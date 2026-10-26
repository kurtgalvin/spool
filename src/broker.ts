/**
 * Spool's broker: the one listener on the per-user socket, so hooks have a single address no
 * matter which VS Code window launched their session.
 *
 * - Hooks connect, send one HookMessage, and disconnect.
 * - Windows (extension hosts) connect, send `subscribe`, and receive every HookMessage; each
 *   window ignores terminals it doesn't own. They ping every PING_INTERVAL_MS.
 *
 * Runs detached, so it outlives window reloads. Exits once no window has pinged for
 * BROKER_IDLE_EXIT_MS, or when a window running a newer extension asks it to (so updates take
 * effect while windows stay open). Recent messages are replayed to new subscribers so hooks
 * fired during a reload aren't lost.
 *
 * Usage: broker.js <socketPath> <version> [logPath]
 */
import * as fs from 'fs';
import * as net from 'net';
import { BROKER_IDLE_EXIT_MS, BrokerHello, WindowMessage, readLines } from './ipc';

const REPLAY_MAX_AGE_MS = 60_000;
const REPLAY_MAX_COUNT = 500;

// Started with ELECTRON_RUN_AS_NODE so VS Code's executable runs as Node; don't pass it on to
// anything this process launches, where it would break Electron apps.
delete process.env.ELECTRON_RUN_AS_NODE;

const [socketPath, version, logPath] = process.argv.slice(2);
const subscribers = new Set<net.Socket>();
const recent: { at: number; line: string }[] = [];
let lastPing = Date.now();
/** Inode of the socket file this broker created; see ownsSocket(). */
let socketIno: number | undefined;

function log(message: string): void {
  if (logPath) {
    fs.appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  }
}

function parseWindowMessage(line: string): WindowMessage | undefined {
  try {
    const message = JSON.parse(line);
    return ['subscribe', 'ping', 'shutdown'].includes(message?.type) ? message : undefined;
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

function subscribe(socket: net.Socket, windowVersion: string): void {
  subscribers.add(socket);
  lastPing = Date.now();
  const hello: BrokerHello = { type: 'hello', version };
  socket.write(JSON.stringify(hello) + '\n');
  pruneRecent();
  for (const { line } of recent) {
    socket.write(line + '\n');
  }
  log(`window ${windowVersion} subscribed (${subscribers.size} connected, replayed ${recent.length})`);
}

/**
 * Whether the socket path is still this broker's file. When several brokers start at once
 * against a stale file, one can remove another's freshly created socket and listen in its
 * place; the one left behind is unreachable and must not unlink the winner's socket.
 */
function ownsSocket(): boolean {
  try {
    return socketIno !== undefined && fs.statSync(socketPath).ino === socketIno;
  } catch {
    return false;
  }
}

function exit(reason: string): never {
  log(`${reason}; exiting`);
  // Unlink first: once the path is gone, a window starting now spawns a fresh broker
  // rather than connecting to this one as it shuts down.
  if (ownsSocket()) {
    fs.rmSync(socketPath, { force: true });
  }
  process.exit(0);
}

const server = net.createServer((socket) => {
  let isWindow = false;
  readLines(socket, (line) => {
    const message = parseWindowMessage(line);
    if (message?.type === 'subscribe') {
      isWindow = true;
      subscribe(socket, message.version);
    } else if (message?.type === 'ping') {
      lastPing = Date.now();
    } else if (message?.type === 'shutdown') {
      exit('asked to shut down by a window');
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
  if (socketIno !== undefined && !ownsSocket()) {
    // Windows connected here reconnect to the broker that took over.
    exit('socket file was replaced by another broker');
  }
  if (Date.now() - lastPing > BROKER_IDLE_EXIT_MS) {
    exit('no window pinged recently');
  }
}, 1_000);

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
  socketIno = fs.statSync(socketPath).ino;
  log(`version ${version} listening on ${socketPath}`);
});
listen(true);
