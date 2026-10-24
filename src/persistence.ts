import * as fs from 'fs';
import * as path from 'path';
import type { SavedSession, SessionPersistence } from './sessions';

/**
 * Saves each session as its own JSON file in the extension's global storage. One file per
 * session means windows only ever write their own sessions, and the files don't depend on the
 * workspace's identity (which changes when a folder is added to a window).
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

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}
