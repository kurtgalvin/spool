import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeComment, CommentStatus, CommentStore } from './comments';
import { groupFor } from './groups';
import { Session, SessionStore } from './sessions';

export const COMMENT_CONTROLLER_ID = 'spool';

const STATUS_LABEL: Record<CommentStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  sent: 'Sent',
  read: 'Read',
  replied: 'Replied',
  resolved: 'Resolved',
};

/**
 * Shows comments as comment threads in the editor, and lets you comment on any file on disk
 * (including the current side of a diff). A thread's `contextValue` is its comment's status,
 * matched by `commentThread` in package.json menu `when` clauses.
 */
export class CommentThreads implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(COMMENT_CONTROLLER_ID, 'Spool');
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly commentIds = new WeakMap<vscode.CommentThread, string>();
  /** What each thread last rendered, so status changes elsewhere don't redraw every thread. */
  private readonly rendered = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly comments: CommentStore,
    private readonly sessions: SessionStore,
  ) {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) =>
        document.uri.scheme === 'file' ? [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)] : [],
    };
    this.controller.options = { prompt: 'Comment for Claude…', placeHolder: 'What should Claude do here?' };
    this.disposables.push(
      this.controller,
      comments.onDidChange(() => this.render()),
      // Thread labels show their session's name.
      sessions.onDidChange(() => this.render()),
    );
    this.render();
  }

  /** Saves the text typed into a new thread as a comment, queued on `session` or as a draft. */
  async create(reply: vscode.CommentReply, session: Session | undefined): Promise<void> {
    const { thread, text } = reply;
    const document = await vscode.workspace.openTextDocument(thread.uri);
    const startLine = thread.range.start.line;
    const endLine = thread.range.end.line;
    const code = document.getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length));
    // Register the thread first: adding renders, which would otherwise create a second thread.
    const id = randomUUID();
    this.attach(id, thread);
    this.comments.add({ file: thread.uri.fsPath, startLine, endLine, code, text }, session?.id, id);
  }

  commentFor(thread: vscode.CommentThread): CodeComment | undefined {
    const id = this.commentIds.get(thread);
    return this.comments.all.find((comment) => comment.id === id);
  }

  dispose(): void {
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private attach(id: string, thread: vscode.CommentThread): void {
    this.threads.set(id, thread);
    this.commentIds.set(thread, id);
  }

  private render(): void {
    const live = new Set<string>();
    for (const comment of this.comments.all) {
      live.add(comment.id);
      let thread = this.threads.get(comment.id);
      if (!thread) {
        thread = this.controller.createCommentThread(
          vscode.Uri.file(comment.file),
          new vscode.Range(comment.startLine, 0, comment.endLine, 0),
          [],
        );
        this.attach(comment.id, thread);
      }
      const label = this.labelFor(comment);
      const key = JSON.stringify([comment, label]);
      if (this.rendered.get(comment.id) === key) {
        continue;
      }
      this.rendered.set(comment.id, key);
      thread.label = label;
      thread.contextValue = comment.status;
      // Replies come from Claude for now; you reply by commenting again.
      thread.canReply = false;
      thread.state =
        comment.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.comments = [
        { body: new vscode.MarkdownString(comment.text), mode: vscode.CommentMode.Preview, author: { name: 'You' } },
        ...comment.replies.map((reply) => ({
          body: new vscode.MarkdownString(reply.text),
          mode: vscode.CommentMode.Preview,
          author: { name: reply.author === 'claude' ? 'Claude' : 'You' },
        })),
      ];
    }
    for (const [id, thread] of this.threads) {
      if (!live.has(id)) {
        thread.dispose();
        this.threads.delete(id);
        this.rendered.delete(id);
      }
    }
  }

  private labelFor(comment: CodeComment): string {
    const session = comment.sessionId ? this.sessions.all.find((s) => s.id === comment.sessionId) : undefined;
    const status = STATUS_LABEL[comment.status];
    return comment.status === 'draft' ? status : `${status} · ${session?.name ?? 'session gone'}`;
  }
}

/**
 * Picks the session to queue a comment on `file` on, from the running sessions in this window.
 * Sessions in the file's folder group are listed first; the only one there is preselected.
 */
export async function pickSessionFor(file: string, sessions: SessionStore): Promise<Session | undefined> {
  const running = sessions.all.filter((session) => session.terminal && session.status !== 'exited');
  if (!running.length) {
    vscode.window.showInformationMessage('No running Claude sessions in this window. Start one, or save the comment as a draft.');
    return undefined;
  }
  const fileGroup = groupFor(path.dirname(file)).dir;
  const groupOf = (session: Session) => {
    const dir = session.launchDir ?? session.cwd;
    return dir === undefined ? undefined : groupFor(dir).dir;
  };
  const inGroup = running.filter((session) => groupOf(session) === fileGroup);
  const suggested = inGroup.length === 1 ? inGroup[0] : undefined;
  const ordered = [...inGroup, ...running.filter((session) => !inGroup.includes(session))];
  const picked = await vscode.window.showQuickPick(
    ordered.map((session) => {
      const group = groupOf(session);
      return {
        label: session.name,
        description: [session.status, group && path.basename(group), session === suggested && 'suggested']
          .filter(Boolean)
          .join(' · '),
        session,
      };
    }),
    { placeHolder: 'Queue the comment on…' },
  );
  return picked?.session;
}
