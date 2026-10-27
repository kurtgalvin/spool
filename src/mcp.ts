/**
 * Spool's MCP server. Claude Code starts one for each session Spool launches (see
 * resources/spool-mcp.json) and talks to it over stdio: newline-delimited JSON-RPC.
 *
 * Gives Claude the code comments sent to its session, and lets it reply in their threads.
 * The session is identified by the SPOOL_ID inherited from its terminal, and the tools take
 * no session argument, so a session can only see and answer its own comments. Comments are
 * read and written as files in Spool's global storage; windows watch those files.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as readline from 'readline';
import type { CodeComment, Walkthrough } from './comments';
import { HookMessage, RENAME_EVENT, checkSessionName } from './ipc';
import { JsonFiles } from './persistence';
import type { SavedSession } from './sessions';

const spoolId = process.env.SPOOL_ID;
const storage = process.env.SPOOL_STORAGE;
/** The broker's socket, which hooks use; rename_session sends through it too. */
const socketPath = process.env.SPOOL_SOCKET;

/** Wide reads (anything but the default) return at most this many comments, newest first. */
const READ_LIMIT = 20;

const INSTRUCTIONS = `Spool delivers code comments the user left in their editor. When told you have comments, \
call read_comments with no arguments, then handle each one: a change request (make the change) or a question \
(answer it). Reply to every comment with reply_to_comment: a short summary of what you did, or the answer. The \
user resolves threads after reading your replies. read_comments' filters are for background, e.g. what the user \
said about a file before you change it; don't answer resolved threads. Use add_comment to leave the user a note on \
code when they ask for one (a review, "point out…") or something needs their attention; never on every edit. Use \
add_walkthrough when asked how something works across files, or to explain a change: ordered steps the user moves \
through with Previous / Next. When the user replies on a step you can answer, change the walkthrough (add_steps, \
edit_comment, remove_steps, update_walkthrough), or both; say what you changed in your reply. Call rename_session \
only when asked to name or rename this session: a short name, 2-4 words, for what the session is working on.`;

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Absolute, or relative to your working directory' },
    start_line: { type: 'number', description: 'First line (1-based)' },
    end_line: { type: 'number', description: 'Last line (1-based, inclusive); defaults to start_line' },
    text: { type: 'string', description: 'What this step explains, in markdown' },
  },
  required: ['file', 'start_line', 'text'],
};

const TOOLS = [
  {
    name: 'read_comments',
    description:
      "Read the code comments the user sent to this session, each with its thread so far and whether the code changed since. With no arguments: the comments waiting for your answer (answer each thread's latest message). Filters look up older comments without changing them.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['waiting', 'replied', 'resolved', 'all'],
          description:
            "waiting (default): sent to you, not answered yet. replied: you answered, the user hasn't resolved it. resolved: done. all: any.",
        },
        file: { type: 'string', description: 'Only comments on this file (absolute, or relative to your working directory)' },
        start_line: { type: 'number', description: "With file: only comments overlapping these lines (1-based)" },
        end_line: { type: 'number', description: 'With file: end of the line range (1-based, inclusive)' },
      },
    },
  },
  {
    name: 'reply_to_comment',
    description: "Reply in a comment's thread in the user's editor. Keep it short.",
    inputSchema: {
      type: 'object',
      properties: {
        comment_id: { type: 'string', description: 'The id from read_comments' },
        text: { type: 'string', description: 'The reply, in markdown' },
      },
      required: ['comment_id', 'text'],
    },
  },
  {
    name: 'add_comment',
    description:
      "Leave the user a comment on code in their editor, starting a thread they can reply to. For a review, or something they need to look at; not for every edit.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute, or relative to your working directory' },
        start_line: { type: 'number', description: 'First line (1-based)' },
        end_line: { type: 'number', description: 'Last line (1-based, inclusive); defaults to start_line' },
        text: { type: 'string', description: 'The comment, in markdown' },
      },
      required: ['file', 'start_line', 'text'],
    },
  },
  {
    name: 'edit_comment',
    description: 'Rewrite the text of a comment you started (not the user\'s comments, not replies).',
    inputSchema: {
      type: 'object',
      properties: {
        comment_id: { type: 'string', description: 'The id from add_comment or read_comments' },
        text: { type: 'string', description: 'The new text, in markdown' },
      },
      required: ['comment_id', 'text'],
    },
  },
  {
    name: 'add_walkthrough',
    description:
      'Create a walkthrough in the user\'s editor: ordered steps on code across files that explain something, which they step through with Previous / Next and can reply on. Each step is a comment.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What it explains, e.g. "How hooks reach the sidebar"' },
        steps: { type: 'array', items: STEP_SCHEMA, description: 'In order' },
      },
      required: ['title', 'steps'],
    },
  },
  {
    name: 'add_steps',
    description: 'Insert steps into one of your walkthroughs, after a given step or at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        walkthrough_id: { type: 'string' },
        after_step: { type: 'string', description: 'Step (comment) id to insert after; omit to add at the end' },
        steps: { type: 'array', items: STEP_SCHEMA, description: 'In order' },
      },
      required: ['walkthrough_id', 'steps'],
    },
  },
  {
    name: 'remove_steps',
    description: "Remove steps from one of your walkthroughs. Steps the user replied on can't be removed.",
    inputSchema: {
      type: 'object',
      properties: {
        walkthrough_id: { type: 'string' },
        step_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['walkthrough_id', 'step_ids'],
    },
  },
  {
    name: 'update_walkthrough',
    description: 'Rename one of your walkthroughs, or reorder its steps.',
    inputSchema: {
      type: 'object',
      properties: {
        walkthrough_id: { type: 'string' },
        title: { type: 'string' },
        order: { type: 'array', items: { type: 'string' }, description: 'Every step id, in the new order' },
      },
      required: ['walkthrough_id'],
    },
  },
  {
    name: 'rename_session',
    description:
      "Rename this session in the user's Spool sidebar and terminal tab. Only when asked to name or rename it. " +
      'A short name, 2-4 words, for what the session is working on.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'One line, at most 40 characters' } },
      required: ['name'],
    },
  },
];

interface Request {
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], isError });

/** The sessions that ran in this terminal: it can host several in a row (/clear). */
function ownSessions(): SavedSession[] {
  return new JsonFiles<SavedSession>(path.join(storage!, 'sessions'))
    .loadAll()
    .filter((session) => session.terminalId === spoolId);
}

/** This session's comments: on any session that ran in this terminal. */
function ownComments(files: JsonFiles<CodeComment>): CodeComment[] {
  const sessionIds = new Set(ownSessions().map((session) => session.id));
  return files.loadAll().filter((comment) => comment.sessionId && sessionIds.has(comment.sessionId));
}

/** The session running in this terminal now, which new comments attach to. */
function currentSession(): SavedSession | undefined {
  const sessions = ownSessions();
  return sessions.find((session) => session.status !== 'exited') ?? sessions[0];
}

/** A file and 1-based line range from a tool's arguments, checked against the file: 0-based lines and their text. */
function codeRange(
  args: Record<string, unknown>,
): { file: string; startLine: number; endLine: number; code: string } | string {
  if (typeof args.file !== 'string' || !args.file) {
    return 'file is required.';
  }
  const file = path.resolve(args.file);
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').map((line) => line.replace(/\r$/, ''));
  } catch {
    return `Can't read ${file}.`;
  }
  const start = typeof args.start_line === 'number' ? Math.floor(args.start_line) : NaN;
  const end = typeof args.end_line === 'number' ? Math.floor(args.end_line) : start;
  if (!(start >= 1 && end >= start && end <= lines.length)) {
    return `Lines ${args.start_line}-${args.end_line ?? args.start_line} aren't in ${file}, which has ${lines.length} lines.`;
  }
  return { file, startLine: start - 1, endLine: end - 1, code: lines.slice(start - 1, end).join('\n') };
}

/** Step comments for `walkthrough` from a tool's `steps` argument, or what's wrong with it. Not saved yet. */
function newSteps(value: unknown, walkthrough: Walkthrough): CodeComment[] | string {
  if (!Array.isArray(value) || !value.length) {
    return 'steps must be a non-empty list.';
  }
  const steps: CodeComment[] = [];
  for (const [i, step] of value.entries()) {
    const range = typeof step === 'object' && step ? codeRange(step) : 'not an object.';
    if (typeof range === 'string') {
      return `Step ${i + 1}: ${range}`;
    }
    if (!hasText(step)) {
      return `Step ${i + 1} needs text.`;
    }
    steps.push({
      id: randomUUID(),
      ...range,
      text: step.text,
      status: 'replied',
      sessionId: walkthrough.sessionId,
      replies: [],
      createdAt: Date.now(),
      author: 'claude',
      unseen: true,
      walkthroughId: walkthrough.id,
    });
  }
  return steps;
}

function editWalkthrough(
  name: 'add_steps' | 'remove_steps' | 'update_walkthrough',
  walkthrough: Walkthrough,
  args: Record<string, unknown>,
  files: JsonFiles<CodeComment>,
  walkthroughFiles: JsonFiles<Walkthrough>,
  own: CodeComment[],
): ToolResult {
  if (name === 'add_steps') {
    const after = args.after_step === undefined ? walkthrough.steps.length - 1 : walkthrough.steps.indexOf(String(args.after_step));
    if (after < 0 && args.after_step !== undefined) {
      return text(`${String(args.after_step)} isn't a step of this walkthrough.`, true);
    }
    const steps = newSteps(args.steps, walkthrough);
    if (typeof steps === 'string') {
      return text(steps, true);
    }
    for (const step of steps) {
      files.save(step);
    }
    walkthrough.steps.splice(after + 1, 0, ...steps.map((step) => step.id));
    walkthroughFiles.save(walkthrough);
    return text(`Added ${steps.map((step) => `${step.id} (step ${walkthrough.steps.indexOf(step.id) + 1})`).join(', ')}.`);
  }
  if (name === 'remove_steps') {
    const ids = Array.isArray(args.step_ids) ? args.step_ids.map(String) : [];
    const unknown = ids.filter((id) => !walkthrough.steps.includes(id));
    if (!ids.length || unknown.length) {
      return text(ids.length ? `Not steps of this walkthrough: ${unknown.join(', ')}.` : 'step_ids is required.', true);
    }
    // Removing a step deletes its thread, and with it anything the user wrote there.
    const repliedOn = ids.filter((id) => own.find((c) => c.id === id)?.replies.some((reply) => reply.author === 'you'));
    if (repliedOn.length) {
      return text(`The user replied on ${repliedOn.join(', ')}; those can't be removed. Edit or add steps instead.`, true);
    }
    for (const id of ids) {
      files.delete(id);
    }
    walkthrough.steps = walkthrough.steps.filter((id) => !ids.includes(id));
    if (walkthrough.steps.length) {
      walkthroughFiles.save(walkthrough);
      return text(`Removed ${ids.length === 1 ? '1 step' : `${ids.length} steps`}; ${walkthrough.steps.length} left.`);
    }
    walkthroughFiles.delete(walkthrough.id);
    return text('Removed every step, so the walkthrough is gone.');
  }
  if (args.title !== undefined) {
    if (typeof args.title !== 'string' || !args.title.trim()) {
      return text('The title needs text.', true);
    }
    walkthrough.title = args.title.trim();
  }
  if (args.order !== undefined) {
    const order = Array.isArray(args.order) ? args.order.map(String) : [];
    const same = order.length === walkthrough.steps.length && [...order].sort().join() === [...walkthrough.steps].sort().join();
    if (!same) {
      return text('order must list every step id exactly once.', true);
    }
    walkthrough.steps = order;
  }
  walkthroughFiles.save(walkthrough);
  return text('Updated.');
}

function hasText(args: Record<string, unknown>): args is { text: string } {
  return typeof args.text === 'string' && !!args.text.trim();
}

type Status = 'waiting' | 'replied' | 'resolved' | 'all';

const STATUS_NOTE: Record<CodeComment['status'], string> = {
  draft: 'draft',
  queued: 'queued',
  sent: 'waiting for your answer',
  read: 'waiting for your answer',
  replied: "answered; the user hasn't resolved it",
  resolved: 'resolved by the user',
};

function matchesStatus(comment: CodeComment, status: Status): boolean {
  switch (status) {
    case 'waiting':
      return comment.status === 'sent' || comment.status === 'read';
    case 'replied':
      return comment.status === 'replied';
    case 'resolved':
      return comment.status === 'resolved';
    case 'all':
      return comment.status !== 'draft' && comment.status !== 'queued';
  }
}

/** Where a comment's code is now. Lines are 0-based. */
type Location =
  | { kind: 'unchanged' }
  | { kind: 'moved'; startLine: number; endLine: number }
  | { kind: 'changed'; current?: string }
  | { kind: 'missing' };

/**
 * Compares a comment's snapshot with its file, ignoring indentation: still at its lines, moved
 * elsewhere in the file (the nearest match), changed, or the file is gone.
 */
function locate(comment: Pick<CodeComment, 'code' | 'startLine' | 'endLine'>, fileText: string | undefined): Location {
  if (fileText === undefined) {
    return { kind: 'missing' };
  }
  const lines = fileText.split('\n').map((line) => line.replace(/\r$/, ''));
  const snapshot = comment.code.split('\n').map((line) => line.trim());
  const at = (start: number) => snapshot.every((line, i) => lines[start + i]?.trim() === line);
  if (at(comment.startLine)) {
    return { kind: 'unchanged' };
  }
  // Blank lines would match anywhere.
  if (snapshot.some(Boolean)) {
    let best: number | undefined;
    for (let start = 0; start + snapshot.length <= lines.length; start++) {
      if (at(start) && (best === undefined || Math.abs(start - comment.startLine) < Math.abs(best - comment.startLine))) {
        best = start;
      }
    }
    if (best !== undefined) {
      return { kind: 'moved', startLine: best, endLine: best + snapshot.length - 1 };
    }
  }
  const current = lines.slice(comment.startLine, comment.endLine + 1);
  return { kind: 'changed', current: current.length ? current.join('\n') : undefined };
}

function lineRange(start: number, end: number): string {
  return start === end ? `line ${start + 1}` : `lines ${start + 1}-${end + 1}`;
}

function fenced(code: string): string[] {
  let fence = '```';
  while (code.includes(fence)) {
    fence += '`';
  }
  return [fence, code, fence];
}

/** For a step: where it is in its walkthrough, and an outline of every step. */
function walkthroughContext(comment: CodeComment, walkthroughs: Map<string, Walkthrough>, all: CodeComment[]): string[] {
  const walkthrough = comment.walkthroughId ? walkthroughs.get(comment.walkthroughId) : undefined;
  if (!walkthrough) {
    return [];
  }
  const steps = walkthrough.steps.map((id) => all.find((c) => c.id === id)).filter((c): c is CodeComment => !!c);
  const outline = steps.map(
    (step, i) =>
      `${i + 1}. ${step.id} ${path.relative(process.cwd(), step.file)}:${step.startLine + 1}${step.id === comment.id ? ' (this step)' : ''}`,
  );
  return [
    `Step ${steps.indexOf(comment) + 1} of ${steps.length} in walkthrough ${walkthrough.id} "${walkthrough.title}". Steps:`,
    ...outline,
  ];
}

function formatComment(comment: CodeComment, location: Location, context: string[] = []): string {
  const status =
    location.kind === 'unchanged'
      ? 'Code: unchanged since the comment.'
      : location.kind === 'moved'
        ? `Code: moved to ${lineRange(location.startLine, location.endLine)}.`
        : location.kind === 'missing'
          ? 'Code: file not found (deleted or renamed).'
          : location.current === undefined
            ? 'Code: changed since the comment; those lines no longer exist.'
            : 'Code: changed since the comment. Those lines now read:';
  return [
    `## Comment ${comment.id} (${STATUS_NOTE[comment.status]})`,
    ...context,
    `${comment.file} (${lineRange(comment.startLine, comment.endLine)}, as it was when commented):`,
    ...fenced(comment.code),
    status,
    ...(location.kind === 'changed' && location.current !== undefined ? fenced(location.current) : []),
    `${comment.author === 'claude' ? 'Claude' : 'User'}: ${comment.text}`,
    ...comment.replies.map((reply) => `${reply.author === 'claude' ? 'Claude' : 'User'}: ${reply.text}`),
  ].join('\n');
}

function readFile(file: string, cache: Map<string, string | undefined>): string | undefined {
  if (!cache.has(file)) {
    try {
      cache.set(file, fs.readFileSync(file, 'utf8'));
    } catch {
      cache.set(file, undefined);
    }
  }
  return cache.get(file);
}

function lastActivity(comment: CodeComment): number {
  return comment.replies.at(-1)?.at ?? comment.createdAt;
}

function readComments(
  files: JsonFiles<CodeComment>,
  own: CodeComment[],
  walkthroughs: Map<string, Walkthrough>,
  args: Record<string, unknown>,
): ToolResult {
  const status = (args.status ?? 'waiting') as Status;
  if (!['waiting', 'replied', 'resolved', 'all'].includes(status)) {
    return text(`Unknown status ${String(args.status)}.`, true);
  }
  const file = typeof args.file === 'string' && args.file ? path.resolve(args.file) : undefined;
  const startLine = typeof args.start_line === 'number' ? args.start_line - 1 : undefined;
  const endLine = typeof args.end_line === 'number' ? args.end_line - 1 : startLine;
  if (startLine !== undefined && !file) {
    return text('start_line needs file.', true);
  }
  // The default read is how new comments are delivered; any filter is a lookup.
  const isDefault = args.status === undefined && !file;
  const contents = new Map<string, string | undefined>();
  let matches = own
    .filter((comment) => matchesStatus(comment, status) && (!file || comment.file === file))
    .map((comment) => ({ comment, location: locate(comment, readFile(comment.file, contents)) }))
    .filter(({ comment, location }) => {
      if (startLine === undefined) {
        return true;
      }
      const [start, end] =
        location.kind === 'moved' ? [location.startLine, location.endLine] : [comment.startLine, comment.endLine];
      return start <= endLine! && end >= startLine;
    });
  if (!matches.length) {
    return text(isDefault ? 'No comments waiting.' : 'No comments match.');
  }
  let more = 0;
  if (status !== 'waiting') {
    matches.sort((a, b) => lastActivity(b.comment) - lastActivity(a.comment));
    more = Math.max(0, matches.length - READ_LIMIT);
    matches = matches.slice(0, READ_LIMIT);
  }
  if (isDefault) {
    for (const { comment } of matches) {
      if (comment.status === 'sent') {
        files.save({ ...comment, status: 'read' });
      }
    }
  }
  const count = matches.length === 1 ? '1 comment' : `${matches.length} comments`;
  const header = isDefault
    ? `${count}. Reply to each with reply_to_comment, passing its id.`
    : `${count}${more ? ` (the newest; ${more} more match)` : ''}.`;
  const formatted = matches.map(({ comment, location }) =>
    formatComment(comment, location, walkthroughContext(comment, walkthroughs, own)),
  );
  return text(`${header}\n\n${formatted.join('\n\n')}`);
}

/** How long rename_session waits for the window to save the name, in 100ms steps. */
const RENAME_WAIT_STEPS = 30;

/**
 * Sessions belong to the window that started them, which writes their files, so the rename
 * goes to it over the broker like a hook. Waits for the window to save the new name.
 */
async function renameSession(args: Record<string, unknown>): Promise<ToolResult> {
  const session = currentSession();
  if (!session || session.status === 'exited' || !socketPath) {
    return text('No running Spool session for this terminal.', true);
  }
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const problem = checkSessionName(name);
  if (problem) {
    return text(problem, true);
  }
  const message: HookMessage = {
    spoolId: spoolId!,
    payload: { hook_event_name: RENAME_EVENT, session_id: session.claudeSessionId, name },
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(socketPath, () => socket.end(JSON.stringify(message) + '\n'));
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });
  } catch (err) {
    return text(`Couldn't reach Spool: ${(err as Error).message}`, true);
  }
  for (let i = 0; i < RENAME_WAIT_STEPS; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const saved = ownSessions().find((s) => s.id === session.id);
    if (saved?.name === name && saved.nameSource === 'agent') {
      return text(`Renamed the session to "${name}".`);
    }
  }
  return text("Sent the rename, but Spool hasn't applied it. Is the editor window that started this session open?", true);
}

function callTool(name: string | undefined, args: Record<string, unknown>): ToolResult | Promise<ToolResult> {
  if (!spoolId || !storage) {
    return text('Spool comments are only available in sessions started from Spool.', true);
  }
  if (name === 'rename_session') {
    return renameSession(args);
  }
  const files = new JsonFiles<CodeComment>(path.join(storage, 'comments'));
  const walkthroughFiles = new JsonFiles<Walkthrough>(path.join(storage, 'walkthroughs'));
  const own = ownComments(files);
  const sessionIds = new Set(ownSessions().map((session) => session.id));
  const walkthroughs = new Map(
    walkthroughFiles
      .loadAll()
      .filter((walkthrough) => sessionIds.has(walkthrough.sessionId))
      .map((walkthrough) => [walkthrough.id, walkthrough]),
  );
  if (name === 'read_comments') {
    return readComments(files, own, walkthroughs, args);
  }
  if (name === 'add_walkthrough') {
    const session = currentSession();
    if (!session) {
      return text('No Spool session for this terminal.', true);
    }
    if (typeof args.title !== 'string' || !args.title.trim()) {
      return text('The walkthrough needs a title.', true);
    }
    const walkthrough: Walkthrough = {
      id: randomUUID(),
      sessionId: session.id,
      title: args.title.trim(),
      steps: [],
      createdAt: Date.now(),
    };
    const steps = newSteps(args.steps, walkthrough);
    if (typeof steps === 'string') {
      return text(steps, true);
    }
    for (const step of steps) {
      files.save(step);
    }
    walkthrough.steps = steps.map((step) => step.id);
    walkthroughFiles.save(walkthrough);
    return text(`Added walkthrough ${walkthrough.id} with steps:\n${steps.map((step, i) => `${i + 1}. ${step.id}`).join('\n')}`);
  }
  if (name === 'add_steps' || name === 'remove_steps' || name === 'update_walkthrough') {
    const walkthrough = walkthroughs.get(String(args.walkthrough_id));
    if (!walkthrough) {
      return text(`No walkthrough ${String(args.walkthrough_id)} for this session.`, true);
    }
    return editWalkthrough(name, walkthrough, args, files, walkthroughFiles, own);
  }
  if (name === 'reply_to_comment') {
    const comment = own.find((c) => c.id === args.comment_id);
    if (!comment) {
      return text(`No comment ${String(args.comment_id)} for this session.`, true);
    }
    if (!hasText(args)) {
      return text('The reply needs text.', true);
    }
    comment.replies.push({ author: 'claude', text: args.text, at: Date.now() });
    comment.status = 'replied';
    files.save(comment);
    return text('Replied.');
  }
  if (name === 'add_comment') {
    const session = currentSession();
    const range = codeRange(args);
    if (!session || typeof range === 'string') {
      return text(session ? (range as string) : 'No Spool session for this terminal.', true);
    }
    if (!hasText(args)) {
      return text('The comment needs text.', true);
    }
    const comment: CodeComment = {
      id: randomUUID(),
      ...range,
      text: args.text,
      status: 'replied',
      sessionId: session.id,
      replies: [],
      createdAt: Date.now(),
      author: 'claude',
      unseen: true,
    };
    files.save(comment);
    return text(`Added comment ${comment.id}.`);
  }
  if (name === 'edit_comment') {
    const comment = own.find((c) => c.id === args.comment_id);
    if (!comment) {
      return text(`No comment ${String(args.comment_id)} for this session.`, true);
    }
    if (comment.author !== 'claude') {
      return text("That comment is the user's; you can only edit comments you started. Reply instead.", true);
    }
    if (!hasText(args)) {
      return text('The comment needs text.', true);
    }
    files.save({ ...comment, text: args.text, editedAt: Date.now() });
    return text('Edited.');
  }
  return text(`Unknown tool ${name}.`, true);
}

function handle(request: Request): unknown | Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        // Echo the client's version: this server only uses what every version has.
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'spool', version: '1' },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(request.params?.name, request.params?.arguments ?? {});
    default:
      return undefined;
  }
}

function send(message: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request: Request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  // Without an id it's a notification (e.g. notifications/initialized): no response.
  if (request.id === undefined) {
    return;
  }
  try {
    const result = await handle(request);
    if (result === undefined) {
      send({ id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
    } else {
      send({ id: request.id, result });
    }
  } catch (err) {
    send({ id: request.id, error: { code: -32603, message: (err as Error).message } });
  }
});
