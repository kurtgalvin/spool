import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { HookMessage } from './ipc';
import { nameFromPrompt } from './naming';
import { SessionStatus, nextStatus } from './status';

/**
 * One Claude conversation. A terminal can host several in a row: /clear ends the current
 * session and starts a new one in the same terminal.
 */
export interface Session {
  id: string;
  /** The SPOOL_ID of the terminal the session runs in; hooks report it. */
  terminalId: string;
  /** From SessionStart. */
  claudeSessionId?: string;
  /** From SessionStart; resuming must run in the same directory to find the conversation. */
  cwd?: string;
  name: string;
  /** 'user' names are never replaced by auto-naming. */
  nameSource: 'default' | 'auto' | 'user';
  status: SessionStatus;
  /** Set while the session is running in its terminal. */
  terminal?: vscode.Terminal;
  /** The terminal's shell process id: the only identifier that survives a window reload. */
  shellPid?: number;
}

/** A session as saved to disk; terminals are re-matched by shellPid on load. */
export type SavedSession = Omit<Session, 'terminal'>;

export interface SessionPersistence {
  loadAll(): SavedSession[];
  save(session: SavedSession): void;
  delete(id: string): void;
}

/** Registry of this window's sessions, kept current from hook events and saved as they change. */
export class SessionStore implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly terminals = new Map<string, vscode.Terminal>();
  private defaultNameCount = 0;
  private readonly changed = new vscode.EventEmitter<Session>();
  readonly onDidChange = this.changed.event;
  private readonly statusChanged = new vscode.EventEmitter<{ session: Session; previous: SessionStatus }>();
  readonly onDidChangeStatus = this.statusChanged.event;
  /** Fires when a terminal's tab should show a new name: auto-naming, or another session taking over the terminal. */
  private readonly terminalNameChanged = new vscode.EventEmitter<Session>();
  readonly onDidChangeTerminalName = this.terminalNameChanged.event;
  /** Fires when a different session takes over an existing terminal (/clear, /resume). */
  private readonly tookOverTerminal = new vscode.EventEmitter<Session>();
  readonly onDidTakeOverTerminal = this.tookOverTerminal.event;

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly persistence: SessionPersistence,
  ) {
    this.changed.event((session) => {
      // remove() fires after deleting; don't write the session back.
      if (this.sessions.has(session.id)) {
        // The terminal can't be serialized; load() re-matches it by shellPid.
        const { terminal, ...saved } = session;
        this.persistence.save(saved);
      }
    });
  }

  /**
   * Loads saved sessions this window should show, skipping ones already loaded:
   * - sessions whose terminal is in this window, matched by shell pid (VS Code doesn't expose a
   *   revived terminal's env), re-attached with their last known status;
   * - exited sessions that `isRelevant` (e.g. in an open workspace folder), so they can be resumed.
   * Sessions still running in another window are left to that window.
   */
  async load(
    terminals: readonly vscode.Terminal[],
    pidOf: (t: vscode.Terminal) => Promise<number | undefined>,
    isRelevant: (session: SavedSession) => boolean,
  ): Promise<void> {
    const pids = await Promise.all(terminals.map(pidOf));
    let attached = 0;
    let loaded = 0;
    for (const saved of this.persistence.loadAll()) {
      if (this.sessions.has(saved.id)) {
        continue;
      }
      const session: Session = { ...saved };
      const wasRunning = saved.status !== 'exited' && saved.shellPid !== undefined;
      const index = wasRunning ? pids.indexOf(saved.shellPid) : -1;
      if (index >= 0) {
        session.terminal = terminals[index];
        this.terminals.set(session.terminalId, session.terminal);
        attached++;
      } else if (wasRunning && isProcessAlive(saved.shellPid!)) {
        continue;
      } else if (isRelevant(saved)) {
        session.status = 'exited';
      } else {
        continue;
      }
      this.sessions.set(session.id, session);
      loaded++;
      this.changed.fire(session);
    }
    for (const session of this.sessions.values()) {
      const n = /^Claude (\d+)$/.exec(session.name);
      this.defaultNameCount = Math.max(this.defaultNameCount, n ? Number(n[1]) : 0);
    }
    if (loaded) {
      this.log.info(`loaded ${loaded} saved session(s), ${attached} re-attached to running terminals`);
    }
  }

  get all(): Session[] {
    return [...this.sessions.values()];
  }

  findByTerminal(terminal: vscode.Terminal | undefined): Session | undefined {
    return terminal && this.all.find((s) => s.terminal === terminal);
  }

  /** Launches a terminal via `createTerminal` (given the session's name) and registers the session in it. */
  create(terminalId: string, createTerminal: (name: string) => vscode.Terminal): Session {
    const name = this.nextDefaultName();
    const terminal = createTerminal(name);
    this.terminals.set(terminalId, terminal);
    return this.startSession(terminalId, terminal, name);
  }

  /** Re-attaches an exited session to a new terminal launched via `createTerminal`. */
  resume(session: Session, terminalId: string, createTerminal: (name: string) => vscode.Terminal): void {
    const terminal = createTerminal(session.name);
    this.terminals.set(terminalId, terminal);
    session.terminalId = terminalId;
    session.terminal = terminal;
    this.recordShellPid(session, terminal);
    this.setStatus(session, 'starting');
  }

  handleHook({ spoolId: terminalId, payload }: HookMessage): void {
    const session = this.routeHook(terminalId, payload);
    if (!session) {
      return;
    }
    if (payload.hook_event_name === 'UserPromptSubmit' && session.nameSource === 'default') {
      const name = nameFromPrompt(payload.prompt);
      if (name) {
        session.name = name;
        session.nameSource = 'auto';
        this.terminalNameChanged.fire(session);
      }
    }
    const status = nextStatus(session.status, payload);
    if (status === 'exited') {
      this.detach(session);
    } else {
      this.setStatus(session, status);
    }
  }

  rename(session: Session, name: string): void {
    session.name = name;
    session.nameSource = 'user';
    this.changed.fire(session);
  }

  /** Manual fix for interrupts, which fire no hook and leave a stale status. */
  markIdle(session: Session): void {
    this.setStatus(session, 'idle');
  }

  remove(session: Session): void {
    this.sessions.delete(session.id);
    this.persistence.delete(session.id);
    this.changed.fire(session);
  }

  handleTerminalClosed(terminal: vscode.Terminal): void {
    for (const [terminalId, t] of this.terminals) {
      if (t === terminal) {
        this.terminals.delete(terminalId);
      }
    }
    const session = this.findByTerminal(terminal);
    if (session) {
      this.detach(session);
    }
  }

  dispose(): void {
    this.changed.dispose();
    this.statusChanged.dispose();
    this.terminalNameChanged.dispose();
    this.tookOverTerminal.dispose();
  }

  /** Finds the session a hook belongs to, starting or resuming one on SessionStart. */
  private routeHook(terminalId: string, payload: Record<string, unknown>): Session | undefined {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      // Every window receives every hook; this one belongs to another window.
      this.log.debug(`ignoring hook for terminal ${terminalId} (not in this window)`);
      return undefined;
    }
    const claudeSessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
    const current = this.findByTerminal(terminal);
    if (current && (!current.claudeSessionId || current.claudeSessionId === claudeSessionId)) {
      current.claudeSessionId ??= claudeSessionId;
      if (typeof payload.cwd === 'string') {
        current.cwd = payload.cwd;
      }
      return current;
    }
    if (payload.hook_event_name !== 'SessionStart' || !claudeSessionId) {
      // A late event for a session that already left this terminal.
      return this.all.find((s) => s.terminalId === terminalId && s.claudeSessionId === claudeSessionId);
    }

    // A new Claude session in an existing terminal (/clear, /resume). The previous session's
    // SessionEnd normally detached it already; this covers it if not.
    if (current) {
      this.detach(current);
    }
    const resumed = this.all.find((s) => s.claudeSessionId === claudeSessionId && !s.terminal);
    if (resumed) {
      this.log.info(`${resumed.name}: resumed`);
      resumed.terminalId = terminalId;
      resumed.terminal = terminal;
      resumed.status = 'starting';
      this.recordShellPid(resumed, terminal);
      this.terminalNameChanged.fire(resumed);
      this.tookOverTerminal.fire(resumed);
      return resumed;
    }
    const session = this.startSession(terminalId, terminal);
    session.claudeSessionId = claudeSessionId;
    session.cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
    this.terminalNameChanged.fire(session);
    this.tookOverTerminal.fire(session);
    return session;
  }

  private startSession(terminalId: string, terminal: vscode.Terminal, name = this.nextDefaultName()): Session {
    const session: Session = {
      id: randomUUID(),
      terminalId,
      name,
      nameSource: 'default',
      status: 'starting',
      terminal,
    };
    this.sessions.set(session.id, session);
    this.recordShellPid(session, terminal);
    this.log.info(`started ${session.name}`);
    this.changed.fire(session);
    return session;
  }

  private recordShellPid(session: Session, terminal: vscode.Terminal): void {
    void terminal.processId.then((pid) => {
      session.shellPid = pid;
      this.changed.fire(session);
    });
  }

  private nextDefaultName(): string {
    return `Claude ${++this.defaultNameCount}`;
  }

  /** Marks a session exited and frees its terminal for whatever runs in it next. */
  private detach(session: Session): void {
    session.terminal = undefined;
    this.setStatus(session, 'exited');
  }

  private setStatus(session: Session, status: SessionStatus): void {
    const previous = session.status;
    if (previous !== status) {
      this.log.info(`${session.name}: ${previous} → ${status}`);
      session.status = status;
      this.statusChanged.fire({ session, previous });
    }
    // Fire even without a status change: claudeSessionId may have changed.
    this.changed.fire(session);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
