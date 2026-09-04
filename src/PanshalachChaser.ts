// PanshalachChaser - Panshalach 记忆增强引擎
// 目标：打造一个**既在工程里强，也在记忆增强里强**的工具。
//
// 核心理念：
// - 高强度模式（High-Rigor / 由 tier 驱动）：高验证密度、结构化思考、工程纪律。
// - 实用模式：token 更省、复盘更温和，适合常规日常开发。
// - 六档强度体系（全部小写）：quick / standard / high / max / ex / pangu，默认 high。
//
// 推荐新代码使用 PanshalachChaser。旧名 Glm53SweProChaser 仅为兼容别名。
//
// 客户端不做限流（按用户要求）。

import { ExtremeGlmToolCallAdapter } from './adapter/ExtremeGlmToolCallAdapter.js';
import { UniversalToolCallAdapter } from './adapter/UniversalToolCallAdapter.js';
import { StructuredReasoner } from './reasoning/StructuredReasoner.js';
import { RepoExplorer, AnchorMemory } from './context/RepoExplorer.js';
import { VerifyCritiqueLoop, VerifyCritiqueLoopOptions } from './loop/VerifyCritiqueLoop.js';
import { TestTimeOrchestrator, Trajectory } from './orchestration/TestTimeOrchestrator.js';
import { FailureMemory } from './memory/FailureMemory.js';
import { ContextManager } from './context/ContextManager.js';
import { BenchmarkProfiles } from './benchmarks/BenchmarkProfiles.js';
import { Tier, TierConfig, TierRegistry, DEFAULT_TIER } from './tiers/TierConfig.js';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { StepEvent } from './cli/repl/types.js';
import { ToolCallFormatDetector } from './adapter/ToolCallFormatDetector.js';
import { createEngineAdapter } from './tools/engineAdapter.js';
import { redactAnchorLines } from './utils/redact.js';

/**
 * 旧版 ModelMode（仅供向下兼容，新代码请使用 tier）
 * @deprecated
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
  /** @deprecated 使用 tier 代替 */
  modelMode?: ModelMode;
  taskStyle?: string;
  /** @deprecated 使用 taskStyle 代替 */
  benchmarkType?: string;
  tier?: Tier;
  yes?: boolean;
  dryRun?: boolean;
  /**
   * When true, the caller (e.g. REPL) has already injected refined memory cards
   * into the prompt. Core should skip its own memory injection to avoid duplication.
   */
  memoryPreInjected?: boolean;
  // ---- M1-2.5: real-execution approval passthrough (all optional) ----
  /** Session approval mode (default: readonly — safe floor). */
  approvalMode?: 'readonly' | 'default' | 'full';
  /** Session-scoped allow-always list ('a' decisions). */
  sessionAllowlist?: Set<string>;
  /** Interactive approval bridge (rich ConfirmBar / readline / headless). */
  approvalBridge?: (req: { tool: string; description: string; danger: boolean }) => Promise<'y' | 'n' | 'a'>;
  /** Approval confirm timeout (default 60s → treated as 'n'). */
  approvalTimeoutMs?: number;
  /** P4-4.7: plan mode (writes/bash denied, plan-only output). */
  planMode?: boolean;
  /** P5-5.2: MCP tools (namespaced, gated like bash). */
  mcpTools?: any[];
}

/**
 * PanshalachChaser 主类
 * 推荐：import { PanshalachChaser } from './PanshalachChaser.js'
 */
export class PanshalachChaser {
  // M3.1: 记忆 store 句柄（任务边界 invalidateProjection 重建投影）
  private memStoreForInvalidate: any = null;
  private extremeAdapter = new ExtremeGlmToolCallAdapter();
  private universalAdapter = new UniversalToolCallAdapter();
  private failureMemory = new FailureMemory();
  private contextManager = new ContextManager();

  constructor(
    private modelClient: any,
    private defaultModeOrTier: ModelMode | Tier | string = DEFAULT_TIER
  ) {}

  async solveIssue(issueDescription: string, workspaceRoot: string, config: ChaserConfig & { onStep?: (event: any) => void } = {}): Promise<{
    success: boolean;
    bestTrajectory?: Trajectory;
    score: number;
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
      effectiveTier = TierRegistry.fromLegacyMode(this.defaultModeOrTier);
    } else if (TierRegistry.isTier(this.defaultModeOrTier as string)) {
      effectiveTier = this.defaultModeOrTier as Tier;
    } else {
      effectiveTier = DEFAULT_TIER;
    }
    const tierConfig = TierRegistry.get(effectiveTier);

    // P3: 入口防御——严禁把 null / 无 complete 的客户端带入执行路径
    if (!this.modelClient || typeof (this.modelClient as any).complete !== 'function') {
      return {
        success: false,
        score: 0,
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

    const isHighRigor = tierConfig.isStrongMode; // 由 tierConfig 驱动，旧名 isStrongMode 仅为向后兼容

    const taskStyle = config.taskStyle ?? (config as any).benchmarkType;
    const profile = BenchmarkProfiles.get(taskStyle);

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
        return { success: false, score: 0, totalRollouts: 0, tierConfig };
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
      return { success: false, score: 0, totalRollouts: 0, tierConfig };
    }

    // Phase 1: 探索
    config.onStep?.({ version: 1, type: 'phase', phase: 'explore' });

    const exploration = await RepoExplorer.explore(workspaceRoot, {
      glmBias: isHighRigor,
      maxDepth: tierConfig.explorationDepth,
      tier: tierConfig.tier,
      taskStyle,
    });

    const anchorMemory = new AnchorMemory();
    let anchors = [...exploration.recommendedAnchors];
    if (['high','max','ex','pangu'].includes(tierConfig.tier)) {
      const must = ['package.json', 'tsconfig.json', 'src', 'README.md'];
      for (const m of must) {
        if (!anchors.includes(m) && existsSync(join(workspaceRoot, m))) anchors.push(m);
      }
    }
    anchors = anchors.slice(0, tierConfig.anchorMax);

    const ANCHOR_MAX_LINES = 80;
    for (const anchor of anchors) {
      const anchorPath = join(workspaceRoot, anchor);
      let anchorContent = '';
      try {
        if (existsSync(anchorPath)) {
          const stat = statSync(anchorPath);
          if (stat.isFile()) {
            const raw = readFileSync(anchorPath, 'utf-8');
            // S3: redact sk- prefixed keys, Bearer tokens and apiKey/secret/
            // password/token pairs (quoted or bare) BEFORE the content ever
            // reaches the model context.
            anchorContent = redactAnchorLines(raw, ANCHOR_MAX_LINES);
          }
        }
      } catch {
        anchorContent = `// [ANCHOR] ${anchor} (读取失败，使用占位符)`;
      }
      if (!anchorContent) anchorContent = `// [ANCHOR] ${anchor} (空文件或目录)`;
      anchorMemory.add(anchor, anchorContent, isHighRigor ? 'strong' : 'normal', isHighRigor ? 135 : 100);
      this.contextManager.registerAnchor(anchor, anchorContent, isHighRigor ? 145 : 100);
    }

    // 初始 prompt
    const usePracticalPrompt = !isHighRigor;
    let basePrompt = StructuredReasoner.buildReasoningPrompt(
      `Issue: ${issueDescription}\n\nExploration:\n${JSON.stringify(exploration.repoMap.slice(0, 40), null, 2)}`,
      this.failureMemory.getRelevant(issueDescription),
      {
        practicalMode: usePracticalPrompt,
        taskStyle,
        benchmarkType: taskStyle,
        isStrongMode: isHighRigor,
        isStrictGlm: isHighRigor
      }
    );

    // 注入顺序（由 tierConfig 驱动）
    const styleHeader = BenchmarkProfiles.getPromptHeader(profile, isHighRigor && profile.defaultStrictIronLaws);
    if (!basePrompt.includes('当前任务风格') && !basePrompt.includes('任务风格') && !basePrompt.includes('当前 Benchmark')) {
      basePrompt = styleHeader + '\n' + basePrompt;
    }

    if (tierConfig.tier !== 'quick' && this.contextManager.getAnchorCount() > 0) {
      const anchorMaxChars = tierConfig.tier === 'standard' ? 10000 : 25000;
      const anchorContext = this.contextManager.toPromptContext(anchorMaxChars);
      if (anchorContext) basePrompt += `\n\n${anchorContext}`;
    }

    if (tierConfig.memoryLoadLevel !== 'none' && !config.memoryPreInjected) {
      try {
        const { RefinedMemoryStore } = await import('./memory/RefinedMemoryStore.js');
        const memStore = new RefinedMemoryStore(workspaceRoot);
        // M3.1: 走投影缓存（任务内快照冻结；任务边界 invalidateProjection 重建）
        const memoryCards = memStore.loadFilteredCached({
          taskStyle,
          tier: tierConfig.tier,
          maxCards: tierConfig.memoryLoadLevel === 'light' ? 3 :
                    tierConfig.memoryLoadLevel === 'medium' ? 6 :
                    tierConfig.memoryLoadLevel === 'high' ? 8 : 10,
        });
        if (memoryCards.length > 0) {
          const memBlock = `\n【提炼后的教训（来自历史项目记忆）】\n${memoryCards.map(c => `  - [${c.category}] ${c.summary}`).join('\n')}\n`;
          basePrompt += memBlock;
        }
        // M3.1: 任务边界 → 重建（下一任务反映最新衰减）
        this.memStoreForInvalidate = memStore;
      } catch {}
    }

    // 铁律/格式提示按 ironLawInjectionLevel 注入
    if (tierConfig.ironLawInjectionLevel !== 'none') {
      basePrompt += `\n\n${StructuredReasoner.buildGlmFormatEnforcementPrompt()}`;
    }

    // P0-B: 一次性收集静态分析结果（仅本次 solveIssue 执行一次）
    // 由 Reviewer 完成语言探测 + 白名单命令执行（tsc / eslint），失败不影响主流程。
    // 结果将透传给 VerifyCritiqueLoop，在 critique 阶段以 <static_analysis_result> 块形式注入，
    // 让模型在自我复盘时能“看见”编译/类型/ lint 错误（根治“灯下黑”）。
    let staticAnalysisResults: any[] = [];
    try {
      const { Reviewer } = await import('./review/Reviewer.js');
      const reviewer = new Reviewer(null, tierConfig.tier);
      staticAnalysisResults = await reviewer.collectStaticAnalysis(workspaceRoot);
    } catch {
      // 静态分析失败绝不影响主流程
      staticAnalysisResults = [];
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
      useUniversalAdapter: !isHighRigor,
      strictGlmOnly: isHighRigor,
      maxSteps: maxStepsPerRollout,
      maxConsecutiveFailures: tierConfig.maxConsecutiveFailures,
      failureMemory: this.failureMemory,
      verifyFirstBias: tierConfig.verifyFirstBias || profile.verifyFirstBias,
      practicalMode: !isHighRigor,
      isStrongMode: isHighRigor,
      taskStyle,
      benchmarkType: taskStyle,
      critiqueFrequency: tierConfig.critiqueFrequency,
      ironLawInjectionLevel: tierConfig.ironLawInjectionLevel,
      // P0-B: 把静态分析结果传给 Loop，供 critique 阶段注入
      staticAnalysis: staticAnalysisResults,
    };

    const best = await orchestrator.runMultiple(
      async (rolloutId: string) => {
        const dynamicOptions: VerifyCritiqueLoopOptions = { ...loopOptions };
        if (triggeredDegradation) {
          dynamicOptions.maxSteps = Math.max(5, Math.floor(maxStepsPerRollout * 0.5));
          if (dynamicOptions.critiqueFrequency) {
            dynamicOptions.critiqueFrequency = {
              ...dynamicOptions.critiqueFrequency,
              periodicEvery: dynamicOptions.critiqueFrequency.periodicEvery > 0 ? dynamicOptions.critiqueFrequency.periodicEvery * 2 : 0,
              skipFirstN: dynamicOptions.critiqueFrequency.skipFirstN + 1,
            };
          }
          if (dynamicOptions.ironLawInjectionLevel === 'highest') dynamicOptions.ironLawInjectionLevel = 'high';
          else if (dynamicOptions.ironLawInjectionLevel === 'high') dynamicOptions.ironLawInjectionLevel = 'medium';
          else if (dynamicOptions.ironLawInjectionLevel === 'medium_high') dynamicOptions.ironLawInjectionLevel = 'medium';
        }

        const useLegacyParser = process.env.PANSHA_USE_LEGACY_PARSER === '1';
        const originalClient = this.modelClient;

        // P1.2: streaming-aware wrapper (protocol v2 deltas).
        // When the underlying client exposes streamChat(), consume the token
        // stream, re-emit throttled thinking.delta / message.delta events via
        // onStep, and return the accumulated raw text so VerifyCritiqueLoop's
        // parsing path is untouched. Falls back to plain complete() otherwise.
        const makeStreamingComplete = (): ((prompt: string) => Promise<string>) => {
          const streamable = originalClient as any;
          if (typeof streamable?.streamChat !== 'function') {
            // Preserve original semantics: complete() may return a string OR an
            // object ({content, toolCalls...}) — VerifyCritiqueLoop handles both.
            return (prompt: string) => originalClient.complete(prompt);
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
          return async (prompt: string): Promise<string> => {
            let text = '';
            let startedThinking = false;
            let startedMessage = false;

            for await (const chunk of streamable.streamChat(prompt)) {
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
              ToolCallFormatDetector.probeAndParse(text, { strictGlmOnly: isHighRigor });
            } catch {}

            return text;
          };
        };

        const streamingComplete = makeStreamingComplete();

        // P0-1: Prefer ToolCallFormatDetector (new call site)
        // Falls back to legacy behavior when PANSHA_USE_LEGACY_PARSER=1
        const effectiveClient = useLegacyParser ? originalClient : {
          complete: streamingComplete,
        };

        // M1-2.1/2.5: real tool execution with approval passthrough.
        // The old inline stub ({ execute() { return 'ALL_TESTS_PASSED' } }) is
        // gone. Toolset = executor registry ∩ approval semantics (the adapter
        // gates bash via the readonly allowlist, writes via classify()).
        const engineAdapter = createEngineAdapter({
          workspaceRoot,
          tierConfig,
          failureMemory: this.failureMemory,
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

        const result = await loop.run(basePrompt + `\n\n[Rollout: ${rolloutId}]${extraFormat}`);

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

        // Emit critique if present
        if (lastStep?.critique) {
          config.onStep?.({
            version: 1,
            type: 'critique',
            rolloutId,
            stepNumber: result.steps.length,
            critique: lastStep.critique,
          });
        }

        const rolloutTokens = result.steps.reduce((sum, s) => {
          const reasoningLen = (s.reasoning?.thinking?.length || 0) + (s.reasoning?.plan?.length || 0);
          const resultLen = (s.verificationResult?.length || 0);
          const critiqueLen = (s.critique?.length || 0);
          return sum + Math.ceil((reasoningLen + resultLen + critiqueLen) / 4);
        }, 0);
        estimatedUsedTokens += rolloutTokens;
        stepsExecuted += result.steps.length;
        rolloutsExecuted++;

        if (estimatedUsedTokens >= budgetTokens * 0.7 && !triggeredSoftLimit) {
          triggeredSoftLimit = true;
          budgetNotes.push(`软限制触发：已使用约 ${estimatedUsedTokens} token（预算的 ${Math.round((estimatedUsedTokens / budgetTokens) * 100)}%）`);
          config.onStep?.({ version: 1, type: 'softLimit', usedRatio: estimatedUsedTokens / budgetTokens });
        }
        if (estimatedUsedTokens >= budgetTokens * 0.9 && !triggeredDegradation) {
          triggeredDegradation = true;
          budgetNotes.push(`行为降级触发：已使用约 ${estimatedUsedTokens} token。maxSteps 缩短，critique 周期翻倍，铁律强度降级`);
          config.onStep?.({ version: 1, type: 'degradation', reason: 'soft-limit-90%' });
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
          score: 0,
          isStrongTarget: isHighRigor,
          benchmarkType: taskStyle,
          taskStyle,
        };

        let score = result.success ? 88 : Math.max(30, 35 + result.steps.length * 2);
        if (tierConfig.isStrongMode) {
          const perfectFormats = result.steps.filter(s => !s.detectedFormat || String(s.detectedFormat).includes('strict')).length;
          score += perfectFormats * 3;
          const firstPass = result.steps.findIndex(s => s.verificationSignal === 'PASS' || s.verificationResult.includes('ALL_TESTS_PASSED'));
          if (firstPass >= 0) score += Math.max(0, 12 - firstPass * 2);
        }
        traj.score = Math.min(100, Math.max(0, score));
        return traj;
      },
      maxRollouts,
      { maxTokens: config.budgetTokens },
      {
        isStrongTarget: isHighRigor,
        benchmarkType: taskStyle,
        taskStyle,
        // D-parallel: high+ tiers run rollouts concurrently (Promise.allSettled,
        // write-mutex for shared workspace, budget aggregation); quick/standard
        // stay serial (cost-sensitive).
        parallel: ['high', 'max', 'ex', 'pangu'].includes(tierConfig.tier),
      }
    );

    const success = best.score >= 80;
    // M3.1: 任务边界 → 投影重建（下一任务反映最新衰减与记忆）
    try { this.memStoreForInvalidate?.invalidateProjection?.(); } catch {}
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

    return { success, bestTrajectory: best, score: best.score, totalRollouts: maxRollouts, budgetReport, tierConfig };
  }
}

/** 兼容别名 @deprecated */
export { PanshalachChaser as Glm53SweProChaser };
