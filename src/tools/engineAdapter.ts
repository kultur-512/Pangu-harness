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
import { classify, describeRequest, WRITE_TOOLS, cancelActiveApproval, type ApprovalDecision } from './approval.js';
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
  /** 2.4 injects an approval bridge (rich ConfirmBar / readline / headless).
   *  返回放宽为 string：line 桥可返回 `n:<指导语>`（P0-3.4，拼进拒绝反馈）。 */
  approvalBridge?: (req: {
    tool: string;
    description: string;
    danger: boolean;
    diff?: unknown[];
  }) => Promise<string>;
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
  /**
   * P1.1 请求侧：OpenAI function calling schema 列表（本 adapter 实际可执行的
   * 工具集 = 注册表 ∩ schema 表，外加 MCP 工具）。smoke 环境返回 []。
   */
  toolSchemas(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
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
      toolSchemas: () => [],
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

  // tier 工具集（2026-09-05 裁决：写工具全档位注册）——quick/standard 也提供
  // write/edit；安全性由审批门禁（readonly allowlist / default 确认 / RBW）
  // 兜底，而不是靠隐藏工具（隐藏会诱导 UNKNOWN_TOOL 空转）。
  const writeTools: Record<string, ToolImpl> = {
    write_file: createWriteFileTool({ readFiles }),
    edit_file: createEditFileTool({ readFiles }),
  };

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
  let decisionTimerLocal: NodeJS.Timeout | undefined;
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
        let decision = 'n';
        try {
          // 评审 P2：timer 改 race 局部（adapter 级共享变量会被并发 MCP 审批互相覆盖/漏清）
          decision = await Promise.race([
            approvalBridge({ tool: mt.name, description, danger }),
            new Promise<string>((resolve) => {
              const t = setTimeout(() => resolve('n'), approvalTimeoutMs);
              t.unref();
              decisionTimerLocal = t;
            }),
          ]);
          if (decisionTimerLocal) { clearTimeout(decisionTimerLocal); decisionTimerLocal = undefined; }
        } catch {
          decision = 'n';
        }
        // T-27（高危）: 'a'（always allow）按 MCP 工具全名放行（mcp_<server>_<tool>），
        // 绝不 add('bash')——否则放行一个 MCP 工具即解锁全部 bash 免审。
        // P0-3.4: `n:<指导语>` 同样拼进 MCP 拒绝反馈。
        const mRaw = String(decision || 'n');
        const mGuidance = mRaw.startsWith('n:') ? mRaw.slice(2).trim() : '';
        const mEff: ApprovalDecision = mRaw === 'a' ? 'a' : mRaw === 'y' ? 'y' : 'n';
        if (mEff === 'a') sessionAllowlist.add(mt.name);
        if (mEff !== 'y' && mEff !== 'a') {
          return { ok: false, output: `✗ DENIED (user) · ${mt.name}${mGuidance ? `\n│ 用户指导: ${mGuidance}` : ''}`, error: 'DENIED_BY_USER' };
        }
      }
      return mt.call(args);
    },
  }));

  const executor = createToolExecutor(ctx, extra, mcpTools as any);

  // P1.1 请求侧：内置工具的 OpenAI function schema。
  // 参数键与各工具实现实际读取的键严格一致（file_path/content/command/...）。
  const BUILTIN_TOOL_SCHEMAS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
    read_file: {
      description: '读取工作区内文本文件的内容（可指定起止行）。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区的文件路径' },
          offset: { type: 'string', description: '起始行号（可选，默认 1）' },
          limit: { type: 'string', description: '读取行数（可选，默认 2000）' },
        },
        required: ['file_path'],
      },
    },
    glob: {
      description: '按 glob 模式列出工作区内的文件路径。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，例如 src/**/*.ts' },
          path: { type: 'string', description: '起始目录（可选，默认工作区根）' },
        },
        required: ['pattern'],
      },
    },
    grep: {
      description: '在工作区内按正则搜索文件内容。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '搜索目录（可选，默认工作区根）' },
          include: { type: 'string', description: '文件名 glob 过滤（可选，例如 *.ts）' },
        },
        required: ['pattern'],
      },
    },
    bash: {
      description: '在工作区执行 bash 命令（受审批模式门禁约束）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
        },
        required: ['command'],
      },
    },
    write_file: {
      description: '写入（或覆盖）工作区内的文件。写前必须先 read_file 该文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区的目标文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['file_path', 'content'],
      },
    },
    edit_file: {
      description: '对工作区内已有文件做精确字符串替换。写前必须先 read_file 该文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区的目标文件路径' },
          old_string: { type: 'string', description: '要被替换的原文（须唯一或配合 replace_all）' },
          new_string: { type: 'string', description: '替换后的新文本' },
          replace_all: { type: 'string', description: "'true' 时替换全部出现（可选）" },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  };

  function toolSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    const out: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
    for (const name of executor.availableTools()) {
      const schema = BUILTIN_TOOL_SCHEMAS[name];
      if (schema) out.push({ name, ...schema });
    }
    for (const mt of mcpTools) {
      out.push({
        name: mt.name,
        description: mt.description || `MCP 工具 ${mt.name}`,
        parameters: { type: 'object', properties: {} },
      });
    }
    return out;
  }

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

    let decision: string = 'n';
    let timedOut = false;
    try {
      // 桥接胜出时清除超时（防挂起）：
      // race — a stray 60s timer otherwise keeps `node --test` alive.
      // (No unref(): the timeout is a real deadline and must keep the loop
      //  alive until it fires or the bridge resolves.)
      let timer: NodeJS.Timeout | undefined;
      decision = await Promise.race([
        approvalBridge({ tool, description, danger: verdict.danger }),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve('n'); }, approvalTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    } catch {
      decision = 'n';
    }
    // 评审 Bug#3：引擎侧 60s race 超时放行时，桥接侧 finish 未跑会残留
    // activeApprovalCancel → isApprovalActive() 恒真（gerund 永久暂停 +
    // 后续 Ctrl+C 被死审批劫持）。超时路径显式清钩子。
    if (timedOut) {
      try { cancelActiveApproval('timeout'); } catch {}
    }

    // P0-3.4: `n:<指导语>` — 拒绝的同时携带用户给模型的一句指导。
    const dRaw = String(decision || 'n');
    const guidance = dRaw.startsWith('n:') ? dRaw.slice(2).trim() : '';
    let eff: ApprovalDecision = dRaw === 'a' ? 'a' : dRaw === 'y' ? 'y' : 'n';
    if (eff === 'a') {
      sessionAllowlist.add(tool);
      // 评审 Bug#1：'a' = 加入会话 allowlist 且**本次放行**（与 MCP gate
      // 语义一致）。旧实现 `decision='a'; decision='y'` 的等价语义在改造
      // 中丢失，导致首次选"总是允许"反而被拒。
      eff = 'y';
    }
    if (eff !== 'y') {
      return {
        ok: false,
        output: `✗ DENIED (user) · ${tool}: ${description}${guidance ? `\n│ 用户指导: ${guidance}` : ''}`,
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
    toolSchemas,
    async execute(calls: ToolCall[]): Promise<string> {
      if (!Array.isArray(calls) || calls.length === 0) {
        return 'TOOL_ERROR: NO_CALLS verification engine received no tool calls';
      }
      const parts: string[] = [];
      for (const call of calls) {
        const params = paramsOf(call);
        const deniedRes = await gate(String(call.toolName || ''), params);
        if (deniedRes) {
          // 评审核销缺口：gate 拒绝的调用也要发 post-execute（ok:false），
          // 否则 line 模式拒绝零卡片反馈（pre 行已由调用方在 execute 前无
          // 从发出——这里连 pre 一起补齐）。
          const deniedTool = String(call.toolName || '').trim().toLowerCase();
          try {
            emitEvent?.({
              type: 'tools/pre-execute',
              tool: deniedTool,
              params,
              approval: 'denied',
              danger: !!deniedRes.meta?.danger,
            });
            emitEvent?.({
              type: 'tools/post-execute',
              tool: deniedTool,
              ok: false,
              exitCode: null,
              durationMs: 0,
              error: deniedRes.error,
              outputPreview: typeof deniedRes.output === 'string' ? deniedRes.output.slice(0, 500) : '',
            });
          } catch {}
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
        // tools/post-execute event (result + duration) for observability.
        // P1-2: 附带轻量结果载荷（截断 output / 行数 / diff 摘要），line 模式
        // 工具实时卡片的结果行由此渲染（Wrote N lines / Read N lines / Added-removed）。
        try {
          emitEvent?.({
            type: 'tools/post-execute',
            tool: toolNorm,
            ok: res.ok,
            exitCode: res.meta?.exitCode ?? null,
            durationMs: Date.now() - toolStart,
            error: res.error,
            outputPreview: typeof res.output === 'string' ? res.output.slice(0, 1500) : '',
            lines: Number(res.meta?.lines) || undefined,
            diff: Array.isArray(res.meta?.diff) ? (res.meta?.diff as DiffHunk[]).slice(0, 40) : undefined,
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
