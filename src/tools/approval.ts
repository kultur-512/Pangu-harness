// src/tools/approval.ts
// 审批层 — 三种模式、会话允许清单、交互桥。
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

// ---- P0-1.4 / P0-3：模块级审批活动钩子 ----
// line 模式 REPL（sseInteractive）通过这些钩子实现：
// - process SIGINT 兜底 → 立即拒绝当前挂起的审批（不再卡满 60s）
// - gerund 重绘暂停 / 恢复（审批提示行不被 spinner 覆盖）
// - 主 readline 的 stdin 所有权交接（审批 question 独占输入）
type ApprovalCancelFn = (reason?: string) => void;
let activeApprovalCancel: ApprovalCancelFn | null = null;
let approvalActivityListener: ((active: boolean) => void) | null = null;

/** 当前是否有审批 question 挂起（line 模式 gerund 暂停的依据）。 */
export function isApprovalActive(): boolean {
  return activeApprovalCancel !== null;
}

/** 立即拒绝当前挂起的审批（SIGINT 兜底入口）。返回是否存在挂起中的审批。 */
export function cancelActiveApproval(reason = 'sigint'): boolean {
  const fn = activeApprovalCancel;
  if (!fn) return false;
  try { fn(reason); } catch {}
  return true;
}

/** 注册审批挂起/结束监听（active=true 进入 question，false 离开）。 */
export function setApprovalActivityListener(fn: ((active: boolean) => void) | null): void {
  approvalActivityListener = fn;
}

/**
 * Line-mode bridge: readline question on stdin/stdout.
 * - y / yes → decision; a → allow-always
 * - n / anything else / Esc / 60s visible countdown → n (safe default)
 * - Ctrl+C（经 sseInteractive 的 SIGINT 兜底调 cancelActiveApproval）→ n
 * - 拒绝后可附一句指导语，返回 `n:<指导语>`（engineAdapter 拼进拒绝反馈）。
 * P0-3：审批期间经 approvalActivityListener 通知宿主暂停 gerund 并交接 stdin；
 * 倒计时每秒 \r 原地重写选项行（配合 \x1b[K 清行纪律）。
 */
export function createCliApprovalBridge(opts: { timeoutMs?: number } = {}): (req: {
  tool: string;
  description: string;
  danger?: boolean;
}) => Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return (req) => new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    let answered = false;
    let remaining = Math.max(1, Math.round(timeoutMs / 1000));
    let ticker: NodeJS.Timeout | undefined;

    const dimWrap = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s);
    const optionPrompt = (secs: number) =>
      dimWrap(`  允许本次 [y] · 本会话总是允许 [a] · 拒绝 [n]（回车=n · ${secs}s 后自动拒绝） > `);
    const guidePrompt = dimWrap('  │ 要给模型一句指导可直接输入（回车跳过）: ');
    const dangerTag = req.danger ? ' [DANGER]' : '';

    const finish = (d: string) => {
      if (settled) return;
      settled = true;
      if (ticker) { clearInterval(ticker); ticker = undefined; }
      activeApprovalCancel = null;
      try { approvalActivityListener?.(false); } catch {}
      try { rl.close(); } catch {}
      if (!answered) { try { process.stdout.write('\n'); } catch {} }
      resolve(d);
    };

    // P0-1.4: SIGINT → 立即拒绝（由 sseInteractive 的 SIGINT 兜底经
    // cancelActiveApproval 转接进来；审批不再吞掉 Ctrl+C 卡满 60s）。
    activeApprovalCancel = () => {
      answered = true; // 本路径已自带换行收尾，finish 不再补 '\n'
      try { process.stdout.write('\n' + dimWrap('⏹ 已中断：本次审批按拒绝处理') + '\n'); } catch {}
      finish('n');
    };
    // P0-3.1: 通知宿主（暂停 gerund + 主 readline 让出 stdin）
    try { approvalActivityListener?.(true); } catch {}

    // P0-3.3: 每秒可见倒计时 — \r 原地重写选项行；同步 rl.setPrompt 保持
    // readline 内部 prompt 与屏幕一致（避免按键时光标错位）。
    ticker = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { finish('n'); return; }
      try {
        rl.setPrompt(optionPrompt(remaining));
        process.stdout.write('\r\x1b[K' + optionPrompt(remaining));
      } catch {}
    }, 1000);

    // 用户开始输入 → 冻结倒计时（重绘会擦掉 readline 行缓冲的可见字符）
    try {
      ((rl as any).input as any)?.on?.('keypress', () => {
        if (ticker) { clearInterval(ticker); ticker = undefined; }
      });
    } catch {}

    // 请求头行（工具 + 描述），随后 rl.question 的选项行带每秒倒计时。
    // 前置 '\n'：gerund 标签可能还占着当前行（P0-2 纪律在宿主侧，此处无法清它），
    // 换到新行起头，保证审批提示行不被拼接。
    try {
      process.stdout.write(`\n⚠ 审批 ${req.tool}${dangerTag}: ${req.description}\n`);
    } catch {}

    rl.question(optionPrompt(remaining), (answer) => {
      answered = true;
      if (ticker) { clearInterval(ticker); ticker = undefined; }
      const a = String(answer || '').trim().toLowerCase();
      if (a === 'y' || a === 'yes') { finish('y'); return; }
      if (a === 'a') { finish('a'); return; }
      // P0-3.4: n / 回车 / 其它 → 拒绝，追加可选的一句指导语
      rl.question(guidePrompt, (g) => {
        const guidance = String(g || '').trim();
        finish(guidance ? `n:${guidance}` : 'n');
      });
    });
  });
}
