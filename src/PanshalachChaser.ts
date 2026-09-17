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
  /**
   * 压缩计量锚点：本任务最后一次模型调用的实测 prompt_tokens。
   * 单次请求的 prompt ≈ 当前活体上下文（system+历史+全部步骤重发），
   * 是"现在上下文多大"的最佳实测值——累计值（estimatedUsedTokens）跨步
   * 重复计入历史，不能当上下文占用用。
   */
  lastPromptTokens?: number;
  rolloutsExecuted: number;
  stepsExecuted: number;
  notes: string[];
}

export interface ChaserConfig {
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
  /** 0.8.2：chat 直答的独立记忆块（宿主从 PromptBuilder 传出；chat 的 user =
   *  "此块 + 用户原话"——绝不整段 enriched 塞 user，1B 元话语根因）。 */
  chatMemoryBlock?: string;
  /**
   * 【1】chat 直答的最近对话段（2026-09-13 迭代包）：宿主从 session 组装
   * （最近 2 轮 userInput+answerText，≤600 字符，自带【最近对话】段头）。
   * chaser 拿不到 session.turns——拼在 chatMemoryBlock 之后、用户原话之前，
   * 指代型追问（"那第二个呢"）不再零上下文硬答。
   */
  chatRecentTurns?: string;
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
    /** 本任务触发过溢出截断重试（RunResult 透传 → RunCommand 溢出证据行）。 */
    contextOverflowCompacted?: boolean;
  }> {
    // 解析 tier（必须在任何客户端校验前完成，因为 dryRun 等返回需要 tierConfig）
    let effectiveTier: Tier;
    if (config.tier) {
      effectiveTier = TierRegistry.normalize(config.tier);
    } else {
      effectiveTier = TierRegistry.normalize(this.defaultModeOrTier);
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

    if (config.dryRun) {
      console.log(`\n[dry-run] Panshalach 任务预估`);
      console.log(`Tier        : ${tierConfig.tier} (${tierConfig.typicalUseCase})`);
      console.log(`Task Style  : ${taskStyle ?? 'auto'}`);
      console.log(`Budget      : ${budgetTokens} tokens`);
      console.log(`Max Steps   : ${maxStepsPerRollout > 0 ? maxStepsPerRollout : '∞（不限，预算闸兜底）'}`);
      console.log(`Iron Law    : ${tierConfig.ironLawInjectionLevel ?? 'N/A（实用模式）'}`);
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
      // B11：chat 的 complete 回退通道同样携带记忆块 + 最近对话段。
      // messages 通道（下方 chatMessages）已独立承载；此处内联进 basePrompt，
      // 仅被「仅实现 complete、无 chat/streamChatMessages」的客户端消费——
      // 此前该通道 chat 意图零记忆零上下文（源码 2026-09-14 已申报缺口）。
      const chatFallbackUser = [config.chatMemoryBlock, config.chatRecentTurns, issueDescription]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n\n');
      basePrompt = StructuredReasoner.buildChatDirective(chatFallbackUser);
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

      // 格式教学恒注入（ironLawInjectionLevel 现已仅强档 high/highest 携带，不再有
      // 'none' 档位；quick/standard/high 也需格式教学防 UNKNOWN_TOOL 空转）。
      // 教学名单固定为全集，与格式教学示例严格一致。
      basePrompt += `\n\n${StructuredReasoner.buildToolCallFormatEnforcementPrompt(
        ['bash', 'read_file', 'glob', 'grep', 'write_file', 'edit_file']
      )}`;
    }

    // chat 意图：单次直答，不进 agent 循环。
    // R3（0.8.1）：能力回落阶梯 streamChatMessages（流式，message.delta 增量透传
    // 给 line/rich 前端）→ chat（整段）→ complete（整段，0.7 原路径）；
    // 显式 temperature 0.7 + maxTokens 4096（摆脱网关默认值）；finish_reason=length
    // 截断时正文尾追加标注；空回答（R2）在最终正文上判。
    // F3（0.8.1 第 2 轮）：chat 直答不发 phase 事件——真机实测 `── 侦察 ──`+`── 执行 ──`
    // 双相位线是 rollout 语义的 UI 噪声（explore 由 runAgentTask 按意图门控，
    // 这里的 rollout 相位线直接删除）。
    if (intent === 'chat') {
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
      // 0.8.2 chat 净化：user = "记忆块 + 用户原话"。宿主传 chatMemoryBlock 时
      // issueDescription 已是原文（runAgentTask chat 分离传递）；记忆块拼在前，
      // 与 system 的对话指令配对——不再整段 enriched 塞 user（1B 元话语根因）。
      // 【1】最近对话原文（2026-09-13 迭代包）：chat 直答模型此前看不到最近对话
      // 原文（【最近上下文】块只在被 chat 丢弃的 enriched 里），指代型追问零
      // 上下文硬答——宿主组装的【最近对话】段拼在记忆块之后、用户原话之前。
      const chatUserContent = [config.chatMemoryBlock, config.chatRecentTurns, issueDescription]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n\n');
      const chatMessages = [
        { role: 'system' as const, content: StructuredReasoner.buildChatSystemDirective() },
        { role: 'user' as const, content: chatUserContent },
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
          // F1（0.8.1 第 2 轮，P0）：流式路径的 <think> 状态机过滤。MiniMax-M3/
          // Qwen3 系把推理以 `<think>...</think>` 内嵌在 content 里（网关未剥离时
          // 走这里）——此前只有非流式正文过 stripThinkTags，流式 chunk 直写导致
          // 推理原文整段暴露。标签可能被 chunk 边界切开 → 尾部保留 ≤10 字符缓冲
          // 跨 chunk 拼接后再检测；thinkMode 期间增量全吞；流结束时仍未闭合
          // （截断响应常见）→ 正文视为空，走下方 R2 空检查。
          let thinkMode = false;
          let pending = '';
          const emitVisible = (segment: string) => {
            if (!segment) return;
            if (!startedMessage) config.onStep?.({ version: 2, type: 'message.start' });
            startedMessage = true;
            config.onStep?.({ version: 2, type: 'message.delta', text: segment });
            text += segment;
          };
          // buf 尾部可能是被切开的半个标签 → 返回需保留的长度（< 标签全长）。
          const holdbackLen = (buf: string, tag: string): number => {
            const max = Math.min(buf.length, 10, tag.length - 1);
            for (let k = max; k > 0; k--) {
              if (buf.endsWith(tag.slice(0, k))) return k;
            }
            return 0;
          };
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
            // F1：正文 chunk 先过 <think> 状态机，只发射边界外的可见段
            pending += (chunk as any).text;
            for (;;) {
              if (!thinkMode) {
                const open = pending.indexOf('<think>');
                if (open !== -1) {
                  emitVisible(pending.slice(0, open));
                  pending = pending.slice(open + '<think>'.length);
                  thinkMode = true;
                  continue;
                }
                const hold = holdbackLen(pending, '<think>');
                if (hold < pending.length) emitVisible(pending.slice(0, pending.length - hold));
                pending = pending.slice(pending.length - hold);
                break;
              }
              const close = pending.indexOf('</think>');
              if (close !== -1) {
                pending = pending.slice(close + '</think>'.length);
                thinkMode = false;
                continue;
              }
              pending = pending.slice(pending.length - holdbackLen(pending, '</think>'));
              break;
            }
          }
          if (thinkMode) {
            // 未闭合 <think>（截断场景）→ 推理全部吞掉、正文视为空 → R2 EMPTY_RESPONSE，
            // 绝不把半截推理原文伪装成回答。
            chatText = '';
          } else {
            emitVisible(pending); // 收尾冲刷尾部缓冲（最多 9 字符的半个标签残留）
            chatText = text;
          }
        } else if (canChat) {
          // 无流式但有 chat：整段直答（正文由宿主 answered 兜底呈现——R1 路径）
          chatText = extractReplyText(await chatClient.chat(chatMessages, chatOpts));
        } else {
          // 回落 plain complete（0.7 原路径：basePrompt 内嵌对话指令 + 用户输入）。
          // B11（已补齐）：basePrompt 现内联 chatMemoryBlock + chatRecentTurns
          // （见上方 chat 分支组装），仅有 complete 的客户端不再零记忆零上下文。
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
          userFacing: true, // chat 直答正文即面向用户回复（answerText 带出的标记）
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
        ...(chatMeasured > 0 && chatUsage.prompt > 0 ? { lastPromptTokens: chatUsage.prompt } : {}),
        rolloutsExecuted: 1,
        stepsExecuted: 0,
        notes: ['chat 单次回复（不进 agent 循环）'],
      };
      // F3/F4（0.8.1 第 2 轮）：chat 直答不再发 step 事件——空 thinking/plan 的
      // step 会渲染成 `[Step 1]` 空头行并把终态撑成 `✓ 已回复 · 1 步 · Xs`（步数
      // 对单轮直答无意义）。正文已随 message.delta 流式呈现，answerText 由
      // runAgentTask 从轨迹末步带出，均不依赖该事件。
      return { success: true, bestTrajectory: traj, totalRollouts: 1, budgetReport, tierConfig };
    }

    // Phase 2: Test-Time Compute
    config.onStep?.({ version: 1, type: 'phase', phase: 'rollout' });

    let estimatedUsedTokens = 0;
    const rolloutsExecuted = 1; // 恒单 rollout
    let stepsExecuted = 0;
    const budgetNotes: string[] = [];

    // M2-4：真实 usage 计量——loop 每次模型调用经 wrapper 传 onUsage 累加；
    // usage 缺失（网关无 usage 字段）时回落 len/4 估算（budgetReport 标注实测/估算）。
    // overflowCompacted：loop 触发过溢出截断重试（评测 A 档正源，经 RunResult
    // 透传到 RunCommand 证据行——stdout 正则误判多，机器可读标记是权威）。
    let overflowCompacted = false;
    // lastPrompt：最近一次请求的实测 prompt_tokens——上下文占用的最佳锚点
    // （累计值跨步重复计入历史，见 BudgetReport.lastPromptTokens 注释）。
    const usageAccum = { prompt: 0, completion: 0, lastPrompt: 0 };
    let usageSamples = 0;
    let usageMeasured = false;
    const onUsage = (u: { prompt?: number; completion?: number }) => {
      if (!u || typeof u !== 'object') return;
      if (typeof u.prompt === 'number' && u.prompt >= 0) {
        usageAccum.prompt += u.prompt;
        usageAccum.lastPrompt = u.prompt;
      }
      if (typeof u.completion === 'number' && u.completion >= 0) usageAccum.completion += u.completion;
      usageSamples++;
    };

    // search 意图用受限只读循环（≤30 步，写/bash 被拒）；execution 用完整循环。
    const isSearchIntent = intent === 'search';
    const dynamicOptions: VerifyCritiqueLoopOptions = {
      strictStructured: isHighRigor && !isSearchIntent,
      // 2026-09-16 取消步数限制：0 = 不限步数（预算闸兜底）。search 意图保留
      // 只读窄检索上限（控制人裁决：全档位步数 ×10——3→30，"读文件数标题"
      // 类多文件问答 3 步经常不够用，真机 REPL 实测第 3 步截断无回答）。
      maxSteps: isSearchIntent
        ? (maxStepsPerRollout > 0 ? Math.min(30, maxStepsPerRollout) : 30)
        : maxStepsPerRollout,
      maxConsecutiveFailures: tierConfig.maxConsecutiveFailures,
      verifyFirstBias: tierConfig.verifyFirstBias,
      practicalMode: !isHighRigor || isSearchIntent,
      isStrongMode: isHighRigor && !isSearchIntent,
      taskStyle,
      benchmarkType: taskStyle,
      // 0.8.2：显式执行意图（task 意图才驱动防呆 nudge；chat 直答不进 loop、search 只读）
      executionIntent: intent === 'execution',
      searchIntent: isSearchIntent,
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
        // <think> 状态机（与 chat 直答分支同构）：loop 流式路径同样会收到
        // 网关内嵌推理（MiniMax-M3/Qwen3），不过滤则推理原文整段直写终端。
        let thinkMode = false;
        let pending = '';
        const holdbackLen = (buf: string, tag: string): number => {
          const max = Math.min(buf.length, 10, tag.length - 1);
          for (let k = max; k > 0; k--) {
            if (buf.endsWith(tag.slice(0, k))) return k;
          }
          return 0;
        };

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
            // <think> 状态机：thinkMode 期间增量全吞，边界外可见段才发射/累积
            pending += chunk.text;
            for (;;) {
              if (!thinkMode) {
                const open = pending.indexOf('<think>');
                if (open !== -1) {
                  const vis = pending.slice(0, open);
                  emitDelta('message', vis, !startedMessage);
                  text += vis;
                  startedMessage = true;
                  pending = pending.slice(open + '<think>'.length);
                  thinkMode = true;
                  continue;
                }
                const hold = holdbackLen(pending, '<think>');
                if (hold < pending.length) {
                  const vis = pending.slice(0, pending.length - hold);
                  emitDelta('message', vis, !startedMessage);
                  startedMessage = true;
                  text += vis;
                }
                pending = pending.slice(pending.length - hold);
                break;
              }
              const close = pending.indexOf('</think>');
              if (close !== -1) {
                pending = pending.slice(close + '</think>'.length);
                thinkMode = false;
                continue;
              }
              pending = pending.slice(pending.length - holdbackLen(pending, '</think>'));
              break;
            }
          }
        }
        if (thinkMode) {
          // 未闭合 <think>（截断场景）→ 推理全吞、正文视为空（R2 空检查兜底）
          text = '';
        } else {
          text += pending; // 收尾冲刷尾部缓冲
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
        // E2：调用方（loop）注入的 onUsage 与本包装器累加器链式合并，两条计量线互不覆盖
        const chainUsage = (opts?: any) => (u: any) => {
          onUsage(u);
          if (opts && typeof opts.onUsage === 'function') opts.onUsage(u);
        };
        if (typeof streamable?.streamChat !== 'function') {
          // M2-4：非流式路径同样透传 onUsage（网关 usage 直接计量）
          return (prompt: string, opts?: any) => originalClient.complete(prompt, { ...(opts ?? {}), onUsage: chainUsage(opts) });
        }
        return (prompt: string, opts?: any) => consumeChunks(streamable.streamChat(prompt, { ...(opts ?? {}), onUsage: chainUsage(opts) }));
      };

      // 0.8 P2（M1-PROTOCOL）：messages 通道 wrapper——优先 streamChatMessages
      // （消费循环与文本路径同构），否则 chat（非流式，无 v2 delta，与文本路径
      // 非流式回退一致）；客户端两者皆无 → undefined（loop 回落文本路径）。
      const makeMessagesComplete = (): ((messages: any[], opts?: any) => Promise<string | ModelClientOutput>) | undefined => {
        const streamable = originalClient as any;
        const canStream = typeof streamable?.streamChatMessages === 'function';
        const canChat = typeof streamable?.chat === 'function';
        if (!canStream && !canChat) return undefined;
        // E2：与文本路径同规则——调用方 onUsage 链式合并，不覆盖累加器
        const chainUsage = (opts?: any) => (u: any) => {
          onUsage(u);
          if (opts && typeof opts.onUsage === 'function') opts.onUsage(u);
        };
        return async (messages: any[], opts?: any): Promise<string | ModelClientOutput> => {
          if (canStream) {
            return consumeChunks(streamable.streamChatMessages(messages, { ...(opts ?? {}), onUsage: chainUsage(opts) }));
          }
          return streamable.chat(messages, { ...(opts ?? {}), onUsage: chainUsage(opts) });
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
        overflowCompacted = true;
        budgetNotes.push('context_overflow 触发溢出截断并重试本步');
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
          // 2026-09-16：verificationResult（工具结果）为空时回退 step.result
          // （空转 answered 步的用户正文）——此前空转正文在此处被空串覆盖，
          // answerText 带出链路断在最后一环（"已回复"但无内容）。
          result: s.verificationResult || (s as any).result || '',
          ...(s.userFacing ? { userFacing: true } : {}),
          detectedFormat: s.detectedFormat,
          didRealVerification: s.didRealVerification,
          readBeforeWriteViolation: s.readBeforeWriteViolation,
          terminalNoCheck: s.terminalNoCheck,
          automationNoEffectCheck: s.automationNoEffectCheck,
          // E2 性能埋点透传（runAgentTask 据此产出 stepTimings 证据）
          ...(typeof s.ts === 'number' ? { ts: s.ts } : {}),
          ...(typeof s.durationMs === 'number' ? { durationMs: s.durationMs } : {}),
          ...(typeof s.promptTokens === 'number' ? { promptTokens: s.promptTokens } : {}),
          ...(typeof s.completionTokens === 'number' ? { completionTokens: s.completionTokens } : {}),
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
      ...(usageMeasured && usageAccum.lastPrompt > 0 ? { lastPromptTokens: usageAccum.lastPrompt } : {}),
      rolloutsExecuted,
      stepsExecuted,
      notes: budgetNotes,
    };

    return { success, bestTrajectory: best, totalRollouts: rolloutsExecuted, budgetReport, tierConfig, contextOverflowCompacted: overflowCompacted, message: !success ? best.lastError : undefined };
  }
}
