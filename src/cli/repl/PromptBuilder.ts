// src/cli/repl/PromptBuilder.ts
// Rich prompt construction for ZIS (blueprint v1.1)
// Incorporates tierConfig (ironLaw, memoryLoad, critique hints) + recent turns + compaction

import type { Session } from './Session.js';
import type { Turn } from './types.js';
import type { TierConfig, IronLawInjectionLevel, Tier } from '../../tiers/TierConfig.js';

// ==================== L0 硬约束（≤3 条，非整段注入） ====================
export const L0_INVARIANTS: string[] = [
  '写前必读（RBW）：修改文件前先读目标文件',
  '变更需可验证：验证命令显式列出，不允许“逻辑上应该通过”',
  '斜杠命令本地执行，永不作为任务提交给引擎',
];

/** M2.1 预算红线断言：L0 超过 3 条即失败（测试调用）。 */
export function assertL0Count(): void {
  if (L0_INVARIANTS.length > 3) throw new Error('L0_INVARIANTS 超过 3 条（M2.1 预算红线）');
}

/** 确定性 token 估算 — ceil(asciiLen/4 + cjkLen×1.5)。纯函数。 */
export function estTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else ascii++;
  }
  return Math.ceil(ascii / 4 + cjk * 1.5);
}

export interface TierConstraint {
  tier: Tier;
  /** 结构化约束，注入到 Prompt（必须是 XML 形式） */
  xml: string;
  /** 自由文本补充（建设性口吻） */
  text: string;
}

const TIER_CONSTRAINTS: Record<Tier, TierConstraint> = {
  quick: {
    tier: 'quick',
    xml: `<tier_constraint tier="quick">
  <max_tool_calls_per_step>3</max_tool_calls_per_step>
  <forbid>deep_analysis, multi_file_refactor, long_verification_chains</forbid>
  <require>single_file_targeted_fix, minimal_verification</require>
  <execution_style>fast_and_shallow</execution_style>
</tier_constraint>`,
    text: '当前档位：quick（快速热修复）。建议做最小化、定向修改，避免深度分析与多文件重构。'
  },
  standard: {
    tier: 'standard',
    xml: `<tier_constraint tier="standard">
  <max_tool_calls_per_step>5</max_tool_calls_per_step>
  <forbid>unnecessary_exploration, redundant_verification</forbid>
  <require>read_before_write, basic_verification</require>
  <execution_style>balanced</execution_style>
</tier_constraint>`,
    text: '当前档位：standard（标准日常）。建议先读后写、保持基本验证。'
  },
  high: {
    tier: 'high',
    xml: `<tier_constraint tier="high">
  <max_tool_calls_per_step>8</max_tool_calls_per_step>
  <forbid>skipping_verification, premature_success_claims</forbid>
  <require>read_before_write, verify_before_claim, real_test_execution</require>
  <execution_style>thorough</execution_style>
</tier_constraint>`,
    text: '当前档位：high（高强度，推荐）。请完整验证后再声称完成。'
  },
  max: {
    tier: 'max',
    xml: `<tier_constraint tier="max">
  <mandatory_user_confirmation>all_write_operations</mandatory_user_confirmation>
  <forbid>write_without_confirmation, skip_plan</forbid>
  <require>explicit_plan_first, read_before_write, verify_before_claim, double_verification</require>
  <execution_style>cautious_and_planned</execution_style>
</tier_constraint>`,
    text: '当前档位：max（最大验证）。所有写操作必须经用户确认，先规划后执行。'
  },
  ex: {
    tier: 'ex',
    xml: `<tier_constraint tier="ex">
  <mandatory_user_confirmation>all_write_and_destructive_operations</mandatory_user_confirmation>
  <forbid>write_without_confirmation, skip_plan, weak_verification</forbid>
  <require>explicit_plan, read_before_write, verify_before_claim, multi_layer_verification</require>
  <execution_style>extremely_cautious</execution_style>
</tier_constraint>`,
    text: '当前档位：ex（极端）。极难任务，所有写操作必须确认，多层验证。'
  },
  pangu: {
    tier: 'pangu',
    xml: `<tier_constraint tier="pangu">
  <mandatory_user_confirmation>all_operations_with_budget_ack</mandatory_user_confirmation>
  <forbid>any_unconfirmed_action, weak_verification, budget_overrun</forbid>
  <require>explicit_plan, exhaustive_verification, budget_acknowledgment</require>
  <execution_style>ultimate_rigor</execution_style>
</tier_constraint>`,
    text: '当前档位：pangu（终极长程记忆模式）。极致追求，所有操作必须确认并遵守预算。'
  },
};

export class TierConstraintRegistry {
  static get(tier: Tier | string | undefined): TierConstraint {
    const t = (tier as Tier) || 'high';
    return TIER_CONSTRAINTS[t] ?? TIER_CONSTRAINTS['high'];
  }

  static getAll(): TierConstraint[] {
    return Object.values(TIER_CONSTRAINTS);
  }
}

/**
 * P1.5a: Tier → thinking-depth directive ladder (CC-inspired).
 * quick/standard stay terse; high begins structured reasoning; max deepens it;
 * ex/pangu get the deepest "ultrathink" level.
 */
export const TIER_THINKING_DIRECTIVE: Record<string, string> = {
  quick: '',
  standard: '',
  high: 'think',
  max: 'think hard',
  ex: 'ultrathink',
  pangu: 'ultrathink',
};

export interface InjectionSummary {
  tierConstraint: boolean;
  styleHeader: string | null;
  anchorCount: number;
  memoryCardCount: number;
  historyTurnCount: number;
  duplicatesSkipped: number;
}

/** buildForTask 扩展元信息（buildForTask 本体仍返回 string，元信息经 lastBuildMeta 暴露） */
export interface BuildResult {
  prompt: string;
  memoryCardCount: number;
  memoryOverflowCount: number;
  injectedCardIds: string[];
}

export class PromptBuilder {
  constructor(
    private session: Session,
    private tierConfig: TierConfig
  ) {}

  // per-build dedup set (reset every buildForTask)
  private injectedKeys = new Set<string>();
  private duplicatesSkipped = 0;
  // previous environment snapshot (for incremental env-delta injection)
  private prevEnvSnapshot: any = null;

  // collect relevant file hints from the current task for reference-based memory filtering
  private collectCurrentWorkspaceFiles(issue: string): string[] {
    if (!issue) return [];
    const files: string[] = [];
    // @path tokens (from P2-A style usage)
    const atRe = /@([^\s"'`]+)/g;
    let m: RegExpExecArray | null;
    while ((m = atRe.exec(issue)) !== null) {
      if (m[1]) files.push(m[1]);
    }
    // simple path-like tokens with common extensions
    const pathLike = /\b([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cpp|c|h|txt))\b/gi;
    while ((m = pathLike.exec(issue)) !== null) {
      if (m[1]) files.push(m[1]);
    }
    // also consider recent turn inputs for last context files
    const recent = this.session.turns.slice(-2);
    for (const t of recent) {
      if (t.userInput) {
        let m2: RegExpExecArray | null;
        const atRe2 = /@([^\s"'`]+)/g;
        while ((m2 = atRe2.exec(t.userInput)) !== null) if (m2[1]) files.push(m2[1]);
        const pl2 = /\b([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cpp|c|h|txt))\b/gi;
        while ((m2 = pl2.exec(t.userInput)) !== null) if (m2[1]) files.push(m2[1]);
      }
    }
    // dedup + keep reasonable count
    const uniq = Array.from(new Set(files.map(f => f.replace(/^\.\//, ''))));
    return uniq.slice(0, 20);
  }

  async buildForTask(issue: string): Promise<string> {
    // reset dedup state for this build
    this.injectedKeys = new Set<string>();
    this.duplicatesSkipped = 0;
    // reset per-build auto-pull state at build START (L1 populates ids later)
    this.autoPulledThisBuild = false;
    this.lastInjectedCardIds = [];
    this.lastKeywords = [];
    this.memoryNumberSeq = 0;

    const lines: string[] = [];

    // collect relevant workspace files from this task (for reference filtering)
    const currentWsFiles = this.collectCurrentWorkspaceFiles(issue);

    // === System identity (always) ===
    const systemLine = `你是烛龙（Zhulong），一个基于 openPangu 的记忆增强长程上下文智能体，面向软件工程长期维护场景（内部代号 Panshalach / 盘沙拉克）。当前档位: ${this.session.tier}（${this.tierConfig.typicalUseCase}）。`;
    lines.push(systemLine);

    // === L0 硬约束（≤3 条精选，非整段注入） ===
    assertL0Count();
    this.tryInject('l0-invariants', `\n【硬约束】\n${L0_INVARIANTS.map((i) => `- ${i}`).join('\n')}`, lines);

    // === Structured tier_constraint — MUST ALWAYS be injected (no dedup) ===
    const constraint = TierConstraintRegistry.get(this.session.tier);
    lines.push(constraint.xml);
    if (constraint.text) {
      lines.push(constraint.text);
    }

    // === Tier runtime contract (iron-law strength, memory, critique cadence) ===
    // Regression guard: buildForTask output must carry the tier contract details
    // (tests assert 纪律规则强度 presence in the task prompt, not only the header).
    this.tryInject('tier-runtime-contract', `\n【档位契约】\n${this.buildTierContract()}`, lines);

    // === fix-#9-①: negative tool list — names in the prompt are NOT tools ===
    // Root cause of the T7 dogfood drift: the model called iron_law_check /
    // thinking / plan / critique as if they were tools, because those words
    // appear in the tier contract text. Inject an explicit non-tool
    // declaration for ALL tiers (drift knows no tier).
    this.tryInject('negative-tool-list', [
      '',
      '<negative_tool_list>',
      '以下名称出现在本提示词中，但它们【不是】工具，禁止调用：',
      '· iron_law_check（纪律规则强度是配置说明，不是工具）',
      '· thinking / plan / critique / reasoning（思维链描述是内部过程，不是工具）',
      '· read / write / edit / bash / glob / grep（正确拼写见可用工具列表）',
      '· 任何未在【可用工具】列表中的名称',
      '如需读取文件，使用 read_file；如需修改，使用 edit_file 或 write_file。',
      '</negative_tool_list>',
    ], lines);

    // === /init closed loop (learn P0-2): inject the project's AGENTS.md
    // verification commands as an asset — the model no longer has to guess
    // how to verify ("不允许逻辑上应该通过" now has concrete commands).
    // AGENTS.md is generated by /init and read back HERE (it was written but
    // never consumed before). Best-effort: absent file → nothing injected.
    try {
      const { readProjectVerificationBlock } = await import('./projectInstructions.js');
      const block = readProjectVerificationBlock(this.session.workspace);
      if (block) {
        this.tryInject('project-verification', ['\n【项目验证命令（来自 .panshalach/AGENTS.md）】', block], lines);
      }
    } catch {
      // project instructions are best-effort
    }

    // === P4-4.7: plan-mode hard constraint (append-only block) ===
    if ((this.session as any).planMode === true) {
      this.tryInject(
        'plan-mode',
        '<plan_mode>计划模式激活。你 MUST NOT 执行任何写操作或 bash 命令。本轮只输出方案，等待用户批准。</plan_mode>',
        lines
      );
    }

    // === P1.5a: Thinking-budget ladder (Claude Code-inspired) ===
    // Map tier → thinking depth directive. Mirrors CC's think/think hard/ultrathink
    // ladder; for OpenAI-compatible endpoints this acts as an explicit
    // reasoning-depth instruction (no native thinking param today).
    const thinkKey = TIER_THINKING_DIRECTIVE[this.session.tier] ?? '';
    if (thinkKey) {
      this.tryInject(
        'thinking-budget',
        [
          `<thinking_budget>${thinkKey}</thinking_budget>`,
          '（请在内部推理时按上述思考深度展开：先在思考中穷举方案与风险，再输出结构化结果。低档位保持简洁，高档位深入推演。）',
        ],
        lines
      );
    }

    // === L1 — relevant memory cards (tier driven, kind-filtered,
    // relevance-sorted, preference seat reserved; source labels + ghost hint)
    const memAdded = await this.appendMemoryCardsDedup(lines, currentWsFiles, issue);
    // memoryCardCount will be computed from actual cards later if needed

    // === P5-5.1: skills injection (task-matched, dedup by key) ===
    try {
      const { loadSkills, matchSkills, truncateSkillContent } = await import('./skillsLoader.js');
      const matched = matchSkills(loadSkills(this.session.workspace), issue);
      if (matched.length > 0) {
        this.tryInject(
          'skills',
          [
            '\n【可用技能（任务命中，遵循其指引）】',
            ...matched.map((s) => `### ${s.name}\n${truncateSkillContent(s.content)}`),
          ],
          lines
        );
      }
    } catch {
      // skills are best-effort; never break the prompt build
    }

    // === L1 — active feature injection (only when an in-progress
    // feature exists; prompt-cache friendly, Pi semantics) ===
    try {
      const { loadFeatures, activeFeature } = await import('./FeatureTracker.js');
      const active = activeFeature(loadFeatures(this.session.workspace));
      if (active) {
        this.tryInject(
          'active-feature',
          [
            `\n【当前特性】${active.id}: ${active.title}${active.nextStep ? `\n下一步: ${active.nextStep}` : ''}`,
            '（聚焦该特性；完成后用 /feature done <id> <证据> 标记）',
          ],
          lines
        );
      }
    } catch {
      // feature tracking is best-effort
    }

    // === L1 — ENV self-description summary, KEYWORD-GATED (build|compile|
    // 构建|test|测试|依赖|install in the task) — not resident ===
    const ENV_KEYWORDS = /build|compile|构建|test|测试|依赖|install/i;
    if (ENV_KEYWORDS.test(issue || '')) {
      try {
        const { describeEnvironment, renderEnvSummary } = await import('./EnvContext.js');
        const summary = renderEnvSummary(describeEnvironment(this.session.workspace), 10);
        if (summary.trim()) {
          this.tryInject('env-self-desc', `\n【环境】\n${summary}`, lines);
        }
      } catch {
        // env self-description is best-effort
      }
    }

    // === incremental environment context — only CHANGED
    // fields are injected (cwd/branch/changed files); unchanged runs inject
    // nothing (token savings). ===
    try {
      const { snapshotEnv, buildEnvDelta, renderEnvDelta } = await import('./EnvContext.js');
      const now = snapshotEnv(this.session.workspace);
      const delta = buildEnvDelta(this.prevEnvSnapshot, now);
      this.prevEnvSnapshot = now;
      const block = renderEnvDelta(delta);
      if (block) {
        this.tryInject('env-delta', block, lines);
      }
    } catch {
      // env snapshot is best-effort (git may be absent)
    }

    // === Anchors note — dedup ===
    if (['high', 'max', 'ex', 'pangu'].includes(this.session.tier)) {
      this.tryInject('anchor-note', '\n（锚点将在探索阶段按档位自动选取关键文件与目录，用于上下文稳定）', lines);
    }

    // === Recent context (compact) — dedup ===
    const recent = this.getRecentContext(3);
    if (recent) {
      this.tryInject('recent-context', ['\n【最近上下文（最近 3 轮摘要）】', recent], lines);
    }

    // === Current task — dedup (in case of weird re-entrancy) ===
    this.tryInject('current-task', [`\n【当前任务】\n${issue}`], lines);

    // === Optional: crude compaction note — dedup ===
    if (this.session.turns.length > 12) {
      this.tryInject('compaction-note', '\n（历史较长，已做内部压缩，保留关键决策与用户原文要点）', lines);
    }

    const joined = lines.join('\n');
    const compacted = this.compactIfNeeded(joined);

    // === 探索阶段自动拉取（standard/high 触发一次；预算 ≤700 token；ghost 状态机）===
    const AUTO_PULL_TIERS = new Set(['standard', 'high']);
    const preAutoPullCount = this.lastInjectedCardIds.length; // L1 已注入 ids 数
    if (!this.autoPulledThisBuild && AUTO_PULL_TIERS.has(this.session.tier)) {
      try {
        const { RefinedMemoryStore } = await import('../../memory/RefinedMemoryStore.js');
        const memStore = new RefinedMemoryStore(this.session.workspace);
        const overflow = memStore.getOverflowCards(
          { tier: this.session.tier, keywords: this.lastKeywords, currentWorkspaceFiles: currentWsFiles.length ? currentWsFiles : undefined },
          this.lastInjectedCardIds
        );
        if (overflow.pulled.length > 0) {
          const label = (c: any): string => c.kind === 'preference' ? '[用户偏好]' : c.kind === 'success' ? '[成功经验]' : '[失败教训]';
          const lines2: string[] = [];
          const l1Tokens = estTokens(lines.filter((l) => l.includes('相关记忆')).join('\n'));
          let budget = 700 - l1Tokens;
          const addedCards: string[] = [];
          const n0 = this.memoryNumberSeq;
          let accepted = 0;
          for (const c of overflow.pulled) {
            const line = `  - [M${n0 + accepted + 1}] ${label(c)} ${c.summary.length > 120 ? c.summary.slice(0, 117) + '...' : c.summary}`;
            const cost = estTokens(line);
            if (budget - cost < 0) break; // 超预算放弃（不降级不重试）
            lines2.push(line);
            addedCards.push(c.id);
            accepted++;
            budget -= cost;
          }
          if (addedCards.length > 0) {
            const ghost = overflow.pulled.length > addedCards.length || overflow.totalRemaining > 0
              ? `\n（另有 ${overflow.totalRemaining + (overflow.pulled.length - addedCards.length)} 张相关，/memory 查看）`
              : '';
            this.tryInject('memory-extra', ['\n【额外记忆】', ...lines2, ghost], lines);
            this.lastInjectedCardIds = this.lastInjectedCardIds.concat(addedCards);
          }
        }
        this.autoPulledThisBuild = true; // 仅一次（同任务多轮不重复拉取）
      } catch {
        // auto-pull best-effort
      }
    }
    const memoryOverflowCount = this.lastInjectedCardIds.length - preAutoPullCount;

    const joined2 = lines.join('\n');
    const compacted2 = this.compactIfNeeded(joined2);

    // === injection summary at the very top (debug block) ===
    const summary: InjectionSummary = this.buildInjectionSummary();
    const summaryBlock = `<injection_summary>\n${JSON.stringify(summary, null, 2)}\n</injection_summary>\n`;

    this.lastBuildMeta = {
      prompt: summaryBlock + compacted2,
      memoryCardCount: this.injectedKeys.has('memory-cards') ? 1 : 0,
      memoryOverflowCount,
      injectedCardIds: [...this.lastInjectedCardIds],
    };
    return summaryBlock + compacted2;
  }

  /** 本 build 的元信息（buildForTask 返回值扩展——不破坏既有 string 返回） */
  lastBuildMeta: BuildResult | null = null;
  private autoPulledThisBuild = false;
  private lastInjectedCardIds: string[] = [];
  private lastKeywords: string[] = [];
  /** [M1] 卡号单一序列：跨 L1 记忆块与溢出块连续编号，顺序与 lastInjectedCardIds 严格一致（接口契约 v3） */
  private memoryNumberSeq = 0;

  private tryInject(key: string, block: string | string[], lines: string[]): boolean {
    if (this.injectedKeys.has(key)) {
      this.duplicatesSkipped++;
      return false;
    }
    this.injectedKeys.add(key);
    if (Array.isArray(block)) {
      lines.push(...block);
    } else {
      lines.push(block);
    }
    return true;
  }

  private async appendMemoryCardsDedup(lines: string[], currentWorkspaceFiles?: string[], issue?: string): Promise<boolean> {
    const level = this.tierConfig.memoryLoadLevel;
    if (level === 'none') return false;

    try {
      const { RefinedMemoryStore } = await import('../../memory/RefinedMemoryStore.js');
      const memStore = new RefinedMemoryStore(this.session.workspace);
      // use pre-collected relevant files (from caller) for reference filtering
      const currentFiles = currentWorkspaceFiles && currentWorkspaceFiles.length ? currentWorkspaceFiles : undefined;
      // 任务关键词 → 相关性排序（0.7×weight + 0.3×relevance）
      const keywords = (issue ?? '').split(/\s+/).map(w => w.replace(/^[/@#]/, '')).filter(w => w.length >= 2);
      this.lastKeywords = keywords;
      const allCards = memStore.loadFiltered({
        tier: this.session.tier,
        currentWorkspaceFiles: currentFiles,
        keywords,
      });
      const maxCards = this.memoryCardLimitForLevel(level);
      const overflow = allCards.length > maxCards;
      const cards = allCards.slice(0, maxCards);
      if (cards.length > 0) {
        // 来源标签（注入安全：preference 必须有 [用户偏好] 标签）
        const label = (c: any): string => c.kind === 'preference' ? '[用户偏好]' : c.kind === 'success' ? '[成功经验]' : '[失败教训]';
        const ghost = overflow ? `\n（另有 ${allCards.length - cards.length} 张相关记忆未注入，/memory 查看）` : '';
        const n0 = this.memoryNumberSeq;
        const added = this.tryInject('memory-cards', [
          '\n【相关记忆】',
          ...cards.map((c, i) => {
            const one = c.summary.length > 120 ? c.summary.slice(0, 117) + '...' : c.summary;
            return `  - [M${n0 + i + 1}] ${label(c)} ${one}`;
          }),
          ghost,
        ], lines);
        if (added) this.memoryNumberSeq += cards.length;
        // 注入编号契约：lastInjectedCardIds 顺序 == [M*] 渲染顺序（含溢出块续号）
        this.lastInjectedCardIds = this.lastInjectedCardIds.concat(cards.map(c => c.id));
        return added;
      }
      this.lastInjectedCardIds = [];
    } catch {
      // best effort
    }
    return false;
  }

  private buildInjectionSummary(): InjectionSummary {
    // We don't have direct counts of styleHeader/anchors here because we deduped them.
    // We report what we know.
    return {
      tierConstraint: true, // always injected per P0-2
      styleHeader: null,    // current implementation uses tier_constraint instead of old style header
      anchorCount: this.injectedKeys.has('anchor-note') ? 1 : 0,
      memoryCardCount: this.injectedKeys.has('memory-cards') ? 1 : 0, // simplified: presence flag
      historyTurnCount: this.session.turns.length,
      duplicatesSkipped: this.duplicatesSkipped,
    };
  }

  private async appendMemoryCards(lines: string[]): Promise<void> {
    const level = this.tierConfig.memoryLoadLevel;
    if (level === 'none') return;

    try {
      const { RefinedMemoryStore } = await import('../../memory/RefinedMemoryStore.js');
      const memStore = new RefinedMemoryStore(this.session.workspace);
      // collect from a neutral string (best effort for legacy path)
      const currentFiles = this.collectCurrentWorkspaceFiles('');
      const cards = memStore.loadFiltered({
        tier: this.session.tier,
        maxCards: this.memoryCardLimitForLevel(level),
        currentWorkspaceFiles: currentFiles.length ? currentFiles : undefined,
      });
      if (cards.length > 0) {
        lines.push('\n【提炼后的教训（来自历史项目记忆）】');
        for (const c of cards) {
          const one = c.summary.length > 120 ? c.summary.slice(0, 117) + '...' : c.summary;
          lines.push(`  - [${c.category}] ${one}`);
        }
      }
    } catch {
      // best effort; memory is optional for REPL prompt
    }
  }

  private memoryCardLimitForLevel(level: TierConfig['memoryLoadLevel']): number {
    if (level === 'light') return 3;
    if (level === 'medium') return 6;
    if (level === 'high') return 8;
    if (level === 'full') return 10;
    return 4;
  }

  /**
   * Build a tier-specific contract block based on TierConfig.
   * This drives iron-law injection level, memory expectations, critique cadence, etc.
   */
  private buildTierContract(): string {
    const t = this.tierConfig;
    const iron = this.describeIron(t.ironLawInjectionLevel);
    const mem = this.describeMemory(t.memoryLoadLevel);
    const parts: string[] = [];
    parts.push(`纪律规则强度: ${iron}`);
    parts.push(`记忆加载: ${mem}`);
    parts.push(`探索深度: ${t.explorationDepth}，并行度: ${t.parallelRollouts}，锚点上限: ${t.anchorMax}`);
    if (t.userConfirmationRequired) {
      parts.push('高风险档位：涉及写操作或高预算时需用户确认。');
    }
    if (t.verifyFirstBias) {
      parts.push('偏好先验证后修改（Verify-Before-Claim）。');
    }
    // Core immutable engineering laws (always present, strength varies by iron level)
    parts.push('核心纪律规则（强度随档位变化）：Read-Before-Write、标准 <> 工具调用格式、变更需可验证、可回滚。');

    return parts.join('；');
  }

  private describeIron(level: IronLawInjectionLevel): string {
    switch (level) {
      case 'none': return '无（快速模式，极简纪律）';
      case 'minimal': return '极简（仅关键节点提醒）';
      case 'low': return '轻量（基础格式与顺序检查）';
      case 'medium': return '中等（常规纪律规则 + 格式 + 证据要求）';
      case 'medium_high': return '中高（强格式 + 证据 + 边界覆盖）';
      case 'high': return '高（严格纪律规则 + 多轮自查 + 证据链）';
      case 'highest': return '极高（终极长程记忆级，全面纪律规则 + 最高证据密度）';
      default: return String(level);
    }
  }

  private describeMemory(level: TierConfig['memoryLoadLevel']): string {
    switch (level) {
      case 'none': return '不加载历史记忆';
      case 'light': return '轻量（3 条以内）';
      case 'medium': return '中等（~6 条）';
      case 'high': return '高强度（~8 条）';
      case 'full': return '全量（~10 条 + 强过滤）';
      default: return String(level);
    }
  }

  /**
   * Return a compact summary of the last N turns.
   * Truncates long user inputs and keeps only key signals.
   */
  private getRecentContext(n: number): string {
    const turns = this.session.turns.slice(-n);
    if (turns.length === 0) return '';
    return turns
      .map((t, i) => {
        const input = t.userInput.length > 80 ? t.userInput.slice(0, 77) + '...' : t.userInput;
        const ok = t.result?.success ? '✓' : (t.result ? '✗' : '?');
        const score = t.result ? (t.result.summary || '?') : ''; // summary 现为验证结果短文本（如"已通过验证"）
        return `Turn ${i + 1} [${t.tier}] ${ok} ${input} ${score}`.trim();
      })
      .join('\n');
  }

  /**
   * Optional: produce a "system only" header for cases where we want to prepend without the task.
   */
  buildSystemHeader(): string {
    return [
      `你是烛龙（Zhulong），档位 ${this.session.tier}。`,
      this.buildTierContract()
    ].join('\n');
  }

  /**
   * Crude compaction helper.
   * If total "context size" is large, return a shorter version of the last prompt.
   * This is a lightweight safeguard; real compression can be added later.
   */
  compactIfNeeded(fullPrompt: string, maxChars = 120_000): string {
    if (fullPrompt.length <= maxChars) return fullPrompt;
    // Keep the first ~30% (system + contract) and the last ~40% (recent task)
    const head = Math.floor(maxChars * 0.30);
    const tail = Math.floor(maxChars * 0.40);
    const headPart = fullPrompt.slice(0, head);
    const tailPart = fullPrompt.slice(-tail);
    return headPart + '\n...[中间历史已压缩]...\n' + tailPart;
  }
}
