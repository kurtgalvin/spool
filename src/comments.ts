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
  /** For a walkthrough step: the walkthrough it's in. */
  walkthroughId?: string;
}

/** Claude's ordered steps across files explaining something. Each step is a comment. */
export interface Walkthrough {
  id: string;
  sessionId: string;
  title: string;
  /** Comment ids, in order. The only place the order is kept. */
  steps: string[];
  createdAt: number;
}

/**
 * Waiting on you to read Claude's reply or comment. A walkthrough step isn't until you've
 * replied in its thread and Claude answered: a new walkthrough would otherwise flag every step.
 */
export function awaitsYou(comment: CodeComment): boolean {
  return comment.status === 'replied' && !(comment.walkthroughId && !comment.replies.length);
}

export type NewComment = Pick<CodeComment, 'file' | 'startLine' | 'endLine' | 'code' | 'text'>;

export interface Persistence<T> {
  loadAll(): T[];
  save(item: T): void;
  delete(id: string): void;
}

export type CommentPersistence = Persistence<CodeComment>;

/**
 * Every comment and walkthrough, from every window: they're saved as files, and any window or
 * session's MCP server may change one, so the store mirrors the files rather than owning them.
 */
export class CommentStore implements vscode.Disposable {
  private readonly comments = new Map<string, CodeComment>();
  private readonly walkthroughMap = new Map<string, Walkthrough>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly persistence: CommentPersistence,
    private readonly walkthroughFiles: Persistence<Walkthrough> = { loadAll: () => [], save() {}, delete() {} },
  ) {
    this.sync();
  }

  get all(): CodeComment[] {
    return [...this.comments.values()];
  }

  get walkthroughs(): Walkthrough[] {
    return [...this.walkthroughMap.values()];
  }

  walkthroughOf(comment: CodeComment): Walkthrough | undefined {
    return comment.walkthroughId ? this.walkthroughMap.get(comment.walkthroughId) : undefined;
  }

  /** A walkthrough's steps in order, skipping any whose comment is gone. */
  stepsOf(walkthrough: Walkthrough): CodeComment[] {
    return walkthrough.steps.map((id) => this.comments.get(id)).filter((c): c is CodeComment => !!c);
  }

  /** Resolves or reopens every step. */
  setWalkthroughResolved(walkthrough: Walkthrough, resolved: boolean): void {
    for (const step of this.stepsOf(walkthrough)) {
      step.status = resolved ? 'resolved' : 'replied';
      this.persistence.save(step);
    }
    this.changed.fire();
  }

  deleteWalkthrough(walkthrough: Walkthrough): void {
    for (const step of this.stepsOf(walkthrough)) {
      this.comments.delete(step.id);
      this.persistence.delete(step.id);
    }
    this.walkthroughMap.delete(walkthrough.id);
    this.walkthroughFiles.delete(walkthrough.id);
    this.changed.fire();
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

  /** Deleting a walkthrough's last step deletes the walkthrough. */
  delete(comment: CodeComment): void {
    this.comments.delete(comment.id);
    this.persistence.delete(comment.id);
    const walkthrough = this.walkthroughOf(comment);
    if (walkthrough) {
      walkthrough.steps = walkthrough.steps.filter((id) => id !== comment.id);
      if (walkthrough.steps.length) {
        this.walkthroughFiles.save(walkthrough);
      } else {
        this.walkthroughMap.delete(walkthrough.id);
        this.walkthroughFiles.delete(walkthrough.id);
      }
    }
    this.changed.fire();
  }

  /** Brings the store in line with the comment and walkthrough files, which other windows also write. */
  sync(): void {
    const comments = mirror(this.comments, this.persistence.loadAll());
    const walkthroughs = mirror(this.walkthroughMap, this.walkthroughFiles.loadAll());
    if (comments || walkthroughs) {
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

/** Updates `items` to match `files`; returns whether anything changed. */
function mirror<T extends { id: string }>(items: Map<string, T>, files: T[]): boolean {
  const dropped = new Set(items.keys());
  let changed = false;
  for (const file of files) {
    dropped.delete(file.id);
    const existing = items.get(file.id);
    if (!existing) {
      items.set(file.id, file);
      changed = true;
    } else if (JSON.stringify(existing) !== JSON.stringify(file)) {
      // Replace in place: views track items by object.
      for (const key of Object.keys(existing)) {
        delete (existing as unknown as Record<string, unknown>)[key];
      }
      Object.assign(existing, file);
      changed = true;
    }
  }
  for (const id of dropped) {
    items.delete(id);
    changed = true;
  }
  return changed;
}
