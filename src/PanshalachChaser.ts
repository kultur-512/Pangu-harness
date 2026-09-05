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
import { runWithVerificationJudge } from './loop/continuationJudge.js';
import { TestTimeOrchestrator, Trajectory } from './orchestration/TestTimeOrchestrator.js';
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
  /** Interactive approval bridge (rich ConfirmBar / readline / headless). */
  approvalBridge?: (req: { tool: string; description: string; danger: boolean }) => Promise<'y' | 'n' | 'a'>;
  /** Approval confirm timeout (default 60s → treated as 'n'). */
  approvalTimeoutMs?: number;
  /** plan mode（禁止写入/bash，仅输出计划）。 */
  planMode?: boolean;
  /** MCP 工具（命名空间化，按 bash 同等门禁）。 */
  mcpTools?: any[];
}

/**
 * PanshalachChaser 主类
 * 推荐：import { PanshalachChaser } from './PanshalachChaser.js'
 */
export class PanshalachChaser {
  // 记忆 store 句柄（任务边界 invalidateProjection 重建投影）
  private memStoreForInvalidate: any = null;

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

    // #3/#5/#6（2026-09-05）：任务前仓库扫描/锚点注入、任务风格提示头、
    // FailureMemory 轨道均已摘除（archive/2026-09-05-removals/）。
    // 记忆注入（RefinedMemoryStore）保留——这是主线。
    let basePrompt = StructuredReasoner.buildReasoningPrompt(
      `Issue: ${issueDescription}`,
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

    // Phase 2: Test-Time Compute
    config.onStep?.({ version: 1, type: 'phase', phase: 'rollout' });

    const orchestrator = new TestTimeOrchestrator();

    let estimatedUsedTokens = 0;
    let triggeredSoftLimit = false;
    let triggeredDegradation = false;
    let rolloutsExecuted = 0;
    let stepsExecuted = 0;
    const budgetNotes: string[] = [];

    const loopOptions: VerifyCritiqueLoopOptions = {
      // #7：解析恒走三路（loop 内部强制 useUniversal），不再传 useUniversalAdapter
      strictStructured: isHighRigor,
      maxSteps: maxStepsPerRollout,
      maxConsecutiveFailures: tierConfig.maxConsecutiveFailures,
      verifyFirstBias: tierConfig.verifyFirstBias,
      practicalMode: !isHighRigor,
      isStrongMode: isHighRigor,
      taskStyle,
      benchmarkType: taskStyle,
      ironLawInjectionLevel: tierConfig.ironLawInjectionLevel,
    };

    const best = await orchestrator.runMultiple(
      async (rolloutId: string) => {
        const dynamicOptions: VerifyCritiqueLoopOptions = { ...loopOptions };
        if (triggeredDegradation) {
          dynamicOptions.maxSteps = Math.max(5, Math.floor(maxStepsPerRollout * 0.5));
          if (dynamicOptions.ironLawInjectionLevel === 'highest') dynamicOptions.ironLawInjectionLevel = 'high';
          else if (dynamicOptions.ironLawInjectionLevel === 'high') dynamicOptions.ironLawInjectionLevel = 'medium';
          else if (dynamicOptions.ironLawInjectionLevel === 'medium_high') dynamicOptions.ironLawInjectionLevel = 'medium';
        }

        const useLegacyParser = process.env.PANSHA_USE_LEGACY_PARSER === '1';
        const originalClient = this.modelClient;

        // 流式感知 wrapper（协议 v2 增量）。
        // When the underlying client exposes streamChat(), consume the token
        // stream, re-emit throttled thinking.delta / message.delta events via
        // onStep, and return the accumulated raw text so VerifyCritiqueLoop's
        // parsing path is untouched. Falls back to plain complete() otherwise.
        const makeStreamingComplete = (): ((prompt: string, opts?: any) => Promise<string | ModelClientOutput>) => {
          const streamable = originalClient as any;
          if (typeof streamable?.streamChat !== 'function') {
            // Preserve original semantics: complete() may return a string OR an
            // object ({content, toolCalls...}) — VerifyCritiqueLoop handles both.
            return (prompt: string, opts?: any) => originalClient.complete(prompt, opts);
          }

          const emitDelta = (type: 'thinking' | 'message', text: string, first: boolean) => {
            if (!config.onStep) return;
            try {
              if (first) {
                config.onStep({ version: 2, type: type === 'thinking' ? 'thinking.start' : 'message.start' });
              }
              config.onStep({ version: 2, type: type === 'thinking' ? 'thinking.delta' : 'message.delta', text });
            } catch {}
          };

          // Emit every chunk as-is. Ink dispatches are cheap enough at chat
          // cadence, and the Hermes-style live feel matters more than
          // micro-batching here (typically 10-100 chunks per reply).
          // P1.1: type:'toolCalls' chunk（原生 function calling）聚合后以结构化
          // 对象返回，VerifyCritiqueLoop.preParsedToolCalls 通道直接消费。
          return async (prompt: string, opts?: any): Promise<string | ModelClientOutput> => {
            let text = '';
            let startedThinking = false;
            let startedMessage = false;
            let streamToolCalls: unknown[] | null = null;

            for await (const chunk of streamable.streamChat(prompt, opts)) {
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

            // Format detection probe (same as non-streaming path)
            try {
              ToolCallFormatDetector.probeAndParse(text, { strictStructured: isHighRigor });
            } catch {}

            // 原生 function calling 优先：网关已给出结构化调用，不再走文本解析
            if (streamToolCalls && streamToolCalls.length > 0) {
              return {
                content: text,
                toolCalls: streamToolCalls,
                detectedFormat: 'openai-json',
              } as ModelClientOutput;
            }

            return text;
          };
        };

        const streamingComplete = makeStreamingComplete();

        // 优先 ToolCallFormatDetector
        // PANSHA_USE_LEGACY_PARSER=1 切回原始 client 的直连路径
        const effectiveClient = useLegacyParser ? originalClient : {
          complete: streamingComplete,
        };

        // 真实工具执行 + 审批透传。
        // The old inline stub ({ execute() { return 'ALL_TESTS_PASSED' } }) is
        // gone. Toolset = executor registry ∩ approval semantics (the adapter
        // gates bash via the readonly allowlist, writes via classify()).
        const engineAdapter = createEngineAdapter({
          workspaceRoot,
          tierConfig,
          approvalMode: config.approvalMode ?? 'readonly',
          sessionAllowlist: config.sessionAllowlist,
          approvalBridge: config.approvalBridge as any,
          approvalTimeoutMs: config.approvalTimeoutMs,
          planMode: config.planMode,
          mcpTools: config.mcpTools,
          emitEvent: (e: any) => config.onStep?.(e),
        });

        const loop = new VerifyCritiqueLoop(
          effectiveClient,
          engineAdapter,
          dynamicOptions
        );

        const extraFormat = (isHighRigor && !triggeredDegradation)
          ? `\n\n【高强度模式格式纪律】请使用标准 <> 工具调用格式。这是高质量工程工作的基本要求。`
          : '';

        // 接口契约 v3.1（双层终止）：PASS 只是 evidence；end_turn 才自然停；
        // 未验证完成且有工具活动时由判官有界续跑（<=2 次）。
        const judged = await runWithVerificationJudge(loop, basePrompt, {
          tag: `[Rollout: ${rolloutId}]${extraFormat}`,
          maxContinuations: 2,
        });

        const result = {
          success: judged.success,
          steps: judged.steps,
          stopReason: judged.stopReason as any,
        };



        // Emit per-step event
        const lastStep = result.steps[result.steps.length - 1];
        config.onStep?.({
          version: 1,
          type: 'step',
          rolloutId,
          stepNumber: result.steps.length,
          thinking: lastStep?.reasoning?.thinking,
          plan: lastStep?.reasoning?.plan,
          toolCalls: lastStep?.toolCalls || [],
          result: lastStep?.verificationResult,
        });

        if (judged.continueCount > 0) {
          config.onStep?.({ version: 1, type: 'degradation', reason: `verification-continue x${judged.continueCount}` });
        }

        const traj: Trajectory = {
          id: rolloutId,
          steps: result.steps.map((s, i) => ({
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

        // score 已移除（2026-09-05）：成败由验证信号标注在轨迹上
        traj.success = result.success;
        traj.stopReason = result.success ? 'completed' : (result.stopReason ?? 'no-verification');
        traj.continueCount = judged.continueCount;
        return traj;
      },
      maxRollouts,
      { maxTokens: config.budgetTokens },
      {
        isStrongTarget: isHighRigor,
        benchmarkType: taskStyle,
        taskStyle,
        // #1（2026-09-05）：maxRollouts 全档收敛为 1，并行 rollout 机制失去意义
      }
    );

    const success = !!best.success;
    // 任务边界 → 投影重建（下一任务反映最新衰减与记忆）
    try { this.memStoreForInvalidate?.invalidateProjection?.(); } catch {}
    // 对抗清单 #1：全部 rollout 失败时透出 lastError（不再静默 TypeError/吞错）
    if (!success && best.lastError) {
      budgetNotes.push(`rollout 失败原因：${best.lastError}`);
    }
    const budgetReport: BudgetReport = {
      budgetTokens,
      estimatedUsedTokens,
      usageRatio: Math.min(1, estimatedUsedTokens / budgetTokens),
      triggeredSoftLimit,
      triggeredDegradation,
      rolloutsExecuted,
      stepsExecuted,
      notes: budgetNotes,
    };

    return { success, bestTrajectory: best, totalRollouts: maxRollouts, budgetReport, tierConfig, message: !success ? best.lastError : undefined };
  }
}
