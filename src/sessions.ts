import * as vscode from 'vscode';
import { HookMessage } from './ipc';
import { SessionStatus, nextStatus } from './status';

export interface Session {
  spoolId: string;
  /** From SessionStart; changes on /clear. */
  claudeSessionId?: string;
  name: string;
  status: SessionStatus;
  /** Cleared once the terminal closes. */
  terminal?: vscode.Terminal;
}

/** In-memory registry of Spool-launched sessions, kept current from hook events. */
export class SessionStore implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly changed = new vscode.EventEmitter<Session>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly log: vscode.LogOutputChannel) {}

  get all(): Session[] {
    return [...this.sessions.values()];
  }

  add(session: Session): void {
    this.sessions.set(session.spoolId, session);
    this.changed.fire(session);
  }

  handleHook({ spoolId, payload }: HookMessage): void {
    const session = this.sessions.get(spoolId);
    if (!session) {
      // e.g. a terminal left over from a previous extension host.
      this.log.warn(`hook for unknown session ${spoolId}`);
      return;
    }
    if (payload.hook_event_name === 'SessionStart' && typeof payload.session_id === 'string') {
      session.claudeSessionId = payload.session_id;
    }
    this.setStatus(session, nextStatus(session.status, payload));
  }

  handleTerminalClosed(terminal: vscode.Terminal): void {
    for (const session of this.sessions.values()) {
      if (session.terminal === terminal) {
        session.terminal = undefined;
        this.setStatus(session, 'exited');
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }

  private setStatus(session: Session, status: SessionStatus): void {
    if (session.status !== status) {
      this.log.info(`${session.name}: ${session.status} → ${status}`);
      session.status = status;
    }
    // Fire even without a status change: claudeSessionId may have changed.
    this.changed.fire(session);
  }
}
