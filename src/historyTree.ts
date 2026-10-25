import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeComment, CommentStore } from './comments';
import { FolderGroup, groupFor } from './groups';
import { Conversation, RunningProcess, TranscriptIndex } from './history';
import { Session, SessionStore } from './sessions';
import { commentTreeItem, inSessionsView, sortComments, tildify } from './sessionTree';

/** Per folder group, newest first. */
const LIMIT = 50;
/** Transcripts are appended to on every message; don't rescan for each one. */
const WATCH_DEBOUNCE_MS = 1_000;
const HIDDEN_KEY = 'spool.hiddenHistory';

type Section = 'exited' | 'external';

const SECTION_LABEL: Record<Section, string> = { exited: 'Exited', external: 'Not in Spool' };

/** Exited: sessions Spool knows that have exited. External: conversations Spool doesn't list. */
interface SectionNode {
  kind: 'section';
  section: Section;
}

/** A folder group within a section, when several are open. */
interface GroupNode {
  kind: 'group';
  section: Section;
  group: FolderGroup;
}

export type HistoryElement = SectionNode | GroupNode | Session | CodeComment | Conversation;

function isSession(element: HistoryElement): element is Session {
  return 'terminalId' in element;
}

function isComment(element: HistoryElement): element is CodeComment {
  return 'startLine' in element;
}

function isConversation(element: HistoryElement): element is Conversation {
  return 'titleSource' in element;
}

/**
 * The History view, in two sections: **Exited**, Spool's sessions that have exited (with
 * their comments and side threads), and **Not in Spool**, Claude conversations for the open
 * folders that Spool doesn't list, read from Claude Code's transcripts (see TranscriptIndex).
 * With one folder group open, a section lists its items directly. Exited sessions with
 * comments waiting on you stay in the Sessions view instead (see inSessionsView). Transcripts
 * are only scanned while the view is visible.
 */
export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryElement>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly index = new TranscriptIndex();
  /** One object per group dir and section, so the tree sees stable elements. */
  private readonly groups = new Map<string, FolderGroup>();
  private readonly groupNodes = new Map<string, GroupNode>();
  private readonly sections: Record<Section, SectionNode> = {
    exited: { kind: 'section', section: 'exited' },
    external: { kind: 'section', section: 'external' },
  };
  /** groupFor() walks the filesystem; cache by start dir. */
  private readonly groupDirs = new Map<string, string>();
  private readonly listed = new Map<string, Conversation[]>();
  /** Claude session ids Spool lists, as of the last refresh. */
  private tracked = '';
  /** What the Exited section showed, as of the last refresh. */
  private exited = '';
  private watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: SessionStore,
    private readonly comments: CommentStore,
    private readonly state: vscode.Memento,
  ) {
    this.tracked = this.trackedKey();
    this.exited = this.exitedKey();
    // Sessions change status constantly; only redraw when what this view shows changes.
    const update = () => {
      const tracked = this.trackedKey();
      const exited = this.exitedKey();
      if (tracked !== this.tracked) {
        this.tracked = tracked;
        this.exited = exited;
        this.refresh();
      } else if (exited !== this.exited) {
        this.exited = exited;
        this.changed.fire();
      }
    };
    this.disposables.push(
      store.onDidChange(update),
      comments.onDidChange(update),
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

  /** Keeps the conversation out of Not in Spool. Its transcript is left alone. */
  hide(claudeSessionId: string): void {
    void this.state.update(HIDDEN_KEY, [...this.hidden(), claudeSessionId]);
    this.refresh();
  }

  async getChildren(element?: HistoryElement): Promise<HistoryElement[]> {
    if (!element) {
      return [...(this.exitedSessions().length ? [this.sections.exited] : []), this.sections.external];
    }
    if (isConversation(element) || isComment(element)) {
      return [];
    }
    if (isSession(element)) {
      return [...sortComments(this.commentsOf(element)), ...this.threadsOf(element)];
    }
    if (element.kind === 'group') {
      return this.itemsIn(element.section, element.group);
    }
    const groups = this.allGroups();
    if (groups.length === 1) {
      return this.itemsIn(element.section, groups[0]);
    }
    const nodes = groups.map((group) => this.groupNode(element.section, group));
    return element.section === 'exited'
      ? nodes.filter((node) => this.topLevelExited(node.group).length)
      : nodes;
  }

  getTreeItem(element: HistoryElement): vscode.TreeItem {
    if (isConversation(element)) {
      return this.conversationItem(element);
    }
    if (isComment(element)) {
      return commentTreeItem(element);
    }
    if (isSession(element)) {
      return this.sessionItem(element);
    }
    return element.kind === 'group' ? this.groupItem(element) : this.sectionItem(element);
  }

  dispose(): void {
    this.unwatch();
    this.changed.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async itemsIn(section: Section, group: FolderGroup): Promise<HistoryElement[]> {
    return section === 'exited' ? this.topLevelExited(group) : this.conversationsIn(group);
  }

  /** Exited sessions not in the Sessions view, in the open folders' groups. */
  private exitedSessions(): Session[] {
    const groups = this.allGroups();
    return this.store.all.filter((session) => {
      const group = this.groupOfSession(session);
      return !session.elsewhere && !inSessionsView(session, this.comments) && !!group && groups.includes(group);
    });
  }

  /** A group's exited sessions, except side threads nested under an exited parent; newest first. */
  private topLevelExited(group: FolderGroup): Session[] {
    return this.exitedSessions()
      .filter((session) => this.groupOfSession(session) === group && !this.nestedUnder(session))
      .sort((a, b) => (this.lastActive(b) ?? 0) - (this.lastActive(a) ?? 0));
  }

  private threadsOf(session: Session): Session[] {
    return this.exitedSessions().filter((thread) => this.nestedUnder(thread) === session);
  }

  /** The exited parent a side thread nests under, if it's in the same group. */
  private nestedUnder(session: Session): Session | undefined {
    const parent = this.forkedFrom(session);
    return parent && this.exitedSessions().includes(parent) && this.groupOfSession(parent) === this.groupOfSession(session)
      ? parent
      : undefined;
  }

  private forkedFrom(session: Session): Session | undefined {
    return session.parentId ? this.store.all.find((s) => s.id === session.parentId) : undefined;
  }

  private commentsOf(session: Session): CodeComment[] {
    return this.comments.all.filter((comment) => comment.sessionId === session.id);
  }

  private lastActive(session: Session): number | undefined {
    const cwd = session.cwd ?? session.launchDir;
    return cwd && session.claudeSessionId ? this.index.lastActive(cwd, session.claudeSessionId) : undefined;
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

  private sectionItem(node: SectionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(SECTION_LABEL[node.section], vscode.TreeItemCollapsibleState.Expanded);
    item.id = `section:${node.section}`;
    if (node.section === 'exited') {
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      item.description = String(this.exitedSessions().length);
      item.tooltip = "Spool's sessions that have exited. Resume one to bring it back to Sessions.";
    } else {
      item.iconPath = new vscode.ThemeIcon('history');
      item.tooltip =
        "Claude conversations for the open folders that Spool isn't listing: started outside Spool, or removed from it.";
    }
    return item;
  }

  private groupItem(node: GroupNode): vscode.TreeItem {
    const { group } = node;
    const item = new vscode.TreeItem(path.basename(group.dir) || group.dir, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `history-group:${node.section}:${group.dir}`;
    item.iconPath = new vscode.ThemeIcon(group.isRepo ? 'repo' : 'folder');
    item.tooltip = tildify(group.dir);
    return item;
  }

  private sessionItem(session: Session): vscode.TreeItem {
    const comments = this.commentsOf(session);
    const item = new vscode.TreeItem(
      session.name,
      comments.length || this.threadsOf(session).length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `exited:${session.id}`;
    const lastActive = this.lastActive(session);
    const group = this.groupOfSession(session);
    const subdir = group && session.launchDir ? path.relative(group.dir, session.launchDir) : '';
    const parent = this.forkedFrom(session);
    item.description = [
      lastActive !== undefined && timeAgo(lastActive),
      subdir,
      parent && !this.nestedUnder(session) && `from ${parent.name}`,
      comments.length && (comments.length === 1 ? '1 comment' : `${comments.length} comments`),
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    item.tooltip = [
      `${session.name} — exited`,
      lastActive !== undefined && `Last active ${new Date(lastActive).toLocaleString()}`,
      session.claudeSessionId && `Claude session ${session.claudeSessionId}`,
    ]
      .filter(Boolean)
      .join('\n');
    // Matched by `viewItem` in package.json menu `when` clauses; `:conversation` can be resumed or branched.
    item.contextValue = `exited${session.claudeSessionId ? ':conversation' : ''}`;
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
    item.contextValue = running ? 'conversation:running' : 'conversation';
    return item;
  }

  /** Groups for the open workspace folders, in workspace order. */
  private allGroups(): FolderGroup[] {
    return [...new Set((vscode.workspace.workspaceFolders ?? []).map((folder) => this.group(folder.uri.fsPath)))];
  }

  private groupNode(section: Section, group: FolderGroup): GroupNode {
    const key = `${section}:${group.dir}`;
    let node = this.groupNodes.get(key);
    if (!node) {
      node = { kind: 'group', section, group };
      this.groupNodes.set(key, node);
    }
    return node;
  }

  private groupOfSession(session: Session): FolderGroup | undefined {
    const dir = session.launchDir ?? session.cwd;
    return dir === undefined ? undefined : this.group(dir);
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

  private exitedKey(): string {
    return JSON.stringify(
      this.exitedSessions().map((session) => [
        session.id,
        session.name,
        session.parentId,
        session.claudeSessionId,
        this.commentsOf(session).map((comment) => [comment.id, comment.status, comment.replies.length]),
      ]),
    );
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
