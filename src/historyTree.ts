import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FolderGroup, groupFor } from './groups';
import { Conversation, RunningProcess, TranscriptIndex } from './history';
import { SessionStore } from './sessions';

/** Per folder group, newest first. */
const LIMIT = 50;
/** Transcripts are appended to on every message; don't rescan for each one. */
const WATCH_DEBOUNCE_MS = 1_000;
const HIDDEN_KEY = 'spool.hiddenHistory';

export type HistoryElement = FolderGroup | Conversation;

function isGroup(element: HistoryElement): element is FolderGroup {
  return 'isRepo' in element;
}

/**
 * The History view: Claude conversations for the open folders that Spool isn't showing,
 * read from Claude Code's transcripts (see TranscriptIndex). With one folder group, its
 * conversations are listed at the top level. Only scanned while the view is visible.
 */
export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryElement>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly index = new TranscriptIndex();
  /** One object per group dir, so getParent() sees stable elements. */
  private readonly groups = new Map<string, FolderGroup>();
  /** groupFor() walks the filesystem; cache by start dir. */
  private readonly groupDirs = new Map<string, string>();
  private readonly listed = new Map<string, Conversation[]>();
  /** Claude session ids Spool lists, as of the last refresh. */
  private tracked = '';
  private watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: SessionStore,
    private readonly state: vscode.Memento,
  ) {
    this.tracked = this.trackedKey();
    this.disposables.push(
      // Sessions change status constantly; only a change in which conversations Spool lists matters.
      store.onDidChange(() => {
        const tracked = this.trackedKey();
        if (tracked !== this.tracked) {
          this.tracked = tracked;
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
  }

  /** Watches the transcripts while the view is visible, and rescans when it's shown. */
  setVisible(visible: boolean): void {
    this.unwatch();
    if (!visible) {
      return;
    }
    const dirs = [this.index.projectsDir, this.index.sessionsDir, ...this.allGroups().flatMap((g) => this.index.projectDirsFor(g.dir))];
    for (const dir of dirs) {
      try {
        this.watchers.push(fs.watch(dir, () => this.refreshSoon()));
      } catch {
        // Not there yet (no conversations, or Claude Code never ran).
      }
    }
    this.refresh();
  }

  refresh(): void {
    this.listed.clear();
    this.changed.fire();
  }

  /** Checked again rather than trusting the row, which can be a few seconds old. */
  runningProcess(conversation: Conversation): RunningProcess | undefined {
    return this.index.running().get(conversation.id);
  }

  hide(conversation: Conversation): void {
    void this.state.update(HIDDEN_KEY, [...this.hidden(), conversation.id]);
    this.refresh();
  }

  async getChildren(element?: HistoryElement): Promise<HistoryElement[]> {
    if (element && !isGroup(element)) {
      return [];
    }
    const groups = this.allGroups();
    if (!element) {
      return groups.length === 1 ? this.conversationsIn(groups[0]) : groups;
    }
    return this.conversationsIn(element);
  }

  getParent(element: HistoryElement): HistoryElement | undefined {
    const groups = this.allGroups();
    return isGroup(element) || groups.length === 1 ? undefined : this.group(element.cwd);
  }

  getTreeItem(element: HistoryElement): vscode.TreeItem {
    return isGroup(element) ? this.groupItem(element) : this.conversationItem(element);
  }

  dispose(): void {
    this.unwatch();
    this.changed.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async conversationsIn(group: FolderGroup): Promise<Conversation[]> {
    let conversations = this.listed.get(group.dir);
    if (!conversations) {
      const tracked = new Set(this.store.all.map((session) => session.claudeSessionId));
      const hidden = new Set(this.hidden());
      conversations = await this.index.list(
        group.dir,
        LIMIT,
        (cwd) => this.group(cwd) === group,
        (id) => tracked.has(id) || hidden.has(id),
      );
      this.listed.set(group.dir, conversations);
    }
    return conversations;
  }

  private groupItem(group: FolderGroup): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(group.dir) || group.dir, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `history-group:${group.dir}`;
    item.iconPath = new vscode.ThemeIcon(group.isRepo ? 'repo' : 'folder');
    item.tooltip = group.dir;
    return item;
  }

  private conversationItem(conversation: Conversation): vscode.TreeItem {
    const item = new vscode.TreeItem(conversation.title, vscode.TreeItemCollapsibleState.None);
    item.id = `history:${conversation.id}`;
    const group = this.group(conversation.cwd);
    const subdir = path.relative(group.dir, conversation.cwd);
    const running = conversation.running;
    item.description = [
      running ? `running elsewhere${running.status ? ` · ${running.status}` : ''}` : timeAgo(conversation.lastActive),
      subdir,
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = running
      ? new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('history');
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escape(conversation.title)}**\n\n`);
    if (running) {
      tooltip.appendMarkdown(`Running in another terminal (pid ${running.pid})\n\n`);
    }
    tooltip.appendMarkdown(
      [
        `Last active ${new Date(conversation.lastActive).toLocaleString()}`,
        `${conversation.cwd}${conversation.gitBranch ? ` · ${conversation.gitBranch}` : ''}`,
        `Claude session ${conversation.id}`,
      ]
        .map(escape)
        .join('  \n'),
    );
    if (conversation.firstPrompt) {
      tooltip.appendMarkdown(`\n\n**First prompt:** ${escape(clip(conversation.firstPrompt))}`);
    }
    if (conversation.lastPrompt && conversation.lastPrompt !== conversation.firstPrompt) {
      tooltip.appendMarkdown(`\n\n**Last prompt:** ${escape(clip(conversation.lastPrompt))}`);
    }
    item.tooltip = tooltip;
    // Matched by `viewItem` in package.json menu `when` clauses.
    item.contextValue = running ? 'history:running' : 'history';
    return item;
  }

  /** Groups for the open workspace folders, in workspace order. */
  private allGroups(): FolderGroup[] {
    return [...new Set((vscode.workspace.workspaceFolders ?? []).map((folder) => this.group(folder.uri.fsPath)))];
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

  private hidden(): string[] {
    return this.state.get<string[]>(HIDDEN_KEY, []);
  }

  private trackedKey(): string {
    return this.store.all
      .map((session) => session.claudeSessionId ?? '')
      .sort()
      .join(',');
  }

  private refreshSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), WATCH_DEBOUNCE_MS);
  }

  private unwatch(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}

function timeAgo(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days < 30 ? `${days}d ago` : new Date(time).toLocaleDateString();
}

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}
