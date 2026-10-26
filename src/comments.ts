import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

/**
 * - draft: no session chosen yet.
 * - queued: attached to a session, not sent yet.
 * - sent: the prompt was typed into the session.
 * - read: Claude fetched it.
 * - replied: Claude posted a reply.
 * - resolved: you marked it done.
 */
export type CommentStatus = 'draft' | 'queued' | 'sent' | 'read' | 'replied' | 'resolved';

export interface ThreadReply {
  author: 'claude' | 'you';
  text: string;
  at: number;
}

/** A comment on code for Claude, and the replies in its thread. */
export interface CodeComment {
  id: string;
  /** Absolute path of the commented file. */
  file: string;
  /** Zero-based and inclusive. */
  startLine: number;
  endLine: number;
  /** The commented lines when the comment was made; the file may have changed since. */
  code: string;
  text: string;
  status: CommentStatus;
  /** The Spool session the comment is queued on or was sent to. */
  sessionId?: string;
  replies: ThreadReply[];
  createdAt: number;
  /** Who started the thread; absent means you. Claude's comments start as replied: waiting on you. */
  author?: 'claude';
  /** Claude's comment you haven't opened yet. */
  unseen?: boolean;
  /** When Claude last rewrote its text. */
  editedAt?: number;
}

export type NewComment = Pick<CodeComment, 'file' | 'startLine' | 'endLine' | 'code' | 'text'>;

export interface CommentPersistence {
  loadAll(): CodeComment[];
  save(comment: CodeComment): void;
  delete(id: string): void;
}

/**
 * Every comment, from every window: comments are saved as files, and any window (or, later,
 * a session's MCP server) may change one, so the store mirrors the files rather than owning them.
 */
export class CommentStore implements vscode.Disposable {
  private readonly comments = new Map<string, CodeComment>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly persistence: CommentPersistence) {
    this.sync();
  }

  get all(): CodeComment[] {
    return [...this.comments.values()];
  }

  queuedOn(sessionId: string): CodeComment[] {
    return this.all.filter((comment) => comment.sessionId === sessionId && comment.status === 'queued');
  }

  /** Queued on `sessionId` if given, otherwise a draft. */
  add(fields: NewComment, sessionId?: string, id: string = randomUUID()): CodeComment {
    const comment: CodeComment = {
      ...fields,
      id,
      status: sessionId ? 'queued' : 'draft',
      sessionId,
      replies: [],
      createdAt: Date.now(),
    };
    this.comments.set(comment.id, comment);
    this.save(comment);
    return comment;
  }

  /** Queues a draft on a session, or moves a queued comment to another one. */
  queue(comment: CodeComment, sessionId: string): void {
    comment.sessionId = sessionId;
    comment.status = 'queued';
    this.save(comment);
  }

  /** Your follow-up in a comment's thread. It's queued like a new comment until sent. */
  addReply(comment: CodeComment, text: string): void {
    comment.replies.push({ author: 'you', text, at: Date.now() });
    comment.status = 'queued';
    delete comment.unseen;
    this.save(comment);
  }

  /** You opened Claude's comment. */
  markSeen(comment: CodeComment): void {
    if (comment.unseen) {
      delete comment.unseen;
      this.save(comment);
    }
  }

  /** Marks a comment done, or reopens it as replied. */
  setResolved(comment: CodeComment, resolved: boolean): void {
    comment.status = resolved ? 'resolved' : 'replied';
    this.save(comment);
  }

  /** After the session was told about them. */
  markSent(comments: CodeComment[]): void {
    for (const comment of comments) {
      comment.status = 'sent';
      this.persistence.save(comment);
    }
    this.changed.fire();
  }

  delete(comment: CodeComment): void {
    this.comments.delete(comment.id);
    this.persistence.delete(comment.id);
    this.changed.fire();
  }

  /** Brings the store in line with the comment files, which other windows also write. */
  sync(): void {
    const files = this.persistence.loadAll();
    const dropped = new Set(this.comments.keys());
    let changed = false;
    for (const file of files) {
      dropped.delete(file.id);
      const existing = this.comments.get(file.id);
      if (!existing) {
        this.comments.set(file.id, file);
        changed = true;
      } else if (JSON.stringify(existing) !== JSON.stringify(file)) {
        // Replace in place: views track comments by object.
        for (const key of Object.keys(existing)) {
          delete (existing as unknown as Record<string, unknown>)[key];
        }
        Object.assign(existing, file);
        changed = true;
      }
    }
    for (const id of dropped) {
      this.comments.delete(id);
      changed = true;
    }
    if (changed) {
      this.changed.fire();
    }
  }

  dispose(): void {
    this.changed.dispose();
  }

  private save(comment: CodeComment): void {
    this.persistence.save(comment);
    this.changed.fire();
  }
}
