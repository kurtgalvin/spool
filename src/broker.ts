/**
 * Spool's broker: the one listener on the per-user socket, so hooks have a single address no
 * matter which VS Code window launched their session.
 *
 * - Hook scripts connect, send one HookMessage, and disconnect.
 * - Windows (extension hosts) connect, send `subscribe`, and receive every HookMessage; each
 *   window ignores terminals it doesn't own. They ping every PING_INTERVAL_MS.
 *
 * Runs detached, so it outlives window reloads. Exits once no window has pinged for
 * BROKER_IDLE_EXIT_MS. Recent messages are replayed to new subscribers so hooks fired
 * during a reload aren't lost.
 *
 * Usage: broker.js <socketPath> [logPath]
 */
import * as fs from 'fs';
import * as net from 'net';
import { BROKER_IDLE_EXIT_MS, WindowMessage, readLines } from './ipc';

const REPLAY_MAX_AGE_MS = 60_000;
const REPLAY_MAX_COUNT = 500;

// Started with ELECTRON_RUN_AS_NODE so VS Code's executable runs as Node; don't pass it on to
// anything this process launches, where it would break Electron apps.
delete process.env.ELECTRON_RUN_AS_NODE;

const [socketPath, logPath] = process.argv.slice(2);
const subscribers = new Set<net.Socket>();
const recent: { at: number; line: string }[] = [];
let lastPing = Date.now();

function log(message: string): void {
  if (logPath) {
    fs.appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  }
}

function parseWindowMessage(line: string): WindowMessage | undefined {
  try {
    const message = JSON.parse(line);
    return message?.type === 'subscribe' || message?.type === 'ping' ? message : undefined;
  } catch {
    return undefined;
  }
}

function pruneRecent(): void {
  const cutoff = Date.now() - REPLAY_MAX_AGE_MS;
  while (recent.length && (recent.length > REPLAY_MAX_COUNT || recent[0].at < cutoff)) {
    recent.shift();
  }
}

function publish(line: string): void {
  recent.push({ at: Date.now(), line });
  pruneRecent();
  for (const subscriber of subscribers) {
    subscriber.write(line + '\n');
  }
}

function subscribe(socket: net.Socket): void {
  subscribers.add(socket);
  lastPing = Date.now();
  pruneRecent();
  for (const { line } of recent) {
    socket.write(line + '\n');
  }
  log(`window subscribed (${subscribers.size} connected, replayed ${recent.length})`);
}

const server = net.createServer((socket) => {
  let isWindow = false;
  readLines(socket, (line) => {
    const message = parseWindowMessage(line);
    if (message?.type === 'subscribe') {
      isWindow = true;
      subscribe(socket);
    } else if (message?.type === 'ping') {
      lastPing = Date.now();
    } else if (!isWindow) {
      // Anything else from a non-window connection is a hook message; windows filter what they need.
      publish(line);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (subscribers.delete(socket)) {
      log(`window disconnected (${subscribers.size} connected)`);
    }
  });
});

setInterval(() => {
  if (Date.now() - lastPing > BROKER_IDLE_EXIT_MS) {
    log('no window pinged recently; exiting');
    // Unlink first: once the path is gone, a window starting now spawns a fresh broker
    // rather than connecting to this one as it shuts down.
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  }
}, 5_000);

function listen(retryIfStale: boolean): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE' || !retryIfStale) {
      log(`listen failed: ${err.message}`);
      process.exit(1);
    }
    // Either another broker is running (two windows raced to start one) or the socket file is
    // left over from a crash. Only remove it if nothing answers.
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      log('another broker is already running; exiting');
      process.exit(0);
    });
    probe.once('error', () => {
      fs.rmSync(socketPath, { force: true });
      listen(false);
    });
  });
  server.listen(socketPath);
}

// Registered once: a failed listen() leaves its callback pending, so passing one per attempt
// would run it again on the retry.
server.once('listening', () => {
  fs.chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath}`);
});
listen(true);
