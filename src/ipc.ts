import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** A hook event forwarded by the hook script, tagged with the Spool session it came from. */
export interface HookMessage {
  spoolId: string;
  payload: Record<string, unknown>;
}

/**
 * Listens on a local Unix socket for hook messages. Each connection carries one or more
 * newline-delimited JSON messages.
 */
export class IpcServer {
  readonly socketPath = path.join(os.tmpdir(), `spool-${process.pid}.sock`);
  private server?: net.Server;

  constructor(
    private readonly onMessage: (message: HookMessage) => void,
    private readonly onError: (error: Error) => void = () => {},
  ) {}

  start(): Promise<void> {
    // A stale socket file from a crashed run would make listen() fail with EADDRINUSE.
    fs.rmSync(this.socketPath, { force: true });

    this.server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          this.handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });
      socket.on('end', () => this.handleLine(buffer));
      socket.on('error', this.onError);
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        this.server!.on('error', this.onError);
        resolve();
      });
    });
  }

  dispose(): void {
    this.server?.close();
    fs.rmSync(this.socketPath, { force: true });
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    try {
      const message = JSON.parse(line);
      if (typeof message?.spoolId !== 'string' || typeof message?.payload !== 'object') {
        throw new Error('expected { spoolId: string, payload: object }');
      }
      this.onMessage(message as HookMessage);
    } catch (err) {
      this.onError(new Error(`Bad IPC message: ${(err as Error).message}: ${line}`));
    }
  }
}
