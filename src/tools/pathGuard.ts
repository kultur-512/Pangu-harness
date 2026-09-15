// src/tools/pathGuard.ts
// M1-2.1: security core — every file tool path must resolve strictly inside
// the workspace. Rules (per M1 instruction):
// - path.resolve(root, p) must equal root or start with root + sep
// - Windows: compare lowercased
// - absolute-path escapes, '..' traversal and drive switches all rejected
// - second check AFTER fs.realpathSync (symlink escape defense)

import path from 'path';
import { realpathSync, existsSync } from 'fs';

export type PathGuardResult =
  | { ok: true; abs: string; real: string }
  | { ok: false; reason: string };

function sameRoot(candidate: string, rootAbs: string): boolean {
  if (process.platform === 'win32') {
    const c = candidate.toLowerCase();
    const r = rootAbs.toLowerCase();
    return c === r || c.startsWith(r + path.sep);
  }
  return candidate === rootAbs || candidate.startsWith(rootAbs + path.sep);
}

/**
 * Resolve `p` under `workspaceRoot` and verify containment twice:
 * once on the lexical resolution, once on the realpath (symlinks).
 * `mustExist`: read-style tools require the target to exist; write-style
 * tools may pass false (then realpath is taken on the nearest existing ancestor).
 */
export function resolveUnderWorkspace(
  p: string,
  workspaceRoot: string,
  opts: { mustExist?: boolean } = {}
): PathGuardResult {
  const mustExist = opts.mustExist !== false;

  if (!p || !String(p).trim()) {
    return { ok: false, reason: 'EMPTY_PATH' };
  }

  const rootAbs = path.resolve(workspaceRoot);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(rootAbs, p);

  // Lexical containment (rejects '..' traversal and drive switches).
  if (!sameRoot(abs, rootAbs)) {
    return { ok: false, reason: `PATH_ESCAPED: ${p} resolves outside workspace` };
  }

  // Realpath containment (symlink defense). For not-yet-existing targets,
  // walk up to the nearest existing ancestor and realpath that.
  let real: string;
  try {
    if (existsSync(abs)) {
      real = realpathSync(abs);
    } else if (mustExist) {
      return { ok: false, reason: `NOT_FOUND: ${p}（文件不存在——若不确定文件名，先用 glob 列出目录内容再选择目标文件）` };
    } else {
      let probe = path.dirname(abs);
      while (probe !== path.dirname(probe) && !existsSync(probe)) {
        probe = path.dirname(probe);
      }
      const realProbe = realpathSync(probe);
      real = path.join(realProbe, path.relative(probe, abs));
    }
  } catch (e: any) {
    return { ok: false, reason: `REALPATH_FAILED: ${e?.message || e}` };
  }

  if (!sameRoot(real, rootAbs)) {
    return { ok: false, reason: `PATH_ESCAPED_SYMLINK: ${p} resolves (via symlink) outside workspace` };
  }

  return { ok: true, abs, real };
}
