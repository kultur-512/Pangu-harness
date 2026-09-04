// src/tools/writeFile.ts
// M1-2.3: write_file with Claude-Code-Write semantics + Panshalach RBW iron law:
// ORDER IS FIXED BY THE M1 INSTRUCTION — diff FIRST, disk write SECOND.
//
// - file_path + content (cap 1MB)
// - RBW: target exists and was NOT read this run → RBW_VIOLATION
//   (+ failureMemory.record('READ_BEFORE_WRITE_VIOLATION', …))
// - meta.diff always computed before any disk mutation
// - atomic: write <file>.tmp-<rand> then rename; tmp cleaned on failure
// - parent dirs auto-created; pathGuard mandatory

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { resolveUnderWorkspace } from './pathGuard.js';
import { computeLineDiff } from './diff.js';
import type { ToolImpl } from './types.js';

const MAX_WRITE_BYTES = 1024 * 1024; // 1MB

export interface WriteToolDeps {
  /** Files already read this run (adapter-maintained). Missing → strict empty set. */
  readFiles?: Set<string>;
  failureMemory?: { record(category: any, description: string, weight?: number): void } | null;
}

export function createWriteFileTool(deps: WriteToolDeps = {}): ToolImpl {
  const readFiles = deps.readFiles ?? new Set<string>();
  const failureMemory = deps.failureMemory ?? null;

  return async (params, ctx) => {
    const start = Date.now();
    const rel = params.file_path ?? params.path ?? '';
    const content = params.content ?? '';

    if (!String(rel).trim()) {
      return { ok: false, output: '✗ write_file requires `file_path`', durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
    }
    if (typeof content !== 'string') {
      return { ok: false, output: '✗ write_file requires string `content`', durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
    }

    const byteLen = Buffer.byteLength(content, 'utf-8');
    if (byteLen > MAX_WRITE_BYTES) {
      return {
        ok: false,
        output: `✗ content too large (${byteLen} bytes, cap ${MAX_WRITE_BYTES})`,
        durationMs: Date.now() - start,
        error: 'FILE_TOO_LARGE',
      };
    }

    const g = resolveUnderWorkspace(rel, ctx.workspaceRoot, { mustExist: false });
    if (!g.ok) {
      return { ok: false, output: `✗ ${g.reason}`, durationMs: Date.now() - start, error: g.reason.startsWith('PATH_ESCAPED') ? 'PATH_ESCAPED' : 'INVALID_PARAMS' };
    }

    // ---- diff FIRST (before any disk mutation), per M1 instruction ----
    let diff;
    try {
      const oldText = fs.existsSync(g.real) ? fs.readFileSync(g.real, 'utf-8') : '';
      diff = computeLineDiff(oldText, content);
    } catch (e: any) {
      return { ok: false, output: `✗ diff failed: ${e?.message || e}`, durationMs: Date.now() - start, error: 'IO' };
    }

    // ---- RBW iron law (after diff, before write) ----
    const existed = fs.existsSync(g.real);
    if (existed && !readFiles.has(path.resolve(g.real))) {
      try {
        failureMemory?.record?.('READ_BEFORE_WRITE_VIOLATION', `write_file 越过未读文件: ${rel}`);
      } catch {}
      return {
        ok: false,
        output: `✗ RBW_VIOLATION: 写入前必须先读取目标文件（Read-Before-Write）: ${rel}`,
        durationMs: Date.now() - start,
        error: 'RBW_VIOLATION',
        meta: { diff },
      };
    }

    // ---- atomic write: tmp → rename ----
    const dir = path.dirname(g.real);
    const tmp = path.join(dir, `.${path.basename(g.real)}.tmp-${randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, content, 'utf-8');
      try {
        fs.renameSync(tmp, g.real);
      } catch (renameErr: any) {
        try { fs.unlinkSync(tmp); } catch {}
        return {
          ok: false,
          output: `✗ write failed (rename): ${renameErr?.message || renameErr}`,
          durationMs: Date.now() - start,
          error: 'IO',
          meta: { diff },
        };
      }
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch {}
      return {
        ok: false,
        output: `✗ write failed: ${e?.message || e}`,
        durationMs: Date.now() - start,
        error: 'IO',
        meta: { diff },
      };
    }

    const addCount = diff.filter((d) => d.type === 'add').length;
    const delCount = diff.filter((d) => d.type === 'del').length;
    return {
      ok: true,
      output: `WRITE_SUCCESS: ${rel} (${byteLen} bytes, +${addCount}/−${delCount})`,
      durationMs: Date.now() - start,
      meta: { diff, lines: content.split('\n').length },
    };
  };
}
