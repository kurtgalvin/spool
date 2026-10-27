/**
 * Wire protocol shared by the hook (hook/), the broker, and the extension. Everything is
 * newline-delimited JSON over one per-user Unix socket owned by the broker (see broker.ts).
 */
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * Bump on incompatible protocol changes: a new version gets its own socket and broker.
 * Compatible changes to the broker are picked up by version check instead (see BrokerHello).
 */
export const PROTOCOL_VERSION = 2;

/** How often a window pings the broker, and how long the broker waits without a ping before exiting. */
export const PING_INTERVAL_MS = 2_000;
/** Long enough to survive a window reload, during which nothing pings. */
export const BROKER_IDLE_EXIT_MS = 60_000;

/** A hook event forwarded by the hook, tagged with the terminal it came from. */
export interface HookMessage {
  spoolId: string;
  payload: Record<string, unknown>;
}

/**
 * Not a Claude Code hook: sent like one by the MCP server's rename_session, so the window that
 * owns the session renames it. Payload: `{hook_event_name, session_id, name}`.
 */
export const RENAME_EVENT = 'SpoolRename';
export const MAX_SESSION_NAME_LENGTH = 40;

/** What's wrong with a session name from Claude (already trimmed), or undefined if it's fine. */
export function checkSessionName(name: string): string | undefined {
  if (!name) {
    return 'The name is empty.';
  }
  if (/[\r\n]/.test(name)) {
    return 'The name must be one line.';
  }
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    return `The name is ${name.length} characters; keep it to ${MAX_SESSION_NAME_LENGTH} or fewer.`;
  }
  return undefined;
}

/**
 * Sent by a window: first line `subscribe` with its extension version, then `ping` every
 * PING_INTERVAL_MS. `shutdown` asks an outdated broker to exit so a newer one can start.
 */
export type WindowMessage = { type: 'subscribe'; version: string } | { type: 'ping' } | { type: 'shutdown' };

/** The broker's reply to `subscribe`, before any hook messages. */
export interface BrokerHello {
  type: 'hello';
  version: string;
}

export function isBrokerHello(value: unknown): value is BrokerHello {
  const message = value as BrokerHello | undefined;
  return message?.type === 'hello' && typeof message.version === 'string';
}

/** Compares dotted numeric versions (e.g. 0.1.10 > 0.1.9). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) {
      return Math.sign(diff);
    }
  }
  return 0;
}

/** The broker's socket. Stable per user, so Claude processes keep reaching it across reloads and windows. */
export function brokerSocketPath(): string {
  return path.join(os.tmpdir(), `spool-${os.userInfo().uid}-v${PROTOCOL_VERSION}.sock`);
}

export function isHookMessage(value: unknown): value is HookMessage {
  const message = value as HookMessage | undefined;
  return typeof message?.spoolId === 'string' && typeof message?.payload === 'object' && message.payload !== null;
}

/** Calls `onLine` for each non-empty line received on `socket`, including a final unterminated one. */
export function readLines(socket: net.Socket, onLine: (line: string) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        onLine(line);
      }
    }
  });
  socket.on('end', () => {
    if (buffer.trim()) {
      onLine(buffer);
    }
    buffer = '';
  });
}
