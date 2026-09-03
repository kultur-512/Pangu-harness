// src/tools/readFile.ts
// M1-2.1: read_file with Claude-Code-Read semantics:
// cat -n line numbers, offset/limit paging (default 500 lines), binary
// detection with truncate+notice, nextOffset continuation hint.

import { readFileSync, statSync } from 'fs';
import { resolveUnderWorkspace } from './pathGuard.js';
import { redactSecrets } from '../utils/redact.js';
import type { ToolImpl } from './types.js';

const DEFAULT_LIMIT = 500;
const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB hard read cap

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) suspicious++; // 0x1F (31) IS a control char
  }
  return suspicious / n > 0.3;
}

export const readFile: ToolImpl = async (params, ctx) => {
  const start = Date.now();
  const rel = params.file_path ?? params.path ?? '';
  const g = resolveUnderWorkspace(rel, ctx.workspaceRoot, { mustExist: true });
  if (!g.ok) {
    return { ok: false, output: `✗ ${g.reason}`, durationMs: Date.now() - start, error: g.reason.startsWith('PATH_ESCAPED') ? 'PATH_ESCAPED' : 'INVALID_PARAMS' };
  }

  try {
    const st = statSync(g.real);
    if (!st.isFile()) {
      return { ok: false, output: `✗ not a regular file: ${rel}`, durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
    }
    if (st.size > MAX_READ_BYTES) {
      return {
        ok: false,
        output: `✗ file too large to read (${st.size} bytes, cap ${MAX_READ_BYTES})`,
        durationMs: Date.now() - start,
        error: 'FILE_TOO_LARGE',
      };
    }

    const buf = readFileSync(g.real);
    if (looksBinary(buf)) {
      return {
        ok: true,
        output: `[binary file — content withheld] ${rel} (${st.size} bytes)`,
        durationMs: Date.now() - start,
        truncated: true,
        error: 'BINARY_FILE',
        meta: { lines: 0 },
      };
    }

    // Normalize CRLF for paging; content itself is displayed as-is per line.
    const all = buf.toString('utf-8').replace(/\r\n/g, '\n').split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();

    const total = all.length;
    const offset = Math.max(1, Math.floor(Number(params.offset) || 1));
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(params.limit) || DEFAULT_LIMIT)));
    const end = Math.min(total, offset - 1 + limit);
    const slice = all.slice(offset - 1, end);

    const width = String(end).length;
    // S3: redact sk- prefixed keys / Bearer tokens / apiKey-secret pairs from
    // file content before it reaches the model (and the terminal).
    const lines = slice.map((l, i) => `${String(offset + i).padStart(width, ' ')}\t${redactSecrets(l)}`);

    const truncated = end < total;
    const nextOffset = truncated ? end + 1 : undefined;

    const out: string[] = [`READ_SUCCESS: ${rel} (${total} lines total)`];
    out.push(...lines);
    if (truncated) {
      out.push(`…[truncated: showing ${slice.length} of ${total} lines]`, `续读位置：offset=${nextOffset}`);
    }
    if (total === 0) out.push('(empty file)');

    return {
      ok: true,
      output: out.join('\n'),
      durationMs: Date.now() - start,
      truncated,
      meta: { lines: slice.length, nextOffset, abs: g.real },
    };
  } catch (e: any) {
    return {
      ok: false,
      output: `✗ read failed: ${e?.message || e}`,
      durationMs: Date.now() - start,
      error: 'IO',
    };
  }
};
