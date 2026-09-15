// src/cli/repl/PromptBuilder.ts
// Rich prompt construction for ZIS (blueprint v1.1)
// Incorporates tierConfig (ironLaw, memoryLoad, critique hints) + recent turns + compaction

import type { Session } from './Session.js';
import type { Turn } from './types.js';
import type { TierConfig, IronLawInjectionLevel, Tier } from '../../tiers/TierConfig.js';
import type { TaskIntent } from '../taskIntent.js';
import { estTokens, resolveWindowTokens } from './tokenEstimate.js';
import { resolveToday } from '../../memory/timeAnchor.js';
// 写侧/渲染侧共享字符帽（SENTENCE_HARD_CUT_CHARS=普通卡渲染帽=句切分硬切；
// PAIR_Q_CHARS=对卡 Q 行上限）——渲染侧与 chatFactMemory 写侧同源，防
// "写 800/渲 400"或"写 240/渲 120"的失配（上一轮 review 揪过的复发现象）。
// C2（2026-09-14）：对卡 A 行渲染用 smartSlice + PAIR_A_RENDER_CHARS(400) 做数字句
// 优先二次裁剪（写侧 PAIR_A_CHARS=800 不动——盘上数据不丢，渲染时才裁）。
import { SENTENCE_HARD_CUT_CHARS, PAIR_Q_CHARS, PAIR_A_CHARS, PAIR_A_RENDER_CHARS, smartSlice } from '../../memory/chatFactMemory.js';

// estTokens 收口到共享模块 ./tokenEstimate.ts（压缩触发/loop 预算/REPL 计量
// 三处必须同源）；此处 re-export 维持既有导入路径兼容（tests/memory/*）。
export { estTokens };

/**
 * G6：句边界截断——预算内截到最后一个句末标点（句号/问号/叹号/省略号）；
 * 找不到足够长的句边界才硬切。修复：旧 slice(0,117) 会把卡的后半段答案剪掉
 * （实测 18.5% 的可播种句超 120 字符，LongMemEval 恰是"答案就在某句里"）。
 */
export function truncateAtSentence(text: string, budget: number): string {
  const t = String(text ?? '');
  if (t.length <= budget) return t;
  const head = t.slice(0, budget + 3);
  const m = head.match(/[\s\S]*[。．！？!?]/);
  const cut = m && m[0].length >= Math.floor(budget * 0.5) ? m[0] : t.slice(0, budget);
  return cut.trimEnd() + '...';
}

/**
 * C1（2026-09-13 对卡渲染）：source==='dialogue-pair' 的卡不走 truncateAtSentence
 * （句边界截断曾把已落卡事实腰斩），改为分行渲染——Q 行 ≤160 字 + A 行 ≤400 字
 * （smartSlice 数字句优先），label 用 [对话记忆]。其他卡渲染不变（单行、句边界截断）。
 * 2026-09-14：普通卡渲染帽 120→SENTENCE_HARD_CUT_CHARS(240)（ZL vs CC 头号杀手
 * ——gold 数字/专名在第 120-400 字符段被 120 切线截掉）；对卡 Q 行用 PAIR_Q_CHARS。
 * C2（2026-09-14 LME 归因）：A 行由 slice(0,800) 改 smartSlice(400)——写侧 800
 * 落盘不丢数据，渲染时数字句优先裁进 400 段（配合 C4 数字句前置，单卡注入成本
 * 下降、819→1229 预算能装更多张对卡）。
 * 返回行数组（对卡 1-2 行，普通卡 1 行）。
 */
function renderMemoryCardLines(
  card: any,
  seq: number,
  label: (c: any) => string,
  factTag: (c: any) => string
): string[] {
  const head = `  - [M${seq}] ${label(card)}${factTag(card)} `;
  if (card?.source === 'dialogue-pair') {
    const s = String(card.summary ?? '');
    const nl = s.indexOf('\n');
    const q = (nl >= 0 ? s.slice(0, nl) : s).replace(/^Q:\s*/i, '').slice(0, PAIR_Q_CHARS);
    // C2 迭代回退（it2-1b 实证 assistant 8→5/user 7→5 回退）：400 裁剪对 gold
    // 位于长答复中后段的题型是净损失——渲染与写侧 PAIR_A_CHARS(800) 同源不裁
    const a = smartSlice((nl >= 0 ? s.slice(nl + 1) : '').replace(/^A:\s*/i, ''), PAIR_A_CHARS);
    void PAIR_A_RENDER_CHARS;
    return a ? [`${head}Q: ${q}`, `    A: ${a}`] : [`${head}Q: ${q}`];
  }
  return [`${head}${truncateAtSentence(card?.summary, SENTENCE_HARD_CUT_CHARS)}`];
}

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
    text: '当前档位：high（标准纪律，推荐）。请完整验证后再声称完成。'
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

// ==================== 关键词抽取（检索通路迭代包 2026-09-13） ====================

// 0.8.2：stopword 过滤（LME 真机实证——英文疑问句切出的 what/was/my 等
// 停用词占满相关性命中，区分度归零）；中文走 CJK 分支（下方）。
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'who', 'how', 'why', 'which', 'did', 'do', 'does', 'did', 'have', 'has', 'had', 'i', 'my', 'me', 'we', 'our', 'you', 'your', 'it', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'and', 'or', 'that', 'this', 'there', 'was', 'first', 'last', 'can', 'will', 'would', 'should', 'did']);

/** CJK 判定：[一-龥]（URO 4E00-9FA5）放宽为 \u3000-\u9fff（含 CJK 符号/标点，
 * 对齐 chatFactMemory confidenceOf 的包C 缺陷6b 修正）。 */
const CJK_CHAR_RE = /[\u3000-\u9fff]/;
/** 短句切分边界：中英文常用标点 + 空白。 */
const CJK_PHRASE_SPLIT_RE = /[\s，。！？!?；;、：:…]+/;
/** CJK 停用 2-gram（虚词组合——2-gram 兜底时跳过，对记忆检索零区分度）。 */
/** 最近对话轮窗口（buildMemoryQueryText 与 runAgentTask.buildChatRecentTurnsBlock 同源）。 */
export const RECENT_TURN_WINDOW = 2;

const CJK_STOP_2GRAMS = new Set([
  '的呢', '了吗', '是的', '一个', '什么', '怎么', '可以', '我们', '你们', '没有',
  '就是', '这个', '那个', '这是', '不是', '还是', '但是', '所以', '如果', '而且',
  '或者', '自己', '时候', '这样', '那样', '你的', '我的', '他们',
]);
const MAX_CJK_KEYWORDS = 16;
// 短句直采上限 8 字（2026-09-14 迭代：20→8）——9-20 字短语降为 2-gram 词粒度：
// 整句短语做 summary.includes 永不命中（"北京那边有多少同事"整句不在任何卡里），
// 词粒度才能让 Q 侧加权/词面通道在共享词干扰下区分 gold（ChineseRetrieval 干扰卡
// 用例实证：粒度不足时双方 rel=0，新近度决胜顶掉 gold）。
const MAX_PHRASE_CHARS = 8;
const MAX_2GRAMS_PER_PHRASE = 12;

/**
 * 单个含 CJK token 的关键词展开（无空格中文此前恒整句 token → 词面永不命中）：
 *  - 数字串（含"3月"）单独成关键词；数字位从余文剔除、前后文拼回（避免碎词）；
 *  - 余文按标点切短句，每个短句一个关键词（CJK 总数 cap 16）；
 *  - 短句仍 >20 字 → 字符 2-gram 滑窗兜底（cap 12，跳过含非汉字/虚词的组）。
 */
function extractCjkTokenKeywords(token: string, out: string[]): void {
  const add = (kw: string): void => {
    const t = kw.trim();
    if (t.length < 2 || out.length >= MAX_CJK_KEYWORDS || out.includes(t)) return;
    out.push(t);
  };
  // 数字后吞单位词（审查建议-1：旧只吞 1 个 CJK 把"5公里"撕成"5公"+"跑步里每周六"）
  const NUM_RE = /\d+(?:公里|千米|米|年|个月|月|日|天|号|点|周|次|个|小时|分钟|秒|元|块|岁|层|度|%|％)?/g;
  for (const d of token.match(NUM_RE) ?? []) add(d);
  const rest = token.replace(NUM_RE, '');
  for (const phrase of rest.split(CJK_PHRASE_SPLIT_RE)) {
    const p = phrase.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (p.length < 2) continue;
    // 审查建议-1：中英混排长 token 的 ASCII 连续段（AuthModule/bug）独立成关键词——
    // 下方 2-gram 只收纯汉字，不提取会整段丢失（旧整句 token 也永不命中，此处是真增益）
    for (const ascii of p.match(/[A-Za-z][A-Za-z0-9_.-]+/g) ?? []) {
      if (ascii.length >= 2) add(ascii);
    }
    if (p.length <= MAX_PHRASE_CHARS) {
      add(p);
      continue;
    }
    let grams = 0;
    for (let i = 0; i + 1 < p.length && grams < MAX_2GRAMS_PER_PHRASE && out.length < MAX_CJK_KEYWORDS; i++) {
      const g = p.slice(i, i + 2);
      if (!/^[\u4e00-\u9fff]{2}$/.test(g)) continue; // 含非汉字（标点/数字/字母）的组跳过
      if (CJK_STOP_2GRAMS.has(g)) continue;          // 虚词 2-gram 跳过
      add(g);
      grams++;
    }
  }
}

/**
 * 任务关键词抽取：ASCII token 走既有逻辑（STOPWORDS 过滤——英文行为逐字节
 * 不变）；含 CJK 的 token 走 extractCjkTokenKeywords（中文检索通路修复）。
 */
export function extractKeywordsFromIssue(issue: string): string[] {
  const keywords: string[] = [];
  for (const raw of String(issue ?? '').split(/\s+/)) {
    const w = raw.replace(/^[/@#]/, '');
    if (CJK_CHAR_RE.test(w)) extractCjkTokenKeywords(w, keywords);
    else if (w.length >= 2 && !STOPWORDS.has(w.toLowerCase())) keywords.push(w);
  }
  return keywords;
}

export class PromptBuilder {
  constructor(
    private session: Session,
    private tierConfig: TierConfig
  ) {}

  // 0.8.2：最近一次 build 注入的记忆块独立文本（chat 直答干净组装用）
  private lastMemoryBlockText = '';

  /** 最近一次注入的【相关记忆】块（无注入 → 空串）。chat 直答的 user 应为
   *  "此块 + 用户原话"——绝不能整段 enriched 塞进 user（1B 元话语根因）。 */
  getChatMemoryBlock(): string {
    return this.lastMemoryBlockText;
  }

  // per-build dedup set (reset every buildForTask)
  private injectedKeys = new Set<string>();
  private duplicatesSkipped = 0;
  // previous environment snapshot (for incremental env-delta injection)
  private prevEnvSnapshot: any = null;
  // 0.8 P2（M1-PROTOCOL）：三段拆分的共享行缓冲（buildForTask = summary 块 + stable + volatile 拼接）
  private buildLines: string[] = [];
  /** 本 build 溢出记忆拉取数（auto-pull 前后 injectedCardIds 差）。 */
  private lastMemoryOverflowCount = 0;
  /** R4（0.8.1）：本 build 的意图（chat 跳过 tier XML → injection summary 如实反映）。 */
  private lastBuildIntent?: TaskIntent;

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
    const recent = this.session.turns.slice(-RECENT_TURN_WINDOW);
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

  /**
   * F7（0.7）：按意图分支注入。intent 传 'chat' 时不注入重工程块——
   * L0 硬约束（验证铁律）、档位契约（纪律规则强度）、negative_tool_list
   * （格式教学）、项目验证命令（AGENTS.md 验证块）——纯对话 prompt 保持轻量；
   * 其余块（身份、tier_constraint XML、记忆、上下文、当前任务）保留。
   * 可选参数：不传 intent = 原有行为完全不变（向后兼容，execution 等价现状）。
   * 接线现状：调用方（Repl.executeTask / RunCommand / runAgentTask）目前尚无
   * intent 信息（分类发生在 chaser.solveIssue 内），故仅参数化，接线待意图分类前移。
   */
  async buildForTask(issue: string, intent?: TaskIntent): Promise<string> {
    // 0.8 P2（M1-PROTOCOL）三段拆分：stable（任务间字节级不变）+ volatile（每任务变）。
    // 对外产物与 0.7.4 逐字节等价（summary 块 + 两段拼接 + 压缩）。
    this.lastBuildIntent = intent;
    const stable = this.buildStableSegment(intent);
    const volatile = await this.buildVolatileSegment(issue, intent);
    const joined2 = this.buildLines.join('\n');
    const compacted2 = this.compactIfNeeded(joined2);

    // === injection summary：内部审计信息不进模型 prompt（红队实测：模型会
    // 讨论内部字段名造成元讨论污染）。审计摘要仍由 buildInjectionSummary 产出
    // 供宿主/审计消费，只是不再拼进发往模型的 prompt。
    const summary: InjectionSummary = this.buildInjectionSummary();
    void summary;
    this.lastBuildMeta = {
      prompt: compacted2,
      memoryCardCount: this.injectedKeys.has('memory-cards') ? 1 : 0,
      memoryOverflowCount: this.lastMemoryOverflowCount,
      injectedCardIds: [...this.lastInjectedCardIds],
    };
    return compacted2;
  }

  /** 每次 build 的共享状态复位（幂等——stable/volatile 入口均可调用，序列调用不受影响）。 */
  private resetBuildState(): void {
    this.injectedKeys = new Set<string>();
    this.duplicatesSkipped = 0;
    // reset per-build auto-pull state at build START (L1 populates ids later)
    this.autoPulledThisBuild = false;
    this.lastInjectedCardIds = [];
    this.lastKeywords = [];
    this.memoryNumberSeq = 0;
  }

  /**
   * 0.8 P2（M1-PROTOCOL）三段拆分之一：stable 段——任务间字节级不变的部分：
   * 身份 + L0 硬约束 + tier 契约（XML + 文本 + 运行时契约）+ negative_tool_list。
   * intent='chat' 时跳过重工程块（L0/档位契约/negative list——F7 语义不变）。
   * messages 模式下由 chaser 置于 role:'system' 首消息（任务间字节级相同 →
   * 网关前缀缓存可命中）。
   */
  buildStableSegment(intent?: TaskIntent): string {
    this.resetBuildState();
    this.buildLines = [];
    const start = this.buildLines.length;

    // === System identity (always) ===
    // 身份画像（2026-09-12 真机反馈）：通用全能智能体，工程是强项不是边界——
    // 1B 小模型曾把"面向软件工程长期维护场景"理解成"只答工程"（真机实证：英国
    // 历史追问被拒、话题被拉回 CI/CD）。档位语义显式限定为工程执行参数，防复读。
    // 时间锚定（0.8.3）：身份行带"今天是 …"——QA prompt 此前没有今天是几号，
    // "多久之前/多少周"类问题无从计算（temporal-reasoning 0/15 主因之二）。
    // 放 stable 段：resolveToday() 天内不变 → 天内字节稳定（前缀缓存友好）。
    const systemLine = `你是烛龙（Zhulong），基于 openPangu 构建的通用智能体（内部代号 Panshalach / 盘沙拉克）：软件工程（读写代码、执行命令、验证变更）与日常对话、知识问答、写作创作皆为所长。工程任务按当前档位契约执行；普通问题直接给出答案本身，不以工程助手自居设限。当前档位: ${this.session.tier}（${this.tierConfig.typicalUseCase}）——它只调节工程任务的执行预算与验证密度，与普通对话无关。当前工作区: ${this.session.workspace || process.cwd()}（工具的相对路径均以此为基准目录）。今天是 ${resolveToday()}。`;
    this.buildLines.push(systemLine);

    // === L0 硬约束（≤3 条精选，非整段注入） ===
    // F7：chat 意图跳过重工程块（验证铁律：写前必读/变更需可验证）——纯对话不做
    // 工程纪律教学；不传 intent 时行为不变（向后兼容）。
    assertL0Count();
    if (intent !== 'chat') {
      this.tryInject('l0-invariants', `\n【硬约束】\n${L0_INVARIANTS.map((i) => `- ${i}`).join('\n')}`, this.buildLines);
    }

    // === Structured tier_constraint — MUST ALWAYS be injected (no dedup) ===
    // R4（0.8.1）：chat 意图跳过——tier XML 是工具纪律/验证节奏契约，与 chat
    // 指令"不要调用任何工具"同框自相矛盾（chat 净荷 985→约500 chars 的主力块）。
    // 非 chat 路径保持 MUST ALWAYS（无 dedup）语义不变。
    if (intent !== 'chat') {
      const constraint = TierConstraintRegistry.get(this.session.tier);
      this.buildLines.push(constraint.xml);
      if (constraint.text) {
        this.buildLines.push(constraint.text);
      }
    }

    // === Tier runtime contract (iron-law strength, memory, critique cadence) ===
    // Regression guard: buildForTask output must carry the tier contract details
    // (tests assert 纪律规则强度 presence in the task prompt, not only the header).
    // F7：chat 意图跳过（纪律规则强度/核心纪律规则是重工程块）。
    if (intent !== 'chat') {
      this.tryInject('tier-runtime-contract', `\n【档位契约】\n${this.buildTierContract()}`, this.buildLines);
    }

    // === negative tool list — names in the prompt are NOT tools ===
    // Root cause of the observed drift: the model called iron_law_check /
    // thinking / plan / critique as if they were tools, because those words
    // appear in the tier contract text. Inject an explicit non-tool
    // declaration for ALL tiers (drift knows no tier).
    // F7：chat 意图跳过（这是格式教学块，纯对话无工具调用）。
    if (intent !== 'chat') {
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
      ], this.buildLines);
    }

    return this.buildLines.slice(start).join('\n');
  }

  /**
   * 0.8 P2（M1-PROTOCOL）三段拆分之二：volatile 段——每任务变的部分：
   * 项目验证命令/plan-mode/thinking-budget/记忆卡/技能/特性/ENV/锚点/任务状态/
   * 最近上下文/当前任务/压缩注记 + 溢出记忆拉取（auto-pull）。
   * messages 模式下由 chaser 与任务文本合流进首条 user。
   */
  async buildVolatileSegment(issue: string, intent?: TaskIntent): Promise<string> {
    this.resetBuildState();
    const lines = this.buildLines;
    const start = lines.length;

    // collect relevant workspace files from this task (for reference filtering)
    const currentWsFiles = this.collectCurrentWorkspaceFiles(issue);

    // === /init closed loop (learn P0-2): inject the project's AGENTS.md
    // verification commands as an asset — the model no longer has to guess
    // how to verify ("不允许逻辑上应该通过" now has concrete commands).
    // AGENTS.md is generated by /init and read back HERE (it was written but
    // never consumed before). Best-effort: absent file → nothing injected.
    // F7：chat 意图跳过（项目验证命令块属于验证铁律教学）。
    if (intent !== 'chat') {
      try {
        const { readProjectVerificationBlock } = await import('./projectInstructions.js');
        const block = readProjectVerificationBlock(this.session.workspace);
        if (block) {
          this.tryInject('project-verification', ['\n【项目验证命令（来自 .panshalach/AGENTS.md）】', block], lines);
        }
      } catch {
        // project instructions are best-effort
      }
    }

    // === plan-mode hard constraint (append-only block) ===
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
    // R4（0.8.1）：chat 意图跳过思考深度阶梯（纯对话不需要推理深度教学）。
    if (thinkKey && intent !== 'chat') {
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

    // === skills injection (task-matched, dedup by key) ===
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

    // === TaskState control-plane injection (U3) ===
    // Keep this block immediately before recent-context: the task state is a
    // stable, task-scoped prefix while recent turns remain the volatile tail.
    // R4（0.8.1）：chat 意图跳过（任务控制面状态与直答无关，且 chat 不调工具）。
    if (intent !== 'chat' && this.session.currentTaskId) {
      try {
        const { TaskStateStore } = await import('../../memory/taskState.js');
        const state = new TaskStateStore(this.session.workspace, process.env.PANSHA_TASK_STATE_FILE?.trim() || undefined).get(this.session.currentTaskId);
        if (state) {
          const linesForState: string[] = [
            '\n【任务状态】',
            `任务编号：${state.taskId}`,
            `原始需求：${state.originalRequirement}`,
          ];
          if (state.currentGoal) linesForState.push(`当前目标：${state.currentGoal}`);
          if (state.decisions.length > 0) {
            linesForState.push('已做决定：', ...state.decisions.map((d) => `- ${d.what}${d.why ? `（原因：${d.why}）` : ''}`));
          }
          if (state.milestones.length > 0) {
            linesForState.push('里程碑：', ...state.milestones.map((m) => `- [${m.done ? 'x' : ' '}] ${m.title}${m.evidence ? `（${m.evidence}）` : ''}`));
          }
          if (state.verified.length > 0) {
            linesForState.push('已验证：', ...state.verified.map((v) => `- ${v.what}`));
          }
          if (state.risks.length > 0) {
            linesForState.push('风险：', ...state.risks.map((r) => `- ${r.risk}${r.mitigation ? `（应对：${r.mitigation}）` : ''}`));
          }
          if (state.nextStep) linesForState.push(`下一步：${state.nextStep}`);
          this.tryInject('task-state', linesForState, lines);
        }
      } catch {
        // TaskState is best-effort; a missing/corrupt state file must not break prompts.
      }
    }

    // === Recent context (compact) — dedup ===
    const recent = this.getRecentContext(3);
    if (recent) {
      this.tryInject('recent-context', ['\n【最近上下文（最近 3 轮摘要）】', recent], lines);
    }

    // === Current task — dedup (in case of weird re-entrancy) ===
    this.tryInject('current-task', [`\n【当前任务】\n${issue}`], lines);

    // === 历史压缩摘要（B3：接真——压缩收益从此真正进入 prompt）===
    // 合成轮 userInput 以 [COMPACT] 开头、result.summary 为摘要正文；压缩后
    // 合成轮固定在 turns 前端，getRecentContext(3) 永远取不到——在此显式注入。
    // 无合成轮且历史较长时给诚实提示（旧行为是无压缩却声称"已做内部压缩"）。
    {
      const synthetic = this.session.turns.find((t) => String(t.userInput || '').startsWith('[COMPACT]'));
      if (synthetic && synthetic.result?.summary) {
        const summary = String(synthetic.result.summary);
        // C3（0.8.2 审查）：注入 cap 从固定 1500 字符改窗口比例预算
        // min(6000 字符, 15% 窗口 tokens×4)——旧 cap ÷ 24 轮 ≈ 62 字符/轮，
        // "逐字保留"的用户指令在注入面全灭（30 轮会话跨任务带宽仅窗口 4-8%）。
        let budgetChars = 6000;
        try {
          const w = resolveWindowTokens((this.session as any).provider, this.session.model);
          budgetChars = Math.min(6000, Math.floor(w * 0.15 * 4));
        } catch {}
        const capped = summary.length > budgetChars ? summary.slice(0, budgetChars) + '…[摘要已截断]' : summary;
        this.tryInject('compaction-note', [`\n【历史压缩摘要】`, capped], lines);
      } else if (this.session.turns.length > 12) {
        this.tryInject('compaction-note', `\n（历史较长：${this.session.turns.length} 轮，更早轮次未注入。如需把早期关键背景带进上下文，可用 /compact 生成压缩摘要。）`, lines);
      }
    }

    // === 探索阶段自动拉取（standard/high 触发一次；预算 = L1 预算 tokens（窗口未知回退 700）；ghost 状态机）===
    // 【2】auto-pull 审计如实（2026-09-13 迭代包）：chat 意图不做 auto-pull——
    // chat user 只含 lastMemoryBlockText（L1 块），额外卡本就进不了 chat 净荷，
    // 拉取只白耗嵌入计算，且 lastInjectedCardIds 照常并入使注入审计虚报
    // （实测 8K 窗 ids=17 vs chat 块可见 12）。选择申报：采用"intent 门禁"
    // 方案而非"lastMemoryBlockText 组装后移"——后者会让 chat 净荷膨胀、违反
    // 0.8.2 chat 净化的预算纪律。intent 参数在 buildVolatileSegment 签名内可用。
    const preAutoPullCount = this.lastInjectedCardIds.length; // L1 已注入 ids 数
    if (!this.autoPulledThisBuild && this.tierConfig.autoPullMemory && intent !== 'chat') {
      try {
        const { RefinedMemoryStore } = await import('../../memory/RefinedMemoryStore.js');
        const memStore = new RefinedMemoryStore(this.session.workspace);
        const overflow = memStore.getOverflowCards(
          {
            tier: this.session.tier,
            keywords: this.lastKeywords,
            currentWorkspaceFiles: currentWsFiles.length ? currentWsFiles : undefined,
            // C3/B5：溢出拉取与 L1 同源查询（投影 key 已含查询文本，不串槽）
            queryText: this.buildMemoryQueryText(issue),
            semantic: process.env.PANSHA_SEMANTIC_SEARCH !== '0',
          },
          this.lastInjectedCardIds
        );
        if (overflow.pulled.length > 0) {
          const label = (c: any): string =>
            c.source === 'dialogue-pair' ? '[对话记忆]'
              : c.kind === 'preference' ? '[用户偏好]'
              : c.kind === 'success' ? '[成功经验]' : '[失败教训]';
          // 0.8.3 时间锚定：卡带 factDateText → 渲染 [事实时间:…]（老卡无字段不变）
          const factTag = (c: any): string => c?.factDateText ? ` [事实时间:${c.factDateText}]` : '';
          const lines2: string[] = [];
          const l1Tokens = estTokens(lines.filter((l) => l.includes('相关记忆')).join('\n'));
          // C2：溢出块预算与 L1 同源（window 感知），700 仅作窗口未知回退
          let budget = this.memoryBudgetTokens() - l1Tokens;
          const addedCards: string[] = [];
          const n0 = this.memoryNumberSeq;
          let accepted = 0;
          for (const c of overflow.pulled) {
            const cardLines = renderMemoryCardLines(c, n0 + accepted + 1, label, factTag);
            const cost = estTokens(cardLines.join('\n'));
            if (budget - cost < 0) break; // 超预算放弃（不降级不重试）
            lines2.push(...cardLines);
            addedCards.push(c.id);
            accepted++;
            budget -= cost;
          }
          if (addedCards.length > 0) {
            // 注意：此处 ghost 有意保留 \n 前缀——lastMemoryBlockText 过滤器靠
            // startsWith('（另有') 只放行 L1 ghost；去掉 \n 会把溢出 ghost 泄进
            // chat 净荷（与 L1 的去 \n 修复方向相反，勿顺手统一）。
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
    this.lastMemoryOverflowCount = memoryOverflowCount;

    return lines.slice(start).join('\n');
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
    // R6 eval: PANSHA_NO_MEMORY=1 → B 档零注入（防线失败基准），强制跳过记忆卡注入
    if (process.env.PANSHA_NO_MEMORY === '1') return false;
    const level = this.tierConfig.memoryLoadLevel;
    if (level === 'none') return false;

    try {
      const { RefinedMemoryStore } = await import('../../memory/RefinedMemoryStore.js');
      const memStore = new RefinedMemoryStore(this.session.workspace);
      // use pre-collected relevant files (from caller) for reference filtering
      const currentFiles = currentWorkspaceFiles && currentWorkspaceFiles.length ? currentWorkspaceFiles : undefined;
      // 任务关键词 → 相关性排序（0.7×weight + 0.3×relevance）
      // 0.8.2：stopword 过滤（英文）；【1】检索通路迭代包（2026-09-13）：
      // 无空格中文此前恒整句 token → 词面永不命中，改为 CJK 分支（数字串/短句/
      // 2-gram 兜底，见 extractKeywordsFromIssue）——ASCII 路径逐字节不变。
      const keywords = extractKeywordsFromIssue(issue ?? '');
      this.lastKeywords = keywords;
      // C3（2026-09-13 混合检索接线）：查询侧从只有 issue 扩为
      // "issue + 最近 2 轮 userInput/answerText 各前 200 字符"，传 loadFiltered 的
      // queryText；语义通道默认开（PANSHA_SEMANTIC_SEARCH=0 显式关闭）。
      const queryText = this.buildMemoryQueryText(issue ?? '');
      const semantic = process.env.PANSHA_SEMANTIC_SEARCH !== '0';
      const allCards = memStore.loadFiltered({
        tier: this.session.tier,
        currentWorkspaceFiles: currentFiles,
        keywords,
        queryText,
        semantic,
      });
      const maxCards = this.memoryCardLimitForLevel(level);
      // 审查 FAIL-1：对卡实际成本 122-470 token/张（英文/中文），41 系数张数帽
      // 在小窗口+对卡多时超发 3-11 倍（8K 窗极端可注满整个窗口）。改为按渲染后
      // 实测 token 贪心装入窗口比例预算；张数帽仅作上限，至少保 1 张。
      const budgetTokens = this.memoryBudgetForLevel(level);
      const label = (c: any): string =>
        c.source === 'dialogue-pair' ? '[对话记忆]'
          : c.kind === 'preference' ? '[用户偏好]'
          : c.kind === 'success' ? '[成功经验]' : '[失败教训]';
      // 0.8.3 时间锚定：卡带 factDateText → 渲染 [事实时间:…]（老卡无字段不变）
      const factTag = (c: any): string => c?.factDateText ? ` [事实时间:${c.factDateText}]` : '';
      const chosen: Array<{ card: any; lines: string[]; tokens: number }> = [];
      let usedTokens = 0;
      for (let i = 0; i < allCards.length && chosen.length < maxCards; i++) {
        const ls = renderMemoryCardLines(allCards[i], this.memoryNumberSeq + chosen.length + 1, label, factTag);
        const t = ls.reduce((acc, l) => acc + estTokens(l), 0);
        // R1（2026-09-14 LME 归因）：装不下的大卡跳过（continue）而非终止（旧
        // break 让一张大卡后面的所有小卡全部落选——819 token 预算实际只装 3.8 张
        // 对卡的第一瓶颈）。首卡超预算仍收（chosen.length===0 短路）="至少保 1 张"
        // 语义保留。
        if (chosen.length > 0 && usedTokens + t > budgetTokens) continue;
        chosen.push({ card: allCards[i], lines: ls, tokens: t });
        usedTokens += t;
      }
      // C1(a)（2026-09-14 LME 归因）：注入渲染按 factDate 升序稳定重排——后注入者
      // = 事实时间更新者，配合规则行"以[事实时间]最新的一条为准"（C1b）让 1B 的
      // "取最后一条"启发式指向新值（KU 新旧值选错是管道主动误导）。无 factDate 的
      // 老卡排最后、之间保持原序；重排只影响渲染顺序与编号，不改入选集合与 token
      // 预算账（chosen/tokens 在重排前已定）。
      const ordered = chosen
        .map((e, idx) => ({ e, idx }))
        .sort((a, b) => {
          const da = a.e.card?.factDate;
          const db = b.e.card?.factDate;
          const hasA = typeof da === 'number' && Number.isFinite(da);
          const hasB = typeof db === 'number' && Number.isFinite(db);
          if (hasA !== hasB) return hasA ? -1 : 1; // 有 factDate 在前，无者排最后
          if (hasA && hasB && da !== db) return (da as number) - (db as number); // 升序
          return a.idx - b.idx; // 稳定：同日期/均无日期保持原序
        })
        .map((x) => x.e);
      const cards: any[] = [];
      const rendered: string[][] = [];
      ordered.forEach((e, j) => {
        cards.push(e.card);
        // [M*] 编号按重排后顺序连续编（契约：lastInjectedCardIds 顺序 == [M*] 渲染顺序）
        rendered.push(renderMemoryCardLines(e.card, this.memoryNumberSeq + j + 1, label, factTag));
      });
      const overflow = cards.length < allCards.length;
      if (cards.length > 0) {
        // 【3】ghost 行修复（2026-09-13 迭代包）：模板原来的 '\n' 前缀让
        // lastMemoryBlockText 过滤器的 l.startsWith('（另有') 永不匹配 → chat 块
        // 永远没有"另有 N 张"提示。tryInject 的 lines 数组本身分行（join('\n')），
        // 前导 '\n' 多余且破坏 startsWith 过滤——去掉后 rich 渲染不变（仍换行）。
        const ghost = overflow ? `（另有 ${allCards.length - cards.length} 张相关记忆未注入，/memory 查看）` : '';
        const n0 = this.memoryNumberSeq;
        const added = this.tryInject('memory-cards', [
          '\n【相关记忆】',
          // G3 最小版：知识更新指令——冲突事实并存时以后注入者为准（配合
          // 卡内日期前缀，1B 级模型也能据此选新弃旧；此前旧事实因插入序靠前
          // 被优先采纳，knowledge-update 题全 0 的直接原因之一）。
          // 0.8.3：原"带 [S日期] 前缀的以日期较新者为准"是悬空规则——全代码库
          // 无任何路径产出 [S日期] 前缀（grep 证实）。替换为事实时间差值规则，
          // 与今天（身份行）+ [事实时间:…] 标注配套，"多久之前/多少周"可计算。
          // C1b（2026-09-14 LME 归因）：追加冲突规则——配合 C1a 的 factDate 升序
          // 注入，"取最后一条"启发式即指向[事实时间]最新的新值。
          // L1（2026-09-14 LME 归因）：追加答案语言镜像——语言/单位不匹配 6 题
          // （提问英文而答复中文数字单位）。仍在同一行（chat 块过滤器按
          // l.includes('（规则：') 整行放行，拆行会从 chat 净荷丢失）。
          '（规则：记忆卡【】内的日期与[事实时间:...]标注的是事实发生时间；计算"多久之前/多少周"时用它与今天的差值，不要用其他时间戳。同一事实出现新旧不同数值时，以[事实时间]最新的一条为准。以用户提问的语言作答，数字与单位保留提问原文的写法（如提问为英文则以英文数字+单位作答）。）',
          // C1：对卡分行渲染（Q ≤160；A 行 smartSlice 400 数字句优先——写侧 800
          // 不动，见 renderMemoryCardLines），普通卡单行截 240；
          // 行集已在 token 门按预算贪心生成并按 factDate 升序重排（rendered），此处只拼接
          ...rendered.flat(),
          ghost,
        ], lines);
        if (added) {
          this.memoryNumberSeq += cards.length;
          // 包C 缺陷12：concat 必须在 if 内——tryInject 因 key 去重跳过时块未
          // 渲染，先行 concat 会产出没有 [M*] 行对应的孤儿 id（下游 markInjected /
          // ContextSnapshot 审计到"注入了看不见的卡"）。
          // 注入编号契约：lastInjectedCardIds 顺序 == [M*] 渲染顺序（含溢出块续号）
          this.lastInjectedCardIds = this.lastInjectedCardIds.concat(cards.map(c => c.id));
        }
        // 0.8.2：独立记忆块文本（chat 直答干净组装用——chat 的 user 应是
        // "记忆块 + 用户原话"，而不是整段 enriched prompt 外壳，否则 1B 被
        // 结构块噪音拖垮、元话语复发）。非 chat 也存，无副作用。
        const memStart = lines.findIndex((l) => l.includes('【相关记忆】'));
        if (memStart >= 0) {
          this.lastMemoryBlockText = lines.slice(memStart)
            .filter((l) => l.includes('【相关记忆】') || l.includes('（规则：') || l.startsWith('  - [M') || l.startsWith('    A: ') || l.startsWith('（另有'))
            .join('\n');
        }
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
      // R4（0.8.1）：chat 意图跳过 tier XML → summary 如实反映（不再恒 true）
      tierConstraint: this.lastBuildIntent !== 'chat',
      styleHeader: null,    // current implementation uses tier_constraint instead of old style header
      memoryCardCount: this.injectedKeys.has('memory-cards') ? 1 : 0, // simplified: presence flag
      historyTurnCount: this.session.turns.length,
      duplicatesSkipped: this.duplicatesSkipped,
    };
  }

  /**
   * C2（2026-09-13 注入预算 token 化）+ 2026-09-14 随窗口放大 + R2 统一 15%：
   * 注入预算 tokens = min(ceil(window×15%), max(1600, floor(window/64)))。
   *   - R2（2026-09-14 LME 归因）：旧 8K 档 10% 删除、统一 15%。归因数据：819
   *     token 预算实际只装 3.8 张对卡，是注入面第一瓶颈；8192→1229（+R1 贪心
   *     skip + 对卡 A 行渲染 400/C2）≈ 6-7 张。比例项用 ceil：floor(8192×0.15)
   *     =1228，归因报告按 1229 锚定（预算利用率优先）；大窗口比例项远超帽，
   *     ceil/floor 不影响结果（32K→1600 帽不变、1M→15625 不变）。
   *   - 固定卡数帽不随窗口伸缩是错的——8K 与 128K 窗口给同样的 8 张，要么撑爆
   *     小窗要么浪费大窗。
   *   - 上限由固定 1600 改为 max(1600, floor(w/64))：1M 窗→15625（多会话大库
   *     73-80 卡可全注，旧帽只放进 ~15%）；32K 窗→floor(32768/64)=512→仍 1600、
   *     8K 窗→128→仍 1600>1229（帽不 binding）。
   * 窗口未知/异常回退 700（旧溢出块常量，语义=保守小预算）。
   */
  private memoryBudgetTokens(): number {
    try {
      const w = resolveWindowTokens((this.session as any).provider, this.session.model);
      return Math.min(Math.ceil(w * 0.15), Math.max(1600, Math.floor(w / 64)));
    } catch {
      return 700;
    }
  }

  /** 按 memoryLoadLevel 对 token 预算施加乘数（medium=1.0 基准：light 0.6 / high 1.2 / full 1.4 / none 0）。 */
  private memoryBudgetForLevel(level: TierConfig['memoryLoadLevel']): number {
    const mult = MEMORY_LEVEL_BUDGET_MULT[level] ?? 1.0;
    return Math.round(this.memoryBudgetTokens() * mult);
  }

  private memoryCardLimitForLevel(level: TierConfig['memoryLoadLevel']): number {
    // 0.8.2 评测逃生门：LME 等 memory-QA 场景对齐"全量注入"对照口径
    // （Pi/CC 实验把整个 memory 文件塞进上下文）。评测格依赖它——env 显式
    // 设置时张数帽完全维持现状；注意 >100K 窗口下 token 门预算仍随窗口放大
    // （memoryBudgetForLevel 的 max(1600, w/64)），env 仅覆盖张数帽（review 申报）。
    const envLimit = Number(process.env.PANSHA_MEMORY_LIMIT);
    if (Number.isFinite(envLimit) && envLimit > 0) return envLimit;
    // C2：窗口感知张数——budget/41（41 为混合短卡经验值；对卡/Q/A 双行由渲染后
    // estTokens 门实际约束，张数帽仅作上限），
    // clamp 到 [6, 200]：下限 6 保证轻量档最小可见性，上限 200 让 1M 窗下大库
    // （73-80 卡）可全注（旧 40 帽 32K 窗仍 39 不变；1M 窗 381→cap 200）。
    // level 现真正差异化（MEMORY_LEVEL_BUDGET_MULT 乘数）；'none' 档在调用方已拦截。
    const budget = this.memoryBudgetForLevel(level);
    return Math.max(6, Math.min(Math.floor(budget / 41), 200));
  }

  /**
   * C3（2026-09-13 混合检索接线）：记忆检索查询文本 = 当前任务 + 最近 2 轮的
   * userInput/answerText。
   * 【3】查询稀释修复（2026-09-13 迭代包）：探查实证 77 字无关历史前缀把 gold
   * cos 0.119 砸到 0.030——改为 issue 权重主导：issue 重复拼接两次置顶（嵌入
   * 权重加倍）+ 最近 2 轮 userInput/answerText 各截前 60 字符（原 200）；长
   * issue 时 issue 字符占比 ≥2/3。保留函数签名（仅查询文本形状变化）。
   */
  private buildMemoryQueryText(issue: string): string {
    // 审查建议-6 诚实申报：短 issue 场景稀释仍存（issue 双拼只把"9 字 issue +
    // 240 字历史"的占比从 ~4% 提到 ~7%），彻底解需语义通道按段加权（ROADMAP）。
    // 窗口常量 RECENT_TURN_WINDOW 与 runAgentTask.buildChatRecentTurnsBlock 同源。
    const iss = String(issue ?? '').replace(/\s+/g, ' ').trim();
    const parts: string[] = [iss, iss];
    for (const t of this.session.turns.slice(-RECENT_TURN_WINDOW)) {
      const u = String(t?.userInput ?? '').replace(/\s+/g, ' ').trim();
      if (u) parts.push(u.slice(0, 60));
      const a = String((t as any)?.result?.answerText ?? '').replace(/\s+/g, ' ').trim();
      if (a) parts.push(a.slice(0, 60));
    }
    return parts.filter(Boolean).join(' ');
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
    if (t.verifyFirstBias) {
      parts.push('偏好先验证后修改（Verify-Before-Claim）。');
    }
    // Core immutable engineering laws (always present, strength varies by iron level)
    parts.push('核心纪律规则（强度随档位变化）：Read-Before-Write、标准 <> 工具调用格式、变更需可验证、可回滚。');

    return parts.join('；');
  }

  private describeIron(level: IronLawInjectionLevel | undefined): string {
    if (level === undefined) return '实用模式（无强制纪律）';
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
      // 0.8.3 注入量已窗口感知（窗口比例预算 + 实测 token 门），固定条数自描述失真（审查建议-8）
      case 'light': return '轻量（小预算）';
      case 'medium': return '中等（中等预算）';
      case 'high': return '高强度（较大预算）';
      case 'full': return '全量（最大预算 + 强过滤）';
      default: return String(level);
    }
  }

  /**
   * Return a compact summary of the last N turns.
   * Truncates long user inputs and keeps only key signals.
   * R6（0.8.1）：answered 回合带上答案前 200 字符——resume/最近上下文可见
   * 问答对（此前只见问不见答，模型对"刚才答了什么"失忆）。
   */
  private getRecentContext(n: number): string {
    const turns = this.session.turns.slice(-n);
    if (turns.length === 0) return '';
    return turns
      .map((t, i) => {
        const input = t.userInput.length > 80 ? t.userInput.slice(0, 77) + '...' : t.userInput;
        const ok = t.result?.success ? '✓' : (t.result ? '✗' : '?');
        const score = t.result ? (t.result.summary || '?') : ''; // summary 现为验证结果短文本（如"已通过验证"）
        // R6：答案摘要（截 200 字符，换行折叠为空格防摘要行被撑爆）
        const answer = t.result?.answerText
          ? ' → ' + String(t.result.answerText).replace(/\s+/g, ' ').trim().slice(0, 200)
          : '';
        return `Turn ${i + 1} [${t.tier}] ${ok} ${input} ${score}${answer}`.trim();
      })
      .join('\n');
  }

  /**
   * Optional: produce a "system only" header for cases where we want to prepend without the task.
   */
  buildSystemHeader(): string {
    return [
      `你是烛龙（Zhulong），通用智能体——工程任务与日常对话、知识问答皆可，档位 ${this.session.tier}。`,
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

// ==================== memoryLoadLevel 四档 token 预算乘数（#2 真差异化） ====================
// medium=1.0 为基准（high 档 memoryLoadLevel='medium' 是默认档/评测甜点位，
// 行为必须保持不变）；PANSHA_MEMORY_LIMIT env 逃生门优先级最高，不受乘数影响。
const MEMORY_LEVEL_BUDGET_MULT: Record<TierConfig['memoryLoadLevel'], number> = {
  // 'none' 档产品层已无 tier 使用（quick 已改 'light'），保留仅为类型完备；
  // appendMemoryCardsDedup 对 'none' 早退，故 mult=0 实际不可达。
  none: 0, light: 0.6, medium: 1.0, high: 1.2, full: 1.4,
};
