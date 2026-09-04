// src/tools/editFile.ts
// edit_file：Claude-Code-Edit 语义 + RBW 纪律规则：
// - file_path + old_string + new_string (+ replace_all?)
// - uniqueness: without replace_all, old_string must appear EXACTLY once
//   (error message mirrors CC: 'old_string must appear exactly once (found N)')
// - diff computed BEFORE any disk mutation (M1 ordering rule)
// - atomic write identical to writeFile (tmp → rename, tmp cleaned on failure)

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { resolveUnderWorkspace } from './pathGuard.js';
import { computeLineDiff } from './diff.js';
import type { ToolImpl } from './types.js';

const MAX_EDIT_BYTES = 1024 * 1024;

export interface EditToolDeps {
  readFiles?: Set<string>;
  failureMemory?: { record(category: any, description: string, weight?: number): void } | null;
}

export function createEditFileTool(deps: EditToolDeps = {}): ToolImpl {
  const readFiles = deps.readFiles ?? new Set<string>();
  const failureMemory = deps.failureMemory ?? null;

  return async (params, ctx) => {
    const start = Date.now();
    const rel = params.file_path ?? params.path ?? '';
    const oldString = params.old_string ?? '';
    const newString = params.new_string ?? '';
    const replaceAll = String(params.replace_all || '') === 'true' || params.replace_all === '1';

    if (!String(rel).trim() || oldString === '') {
      return { ok: false, output: '✗ edit_file requires `file_path` and non-empty `old_string`', durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
    }
    if (oldString === newString) {
      return { ok: false, output: '✗ old_string and new_string must be different', durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
    }

    const g = resolveUnderWorkspace(rel, ctx.workspaceRoot, { mustExist: true });
    if (!g.ok) {
      return { ok: false, output: `✗ ${g.reason}`, durationMs: Date.now() - start, error: g.reason.startsWith('PATH_ESCAPED') ? 'PATH_ESCAPED' : 'INVALID_PARAMS' };
    }

    let current: string;
    try {
      const st = fs.statSync(g.real);
      if (!st.isFile()) return { ok: false, output: `✗ not a regular file: ${rel}`, durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
      if (st.size > MAX_EDIT_BYTES) {
        return { ok: false, output: `✗ file too large to edit (${st.size} bytes)`, durationMs: Date.now() - start, error: 'FILE_TOO_LARGE' };
      }
      current = fs.readFileSync(g.real, 'utf-8');
    } catch (e: any) {
      return { ok: false, output: `✗ read failed: ${e?.message || e}`, durationMs: Date.now() - start, error: 'IO' };
    }

    // ---- replacement (in memory) ----
    let updated: string;
    let occurrences: number;
    if (replaceAll) {
      occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) {
        return {
          ok: false,
          output: `✗ old_string not found in ${rel}. It must appear at least once (found 0)`,
          durationMs: Date.now() - start,
          error: 'INVALID_PARAMS',
        };
      }
      updated = current.split(oldString).join(newString);
    } else {
      occurrences = current.split(oldString).length - 1;
      if (occurrences !== 1) {
        return {
          ok: false,
          output: `✗ old_string must appear exactly once (found ${occurrences}) in ${rel}`,
          durationMs: Date.now() - start,
          error: 'INVALID_PARAMS',
        };
      }
      updated = current.replace(oldString, newString);
    }

    // ---- diff FIRST (M1 ordering rule) ----
    const diff = computeLineDiff(current, updated);

    // ---- RBW iron law ----
    if (!readFiles.has(path.resolve(g.real))) {
      try {
        failureMemory?.record?.('READ_BEFORE_WRITE_VIOLATION', `edit_file 越过未读文件: ${rel}`);
      } catch {}
      return {
        ok: false,
        output: `✗ RBW_VIOLATION: 写入前必须先读取目标文件（Read-Before-Write）: ${rel}`,
        durationMs: Date.now() - start,
        error: 'RBW_VIOLATION',
        meta: { diff },
      };
    }

    // ---- atomic write ----
    const dir = path.dirname(g.real);
    const tmp = path.join(dir, `.${path.basename(g.real)}.tmp-${randomBytes(4).toString('hex')}`);
    try {
      fs.writeFileSync(tmp, updated, 'utf-8');
      try {
        fs.renameSync(tmp, g.real);
      } catch (renameErr: any) {
        try { fs.unlinkSync(tmp); } catch {}
        return {
          ok: false,
          output: `✗ edit failed (rename): ${renameErr?.message || renameErr}`,
          durationMs: Date.now() - start,
          error: 'IO',
          meta: { diff },
        };
      }
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch {}
      return {
        ok: false,
        output: `✗ edit failed: ${e?.message || e}`,
        durationMs: Date.now() - start,
        error: 'IO',
        meta: { diff },
      };
    }

    const addCount = diff.filter((d) => d.type === 'add').length;
    const delCount = diff.filter((d) => d.type === 'del').length;
    return {
      ok: true,
      output: `EDIT_SUCCESS: ${rel} (${occurrences} replacement${occurrences > 1 ? 's' : ''}, +${addCount}/−${delCount})`,
      durationMs: Date.now() - start,
      meta: { diff },
    };
  };
}
