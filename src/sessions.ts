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
  name: string;
  /** 'user' names are never replaced by auto-naming. */
  nameSource: 'default' | 'auto' | 'user';
  status: SessionStatus;
  /** Set while the session is running in its terminal. */
  terminal?: vscode.Terminal;
}

/** In-memory registry of Spool-launched sessions, kept current from hook events. */
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

  constructor(private readonly log: vscode.LogOutputChannel) {}

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
  }

  /** Finds the session a hook belongs to, starting or resuming one on SessionStart. */
  private routeHook(terminalId: string, payload: Record<string, unknown>): Session | undefined {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      // e.g. a terminal left over from a previous extension host.
      this.log.warn(`hook for unknown terminal ${terminalId}`);
      return undefined;
    }
    const claudeSessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
    const current = this.findByTerminal(terminal);
    if (current && (!current.claudeSessionId || current.claudeSessionId === claudeSessionId)) {
      current.claudeSessionId ??= claudeSessionId;
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
      this.terminalNameChanged.fire(resumed);
      return resumed;
    }
    const session = this.startSession(terminalId, terminal);
    session.claudeSessionId = claudeSessionId;
    this.terminalNameChanged.fire(session);
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
    this.log.info(`started ${session.name}`);
    this.changed.fire(session);
    return session;
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
