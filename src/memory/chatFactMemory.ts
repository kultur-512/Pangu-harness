// src/memory/chatFactMemory.ts
// 对话事实记忆（0.8.2 · LongMemEval 真机驱动的新产品能力）：
// chat 直答回合结束后，把"用户说了什么 + 答复要点"确定性沉淀为记忆卡。
//
// 设计约束（控制人 2026-09-13 裁决的推论）：
//  - 确定性实现，不经 LLM 抽取——1B/7B 模型抽取不可控（同 Assertion 抽取器
//    推迟的理由）；事实以原文摘录形式入卡，检索靠既有关键词相关性链路。
//  - 零额外推理成本——宿主在回合边界直接落卡，不发模型请求。
//  - kind='preference'（用户相关事实）+ memoryCategory='insight'
//    （high 档可见性：failure|implementation|insight——general 在默认档不可见，
//    若用 general 则对话记忆永不注入，功能形同虚设）。
//  - 降速衰减：weight 0.8（低于工程卡 2.0，容量淘汰 tiebreak 时优先让位）——
//    【4】排序公平性（2026-09-13 迭代包，review 纠正算式）：对卡恒带
//    decayWeight 1.0，而 effBase 的 base = decayWeight ?? weight（优先级！），
//    故 weight 不进衰减 effBase——0.8 仅作用于容量排序 tiebreak 与无
//    decayWeight 卡。真正的出局门修复载体是对卡基线 0.85：旧 effBase 新鲜
//    1.0×0.6=0.6、两段衰减 ×0.4=0.24<0.3 硬出局；0.85 基线后两段衰减
//    1.0×0.4×0.85=0.34≥0.3 入围（见 RefinedMemoryStore calculateEffectiveBase）。
//  - 逃生门：PANSHA_CHAT_MEMORY=0 关闭（默认开）。
//  - 时间锚定（0.8.3）：区分"何时记的"（lastSeen，衰减语义不动）与"记的是
//    何时的事"（factDate/factDateText，新增；卡前缀同步改为日期级事实时间，
//    去掉时分秒）——旧前缀把 Date.now() 冒充事实时间，评测当天 ≠ 事实当天
//    是 temporal-reasoning 题型 0/15 的假日期污染主因。
import { createHash } from 'node:crypto';
import { RefinedMemoryStore } from './RefinedMemoryStore.js';
import { resolveToday } from './timeAnchor.js';

const hashId = (seed: string): string => createHash('sha1').update(seed).digest('hex').slice(0, 12);

const MIN_INPUT_CHARS = 8;
// 写路径"宽进严排"（2026-09-13 裁决）：旧 MAX_CARDS_PER_TURN=3 分侧帽与
// MAX_TOTAL_CARDS=80 硬拒绝删除——每侧句级补充 ≤2、整轮总帽 8；溢出治理交给
// RefinedMemoryStore.applyCapacityLimits 的 kind 分桶淘汰（新进旧出）。
const MAX_SUPPLEMENT_PER_SIDE = 2;
const MAX_CARDS_PER_TURN_TOTAL = 8;
/** 句级补充卡的置信阈值（A2）：低于此值的句子不再单独成卡，但不阻断对卡。 */
const SUPPLEMENT_CONFIDENCE = 0.7;
/** 句级补充卡的最短句长（确定无信息量的碎片仍拦在写入侧）。 */
const MIN_SENTENCE_CHARS = 12;

/**
 * 句置信分类器（0.8.2 句级拆卡 → 2026-09-13 宽进严排改造）：
 * isFactSentence 的硬判定改为连续置信度，供两层消费——
 *   1) 句级补充卡只在 confidenceOf >= 0.7 时发射（每侧 ≤2）；
 *   2) 对卡携带 confidence 入盘，检索端按 (0.5 + 0.5×confidence) 软惩罚
 *     （替代旧"低置信整轮拒收"的硬门，质量判断后移到检索排序）。
 * 分档：含数字=1.0；含 CJK=0.8；第一人称词+大写开头=0.7；全大写缩写=0.7；其余=0.4。
 */
export const confidenceOf = (x: string): number => {
  const t = String(x ?? '').trim();
  if (/\d/.test(t)) return 1.0;                          // 数字/日期/度量
  // 包C 缺陷6b：[一-龥]（URO 4E00-9FA5）过窄 → 与包 B 对齐的 CJK 范围：
  // CJK 符号标音 3000-9FFF + Ext-A 3400-4DBF + 全角形式 FF00-FFEF。
  if (/[\u3000-\u9fff\u3400-\u4dbf\uff00-\uffef]/.test(t)) return 0.8;
  // 包C 缺陷6a：\b 词界——任何含字母 i 的英文句（unit/testing/nice…）不算
  // 第一人称；第一人称词 + 大写开头才算 0.7 档。
  if (/\b(?:my|i|we|our)\b/i.test(t) && /^[A-Z]/.test(t)) return 0.7; // 第一人称专名句
  if (/\p{Lu}{2,}/u.test(t)) return 0.7;                  // 全大写缩写
  return 0.4;
};

/**
 * 事实日期解析（0.8.3）：从 sessionDate（LME haystack_dates 形如
 * "2023/01/19 (Thu) 05:19"；也兼容 ISO "2023-01-19T05:19:00"）取日期部分。
 * 返回 null = 解析失败。组件回环校验防 Date 滚动误收（如 02-31 → 03-03）。
 */
export interface FactDate {
  /** 该日 00:00 的 UTC ms */
  ms: number;
  /** yyyy-MM-dd（卡前缀与渲染共用，无时分秒） */
  text: string;
}

export function parseFactDate(s: string | undefined): FactDate | null {
  const m = String(s ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { ms, text: `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** 今天作为事实日期（产品路径不传 sessionDate 时的回退，语义=当天发生）。 */
function todayFact(): FactDate {
  const today = resolveToday();
  const [y, mo, d] = today.split('-').map(Number);
  return { ms: Date.UTC(y, mo - 1, d), text: today };
}

/**
 * 去重键 = 剥离【…】前缀后的句子内容（包C 缺陷6c）：turnTag 是时间戳，
 * 拼进 summary 且去重键取 summary 全等 → 跨时间同一句被当成新卡重复落盘。
 * summary 仍带时间戳供展示，仅去重键剥离。0.8.3：前缀从分钟级改为日期级
 * （`【对话事实·用户·2023-01-19】`），本正则按内容无关的【…】剥离，两种
 * 格式（及未来的时间粒度变化）都照常工作。
 */
const stripTurnTag = (s: string): string => String(s ?? '').replace(/^【[^】]*】/, '');

/** 切分器（第三轮修正）：先按行、再按句、超长硬切——无句号结尾的长轮
 *  此前被整段丢弃（真机 18 题实证：12 轮只落 10 张，bike 轮缺席）。
 *  A6 缩写保护（2026-09-13）：切句前把常见缩写的点替换为占位符，切后还原——
 *  旧实现把 "Dr. Smith" 切成 "Dr." + "Smith…"，首片过短被丢，gold 直接损失。 */
const ABBR_PLACEHOLDER = '\u0001';
const ABBR_RE = /\b(Dr|Mr|Mrs|Ms|St|vs|Inc|No|Fig|e\.g|i\.e)\./g;
const restoreAbbrDot = (s: string): string => s.split(ABBR_PLACEHOLDER).join('.');

export function splitSentences(text: string): string[] {
  const guarded = String(text ?? '').replace(ABBR_RE, `$1${ABBR_PLACEHOLDER}`);
  const out: string[] = [];
  for (const line of guarded.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 句末标点含全角（。．！？）——旧 ASCII [.!?] 类从未切开中文句（整行成"一句"，
    // 中文"句级拆卡"实为行级；SMART 式数字句优先同样失效）。对齐 truncateAtSentence
    // 的句末字符类（truncateAtSentence 一直含全角）。
    const parts = trimmed.match(/[^。．！？.!?]*[。．！？.!?]+|[^。．！？.!?]+$/g) ?? [trimmed];
    for (const part of parts) {
      let p = part.trim();
      if (!p) continue;
      while (p.length > 240) {
        out.push(restoreAbbrDot(p.slice(0, 240)));
        p = p.slice(240);
      }
      if (p) out.push(restoreAbbrDot(p));
    }
  }
  return out;
}

/**
 * 截断保留策略（0.8.2 真机修正）：LongMemEval 的 gold 多为数字/日期/专名，
 * 常在答复中后段——朴素截 80 字符会把关键事实截掉（真机实证：PB 成绩卡
 * "Congratulations on your personal best time in the 5K run! T..." 数字被截，
 * 模型看到卡也答不出）。策略：按句切分，含数字的句子优先保留，超预算再截。
 */
function smartSlice(text: string, budget: number): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= budget) return t;
  // 句末标点含全角（对齐 splitSentences / truncateAtSentence）——旧 ASCII 类对
  // 中文长答复切不出句，第一遍数字句优先与第二遍补齐双双落空 → A 侧为空。
  const sentences = t.match(/[^。．！？.!?]*[。．！？.!?]+|[^。．！？.!?]+$/g) ?? [t];
  const hasDigit = sentences.map((x) => /\d/.test(x));
  const picked: string[] = [];
  let len = 0;
  // 第一遍：含数字的句子优先
  for (let i = 0; i < sentences.length; i++) {
    if (!hasDigit[i]) continue;
    if (len + sentences[i].length > budget) break;
    picked.push(sentences[i]);
    len += sentences[i].length;
  }
  // 第二遍：按序补齐
  for (let i = 0; i < sentences.length && len < budget; i++) {
    if (picked.includes(sentences[i])) continue;
    if (len + sentences[i].length > budget) break;
    picked.push(sentences[i]);
    len += sentences[i].length;
  }
  // 兜底：无任何完整句装得下预算（如首个"句"超长）→ 硬切，绝不返回空串
  const out = picked.join(' ').trim();
  if (!out) return t.slice(0, budget);
  return out.length > budget ? out.slice(0, budget) : out;
}

/** 问候/纯噪音/元命令——不入卡（防"1"/"你好"刷屏容量）。 */
const NOISE_RE = /^(你好|您好|嗨|hi|hello|hey|在吗|谢谢|thanks?|再见|拜拜|好的?|ok|嗯+)[\s!！。.,，]*$|^\d+$/i;

export interface ChatFactResult {
  recorded: boolean;
  reason?: 'disabled' | 'too-short' | 'noise' | 'duplicate';
  cardId?: string;
}

/**
 * 评测直落卡（0.8.2）：LME memory 文件的浓缩事实行逐行落卡——跳过噪音门/
 * 最短长度门（浓缩行非自然对话），保留去重与 schema。评测专用，产品路径
 * 仍走 recordConversationTurn 的保守门。
 * 0.8.3：opts.sessionDate 可解析时为卡补 factDate/factDateText（事实时间
 * 字段）；不传/解析失败 → 不带字段（事实时间以行内自带的日期标注为准，
 * 老卡渲染不变）。
 */
export async function recordFactLines(
  workspace: string,
  lines: string[],
  opts?: { sessionDate?: string }
): Promise<{ recorded: number; total: number }> {
  try {
    if (process.env.PANSHA_CHAT_MEMORY === '0') return { recorded: 0, total: lines.length };
    const store = new RefinedMemoryStore(workspace);
    const file = store.load();
    const now = Date.now();
    const fact = parseFactDate(opts?.sessionDate);
    const existing = new Set(file.cards.map((c) => c.summary));
    const cards = [];
    for (const raw of lines) {
      const line = String(raw ?? '').trim();
      if (line.length < 4 || existing.has(line)) continue;
      cards.push({
        id: hashId(`chatfact-${line}`),
        kind: 'preference' as const,
        category: 'OTHER' as const,
        memoryCategory: 'insight' as const,
        summary: line,
        weight: 0.7,
        taskStyle: 'all',
        count: 1,
        lastSeen: now,
        firstSeen: now,
        applicableTiers: [],
        sourceContext: '评测记忆文件事实行（LME）',
        decayWeight: 1.0,
        lastUsedAt: now,
        ...(fact ? { factDate: fact.ms, factDateText: fact.text } : {}),
      });
      existing.add(line);
    }
    // 包C 缺陷2：返回真实 save 后落盘数——旧实现返回 recorded=cards.length
    // （save() 容量截断前的候选数），save() 的 {written, capped} 被丢弃，返回值
    // 谎报。现按本批 id 在盘上的实际存活数计（容量淘汰后与磁盘一致）。
    let recorded = 0;
    if (cards.length > 0) {
      store.save(cards as any);
      const ids = new Set(cards.map((c) => c.id));
      recorded = store.load().cards.filter((c) => ids.has(c.id)).length;
    }
    return { recorded, total: lines.length };
  } catch {
    return { recorded: 0, total: lines.length };
  }
}

export interface ConversationTurnResult {
  recorded: number;
  reason?: 'disabled' | 'too-short' | 'noise' | 'duplicate';
  cardIds?: string[];
}

/**
 * 记录一条对话事实卡。任何失败都不抛出（记忆写入绝不影响对话主流程）。
 * @param workspace 工作区（记忆文件所在）
 * @param userInput 用户原话（截 80 字符入 summary）
 * @param answer    助手答复（截 80 字符入 summary）
 * @param opts.sessionDate 该轮对话的事实发生时间（如 "2023/01/19 (Thu) 05:19"）；
 *        可解析 → 卡前缀/factDate 用它；不传或解析失败 → 回退当天（产品语义不变）。
 */
export async function recordChatFact(
  workspace: string,
  userInput: string,
  answer: string,
  opts?: { sessionDate?: string }
): Promise<ChatFactResult> {
  const r = await recordConversationTurn(workspace, userInput, answer, opts);
  return { recorded: r.recorded > 0, reason: r.reason, cardId: r.cardIds?.[0] };
}

/** user 归一化：换行折叠 + trim（对卡 Q 侧与句级拆分的统一入口形态）。 */
const normalizeTurnText = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 对卡摘要（A1）：`Q: <user 归一化后前 160 字>\nA: <assistant smartSlice 400 字>`。
 * assistant 侧用 smartSlice 做数字句优先裁剪（该函数由死代码转为写路径主力——
 * LongMemEval 的 gold 多为数字/日期，常在答复中后段，朴素截断会把关键事实截掉）。
 */
function buildPairSummary(input: string, reply: string): { summary: string; confidence: number } {
  const q = normalizeTurnText(input).slice(0, 160);
  const a = smartSlice(normalizeTurnText(reply), 400);
  // 【5】A 侧主导置信（2026-09-13 迭代包）：旧实现取轮内两侧各句的全局 max——
  // Q 侧一个数字就把纯客套 A 拉满 1.0，检索端 (0.5+0.5×confidence) 软惩罚几乎
  // 永不生效。改为 confidence = 0.7×max(A 侧各句) + 0.3×max(Q 侧各句)：
  // A 行是注入载荷主体、事实由回答承载（0.7 主导）；Q 侧 0.3 保留提问相关性
  // 信号、防答非所问。两侧皆无句 → 0（软惩罚兜底档）。
  const maxConf = (seg: string): number => {
    const cs = splitSentences(seg).map(confidenceOf);
    return cs.length > 0 ? Math.max(...cs) : 0;
  };
  const confidence = 0.7 * maxConf(reply) + 0.3 * maxConf(input);
  return { summary: `Q: ${q}\nA: ${a}`, confidence };
}

/**
 * 记录一轮对话（2026-09-13"宽进严排"改造）：
 *  - A1 落卡单元 = 对话对：每对 user/assistant 无条件产 1 张对卡
 *    （source='dialogue-pair'，kind 沿用 'preference'——容量桶语义不变）；
 *  - A2 句级补充卡只按 confidenceOf>=0.7 发射（每侧 ≤2），低置信句不再阻断落卡；
 *  - A3 整轮总帽 8 张（旧 MAX_CARDS_PER_TURN=3 分侧帽删除）；
 *  - A4 配对牵连修复：user 命中 too-short/noise 只跳过 user 侧句级评估，
 *    assistant 侧单独评估（旧实现整轮 early-return 把答侧事实一并杀死）；
 *  - A5 无 80 帽硬拒绝：溢出交给 RefinedMemoryStore.applyCapacityLimits 的
 *    kind 分桶淘汰（新进旧出，最新事实天然保留）。
 * 多卡原子落盘（一次 save）。
 * 0.8.3 时间锚定：句级卡前缀 = 事实时间（yyyy-MM-dd）；"何时记的"由 lastSeen 承担。
 */
export async function recordConversationTurn(
  workspace: string,
  userInput: string,
  answer: string,
  opts?: { sessionDate?: string }
): Promise<ConversationTurnResult> {
  try {
    if (process.env.PANSHA_CHAT_MEMORY === '0') return { recorded: 0, reason: 'disabled' };
    const input = normalizeTurnText(userInput);
    const reply = normalizeTurnText(answer);
    if (!input && !reply) return { recorded: 0, reason: 'too-short' };

    const store = new RefinedMemoryStore(workspace);
    const file = store.load();

    // 0.8.3：前缀 = 事实时间（yyyy-MM-dd，去时分秒）；sessionDate 解析失败或
    // 不传 → 回退当天（旧实现是分钟级 Date.now()，冒充事实时间 → 假日期污染）。
    const fact = parseFactDate(opts?.sessionDate) ?? todayFact();
    const turnTag = fact.text;
    const now = Date.now();

    // A4：user 侧硬门（too-short/noise）只跳过 user 侧句级补充，assistant 不受牵连
    const userGated = input.length < MIN_INPUT_CHARS || NOISE_RE.test(input);

    // 候选卡：对卡 1 张（无条件）+ 句级补充（置信 ≥0.7，每侧 ≤2，整轮 ≤8）
    const candidates: Array<{ summary: string; confidence?: number; source?: string; sourceContext: string }> = [];
    const pair = buildPairSummary(input, reply);
    candidates.push({
      summary: pair.summary,
      confidence: pair.confidence,
      source: 'dialogue-pair',
      sourceContext: '对话事实沉淀（对话对）',
    });
    for (const [src, text, gated] of [['用户', input, userGated], ['助手', reply, false]] as const) {
      if (gated) continue;
      let picked = 0;
      for (const raw of splitSentences(text)) {
        if (picked >= MAX_SUPPLEMENT_PER_SIDE || candidates.length >= MAX_CARDS_PER_TURN_TOTAL) break;
        const sent = raw.trim();
        if (sent.length < MIN_SENTENCE_CHARS) continue; // 确定无信息量的碎片仍拦在写入侧
        if (confidenceOf(sent) < SUPPLEMENT_CONFIDENCE) continue;
        candidates.push({ summary: `【对话事实·${src}·${turnTag}】${sent}`, sourceContext: '对话事实沉淀（句级拆卡）' });
        picked++;
      }
    }

    // 去重（包C 缺陷6c：键 = 剥离【…】时间戳前缀后的内容——对卡无前缀，键=全文）
    const existingSummaries = new Set(file.cards.filter((c) => c.kind === 'preference').map((c) => stripTurnTag(c.summary)));
    const fresh = candidates.filter((c) => !existingSummaries.has(stripTurnTag(c.summary)));
    if (fresh.length === 0) return { recorded: 0, reason: 'duplicate' };

    const cards = fresh.map((c) => ({
      id: hashId(`chatfact-${c.summary}`),
      kind: 'preference' as const,
      category: 'OTHER' as const,
      memoryCategory: 'insight' as const,
      summary: c.summary,
      // 【4】排序公平性：0.5→0.8。注意 weight 不进衰减 effBase（base =
      // decayWeight ?? weight，对卡恒带 decayWeight 1.0 优先）——出局门修复载体
      // 是 RefinedMemoryStore 的 dialogue-pair 基线 0.85；0.8 仅作用于容量淘汰
      // tiebreak 与无 decayWeight 卡（review 纠正）
      weight: 0.8,
      taskStyle: 'all',
      count: 1,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: [],
      sourceContext: c.sourceContext,
      decayWeight: 1.0,
      lastUsedAt: now,
      // A1/A2：对卡带产出来源标记与分类器置信度（检索端软惩罚的数据源）
      ...(c.source ? { source: c.source } : {}),
      ...(typeof c.confidence === 'number' ? { confidence: c.confidence } : {}),
      // 0.8.3：事实时间字段（"记的是何时的事"）——渲染与"多久之前"计算的数据源
      factDate: fact.ms,
      factDateText: fact.text,
    }));
    store.save(cards as any);
    return { recorded: cards.length, cardIds: cards.map((c) => c.id) };
  } catch {
    // 静默：记忆沉淀是 best-effort，绝不影响对话
    return { recorded: 0, reason: 'duplicate' };
  }
}
