// src/tools/approval.ts
// M1-2.4: approval layer — three modes, session allowlist, interactive bridges.
//
// Semantics (per M1 instruction):
//   readonly : all writes and non-allowlisted bash → DENIED (no confirm card)
//   default  : writes always confirm; bash outside the readonly allowlist
//              confirms; allowlisted bash runs free
//   full     : everything runs; dangerous commands stay flagged (danger=true)
//   'a'      : allow-always for this session (per-tool), /approvals clear resets

import * as readline from 'readline';
import { isDangerousCommand } from './bash.js';
import type { DiffHunk } from './types.js';

export type ApprovalMode = 'readonly' | 'default' | 'full';
export type ApprovalDecision = 'y' | 'n' | 'a';

export const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export interface ApprovalRequest {
  tool: string;
  /** Human-readable description (bash: the command itself; write: path + summary). */
  description: string;
  danger: boolean;
  diff?: DiffHunk[];
  resolve: (decision: ApprovalDecision) => void;
}

export interface ClassifyContext {
  mode: ApprovalMode;
  sessionAllowlist: Set<string>;
  isReadonlyAllowed(cmd: string): boolean;
}

export interface ClassifyResult {
  needsApproval: boolean;
  denied: boolean;
  danger: boolean;
  reason?: string;
}

export const READONLY_HINT = '当前档位为只读；使用 /approvals default 或切换档位放行';

/**
 * Decide what happens to a tool call under the current approval mode.
 * Pure function — the adapter performs the actual bridge interaction.
 */
export function classify(tool: string, params: Record<string, string>, ctx: ClassifyContext): ClassifyResult {
  const name = String(tool || '').trim().toLowerCase();
  const isWrite = WRITE_TOOLS.has(name);
  const isBash = name === 'bash';
  const cmd = params.command ?? params.cmd ?? '';
  const danger = isBash ? isDangerousCommand(cmd) : false;

  // Session 'allow-always' wins (never for readonly mode itself — that mode
  // exists precisely to be a hard floor).
  if (ctx.mode !== 'readonly' && ctx.sessionAllowlist.has(name)) {
    return { needsApproval: false, denied: false, danger };
  }

  if (ctx.mode === 'readonly') {
    if (isWrite) {
      return { needsApproval: false, denied: true, danger, reason: `写类工具在只读模式被禁用。${READONLY_HINT}` };
    }
    if (isBash && !ctx.isReadonlyAllowed(cmd)) {
      return { needsApproval: false, denied: true, danger, reason: `命令不在只读白名单。${READONLY_HINT}` };
    }
    return { needsApproval: false, denied: false, danger };
  }

  if (ctx.mode === 'default') {
    if (isWrite) {
      return { needsApproval: true, denied: false, danger };
    }
    if (isBash && !ctx.isReadonlyAllowed(cmd)) {
      return { needsApproval: true, denied: false, danger };
    }
    return { needsApproval: false, denied: false, danger };
  }

  // full: everything runs; danger stays flagged (red badge, no block).
  return { needsApproval: false, denied: false, danger };
}

/** Build a human-readable description for the request card / question. */
export function describeRequest(tool: string, params: Record<string, string>): string {
  const name = String(tool || '').trim().toLowerCase();
  if (name === 'bash') {
    return params.command ?? params.cmd ?? '(empty command)';
  }
  if (WRITE_TOOLS.has(name)) {
    const p = params.file_path ?? params.path ?? '(no path)';
    const size = name === 'write_file' ? `${Buffer.byteLength(params.content ?? '', 'utf-8')} bytes` : `${(params.new_string ?? '').length} chars`;
    return `${p} (${size})`;
  }
  return JSON.stringify(params).slice(0, 120);
}

/** Headless bridge: always-yes or always-no (drivers / tests / acceptance runs). */
export function createHeadlessApprovalBridge(mode: 'y-all' | 'n-all') {
  return async (_req: ApprovalRequest): Promise<ApprovalDecision> => (mode === 'y-all' ? 'y' : 'n');
}

/**
 * Line-mode bridge: readline question on stdin/stdout.
 * - y / yes → decision; a → allow-always
 * - n / anything else / Esc / 60s silence → n (safe default)
 * Takes the light request shape (no resolve callback needed here).
 */
export function createCliApprovalBridge(opts: { timeoutMs?: number } = {}): (req: { tool: string; description: string; danger?: boolean }) => Promise<ApprovalDecision> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return (req) => new Promise<ApprovalDecision>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (d: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl.close(); } catch {}
      resolve(d);
    };
    const timer = setTimeout(() => done('n'), timeoutMs); // silence = safe default
    const dangerTag = req.danger ? ' [DANGER]' : '';
    rl.question(`\n⚠ 审批 ${req.tool}${dangerTag}: ${req.description}\n  (y=允许 / a=本会话总是允许 / n=拒绝，回车=n，${Math.round(timeoutMs / 1000)}s 超时=n) > `, (answer) => {
      const a = String(answer || '').trim().toLowerCase();
      if (a === 'y' || a === 'yes') done('y');
      else if (a === 'a') done('a');
      else done('n');
    });
  });
}
