import { spawn } from 'child_process';
import * as net from 'net';
import * as vscode from 'vscode';
import { HookMessage, PING_INTERVAL_MS, WindowMessage, isHookMessage, readLines } from './ipc';

const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_MS = 100;
const RECONNECT_DELAY_MS = 500;

/**
 * This window's connection to the broker. Starts the broker if none is running, subscribes to
 * hook messages, pings so the broker knows a window still needs it, and reconnects (starting a
 * new broker if needed) whenever the connection drops.
 */
export class BrokerClient implements vscode.Disposable {
  private socket?: net.Socket;
  private pingTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    readonly socketPath: string,
    private readonly brokerScript: string,
    private readonly brokerLogPath: string,
    private readonly onMessage: (message: HookMessage) => void,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async connect(): Promise<void> {
    let socket = await this.tryConnect();
    if (!socket) {
      this.startBroker();
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (!socket && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
        socket = await this.tryConnect();
      }
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

  dispose(): void {
    this.disposed = true;
    clearInterval(this.pingTimer);
    this.socket?.destroy();
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.send({ type: 'subscribe' });
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
    readLines(socket, (line) => {
      try {
        const message = JSON.parse(line);
        if (isHookMessage(message)) {
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

  /** Keeps trying until connected or disposed; the broker may need a moment to (re)start. */
  private reconnect(): void {
    setTimeout(() => {
      if (this.disposed) {
        return;
      }
      this.connect().catch((err) => {
        this.log.error((err as Error).message);
        this.reconnect();
      });
    }, RECONNECT_DELAY_MS);
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
    const child = spawn(process.execPath, [this.brokerScript, this.socketPath, this.brokerLogPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  }
}
