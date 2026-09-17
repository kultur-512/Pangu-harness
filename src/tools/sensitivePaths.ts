// src/tools/sensitivePaths.ts
// M2-6: sensitive-path write protection (hermes 2.5a, tightened for the
// competition): write_file/edit_file and /undo restores must never touch
// these paths at ANY approval tier — the approval bridge cannot override.
//
// Matching happens on the workspace-relative path (the input is resolved
// against the workspace first), so `./.ssh/x`, absolute in-workspace paths
// and bare relative forms all collapse to the same rel path. Matching is
// case-sensitive; on win32 comparisons are lowercased (that FS cannot
// distinguish case).

import path from 'path';

/** Directory names — the directory itself and every descendant are protected. */
const SENSITIVE_DIRS = ['.ssh', '.aws', '.kube', '.git'];
/** Exact file names — protected at any depth. */
const SENSITIVE_FILES = ['.git-credentials', '.netrc', '.panshalach.json'];
/** Trailing-`*` globs matched against each path segment (`.env`, `.env.local`, `id_rsa`, `id_rsa.pub`, …). */
const SENSITIVE_SEGMENT_GLOBS = ['id_rsa*', '.env*'];

/** win32 FS is case-insensitive → compare lowercased; posix stays case-sensitive. */
function fold(s: string): string {
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function segmentGlobMatches(segment: string, pattern: string): boolean {
  return pattern.endsWith('*') ? segment.startsWith(pattern.slice(0, -1)) : segment === pattern;
}

/** Posix slashes, no leading `./`, no empty segments (`.ssh/` → `.ssh`). */
export function normalizeRelPath(rel: string): string {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

/** 段级豁免（2026-09-16）：.env.example/.env.sample/.env.template 是模板文件
 *  （占位值，不含真密钥），不落敏感清单——真机 M3 实证被 .env* 通配误拦。 */
const SEGMENT_EXEMPT = /^\.env\.(example|sample|template)$/i;

/** True when the workspace-relative path hits the sensitive manifest. */
export function isSensitiveRelPath(rel: string): boolean {
  const norm = normalizeRelPath(rel);
  if (!norm) return false;
  return norm.split('/').some((raw) => {
    const seg = fold(raw);
    if (SEGMENT_EXEMPT.test(seg)) return false;
    return (
      SENSITIVE_DIRS.some((d) => fold(d) === seg) ||
      SENSITIVE_FILES.some((f) => fold(f) === seg) ||
      SENSITIVE_SEGMENT_GLOBS.some((g) => segmentGlobMatches(seg, fold(g)))
    );
  });
}

/**
 * Resolve any input (relative, `./`-prefixed, absolute) against the workspace
 * and test it. Paths escaping the workspace are NOT sensitive here — pathGuard
 * rejects them downstream with its own reason.
 */
export function isSensitiveWorkspacePath(workspaceRoot: string, p: string): boolean {
  if (!p) return false;
  const rootAbs = path.resolve(workspaceRoot);
  const rel = path.relative(rootAbs, path.resolve(rootAbs, String(p)));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return isSensitiveRelPath(rel);
}

/** Canonical deny message for the write gate (undo composes its own tail). */
export function sensitiveDenyMessage(p: string): string {
  return `✗ SENSITIVE_PATH: ${p} 位于敏感路径清单，任何档位禁止写入`;
}
