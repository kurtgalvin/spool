import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeComment, CommentStatus, CommentStore, Walkthrough, awaitsYou } from './comments';
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

const COMMENT_DISPLAY: Record<CommentStatus, { label: string; icon: vscode.ThemeIcon }> = {
  draft: { label: 'draft', icon: new vscode.ThemeIcon('edit') },
  queued: { label: 'queued', icon: new vscode.ThemeIcon('clock') },
  sent: { label: 'sent', icon: new vscode.ThemeIcon('send') },
  read: { label: 'Claude is on it', icon: new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue')) },
  replied: { label: 'replied', icon: new vscode.ThemeIcon('comment-unresolved', new vscode.ThemeColor('charts.yellow')) },
  resolved: { label: 'resolved', icon: new vscode.ThemeIcon('check', new vscode.ThemeColor('disabledForeground')) },
};

/** Threads needing you first, done ones last. */
const COMMENT_ORDER: CommentStatus[] = ['replied', 'queued', 'draft', 'sent', 'read', 'resolved'];

/** The Comments node under a session, holding its comment threads. */
export interface CommentsNode {
  kind: 'comments';
  session: Session;
}

/** The Drafts row at the top: comments not attached to a session yet. */
export interface DraftsNode {
  kind: 'drafts';
}

export type SessionTreeElement = FolderGroup | Session | CommentsNode | DraftsNode | CodeComment | Walkthrough;

export function isGroup(element: SessionTreeElement): element is FolderGroup {
  return 'isRepo' in element;
}

export function isSession(element: SessionTreeElement): element is Session {
  return 'terminalId' in element;
}

export function isComment(element: SessionTreeElement): element is CodeComment {
  return 'startLine' in element;
}

export function isWalkthrough(element: SessionTreeElement): element is Walkthrough {
  return 'steps' in element;
}

/** Comments waiting on you: Claude replied (see awaitsYou), or they're queued to send. */
export function needsYou(session: Session, comments: CommentStore): boolean {
  return comments.all.some(
    (comment) => comment.sessionId === session.id && (awaitsYou(comment) || comment.status === 'queued'),
  );
}

/**
 * The Sessions view shows running sessions, and exited ones only while comments on them wait
 * on you. Other exited sessions are in the History view.
 */
export function inSessionsView(session: Session, comments: CommentStore): boolean {
  return session.status !== 'exited' || needsYou(session, comments);
}

/**
 * Sessions grouped by folder (see groupFor). Every open workspace folder has a group, even
 * with no sessions, so a session can be started there from its row. Only sessions
 * inSessionsView() are listed.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeElement> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /** One object per group dir, so reveal() and getParent() see stable elements. */
  private readonly groups = new Map<string, FolderGroup>();
  /** groupFor() walks the filesystem; cache by start dir. */
  private readonly groupDirs = new Map<string, string>();
  /** Stable node objects, for the same reason as groups. */
  private readonly commentsNodes = new Map<string, CommentsNode>();
  private readonly draftsNode: DraftsNode = { kind: 'drafts' };

  constructor(
    private readonly store: SessionStore,
    private readonly comments: CommentStore,
  ) {
    store.onDidChange(() => this.changed.fire());
    comments.onDidChange(() => this.changed.fire());
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed.fire());
  }

  getChildren(element?: SessionTreeElement): SessionTreeElement[] {
    if (!element) {
      return [...(this.drafts().length ? [this.draftsNode] : []), ...this.allGroups()];
    }
    if (isGroup(element)) {
      return this.topLevelIn(element);
    }
    if (isSession(element)) {
      const comments = this.commentsOf(element).length ? [this.commentsNode(element)] : [];
      return [...comments, ...walkthroughsOf(element, this.comments), ...this.threadsOf(element)];
    }
    if (isComment(element)) {
      return [];
    }
    if (isWalkthrough(element)) {
      return this.comments.stepsOf(element);
    }
    return element.kind === 'drafts' ? this.drafts() : this.commentsOf(element.session);
  }

  getParent(element: SessionTreeElement): SessionTreeElement | undefined {
    if (isGroup(element)) {
      return undefined;
    }
    if (isSession(element)) {
      return this.parentOf(element) ?? this.groupOf(element);
    }
    if (isWalkthrough(element)) {
      return this.store.all.find((s) => s.id === element.sessionId) ?? this.draftsNode;
    }
    if (isComment(element)) {
      const walkthrough = this.comments.walkthroughOf(element);
      if (walkthrough) {
        return walkthrough;
      }
      const session = this.sessionOf(element);
      return session ? this.commentsNode(session) : this.draftsNode;
    }
    return element.kind === 'drafts' ? undefined : element.session;
  }

  getTreeItem(element: SessionTreeElement): vscode.TreeItem {
    if (isGroup(element)) {
      return this.groupItem(element);
    }
    if (isSession(element)) {
      return this.sessionItem(element);
    }
    if (isComment(element)) {
      return this.comments.walkthroughOf(element)
        ? stepTreeItem(element, this.comments)
        : commentTreeItem(element);
    }
    if (isWalkthrough(element)) {
      return walkthroughTreeItem(element, this.comments);
    }
    return element.kind === 'drafts' ? this.draftsItem() : this.commentsNodeItem(element);
  }

  /** The tree element for a walkthrough, to reveal it. */
  walkthroughFor(id: string): Walkthrough | undefined {
    return this.comments.walkthroughs.find((walkthrough) => walkthrough.id === id);
  }

  /** The tree element for a comment, to reveal it. */
  elementFor(comment: CodeComment): CodeComment | undefined {
    return this.comments.all.find((c) => c.id === comment.id);
  }

  private commentsNode(session: Session): CommentsNode {
    let node = this.commentsNodes.get(session.id);
    if (!node || node.session !== session) {
      node = { kind: 'comments', session };
      this.commentsNodes.set(session.id, node);
    }
    return node;
  }

  private sessionOf(comment: CodeComment): Session | undefined {
    return comment.sessionId ? this.store.all.find((s) => s.id === comment.sessionId) : undefined;
  }

  /** Drafts, and comments and walkthroughs whose session is no longer listed, so they don't disappear. */
  private drafts(): (CodeComment | Walkthrough)[] {
    const listed = (sessionId: string | undefined) => this.store.all.some((s) => s.id === sessionId);
    return [
      ...sortComments(this.comments.all.filter((comment) => !comment.walkthroughId && !listed(comment.sessionId))),
      ...this.comments.walkthroughs.filter((walkthrough) => !listed(walkthrough.sessionId)),
    ];
  }

  /** The session's comments outside walkthroughs: what its Comments node lists. */
  private commentsOf(session: Session): CodeComment[] {
    return sortComments(
      this.comments.all.filter((comment) => comment.sessionId === session.id && !comment.walkthroughId),
    );
  }

  /** Every comment on the session, walkthrough steps included: what its counts cover. */
  private allCommentsOf(session: Session): CodeComment[] {
    return this.comments.all.filter((comment) => comment.sessionId === session.id);
  }

  private count(comments: CodeComment[], status: CommentStatus): number {
    return comments.filter((comment) => (status === 'replied' ? awaitsYou(comment) : comment.status === status)).length;
  }

  groupOf(session: Session): FolderGroup | undefined {
    const dir = session.launchDir ?? session.cwd;
    return dir === undefined ? undefined : this.group(dir);
  }

  /** Open workspace folders first, in workspace order, then other folders by name. */
  private allGroups(): FolderGroup[] {
    const open = (vscode.workspace.workspaceFolders ?? []).map((folder) => this.group(folder.uri.fsPath));
    const others = this.shown()
      .map((session) => this.groupOf(session))
      .filter((group): group is FolderGroup => !!group && !open.includes(group))
      .sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)));
    return [...new Set([...open, ...others])];
  }

  private shown(): Session[] {
    return this.store.all.filter((session) => inSessionsView(session, this.comments));
  }

  private sessionsIn(group: FolderGroup): Session[] {
    return this.shown().filter((session) => this.groupOf(session) === group);
  }

  /** Sessions shown directly under a group: all but side threads whose parent is still listed. */
  private topLevelIn(group: FolderGroup): Session[] {
    return this.sessionsIn(group).filter((session) => !this.parentOf(session));
  }

  private threadsOf(session: Session): Session[] {
    return this.store
      .childrenOf(session)
      .filter((thread) => inSessionsView(thread, this.comments) && this.parentOf(thread) === session);
  }

  /** The session a side thread nests under: its parent, if listed here. */
  private parentOf(session: Session): Session | undefined {
    const parent = this.forkedFrom(session);
    // A thread whose parent is in another group (shouldn't happen) is shown at its group's top level.
    return parent && inSessionsView(parent, this.comments) && this.groupOf(parent) === this.groupOf(session)
      ? parent
      : undefined;
  }

  private forkedFrom(session: Session): Session | undefined {
    return session.parentId ? this.store.all.find((s) => s.id === session.parentId) : undefined;
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
    const replied = this.count(sessions.flatMap((session) => this.allCommentsOf(session)), 'replied');
    item.description = [
      ...SUMMARIZED.map((status) => {
        const count = sessions.filter((s) => s.status === status).length;
        return count ? `${count} ${STATUS_DISPLAY[status].label}` : undefined;
      }),
      replied && `${replied} replied`,
    ]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = tildify(group.dir);
    // Matched by `viewItem` in package.json menu `when` clauses.
    item.contextValue = 'group';
    return item;
  }

  private sessionItem(session: Session): vscode.TreeItem {
    const display = STATUS_DISPLAY[session.status];
    const comments = this.allCommentsOf(session);
    const item = new vscode.TreeItem(
      session.name,
      this.threadsOf(session).length || comments.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = session.id;
    // Show where in the group the session started, if not at its root.
    const group = this.groupOf(session);
    const subdir = group && session.launchDir ? path.relative(group.dir, session.launchDir) : '';
    const queued = this.count(comments, 'queued');
    const replied = this.count(comments, 'replied');
    // A side thread whose parent is in History says where it came from.
    const parent = this.forkedFrom(session);
    item.description = [
      display.label,
      subdir,
      parent && !this.parentOf(session) && `from ${parent.name}`,
      session.elsewhere && 'other window',
      queued && `${queued} queued`,
      replied && `${replied} replied`,
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = display.icon;
    // Matched by `viewItem` in package.json menu `when` clauses. Sessions in other windows get
    // no actions: their window owns them.
    // `:conversation` marks sessions with a Claude conversation to resume or branch from,
    // `:comments` ones with comments queued to send.
    item.contextValue = session.elsewhere
      ? `elsewhere:${session.status}`
      : `session:${session.status}${session.claudeSessionId ? ':conversation' : ''}${queued ? ':comments' : ''}`;
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

  private commentsNodeItem(node: CommentsNode): vscode.TreeItem {
    const comments = this.commentsOf(node.session);
    // Open while something needs you; done threads stay out of the way.
    const needsYou = comments.some((comment) => awaitsYou(comment) || comment.status === 'queued');
    const item = new vscode.TreeItem(
      'Comments',
      needsYou ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `comments:${node.session.id}`;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.description = String(comments.length);
    item.contextValue = 'comments';
    return item;
  }

  private draftsItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Drafts', vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'drafts';
    item.iconPath = new vscode.ThemeIcon('edit');
    item.description = String(this.drafts().length);
    item.tooltip = "Comments not queued on a session (or whose session isn't listed)";
    item.contextValue = 'drafts';
    return item;
  }
}

/** A comment's row, in either view. */
export function commentTreeItem(comment: CodeComment): vscode.TreeItem {
  const display = COMMENT_DISPLAY[comment.status];
  const firstLine = comment.text.split('\n').find((line) => line.trim())?.trim() ?? '';
  const item = new vscode.TreeItem(firstLine, vscode.TreeItemCollapsibleState.None);
  item.id = `comment:${comment.id}`;
  item.iconPath = display.icon;
  const lines =
    comment.startLine === comment.endLine ? `${comment.startLine + 1}` : `${comment.startLine + 1}-${comment.endLine + 1}`;
  const fromClaude = comment.author === 'claude';
  const status = fromClaude && comment.status === 'replied' && !comment.replies.length ? 'from Claude' : display.label;
  item.description = [`${path.basename(comment.file)}:${lines}`, status, comment.unseen && 'new'].filter(Boolean).join(' · ');
  const lastReply = comment.replies.at(-1);
  item.tooltip = new vscode.MarkdownString(
    [
      `**${status}** · ${tildify(comment.file)}:${lines}`,
      fromClaude ? `**Claude:** ${comment.text}` : comment.text,
      lastReply && `**${lastReply.author === 'claude' ? 'Claude' : 'You'}:** ${lastReply.text}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  // Matched by `viewItem` in package.json menu `when` clauses.
  item.contextValue = `comment:${comment.status}`;
  item.command = { command: 'spool.openComment', title: 'Open Comment', arguments: [comment] };
  return item;
}

/** A session's walkthroughs, oldest first. */
export function walkthroughsOf(session: Session, comments: CommentStore): Walkthrough[] {
  return comments.walkthroughs
    .filter((walkthrough) => walkthrough.sessionId === session.id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** A walkthrough's row, in either view: open while it has steps you haven't opened. */
export function walkthroughTreeItem(walkthrough: Walkthrough, comments: CommentStore): vscode.TreeItem {
  const steps = comments.stepsOf(walkthrough);
  const unseen = steps.some((step) => step.unseen);
  const resolved = steps.length > 0 && steps.every((step) => step.status === 'resolved');
  const replied = steps.filter(awaitsYou).length;
  const item = new vscode.TreeItem(
    walkthrough.title,
    unseen ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = `walkthrough:${walkthrough.id}`;
  item.iconPath = resolved
    ? new vscode.ThemeIcon('list-ordered', new vscode.ThemeColor('disabledForeground'))
    : new vscode.ThemeIcon('list-ordered');
  item.description = [
    steps.length === 1 ? '1 step' : `${steps.length} steps`,
    unseen && 'new',
    replied && `${replied} replied`,
    resolved && 'resolved',
  ]
    .filter(Boolean)
    .join(' · ');
  item.tooltip = `Walkthrough by Claude: ${walkthrough.title}`;
  // Matched by `viewItem` in package.json menu `when` clauses.
  item.contextValue = `walkthrough:${resolved ? 'resolved' : 'open'}`;
  item.command = { command: 'spool.startWalkthrough', title: 'Start Walkthrough', arguments: [walkthrough] };
  return item;
}

/** A walkthrough step's row: its number, then where it is, or its status once you've replied there. */
export function stepTreeItem(step: CodeComment, comments: CommentStore): vscode.TreeItem {
  const walkthrough = comments.walkthroughOf(step);
  const index = walkthrough ? comments.stepsOf(walkthrough).indexOf(step) : -1;
  const firstLine = step.text.split('\n').find((line) => line.trim())?.trim() ?? '';
  const item = new vscode.TreeItem(`${index + 1}. ${firstLine}`, vscode.TreeItemCollapsibleState.None);
  item.id = `comment:${step.id}`;
  const display = COMMENT_DISPLAY[step.status];
  item.iconPath = step.replies.length ? display.icon : new vscode.ThemeIcon('debug-stackframe-dot');
  item.description = [
    `${path.basename(step.file)}:${step.startLine + 1}`,
    step.replies.length && display.label,
    step.unseen && 'new',
  ]
    .filter(Boolean)
    .join(' · ');
  const lastReply = step.replies.at(-1);
  item.tooltip = new vscode.MarkdownString(
    [
      `**Step ${index + 1}** · ${tildify(step.file)}:${step.startLine + 1}`,
      step.text,
      lastReply && `**${lastReply.author === 'claude' ? 'Claude' : 'You'}:** ${lastReply.text}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  // Matched by `viewItem` in package.json menu `when` clauses; `:thread` once you've replied there.
  item.contextValue = `step:${step.status}${step.replies.length ? ':thread' : ''}`;
  item.command = { command: 'spool.openComment', title: 'Open Step', arguments: [step] };
  return item;
}

export function sortComments(comments: CodeComment[]): CodeComment[] {
  return comments.sort(
    (a, b) => COMMENT_ORDER.indexOf(a.status) - COMMENT_ORDER.indexOf(b.status) || a.createdAt - b.createdAt,
  );
}

export function tildify(dir: string): string {
  const home = os.homedir();
  return dir === home || dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
}
