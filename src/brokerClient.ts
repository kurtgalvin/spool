import { spawn } from 'child_process';
import * as net from 'net';
import * as vscode from 'vscode';
import {
  HookMessage,
  PING_INTERVAL_MS,
  WindowMessage,
  compareVersions,
  isBrokerHello,
  isHookMessage,
  readLines,
} from './ipc';

const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_MS = 100;
const RECONNECT_DELAY_MS = 500;
/**
 * After losing the broker, how long to look for one another window started before starting
 * one. Lets the window that replaced an outdated broker win; otherwise every window would race
 * to start its own version.
 */
const SPAWN_GRACE_MS = 2_000;

/**
 * This window's connection to the broker. Starts the broker if none is running, subscribes to
 * hook messages, pings so the broker knows a window still needs it, and reconnects (starting a
 * new broker if needed) whenever the connection drops. A broker from an older extension
 * version is asked to shut down and replaced, so updates apply without closing every window.
 */
export class BrokerClient implements vscode.Disposable {
  private socket?: net.Socket;
  private pingTimer?: NodeJS.Timeout;
  private disposed = false;
  /** Set when this window asked the broker to exit, so it starts the replacement right away. */
  private replacing = false;

  constructor(
    readonly socketPath: string,
    /** This extension's version, compared with the broker's. */
    private readonly version: string,
    private readonly brokerScript: string,
    private readonly brokerLogPath: string,
    private readonly onMessage: (message: HookMessage) => void,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Connects, starting a broker if none answers within `spawnDelayMs`. */
  async connect(spawnDelayMs = 0): Promise<void> {
    const spawnAt = Date.now() + spawnDelayMs;
    const deadline = spawnAt + CONNECT_TIMEOUT_MS;
    let started = false;
    let socket = await this.tryConnect();
    while (!socket && Date.now() < deadline) {
      if (!started && Date.now() >= spawnAt) {
        this.startBroker();
        started = true;
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      socket = await this.tryConnect();
    }
    if (!socket) {
      throw new Error(`could not connect to the Spool broker at ${this.socketPath}; see ${this.brokerLogPath}`);
    }
    if (this.disposed) {
      socket.destroy();
      return;
    }
    this.attach(socket);
  }

  /** Asks the broker to exit; the connection drops and reconnect() starts a fresh one. */
  restartBroker(): void {
    this.log.info('restarting broker');
    this.replace();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.pingTimer);
    this.socket?.destroy();
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.send({ type: 'subscribe', version: this.version });
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
    readLines(socket, (line) => {
      try {
        const message = JSON.parse(line);
        if (isBrokerHello(message)) {
          if (compareVersions(message.version, this.version) < 0) {
            this.log.info(`broker is version ${message.version}, older than ${this.version}; replacing it`);
            this.replace();
          }
        } else if (isHookMessage(message)) {
          this.onMessage(message);
        }
      } catch {
        this.log.warn(`bad message from broker: ${line}`);
      }
    });
    socket.on('error', (err) => this.log.warn(`broker connection error: ${err.message}`));
    socket.on('close', () => {
      clearInterval(this.pingTimer);
      if (this.disposed) {
        return;
      }
      this.log.warn('lost connection to the Spool broker; reconnecting');
      this.reconnect();
    });
    this.log.info(`connected to broker at ${this.socketPath}`);
  }

  private replace(): void {
    this.replacing = true;
    this.send({ type: 'shutdown' });
  }

  /** Keeps trying until connected or disposed; the broker may need a moment to (re)start. */
  private reconnect(): void {
    const replacing = this.replacing;
    this.replacing = false;
    setTimeout(
      () => {
        if (this.disposed) {
          return;
        }
        this.connect(replacing ? 0 : SPAWN_GRACE_MS).catch((err) => {
          this.log.error((err as Error).message);
          this.reconnect();
        });
      },
      replacing ? 0 : RECONNECT_DELAY_MS,
    );
  }

  private send(message: WindowMessage): void {
    this.socket?.write(JSON.stringify(message) + '\n');
  }

  private tryConnect(): Promise<net.Socket | undefined> {
    return new Promise((resolve) => {
      const socket = net.connect(this.socketPath);
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        resolve(socket);
      });
      socket.once('error', () => resolve(undefined));
    });
  }

  private startBroker(): void {
    this.log.info('starting broker');
    // The extension host's own executable runs as plain Node with ELECTRON_RUN_AS_NODE, so the
    // broker doesn't depend on a `node` on PATH. Detached so it outlives this window.
    const child = spawn(process.execPath, [this.brokerScript, this.socketPath, this.version, this.brokerLogPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  }
}
