// src/tools/bash.ts
// M1-2.2: real command execution.
// - spawn with shell:true, cwd=workspaceRoot, detached (for tree-kill)
// - tier-driven timeout: quick=30s / standard=60s / high|ex|zorge=120s (cap 600000)
// - timeout kills the whole process tree (taskkill /T /F on Windows, -SIGKILL on POSIX)
// - stdout+stderr merged, 20k internal cap
// - env passthrough + ZORGE_EXEC=1
// - DANGER MARKING ONLY (enforcement belongs to the approval layer, 2.4):
//   rm -rf / del / format / reg add|delete / git push --force / mkfs / shutdown …

import { spawn } from 'child_process';
import type { ToolImpl } from './types.js';

export const BASH_HARD_CAP_MS = 600_000;
const OUTPUT_CAP = 20_000;

export function bashTimeoutForTier(tier: string | undefined): number {
  const t = String(tier || '').toLowerCase();
  const base = t === 'quick' ? 30_000 : t === 'standard' ? 60_000 : 120_000;
  return Math.min(base, BASH_HARD_CAP_MS);
}

const DANGER_PATTERNS: RegExp[] = [
  /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/i, // rm -rf variants
  /\bdel\s+\/[rsq]\b/i,
  /\bformat\s+\w:/i,
  /\breg\s+(add|delete)\b/i,
  /\bgit\s+push\b.*--force/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
];

export function isDangerousCommand(cmd: string): boolean {
  const c = String(cmd || '');
  return DANGER_PATTERNS.some((re) => re.test(c));
}

export interface BashToolOptions {
  timeoutMs?: number;
}

export function createBashTool(opts: BashToolOptions = {}): ToolImpl {
  return async (params, ctx) => {
    const start = Date.now();
    const cmd = params.command ?? params.cmd ?? '';
    if (!String(cmd).trim()) {
      return { ok: false, output: '✗ bash requires `command`', durationMs: Date.now() - start, error: 'INVALID_PARAMS' };
    }

    const timeoutMs = Math.min(Math.max(1, opts.timeoutMs ?? 120_000), BASH_HARD_CAP_MS);

    return new Promise((resolve) => {
      let child: any;
      try {
        child = spawn(String(cmd), {
          shell: true,
          cwd: ctx.workspaceRoot,
          // detached is only needed on POSIX (negative-pid tree kill).
          // On Windows detached detaches the console and grandchildren (exe
          // spawned by the shell) stop inheriting our stdout pipe → empty
          // captures. Windows tree-kill uses taskkill /T which doesn't need it.
          detached: process.platform !== 'win32',
          env: { ...process.env, ZORGE_EXEC: '1' },
          windowsHide: true,
        });
      } catch (e: any) {
        resolve({ ok: false, output: `✗ spawn failed: ${e?.message || e}`, durationMs: Date.now() - start, error: 'IO' });
        return;
      }

      let out = '';
      let truncated = false;
      let settled = false;

      const append = (chunk: Buffer | string) => {
        if (truncated) return;
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        if (out.length + s.length > OUTPUT_CAP) {
          out += s.slice(0, Math.max(0, OUTPUT_CAP - out.length));
          truncated = true;
        } else {
          out += s;
        }
      };

      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const finish = (exitCode: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ok = error ? false : exitCode === 0;
        const tail = error
          ? ``
          : `\nEXIT_CODE:${exitCode ?? 'null'}`;
        resolve({
          ok,
          output: (out + tail) || `(no output)${tail}`,
          durationMs: Date.now() - start,
          exitCode: exitCode ?? undefined,
          error,
          truncated,
          meta: { danger: isDangerousCommand(String(cmd)) },
        });
      };

      const timer = setTimeout(() => {
        if (settled) return;
        // Kill the whole tree — shell:true spawns a shell wrapper, so killing
        // only the direct child would leave grandchildren alive.
        try {
          if (process.platform === 'win32') {
            if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          } else if (child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        } catch {}
        finish(null, 'TIMEOUT');
        // Give the OS a beat, then final-claim the process so no zombie keeps the loop alive
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 100);
      }, timeoutMs);

      child.on('error', (e: any) => finish(null, 'SPAWN_ERROR: ' + (e?.message || e)));

      child.on('close', (code: number | null) => finish(code));
    });
  };
}
