// src/tools/walk.ts (internal helper shared by glob/grep)
// Directory walk mirroring RepoExplorer's ignoreDirs set (same list, mirrored
// per M1 instruction since RepoExplorer doesn't export it).
//
// C4（ROADMAP-NEXT §3.2）：不跟随符号链接。受信工作区假设下，链接通常无害；
// 但 glob/grep 的遍历必须防御两类风险——(1) 指向祖先目录的链接造成无限循环，
// (2) 链接逃逸出工作区边界（pathGuard 只校验了基路径，管不住遍历中的链接）。
// 因此 dirent.isSymbolicLink() 一律跳过（junction/symlink 都算）。

import { readdirSync } from 'fs';
import path from 'path';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.venv', 'venv', 'target', 'out',
  // M2-3 scratch（工具结果落盘）不入搜索面——否则模型 glob/grep 会搜到
  // 自己之前的落盘产物造成上下文污染
  '.panshalach',
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
    let entries: import('fs').Dirent[];
    try {
      // withFileTypes: dirent 类型不跟随链接，避免逐项 statSync（lstat 语义）
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip silently
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      // C4: symlink 防御 —— 不跟随符号链接/联接（防循环 + 防逃逸出工作区）
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name) || ent.name.startsWith('.git')) continue;
        visit(abs, rel, depth + 1);
      } else if (ent.isFile()) {
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
