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
//  - 降速衰减：weight 0.5（低于工程卡 1.0）——对话细节比工程教训过期更快，
//    容量淘汰时优先让位。
//  - 逃生门：PANSHA_CHAT_MEMORY=0 关闭（默认开）。
import { createHash } from 'node:crypto';
import { RefinedMemoryStore } from './RefinedMemoryStore.js';

const hashId = (seed: string): string => createHash('sha1').update(seed).digest('hex').slice(0, 12);

const MIN_INPUT_CHARS = 8;
const MAX_CARDS_PER_TURN = 3;
const MAX_TOTAL_CARDS = 80;

/**
 * 句级拆卡（0.8.2 第二轮修正）：18 题 B 档错题归因——15 错中 11 错是
 * "gold 不在截断后的卡里"（整轮截 120/240 字符的摘要形态覆盖率不足，
 * 事实藏在对话任意位置）。改为按句拆分：含数字/专名的句子独立成卡
 * （事实粒度 = 句，检索关键词更精准），确定性规则、零 LLM。
 */
const isFactSentence = (x: string): boolean => {
  const t = x.trim();
  if (t.length < 12 || t.length > 240) return false;
  if (/\d/.test(t)) return true;                          // 数字/日期/度量
  if (/[一-龥]/.test(t)) return true;             // 中文句整体保留
  if (/(my|i|we|our)/i.test(t) && /[A-Z]/.test(t)) return true; // 第一人称专名句
  if (/\p{Lu}{2,}/u.test(t)) return true;                  // 全大写缩写
  return false;
};

/** 切分器（第三轮修正）：先按行、再按句、超长硬切——无句号结尾的长轮
 *  此前被整段丢弃（真机 18 题实证：12 轮只落 10 张，bike 轮缺席）。 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.match(/[^.!?]*[.!?]+|[^.!?]+$/g) ?? [trimmed];
    for (const part of parts) {
      let p = part.trim();
      if (!p) continue;
      while (p.length > 240) {
        out.push(p.slice(0, 240));
        p = p.slice(240);
      }
      if (p) out.push(p);
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
  const sentences = t.match(/[^.!??]*[.!??]+|[^.!??]+$/g) ?? [t];
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
  const out = picked.join(' ').trim();
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
 */
export async function recordFactLines(
  workspace: string,
  lines: string[]
): Promise<{ recorded: number; total: number }> {
  try {
    if (process.env.PANSHA_CHAT_MEMORY === '0') return { recorded: 0, total: lines.length };
    const store = new RefinedMemoryStore(workspace);
    const file = store.load();
    const now = Date.now();
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
      });
      existing.add(line);
    }
    if (cards.length > 0) store.save(cards as any);
    return { recorded: cards.length, total: lines.length };
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
 */
export async function recordChatFact(
  workspace: string,
  userInput: string,
  answer: string
): Promise<ChatFactResult> {
  const r = await recordConversationTurn(workspace, userInput, answer);
  return { recorded: r.recorded > 0, reason: r.reason, cardId: r.cardIds?.[0] };
}

/**
 * 记录一轮对话（句级拆卡版）：user/assistant 轮各拆句，事实句独立成卡。
 * 多卡原子落盘（一次 save）；总卡数 80 封顶（新卡让位旧卡由容量淘汰管）。
 */
export async function recordConversationTurn(
  workspace: string,
  userInput: string,
  answer: string
): Promise<ConversationTurnResult> {
  try {
    if (process.env.PANSHA_CHAT_MEMORY === '0') return { recorded: 0, reason: 'disabled' };
    const input = String(userInput ?? '').trim();
    const reply = String(answer ?? '').replace(/\s+/g, ' ').trim();
    if (input.length < MIN_INPUT_CHARS) return { recorded: 0, reason: 'too-short' };
    if (NOISE_RE.test(input)) return { recorded: 0, reason: 'noise' };

    const store = new RefinedMemoryStore(workspace);
    const file = store.load();
    if (file.cards.length >= MAX_TOTAL_CARDS) return { recorded: 0, reason: 'duplicate' };

    // 句级拆分：user 轮 + assistant 轮的事实句（每轮各限 3 张防刷屏）
    const now = Date.now();
    const turnTag = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
    const candidates: string[] = [];
    for (const [src, text] of [['用户', input], ['助手', reply]] as const) {
      // G1 死代码修复：改走 splitSentences（先按行、再按句、>240 硬切）——
      // 内联正则按 \n 断句，无句号结尾的多行长轮整段丢失（审查实证）。
      const sentences = splitSentences(text);
      let picked = 0;
      for (const raw of sentences) {
        if (picked >= MAX_CARDS_PER_TURN) break;
        const sent = raw.trim();
        if (!isFactSentence(sent)) continue;
        candidates.push(`【对话事实·${src}·${turnTag}】${sent}`);
        picked++;
      }
    }
    if (candidates.length === 0) return { recorded: 0, reason: 'too-short' };

    // 去重（summary 全等 → 跳过）
    const existingSummaries = new Set(file.cards.filter((c) => c.kind === 'preference').map((c) => c.summary));
    const fresh = candidates.filter((c) => !existingSummaries.has(c));
    if (fresh.length === 0) return { recorded: 0, reason: 'duplicate' };

    const cards = fresh.map((summary) => ({
      id: hashId(`chatfact-${summary}`),
      kind: 'preference' as const,
      category: 'OTHER' as const,
      memoryCategory: 'insight' as const,
      summary,
      weight: 0.5,
      taskStyle: 'all',
      count: 1,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: [],
      sourceContext: '对话事实沉淀（句级拆卡）',
      decayWeight: 1.0,
      lastUsedAt: now,
    }));
    store.save(cards as any);
    return { recorded: cards.length, cardIds: cards.map((c) => c.id) };
  } catch {
    // 静默：记忆沉淀是 best-effort，绝不影响对话
    return { recorded: 0, reason: 'duplicate' };
  }
}
