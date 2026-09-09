// src/tools/engineAdapter.ts
// 引擎兼容层。
// Bridges VerifyCritiqueLoop's verificationEngine contract —
//   execute(calls: ToolCall[]): Promise<string>
// — onto the real tool executor, formatting results into the string heuristics
// the loop already understands. The loop itself stays untouched (until 2.5's
// one-line EXIT_CODE:0 enhancement).
//
// SAFETY GATE (0.8 semantics): mock is EXPLICIT OPT-IN ONLY (PANSHA_SMOKE=1)
//   → fixed mock string, zero spawns, zero file writes. Non-TTY no longer
//   defaults to mock: non-interactive safety is enforced by the real defense
//   stack (approval three-tier + pathGuard + sensitive paths + read-before-write),
//   NOT by fake results (the mock previously masked two P0s where real successes
//   were misjudged as failures).

import type { ToolCall } from '../types/toolCall.js';
import type { TierConfig } from '../tiers/TierConfig.js';
import { createToolExecutor, normalizeToolName, type ToolExecutor } from './executor.js';
import { createBashTool, bashTimeoutForTier } from './bash.js';
import { isReadonlyAllowed, READONLY_DENY_MESSAGE } from './readonlyAllowlist.js';
import { readFile } from './readFile.js';
import { createWriteFileTool } from './writeFile.js';
import { createEditFileTool } from './editFile.js';
import { classify, describeRequest, WRITE_TOOLS, cancelActiveApproval, type ApprovalDecision } from './approval.js';
import { checkpointBeforeMutation } from './fileHistory.js';
import { isSensitiveWorkspacePath, sensitiveDenyMessage } from './sensitivePaths.js';
// 'a' 决策持久化到项目配置（best-effort；ConfigManager 无反向依赖，无环）
import { appendProjectApprovalAllowlist } from '../cli/repl/ConfigManager.js';
import fs from 'node:fs';
import path from 'path';
import { TOOL_OUTPUT_CAP, type ToolContext, type ToolImpl, type ToolResult, type DiffHunk } from './types.js';

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

// ---- M2-1: 并行分段调度常量 ----
/** 整批 execute() 的硬闸超时（对齐 hermes 默认 420s）。 */
export const BATCH_TIMEOUT_MS = 420_000;
/** 连续只读段（read_file/glob/grep）的并发上限。 */
export const READ_SEGMENT_CONCURRENCY = 3;
/** 落入只读并发段的规范化工具名。 */
const READ_SEGMENT_TOOLS: ReadonlySet<string> = new Set(['read_file', 'glob', 'grep']);

// ---- M2-3: 工具结果落盘 ----
/** 超 cap 结果落盘目录（workspace 相对路径，进 .gitignore）。 */
export const SCRATCH_DIR = '.panshalach';
export const SCRATCH_SUBDIR = 'scratch';
/** 预览：头/尾保留字符数。 */
export const PERSIST_PREVIEW_HEAD = 1500;
export const PERSIST_PREVIEW_TAIL = 500;
// 会话级序号（进程即会话；adapter 按 rollout 重建，序号跨 rollout 单调）。
let persistSeq = 0;

export interface EngineAdapterOptions {
  workspaceRoot: string;
  tierConfig: TierConfig;
  /** Injects the session's approval mode here (default: readonly). */
  approvalMode?: 'readonly' | 'default' | 'full';
  /** Injects an approval bridge (rich ConfirmBar / readline / headless).
   *  返回放宽为 string：line 桥可返回 `n:<指导语>`（拼进拒绝反馈）。 */
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
  /** M2-1 整批超时（默认 420_000ms；超时未完成的 call 落 TIMEOUT 结果）。 */
  batchTimeoutMs?: number;
  /** 事件发射器（approval.request 卡片）— e.g. config.onStep。 */
  emitEvent?: (event: any) => void;
  /** Extra tools registered beyond the built-ins (bash, write/edit). */
  extraTools?: Record<string, import('./types.js').ToolImpl>;
  /** MCP 工具（命名空间 mcp_<server>_<tool>），按 bash 同等门禁。 */
  mcpTools?: Array<{
    server: string;
    name: string;
    description: string;
    call(args: Record<string, unknown>): Promise<{ ok: boolean; output: string; error?: string }>;
  }>;
  /** Files already read this run (RBW bookkeeping). */
  readFiles?: Set<string>;
  signal?: AbortSignal;
}

export interface EngineAdapter {
  execute(calls: ToolCall[]): Promise<string>;
  /** Exposed for tests / approval command introspection. */
  executor: ToolExecutor;
  ctx: ToolContext;
  /**
   * 请求侧：OpenAI function calling schema 列表（本 adapter 实际可执行的
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
  // 0.8 语义反转：mock 仅显式 opt-in（PANSHA_SMOKE=1）。
  // 非交互场景的安全由审批三档 + pathGuard + 敏感路径 + 写前读四层真防护兜底，
  // 不再由假结果密封（假结果曾掩盖真实成功被误判的两个 P0）。
  // PANSHA_HEADLESS 保留为兼容别名（no-op，历史上是本门的逃逸通道）。
  return process.env.PANSHA_SMOKE === '1';
}

export function createEngineAdapter(opts: EngineAdapterOptions): EngineAdapter {
  // ---- SMOKE GATE (explicit opt-in only, PANSHA_SMOKE=1) ----
  // Non-TTY is NOT smoke anymore (0.8 reversal): real execution proceeds and
  // non-interactive safety is兜底 by the real defense layers wired below —
  // approval three-tier gate() (readonly deny / bridge-or-auto-deny), pathGuard
  // + read-before-write inside the write tools, and the M2-6 sensitive-path
  // hard deny (sensitiveWriteDenial, all tiers, pre-approval).
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
      // 先查全名 allowlist（mcp_<server>_<tool>——'a' 决策只放行该
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
          // timer 限定在 race 局部（adapter 级共享变量会被并发 MCP 审批互相覆盖/漏清）
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
        // 'a'（always allow）按 MCP 工具全名放行（mcp_<server>_<tool>），
        // 绝不 add('bash')——否则放行一个 MCP 工具即解锁全部 bash 免审。
        // `n:<指导语>` 同样拼进 MCP 拒绝反馈。
        const mRaw = String(decision || 'n');
        const mGuidance = mRaw.startsWith('n:') ? mRaw.slice(2).trim() : '';
        const mEff: ApprovalDecision = mRaw === 'a' ? 'a' : mRaw === 'y' ? 'y' : 'n';
        if (mEff === 'a') {
          sessionAllowlist.add(mt.name);
          // 与 bash/write gate 同语义——'a' 持久化（best-effort）
          try { appendProjectApprovalAllowlist(opts.workspaceRoot, mt.name); } catch {}
        }
        if (mEff !== 'y' && mEff !== 'a') {
          return { ok: false, output: `✗ DENIED (user) · ${mt.name}${mGuidance ? `\n│ 用户指导: ${mGuidance}` : ''}`, error: 'DENIED_BY_USER' };
        }
      }
      return mt.call(args);
    },
  }));

  const executor = createToolExecutor(ctx, extra, mcpTools as any);

  // 请求侧：内置工具的 OpenAI function schema。
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

    // 真实成功信号确定性入册——
    // 按 `res.ok` + 工具类别在结果尾部追加规范尾标，让 loop 的 classifySignal
    // 能识别真实引擎的成功（此前唯一 PASS 产出方是 smoke mock，真实成功被误判
    // FAIL → completed 真机不可达）。不做正文字符串扫描：
    //   bash（EXIT_CODE:0 尾行已有）→ 追加 VERIFICATION: PASS（命令真跑通=验证）
    //   write_file / edit_file      → 追加 VERIFICATION: APPLIED（写盘成功 ≠ 任务
    //                                 验证通过；PASS 留给真实验证命令，
    //                                 APPLIED=PARTIAL——清零连败但不触发 completed）
    //   read_file / glob / grep     → 追加 VERIFICATION: NEUTRAL（只读，无验证效力）
    // 失败分支（TOOL_ERROR）不追加任何 VERIFICATION 行——失败永远不该长得像成功。
    if (res.ok) {
      if (name === 'bash') {
        head += '\nVERIFICATION: PASS';
      } else if (name === 'write_file' || name === 'edit_file') {
        head += '\nVERIFICATION: APPLIED';
      } else if (name.includes('read') || name === 'glob' || name === 'grep') {
        head += '\nVERIFICATION: NEUTRAL';
      }
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
    // 引擎侧 60s race 超时放行时，桥接侧 finish 未跑会残留
    // activeApprovalCancel → isApprovalActive() 恒真（gerund 永久暂停 +
    // 后续 Ctrl+C 被死审批劫持）。超时路径显式清钩子。
    if (timedOut) {
      try { cancelActiveApproval('timeout'); } catch {}
    }

    // `n:<指导语>` — 拒绝的同时携带用户给模型的一句指导。
    const dRaw = String(decision || 'n');
    const guidance = dRaw.startsWith('n:') ? dRaw.slice(2).trim() : '';
    let eff: ApprovalDecision = dRaw === 'a' ? 'a' : dRaw === 'y' ? 'y' : 'n';
    if (eff === 'a') {
      sessionAllowlist.add(tool);
      // 'a' 决策同时持久化到项目配置 approvalAllowlist（best-effort，
      // 失败静默）——下一会话启动时经 Session 构造器加载回 sessionAllowlist。
      try { appendProjectApprovalAllowlist(opts.workspaceRoot, tool); } catch {}
      // 'a' = 加入会话 allowlist 且**本次放行**（与 MCP gate
      // 语义一致：选"总是允许"当次也必须放行，否则首次选 a 反而被拒）。
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

  /**
   * M2-6: sensitive-path write protection — hard deny at EVERY tier, BEFORE
   * the approval gate (readonly/default/full all reject; approval cannot
   * override). Alias-normalized so `write`/`edit` can't slip past the check.
   */
  function sensitiveWriteDenial(toolRaw: string, params: Record<string, string>): ToolResult | null {
    const norm = normalizeToolName(toolRaw);
    if (norm !== 'write_file' && norm !== 'edit_file') return null;
    const p = params.file_path ?? params.path ?? '';
    if (!p || !isSensitiveWorkspacePath(opts.workspaceRoot, p)) return null;
    return {
      ok: false,
      output: sensitiveDenyMessage(p),
      durationMs: 0,
      error: 'SENSITIVE_PATH',
      meta: { danger: true },
    };
  }

  // ---- M2-3: oversized output → scratch persistence + head/tail preview ----
  function persistOversizedOutput(toolNorm: string, res: ToolResult): ToolResult {
    // read_file NEVER persists (persist → re-read → persist loop); the model
    // re-reads via offset 续读 instead.
    if (toolNorm === 'read_file') return res;
    const full = res.meta?.fullOutput;
    if (typeof full !== 'string' || full.length <= TOOL_OUTPUT_CAP) return res;
    try {
      const scratchDir = path.join(opts.workspaceRoot, SCRATCH_DIR, SCRATCH_SUBDIR);
      fs.mkdirSync(scratchDir, { recursive: true });
      const name = `tool-${++persistSeq}.txt`;
      fs.writeFileSync(path.join(scratchDir, name), full, 'utf-8');
      const rel = `${SCRATCH_DIR}/${SCRATCH_SUBDIR}/${name}`;
      const head = full.slice(0, PERSIST_PREVIEW_HEAD);
      const tail = full.slice(-PERSIST_PREVIEW_TAIL);
      const omitted = full.length - head.length - tail.length;
      const preview =
        head +
        `\n…[中间 ${omitted} 字符已落盘]\n` +
        tail +
        `\n<persisted-output path="${rel}">`;
      return {
        ...res,
        output: preview,
        meta: { ...res.meta, persistedOutput: rel, fullOutput: undefined },
      };
    } catch {
      // Best-effort: on any fs failure the capped output stays usable.
      return res;
    }
  }

  const emitPreEvent = (toolRaw: string, params: Record<string, string>) => {
    const toolNorm = String(toolRaw || '').trim().toLowerCase();
    try {
      emitEvent?.({
        type: 'tools/pre-execute',
        tool: toolNorm,
        params,
        approval: (sessionAllowlist.has(toolNorm) || approvalMode === 'full') ? 'allowed' : approvalMode,
        danger: false,
      });
    } catch {}
  };

  const emitPostEvent = (toolRaw: string, res: ToolResult, toolStart: number) => {
    const toolNorm = String(toolRaw || '').trim().toLowerCase();
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
        persistedOutput: typeof res.meta?.persistedOutput === 'string' ? res.meta.persistedOutput : undefined,
      });
    } catch {}
  };

  return {
    executor,
    ctx,
    toolSchemas,
    async execute(calls: ToolCall[]): Promise<string> {
      if (!Array.isArray(calls) || calls.length === 0) {
        return 'TOOL_ERROR: NO_CALLS verification engine received no tool calls';
      }

      // ---- M2-1 batch deadline: races the WHOLE segment pipeline. ----
      const batchTimeoutMs = Math.max(1, opts.batchTimeoutMs ?? BATCH_TIMEOUT_MS);
      const BATCH_TIMEOUT = Symbol('batch-timeout');
      let deadlineTimer: NodeJS.Timeout | null = null;
      let batchTimedOut = false;
      const deadline = new Promise<typeof BATCH_TIMEOUT>((resolve) => {
        deadlineTimer = setTimeout(() => {
          batchTimedOut = true;
          resolve(BATCH_TIMEOUT);
        }, batchTimeoutMs);
      });

      type CallOutcome =
        | { kind: 'denied'; params: Record<string, string>; res: ToolResult }
        | { kind: 'run'; params: Record<string, string>; res: ToolResult; toolStart: number }
        | { kind: 'batch-timeout'; params: Record<string, string> };

      const outcomes: (CallOutcome | null)[] = new Array(calls.length).fill(null);
      const startedAt: (number | undefined)[] = new Array(calls.length);
      const preEmitted: boolean[] = new Array(calls.length).fill(false);

      const raceBatch = async <T>(p: Promise<T>): Promise<T | typeof BATCH_TIMEOUT> => {
        if (batchTimedOut) return BATCH_TIMEOUT;
        return await Promise.race([p, deadline]);
      };

      // 每个 call 独立走 gate（只读段内并行仍逐 call 审批语义）。
      const runCall = async (call: ToolCall, idx: number): Promise<CallOutcome> => {
        const params = paramsOf(call);
        const sensitiveRes = sensitiveWriteDenial(String(call.toolName || ''), params);
        const deniedRes = sensitiveRes ?? (await gate(String(call.toolName || ''), params));
        if (deniedRes) return { kind: 'denied', params, res: deniedRes };
        const toolNorm = String(call.toolName || '').trim().toLowerCase();
        if (toolNorm === 'write_file' || toolNorm === 'edit_file') {
          try { checkpointBeforeMutation(toolNorm, params, opts.workspaceRoot); } catch {}
        }
        const toolStart = Date.now();
        startedAt[idx] = toolStart;
        emitPreEvent(String(call.toolName || ''), params);
        preEmitted[idx] = true;
        const raw = toolNorm === 'write_file' || toolNorm === 'edit_file'
          ? await withWriteLock(() => executor.execute(String(call.toolName || ''), params))
          : await executor.execute(String(call.toolName || ''), params);
        const res = persistOversizedOutput(toolNorm, raw);
        return { kind: 'run', params, res, toolStart };
      };

      // 结果/事件按原始序落位（不按完成序）。
      const settleOutcome = (idx: number, o: CallOutcome) => {
        outcomes[idx] = o;
        if (o.kind === 'denied') {
          const deniedTool = String(calls[idx].toolName || '').trim().toLowerCase();
          try {
            emitEvent?.({
              type: 'tools/pre-execute',
              tool: deniedTool,
              params: o.params,
              approval: 'denied',
              danger: !!o.res.meta?.danger,
            });
            emitEvent?.({
              type: 'tools/post-execute',
              tool: deniedTool,
              ok: false,
              exitCode: null,
              durationMs: 0,
              error: o.res.error,
              outputPreview: typeof o.res.output === 'string' ? o.res.output.slice(0, 500) : '',
            });
          } catch {}
        } else if (o.kind === 'run') {
          emitPostEvent(String(calls[idx].toolName || ''), o.res, o.toolStart);
        } else {
          if (!preEmitted[idx]) emitPreEvent(String(calls[idx].toolName || ''), o.params);
          const timeoutRes: ToolResult = {
            ok: false,
            output: `✗ batch timed out after ${Math.round(batchTimeoutMs / 1000)}s`,
            durationMs: startedAt[idx] != null ? Date.now() - startedAt[idx] : 0,
            error: 'TIMEOUT',
            meta: { danger: false },
          };
          emitPostEvent(String(calls[idx].toolName || ''), timeoutRes, startedAt[idx] ?? Date.now());
        }
      };

      const isReadCall = (call: ToolCall): boolean =>
        READ_SEGMENT_TOOLS.has(normalizeToolName(String(call.toolName || '')));

      try {
        let i = 0;
        while (i < calls.length) {
          if (batchTimedOut) break;
          if (isReadCall(calls[i])) {
            // 连续只读段：分波（≤3）并发，段内按原始序 emit pre，完成后按原始序 emit post。
            let j = i;
            while (j < calls.length && isReadCall(calls[j])) j++;
            for (let k = i; k < j && !batchTimedOut; k += READ_SEGMENT_CONCURRENCY) {
              const end = Math.min(k + READ_SEGMENT_CONCURRENCY, j);
              const idxs: number[] = [];
              for (let x = k; x < end; x++) idxs.push(x);
              const settled = await Promise.all(idxs.map((x) => raceBatch(runCall(calls[x], x))));
              for (let x = 0; x < idxs.length; x++) {
                const r = settled[x];
                settleOutcome(idxs[x], r === BATCH_TIMEOUT
                  ? { kind: 'batch-timeout', params: paramsOf(calls[idxs[x]]) }
                  : r);
              }
            }
            i = j;
          } else {
            // barrier 串行段：write/edit 经 withWriteLock；bash/MCP/未知工具单 call 串行。
            const r = await raceBatch(runCall(calls[i], i));
            settleOutcome(i, r === BATCH_TIMEOUT
              ? { kind: 'batch-timeout', params: paramsOf(calls[i]) }
              : r);
            i++;
          }
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }

      // 超时跳过的未启动 call：补齐 pre/post + TIMEOUT 结果。
      for (let k = 0; k < calls.length; k++) {
        if (outcomes[k] === null) {
          settleOutcome(k, { kind: 'batch-timeout', params: paramsOf(calls[k]) });
        }
      }

      // 按原始调用顺序装配 parts（LoopStep.verificationResult 顺序不变）。
      const parts: string[] = [];
      for (let k = 0; k < calls.length; k++) {
        const call = calls[k];
        const o = outcomes[k]!;
        if (o.kind === 'denied') {
          parts.push(describeResult(call, o.params, o.res));
          continue;
        }
        if (o.kind === 'batch-timeout') {
          const res: ToolResult = {
            ok: false,
            output: `✗ batch timed out after ${Math.round(batchTimeoutMs / 1000)}s`,
            durationMs: 0,
            error: 'TIMEOUT',
            meta: { danger: false },
          };
          parts.push(describeResult(call, o.params, res));
          continue;
        }
        const res = o.res;
        if (res.error === 'UNKNOWN_TOOL') {
          unknownToolStreak++;
          const toolName = String(call.toolName || '').trim();
          const tools = [...executor.availableTools()].sort().join(', ');
          parts.push(
            describeResult(call, o.params, res) +
            `\n（提示：工具名错误。可用工具: ${tools}。若你想读文件请用 read_file，想改文件请用 edit_file / write_file。）`
          );
          if (unknownToolStreak >= 3) {
            parts.push(
              `（连续 ${unknownToolStreak} 次调用未知工具。请立即停止猜测工具名，仅使用【可用工具】列表中的名称。）`
            );
          }
        } else {
          unknownToolStreak = 0; // any known tool resets the drift streak
          parts.push(describeResult(call, o.params, res));
        }
      }
      return parts.join('\n---\n');
    },
  };
}
