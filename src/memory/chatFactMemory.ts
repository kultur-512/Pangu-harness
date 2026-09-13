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
const INPUT_SLICE = 120;
const ANSWER_SLICE = 240;

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
  try {
    if (process.env.PANSHA_CHAT_MEMORY === '0') return { recorded: false, reason: 'disabled' };
    const input = String(userInput ?? '').trim();
    const reply = String(answer ?? '').replace(/\s+/g, ' ').trim();
    if (input.length < MIN_INPUT_CHARS) return { recorded: false, reason: 'too-short' };
    if (NOISE_RE.test(input)) return { recorded: false, reason: 'noise' };

    const store = new RefinedMemoryStore(workspace);
    const summary = `用户提到：${smartSlice(input, INPUT_SLICE)}｜答复要点：${smartSlice(reply, ANSWER_SLICE)}`;

    // 去重：同 summary 的活跃卡已存在 → 只刷 lastSeen（不叠 count 防自增）
    const existing = store.load().cards.find((c) => c.kind === 'preference' && c.summary === summary);
    if (existing) {
      return { recorded: false, reason: 'duplicate', cardId: existing.id };
    }

    const now = Date.now();
    const card = {
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
      sourceContext: '对话事实沉淀（chat fact memory）',
      decayWeight: 1.0,
      lastUsedAt: now,
    };
    store.save([card as any]);
    return { recorded: true, cardId: card.id };
  } catch {
    // 静默：记忆沉淀是 best-effort，绝不影响对话
    return { recorded: false, reason: 'duplicate' };
  }
}
