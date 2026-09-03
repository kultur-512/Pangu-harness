// src/tools/walk.ts (internal helper shared by glob/grep)
// Directory walk mirroring RepoExplorer's ignoreDirs set (same list, mirrored
// per M1 instruction since RepoExplorer doesn't export it).

import { readdirSync, statSync } from 'fs';
import path from 'path';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.venv', 'venv', 'target', 'out',
]);

export interface WalkEntry {
  abs: string;
  rel: string; // posix-style relative path
}

export function walkFiles(
  rootAbs: string,
  opts: { maxFiles?: number; maxDepth?: number } = {}
): { files: WalkEntry[]; truncated: boolean } {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxDepth = opts.maxDepth ?? 12;
  const files: WalkEntry[] = [];
  let truncated = false;

  const visit = (dir: string, relBase: string, depth: number): void => {
    if (files.length >= maxFiles || depth > maxDepth) {
      if (files.length >= maxFiles) truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir — skip silently
    }
    for (const name of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const abs = path.join(dir, name);
      const rel = relBase ? relBase + '/' + name : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(name) || name.startsWith('.git')) continue;
        visit(abs, rel, depth + 1);
      } else if (st.isFile()) {
        files.push({ abs, rel });
      }
    }
  };

  visit(rootAbs, '', 0);
  return { files, truncated };
}

/** Simple glob → RegExp. Supports **, *, ?, and literal dots. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // '**' — any path segment(s), eats surrounding slashes
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}
