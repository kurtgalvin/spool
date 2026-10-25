/**
 * Spool's MCP server. Claude Code starts one for each session Spool launches (see
 * resources/spool-mcp.json) and talks to it over stdio: newline-delimited JSON-RPC.
 *
 * Gives Claude the code comments sent to its session, and lets it reply in their threads.
 * The session is identified by the SPOOL_ID inherited from its terminal, and the tools take
 * no session argument, so a session can only see and answer its own comments. Comments are
 * read and written as files in Spool's global storage; windows watch those files.
 */
import * as path from 'path';
import * as readline from 'readline';
import type { CodeComment } from './comments';
import { JsonFiles } from './persistence';
import type { SavedSession } from './sessions';

const spoolId = process.env.SPOOL_ID;
const storage = process.env.SPOOL_STORAGE;

const INSTRUCTIONS = `Spool delivers code comments the user left in their editor. When told you have comments, \
call get_comments, then handle each one: a change request (make the change) or a question (answer it). \
Reply to every comment with the reply tool: a short summary of what you did, or the answer. The user \
resolves threads after reading your replies.`;

const TOOLS = [
  {
    name: 'get_comments',
    description:
      "Get the code comments the user sent to this session that have no reply yet, each with its thread so far. Answer the thread's latest message.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reply',
    description: "Reply in a comment's thread in the user's editor. Keep it short.",
    inputSchema: {
      type: 'object',
      properties: {
        comment_id: { type: 'string', description: 'The id from get_comments' },
        text: { type: 'string', description: 'The reply, in markdown' },
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

/** This session's comments. A terminal can host several sessions in a row (/clear), so match on all of them. */
function ownComments(files: JsonFiles<CodeComment>): CodeComment[] {
  const sessionIds = new Set(
    new JsonFiles<SavedSession>(path.join(storage!, 'sessions'))
      .loadAll()
      .filter((session) => session.terminalId === spoolId)
      .map((session) => session.id),
  );
  return files.loadAll().filter((comment) => comment.sessionId && sessionIds.has(comment.sessionId));
}

function formatComment(comment: CodeComment): string {
  let fence = '```';
  while (comment.code.includes(fence)) {
    fence += '`';
  }
  const lines =
    comment.startLine === comment.endLine
      ? `line ${comment.startLine + 1}`
      : `lines ${comment.startLine + 1}-${comment.endLine + 1}`;
  return [
    `## Comment ${comment.id}`,
    `${comment.file} (${lines}, as it was when commented):`,
    fence,
    comment.code,
    fence,
    `User: ${comment.text}`,
    ...comment.replies.map((reply) => `${reply.author === 'claude' ? 'Claude' : 'User'}: ${reply.text}`),
  ].join('\n');
}

function callTool(name: string | undefined, args: Record<string, unknown>): ToolResult {
  if (!spoolId || !storage) {
    return text('Spool comments are only available in sessions started from Spool.', true);
  }
  const files = new JsonFiles<CodeComment>(path.join(storage, 'comments'));
  const own = ownComments(files);
  if (name === 'get_comments') {
    const pending = own.filter((comment) => comment.status === 'sent' || comment.status === 'read');
    if (!pending.length) {
      return text('No comments waiting.');
    }
    for (const comment of pending) {
      if (comment.status === 'sent') {
        files.save({ ...comment, status: 'read' });
      }
    }
    const count = pending.length === 1 ? '1 comment' : `${pending.length} comments`;
    return text(
      `${count}. Reply to each with the reply tool, passing its id.\n\n${pending.map(formatComment).join('\n\n')}`,
    );
  }
  if (name === 'reply') {
    const comment = own.find((c) => c.id === args.comment_id);
    if (!comment) {
      return text(`No comment ${String(args.comment_id)} for this session.`, true);
    }
    if (typeof args.text !== 'string' || !args.text.trim()) {
      return text('The reply needs text.', true);
    }
    comment.replies.push({ author: 'claude', text: args.text, at: Date.now() });
    comment.status = 'replied';
    files.save(comment);
    return text('Replied.');
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
