import * as vscode from 'vscode';
import { Session, SessionStore } from './sessions';
import { SessionStatus } from './status';

const STATUS_DISPLAY: Record<SessionStatus, { label: string; icon: vscode.ThemeIcon }> = {
  starting: { label: 'starting', icon: new vscode.ThemeIcon('loading~spin') },
  working: { label: 'working', icon: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue')) },
  'needs-input': { label: 'needs input', icon: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow')) },
  idle: { label: 'idle', icon: new vscode.ThemeIcon('circle-outline') },
  exited: { label: 'exited', icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')) },
};

export class SessionTreeProvider implements vscode.TreeDataProvider<Session> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: SessionStore) {
    store.onDidChange(() => this.changed.fire());
  }

  getChildren(element?: Session): Session[] {
    return element ? [] : this.store.all;
  }

  /** Required by TreeView.reveal; sessions are top-level for now. */
  getParent(): undefined {
    return undefined;
  }

  getTreeItem(session: Session): vscode.TreeItem {
    const display = STATUS_DISPLAY[session.status];
    const item = new vscode.TreeItem(session.name);
    item.id = session.spoolId;
    item.description = display.label;
    item.iconPath = display.icon;
    // Matched by `viewItem` in package.json menu `when` clauses.
    item.contextValue = `session:${session.status}`;
    item.tooltip = session.claudeSessionId
      ? `${session.name} — ${display.label}\nClaude session ${session.claudeSessionId}`
      : `${session.name} — ${display.label}`;
    if (session.terminal) {
      item.command = { command: 'spool.focusSession', title: 'Focus Session', arguments: [session] };
    }
    return item;
  }
}
