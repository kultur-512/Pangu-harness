// src/tools/glob.ts
// glob — 自实现 **、*、? 匹配的工作区遍历。
// ignoreDirs respected; 200 result cap; 2000-file scan hard stop.

import path from 'path';
import { resolveUnderWorkspace } from './pathGuard.js';
import { walkFiles, globToRegExp } from './walk.js';
import type { ToolImpl } from './types.js';

const RESULT_CAP = 200;
const SCAN_CAP = 2000;

export const glob: ToolImpl = async (params, ctx) => {
  const start = Date.now();
  const pattern = params.pattern ?? '';
  if (!pattern.trim()) {
    return { ok: false, output: '✗ glob requires `pattern`', durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
  }

  const relBase = params.path || '.';
  const g = resolveUnderWorkspace(relBase, ctx.workspaceRoot, { mustExist: true });
  if (!g.ok) {
    return { ok: false, output: `✗ ${g.reason}`, durationMs: Date.now() - start, error: g.reason.startsWith('PATH_ESCAPED') ? 'PATH_ESCAPED' : 'INVALID_PARAMS' };
  }

  try {
    const re = globToRegExp(pattern);
    const { files, truncated: scanTruncated } = walkFiles(g.real, { maxFiles: SCAN_CAP });

    const matches: string[] = [];
    let resultTruncated = false;
    for (const f of files) {
      // Match against the relative path (posix separators) OR the basename.
      const base = path.basename(f.rel);
      if (re.test(f.rel) || re.test(base)) {
        if (matches.length >= RESULT_CAP) { resultTruncated = true; break; }
        matches.push(f.rel);
      }
    }

    const truncated = resultTruncated || scanTruncated;
    const out: string[] = [`GLOB_SUCCESS: ${matches.length} file(s)${truncated ? ' (truncated)' : ''}`];
    out.push(...matches);

    return {
      ok: true,
      output: out.join('\n'),
      durationMs: Date.now() - start,
      truncated,
      error: truncated ? 'OUTPUT_TRUNCATED' : undefined,
      meta: { lines: matches.length },
    };
  } catch (e: any) {
    return { ok: false, output: `✗ glob failed: ${e?.message || e}`, durationMs: Date.now() - start, error: 'IO' };
  }
};
