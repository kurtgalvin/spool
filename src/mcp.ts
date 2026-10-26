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
import * as path from 'path';
import * as readline from 'readline';
import type { CodeComment } from './comments';
import { JsonFiles } from './persistence';
import type { SavedSession } from './sessions';

const spoolId = process.env.SPOOL_ID;
const storage = process.env.SPOOL_STORAGE;

/** Wide reads (anything but the default) return at most this many comments, newest first. */
const READ_LIMIT = 20;

const INSTRUCTIONS = `Spool delivers code comments the user left in their editor. When told you have comments, \
call read_comments with no arguments, then handle each one: a change request (make the change) or a question \
(answer it). Reply to every comment with reply_to_comment: a short summary of what you did, or the answer. The \
user resolves threads after reading your replies. read_comments' filters are for background, e.g. what the user \
said about a file before you change it; don't answer resolved threads. Use add_comment to leave the user a note on \
code when they ask for one (a review, "point out…") or something needs their attention; never on every edit.`;

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

function formatComment(comment: CodeComment, location: Location): string {
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

function readComments(files: JsonFiles<CodeComment>, own: CodeComment[], args: Record<string, unknown>): ToolResult {
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
  return text(`${header}\n\n${matches.map(({ comment, location }) => formatComment(comment, location)).join('\n\n')}`);
}

function callTool(name: string | undefined, args: Record<string, unknown>): ToolResult {
  if (!spoolId || !storage) {
    return text('Spool comments are only available in sessions started from Spool.', true);
  }
  const files = new JsonFiles<CodeComment>(path.join(storage, 'comments'));
  const own = ownComments(files);
  if (name === 'read_comments') {
    return readComments(files, own, args);
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

function handle(request: Request): unknown {
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

readline.createInterface({ input: process.stdin }).on('line', (line) => {
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
    const result = handle(request);
    if (result === undefined) {
      send({ id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
    } else {
      send({ id: request.id, result });
    }
  } catch (err) {
    send({ id: request.id, error: { code: -32603, message: (err as Error).message } });
  }
});
