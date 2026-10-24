import * as fs from 'fs';
import * as path from 'path';

/** A folder in the sidebar: the sessions started in or under one directory. */
export interface FolderGroup {
  dir: string;
  /** True if `dir` is a git repo (or worktree) root. */
  isRepo: boolean;
}

/**
 * The group a session started in `dir` belongs to: the nearest enclosing git repo root, so
 * sessions started in a repo's subfolders stay together, or `dir` itself when it isn't inside
 * a repo (e.g. a parent folder holding several repos gets its own group).
 */
export function groupFor(dir: string, exists: (p: string) => boolean = fs.existsSync): FolderGroup {
  // `.git` is a directory in a normal repo and a file in a worktree; either marks the root.
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (exists(path.join(current, '.git'))) {
      return { dir: current, isRepo: true };
    }
    if (path.dirname(current) === current) {
      return { dir: path.resolve(dir), isRepo: false };
    }
  }
}
