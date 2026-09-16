// VerifyCritiqueLoop - 验证密集 + 复盘循环
// 目的：长程任务中保持验证密度与建设性复盘的核心循环。
// 
// 高纪律路径（highRigor / !practicalMode）设计原则：
// - 严谨可靠：保留 Read-Before-Write、Verify-Before-Claim、标准格式、高验证密度。
// - 工程可用：在真实日常高强度项目中能长时间运行，不会因为过于严苛导致 token 爆炸、模型疲劳或工作流卡死。
// - 分数友好：通过高密度验证、建设性复盘、纪律规则遵守，在 benchmark / 评测中仍能保持竞争力。
// 
// 实用模式：更温和、token 高效，适合常规开发。
// 
// 自我批评保持建设性。纪律规则主要在高纪律模式下高强度执行，但频率和语气都经过工程化调优。

import { StructuredReasoner, StructuredReasoningOutput } from '../reasoning/StructuredReasoner.js';
import { ToolCallGuardrailController, type ToolCallGuardrailOptions } from './guardrails.js';
import { UniversalToolCallAdapter, ToolCallFormat } from '../adapter/UniversalToolCallAdapter.js';
import { ToolCall, inferToolCategory } from '../types/toolCall.js';
import { BenchmarkProfiles, BenchmarkType } from '../benchmarks/BenchmarkProfiles.js';
import { IronLawInjectionLevel } from '../tiers/TierConfig.js';
import { classifyApiError } from '../model/errorClassify.js';
import type { StaticAnalysisResult } from '../review/Reviewer.js';
import type { ChatMessage, TurnStopReason } from '../cli/repl/types.js';
import { estTokens, safeSlice } from '../cli/repl/tokenEstimate.js';

/**
 * Critique 构造上下文
 * 用于在 critique prompt 构建阶段按指定顺序注入结构化块。
 */
export interface CritiqueContext {
  staticAnalysisBlocks?: string[];
}

/** C1 收缩循环迭代上限（P0：CJK 巨结果曾致 for(;;) 永不收敛）。 */
const MESSAGES_BUDGET_MAX_ITERATIONS = 64;
/** 二级收缩的最小保留长度下限（码点数）：低于此不截（防退化切片）。 */
const TOOL_SHRINK_MIN_KEEP_CODEPOINTS = 64;

/**
 * 按 estTokens 反推截断尺寸：返回 content 的最大前缀/后缀（码点对齐，经
 * safeSlice），使 estTokens(产物) ≤ budgetTokens。estTokens 对长度单调 →
 * 在码元索引上二分。纯 CJK 与 ASCII 统一按同一 token 口径收敛（P0 修复核心）。
 */
function sliceToTokenBudget(content: string, budgetTokens: number, fromHead: boolean): string {
  if (budgetTokens <= 0) return '';
  if (estTokens(content) <= budgetTokens) return content;
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = mid === 0
      ? ''
      : (fromHead ? safeSlice(content, 0, mid) : safeSlice(content, -mid));
    if (estTokens(candidate) <= budgetTokens) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return '';
  return fromHead ? safeSlice(content, 0, lo) : safeSlice(content, -lo);
}

export type VerificationSignal = 'PASS' | 'FAIL' | 'PARTIAL' | 'ERROR' | 'NO_TOOL_CALLS';

export interface LoopStep {
  stepNumber: number;
  reasoning: StructuredReasoningOutput;
  toolCalls: ToolCall[];
  verificationResult: string;
  verificationSignal: VerificationSignal;
  detectedFormat?: ToolCallFormat;
  didRealVerification?: boolean;
  readBeforeWriteViolation?: boolean;
  /** 多任务风格每步信号 */
  terminalNoCheck?: boolean;
  automationNoEffectCheck?: boolean;
  /** 空转 answered 步的用户正文（2026-09-16：answerText 带出的数据源） */
  result?: string;
}

export interface VerifyCritiqueLoopOptions {
  strictStructured?: boolean; // 解析/格式严格度旗标；与 !practicalMode 联合构成高纪律行为
  useUniversalAdapter?: boolean;
  maxSteps?: number;
  maxConsecutiveFailures?: number;
  verifyFirstBias?: boolean;
  /** 
   * When true, the loop will use lighter prompts suitable for daily coding.
   * When false (default for strong mode), it uses more rigorous prompts and higher verification density.
   */
  practicalMode?: boolean;
  /** 任务风格（推荐）：'swe' | 'terminal' | 'automation' 等，用于适配验证策略。 */
  taskStyle?: string;
  /** 显式执行意图：intent==='task' 时为 true——驱动"只说话不动手"防呆 nudge。
   *  不传时回落 isStrongMode/taskStyle 启发（向后兼容）。 */
  executionIntent?: boolean;
  /** search 意图（0.8.5 工具配合度修复）：只读受限循环同样接格式教学 + nudge
   *  阶梯（此前 gate 在 executionIntent 上，search 对弱模型是裸奔 3 步零出块）；
   *  availableToolNames 随之限缩为只读工具（教学与 readonly 白名单对齐）。 */
  searchIntent?: boolean;
  /** 任务风格别名，等同于 taskStyle。 */
  benchmarkType?: BenchmarkType | string;
  /** 是否高纪律模式，等同于 !practicalMode 的高纪律路径。 */
  isStrongMode?: boolean;
  /** 纪律规则注入强度 */
  ironLawInjectionLevel?: IronLawInjectionLevel;
  /** tier 名称 */
  tier?: string;
  /**
   * 预格式化的静态分析块字符串数组（推荐）。
   * 每个元素应为 Reviewer 产生的 <static_analysis_result ...> 片段。
   * 这些块将在 critique prompt 中以 <static_analysis_context> 包裹，并在 <user_request> 之前注入。
   */
  staticAnalysisBlocks?: string[];
  /**
   * 原始静态分析结果（Loop 会按需格式化）。
   * 预格式化块请优先使用 staticAnalysisBlocks。
   */
  staticAnalysis?: StaticAnalysisResult[];

  /**
   * 显式用户请求，用于构造 <user_request> 块。
   */
  userRequest?: string;

  /**
   * 当前 diff，用于构造 <current_diff> 块。
   */
  currentDiff?: string;

  /** 外部中止信号（贯穿到模型调用与工具执行）。abort 时本轮以 stopReason='aborted' 结束。 */
  signal?: AbortSignal;

  /**
   * 上下文窗口预算（tokens，来自 provider.getModelContextLength，
   * unknown 回落 32768）。>0 时 buildHistoryPrompt 组装后超过窗口 70%
   * （estTokens，CJK 感知）→ 裁 history 中段（保前 2 步 + 后 2 步）。
   */
  windowTokens?: number;

  /**
   * 0.8 P2（M1-PROTOCOL）：messages 模式下 system 首消息内容
   * （PromptBuilder.buildStableSegment 产物，任务间字节级不变 → 网关前缀缓存可命中）。
   * 缺省时 messages 栈以首条 user 起始（chat 通道仍可用）。
   */
  systemSegment?: string;

  /**
   * M2-2 卡死检测硬闸阈值（hermes tool_guardrails 移植）。缺省
   * exactFailureBlockAfter=5 / sameToolFailureHaltAfter=8 / noProgressBlockAfter=5。
   * 与 maxConsecutiveFailures 并行（互不替代）。
   */
  guardrails?: ToolCallGuardrailOptions;

  /**
   * M2-5：context_overflow 通知（loop 捕获分类为 context_overflow 时回调，
   * 每任务至多一次）。宿主可据此触发 compactService 的强制档（force 入口，
   * 绕过 shouldAutoCompact 的 0.85 阈值）执行会话级压缩。回调抛错不阻断 loop。
   */
  onContextOverflow?: (info: { error: unknown }) => void | Promise<void>;
}

export class VerifyCritiqueLoop {
  private steps: LoopStep[] = [];
  private universalAdapter = new UniversalToolCallAdapter();
  private consecutiveFailures = 0;
  /** M2-2 卡死检测硬闸（loop 生命周期实例，与 maxConsecutiveFailures 并行）。 */
  private guardrails: ToolCallGuardrailController;

  private useUniversal: boolean;
  private strictStructured: boolean; // 为 true 时优先严格 <> 解析器 + 高纪律行为（与 !practicalMode 联合）
  private verifyFirstBias: boolean;
  private practicalMode: boolean;
  private benchmarkType?: BenchmarkType | string; // taskStyle 的别名（内部同步维护）
  private taskStyle?: string;
  /** 显式执行意图（0.8.2 真机纰漏修复）：由宿主从意图分类直接传入（intent==='task'）。
   *  缺省时回落旧启发（isStrongMode || taskStyle==='execution'）——但默认档 high 的
   *  taskStyle 实际为 'all'，启发恒 false 导致"只说话不动手防呆 nudge"成死代码
   *  （MiniMax-M3 真机 T1 实证：规格书式 prompt 首步纯文本答复即被 answered 放行）。 */
  private executionIntentFlag?: boolean;
  private searchIntentFlag = false;
  private isStrongMode?: boolean;
  private signal?: AbortSignal;
  private profile = BenchmarkProfiles.get('swe');
  // 纪律规则注入强度 / tier 名称
  private ironLawInjectionLevel?: IronLawInjectionLevel;
  private tierName?: string;
  /** 原始静态分析结果 */
  private staticAnalysis?: StaticAnalysisResult[];
  /** 预格式化的静态分析块 */
  private staticAnalysisBlocks: string[] = [];
  /** 显式 user request，用于 <user_request> 块 */
  private userRequest?: string;
  /** 当前 diff，用于 <current_diff> 块 */
  private currentDiff?: string;
  /** 保存初始 prompt，用于尽力提取 user request（不影响主逻辑） */
  private initialPromptForContext: string = '';

  // 0.8 P2（M1-PROTOCOL）：任务内 messages 栈（chat 通道专用；与 steps 同源维护）。
  private messages: ChatMessage[] = [];
  /** messages 首消息的 system 段（由 chaser 注入的 stable 段文本）。 */
  private systemSegment?: string;
  /** 自增工具调用 id 序号（文本协议解析无原生 id 时合成 tool_call_id 配对用）。 */
  private toolCallSeq = 0;

  // M2-5：context_overflow 联动（overflow → 强制压缩 → 重试本步，每任务 ≤1 次）
  /** 本任务是否已用过 overflow 重试（防循环：每任务最多 1 次）。 */
  private overflowRetryUsed = false;
  /** 本任务是否已通知外层 overflow（每任务至多一次，通知失败不阻断）。 */
  private overflowNotified = false;
  /** 强制压缩已启用（触发后本任务余下所有 history 组装均裁中段）。 */
  private forcedCompactApplied = false;
  /** 消费型旗标：重试本步的 prompt 注入一次性压缩提示。 */
  private pendingOverflowNotice = false;
  /** onContextOverflow 通知回调（宿主 → compactService 强制档）。 */
  private onContextOverflow?: (info: { error: unknown }) => void | Promise<void>;

  constructor(
    private modelClient: any,
    private verificationEngine: any,
    options: VerifyCritiqueLoopOptions = {}
  ) {
    // 解析统一走三路自适应（JSON/文本/XML 容错探测）——
    // useUniversalAdapter 选项仅为兼容保留，恒真；<> 严格独占解析路径已归档。
    this.useUniversal = true;
    this.strictStructured = options.strictStructured ?? true;
    // 2026-09-16 取消步数限制：maxSteps ≤0（或缺省）= 不限步数，预算闸兜底；
    // 显式正数仍生效（eval/测试可用）。
    this.maxSteps = options.maxSteps !== undefined && options.maxSteps > 0
      ? options.maxSteps
      : Number.POSITIVE_INFINITY;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.verifyFirstBias = options.verifyFirstBias ?? this.strictStructured;
    // 高纪律模式判定（behavioral）：优先 isStrongMode，其次 !practicalMode，再次 strictStructured
    const explicitStrong = options.isStrongMode;
    const explicitPractical = options.practicalMode;
    this.isStrongMode = explicitStrong ?? (explicitPractical === undefined ? this.strictStructured : !explicitPractical);
    this.practicalMode = explicitPractical ?? !this.isStrongMode;
    // 任务风格：优先 taskStyle，其次 benchmarkType（别名）
    this.taskStyle = options.taskStyle ?? (options.benchmarkType as string | undefined);
    this.executionIntentFlag = options.executionIntent;
    this.searchIntentFlag = options.searchIntent === true;
    this.benchmarkType = options.benchmarkType ?? this.taskStyle;
    this.profile = BenchmarkProfiles.get(this.taskStyle ?? this.benchmarkType);
    // 接收纪律规则注入强度、tier 名称
    this.ironLawInjectionLevel = options.ironLawInjectionLevel;
    this.tierName = options.tier;
    // 静态分析
    this.staticAnalysis = options.staticAnalysis;
    if (Array.isArray(options.staticAnalysisBlocks)) {
      this.staticAnalysisBlocks = options.staticAnalysisBlocks.slice();
    } else {
      this.staticAnalysisBlocks = [];
    }
    this.userRequest = options.userRequest;
    this.currentDiff = options.currentDiff;
    this.signal = options.signal;
    this.windowTokens = options.windowTokens;
    this.systemSegment = options.systemSegment;
    this.onContextOverflow = options.onContextOverflow;
    // M2-2 卡死检测硬闸（hermes tool_guardrails 移植）：loop 生命周期实例。
    this.guardrails = new ToolCallGuardrailController(options.guardrails);
  }

  private maxSteps: number;
  private maxConsecutiveFailures: number;

  // 结构化 Iron Law tracking (Read-Before-Write + Verification density)
  private hasPerformedRealVerification = false;
  private stepsSinceLastRealVerification = 0;
  private verificationAttempts = 0;

  // 消费型一次性旗标——非状态机：置位后在下一次 prompt
  // 组装处消费并复位；对应的终局门只看布尔本身。
  /** 上一步响应被 max_tokens 截断，下一步 prompt 注入精简提示。 */
  private pendingTruncationNotice = false;
  /**
   */
  /** 连续 NO_TOOL_CALLS 步数（喂 guardrails 作格式停滞信号：只计数上报，不设硬闸——maxSteps 已兜底）。 */
  private consecutiveNoToolCalls = 0;
  /** 上下文窗口预算（tokens）。>0 时 buildHistoryPrompt 超 70% 裁中段。 */
  private windowTokens?: number;

  /**
   * PANSHA_NO_BUDGET_TRIM=1 → 禁用主动窗口预算裁剪（评测 A 档逃生门：
   * 让"窗口装不下"可达网关，真溢出可测）。溢出应急档（forcedCompactApplied）
   * 是溢出后的恢复路径，不受此开关影响。
   */
  private get budgetTrimDisabled(): boolean {
    return process.env.PANSHA_NO_BUDGET_TRIM === '1';
  }

  private filesReadThisTrajectory = new Set<string>();
  private filesWrittenThisTrajectory = new Set<string>();
  private readBeforeWriteViolations = 0;

  // 多任务风格支持的额外跟踪
  private terminalCommandsExecuted = 0;
  private terminalNoCheckViolations = 0;   // Terminal 风格：关键命令后未检查
  private automationStepsWithoutEffectCheck = 0;

  /** 当前引擎实际可用的工具名（格式教学示例必须与之匹配，防 UNKNOWN_TOOL 空转）。 */
  private availableToolNames(): string[] | undefined {
    try {
      let names = this.verificationEngine?.executor?.availableTools?.();
      // 0.8.5 search 只读限缩：教学/提示清单与 readonly 白名单对齐
      // （写/bash 在 search 循环必被拒，教了也是白教且误导模型）。
      if (this.searchIntentFlag && Array.isArray(names)) {
        const readonlySet = new Set(['read_file', 'glob', 'grep']);
        names = names.filter((n) => readonlySet.has(String(n)));
      }
      return Array.isArray(names) && names.length > 0 ? names.map(String) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * T1：格式教学的 schema 注入（工具用途/参数名从 engineAdapter.toolSchemas() 取，
   * 不写死）。mock/旧引擎无该方法 → 返回空对象，StructuredReasoner 走内置兜底。
   */
  private formatPromptOpts(): { schemaById?: Record<string, { description?: string; parameters?: any }> } {
    try {
      const fn = (this.verificationEngine as any)?.toolSchemas;
      if (typeof fn === 'function') {
        const schemas = fn.call(this.verificationEngine);
        if (Array.isArray(schemas) && schemas.length > 0) {
          const schemaById: Record<string, { description?: string; parameters?: any }> = {};
          for (const s of schemas) {
            if (s && typeof s.name === 'string') schemaById[s.name.toLowerCase()] = s;
          }
          return { schemaById };
        }
      }
    } catch {
      // mock 引擎无 toolSchemas → 内置兜底
    }
    return {};
  }

  /** T1：格式教学全文（各调用点共用同一注入形态）。 */
  private buildFormatTeachingPrompt(): string {
    return StructuredReasoner.buildToolCallFormatEnforcementPrompt(this.availableToolNames(), this.formatPromptOpts());
  }

  /**
   * 0.8 P2（M1-PROTOCOL）双通道门：模型客户端具备 messages 能力
   * （chat / streamChatMessages）且 PANSHA_MESSAGES_MODE !== 'off' 时走
   * chat 通道（messages 栈组装）；否则走 complete(prompt) 文本路径
   * （与 0.7.4 逐字节等价）。
   */
  private get messagesModeEnabled(): boolean {
    if (process.env.PANSHA_MESSAGES_MODE === 'off') return false;
    const c = this.modelClient as any;
    return typeof c?.chat === 'function' || typeof c?.streamChatMessages === 'function';
  }

  /**
   * A5：messages 栈截断——保种子前缀（system + 首条 user + 首步注入）+
   * 末 N 个 assistant 交换对（assistant + 其 tool 结果），中段换一条 user
   * 截断标记。边界按 role:'assistant' 切（practicalMode 下大多数步骤没有
   * user 注入消息，user 边界凑不齐组）；assistant 在切口处、其 tool 结果
   * 全部在后段——天然无孤儿 tool、无悬空 tool_calls（OpenAI 严格校验）。
   */
  private trimMessages(maxGroups = 2): void {
    const msgs = this.messages;
    const firstAssistant = msgs.findIndex((m) => m.role === 'assistant');
    if (firstAssistant === -1) return;
    const prefixEnd = firstAssistant; // [0..prefixEnd) = system/种子/首步注入，恒保留
    const assistantIdx: number[] = [];
    for (let i = firstAssistant; i < msgs.length; i++) {
      if (msgs[i].role === 'assistant') assistantIdx.push(i);
    }
    if (assistantIdx.length <= maxGroups) return;
    const cutFrom = assistantIdx[assistantIdx.length - maxGroups];
    const dropped = cutFrom - prefixEnd;
    const marker: ChatMessage = {
      role: 'user',
      content: `[...${dropped} 条步骤历史已截断（上下文窗口预算）；如需背景信息请用 read_file/glob 重新获取，不要复述历史。]`,
    };
    this.messages = [...msgs.slice(0, prefixEnd), marker, ...msgs.slice(cutFrom)];
  }

  /** A5：messages 栈 token 估算（全部消息 content 之和，CJK-aware）。 */
  private messagesTokens(): number {
    let t = 0;
    for (const m of this.messages) t += estTokens(typeof m.content === 'string' ? m.content : '');
    return t;
  }

  /**
   * C1：把 messages 栈收缩到 capTokens 以内，返回是否做过任何裁剪。
   * 两级策略：组级 trimMessages（丢最旧交换组）→ 仍超则对栈内最大 tool
   * 消息做二级内容截断（防"trim 后组数已到底、巨结果仍在"的残余超窗）。
   * 巨型首条 user（种子）不可裁——到它为止，交溢出应急。
   * 【P0 修复】迭代上限 + 进展检查：旧 for(;;) 在纯 CJK 巨工具结果上永不收敛
   * （截断尺寸按 ASCII 4 chars/token 换算、按 CJK 口径重估恒超 cap）——180K 次
   * 迭代不终止。64 次上限 + "本次收缩未使最大 tool 消息 token 数下降即退出"
   * 双保险保证有限终止。
   */
  private enforceMessagesBudget(capTokens: number): boolean {
    let acted = false;
    for (let iter = 0; iter < MESSAGES_BUDGET_MAX_ITERATIONS; iter++) {
      if (this.messagesTokens() <= capTokens) return acted;
      const before = this.messages.length;
      this.trimMessages();
      if (this.messages.length < before) { acted = true; continue; }
      if (this.shrinkLargestToolMessage()) { acted = true; continue; }
      return acted;
    }
    return acted;
  }

  /**
   * C1 二级裁剪：栈内 estTokens 最大的 tool 消息 >20% 窗口预算 → 头 + 尾，
   * 中段换显式标记。
   * 【P0 修复】截断尺寸按 estTokens 反推（token 预算 → 二分求最大前缀/后缀）：
   * 旧实现按 ASCII 4 chars/token 换算 head/tail 字符数，纯 CJK 巨结果按 CJK
   * 系数（默认 1.0）重估后恒超 cap → 收缩永不收敛。现在 head+tail
   * token 预算合计 = capTokens*0.85（比例维持旧 60/25 分成），任何语种下
   * 单次收缩必然大幅降低该消息 token 数。
   * 返回 true 当且仅当本次收缩使该消息 token 数【严格下降】（进展检查）。
   */
  private shrinkLargestToolMessage(): boolean {
    if (!this.windowTokens || this.windowTokens <= 0) return false;
    const capTokens = this.windowTokens * 0.7 * 0.2;
    let bi = -1; let bt = 0;
    this.messages.forEach((m, i) => {
      if (m.role === 'tool') {
        const t = estTokens(typeof m.content === 'string' ? m.content : '');
        if (t > bt) { bt = t; bi = i; }
      }
    });
    if (bi === -1 || bt <= capTokens) return false;
    const content = String(this.messages[bi].content ?? '');
    // 最小保留长度下限：极短消息不值得截（防退化切片/无意义抖动）
    if ([...content].length <= TOOL_SHRINK_MIN_KEEP_CODEPOINTS) return false;
    const tokenBudget = capTokens * 0.85;
    const headTokens = tokenBudget * (0.6 / 0.85);
    const tailTokens = tokenBudget * (0.25 / 0.85);
    const head = sliceToTokenBudget(content, headTokens, true);
    const tail = sliceToTokenBudget(content, tailTokens, false);
    const next = head
      + '\n[...工具输出过长已截断（窗口预算）；如需完整内容（尤其 read_file 输出），请重新读取目标文件...]'
      + tail;
    if (estTokens(next) >= bt) return false; // 无进展即退出（防截断标记开销形成死点）
    this.messages[bi] = {
      ...this.messages[bi],
      content: next,
    };
    return true;
  }

  /** 0.8 P2：剥离工具调用原文块，剩余面向模型的"文本部分"（assistant 消息 content）。 */
  private stripToolBlocks(rawContent: string, toolCalls: ToolCall[]): string {
    let out = String(rawContent ?? '');
    for (const c of toolCalls) {
      if (typeof c.rawBlock === 'string' && c.rawBlock) out = out.split(c.rawBlock).join('');
    }
    return out;
  }

  /**
   * 0.8 P2：内部 ToolCall[] → wire 形状 tool_calls（assistant 消息透传）。
   * 原生 FC（rawBlock 为 JSON）还原原 id 与 arguments；文本协议解析无 id →
   * 自增合成（tool 消息以同 id 配对）。
   */
  private buildWireToolCalls(toolCalls: ToolCall[]): unknown[] {
    return toolCalls.map((c) => {
      if (typeof c.rawBlock === 'string' && c.rawBlock) {
        try {
          const t = JSON.parse(c.rawBlock);
          if (t && t.function && typeof t.function.name === 'string') {
            const entry: any = { type: 'function', function: { name: t.function.name } };
            if (typeof t.function.arguments === 'string') entry.function.arguments = t.function.arguments;
            entry.id = (typeof t.id === 'string' && t.id) ? t.id : `call_${++this.toolCallSeq}`;
            return entry;
          }
        } catch {
          // 文本协议 rawBlock 非 JSON → 走下方合成
        }
      }
      const argsObj: Record<string, unknown> = {};
      for (const p of c.params ?? []) {
        if (p && typeof p.name === 'string') {
          try { argsObj[p.name] = JSON.parse(p.value); } catch { argsObj[p.name] = p.value; }
        }
      }
      return {
        id: `call_${++this.toolCallSeq}`,
        type: 'function',
        function: { name: c.toolName, arguments: JSON.stringify(argsObj) },
      };
    });
  }

  /**
   * 0.8 P2：工具结果回灌 messages 栈（chat 通道）。结果按 '\n---\n' 分段数
   * 与调用数匹配时逐 call 切分；不匹配时【P2 修复】前 N-1 条放有界预览
   * （首 800 字符 + 说明标记），完整结果只落最后一条（仍受单条封顶）——
   * 旧实现把整段 resultText 复制进每条 tool 消息，多调用大结果膨胀 N×20% 窗口。
   * C1（0.8.2 审查）：per-message 封顶——read_file 上限 20% 窗口预算，
   * 超限保留头 60% + 尾 25%，中段换显式标记（对齐文本路径 capStepPart 语义）。
   * 所有截断经 safeSlice（码点对齐，不产孤立代理项）。
   */
  private pushToolMessages(toolCalls: ToolCall[], wireCalls: unknown[] | null, resultText: string): void {
    const text = String(resultText ?? '');
    const segments = text.split('\n---\n');
    const perCall = segments.length === toolCalls.length ? segments : null;
    const budgetTokens = this.windowTokens && this.windowTokens > 0
      ? this.windowTokens * 0.2
      : 0;
    // 分段数与调用数不匹配（含引擎附加提示段等）：无法可靠按调用归位。
    const mismatch = !perCall && toolCalls.length > 1;
    const MISMATCH_PREVIEW_CHARS = 800;
    const MISMATCH_NOTE = '\n[...多调用结果无法按调用切分，本条仅为首段预览；完整结果见本步最后一条工具消息...]';
    toolCalls.forEach((c, i) => {
      const wireId = wireCalls ? (wireCalls[i] as any)?.id : undefined;
      let content: string;
      if (perCall) {
        content = perCall[i];
      } else if (!mismatch || i === toolCalls.length - 1) {
        // 单调用（分段天然不匹配不切分）或最后一条：完整结果（仍受单条封顶）
        content = text;
      } else {
        content = safeSlice(text, 0, MISMATCH_PREVIEW_CHARS) + MISMATCH_NOTE;
      }
      if (budgetTokens > 0 && estTokens(content) > budgetTokens) {
        const head = sliceToTokenBudget(content, budgetTokens * 0.6, true);
        const tail = sliceToTokenBudget(content, budgetTokens * 0.25, false);
        content = head
          + '\n[...工具输出过长已截断（单条窗口预算）；如需完整内容（尤其 read_file 输出），请重新读取目标文件（输出中会给出 offset 续读位置）。]'
          + tail;
      }
      this.messages.push({
        role: 'tool',
        toolCallId: wireId ? String(wireId) : `call_${++this.toolCallSeq}`,
        name: c.toolName,
        content,
      });
    });
  }

  /**
   * 0.8 P2：messages 模式下每步追加的 user 消息（镜像文本路径的逐步注入：
   * iron 头/截断续跑/overflow 提示/格式提醒/工程建议/风格提醒）。
   * 消费型旗标与文本路径共享（同一 run 生命周期只走一条轨）。
   */
  private buildMessagesStepInjection(stepNum: number, highRigor: boolean): string {
    const lead: string[] = [];
    const tail: string[] = [];

    // 截断续跑提示——上一步响应被 max_tokens 截断时，注入一次性提醒。
    if (this.pendingTruncationNotice) {
      this.pendingTruncationNotice = false;
      lead.push('【上一条响应被 max_tokens 截断，请精简后继续】如需调用工具请保持调用块完整；如为答复请精简内容后输出。');
    }
    // M2-5 overflow 强制压缩提示——重试本步时注入一次性提醒。
    if (this.pendingOverflowNotice) {
      this.pendingOverflowNotice = false;
      lead.push('【上下文长度已超限——历史已溢出截断（仅保留首尾步骤）。请精简输出继续当前任务；如需背景信息请用 read_file/glob 重新获取，不要复述历史。】');
    }
    if (highRigor) {
      const injectionLevel = this.ironLawInjectionLevel ?? 'medium';
      const shouldInjectIronHeader = injectionLevel === 'highest'
        || (injectionLevel === 'high' && (this.readBeforeWriteViolations > 0 || this.stepsSinceLastRealVerification >= 3 || stepNum <= 2))
        || (injectionLevel === 'medium_high' && (this.readBeforeWriteViolations > 0 || this.stepsSinceLastRealVerification >= 3 || stepNum <= 3))
        || (injectionLevel === 'medium' && (this.readBeforeWriteViolations > 0 || stepNum <= 1));

      if (shouldInjectIronHeader) {
        const ironHeader = StructuredReasoner.getEngineeringIronLawsHeader();
        const ironStatus = StructuredReasoner.buildCurrentIronLawStatus({
          filesRead: this.filesReadThisTrajectory.size,
          filesWritten: this.filesWrittenThisTrajectory.size,
          rbwViolations: this.readBeforeWriteViolations,
          verifiedCount: this.verificationAttempts,
          stepsSinceLastVerification: this.stepsSinceLastRealVerification,
        });
        lead.push(ironHeader + '\n\n' + ironStatus);
      }

      const hasFormatIssue = this.steps.some(s => s.detectedFormat && String(s.detectedFormat).includes('loose'));
      const formatEarlyBoundMap: Record<string, number> = {
        minimal: 1, low: 1, medium: 2, medium_high: 3, high: 4, highest: 5,
      };
      const formatEarlyBound = formatEarlyBoundMap[injectionLevel] ?? 2;
      if ((injectionLevel === 'minimal' || injectionLevel === 'low') && !hasFormatIssue) {
        // 跳过格式提示
      } else if (stepNum <= formatEarlyBound || hasFormatIssue) {
        tail.push(this.buildFormatTeachingPrompt());
      }

      if (this.verifyFirstBias && this.stepsSinceLastRealVerification >= 3 && stepNum >= 4) {
        tail.push('【工程建议】建议尽快完成一次明确验证（测试/状态/效果确认），避免长时间无确认的修改。');
      }

      if (this.terminalNoCheckViolations > 0) {
        tail.push('【Terminal 实践】关键命令后请检查 exit code / 输出 / 状态，确认效果。');
      }
      if (this.automationStepsWithoutEffectCheck > 0) {
        tail.push('【Automation 实践】动作后请用 CheckStatus / VerifyEffect 确认业务效果。');
      }
      if (this.readBeforeWriteViolations > 0) {
        tail.push('【Read-Before-Write】修改前先完整读文件，这是高纪律模式保证质量的核心纪律。');
      }
    } else {
      if (stepNum <= 1) {
        tail.push(this.buildFormatTeachingPrompt());
      }
      if (this.readBeforeWriteViolations > 0) {
        tail.push('【小提醒】最近有在未读取文件的情况下直接修改文件的倾向，建议先读取再修改。');
      }
      if (this.stepsSinceLastRealVerification >= 3) {
        tail.push('【小提醒】已经连续几步没有明显验证，建议适当确认修改效果。');
      }
    }

    const all = [...lead, ...tail];
    return all.length ? all.join('\n\n') : '';
  }

  async run(initialPrompt: string): Promise<{
    success: boolean;
    steps: LoopStep[];
    stopReason?: TurnStopReason;
    partialText?: string;
    /** M2-5：本任务是否触发过 overflow 强制压缩重试（宿主观测/记账用）。 */
    contextOverflowCompacted?: boolean;
  }> {
    let stepNum = 0;
    let done = false;
    let stopReason: TurnStopReason | undefined;
    /** aborted 时本步已流出的模型正文（部分结果，随轨迹带回宿主落盘）。 */
    let partialText: string | undefined;
    const highRigor = ((this.isStrongMode ?? this.strictStructured) && !this.practicalMode);

    // 0.8 P2（M1-PROTOCOL）：messages 栈种子——system 段一次 + 首条 user（任务+volatile）。
    // 双通道门在 run 生命周期内恒一（env / 客户端能力不变）。
    const messagesMode = this.messagesModeEnabled;
    if (messagesMode) {
      this.messages = [];
      this.toolCallSeq = 0;
      if (this.systemSegment) {
        this.messages.push({ role: 'system', content: this.systemSegment });
      }
      this.messages.push({ role: 'user', content: initialPrompt });
    }

    while (!done && stepNum < this.maxSteps) {
      if (this.signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      stepNum++;
      // 空转 answered 步的用户正文（step.result；answerText 带出的数据源）
      let idleAnswerText: string | undefined;

      let prompt = '';
      if (!messagesMode) {
        const history = this.buildHistoryPrompt();
        prompt = `${initialPrompt}\n\n[历史执行记录]\n${history}`;

      // 截断续跑提示——上一步响应被 max_tokens 截断时，注入一次性
      // 提醒（消费型旗标，不是新状态机）。
      if (this.pendingTruncationNotice) {
        this.pendingTruncationNotice = false;
        prompt += '\n\n【上一条响应被 max_tokens 截断，请精简后继续】如需调用工具请保持调用块完整；如为答复请精简内容后输出。';
      }
      // M2-5 overflow 强制压缩提示——重试本步时注入一次性提醒（消费型旗标）。
      if (this.pendingOverflowNotice) {
        this.pendingOverflowNotice = false;
        prompt += '\n\n【上下文长度已超限——历史已溢出截断（仅保留首尾步骤）。请精简输出继续当前任务；如需背景信息请用 read_file/glob 重新获取，不要复述历史。】';
      }

      // 构建 prompt 时根据 practicalMode + 任务风格调整纪律规则/格式注入强度
      // 高纪律模式设计目标：工程强 + 分数强
      // - 保留核心纪律（Read-Before-Write、Verify-Before-Claim、标准格式）
      // - 但只在“有风险或早期”时才重度注入，避免每步塞大段规则导致 token 爆炸和日常工程不可用
      if (highRigor) {
        // === 高纪律模式（高纪律，工程可用） ===
        // 完全按 ironLawInjectionLevel 差异化
        // - 'minimal' / 'low'：几乎不注入（只保留格式/任务风格提醒）
        // - 'medium'：常规注入
        // - 'medium_high' / 'high'：重度注入
        // - 'highest'：始终注入完整纪律规则头
        const injectionLevel = this.ironLawInjectionLevel ?? 'medium';

        // minimal: 极轻量；low: 轻量；medium: 标准；medium_high/high: 较重；highest: 最重
        const shouldInjectIronHeader = injectionLevel === 'highest'
          || (injectionLevel === 'high' && (this.readBeforeWriteViolations > 0 || this.stepsSinceLastRealVerification >= 3 || stepNum <= 2))
          || (injectionLevel === 'medium_high' && (this.readBeforeWriteViolations > 0 || this.stepsSinceLastRealVerification >= 3 || stepNum <= 3))
          || (injectionLevel === 'medium' && (this.readBeforeWriteViolations > 0 || stepNum <= 1));

        if (shouldInjectIronHeader) {
          const ironHeader = StructuredReasoner.getEngineeringIronLawsHeader();
          const ironStatus = StructuredReasoner.buildCurrentIronLawStatus({
            filesRead: this.filesReadThisTrajectory.size,
            filesWritten: this.filesWrittenThisTrajectory.size,
            rbwViolations: this.readBeforeWriteViolations,
            verifiedCount: this.verificationAttempts,
            stepsSinceLastVerification: this.stepsSinceLastRealVerification,
          });
          prompt = ironHeader + '\n\n' + ironStatus + '\n\n' + prompt;
        }

        // 格式提示：按 ironLawInjectionLevel 差异化
        const hasFormatIssue = this.steps.some(s => s.detectedFormat && String(s.detectedFormat).includes('loose'));
        const formatEarlyBoundMap: Record<string, number> = {
          minimal: 1, low: 1, medium: 2, medium_high: 3, high: 4, highest: 5,
        };
        const formatEarlyBound = formatEarlyBoundMap[injectionLevel] ?? 2;
        // minimal / low 几乎不强制格式提示（除非已出问题）
        if ((injectionLevel === 'minimal' || injectionLevel === 'low') && !hasFormatIssue) {
          // 跳过格式提示
        } else if (stepNum <= formatEarlyBound || hasFormatIssue) {
          prompt += `\n\n${this.buildFormatTeachingPrompt()}`;
        }

        // 验证提醒更实用
        if (this.verifyFirstBias && this.stepsSinceLastRealVerification >= 3 && stepNum >= 4) {
          prompt += `\n\n【工程建议】建议尽快完成一次明确验证（测试/状态/效果确认），避免长时间无确认的修改。`;
        }

        // 任务风格提醒（仅违规时，轻量）
        if (this.terminalNoCheckViolations > 0) {
          prompt += `\n\n【Terminal 实践】关键命令后请检查 exit code / 输出 / 状态，确认效果。`;
        }
        if (this.automationStepsWithoutEffectCheck > 0) {
          prompt += `\n\n【Automation 实践】动作后请用 CheckStatus / VerifyEffect 确认业务效果。`;
        }
        if (this.readBeforeWriteViolations > 0) {
          prompt += `\n\n【Read-Before-Write】修改前先完整读文件，这是高纪律模式保证质量的核心纪律。`;
        }
      } else {
        // === 实用 / 日常模式：轻量纪律提示（避免无谓消耗）===
        // 首轮格式教学：任何档位第一步都必须知道调用格式（小模型无示例不产出调用）。
        if (stepNum <= 1) {
          prompt += `\n\n${this.buildFormatTeachingPrompt()}`;
        }
        if (this.readBeforeWriteViolations > 0) {
          prompt += `\n\n【小提醒】最近有在未读取文件的情况下直接修改文件的倾向，建议先读取再修改。`;
        }
        if (this.stepsSinceLastRealVerification >= 3) {
          prompt += `\n\n【小提醒】已经连续几步没有明显验证，建议适当确认修改效果。`;
        }
      }
      } else {
        // 0.8 P2：messages 通道——逐步注入作为独立 user 消息追加到 messages 栈。
        const stepUser = this.buildMessagesStepInjection(stepNum, highRigor);
        if (stepUser) this.messages.push({ role: 'user', content: stepUser });
      }

      // P1.1 请求侧：真实引擎带 toolSchemas() 时走原生 function calling；
      // mock/旧引擎没有该方法 → 不带 tools，维持文本协议路径（测试兼容）。
      const toolSchemas = typeof this.verificationEngine?.toolSchemas === 'function'
        ? this.verificationEngine.toolSchemas()
        : undefined;

      // A5：messages 发送前稳态预算——栈 >70% 窗口即迭代收缩（C1：组级 trim
      // 到底后对巨 tool 消息二级截断，防单条巨结果残余超窗）。与文本路径的
      // buildHistoryPrompt 70% 预算线对等。windowTokens 未提供或
      // PANSHA_NO_BUDGET_TRIM=1（评测逃生门）时不裁。
      if (messagesMode && !this.budgetTrimDisabled && this.windowTokens && this.windowTokens > 0) {
        this.enforceMessagesBudget(this.windowTokens * 0.7);
      }

      // M2-5：模型调用包裹 overflow 捕获——context_overflow 时通知外层、
      // 强制截断 history 后重试本步（每任务 ≤1 次）；仍失败原样抛出
      // → chaser 落 error 终态（0.7.4 语义不变）。
      let rawOrObj: any;
      try {
        rawOrObj = messagesMode
          ? await this.modelClient.chat(this.messages, {
              ...(Array.isArray(toolSchemas) && toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
              signal: this.signal,
            })
          : await this.modelClient.complete(prompt, {
              ...(Array.isArray(toolSchemas) && toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
              signal: this.signal,
            });
      } catch (e: any) {
        if (classifyApiError(e) === 'context_overflow') {
          if (!this.overflowNotified) {
            this.overflowNotified = true;
            try { await this.onContextOverflow?.({ error: e }); } catch { /* 通知失败不阻断 loop */ }
          }
          // 压缩前提：至少 3 步历史（裁中段才有实际消减）；防循环：每任务 1 次。
          if (!this.overflowRetryUsed && this.steps.length >= 3) {
            this.overflowRetryUsed = true;
            this.forcedCompactApplied = true;
            this.pendingOverflowNotice = true;
            // A5：messages 模式的实际裁剪在这里——旧实现只置 flag 就重试，
            // 而 forcedCompactApplied 只作用于文本路径的 buildHistoryPrompt，
            // messages 栈原样重发必然再次溢出（修：重试必败）。C1：迭代收缩。
            if (messagesMode) {
              if (this.windowTokens && this.windowTokens > 0) this.enforceMessagesBudget(this.windowTokens * 0.7);
              else this.trimMessages();
            }
            stepNum--; // 重试本步（不消耗新步数）
            continue;
          }
        }
        throw e;
      }

      // 中止检查不在 complete 返回后立即做：解析是纯本地操作，先做它才能
      // 保全"已流出正文 + 已解析 toolCalls"的现场（见下方 aborted 分支）。

      // Normalize
      let rawContent: string;
      let preParsedToolCalls: ToolCall[] | null = null;
      let detectedFormat: ToolCallFormat | undefined;

      if (typeof rawOrObj === 'string') {
        rawContent = rawOrObj;
      } else if (rawOrObj && typeof rawOrObj === 'object') {
        rawContent = rawOrObj.content ?? rawOrObj.raw ?? '';
        preParsedToolCalls = rawOrObj.toolCalls ?? null;
        detectedFormat = rawOrObj.detectedFormat;
      } else {
        rawContent = '';
      }

      const reasoning = StructuredReasoner.parseReasoning(rawContent);
      // 网关侧推理剥离（MiniMax-M3/Qwen3/DeepSeek-R1 系把 <think> 内嵌 content）：
      // 展示与历史回灌前必须剥掉推理原文，否则用户整段看到模型内心独白。
      rawContent = StructuredReasoner.stripThinkTags(rawContent);

      // 解析工具调用：恒走三路自适应（JSON/文本/XML 容错探测）——
      // StrictStructuredToolAdapter 的 <> 严格独占解析路径已归档，
      // strictStructured 仅影响 XML 探测深度，不再独占解析路径。
      let toolCalls: ToolCall[] = preParsedToolCalls ?? [];

      if (toolCalls.length === 0) {
        const res = this.universalAdapter.parse(rawContent, {
          strictStructured: this.strictStructured,
          tolerant: true,
        });
        toolCalls = res.toolCalls;
        detectedFormat = res.detectedFormat ?? detectedFormat;
      }

      // 诊断转储（PANSHA_DEBUG_STEPS=1）：每步原始输出/解析结果/意图引导状态
      // 落 stderr——弱模型工具配合度调优的可观测性基建。
      if (process.env.PANSHA_DEBUG_STEPS === '1') {
        process.stderr.write(`[dbg] step=${stepNum} fmt=${detectedFormat} calls=${toolCalls.length}`
          + ` noToolStreak=${this.consecutiveNoToolCalls}`
          + ` raw=${JSON.stringify(String(rawContent ?? '').slice(0, 300))}\n`);
        for (const c of toolCalls) {
          process.stderr.write(`[dbg]   -> ${c.toolName} ${JSON.stringify(c.params).slice(0, 200)}\n`);
        }
      }

      // 0.8 P2：本步模型输出挂入 messages 栈（assistant：文本部分 + wire tool_calls）。
      // 原生 FC（带 toolSchemas）下 assistant 携带 wire 形状 tool_calls（id 与后续
      // tool 消息配对）；文本协议（无 toolSchemas）不携带，tool 结果经 toWireMessages
      // 降级为 user 消息标注。
      let wireCalls: unknown[] | null = null;
      if (messagesMode) {
        const native = Array.isArray(toolSchemas) && toolSchemas.length > 0;
        wireCalls = native && toolCalls.length > 0 ? this.buildWireToolCalls(toolCalls) : null;
        const assistantMsg: ChatMessage = { role: 'assistant', content: this.stripToolBlocks(rawContent, toolCalls) };
        if (wireCalls) assistantMsg.toolCalls = wireCalls;
        this.messages.push(assistantMsg);
      }

      // 中断现场落盘：中止检查移到解析之后——abort 不再丢现场：
      //   - 本步已流出正文（剥离结构块）作为 partialText 随轨迹带回宿主；
      //   - 本步已解析的 toolCalls 补合成失败结果（call/result 成对进历史，
      //     "aborted before dispatch"）；
      //   - 不执行任何工具，随后以 stopReason='aborted' 终局。
      if (this.signal?.aborted) {
        const partial = this.extractUserText(rawContent);
        if (toolCalls.length > 0) {
          const abortedResult = toolCalls
            .map((c) => `TOOL_ERROR: ABORTED aborted before dispatch: ${c.toolName}`)
            .join('\n---\n');
          this.steps.push({
            stepNumber: stepNum,
            reasoning,
            toolCalls,
            verificationResult: abortedResult,
            verificationSignal: 'FAIL',
            detectedFormat,
          });
          if (messagesMode) this.pushToolMessages(toolCalls, wireCalls, abortedResult);
        }
        if (partial) partialText = partial;
        stopReason = 'aborted';
        break;
      }

      // 确保每个工具调用都有 category（用于多任务风格纪律规则跟踪）
      for (const c of toolCalls) {
        if (!c.category) {
          c.category = inferToolCategory(c.toolName);
        }
      }

      // === 多任务风格纪律规则实时跟踪 ===
      // 高纪律模式下执行更严格的跟踪；实用模式下也做轻量统计以便提示
      if (highRigor || true) {  // 始终统计，提示和打分会按模式使用
        for (const call of toolCalls) {
          const name = (call.toolName || '').toLowerCase();
          const cat = call.category || inferToolCategory(call.toolName);
          const fp =
            call.params.find(p => ['file_path', 'path', 'file', 'filename'].includes(p.name.toLowerCase()))?.value
            || call.params[0]?.value
            || '';

          // 文件类：Read-Before-Write
          if (cat === 'file') {
            if (name.includes('read') || name === 'read_file') {
              if (fp) this.filesReadThisTrajectory.add(fp);
            }
            if (name.includes('write') || name.includes('edit') || name === 'write_file') {
              if (fp) this.filesWrittenThisTrajectory.add(fp);
              if (fp && !this.filesReadThisTrajectory.has(fp)) {
                this.readBeforeWriteViolations++;
              }
            }
          }

          // 终端类（Terminal 风格核心）：关键命令后是否检查
          if (cat === 'terminal') {
            this.terminalCommandsExecuted++;
            // 简单启发：如果当前调用本身看起来像 check 类命令，则不算违规
            //（检查对象是调用原文；尾部空格维持旧占位拼接的匹配语义）
            const looksLikeCheck = /check|stat|verify|cat |ls |echo |head |tail |grep |ps |netstat|ss |df |du |exit code|stdout/i.test(
              (call.rawBlock || '') + ' '
            );
            if (!looksLikeCheck && this.stepsSinceLastRealVerification >= 1) {
              this.terminalNoCheckViolations++;
            }
          }

          // 自动化类（Automation 风格）：步骤后是否验证效果
          if (cat === 'automation') {
            // 认为 Call/Execute/Transform 是"动作"，Check/Verify/Status 是"验证"
            const isAction = /call|execute|transform|send|create|update|delete|post|trigger|action/i.test(name);
            const isCheck = /check|verify|status|effect/i.test(name);
            if (isAction && !isCheck) {
              // 后续会通过验证结果判断是否跟进检查，这里先做占位统计
              this.automationStepsWithoutEffectCheck++;
            }
            if (isCheck) {
              // 看到检查动作，减少未验证计数（简单模型）
              if (this.automationStepsWithoutEffectCheck > 0) this.automationStepsWithoutEffectCheck--;
            }
          }
        }
      }

      let verificationResult = '';
      let signal: VerificationSignal = 'NO_TOOL_CALLS';
      let didRealVerificationThisStep = false;

      if (toolCalls.length > 0) {
        // M2-2 卡死检测硬闸：执行前 before_call 检查（工具调用解析后、
        // verificationEngine.execute 前）。阻断时本步不执行工具，reason 作为
        // 工具结果文本回灌 history（模型可见提示）；halt 级直接置 done +
        // stopReason='consecutive-failures'（复用现有终态，不加新枚举）。
        // 与 maxConsecutiveFailures 并行：阻断步 signal=FAIL，仍计入连败保护。
        const guardrailDecision = this.guardrails.beforeCall(toolCalls);
        if (guardrailDecision.blocked) {
          verificationResult = guardrailDecision.reason ?? 'TOOL_ERROR: GUARDRAIL_BLOCKED';
          signal = 'FAIL';
          if (guardrailDecision.halt) {
            stopReason = 'consecutive-failures';
            done = true;
          }
          this.stepsSinceLastRealVerification++;
          if (messagesMode) this.pushToolMessages(toolCalls, wireCalls, verificationResult);
        } else {
          verificationResult = await this.verificationEngine.execute(toolCalls);
          signal = this.classifySignal(verificationResult);
          if (messagesMode) this.pushToolMessages(toolCalls, wireCalls, verificationResult);

          // T4：工具调用恢复 → 连续空转计数清零（loop 字段与 guardrails 同步）。
          if (this.consecutiveNoToolCalls > 0) this.consecutiveNoToolCalls = 0;
          this.guardrails.resetNoToolCalls();

          // 0.8.1 UX：只读拒绝快速通道——execute 返回 DENIED_READONLY 时逐 call
          // 记入专用计数（下一步 beforeCall 以阈值 2 阻断并注入强指引）。
          // readonly 语义确定、重试无意义，比一般失败硬闸（5/8）更早止损。
          for (const call of toolCalls) {
            this.guardrails.recordDenied(call.toolName, verificationResult);
          }

          // M2-2：execute 后逐 call 喂结果。failed 复用 loop 分段信号语义
          // （classifySignal 已排除只读正文偶含 FAIL/ERROR 字样的误判）。
          const guardrailFailed = signal === 'FAIL' || signal === 'ERROR';
          for (const call of toolCalls) {
            this.guardrails.recordResult(call, verificationResult, guardrailFailed);
          }

          const lower = verificationResult.toLowerCase();
        // 真实执行引擎的成功 bash 结果以 `EXIT_CODE:0` 结尾——最强真实验证信号。
        // 下方的 PASS 启发式作为补充信号。
        // `verification:` 松匹配收紧为 `verification: pass`——
        // 否则 engineAdapter 给 read/glob/grep 追加的 `VERIFICATION: NEUTRAL` 会被
        // 误计为真实验证（NEUTRAL=PARTIAL：清零连败但不计 PASS/不触发 completed）。
        // T6 假验证收紧：裸 EXIT_CODE:0 判真实验证需【验证特征词】（test/check/
        // verify/diff/grep/lint——真实引擎输出常含命令 stdout）或【VERIFICATION/
        // PASS 标记】（engineAdapter 对 ok bash 确定性追加 VERIFICATION: PASS，
        // 真实引擎路径不受影响）——防 `echo`/跑错命令刷真实验证计数。
        const verificationFeature = /(test|check|verify|diff|grep|lint)/.test(lower);
        const verificationMarker = lower.includes('verification:') || lower.includes('pass');
        const looksLikeRealPass =
          (lower.includes('exit_code:0') && (verificationFeature || verificationMarker)) ||
          lower.includes('all_tests_passed') ||
          lower.includes('verification: pass');

          if (looksLikeRealPass) {
            didRealVerificationThisStep = true;
            this.hasPerformedRealVerification = true;
            this.stepsSinceLastRealVerification = 0;
            this.verificationAttempts++;
          } else {
            this.stepsSinceLastRealVerification++;
          }
        }
      } else {
        // 2026-09-16：空转步 verificationResult 不再填充 'NO_TOOL_CALLS' 字面——
        // 该字面经轨迹映射（result: s.verificationResult）喂给模型导致 1B/M3
        // 双学舌。用户正文走 idleAnswerText（step.result）；内部信号仅存
        // verificationSignal（guardrails 计数/测试消费）。
        verificationResult = '';
        signal = 'NO_TOOL_CALLS';
        this.stepsSinceLastRealVerification++;
        // 2026-09-16：空转 answered 的用户正文暂存（step.result）——runAgentTask
        // 的 answerText 提取读 trajSteps[last].result，此前该字段恒空 →
        // "已回复"但三端都看不到回复内容（真机实证）。
        idleAnswerText = !!(rawOrObj as any)?.truncated
          ? undefined
          : (this.extractUserText(rawContent) || undefined);
        // T4：连续空转计数喂 guardrails（格式停滞信号：只计数上报，不设硬闸——
        // maxSteps 已兜底）；工具调用恢复时清零（见上方 toolCalls>0 分支）。
        this.consecutiveNoToolCalls++;
        this.guardrails.recordNoToolCalls();
        // end_turn——模型不再调用工具即自然停（闲聊/纯回答 1 步即停）。
        // 区分 answered（有面向用户正文答复）与 no-verification（空白/空转）。
        //
        // finish_reason=length 截断的响应【禁判 answered】——残缺
        // 内容不可作为完成，注入提示重试一步（消费型旗标，上一步 prompt 组装处
        // 消费；maxSteps 兜底防无限循环）。
        // 2026-09-16 语义摘除（控制人裁决）：空转步不再走 T4 三级 nudge 阶梯、
        // 不再强制 no-verification 假失败——有正文即 answered（success 语义见
        // 末尾 T6 简化式）。历史依据：只读任务（"看下工作区"）模型读完输出总结
        // 是正确完成，旧阶梯把它误判空转假失败（真机 M3 Step 8 实证）；且
        // nudge 逼出的工具调用是噪音动作。空转无正文仍记 no-verification。
        const hasText = this.hasUserFacingText(rawContent);
        const truncatedResponse = !!(rawOrObj as any)?.truncated;
        if (truncatedResponse) {
          this.pendingTruncationNotice = true;
          // done 保持 false——截断响应继续下一步
        } else {
          done = true;
          stopReason = hasText ? 'answered' : 'no-verification';
        }
      }

      const step: LoopStep = {
        stepNumber: stepNum,
        reasoning,
        toolCalls,
        verificationResult,
        verificationSignal: signal,
        detectedFormat,
        didRealVerification: didRealVerificationThisStep,
        readBeforeWriteViolation: this.readBeforeWriteViolations > 0,
        ...(idleAnswerText ? { result: idleAnswerText } : {}),
      };

      this.steps.push(step);

      // 失败保护（高纪律模式更宽松，允许更多探索）
      if (signal === 'FAIL' || signal === 'ERROR') {
        this.consecutiveFailures++;
        stopReason = 'consecutive-failures';
      } else {
        this.consecutiveFailures = 0;
      }

      // 接口契约 v3.1：PASS 降级为 evidence——记录信号并计入 trajectory.success
      // （run() 末尾统一计算），但不再直接终止循环；终止由 end_turn /
      // consecutive-failures / max-steps 决定。
      if (signal === 'PASS' || this.isPassTail(verificationResult)) {
        this.hasPerformedRealVerification = true;
      }

      const failureLimit = highRigor ? this.maxConsecutiveFailures + 2 : this.maxConsecutiveFailures;
      if (this.consecutiveFailures >= failureLimit) {
        done = true;
      }
    }

    if (!stopReason) stopReason = 'max-steps';
    if (stopReason === 'no-verification' || stopReason === 'answered') {
      const hasPass = this.steps.some(
        s => s.verificationSignal === 'PASS' || this.isPassTail(s.verificationResult)
      );
      if (hasPass) stopReason = 'completed';
    }

    // 结束时把整条轨迹喂给记忆（FailureMemory 轨道已摘除，收敛到
    // RefinedMemoryStore.refine 的任务落定提炼——见 MEMORY-DESIGN §7.1）

    // T6 success 语义摘除（2026-09-16 控制人裁决）：'answered' 一律计 success——
    // 旧"execution 意图 + 全程零工具调用时 answered 不计 success"的假成功防线
    // 连带 T4 nudge 阶梯一并摘除（只读任务的合理总结被误判假失败，真机 M3
    // Step 8 实证）。PASS/completed 仍由真实验证驱动，语义不变。
    const success = this.steps.some(
      s => s.verificationSignal === 'PASS' || this.isPassTail(s.verificationResult)
    ) || stopReason === 'answered';
    // aborted 时携带本步已流出正文，供宿主落 turn（partialText）
    return { success, steps: this.steps, stopReason, partialText, contextOverflowCompacted: this.overflowRetryUsed };
  }

  /** 剥离结构化块与工具块，返回面向用户的正文（aborted 部分结果提取用）。 */
  private extractUserText(rawContent: string): string {
    return String(rawContent ?? '')
      .replace(/<(thinking|plan|verify|critique|format_check|iron_law_check)>[\s\S]*?<\/\1>/gi, '')
      .replace(/<>[\s\S]*?<\/>/gi, '')
      .trim();
  }

  /** 剥离结构化块与工具块后，是否仍有面向用户的正文（决定 end_turn → answered vs no-verification）。 */
  private hasUserFacingText(rawContent: string): boolean {
    return this.extractUserText(rawContent).length > 0;
  }

  /**
   * PASS 类尾标的分段尾锚定判定（classifySignal 与 run() 终局统计共用）：
   * 任一 '\n---\n' 分段以一行 ALL_TESTS_PASSED（容忍 VERIFICATION: 前缀与
   * 尾随空白）或 VERIFICATION: PASS 结束才算——【P2 修复】旧的全文
   * includes('ALL_TESTS_PASSED') 读到含该字面量的文件正文即假"验证通过"。
   */
  private isPassTail(result: string): boolean {
    const segments = String(result ?? '').split('\n---\n');
    return segments.some((s) =>
      /(?:^|\n)[ \t]*(?:VERIFICATION:[ \t]*)?ALL_TESTS_PASSED\s*$/.test(s)
      || /(?:^|\n)VERIFICATION: PASS\s*$/.test(s));
  }

  private classifySignal(result: string): VerificationSignal {
    // 真实引擎成功信号入册。
    // 顺序契约：
    //   1) 显式 PASS 尾标（smoke mock + engineAdapter 对 bash 的确定性追加）
    //   2) APPLIED 尾标（write/edit——写入成功 ≠ 验证通过 → PARTIAL）
    //   3) NEUTRAL 尾标（read/glob/grep——只读成功，无验证效力）→ PARTIAL，
    //      必须排在 FAIL/ERROR 子句之前（只读输出正文可能偶然含 "error" 字样）
    //   4) FAIL/ERROR
    //   5) 裸 `EXIT_CODE:0`：尾部锚定 `/\nEXIT_CODE:0\s*$/`（防正文内嵌字面量误判），
    //      排在 FAIL 检查之后（真 bash 成功尾行优先级低于显式失败信号）
    // 尾标判定用**分段尾锚定**（parts 以 '---' 连接，每段末尾各有自己的尾标）：
    // 全文 includes 会把 read/grep 正文里的字面量误判成信号（本仓库源码即触发器）。
    // 多调用步骤一成一败仍判 PASS：PASS 段存在即过（可接受粒度，测试已注明）。
    const segments = result.split('\n---\n');
    const segEndsWith = (re: RegExp) => segments.some((s) => re.test(s));
    if (this.isPassTail(result)) return 'PASS';
    if (segEndsWith(/\nVERIFICATION: APPLIED\s*$/) || segEndsWith(/\nVERIFICATION: NEUTRAL\s*$/) || result.includes('PARTIAL')) return 'PARTIAL';
    if (result.includes('FAIL') || result.includes('ERROR')) return 'FAIL';
    if (/\nEXIT_CODE:0\s*$/.test(result)) return 'PASS';
    return 'FAIL';
  }

  private buildHistoryPrompt(): string {
    const isPractical = this.practicalMode;
    // 保留 <plan> 和 <verify> 的完整结构（长上下文利用）：
    // 按 tier + practical 给出合理上限，但确保结构化块完整
    const planLimit = isPractical ? 200 : 300;
    const thinkLimit = isPractical ? 200 : 300;
    // 结果截断改"超阈值才剪"——≤4000 字符原样保留（read_file 输出
    // 常超旧上限 200-300，静默剪掉会让模型误以为文件不完整）；超限保留
    // 头 2500 + 尾 800 + 显式修剪标记。
    const RESULT_LIMIT = 4000;
    const RESULT_HEAD = 2500;
    const RESULT_TAIL = 800;

    const parts = this.steps
      .map(s => {
        const flags: string[] = [];
        if (s.didRealVerification) flags.push('VERIFIED');
        if (s.readBeforeWriteViolation) flags.push('RBW');
        const iron = flags.length ? flags.join('+') : (isPractical ? '' : 'ok');
        // 2026-09-16 真机缺陷：内部信号词 NO_TOOL_CALLS 被原样渲染进历史
        // （"Step N [NO_TOOL_CALLS] / Result: NO_TOOL_CALLS"），1B 与 M3
        // 双双学舌成正文输出（终局 answerText='NO_TOOL_CALLS'）。历史渲染
        // 改用模型友好的本地化文案——信号是给引擎看的，不是给模型的。
        const signalLabel = s.verificationSignal === 'NO_TOOL_CALLS' ? '无工具调用' : s.verificationSignal;

        // 保留 plan / verify 的核心结构（不被激进截断）
        const plan = safeSlice(s.reasoning.plan || '', 0, planLimit);
        const verify = safeSlice(s.reasoning.verify || '', 0, planLimit);
        const fullResult = s.verificationResult === 'NO_TOOL_CALLS'
          ? '（本步未调用任何工具）'
          : (s.verificationResult || '');
        let resultText = fullResult;
        let resultTruncated = false;
        if (fullResult.length > RESULT_LIMIT) {
          const trimmed = fullResult.length - RESULT_HEAD - RESULT_TAIL;
          resultText = safeSlice(fullResult, 0, RESULT_HEAD)
            + `\n[...已修剪 ${trimmed} 字符...]`
            + (RESULT_TAIL > 0 ? safeSlice(fullResult, -RESULT_TAIL) : '');
          resultTruncated = true;
        }
        // 截断结果必须告知模型——且明确保留了头尾，模型可据此判断是否需要重读。
        const resultNote = resultTruncated
          ? `\n[⚠ 上一轮结果过长已修剪中段（保留头 ${RESULT_HEAD} + 尾 ${RESULT_TAIL} 字符）。若需要完整内容（尤其 read_file 输出），请用 read_file 重新读取目标文件（输出中会给出 offset 续读位置）。]`
          : '';
        const thinking = safeSlice(s.reasoning.thinking || '', 0, thinkLimit);

        // 包含完整的结构化块（plan + verify + result）便于长链推理
        const base = `Step ${s.stepNumber} [${signalLabel}]${iron ? ' ['+iron+']' : ''}:
Thinking: ${thinking}
Plan: ${plan}
Verify: ${verify}
Result: ${resultText}${resultNote}`;

        return isPractical ? base : base + `\nFormat: ${s.detectedFormat ?? 'unknown'}`;
      });

    const join = (arr: string[]) => arr.join('\n---\n');

    // M2-5 溢出应急档：context_overflow 触发后，本任务余下所有 history 组装
    // 无条件截断中段（保首 1 + 末 1 步 + 显式折叠标记）。注意这是确定性截断
    // 不是摘要压缩——中段内容不进任何摘要，长期信号靠 TaskState/记忆卡兜底。
    // flag 任务生命周期内保持。
    if (this.forcedCompactApplied && parts.length > 2) {
      const kept = [
        parts[0],
        `[...${parts.length - 2} 步历史已截断（context_overflow 溢出应急，仅保留首尾步骤）...]`,
        parts[parts.length - 1],
      ];
      return join(kept);
    }

    // 窗口预算——组装后若超窗口 70%，先做单步封顶，再迭代裁中段。
    // 裁剪后复查（A4）：旧实现切一刀就返回，保下的首尾步本身可超预算，
    // 重试仍溢出；这里循环收缩直到满足预算或只剩首尾步。
    //（windowTokens 未提供时保持旧行为，不裁；PANSHA_NO_BUDGET_TRIM=1
    // 评测逃生门禁用主动裁剪，溢出应急档不受影响。）
    if (this.windowTokens && this.windowTokens > 0 && !this.budgetTrimDisabled) {
      const budgetTokens = this.windowTokens * 0.7;
      const capped = parts.map((p) => this.capStepPart(p, budgetTokens));
      if (capped.length <= 2 || estTokens(join(capped)) <= budgetTokens) return join(capped);

      // 迭代裁中段：前 2 + 后 2 起步，仍超预算则继续收缩（最少各保 1 步；
      // 先收前段——旧步骤信息密度低于最新现场）。
      let head = Math.min(2, Math.floor((capped.length - 1) / 2));
      let tail = Math.min(2, capped.length - 1 - head);
      for (;;) {
        const dropped = capped.length - head - tail;
        const mid = dropped > 0 ? [`[...${dropped} 步已截断（上下文窗口预算）...]`] : [];
        const text = join([...capped.slice(0, head), ...mid, ...capped.slice(capped.length - tail)]);
        if (estTokens(text) <= budgetTokens) return text;
        if (head <= 1 && tail <= 1) return text; // 首尾仍超预算：到此为止，交溢出应急档
        if (head > 1) head--; else tail--;
      }
    }
    return join(parts);
  }

  /**
   * A4 单步封顶：一步 >20% 历史预算时保留头 60% + 尾 25%，中段换显式标记。
   * 防单步巨量输出（read_file 大文件 / 冗长 bash 日志）把预算吃穿——
   * 旧实现只切步数不切步内容，4 个巨步照样超窗。
   */
  private capStepPart(part: string, budgetTokens: number): string {
    const perStep = budgetTokens * 0.2;
    if (estTokens(part) <= perStep) return part;
    const head = sliceToTokenBudget(part, perStep * 0.6, true);
    const tail = sliceToTokenBudget(part, perStep * 0.25, false);
    return head
      + '\n[...本步内容过长已截断（单步窗口预算）；如需完整输出（尤其 read_file 结果），请重新读取目标文件...]'
      + tail;
  }

  /**
   * Expose current Iron Law compliance state + multi-task-style signals.
   * Used by orchestrator / chaser for scoring and dynamic prompt injection.
   */
  getIronLawStatus() {
    return {
      filesRead: this.filesReadThisTrajectory.size,
      filesWritten: this.filesWrittenThisTrajectory.size,
      rbwViolations: this.readBeforeWriteViolations,
      verifiedCount: this.verificationAttempts,
      stepsSinceLastVerification: this.stepsSinceLastRealVerification,
      hasPerformedRealVerification: this.hasPerformedRealVerification,
      // 多任务风格扩展信号（benchmarkType 为旧别名，向下兼容）
      taskStyle: this.taskStyle ?? this.benchmarkType,
      benchmarkType: this.profile.type,
      terminalCommands: this.terminalCommandsExecuted,
      terminalNoCheckViolations: this.terminalNoCheckViolations,
      automationStepsWithoutEffectCheck: this.automationStepsWithoutEffectCheck,
      // T4：连续 NO_TOOL_CALLS 步数（格式停滞信号，只计数上报——maxSteps 兜底）
      consecutiveNoToolCalls: this.consecutiveNoToolCalls,
    };
  }
}

