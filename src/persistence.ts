import * as fs from 'fs';
import * as path from 'path';
/** Writes come in bursts (temp file, then rename; several files at once). */
const WATCH_DEBOUNCE_MS = 100;

/**
 * Saves each item (a session, a comment) as its own JSON file in a directory in the
 * extension's global storage. One file per item means windows only write what they changed,
 * and the files don't depend on the workspace's identity (which changes when a folder is added
 * to a window). Other windows watch the directory to mirror items they don't own.
 */
export class JsonFiles<T extends { id: string }> {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  loadAll(): T[] {
    const items: T[] = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        items.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')));
      } catch {
        // A file mid-write by another window, or corrupt; skip it.
      }
    }
    return items;
  }

  save(item: T): void {
    // Write then rename, so another window never reads a half-written file.
    const file = this.fileFor(item.id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(item));
    fs.renameSync(`${file}.tmp`, file);
  }

  delete(id: string): void {
    fs.rmSync(this.fileFor(id), { force: true });
  }

  /** Calls `onChange` (debounced) when any file changes, including this window's own writes. */
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
