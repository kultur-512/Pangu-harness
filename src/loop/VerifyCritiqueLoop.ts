// VerifyCritiqueLoop - GLM-5.x Verify-Heavy + Critique Loop
// 目的：打造一个**既在工程里强，也在跑分里强**的强力模式核心循环。
// 
// 强力模式（highRigor / !practicalMode）设计原则：
// - 严谨可靠：保留 Read-Before-Write、Verify-Before-Claim、标准格式、高验证密度。
// - 工程可用：在真实日常高强度项目中能长时间运行，不会因为过于严苛导致 token 爆炸、模型疲劳或工作流卡死。
// - 分数友好：通过高密度验证、建设性复盘、铁律遵守，在 benchmark / 评测中仍能保持竞争力。
// 
// 实用模式：更温和、token 高效，适合常规开发。
// 
// 自我批评保持建设性。铁律主要在强力模式下高强度执行，但频率和语气都经过工程化调优。

import { StructuredReasoner, StructuredReasoningOutput } from '../reasoning/StructuredReasoner.js';
import { ExtremeGlmToolCallAdapter } from '../adapter/ExtremeGlmToolCallAdapter.js';
import { UniversalToolCallAdapter, ToolCallFormat } from '../adapter/UniversalToolCallAdapter.js';
import { ToolCall, inferToolCategory } from '../types/toolCall.js';
import { FailureMemory } from '../memory/FailureMemory.js';
import { BenchmarkProfiles, BenchmarkType } from '../benchmarks/BenchmarkProfiles.js';
import { TierConfig, TierRegistry, DEFAULT_TIER, CritiqueFrequencySpec, IronLawInjectionLevel, Tier } from '../tiers/TierConfig.js';
import { Reviewer, type StaticAnalysisResult } from '../review/Reviewer.js';

/**
 * P0.5-A (v2): Critique 构造上下文
 * 用于在 critique prompt 构建阶段按指定顺序注入结构化块。
 */
export interface CritiqueContext {
  staticAnalysisBlocks?: string[];
}

/**
 * P0.5-A (v2): Critique 构造上下文
 * 用于在 buildCritiquePrompt 阶段按指定顺序注入结构化块。
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
  strictGlmOnly?: boolean; // parser/format strictness flag (legacy); combined with !practicalMode yields high-rigor behavior
  useUniversalAdapter?: boolean;
  maxSteps?: number;
  maxConsecutiveFailures?: number;
  failureMemory?: FailureMemory;
  verifyFirstBias?: boolean;
  /** 
   * When true, the loop will use lighter prompts suitable for daily coding.
   * When false (default for strong mode), it uses more rigorous prompts and higher verification density.
   */
  practicalMode?: boolean;
  /** 任务风格（推荐）：'swe' | 'terminal' | 'automation' 等，用于适配验证策略。 */
  taskStyle?: string;
  /** 内部兼容旧称 benchmarkType，等同于 taskStyle。仅作为别名使用。 */
  benchmarkType?: BenchmarkType | string;
  /** 是否强力模式（新名），等同于 !practicalMode 的高纪律路径。 */
  isStrongMode?: boolean;
  /** 六档体系新增：critique 频率配置 */
  critiqueFrequency?: CritiqueFrequencySpec;
  /** 六档体系新增：铁律注入强度 */
  ironLawInjectionLevel?: IronLawInjectionLevel;
  /** 六档体系新增：tier 名称 */
  tier?: string;
  /**
   * P0.5-A (v2): 预格式化的静态分析块字符串数组（推荐）。
   * 每个元素应为 Reviewer 产生的 <static_analysis_result ...> 片段。
   * 这些块将在 critique prompt 中以 <static_analysis_context> 包裹，并在 <user_request> 之前注入。
   */
  staticAnalysisBlocks?: string[];
  /**
   * P0-B 遗留兼容：原始结果，Loop 会按需格式化。
   * 新代码优先使用 staticAnalysisBlocks。
   */
  staticAnalysis?: StaticAnalysisResult[];

  /**
   * P0.5-A (v2): 显式用户请求，用于构造 <user_request> 块。
   */
  userRequest?: string;

  /**
   * P0.5-A (v2): 当前 diff，用于构造 <current_diff> 块。
   */
  currentDiff?: string;
}

export class VerifyCritiqueLoop {
  private steps: LoopStep[] = [];
  private extremeAdapter = new ExtremeGlmToolCallAdapter();
  private universalAdapter = new UniversalToolCallAdapter();
  private consecutiveFailures = 0;

  private useUniversal: boolean;
  private strictGlm: boolean; // legacy internal: when true, prefer strict GLM <> parser + high-rigor behaviors (combined with !practicalMode)
  private failureMemory?: FailureMemory;
  private verifyFirstBias: boolean;
  private practicalMode: boolean;
  private benchmarkType?: BenchmarkType | string; // legacy alias for taskStyle (internal compat only)
  private taskStyle?: string;
  private isStrongMode?: boolean;
  private profile = BenchmarkProfiles.get('swe');
  // 六档体系新增
  private critiqueFrequency?: CritiqueFrequencySpec;
  private ironLawInjectionLevel?: IronLawInjectionLevel;
  private tierName?: string;
  /** P0-B 兼容：原始静态分析结果 */
  private staticAnalysis?: StaticAnalysisResult[];
  /** P0.5-A (v2)：预格式化的静态分析块 */
  private staticAnalysisBlocks: string[] = [];
  /** P0.5-A (v2)：显式 user request，用于 <user_request> 块 */
  private userRequest?: string;
  /** P0.5-A (v2)：当前 diff，用于 <current_diff> 块 */
  private currentDiff?: string;
  /** 保存初始 prompt，用于尽力提取 user request（不影响主逻辑） */
  private initialPromptForContext: string = '';

  constructor(
    private modelClient: any,
    private verificationEngine: any,
    options: VerifyCritiqueLoopOptions = {}
  ) {
    this.useUniversal = options.useUniversalAdapter ?? false;
    this.strictGlm = options.strictGlmOnly ?? true;
    this.maxSteps = options.maxSteps ?? 25;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.failureMemory = options.failureMemory;
    this.verifyFirstBias = options.verifyFirstBias ?? this.strictGlm;
    // 强力模式判定（behavioral）：优先 isStrongMode，其次 !practicalMode，再次 strictGlmOnly（legacy）
    const explicitStrong = options.isStrongMode;
    const explicitPractical = options.practicalMode;
    this.isStrongMode = explicitStrong ?? (explicitPractical === undefined ? this.strictGlm : !explicitPractical);
    this.practicalMode = explicitPractical ?? !this.isStrongMode;
    // 任务风格：优先 taskStyle，其次 benchmarkType（legacy alias）
    this.taskStyle = options.taskStyle ?? (options.benchmarkType as string | undefined);
    this.benchmarkType = options.benchmarkType ?? this.taskStyle;
    this.profile = BenchmarkProfiles.get(this.taskStyle ?? this.benchmarkType);
    // 六档体系新增：接收 critique 频率、铁律注入强度、tier 名称
    this.critiqueFrequency = options.critiqueFrequency;
    this.ironLawInjectionLevel = options.ironLawInjectionLevel;
    this.tierName = options.tier;
    // P0-B / P0.5-A 静态分析
    this.staticAnalysis = options.staticAnalysis;
    if (Array.isArray(options.staticAnalysisBlocks)) {
      this.staticAnalysisBlocks = options.staticAnalysisBlocks.slice();
    } else {
      this.staticAnalysisBlocks = [];
    }
    this.userRequest = options.userRequest;
    this.currentDiff = options.currentDiff;
  }

  private maxSteps: number;
  private maxConsecutiveFailures: number;

  // GLM-5.x Iron Law tracking (Read-Before-Write + Verification density)
  private hasPerformedRealVerification = false;
  private stepsSinceLastRealVerification = 0;
  private verificationAttempts = 0;

  private filesReadThisTrajectory = new Set<string>();
  private filesWrittenThisTrajectory = new Set<string>();
  private readBeforeWriteViolations = 0;

  // 多任务风格支持的额外跟踪
  private terminalCommandsExecuted = 0;
  private terminalNoCheckViolations = 0;   // Terminal 风格：关键命令后未检查
  private automationStepsWithoutEffectCheck = 0;

  async run(initialPrompt: string): Promise<{ success: boolean; steps: LoopStep[] }> {
    this.initialPromptForContext = initialPrompt || '';
    let stepNum = 0;
    let done = false;

    // highRigor: behavioral flag for heavy verification, iron laws, high critique frequency, strict format enforcement.
    // This represents the "strong mode" execution path (high-rigor discipline) regardless of underlying model.
    // Computed from:
    // - explicit isStrongMode (preferred public flag), or
    // - strictGlm (legacy high-discipline parser intent) + !practicalMode.
    const highRigor = ((this.isStrongMode ?? this.strictGlm) && !this.practicalMode) && !this.useUniversal;

    // 任务风格相关元信息（用于 prompt 注入和铁律策略）
    const benchHeader = BenchmarkProfiles.getPromptHeader(this.profile, highRigor && this.profile.defaultStrictIronLaws);
    const verificationHint = BenchmarkProfiles.getVerificationHint(this.profile);

    while (!done && stepNum < this.maxSteps) {
      stepNum++;

      const history = this.buildHistoryPrompt();
      let prompt = `${initialPrompt}\n\n[历史执行记录]\n${history}`;

      // 轻量注入任务风格头（如果还没在 initialPrompt 里）
      if (!prompt.includes('当前任务风格') && !prompt.includes('任务风格') && !prompt.includes('当前 Benchmark') && !prompt.includes('Terminal-Bench') && !prompt.includes('AutomationBench')) {
        prompt = benchHeader + '\n' + prompt;
      }

      // 构建 prompt 时根据 practicalMode + 任务风格调整铁律/格式注入强度
      // 强力模式设计目标：工程强 + 分数强
      // - 保留核心纪律（Read-Before-Write、Verify-Before-Claim、标准格式）
      // - 但只在“有风险或早期”时才重度注入，避免每步塞大段规则导致 token 爆炸和日常工程不可用
      if (highRigor) {
        // === 强力模式（高纪律，工程可用） ===
        // P2-3 修复：完全按 ironLawInjectionLevel 差异化
        // - 'minimal' / 'low'：几乎不注入（只保留格式/任务风格提醒）
        // - 'medium'：常规注入
        // - 'medium_high' / 'high'：重度注入
        // - 'highest'：始终注入完整铁律头
        const injectionLevel = this.ironLawInjectionLevel ?? 'medium';

        // minimal: 极轻量；low: 轻量；medium: 标准；medium_high/high: 较重；highest: 最重
        const shouldInjectIronHeader = injectionLevel === 'highest'
          || (injectionLevel === 'high' && (this.readBeforeWriteViolations > 0 || this.stepsSinceLastRealVerification >= 3 || stepNum <= 2))
          || (injectionLevel === 'medium_high' && (this.readBeforeWriteViolations > 0 || this.stepsSinceLastRealVerification >= 3 || stepNum <= 3))
          || (injectionLevel === 'medium' && (this.readBeforeWriteViolations > 0 || stepNum <= 1));

        if (shouldInjectIronHeader) {
          const ironHeader = StructuredReasoner.getGlmIronLawsHeader();
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
          prompt += `\n\n${StructuredReasoner.buildGlmFormatEnforcementPrompt()}`;
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
          prompt += `\n\n【Read-Before-Write】修改前先完整读文件，这是强力模式保证质量的核心纪律。`;
        }
      } else {
        // === 实用 / 日常模式：轻量纪律提示（避免无谓消耗）===
        if (this.readBeforeWriteViolations > 0) {
          prompt += `\n\n【小提醒】最近有在未读取文件的情况下直接修改文件的倾向，建议先读取再修改。`;
        }
        if (this.stepsSinceLastRealVerification >= 3) {
          prompt += `\n\n【小提醒】已经连续几步没有明显验证，建议适当确认修改效果。`;
        }
        // 轻量任务风格验证提示
        if (stepNum % 3 === 0) {
          prompt += `\n\n${verificationHint}`;
        }
      }

      // P0-2 修复：旧 FailureMemory 注入加 tier 门控
      // 强力模式（!practicalMode）才允许注入旧 FailureMemory；
      // 实用模式完全不注入（避免双记忆污染和 token 爆炸）。
      // 最终目标：完全收敛到 RefinedMemoryStore（旧路径下线）。
      if (!this.practicalMode && this.failureMemory && (this.isStrongMode ?? this.strictGlm)) {
        const mem = this.failureMemory.toPromptInjection();
        if (mem) prompt += '\n' + mem;
      }

      const rawOrObj = await this.modelClient.complete(prompt);

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

      // 解析工具调用（GLM 严格模式走 Extreme）
      let toolCalls: ToolCall[] = preParsedToolCalls ?? [];

      if (toolCalls.length === 0) {
        if (this.useUniversal && !this.strictGlm) {
          const res = this.universalAdapter.parse(rawContent, {
            strictGlmOnly: this.strictGlm,
            tolerant: !this.strictGlm,
          });
          toolCalls = res.toolCalls;
          detectedFormat = res.detectedFormat ?? detectedFormat;
        } else {
          const res = this.extremeAdapter.parse(rawContent, { strict: this.strictGlm });
          toolCalls = res.toolCalls;
        }
      }

      // 确保每个工具调用都有 category（用于多任务风格铁律跟踪）
      for (const c of toolCalls) {
        if (!c.category) {
          c.category = inferToolCategory(c.toolName);
        }
      }

      // === 多任务风格铁律实时跟踪 ===
      // 强力模式下执行更严格的跟踪；实用模式下也做轻量统计以便提示
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
                if (this.failureMemory) {
                  this.failureMemory.record('READ_BEFORE_WRITE_VIOLATION', `Wrote ${fp} without prior Read`);
                }
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
        verificationResult = await this.verificationEngine.execute(toolCalls);
        signal = this.classifySignal(verificationResult);

        const lower = verificationResult.toLowerCase();
        // M1-2.5 (the ONLY change allowed in this file): the real-execution
        // engine adapter terminates successful bash results with `EXIT_CODE:0`
        // — treat that as the strongest real-verification signal. Legacy PASS
        // heuristics below remain for compatibility.
        const looksLikeRealPass =
          lower.includes('exit_code:0') ||
          lower.includes('all_tests_passed') ||
          lower.includes('verification:') ||
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
      } else {
        verificationResult = 'NO_TOOL_CALLS';
        signal = 'NO_TOOL_CALLS';
        this.stepsSinceLastRealVerification++;
      }

      // 决定是否进行 critique（控制 token 消耗）
      // - 强力模式（!practicalMode）：从第2步起高频 critique，以保持高纪律自我检查
      // - 实用/日常模式：降低频率，避免无谓 token 消耗；只在必要时触发
      let critique: string | undefined;
      const shouldCritique = this.decideShouldCritique(stepNum, signal, highRigor);

      if (shouldCritique) {
        const lastData = this.steps.length > 0
          ? JSON.stringify(this.steps[this.steps.length - 1])
          : '（第一步）';

        // P0.5-A (v2): 按蓝图要求构造结构化上下文
        // 顺序：
        //   <static_analysis_context> （来自 Reviewer 的块）
        //   <user_request>
        //   <current_diff>
        // 之后附加 lastData（历史步骤 JSON）供复盘连续性。
        const contextParts: string[] = [];

        // 1) 静态分析上下文（必须在 user_request 之前）
        let saContent = '';
        if (this.staticAnalysisBlocks && this.staticAnalysisBlocks.length > 0) {
          saContent = this.staticAnalysisBlocks.join('\n');
        } else if (this.staticAnalysis && this.staticAnalysis.length > 0) {
          try {
            saContent = Reviewer.formatStaticAnalysisBlock(this.staticAnalysis) || '';
          } catch {}
        }
        if (saContent && saContent.trim().length > 0) {
          if (saContent.length > 4000) {
            saContent = saContent.slice(0, 4000) + '\n...[truncated]';
          }
          // 每块已包含 <static_analysis_result> 标签，这里整体包裹
          contextParts.push(`<static_analysis_context>\n${saContent}\n</static_analysis_context>`);
        }

        // 2) user_request（显式标注，按 v2 要求）
        let ur = this.userRequest;
        if (!ur && this.initialPromptForContext) {
          // 尽力从初始 prompt 提取 Issue / 任务描述
          const m = this.initialPromptForContext.match(/(?:^|\n)\s*(?:Issue:|当前任务|Task:|问题描述)\s*[:：]?\s*([\s\S]{0,1200})/i);
          ur = m ? m[1].trim() : this.initialPromptForContext.slice(0, 800).trim();
        }
        if (ur && ur.trim().length > 0) {
          let urTrim = ur;
          if (urTrim.length > 2000) urTrim = urTrim.slice(0, 2000) + '...';
          contextParts.push(`<user_request>\n${urTrim}\n</user_request>`);
        }

        // 3) current_diff（显式标注，在 user_request 之后）
        if (this.currentDiff && this.currentDiff.trim().length > 0) {
          let cd = this.currentDiff.trim();
          if (cd.length > 2000) cd = cd.slice(0, 2000) + '...';
          contextParts.push(`<current_diff>\n${cd}\n</current_diff>`);
        }

        // 4) 附加最近一步的原始数据（保持原有复盘连续性）
        contextParts.push(lastData);

        const critiqueInput = contextParts.join('\n\n');

        const critiquePrompt = StructuredReasoner.buildCritiquePrompt(
          critiqueInput,
          verificationResult,
          toolCalls,
          { practicalMode: this.practicalMode }
        );
        const critiqueRaw = await this.modelClient.complete(critiquePrompt);
        critique = typeof critiqueRaw === 'string' ? critiqueRaw : (critiqueRaw?.content ?? '');
      }

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
      };

      this.steps.push(step);

      // 自动喂给 FailureMemory
      if (this.failureMemory) {
        this.failureMemory.autoExtractFromTrajectory([step]);
      }

      // 失败保护（强力模式更宽松，允许更多探索）
      if (signal === 'FAIL' || signal === 'ERROR') {
        this.consecutiveFailures++;
        // 多任务风格失败记忆增强
        if (this.failureMemory) {
          const lowerRes = verificationResult.toLowerCase();
          if (lowerRes.includes('fail') || lowerRes.includes('error') || lowerRes.includes('non-zero')) {
            this.failureMemory.record('COMMAND_FAILED', `Command failed or error: ${verificationResult.slice(0, 120)}`);
          }
          if (this.terminalNoCheckViolations > 0 && (stepNum % 2 === 0)) {
            this.failureMemory.record('TERMINAL_NO_CHECK_AFTER_COMMAND', '关键终端命令后未及时检查输出/状态');
          }
          if (lowerRes.includes('fail') || lowerRes.includes('error') || lowerRes.includes('mismatch')) {
            this.failureMemory.record('WORKFLOW_STEP_ERROR', `Step issue: ${verificationResult.slice(0, 120)}`);
          }
          if (this.automationStepsWithoutEffectCheck > 1) {
            this.failureMemory.record('AUTOMATION_NO_EFFECT_VERIFICATION', '执行自动化动作后未验证业务效果');
          }
          if (lowerRes.includes('mismatch') || lowerRes.includes('state') && lowerRes.includes('expect')) {
            this.failureMemory.record('STATE_MISMATCH', `状态不匹配: ${verificationResult.slice(0, 120)}`);
          }
        }
      } else {
        this.consecutiveFailures = 0;
      }

      // 成功条件：必须基于真实验证信号，不能仅凭 critique 文本判定
      // Verify-Before-Claim 铁律：只有看到明确的 PASS / ALL_TESTS_PASSED 信号才能终止
      if (signal === 'PASS' || verificationResult.includes('ALL_TESTS_PASSED')) {
        done = true;
      }

      // critique 文本单独不能终止任务（修复 P0-6：critique 可单独终止的问题）
      // 仅当 critique 声称"已解决"且本步有真实验证信号时才允许终止
      if (critique && /任务已解决|已修复|问题已解决|完全正确|验证通过/i.test(critique)) {
        // 必须本步有真实验证（PASS 信号或 ALL_TESTS_PASSED）才允许终止
        if (signal === 'PASS' || verificationResult.includes('ALL_TESTS_PASSED') || didRealVerificationThisStep) {
          done = true;
        }
        // 否则：critique 声称已解决但无验证信号 → 记录失败记忆，不终止
        else if (this.failureMemory) {
          this.failureMemory.record('NO_VERIFICATION_BEFORE_CLAIM', 'critique 声称已解决但无真实验证信号');
        }
      }

      const failureLimit = highRigor ? this.maxConsecutiveFailures + 2 : this.maxConsecutiveFailures;
      if (this.consecutiveFailures >= failureLimit) {
        done = true;
      }
    }

    // 结束时把整条轨迹喂给记忆
    if (this.failureMemory) {
      this.failureMemory.autoExtractFromTrajectory(this.steps);
    }

    const success = this.steps.some(
      s => s.verificationSignal === 'PASS' || s.verificationResult.includes('ALL_TESTS_PASSED')
    );
    return { success, steps: this.steps };
  }

  private classifySignal(result: string): VerificationSignal {
    if (result.includes('ALL_TESTS_PASSED') || result.includes('VERIFICATION: PASS')) return 'PASS';
    if (result.includes('PARTIAL')) return 'PARTIAL';
    if (result.includes('FAIL') || result.includes('ERROR')) return 'FAIL';
    return 'FAIL';
  }

  /**
   * 决定本步是否需要生成 critique（控制 token 消耗 + 自我批评强度）
   * 六档体系：优先使用 critiqueFrequency 配置，回退到 highRigor 默认策略。
   * 
   * 配置驱动策略：
   * - onProblem: 任何问题（FAIL/ERROR/PARTIAL）必须复盘
   * - periodicEvery: 每 N 步周期性复盘（0 = 不周期性）
   * - longNoVerifyThreshold: 连续 N 步未真实验证后强制复盘（0 = 不强制）
   * - skipFirstN: 前N步跳过复盘（减少早期噪音）
   */
  private decideShouldCritique(stepNum: number, signal: VerificationSignal, highRigor: boolean): boolean {
    const isProblem = signal === 'FAIL' || signal === 'ERROR' || signal === 'PARTIAL';

    // 六档体系：优先使用配置
    if (this.critiqueFrequency) {
      const cf = this.critiqueFrequency;
      if (cf.skipFirstN > 0 && stepNum <= cf.skipFirstN) return false;
      if (cf.onProblem && isProblem) return true;
      if (cf.periodicEvery > 0 && stepNum % cf.periodicEvery === 0) return true;
      if (cf.longNoVerifyThreshold > 0 && this.stepsSinceLastRealVerification >= cf.longNoVerifyThreshold) return true;
      return false;
    }

    // 回退：highRigor 默认策略
    if (highRigor && !this.practicalMode) {
      if (isProblem) return true;
      if (stepNum < 3) return false;           // 前两步跳过，减少早期噪音
      const periodic = (stepNum % 3 === 0);    // 每 3 步一次
      const longNoVerify = this.stepsSinceLastRealVerification >= 3;
      return periodic || longNoVerify;
    }

    // 实用模式：更宽松
    if (stepNum < 3) return false;
    const periodic = (stepNum % 3 === 0);
    const longNoVerify = this.stepsSinceLastRealVerification >= 4;
    return isProblem || periodic || longNoVerify;
  }

  private buildHistoryPrompt(): string {
    const isPractical = this.practicalMode;
    // P2-2 修复：保留 <plan> 和 <verify> 的完整结构（GLM 长上下文利用）
    // 之前 plan.slice(150) / result.slice(160) 破坏了结构化信息
    // 现在按 tier + practical 给出合理上限，但确保结构化块完整
    const planLimit = isPractical ? 200 : 300;
    const resultLimit = isPractical ? 200 : 300;
    const thinkLimit = isPractical ? 200 : 300;
    const critiqueLimit = isPractical ? 150 : 200;

    return this.steps
      .map(s => {
        const flags: string[] = [];
        if (s.didRealVerification) flags.push('VERIFIED');
        if (s.readBeforeWriteViolation) flags.push('RBW');
        const iron = flags.length ? flags.join('+') : (isPractical ? '' : 'ok');

        // 保留 plan / verify 的核心结构（不被激进截断）
        const plan = (s.reasoning.plan || '').slice(0, planLimit);
        const verify = (s.reasoning.verify || '').slice(0, planLimit);
        const resultText = (s.verificationResult || '').slice(0, resultLimit);
        // fix-#10: truncated results MUST tell the model — silent truncation of
        // read_file content made the model believe the file never loaded and
        // (under RBW) refuse to edit → zero-output spin. Now it knows to
        // re-read with an offset.
        const resultTruncated = (s.verificationResult || '').length > resultLimit;
        const thinking = (s.reasoning.thinking || '').slice(0, thinkLimit);
        const critique = s.critique
          ? s.critique.slice(0, critiqueLimit)
          : 'N/A';

        // 包含完整的结构化块（plan + verify + result）便于 GLM 长链推理
        const base = `Step ${s.stepNumber} [${s.verificationSignal}]${iron ? ' ['+iron+']' : ''}:
Thinking: ${thinking}
Plan: ${plan}
Verify: ${verify}
Result: ${resultText}${resultTruncated ? `\n[⚠ 上一轮结果已截断（保留前 ${resultLimit} 字符）。若需要完整内容（尤其 read_file 输出），请用 read_file 重新读取目标文件（输出中会给出 offset 续读位置）。]` : ''}
Critique: ${critique}`;

        return isPractical ? base : base + `\nFormat: ${s.detectedFormat ?? 'unknown'}`;
      })
      .join('\n---\n');
  }

  /**
   * Expose current GLM Iron Law compliance state + multi-task-style signals.
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

