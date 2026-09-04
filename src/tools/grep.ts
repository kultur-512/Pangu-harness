// src/tools/grep.ts
// grep — 工作区递归行级正则搜索。
// 250-match cap; output `file:line:text`; include glob filter; friendly
// error on invalid regex.

import { readFileSync } from 'fs';
import path from 'path';
import { resolveUnderWorkspace } from './pathGuard.js';
import { walkFiles, globToRegExp } from './walk.js';
import type { ToolImpl } from './types.js';

const MATCH_CAP = 250;
const SCAN_CAP = 2000;
const LINE_DISPLAY_CAP = 200;

export const grep: ToolImpl = async (params, ctx) => {
  const start = Date.now();
  const pattern = params.pattern ?? '';
  if (!pattern.trim()) {
    return { ok: false, output: '✗ grep requires `pattern`', durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e: any) {
    return {
      ok: false,
      output: `✗ invalid regex: ${e?.message || e}`,
      durationMs: Date.now() - start,
      error: 'INVALID_REGEX',
    };
  }

  const relBase = params.path || '.';
  const g = resolveUnderWorkspace(relBase, ctx.workspaceRoot, { mustExist: true });
  if (!g.ok) {
    return { ok: false, output: `✗ ${g.reason}`, durationMs: Date.now() - start, error: g.reason.startsWith('PATH_ESCAPED') ? 'PATH_ESCAPED' : 'INVALID_PARAMS' };
  }

  const includeRe = params.include ? globToRegExp(params.include) : null;

  try {
    const { files, truncated: scanTruncated } = walkFiles(g.real, { maxFiles: SCAN_CAP });

    const out: string[] = [];
    let matches = 0;
    let truncated = false;

    for (const f of files) {
      if (matches >= MATCH_CAP) { truncated = true; break; }
      if (includeRe && !includeRe.test(f.rel) && !includeRe.test(path.basename(f.rel))) continue;

      let content: string;
      try {
        const buf = readFileSync(f.abs);
        // Skip likely-binary files quickly
        if (buf.includes(0)) continue;
        content = buf.toString('utf-8');
      } catch {
        continue;
      }

      const lines = content.replace(/\r\n/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          if (matches >= MATCH_CAP) { truncated = true; break; }
          const text = lines[i].length > LINE_DISPLAY_CAP ? lines[i].slice(0, LINE_DISPLAY_CAP) + '…' : lines[i];
          out.push(`${f.rel}:${i + 1}:${text}`);
          matches++;
        }
      }
      if (truncated) break;
    }

    const head = `GREP_SUCCESS: ${matches} match(es)${truncated ? ' (truncated)' : ''}`;
    return {
      ok: true,
      output: [head, ...out].join('\n'),
      durationMs: Date.now() - start,
      truncated,
      error: truncated ? 'OUTPUT_TRUNCATED' : undefined,
      meta: { lines: matches },
    };
  } catch (e: any) {
    return { ok: false, output: `✗ grep failed: ${e?.message || e}`, durationMs: Date.now() - start, error: 'IO' };
  }
};
