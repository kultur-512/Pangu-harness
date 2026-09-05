// src/tools/engineAdapter.ts
// 引擎兼容层。
// Bridges VerifyCritiqueLoop's verificationEngine contract —
//   execute(calls: ToolCall[]): Promise<string>
// — onto the real tool executor, formatting results into the string heuristics
// the loop already understands. The loop itself stays untouched (until 2.5's
// one-line EXIT_CODE:0 enhancement).
//
// SAFETY GATE (first thing that runs, per M1 instruction):
//   !process.stdout.isTTY || PANSHA_SMOKE=1  →  fixed mock string, zero spawns,
//   zero file writes. This is what keeps smoke tests and CI harmless.

import type { ToolCall } from '../types/toolCall.js';
import type { TierConfig } from '../tiers/TierConfig.js';
import { createToolExecutor, type ToolExecutor } from './executor.js';
import { createBashTool, bashTimeoutForTier } from './bash.js';
import { isReadonlyAllowed, READONLY_DENY_MESSAGE } from './readonlyAllowlist.js';
import { readFile } from './readFile.js';
import { createWriteFileTool } from './writeFile.js';
import { createEditFileTool } from './editFile.js';
import { classify, describeRequest, WRITE_TOOLS, type ApprovalDecision } from './approval.js';
import { checkpointBeforeMutation } from './fileHistory.js';
import path from 'path';
import type { ToolContext, ToolImpl, ToolResult, DiffHunk } from './types.js';

// 共享写互斥 — 并行 rollout 间的 write/edit_file 调用全部
// rollouts serialize through one promise chain (shared workspace safety);
// read/bash tools run concurrently. Never blocks; failures don't poison the
// chain.
let writeChain: Promise<unknown> = Promise.resolve();
export function withWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface EngineAdapterOptions {
  workspaceRoot: string;
  tierConfig: TierConfig;
  /** 2.4 injects the session's approval mode here (default: readonly). */
  approvalMode?: 'readonly' | 'default' | 'full';
  /** 2.4 injects an approval bridge (rich ConfirmBar / readline / headless). */
  approvalBridge?: (req: {
    tool: string;
    description: string;
    danger: boolean;
    diff?: unknown[];
  }) => Promise<'y' | 'n' | 'a'>;
  /** Session-scoped allowlist for 'a' (allow-always) decisions. */
  sessionAllowlist?: Set<string>;
  /** plan mode — 写入与 bash 直接拒绝（读取放行）。 */
  planMode?: boolean;
  /** 审批确认超时（默认 60s → 视为 'n'）。 */
  approvalTimeoutMs?: number;
  /** 事件发射器（approval.request 卡片）— e.g. config.onStep。 */
  emitEvent?: (event: any) => void;
  /** Extra tools registered beyond the built-ins (bash in 2.2, write/edit in 2.3). */
  extraTools?: Record<string, import('./types.js').ToolImpl>;
  /** MCP 工具（命名空间 mcp_<server>_<tool>），按 bash 同等门禁。 */
  mcpTools?: Array<{
    server: string;
    name: string;
    description: string;
    call(args: Record<string, unknown>): Promise<{ ok: boolean; output: string; error?: string }>;
  }>;
  /** Files already read this run (RBW bookkeeping, used from 2.3). */
  readFiles?: Set<string>;
  signal?: AbortSignal;
}

export interface EngineAdapter {
  execute(calls: ToolCall[]): Promise<string>;
  /** Exposed for tests / approval command introspection. */
  executor: ToolExecutor;
  ctx: ToolContext;
}

export const SMOKE_MOCK_RESULT = 'VERIFICATION: ALL_TESTS_PASSED';

export function isSmokeEnvironment(): boolean {
  // Priority (dogfood-①): PANSHA_SMOKE=1 wins over everything (tests/CI keep
  // the power to force mock even if HEADLESS was mis-set in CI).
  if (process.env.PANSHA_SMOKE === '1') return true;
  // Explicit headless escape hatch: PANSHA_HEADLESS=1 or `pangu --headless`
  // opts OUT of the mock gate — real execution in non-interactive/CI contexts.
  // Must always be set explicitly; never defaults on.
  if (process.env.PANSHA_HEADLESS === '1') return false;
  // Default (unchanged): non-TTY → mock (safety red line).
  return !process.stdout.isTTY;
}

export function createEngineAdapter(opts: EngineAdapterOptions): EngineAdapter {
  // ---- SAFETY HARD GATE (must be the outermost behavior) ----
  if (isSmokeEnvironment()) {
    return {
      // Keeps the existing loop heuristic (PASS) and smoke behavior intact.
      execute: async () => SMOKE_MOCK_RESULT,
      executor: createToolExecutor({
        workspaceRoot: opts.workspaceRoot,
        approvalMode: 'readonly',
        signal: opts.signal,
      }),
      ctx: { workspaceRoot: opts.workspaceRoot, approvalMode: 'readonly', signal: opts.signal },
    };
  }

  const approvalMode = opts.approvalMode ?? 'readonly';
  const ctx: ToolContext = {
    workspaceRoot: opts.workspaceRoot,
    approvalMode,
    signal: opts.signal,
  };

  // 每轮 RBW 记账。readFiles 记录每次成功
  // read file (absolute, resolved) so write_file/edit_file can enforce
  // Read-Before-Write. The set lives for the lifetime of THIS adapter
  // (created per rollout by PanshalachChaser — matching per-rollout semantics).
  const readFiles = opts.readFiles ?? new Set<string>();

  const baseRead: ToolImpl = readFile;
  const readFileRecording: ToolImpl = async (params, c) => {
    const res = await baseRead(params, c);
    if (res.ok && res.meta && typeof res.meta.abs === 'string') {
      readFiles.add(path.resolve(res.meta.abs as string));
    }
    return res;
  };

  // tier 工具集：quick/standard 不提供写工具（六档
  // contract enforced at the execution layer). high/max/ex/pangu do.
  // (B1 fix: 'max' was missing — TierConfig marks max isStrongMode with
  // all-write confirmation, so it must carry write tools too.)
  const tier = String(opts.tierConfig.tier || '').toLowerCase();
  const writeTools: Record<string, ToolImpl> =
    (tier === 'high' || tier === 'max' || tier === 'ex' || tier === 'pangu')
      ? {
          write_file: createWriteFileTool({ readFiles }),
          edit_file: createEditFileTool({ readFiles }),
        }
      : {};

  // bash 按 tier 注册超时。只读强制
  // lives here (day-one rule): readonly mode → allowlist only; other modes
  // run fully (confirmation/danger handling arrives with 2.4).
  const bashImpl = createBashTool({ timeoutMs: bashTimeoutForTier(opts.tierConfig.tier) });
  const bashGuarded: ToolImpl = async (params, c) => {
    const cmd = params.command ?? params.cmd ?? '';
    if (c.approvalMode === 'readonly' && !isReadonlyAllowed(cmd)) {
      const res: ToolResult = {
        ok: false,
        output: READONLY_DENY_MESSAGE,
        durationMs: 0,
        error: 'DENIED_READONLY',
        meta: { danger: false },
      };
      return res;
    }
    return bashImpl(params, c);
  };

  const extra: Record<string, ToolImpl> = {
    ...(opts.extraTools ?? {}),
    read_file: readFileRecording,
    bash: bashGuarded,
    ...writeTools,
  };

  // MCP 工具 — 命名空间 mcp_<server>_<tool>，按 bash 同等门禁。
  // readonly → denied; default → confirm (via the same bridge); full → pass;
  // plan mode → denied. Danger heuristic: write-ish tool names flagged.
  const mcpTools = (opts.mcpTools ?? []).map((mt) => ({
    ...mt,
    call: async (args: Record<string, unknown>) => {
      const toolNorm = mt.name.toLowerCase();
      const danger = /write|delete|remove|exec|run|push|create|edit/i.test(toolNorm);
      // T-27（高危）: 先查全名 allowlist（mcp_<server>_<tool>——'a' 决策只放行该
      // MCP 工具，绝不解锁 bash）。未放行才走 classify('bash') 语义（MCP 视同
      // bash：readonly 一律拒、default 需审批、full 放行）。
      const allowlisted = sessionAllowlist.has(toolNorm);
      const verdict = allowlisted
        ? { needsApproval: false, denied: false, danger }
        : classify('bash', { command: mt.name }, {
            mode: approvalMode,
            sessionAllowlist,
            isReadonlyAllowed: () => false, // MCP never in the readonly allowlist
          });
      if (planMode) {
        return { ok: false, output: '✗ PLAN_MODE: 计划模式下禁止执行 MCP 工具，先输出方案', error: 'PLAN_MODE' };
      }
      if (verdict.denied) {
        return { ok: false, output: READONLY_DENY_MESSAGE, error: 'DENIED_READONLY' };
      }
      if (verdict.needsApproval) {
        if (!approvalBridge) {
          return { ok: false, output: `✗ DENIED (approval): 无可用审批通道，按拒绝处理。${mt.name}`, error: 'DENIED_BY_USER' };
        }
        const description = `MCP 工具 ${mt.name}（${mt.description || ''}）`;
        emitEvent?.({ version: 2, type: 'approval.request', requestId: `mcp_${Date.now()}_${++approvalSeq}`, tool: mt.name, description, danger });
        let decision: ApprovalDecision = 'n';
        try {
          decision = await Promise.race([
            approvalBridge({ tool: mt.name, description, danger }),
            new Promise<ApprovalDecision>((resolve) => {
              const t = setTimeout(() => resolve('n'), approvalTimeoutMs);
              t.unref();
              decisionTimer = t;
            }),
          ]);
          if (decisionTimer) { clearTimeout(decisionTimer); decisionTimer = undefined; }
        } catch {
          decision = 'n';
        }
        // T-27（高危）: 'a'（always allow）按 MCP 工具全名放行（mcp_<server>_<tool>），
        // 绝不 add('bash')——否则放行一个 MCP 工具即解锁全部 bash 免审。
        if (decision === 'a') sessionAllowlist.add(mt.name);
        if (decision !== 'y' && decision !== 'a') {
          return { ok: false, output: `✗ DENIED (user) · ${mt.name}`, error: 'DENIED_BY_USER' };
        }
      }
      return mt.call(args);
    },
  }));

  const executor = createToolExecutor(ctx, extra, mcpTools as any);

  function paramsOf(call: ToolCall): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of call.params || []) {
      if (p && typeof p.name === 'string') out[p.name] = String(p.value ?? '');
    }
    return out;
  }

  const DIFF_MARK = '⟦DIFF⟧';

  function describeResult(call: ToolCall, params: Record<string, string>, res: ToolResult): string {
    const name = String(call.toolName || '').trim().toLowerCase();
    let head: string;
    if (res.ok) {
      if (name.includes('read')) {
        head = `READ_SUCCESS: ${params.file_path || params.path || ''}\n${res.output}`;
      } else if (name === 'glob') {
        head = `GLOB_SUCCESS: ${res.meta?.lines ?? 0} file(s)\n${res.output}`;
      } else if (name === 'grep') {
        head = `GREP_SUCCESS: ${res.meta?.lines ?? 0} match(es)\n${res.output}`;
      } else if (name === 'write_file') {
        head = res.output;
      } else if (name === 'edit_file') {
        head = res.output;
      } else if (name === 'bash') {
        head = `BASH_SUCCESS:\n${res.output}`;
      } else {
        head = `TOOL_OK: ${name}\n${res.output}`;
      }
    } else {
      const firstLine = (res.output || res.error || '').split('\n')[0];
      head = `TOOL_ERROR: ${res.error || 'UNKNOWN'} ${firstLine}`;
    }

    // 在字符串契约内把结构化 diff 带给 UI。
    // ToolCard parses this marker line; the engine stays UI-agnostic.
    const diff = res.meta?.diff as DiffHunk[] | undefined;
    if (diff && diff.length > 0) {
      head += `\n${DIFF_MARK}${JSON.stringify(diff)}`;
    }
    return head;
  }

  const sessionAllowlist = opts.sessionAllowlist ?? new Set<string>();
  const planMode = !!opts.planMode;
  const WRITE_TOOLS_SET = WRITE_TOOLS;
  const approvalBridge = opts.approvalBridge;
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 60_000;
  const emitEvent = opts.emitEvent;

  let approvalSeq = 0;
  let decisionTimer: NodeJS.Timeout | undefined;
  // 连续未知工具漂移计数器（adapter 生命周期 = 单次
  // task run; resets only when a KNOWN tool is called).
  let unknownToolStreak = 0;

  /**
   * 执行前审批门。
   * - classify → denied: return immediately (readonly denial keeps the
   *   guidance text; user denial reports DENIED_BY_USER)
   * - needsApproval: route through the bridge (rich ConfirmBar / readline /
   *   headless). Non-TTY without a bridge → auto-'n' (never hang, never write).
   *   'a' adds the tool to the session allowlist.
   */
  async function gate(toolRaw: string, params: Record<string, string>): Promise<ToolResult | null> {
    const tool = String(toolRaw || '').trim().toLowerCase();

    // plan-mode 预检（classify 之前）— 读取放行，写入与
    // bash denied with the plan reason. Uses approval.ts WRITE_TOOLS as a
    // read-only helper; classify() signature untouched.
    if (planMode && (WRITE_TOOLS_SET.has(tool) || tool === 'bash')) {
      return {
        ok: false,
        output: '✗ PLAN_MODE: 计划模式下禁止执行，先输出方案',
        durationMs: 0,
        error: 'PLAN_MODE',
        meta: { danger: false },
      };
    }

    const verdict = classify(tool, params, {
      mode: approvalMode,
      sessionAllowlist,
      isReadonlyAllowed,
    });

    if (verdict.denied) {
      return {
        ok: false,
        output: `✗ DENIED (readonly) · ${verdict.reason || 'not permitted'}`,
        durationMs: 0,
        error: 'DENIED_READONLY',
        meta: { danger: verdict.danger },
      };
    }
    if (!verdict.needsApproval) return null;

    const description = describeRequest(tool, params);
    emitEvent?.({
      version: 2,
      type: 'approval.request',
      requestId: `appr_${Date.now()}_${++approvalSeq}`,
      tool,
      description,
      danger: verdict.danger,
    });

    if (!approvalBridge) {
      // No interactive bridge available (e.g. pure engine context): safe default.
      return {
        ok: false,
        output: `✗ DENIED (approval): 无可用审批通道，按拒绝处理。${description}`,
        durationMs: 0,
        error: 'DENIED_BY_USER',
        meta: { danger: verdict.danger },
      };
    }

    let decision: ApprovalDecision = 'n';
    try {
      // 桥接胜出时清除超时（防挂起）：
      // race — a stray 60s timer otherwise keeps `node --test` alive.
      // (No unref(): the timeout is a real deadline and must keep the loop
      //  alive until it fires or the bridge resolves.)
      let timer: NodeJS.Timeout | undefined;
      decision = await Promise.race([
        approvalBridge({ tool, description, danger: verdict.danger }),
        new Promise<ApprovalDecision>((resolve) => {
          timer = setTimeout(() => resolve('n'), approvalTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    } catch {
      decision = 'n';
    }

    if (decision === 'a') {
      sessionAllowlist.add(tool);
      decision = 'y';
    }
    if (decision !== 'y') {
      return {
        ok: false,
        output: `✗ DENIED (user) · ${tool}: ${description}`,
        durationMs: 0,
        error: 'DENIED_BY_USER',
        meta: { danger: verdict.danger },
      };
    }
    return null; // approved → proceed
  }

  return {
    executor,
    ctx,
    async execute(calls: ToolCall[]): Promise<string> {
      if (!Array.isArray(calls) || calls.length === 0) {
        return 'TOOL_ERROR: NO_CALLS verification engine received no tool calls';
      }
      const parts: string[] = [];
      for (const call of calls) {
        const params = paramsOf(call);
        const deniedRes = await gate(String(call.toolName || ''), params);
        if (deniedRes) {
          parts.push(describeResult(call, params, deniedRes));
          continue;
        }
        // snapshot the target BEFORE mutation so /undo can restore it.
        const toolNorm = String(call.toolName || '').trim().toLowerCase();
        if (toolNorm === 'write_file' || toolNorm === 'edit_file') {
          try { checkpointBeforeMutation(toolNorm, params, opts.workspaceRoot); } catch {}
        }
        // tools/pre-execute event point — observers (memory,
        // logging, policy) attach here; execution semantics unchanged.
        const toolStart = Date.now();
        try {
          emitEvent?.({
            type: 'tools/pre-execute',
            tool: toolNorm,
            params,
            approval: (sessionAllowlist.has(toolNorm) || approvalMode === 'full') ? 'allowed' : approvalMode,
            danger: false,
          });
        } catch {}
        // write/edit 经共享互斥串行化
        // (parallel rollouts share the workspace); read/bash stay concurrent.
        const res = toolNorm === 'write_file' || toolNorm === 'edit_file'
          ? await withWriteLock(() => executor.execute(String(call.toolName || ''), params))
          : await executor.execute(String(call.toolName || ''), params);
        // tools/post-execute event (result + duration) for observability
        try {
          emitEvent?.({
            type: 'tools/post-execute',
            tool: toolNorm,
            ok: res.ok,
            exitCode: res.meta?.exitCode ?? null,
            durationMs: Date.now() - toolStart,
            error: res.error,
          });
        } catch {}
        // 未知工具漂移运行时护栏 — 记录 + 引导 +
        // hard-stop on consecutive spins (anti "5-step empty spin").
        if (res.error === 'UNKNOWN_TOOL') {
          unknownToolStreak++;
          const toolName = String(call.toolName || '').trim();
          const tools = [...executor.availableTools()].sort().join(', ');
          parts.push(
            describeResult(call, params, res) +
            `\n（提示：工具名错误。可用工具: ${tools}。若你想读文件请用 read_file，想改文件请用 edit_file / write_file。）`
          );
          if (unknownToolStreak >= 3) {
            parts.push(
              `（连续 ${unknownToolStreak} 次调用未知工具。请立即停止猜测工具名，仅使用【可用工具】列表中的名称。）`
            );
          }
        } else {
          unknownToolStreak = 0; // any known tool resets the drift streak
          parts.push(describeResult(call, params, res));
        }
      }
      return parts.join('\n---\n');
    },
  };
}
