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
import { StrictStructuredToolAdapter } from '../adapter/StrictStructuredToolAdapter.js';
import { UniversalToolCallAdapter, ToolCallFormat } from '../adapter/UniversalToolCallAdapter.js';
import { ToolCall, inferToolCategory } from '../types/toolCall.js';
import { BenchmarkProfiles, BenchmarkType } from '../benchmarks/BenchmarkProfiles.js';
import { TierConfig, TierRegistry, DEFAULT_TIER, CritiqueFrequencySpec, IronLawInjectionLevel, Tier } from '../tiers/TierConfig.js';
import { classifyApiError } from '../model/errorClassify.js';
import type { StaticAnalysisResult } from '../review/Reviewer.js';
import type { TurnStopReason } from '../cli/repl/types.js';

/**
 * Critique 构造上下文
 * 用于在 critique prompt 构建阶段按指定顺序注入结构化块。
 */
export interface CritiqueContext {
  staticAnalysisBlocks?: string[];
}

export type VerificationSignal = 'PASS' | 'FAIL' | 'PARTIAL' | 'ERROR' | 'NO_TOOL_CALLS';

export interface LoopStep {
  stepNumber: number;
  reasoning: StructuredReasoningOutput;
  toolCalls: ToolCall[];
  verificationResult: string;
  verificationSignal: VerificationSignal;
  critique?: string;
  detectedFormat?: ToolCallFormat;
  didRealVerification?: boolean;
  readBeforeWriteViolation?: boolean;
  /** 多任务风格每步信号 */
  terminalNoCheck?: boolean;
  automationNoEffectCheck?: boolean;
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
  /** 任务风格别名，等同于 taskStyle。 */
  benchmarkType?: BenchmarkType | string;
  /** 是否高纪律模式，等同于 !practicalMode 的高纪律路径。 */
  isStrongMode?: boolean;
  /** 【休眠】critique 机制已摘除（archive/2026-09-05-removals/），字段仅为兼容保留、运行期忽略 */
  critiqueFrequency?: CritiqueFrequencySpec;
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
   * （token 估算 chars/4）→ 裁 history 中段（保前 2 步 + 后 2 步）。
   */
  windowTokens?: number;

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
  private isStrongMode?: boolean;
  private signal?: AbortSignal;
  private profile = BenchmarkProfiles.get('swe');
  // critique 频率 / 纪律规则注入强度 / tier 名称
  private critiqueFrequency?: CritiqueFrequencySpec;
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
    this.maxSteps = options.maxSteps ?? 25;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.verifyFirstBias = options.verifyFirstBias ?? this.strictStructured;
    // 高纪律模式判定（behavioral）：优先 isStrongMode，其次 !practicalMode，再次 strictStructured
    const explicitStrong = options.isStrongMode;
    const explicitPractical = options.practicalMode;
    this.isStrongMode = explicitStrong ?? (explicitPractical === undefined ? this.strictStructured : !explicitPractical);
    this.practicalMode = explicitPractical ?? !this.isStrongMode;
    // 任务风格：优先 taskStyle，其次 benchmarkType（别名）
    this.taskStyle = options.taskStyle ?? (options.benchmarkType as string | undefined);
    this.benchmarkType = options.benchmarkType ?? this.taskStyle;
    this.profile = BenchmarkProfiles.get(this.taskStyle ?? this.benchmarkType);
    // 接收 critique 频率、纪律规则注入强度、tier 名称
    this.critiqueFrequency = options.critiqueFrequency;
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
  /** 格式提醒已注入过（防呆只重试一步）。 */
  private formatNudgeUsed = false;
  /** 下一步 prompt 注入格式提醒。 */
  private pendingFormatNudge = false;
  /** 上下文窗口预算（tokens）。>0 时 buildHistoryPrompt 超 70% 裁中段。 */
  private windowTokens?: number;

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
      const names = this.verificationEngine?.executor?.availableTools?.();
      return Array.isArray(names) && names.length > 0 ? names.map(String) : undefined;
    } catch {
      return undefined;
    }
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

    while (!done && stepNum < this.maxSteps) {
      if (this.signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      stepNum++;

      const history = this.buildHistoryPrompt();
      let prompt = `${initialPrompt}\n\n[历史执行记录]\n${history}`;

      // 截断续跑提示——上一步响应被 max_tokens 截断时，注入一次性
      // 提醒（消费型旗标，不是新状态机）。
      if (this.pendingTruncationNotice) {
        this.pendingTruncationNotice = false;
        prompt += '\n\n【上一条响应被 max_tokens 截断，请精简后继续】如需调用工具请保持调用块完整；如为答复请精简内容后输出。';
      }
      // M2-5 overflow 强制压缩提示——重试本步时注入一次性提醒（消费型旗标）。
      if (this.pendingOverflowNotice) {
        this.pendingOverflowNotice = false;
        prompt += '\n\n【上下文长度已超限——历史已强制压缩（仅保留首尾步骤）。请精简输出继续当前任务；如需背景信息请用 read_file/glob 重新获取，不要复述历史。】';
      }
      // answered 空转防呆——execution 意图下"只说话不动作"的第一次，
      // 注入一次格式提醒重试一步（消费型旗标）。
      if (this.pendingFormatNudge) {
        this.pendingFormatNudge = false;
        prompt += '\n\n' + StructuredReasoner.buildToolCallFormatEnforcementPrompt(this.availableToolNames())
          + '\n【重要】上一步你只输出了文字说明而没有输出任何工具调用块。当前是执行类任务：请立即输出一个工具调用块开始实际操作（如 read_file / bash / write_file），不要只描述计划。';
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
          prompt += `\n\n${StructuredReasoner.buildToolCallFormatEnforcementPrompt(this.availableToolNames())}`;
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
          prompt += `\n\n${StructuredReasoner.buildToolCallFormatEnforcementPrompt(this.availableToolNames())}`;
        }
        if (this.readBeforeWriteViolations > 0) {
          prompt += `\n\n【小提醒】最近有在未读取文件的情况下直接修改文件的倾向，建议先读取再修改。`;
        }
        if (this.stepsSinceLastRealVerification >= 3) {
          prompt += `\n\n【小提醒】已经连续几步没有明显验证，建议适当确认修改效果。`;
        }
      }

      // P1.1 请求侧：真实引擎带 toolSchemas() 时走原生 function calling；
      // mock/旧引擎没有该方法 → 不带 tools，维持文本协议路径（测试兼容）。
      const toolSchemas = typeof this.verificationEngine?.toolSchemas === 'function'
        ? this.verificationEngine.toolSchemas()
        : undefined;

      // M2-5：模型调用包裹 overflow 捕获——context_overflow 时通知外层、
      // 强制压缩 history 后重试本步（每任务 ≤1 次）；仍失败原样抛出
      // → chaser 落 error 终态（0.7.4 语义不变）。
      let rawOrObj: any;
      try {
        rawOrObj = await this.modelClient.complete(prompt, {
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

      // 解析工具调用（严格结构化模式走 StrictStructuredToolAdapter）
      let toolCalls: ToolCall[] = preParsedToolCalls ?? [];

      if (toolCalls.length === 0) {
        // 三路自适应解析（OpenAI JSON / 文本 / <> XML），恒容错；
        // strictStructured 仅影响 XML 探测深度，不再独占解析路径。
        const res = this.universalAdapter.parse(rawContent, {
          strictStructured: this.strictStructured,
          tolerant: true,
        });
        toolCalls = res.toolCalls;
        detectedFormat = res.detectedFormat ?? detectedFormat;
      }

      // 中断现场落盘：中止检查移到解析之后——abort 不再丢现场：
      //   - 本步已流出正文（剥离结构块）作为 partialText 随轨迹带回宿主；
      //   - 本步已解析的 toolCalls 补合成失败结果（call/result 成对进历史，
      //     "aborted before dispatch"）；
      //   - 不执行任何工具，随后以 stopReason='aborted' 终局。
      if (this.signal?.aborted) {
        const partial = this.extractUserText(rawContent);
        if (toolCalls.length > 0) {
          this.steps.push({
            stepNumber: stepNum,
            reasoning,
            toolCalls,
            verificationResult: toolCalls
              .map((c) => `TOOL_ERROR: ABORTED aborted before dispatch: ${c.toolName}`)
              .join('\n---\n'),
            verificationSignal: 'FAIL',
            detectedFormat,
          });
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
      // 注意：verificationResult 在此处尚未声明，必须使用局部占位以避免 TDZ 崩溃
      const pendingVerificationResult = ''; // 本步执行前的验证结果占位（执行后会被覆盖）
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
            const looksLikeCheck = /check|stat|verify|cat |ls |echo |head |tail |grep |ps |netstat|ss |df |du |exit code|stdout/i.test(
              (call.rawBlock || '') + ' ' + (pendingVerificationResult || '')
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
        } else {
          verificationResult = await this.verificationEngine.execute(toolCalls);
          signal = this.classifySignal(verificationResult);

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
        const looksLikeRealPass =
          lower.includes('exit_code:0') ||
          lower.includes('all_tests_passed') ||
          lower.includes('verification: pass') ||
          (lower.includes('pass') && lower.includes('5')) || // 针对我们的加法例子
          lower.includes('正确') && (lower.includes('5') || lower.includes('pass'));

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
        verificationResult = 'NO_TOOL_CALLS';
        signal = 'NO_TOOL_CALLS';
        this.stepsSinceLastRealVerification++;
        // end_turn——模型不再调用工具即自然停（闲聊/纯回答 1 步即停）。
        // 区分 answered（有面向用户正文答复）与 no-verification（空白/空转）。
        //
        // finish_reason=length 截断的响应【禁判 answered】——残缺
        // 内容不可作为完成，注入提示重试一步（消费型旗标，上一步 prompt 组装处
        // 消费；maxSteps 兜底防无限循环）。
        // answered 空转防呆——execution 意图（isStrongMode 或
        // taskStyle==='execution'）且从未做过真实验证时，"有正文却只说话不动手"
        // 的第一次不终局，注入格式提醒重试一步；第二次仍无动作按 no-verification
        // 终局（不计 success）。仅用消费型布尔旗标实现，不引入新状态机。
        const hasText = this.hasUserFacingText(rawContent);
        const truncatedResponse = !!(rawOrObj as any)?.truncated;
        const executionIntent = !!this.isStrongMode
          || String(this.taskStyle ?? this.benchmarkType ?? '') === 'execution';
        if (truncatedResponse) {
          this.pendingTruncationNotice = true;
          // done 保持 false——截断响应继续下一步
        } else if (executionIntent && !this.hasPerformedRealVerification && hasText && !this.formatNudgeUsed) {
          this.formatNudgeUsed = true;
          this.pendingFormatNudge = true;
          // done 保持 false——注入格式提醒后重试一步
        } else if (executionIntent && !this.hasPerformedRealVerification) {
          // 含"第二次文本空转"：不再按 answered 计成功（有正文即假完成）
          done = true;
          stopReason = 'no-verification';
        } else {
          done = true;
          stopReason = hasText ? 'answered' : 'no-verification';
        }
      }

      // critique 自我批判已摘除（archive/2026-09-05-removals/）——
      // 每次触发是一次额外完整模型调用，且打分器归档后其打分激励不复存在。
      // LoopStep.critique 恒 undefined；buildCritiquePrompt/上下文装配保留为休眠代码。
      const critique: string | undefined = undefined;

      const step: LoopStep = {
        stepNumber: stepNum,
        reasoning,
        toolCalls,
        verificationResult,
        verificationSignal: signal,
        critique,
        detectedFormat,
        didRealVerification: didRealVerificationThisStep,
        readBeforeWriteViolation: this.readBeforeWriteViolations > 0,
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
      if (signal === 'PASS' || verificationResult.includes('ALL_TESTS_PASSED')) {
        this.hasPerformedRealVerification = true;
      }

      // critique 文本单独不能终止任务（#2：critique 已摘除，本判定为休眠保留——
      // LoopStep.critique 恒 undefined，条件永假）
      if (critique && /任务已解决|已修复|问题已解决|完全正确|验证通过/i.test(critique)) {
        // 必须本步有真实验证（PASS 信号或 ALL_TESTS_PASSED）才允许终止
        if (signal === 'PASS' || verificationResult.includes('ALL_TESTS_PASSED') || didRealVerificationThisStep) {
          done = true;
        }
      }

      const failureLimit = highRigor ? this.maxConsecutiveFailures + 2 : this.maxConsecutiveFailures;
      if (this.consecutiveFailures >= failureLimit) {
        done = true;
      }
    }

    if (!stopReason) stopReason = 'max-steps';
    if (stopReason === 'no-verification' || stopReason === 'answered') {
      const hasPass = this.steps.some(
        s => s.verificationSignal === 'PASS' || s.verificationResult.includes('ALL_TESTS_PASSED')
      );
      if (hasPass) stopReason = 'completed';
    }

    // 结束时把整条轨迹喂给记忆（FailureMemory 轨道已摘除，收敛到
    // RefinedMemoryStore.refine 的任务落定提炼——见 MEMORY-DESIGN §7.1）

    const success = this.steps.some(
      s => s.verificationSignal === 'PASS' || s.verificationResult.includes('ALL_TESTS_PASSED')
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
    if (result.includes('ALL_TESTS_PASSED') || segEndsWith(/\nVERIFICATION: PASS\s*$/)) return 'PASS';
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
    const critiqueLimit = isPractical ? 150 : 200;
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

        // 保留 plan / verify 的核心结构（不被激进截断）
        const plan = (s.reasoning.plan || '').slice(0, planLimit);
        const verify = (s.reasoning.verify || '').slice(0, planLimit);
        const fullResult = s.verificationResult || '';
        let resultText = fullResult;
        let resultTruncated = false;
        if (fullResult.length > RESULT_LIMIT) {
          const trimmed = fullResult.length - RESULT_HEAD - RESULT_TAIL;
          resultText = fullResult.slice(0, RESULT_HEAD)
            + `\n[...已修剪 ${trimmed} 字符...]`
            + (RESULT_TAIL > 0 ? fullResult.slice(-RESULT_TAIL) : '');
          resultTruncated = true;
        }
        // 截断结果必须告知模型——且明确保留了头尾，模型可据此判断是否需要重读。
        const resultNote = resultTruncated
          ? `\n[⚠ 上一轮结果过长已修剪中段（保留头 ${RESULT_HEAD} + 尾 ${RESULT_TAIL} 字符）。若需要完整内容（尤其 read_file 输出），请用 read_file 重新读取目标文件（输出中会给出 offset 续读位置）。]`
          : '';
        const thinking = (s.reasoning.thinking || '').slice(0, thinkLimit);
        const critique = s.critique
          ? s.critique.slice(0, critiqueLimit)
          : 'N/A';

        // 包含完整的结构化块（plan + verify + result）便于长链推理
        const base = `Step ${s.stepNumber} [${s.verificationSignal}]${iron ? ' ['+iron+']' : ''}:
Thinking: ${thinking}
Plan: ${plan}
Verify: ${verify}
Result: ${resultText}${resultNote}
Critique: ${critique}`;

        return isPractical ? base : base + `\nFormat: ${s.detectedFormat ?? 'unknown'}`;
      });

    const join = (arr: string[]) => arr.join('\n---\n');

    // M2-5 强制档：context_overflow 触发后，本任务余下所有 history 组装
    // 无条件裁中段（保首 1 + 末 1 步 + 显式折叠标记），与下方窗口预算裁剪
    // （超 70% 才裁）并行——压缩是消费历史，flag 任务生命周期内保持。
    if (this.forcedCompactApplied && parts.length > 2) {
      const kept = [
        parts[0],
        `[...强制压缩：${parts.length - 2} 步历史已折叠（context_overflow 触发）...]`,
        parts[parts.length - 1],
      ];
      return join(kept);
    }

    // 窗口预算——组装后若超窗口 70%（token 估算 chars/4），
    // 裁 history 中段：保前 2 步 + 后 2 步，中段替换为显式标记
    //（windowTokens 未提供时保持旧行为，不裁）。
    if (this.windowTokens && this.windowTokens > 0 && parts.length > 4) {
      const budgetChars = this.windowTokens * 4 * 0.7;
      if (join(parts).length > budgetChars) {
        const kept = [...parts.slice(0, 2), `[...${parts.length - 4} 步已裁剪（上下文窗口预算）...]`, ...parts.slice(-2)];
        return join(kept);
      }
    }
    return join(parts);
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
    };
  }
}

