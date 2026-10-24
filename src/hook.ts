/**
 * Run by Claude Code for each Spool hook. Reads the hook payload from stdin and forwards
 * it to the extension's IPC socket, tagged with this terminal's SPOOL_ID.
 *
 * Must never interfere with Claude: it always exits 0, prints nothing, and gives up quickly.
 */
import * as net from 'net';

const TIMEOUT_MS = 2000;

const spoolId = process.env.SPOOL_ID;
const socketPath = process.env.SPOOL_SOCKET;

function finish(): never {
  process.exit(0);
}

if (!spoolId || !socketPath) {
  finish();
}

setTimeout(finish, TIMEOUT_MS).unref();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => (input += chunk));
process.stdin.on('end', () => {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    finish();
  }
  const socket = net.connect(socketPath, () => {
    socket.end(JSON.stringify({ spoolId, payload }) + '\n');
  });
  socket.on('close', finish);
  socket.on('error', finish);
});
