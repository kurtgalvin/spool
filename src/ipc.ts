/**
 * Wire protocol shared by the hook script, the broker, and the extension. Everything is
 * newline-delimited JSON over one per-user Unix socket owned by the broker (see broker.ts).
 */
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** Bump on incompatible protocol changes: a new version gets its own socket and broker. */
export const PROTOCOL_VERSION = 1;

/** How often a window pings the broker, and how long the broker waits without a ping before exiting. */
export const PING_INTERVAL_MS = 2_000;
/** Long enough to survive a window reload, during which nothing pings. */
export const BROKER_IDLE_EXIT_MS = 60_000;

/** A hook event forwarded by the hook script, tagged with the terminal it came from. */
export interface HookMessage {
  spoolId: string;
  payload: Record<string, unknown>;
}

/** Sent by a window: first line `subscribe`, then `ping` every PING_INTERVAL_MS. */
export type WindowMessage = { type: 'subscribe' } | { type: 'ping' };

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
