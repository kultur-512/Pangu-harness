// PanshalachChaser - Panshalach 记忆增强引擎
// 目标：打造一个**既在工程里强，也在记忆增强里强**的工具。
//
// 核心理念：
// - 高强度模式（High-Rigor / 由 tier 驱动）：高验证密度、结构化思考、工程纪律。
// - 实用模式：token 更省、复盘更温和，适合常规日常开发。
// - 六档强度体系（全部小写）：quick / standard / high / max / ex / pangu，默认 high。
//
// 客户端不做限流（按用户要求）。

import { StructuredReasoner } from './reasoning/StructuredReasoner.js';
import { VerifyCritiqueLoop, VerifyCritiqueLoopOptions } from './loop/VerifyCritiqueLoop.js';
import { Trajectory, syntheticFailureTrajectory } from './loop/trajectory.js';
import { classifyTaskIntent, TaskIntent } from './cli/taskIntent.js';
import { Tier, TierConfig, TierRegistry, DEFAULT_TIER } from './tiers/TierConfig.js';
import type { StepEvent, ModelClientOutput } from './cli/repl/types.js';
import { ToolCallFormatDetector } from './adapter/ToolCallFormatDetector.js';
import { createEngineAdapter } from './tools/engineAdapter.js';

/**
 * 任务风格：strong=高纪律验证密集 / practical=务实 / universal=通用
 */
export type ModelMode = 'strong' | 'practical' | 'universal';

/**
 * 预算报告（软限制执行结果）
 */
export interface BudgetReport {
  budgetTokens: number;
  estimatedUsedTokens: number;
  usageRatio: number;
  /**
   * M2-4：true = 网关实测 usage 累计（onUsage 回调汇总）；
   * false = 字符长度 /4 估算（usage 缺失时的回落口径）。
   */
  usageMeasured: boolean;
  triggeredSoftLimit: boolean;
  triggeredDegradation: boolean;
  rolloutsExecuted: number;
  stepsExecuted: number;
  notes: string[];
}

export interface ChaserConfig {
  maxRollouts?: number;
  maxStepsPerRollout?: number;
  budgetTokens?: number;
  earlyStopOnHighScore?: boolean;
  /** 任务模式（tier 的别名入口，等价于 tier: high/quick/standard） */
  modelMode?: ModelMode;
  taskStyle?: string;
  /** taskStyle 的别名 */
  benchmarkType?: string;
  tier?: Tier;
  yes?: boolean;
  dryRun?: boolean;
  /**
   * When true, the caller (e.g. REPL) has already injected refined memory cards
   * into the prompt. Core should skip its own memory injection to avoid duplication.
   */
  memoryPreInjected?: boolean;
  // ---- 真实执行审批透传（全部可选） ----
  /** Session approval mode (default: readonly — safe floor). */
  approvalMode?: 'readonly' | 'default' | 'full';
  /** Session-scoped allow-always list ('a' decisions). */
  sessionAllowlist?: Set<string>;
  /** Interactive approval bridge (rich ConfirmBar / readline / headless).
   *  返回放宽为 string：line 桥可返回 `n:<指导语>`；'y'/'a' 语义不变。 */
  approvalBridge?: (req: { tool: string; description: string; danger: boolean }) => Promise<string>;
  /** Approval confirm timeout (default 60s → treated as 'n'). */
  approvalTimeoutMs?: number;
  /** plan mode（禁止写入/bash，仅输出计划）。 */
  planMode?: boolean;
  /** MCP 工具（命名空间化，按 bash 同等门禁）。 */
  mcpTools?: any[];
  /** 外部中止信号，贯穿到 loop / 模型调用 / 工具执行。 */
  signal?: AbortSignal;
  /** 任务意图（execution/search/chat/meta），决定执行路径。 */
  intent?: TaskIntent;
  /**
   * 上下文窗口预算（tokens）。由调用方从 provider
   * getModelContextLength 解析（unknown 回落 32768），传给 loop 做
   * history 超 70% 窗口裁中段。
   */
  windowTokens?: number;
  /**
   * M2-5：context_overflow 通知透传（loop 捕获分类为 context_overflow 时
   * 回调，每任务至多一次）。宿主可据此触发 compactService 的强制档
   * shouldAutoCompact(session, ratio, { force: true }) 做会话级压缩。
   */
  onContextOverflow?: (info: { error: unknown }) => void | Promise<void>;
  /**
   * 0.8 P2（M1-PROTOCOL）：messages 模式下 stable 段
   * （PromptBuilder.buildStableSegment 产物）→ role:'system' 首消息；
   * volatile 段（buildVolatileSegment 产物）与任务文本合流进首条 user。
   * 两者缺一或 PANSHA_MESSAGES_MODE=off 时走文本路径（0.7.4 语义逐字节等价）。
   */
  stableSegment?: string;
  volatileSegment?: string;
}

/**
 * PanshalachChaser 主类
 * 推荐：import { PanshalachChaser } from './PanshalachChaser.js'
 */
export class PanshalachChaser {
  constructor(
    private modelClient: any,
    private defaultModeOrTier: ModelMode | Tier | string = DEFAULT_TIER
  ) {}

  async solveIssue(issueDescription: string, workspaceRoot: string, config: ChaserConfig & { onStep?: (event: any) => void } = {}): Promise<{
    success: boolean;
    bestTrajectory?: Trajectory;
    totalRollouts: number;
    budgetReport?: BudgetReport;
    tierConfig?: TierConfig;
    error?: string;
    message?: string;
  }> {
    // 解析 tier（必须在任何客户端校验前完成，因为 dryRun/确认等返回需要 tierConfig）
    let effectiveTier: Tier;
    if (config.tier) {
      effectiveTier = config.tier;
    } else if (this.defaultModeOrTier === 'strong' || this.defaultModeOrTier === 'practical' || this.defaultModeOrTier === 'universal') {
      effectiveTier = TierRegistry.fromMode(this.defaultModeOrTier);
    } else if (TierRegistry.isTier(this.defaultModeOrTier as string)) {
      effectiveTier = this.defaultModeOrTier as Tier;
    } else {
      effectiveTier = DEFAULT_TIER;
    }
    const tierConfig = TierRegistry.get(effectiveTier);

    // 入口防御——严禁把 null / 无 complete 的客户端带入执行路径
    if (!this.modelClient || typeof (this.modelClient as any).complete !== 'function') {
      return {
        success: false,
        totalRollouts: 0,
        tierConfig,
        error: 'NO_MODEL_CLIENT',
        message: '未提供可用的模型客户端（missing .complete）',
      };
    }

    const {
      maxRollouts = tierConfig.maxRollouts,
      maxStepsPerRollout = tierConfig.maxStepsPerRollout,
      earlyStopOnHighScore = true,
      budgetTokens = tierConfig.tier === 'pangu' ? 250_000
                   : tierConfig.tier === 'ex' ? 200_000
                   : tierConfig.tier === 'max' ? 150_000
                   : tierConfig.tier === 'high' ? 120_000
                   : 80_000,
    } = config;

    const isHighRigor = tierConfig.isStrongMode;

    const taskStyle = config.taskStyle ?? (config as any).benchmarkType;

    // 意图分类（config.intent 由调用方显式传入；否则在此按 issueDescription 推断）。
    // chat/search 走单次/受限路径，不进完整 agent 循环。
    const intent: TaskIntent = config.intent ?? classifyTaskIntent(issueDescription);

    // 用户确认（max/ex/pangu）
    if (tierConfig.userConfirmationRequired && !config.yes && !config.dryRun) {
      const { renderConfirmationPanel, waitForUserConfirmation } = await import('./cli/UserConfirmation.js');
      const panel = renderConfirmationPanel({
        tierConfig,
        estimatedTokensUpper: budgetTokens,
        estimatedCalls: maxRollouts * maxStepsPerRollout,
        estimatedDuration: `约 ${Math.max(1, Math.ceil(budgetTokens / 50000))} 分钟`,
      });
      console.log(panel);
      const result = await waitForUserConfirmation();
      if (!result.confirmed) {
        console.log('\n✗ 用户取消，任务未执行。');
        return { success: false, totalRollouts: 0, tierConfig };
      }
    }

    if (config.dryRun) {
      console.log(`\n[dry-run] Panshalach 任务预估`);
      console.log(`Tier        : ${tierConfig.tier} (${tierConfig.typicalUseCase})`);
      console.log(`Task Style  : ${taskStyle ?? 'auto'}`);
      console.log(`Budget      : ${budgetTokens} tokens`);
      console.log(`Rollouts    : ${maxRollouts}`);
      console.log(`Max Steps   : ${maxStepsPerRollout}`);
      console.log(`Iron Law    : ${tierConfig.ironLawInjectionLevel}`);
      console.log(`Memory      : ${tierConfig.memoryLoadLevel}`);
      return { success: false, totalRollouts: 0, tierConfig };
    }

    // 任务前仓库扫描/锚点注入、任务风格提示头、FailureMemory 轨道均已摘除
    // （archive/2026-09-05-removals/）。记忆注入（RefinedMemoryStore）保留——这是主线。
    // 0.8 P2（M1-PROTOCOL）：messages 双通道门——客户端有 chat/streamChatMessages 能力、
    // 未关闭、且调用方提供了 stable/volatile 分段时，stable 段 → system 首消息、
    // volatile 段与任务文本合流进首条 user（前缀缓存可命中）；否则文本路径（0.7.4 逐字节等价）。
    const streamableClient = this.modelClient as any;
    const hasMessagesCapability = typeof streamableClient?.chat === 'function'
      || typeof streamableClient?.streamChatMessages === 'function';
    const messagesEnabled = hasMessagesCapability
      && process.env.PANSHA_MESSAGES_MODE !== 'off'
      && typeof config.stableSegment === 'string' && config.stableSegment.length > 0
      && typeof config.volatileSegment === 'string' && config.volatileSegment.length > 0;
    const taskText = messagesEnabled ? (config.volatileSegment as string) : issueDescription;

    // 按意图分支组装 prompt——chat 用单轮对话指令（不灌工具教学），
    // search 用只读搜索指令；execution 才走完整推理 + 格式教学。
    let basePrompt: string;
    if (intent === 'chat') {
      basePrompt = StructuredReasoner.buildChatDirective(issueDescription);
    } else if (intent === 'search') {
      basePrompt = StructuredReasoner.buildSearchDirective(taskText);
    } else {
      basePrompt = StructuredReasoner.buildReasoningPrompt(
        `Issue: ${taskText}`,
        [],
        {
          practicalMode: !isHighRigor,
          taskStyle,
          benchmarkType: taskStyle,
          isStrongMode: isHighRigor
        }
      );

      if (tierConfig.ironLawInjectionLevel !== 'none') {
        // 写工具已全档位注册（2026-09-05 裁决），教学名单固定为全集，
        // 与格式教学示例严格一致，防 UNKNOWN_TOOL 空转。
        basePrompt += `\n\n${StructuredReasoner.buildToolCallFormatEnforcementPrompt(
          ['bash', 'read_file', 'glob', 'grep', 'write_file', 'edit_file']
        )}`;
      }
    }

    // chat 意图：单次直答，不进 agent 循环。
    // R3（0.8.1）：能力回落阶梯 streamChatMessages（流式，message.delta 增量透传
    // 给 line/rich 前端）→ chat（整段）→ complete（整段，0.7 原路径）；
    // 显式 temperature 0.7 + maxTokens 4096（摆脱网关默认值）；finish_reason=length
    // 截断时正文尾追加标注；空回答（R2）在最终正文上判。
    if (intent === 'chat') {
      config.onStep?.({ version: 1, type: 'phase', phase: 'rollout' });
      const chatClient = this.modelClient as any;
      // M2-4：单次回复同样走 onUsage 计量（网关返回 usage 时记实测）。
      const chatUsage = { prompt: 0, completion: 0 };
      let chatUsageSamples = 0;
      const onChatUsage = (u: { prompt?: number; completion?: number }) => {
        if (typeof u?.prompt === 'number' && u.prompt >= 0) chatUsage.prompt += u.prompt;
        if (typeof u?.completion === 'number' && u.completion >= 0) chatUsage.completion += u.completion;
        chatUsageSamples++;
      };
      const chatOpts = {
        temperature: 0.7,
        maxTokens: 4096,
        signal: config.signal,
        onUsage: onChatUsage,
      };
      // messages 通道形态：system 承载对话指令（不含用户输入），user 承载原文
      // （buildChatDirective 整段内嵌会让输入在 payload 里出现两次）。
      const chatMessages = [
        { role: 'system' as const, content: StructuredReasoner.buildChatSystemDirective() },
        { role: 'user' as const, content: issueDescription },
      ];

      // 直答失败的合成返回（R2 空回答 / R3 异常）——照用 syntheticFailureTrajectory
      // 的 abort 语义（TASK_ABORTED → aborted；其余 → error），与 loop 路径一致。
      const chatFailure = (errMsg: string) => {
        const failTraj = syntheticFailureTrajectory(errMsg);
        const failBudgetReport: BudgetReport = {
          budgetTokens,
          estimatedUsedTokens: 0,
          usageRatio: 0,
          usageMeasured: false,
          triggeredSoftLimit: false,
          triggeredDegradation: false,
          rolloutsExecuted: 1,
          stepsExecuted: 0,
          notes: ['chat 单次回复（不进 agent 循环）', `rollout 失败原因：${errMsg}`],
        };
        return {
          success: false,
          bestTrajectory: failTraj,
          totalRollouts: 1,
          budgetReport: failBudgetReport,
          tierConfig,
          message: failTraj.lastError,
        };
      };

      let truncated = false;
      // 非流式返回的对象形态可能带 truncated 标记（finish_reason=length）
      const extractReplyText = (reply: any): string => {
        if (typeof reply === 'string') return reply;
        if (reply && typeof reply === 'object' && (reply as any).truncated === true) truncated = true;
        return String(reply?.content ?? reply?.raw ?? '');
      };

      let chatText: string;
      try {
        const canStreamMessages = typeof chatClient?.streamChatMessages === 'function';
        const canChat = typeof chatClient?.chat === 'function';
        if (canStreamMessages) {
          let text = '';
          let startedThinking = false;
          let startedMessage = false;
          for await (const chunk of chatClient.streamChatMessages(chatMessages, chatOpts)) {
            // finish_reason 检查先于内容过滤——空文本的尾 chunk 只携带截断标记
            if ((chunk as any)?.finishReason === 'length') truncated = true;
            if (!chunk || typeof (chunk as any).text !== 'string' || !(chunk as any).text) continue;
            if ((chunk as any).type === 'thinking') {
              // 思考增量照发（渲染端已支持），但不进正文
              if (!startedThinking) config.onStep?.({ version: 2, type: 'thinking.start' });
              startedThinking = true;
              config.onStep?.({ version: 2, type: 'thinking.delta', text: (chunk as any).text });
              continue;
            }
            if (!startedMessage) config.onStep?.({ version: 2, type: 'message.start' });
            startedMessage = true;
            config.onStep?.({ version: 2, type: 'message.delta', text: (chunk as any).text });
            text += (chunk as any).text;
          }
          chatText = text;
        } else if (canChat) {
          // 无流式但有 chat：整段直答（正文由宿主 answered 兜底呈现——R1 路径）
          chatText = extractReplyText(await chatClient.chat(chatMessages, chatOpts));
        } else {
          // 回落 plain complete（0.7 原路径：basePrompt 内嵌对话指令 + 用户输入）
          chatText = extractReplyText(await chatClient.complete(basePrompt, chatOpts));
        }
      } catch (e: any) {
        return chatFailure((e as Error)?.message || String(e));
      }

      // 网关侧推理剥离：DeepSeek-R1 系/MiniMax-M3/Qwen3 等把 <think> 推理内嵌
      // 在 content 里，展示与落盘前必须剥离（stripThinkTags 同时处理未闭合块）。
      chatText = StructuredReasoner.stripThinkTags(String(chatText));
      // R2（0.8.1）：空回答不伪装成功——EMPTY_RESPONSE 重试耗尽后网关侧返回空串
      // （chatCompleteWithRetry 吞错转 ''），直答路径不得记 answered + 空内容。
      if (!String(chatText).trim()) {
        return chatFailure('EMPTY_RESPONSE: 模型返回空内容');
      }
      // R3：截断标注——finish_reason=length（流式尾 chunk 或非流式对象标记）时
      // 正文尾追加明示，用户可见"回答不完整"而非静默截断。
      if (truncated) {
        chatText = `${chatText}\n\n[回答被 max_tokens 截断]`;
      }
      const chatMeasured = chatUsageSamples > 0 ? chatUsage.prompt + chatUsage.completion : 0;
      const traj: Trajectory = {
        id: 'rollout-0',
        steps: [{
          stepNumber: 1,
          thought: '',
          plan: '',
          action: [],
          result: chatText,
        }],
        success: true,
        stopReason: 'answered',
        isStrongTarget: isHighRigor,
        benchmarkType: taskStyle,
        taskStyle,
      };
      const budgetReport: BudgetReport = {
        budgetTokens,
        estimatedUsedTokens: chatMeasured,
        usageRatio: chatMeasured > 0 ? Math.min(1, chatMeasured / budgetTokens) : 0,
        usageMeasured: chatMeasured > 0,
        triggeredSoftLimit: false,
        triggeredDegradation: false,
        rolloutsExecuted: 1,
        stepsExecuted: 0,
        notes: ['chat 单次回复（不进 agent 循环）'],
      };
      config.onStep?.({
        version: 1,
        type: 'step',
        rolloutId: 'rollout-0',
        stepNumber: 1,
        thinking: '',
        plan: '',
        toolCalls: [],
        result: chatText,
      });
      return { success: true, bestTrajectory: traj, totalRollouts: 1, budgetReport, tierConfig };
    }

    // Phase 2: Test-Time Compute
    config.onStep?.({ version: 1, type: 'phase', phase: 'rollout' });

    let estimatedUsedTokens = 0;
    let triggeredSoftLimit = false;
    let triggeredDegradation = false;
    const rolloutsExecuted = 1; // 恒单 rollout
    let stepsExecuted = 0;
    const budgetNotes: string[] = [];

    // M2-4：真实 usage 计量——loop 每次模型调用经 wrapper 传 onUsage 累加；
    // usage 缺失（网关无 usage 字段）时回落 len/4 估算（budgetReport 标注实测/估算）。
    const usageAccum = { prompt: 0, completion: 0 };
    let usageSamples = 0;
    let usageMeasured = false;
    const onUsage = (u: { prompt?: number; completion?: number }) => {
      if (!u || typeof u !== 'object') return;
      if (typeof u.prompt === 'number' && u.prompt >= 0) usageAccum.prompt += u.prompt;
      if (typeof u.completion === 'number' && u.completion >= 0) usageAccum.completion += u.completion;
      usageSamples++;
    };

    // search 意图用受限只读循环（≤3 步，写/bash 被拒）；execution 用完整循环。
    const isSearchIntent = intent === 'search';
    const dynamicOptions: VerifyCritiqueLoopOptions = {
      strictStructured: isHighRigor && !isSearchIntent,
      maxSteps: isSearchIntent ? Math.min(3, maxStepsPerRollout) : maxStepsPerRollout,
      maxConsecutiveFailures: tierConfig.maxConsecutiveFailures,
      verifyFirstBias: tierConfig.verifyFirstBias,
      practicalMode: !isHighRigor || isSearchIntent,
      isStrongMode: isHighRigor && !isSearchIntent,
      taskStyle,
      benchmarkType: taskStyle,
      ironLawInjectionLevel: isSearchIntent ? 'none' : tierConfig.ironLawInjectionLevel,
      signal: config.signal,
      windowTokens: config.windowTokens,
      // 0.8 P2：messages 模式下 system 首消息（stable 段）；未启用时 undefined（loop 回落文本路径）。
      systemSegment: messagesEnabled ? config.stableSegment : undefined,
      // M2-5：overflow 通知透传（宿主 → compactService 强制档）
      onContextOverflow: config.onContextOverflow,
    };

    const rolloutId = 'rollout-0';

    let best: Trajectory;
    try {
      const useLegacyParser = process.env.PANSHA_USE_LEGACY_PARSER === '1';
      const originalClient = this.modelClient;

      // 流式感知 wrapper（协议 v2 增量）。当底层暴露 streamChat() 时消费流，
      // 否则回退 plain complete()。0.8 P2：消费循环提取为 consumeChunks——文本
      // 流式与 messages 流式（streamChatMessages）共用（thinking/message delta
      // 事件发射逻辑复用）。
      const emitDelta = (type: 'thinking' | 'message', text: string, first: boolean) => {
        if (!config.onStep) return;
        try {
          if (first) {
            config.onStep({ version: 2, type: type === 'thinking' ? 'thinking.start' : 'message.start' });
          }
          config.onStep({ version: 2, type: type === 'thinking' ? 'thinking.delta' : 'message.delta', text });
        } catch {}
      };

      const consumeChunks = async (chunks: AsyncIterable<any>): Promise<string | ModelClientOutput> => {
        let text = '';
        let startedThinking = false;
        let startedMessage = false;
        let streamToolCalls: unknown[] | null = null;
        // 流式尾 chunk 的 finish_reason（'length' = max_tokens 截断）
        let truncated = false;

        for await (const chunk of chunks) {
          // finish_reason 检查必须先于 toolCalls continue——截断的 tool_calls
          // （arguments 半截 JSON）正是本防御的目标场景。
          if ((chunk as any).finishReason === 'length') truncated = true;
          if (chunk && (chunk as any).type === 'toolCalls' && Array.isArray((chunk as any).toolCalls)) {
            streamToolCalls = ((chunk as any).toolCalls as unknown[]).slice();
            continue;
          }
          if (!chunk || typeof chunk.text !== 'string') continue;
          if (chunk.type === 'thinking') {
            emitDelta('thinking', chunk.text, !startedThinking);
            startedThinking = true;
          } else {
            emitDelta('message', chunk.text, !startedMessage);
            startedMessage = true;
          }
          text += chunk.text;
        }

        try {
          ToolCallFormatDetector.probeAndParse(text, { strictStructured: isHighRigor });
        } catch {}

        const truncTag = truncated ? { truncated: true } : {};
        if (streamToolCalls && streamToolCalls.length > 0) {
          return {
            content: text,
            toolCalls: streamToolCalls,
            detectedFormat: 'openai-json',
            ...truncTag,
          } as ModelClientOutput;
        }

        // 截断时必须以对象返回（裸 string 无法携带 truncated 标记）
        if (truncated) return { content: text, truncated: true } as ModelClientOutput;
        return text;
      };

      const makeStreamingComplete = (): ((prompt: string, opts?: any) => Promise<string | ModelClientOutput>) => {
        const streamable = originalClient as any;
        if (typeof streamable?.streamChat !== 'function') {
          // M2-4：非流式路径同样透传 onUsage（网关 usage 直接计量）
          return (prompt: string, opts?: any) => originalClient.complete(prompt, { ...(opts ?? {}), onUsage });
        }
        return (prompt: string, opts?: any) => consumeChunks(streamable.streamChat(prompt, { ...(opts ?? {}), onUsage }));
      };

      // 0.8 P2（M1-PROTOCOL）：messages 通道 wrapper——优先 streamChatMessages
      // （消费循环与文本路径同构），否则 chat（非流式，无 v2 delta，与文本路径
      // 非流式回退一致）；客户端两者皆无 → undefined（loop 回落文本路径）。
      const makeMessagesComplete = (): ((messages: any[], opts?: any) => Promise<string | ModelClientOutput>) | undefined => {
        const streamable = originalClient as any;
        const canStream = typeof streamable?.streamChatMessages === 'function';
        const canChat = typeof streamable?.chat === 'function';
        if (!canStream && !canChat) return undefined;
        return async (messages: any[], opts?: any): Promise<string | ModelClientOutput> => {
          if (canStream) {
            return consumeChunks(streamable.streamChatMessages(messages, { ...(opts ?? {}), onUsage }));
          }
          return streamable.chat(messages, { ...(opts ?? {}), onUsage });
        };
      };

      const streamingComplete = makeStreamingComplete();
      const messagesComplete = makeMessagesComplete();

      const effectiveClient = useLegacyParser
        ? originalClient
        : messagesComplete
          ? { complete: streamingComplete, chat: messagesComplete }
          : { complete: streamingComplete };

      // 真实工具执行 + 审批透传 + 0.7 signal 贯穿。
      // search 意图：approvalMode 强制 readonly（写/bash 被拒）。
      const engineAdapter = createEngineAdapter({
        workspaceRoot,
        tierConfig,
        approvalMode: isSearchIntent ? 'readonly' : (config.approvalMode ?? 'readonly'),
        sessionAllowlist: config.sessionAllowlist,
        approvalBridge: config.approvalBridge as any,
        approvalTimeoutMs: config.approvalTimeoutMs,
        planMode: config.planMode,
        mcpTools: config.mcpTools,
        signal: config.signal,
        emitEvent: (e: any) => config.onStep?.(e),
      });

      const loop = new VerifyCritiqueLoop(
        effectiveClient,
        engineAdapter,
        dynamicOptions
      );

      const extraFormat = (isHighRigor && !isSearchIntent)
        ? `\n\n【高强度模式格式纪律】请使用标准 <> 工具调用格式。这是高质量工程工作的基本要求。`
        : '';

      const tag = `[Rollout: ${rolloutId}]${extraFormat}`;
      const loopResult = await loop.run(basePrompt + tag);

      // M2-4 预算累计：优先真实 usage（onUsage 累计），usage 缺失时回落
      // 字符长度 /4 估算（预算百分比口径不变，budgetReport 标注实测/估算）。
      const measuredTotal = usageAccum.prompt + usageAccum.completion;
      if (usageSamples > 0 && measuredTotal > 0) {
        usageMeasured = true;
        estimatedUsedTokens = measuredTotal;
        budgetNotes.push(`usage 实测：${measuredTotal} tokens（prompt ${usageAccum.prompt} + completion ${usageAccum.completion}，${usageSamples} 次响应采样）`);
      } else {
        estimatedUsedTokens = Math.ceil((basePrompt.length + tag.length) / 4)
          + loopResult.steps.reduce((acc, s) => acc + Math.ceil((s.reasoning.raw?.length ?? 0) / 4), 0);
        budgetNotes.push('usage 估算（网关未返回 usage 字段，按字符长度 /4 估算）');
      }
      if (loopResult.contextOverflowCompacted) {
        budgetNotes.push('context_overflow 触发强制压缩并重试本步');
      }
      stepsExecuted = loopResult.steps.length;

      // Emit per-step event
      const lastStep = loopResult.steps[loopResult.steps.length - 1];
      config.onStep?.({
        version: 1,
        type: 'step',
        rolloutId,
        stepNumber: loopResult.steps.length,
        thinking: lastStep?.reasoning?.thinking,
        plan: lastStep?.reasoning?.plan,
        toolCalls: lastStep?.toolCalls || [],
        result: lastStep?.verificationResult,
      });

      const traj: Trajectory = {
        id: rolloutId,
        steps: loopResult.steps.map((s, i) => ({
          stepNumber: i + 1,
          thought: s.reasoning.thinking,
          plan: s.reasoning.plan,
          action: s.toolCalls,
          result: s.verificationResult,
          critique: s.critique,
          detectedFormat: s.detectedFormat,
          didRealVerification: s.didRealVerification,
          readBeforeWriteViolation: s.readBeforeWriteViolation,
          terminalNoCheck: s.terminalNoCheck,
          automationNoEffectCheck: s.automationNoEffectCheck,
        })),
        isStrongTarget: isHighRigor,
        benchmarkType: taskStyle,
        taskStyle,
      };

      traj.success = loopResult.success;
      traj.stopReason = loopResult.stopReason;
      // aborted 时保留本步已流出正文（宿主落 turn 用）
      if (loopResult.partialText) traj.partialText = loopResult.partialText;
      traj.estimatedUsedTokens = estimatedUsedTokens;
      best = traj;
    } catch (e: any) {
      // 空批保护：单 rollout 异常时合成失败轨迹，绝不返回 undefined / 抛给上层。
      // 0.7.4：syntheticFailureTrajectory 按"真中断 vs 模型异常"区分 stopReason
      // （TASK_ABORTED/AbortError → aborted；EMPTY_RESPONSE/网络/解析 → error），
      // 模型故障不再被伪装成用户中断。
      const errMsg = (e as Error)?.message || String(e);
      best = syntheticFailureTrajectory(errMsg);
      budgetNotes.push(`rollout 失败原因：${errMsg}`);
    }

    const success = !!best.success;
    // R7（0.8.1）：memStoreForInvalidate 死代码已删——全仓无赋值（恒 null），
    // `?.invalidateProjection?.()` 从未触达任何真实 store；记忆投影重建由
    // RefinedMemoryStore 的使用方自行负责。
    if (!success && best.lastError) {
      budgetNotes.push(`rollout 失败原因：${best.lastError}`);
    }
    const budgetReport: BudgetReport = {
      budgetTokens,
      estimatedUsedTokens,
      usageRatio: Math.min(1, estimatedUsedTokens / budgetTokens),
      usageMeasured,
      triggeredSoftLimit,
      triggeredDegradation,
      rolloutsExecuted,
      stepsExecuted,
      notes: budgetNotes,
    };

    return { success, bestTrajectory: best, totalRollouts: maxRollouts, budgetReport, tierConfig, message: !success ? best.lastError : undefined };
  }
}
