import * as fs from 'fs';
import * as path from 'path';
import type { SavedSession, SessionPersistence } from './sessions';

/** Writes come in bursts (temp file, then rename; several sessions at once). */
const WATCH_DEBOUNCE_MS = 100;

/**
 * Saves each session as its own JSON file in the extension's global storage. One file per
 * session means windows only ever write their own sessions, and the files don't depend on the
 * workspace's identity (which changes when a folder is added to a window). Other windows
 * watch the directory to mirror sessions they don't run.
 */
export class SessionFiles implements SessionPersistence {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  loadAll(): SavedSession[] {
    const sessions: SavedSession[] = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        sessions.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')));
      } catch {
        // A file mid-write by another window, or corrupt; skip it.
      }
    }
    return sessions;
  }

  save(session: SavedSession): void {
    // Write then rename, so another window never reads a half-written file.
    const file = this.fileFor(session.id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(session));
    fs.renameSync(`${file}.tmp`, file);
  }

  delete(id: string): void {
    fs.rmSync(this.fileFor(id), { force: true });
  }

  /** Calls `onChange` (debounced) when any session file changes, including this window's own writes. */
  watch(onChange: () => void): { dispose(): void } {
    let timer: NodeJS.Timeout | undefined;
    const watcher = fs.watch(this.dir, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
    });
    return {
      dispose: () => {
        clearTimeout(timer);
        watcher.close();
      },
    };
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}
