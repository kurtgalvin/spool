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
  /** Where the session's terminal was started; decides its folder group in the sidebar. */
  launchDir?: string;
  /** For side threads: the session this one was forked from. */
  parentId?: string;
  name: string;
  /** 'user' names are never replaced by auto-naming. */
  nameSource: 'default' | 'auto' | 'user';
  status: SessionStatus;
  /** Set while the session is running in its terminal. */
  terminal?: vscode.Terminal;
  /** The terminal's shell process id: the only identifier that survives a window reload. */
  shellPid?: number;
  /** Running in another VS Code window: mirrored from its file, read-only here. Never saved. */
  elsewhere?: boolean;
}

/** A session as saved to disk; terminals are re-matched by shellPid on load. */
export type SavedSession = Omit<Session, 'terminal' | 'elsewhere'>;

export interface SessionPersistence {
  loadAll(): SavedSession[];
  save(session: SavedSession): void;
  delete(id: string): void;
}

/**
 * Registry of sessions: this window's, kept current from hook events and saved as they change,
 * plus other windows' running sessions and resumable exited ones, mirrored from their files.
 */
export class SessionStore implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly terminals = new Map<string, vscode.Terminal>();
  private defaultNameCount = 0;
  private pendingSync = Promise.resolve();
  /** Set while applying session files, so changes read from disk aren't written back. */
  private applyingFiles = false;
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
      // remove() fires after deleting; don't write the session back. Sessions running elsewhere
      // belong to their own window.
      if (this.sessions.has(session.id) && !session.elsewhere && !this.applyingFiles) {
        // The terminal can't be serialized; sync() re-matches it by shellPid.
        const { terminal, elsewhere, ...saved } = session;
        this.persistence.save(saved);
      }
    });
  }

  /**
   * Brings the store in line with the session files, which every window writes as its
   * sessions change. Sessions running in this window are left alone: this window is their
   * source of truth. Every other file is loaded or updated:
   * - running in one of `terminals`, matched by shell pid (VS Code doesn't expose a revived
   *   terminal's env): re-attached with its last known status;
   * - running in another window (its shell is alive): shown read-only, marked `elsewhere`;
   * - otherwise exited: shown if `isRelevant` (e.g. in an open workspace folder), so it can be
   *   resumed.
   * Sessions whose file is gone (removed in another window) are dropped. Calls are serialized.
   */
  sync(
    terminals: readonly vscode.Terminal[],
    pidOf: (t: vscode.Terminal) => Promise<number | undefined>,
    isRelevant: (session: SavedSession) => boolean,
  ): Promise<void> {
    this.pendingSync = this.pendingSync
      .then(() => this.syncNow(terminals, pidOf, isRelevant))
      .catch((err) => this.log.error(`syncing sessions failed: ${(err as Error).message}`));
    return this.pendingSync;
  }

  private async syncNow(
    terminals: readonly vscode.Terminal[],
    pidOf: (t: vscode.Terminal) => Promise<number | undefined>,
    isRelevant: (session: SavedSession) => boolean,
  ): Promise<void> {
    const pids = await Promise.all(terminals.map(pidOf));
    const files = this.persistence.loadAll();
    const dropped = new Set(this.sessions.keys());
    this.applyingFiles = true;
    try {
      for (const file of files) {
        const existing = this.sessions.get(file.id);
        if (existing?.terminal) {
          dropped.delete(file.id);
          continue;
        }
        const next: Session = { ...file, elsewhere: false };
        const running = file.status !== 'exited';
        const index = running && file.shellPid !== undefined ? pids.indexOf(file.shellPid) : -1;
        if (index >= 0) {
          next.terminal = terminals[index];
          this.terminals.set(next.terminalId, next.terminal);
          this.log.info(`${next.name}: re-attached to its terminal`);
        } else if (running && (file.shellPid === undefined || isProcessAlive(file.shellPid))) {
          // No pid yet means its window is still starting it.
          next.elsewhere = true;
        } else if (isRelevant(file)) {
          next.status = 'exited';
        } else {
          continue;
        }
        dropped.delete(file.id);
        if (!existing) {
          this.sessions.set(next.id, next);
          this.changed.fire(next);
        } else if (!sameSession(existing, next)) {
          // Update in place: the tree view tracks sessions by object.
          Object.assign(existing, next);
          this.changed.fire(existing);
        }
      }
      for (const id of dropped) {
        const session = this.sessions.get(id)!;
        if (session.terminal) {
          continue;
        }
        this.sessions.delete(id);
        this.changed.fire(session);
      }
    } finally {
      this.applyingFiles = false;
    }
    for (const session of this.sessions.values()) {
      const n = /^Claude (\d+)$/.exec(session.name);
      this.defaultNameCount = Math.max(this.defaultNameCount, n ? Number(n[1]) : 0);
    }
  }

  get all(): Session[] {
    return [...this.sessions.values()];
  }

  findByTerminal(terminal: vscode.Terminal | undefined): Session | undefined {
    return terminal && this.all.find((s) => s.terminal === terminal);
  }

  /** Launches a terminal in `launchDir` via `createTerminal` (given the session's name) and registers the session in it. */
  /** With a `name`, the session isn't auto-named from its first prompt. */
  create(
    terminalId: string,
    launchDir: string,
    createTerminal: (name: string) => vscode.Terminal,
    name?: string,
  ): Session {
    const sessionName = name ?? this.nextDefaultName();
    const terminal = createTerminal(sessionName);
    this.terminals.set(terminalId, terminal);
    return this.startSession(terminalId, terminal, launchDir, sessionName, name ? 'auto' : 'default');
  }

  /**
   * Registers a side thread of `parent` in a terminal launched via `createTerminal`. The caller
   * runs the fork; its SessionStart carries the new Claude session id.
   */
  /** Nested under its parent in the sidebar. Auto-named from its first prompt unless given a `name`. */
  branch(
    parent: Session,
    terminalId: string,
    createTerminal: (name: string) => vscode.Terminal,
    name?: string,
  ): Session {
    const sessionName = name ?? 'Side thread';
    const terminal = createTerminal(sessionName);
    this.terminals.set(terminalId, terminal);
    const session = this.startSession(
      terminalId,
      terminal,
      parent.launchDir ?? parent.cwd,
      sessionName,
      name ? 'auto' : 'default',
    );
    session.parentId = parent.id;
    this.changed.fire(session);
    return session;
  }

  childrenOf(parent: Session): Session[] {
    return this.all.filter((s) => s.parentId === parent.id);
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

  /**
   * Adds a conversation Spool didn't start (from the History view) as an exited session, so
   * it can be resumed like any other. It runs in `cwd`, which also decides its folder group.
   */
  adopt(claudeSessionId: string, cwd: string, name: string, nameSource: Session['nameSource']): Session {
    const session: Session = {
      id: randomUUID(),
      // Replaced when it's resumed in a terminal.
      terminalId: randomUUID(),
      claudeSessionId,
      cwd,
      launchDir: cwd,
      name,
      nameSource,
      status: 'exited',
    };
    this.sessions.set(session.id, session);
    this.log.info(`${name}: added from history`);
    this.changed.fire(session);
    return session;
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
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
    // Same terminal, so same folder as the session it replaces (usually already detached by SessionEnd).
    const previous = this.all.reverse().find((s) => s.terminalId === terminalId);
    const session = this.startSession(terminalId, terminal, previous?.launchDir ?? cwd);
    session.claudeSessionId = claudeSessionId;
    session.cwd = cwd;
    this.terminalNameChanged.fire(session);
    this.tookOverTerminal.fire(session);
    return session;
  }

  private startSession(
    terminalId: string,
    terminal: vscode.Terminal,
    launchDir: string | undefined,
    name = this.nextDefaultName(),
    nameSource: Session['nameSource'] = 'default',
  ): Session {
    const session: Session = {
      id: randomUUID(),
      terminalId,
      launchDir,
      name,
      nameSource,
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

function sameSession(a: Session, b: Session): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Session)[]);
  return [...keys].every((key) => a[key] === b[key]);
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
