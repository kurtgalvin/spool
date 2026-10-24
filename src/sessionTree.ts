import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FolderGroup, groupFor } from './groups';
import { Session, SessionStore } from './sessions';
import { SessionStatus } from './status';

const STATUS_DISPLAY: Record<SessionStatus, { label: string; icon: vscode.ThemeIcon }> = {
  starting: { label: 'starting', icon: new vscode.ThemeIcon('loading~spin') },
  working: { label: 'working', icon: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue')) },
  'needs-input': { label: 'needs input', icon: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow')) },
  idle: { label: 'idle', icon: new vscode.ThemeIcon('circle-outline') },
  exited: { label: 'exited', icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')) },
};

/** Statuses summarized on a group's row, so a collapsed group still shows what needs attention. */
const SUMMARIZED: SessionStatus[] = ['needs-input', 'working'];

export type SessionTreeElement = FolderGroup | Session;

export function isGroup(element: SessionTreeElement): element is FolderGroup {
  return 'isRepo' in element;
}

/**
 * Sessions grouped by folder (see groupFor). Every open workspace folder has a group, even
 * with no sessions, so a session can be started there from its row.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeElement> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /** One object per group dir, so reveal() and getParent() see stable elements. */
  private readonly groups = new Map<string, FolderGroup>();
  /** groupFor() walks the filesystem; cache by start dir. */
  private readonly groupDirs = new Map<string, string>();

  constructor(private readonly store: SessionStore) {
    store.onDidChange(() => this.changed.fire());
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed.fire());
  }

  getChildren(element?: SessionTreeElement): SessionTreeElement[] {
    if (!element) {
      return this.allGroups();
    }
    return isGroup(element) ? this.topLevelIn(element) : this.threadsOf(element);
  }

  getParent(element: SessionTreeElement): SessionTreeElement | undefined {
    return isGroup(element) ? undefined : (this.parentOf(element) ?? this.groupOf(element));
  }

  getTreeItem(element: SessionTreeElement): vscode.TreeItem {
    return isGroup(element) ? this.groupItem(element) : this.sessionItem(element);
  }

  groupOf(session: Session): FolderGroup | undefined {
    const dir = session.launchDir ?? session.cwd;
    return dir === undefined ? undefined : this.group(dir);
  }

  /** Open workspace folders first, in workspace order, then other folders by name. */
  private allGroups(): FolderGroup[] {
    const open = (vscode.workspace.workspaceFolders ?? []).map((folder) => this.group(folder.uri.fsPath));
    const others = this.store.all
      .map((session) => this.groupOf(session))
      .filter((group): group is FolderGroup => !!group && !open.includes(group))
      .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)));
    return [...new Set([...open, ...others])];
  }

  private sessionsIn(group: FolderGroup): Session[] {
    return this.store.all.filter((session) => this.groupOf(session) === group);
  }

  /** Sessions shown directly under a group: all but side threads whose parent is still listed. */
  private topLevelIn(group: FolderGroup): Session[] {
    return this.sessionsIn(group).filter((session) => !this.parentOf(session));
  }

  private threadsOf(session: Session): Session[] {
    return this.store.childrenOf(session).filter((thread) => this.parentOf(thread) === session);
  }

  private parentOf(session: Session): Session | undefined {
    const parent = session.parentId ? this.store.all.find((s) => s.id === session.parentId) : undefined;
    // A thread whose parent is in another group (shouldn't happen) is shown at its group's top level.
    return parent && this.groupOf(parent) === this.groupOf(session) ? parent : undefined;
  }

  private group(startDir: string): FolderGroup {
    let dir = this.groupDirs.get(startDir);
    if (dir === undefined) {
      const found = groupFor(startDir);
      dir = found.dir;
      this.groupDirs.set(startDir, dir);
      if (!this.groups.has(dir)) {
        this.groups.set(dir, found);
      }
    }
    return this.groups.get(dir)!;
  }

  private groupItem(group: FolderGroup): vscode.TreeItem {
    const sessions = this.sessionsIn(group);
    const isOpen = vscode.workspace.workspaceFolders?.some((folder) => this.group(folder.uri.fsPath) === group);
    const item = new vscode.TreeItem(
      path.basename(group.dir) || group.dir,
      !sessions.length
        ? vscode.TreeItemCollapsibleState.None
        : isOpen
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `group:${group.dir}`;
    item.iconPath = new vscode.ThemeIcon(group.isRepo ? 'repo' : 'folder');
    item.description = SUMMARIZED.map((status) => {
      const count = sessions.filter((s) => s.status === status).length;
      return count ? `${count} ${STATUS_DISPLAY[status].label}` : undefined;
    })
      .filter(Boolean)
      .join(' · ');
    item.tooltip = tildify(group.dir);
    // Matched by `viewItem` in package.json menu `when` clauses.
    item.contextValue = 'group';
    return item;
  }

  private sessionItem(session: Session): vscode.TreeItem {
    const display = STATUS_DISPLAY[session.status];
    const item = new vscode.TreeItem(
      session.name,
      this.threadsOf(session).length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = session.id;
    // Show where in the group the session started, if not at its root.
    const group = this.groupOf(session);
    const subdir = group && session.launchDir ? path.relative(group.dir, session.launchDir) : '';
    item.description = [display.label, subdir, session.elsewhere && 'other window'].filter(Boolean).join(' · ');
    item.iconPath = display.icon;
    // Matched by `viewItem` in package.json menu `when` clauses. Sessions in other windows get
    // no actions: their window owns them.
    // `:conversation` marks sessions with a Claude conversation to resume or branch from.
    item.contextValue = session.elsewhere
      ? `elsewhere:${session.status}`
      : `session:${session.status}${session.claudeSessionId ? ':conversation' : ''}`;
    item.tooltip = [
      `${session.name} — ${display.label}`,
      session.elsewhere && 'Running in another VS Code window',
      session.claudeSessionId && `Claude session ${session.claudeSessionId}`,
    ]
      .filter(Boolean)
      .join('\n');
    if (session.terminal) {
      item.command = { command: 'spool.focusSession', title: 'Focus Session', arguments: [session] };
    }
    return item;
  }
}

function tildify(dir: string): string {
  const home = os.homedir();
  return dir === home || dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
}
