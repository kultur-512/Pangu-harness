// tests/memory/WideIntake.test.ts
// 写路径"宽进严排"改造（2026-09-13 裁决）：写入侧只拦确定无信息量的内容，
// 质量判断后移到检索排序（confidence 软惩罚替代硬拒绝）。锁六件事：
//   A1 对卡无条件落卡：recordConversationTurn 每对 user/assistant 产 1 张
//      source='dialogue-pair' 对卡（summary='Q: <user 前160>\nA: <smartSlice 400>'，
//      kind 沿用 'preference'，confidence=分类器值）。
//   A2 isFactSentence → confidenceOf 分类器（数字 1.0 / CJK 0.8 / 第一人称+大写
//      开头 0.7 / 全大写缩写 0.7 / 其余 0.4）；句级补充卡只在 ≥0.7 发射（每侧 ≤2）。
//   A3 整轮总帽 8（旧 MAX_CARDS_PER_TURN=3 分侧帽删除，user/assistant 不分侧设帽）。
//   A4 配对牵连修复：user 命中 too-short/noise 只跳过 user 侧，assistant 事实仍落卡。
//   A5 80 帽硬拒绝移除：溢出交给 RefinedMemoryStore.applyCapacityLimits 的 kind
//      分桶淘汰（新进旧出，最新事实天然保留）。
//   A6 分句器缩写保护：Dr. Smith 不被切碎。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordConversationTurn,
  confidenceOf,
  splitSentences,
} from '../../src/memory/chatFactMemory.js';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';

let ws = '';
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-wide-intake-')); });
afterEach(() => { if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; } });

function cards(dir: string): any[] {
  const fp = path.join(dir, '.panshalach-memory.json');
  return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')).cards : [];
}

describe('A1：对卡无条件落卡（source=dialogue-pair）', () => {
  it('正常轮 → 恰 1 张对卡：kind=preference、confidence 数值、Q:/A: 双段', async () => {
    const r = await recordConversationTurn(ws, '我今天买了一辆红色的特斯拉', '好的，已记录你的新车信息，落地价 25 万元');
    assert.ok(r.recorded > 0, '前置：轮次落卡');
    const all = cards(ws);
    const pairs = all.filter((c) => c.source === 'dialogue-pair');
    assert.equal(pairs.length, 1, '每对 user/assistant 恰产 1 张对卡');
    const pair = pairs[0];
    assert.equal(pair.kind, 'preference', 'kind 沿用 preference（容量桶语义不变，不新增 kind）');
    assert.equal(typeof pair.confidence, 'number', '对卡带分类器置信度');
    assert.ok(pair.summary.startsWith('Q: '), 'Q 侧 = user 归一化');
    assert.ok(pair.summary.includes('\nA: '), 'A 侧 = assistant');
    assert.ok(pair.summary.includes('特斯拉'), 'Q 侧内容入卡');
    assert.ok(all.some((c) => c.summary.includes('25 万')), '数字句照常句级成卡');
  });

  it('纯寒暄 user + 有料 assistant → 对卡仍落（Q 侧保留寒暄原文，质量判断后移到检索端）', async () => {
    const r = await recordConversationTurn(ws, '好的', '我的服务器在柏林，机房编号 B-12。');
    assert.ok(r.recorded > 0, '整轮不再被 user 噪音 early-return 杀死');
    const pair = cards(ws).find((c) => c.source === 'dialogue-pair');
    assert.ok(pair, '对卡无条件落卡');
    assert.ok(pair.summary.startsWith('Q: 好的'), 'Q 侧 = 寒暄原文');
    assert.ok(pair.summary.includes('柏林'), 'A 侧带 assistant 事实');
  });

  it('Q 侧截 160 字、A 侧 smartSlice ≤400 字（数字句优先裁剪）', async () => {
    const longUser = '很长的用户输入'.repeat(60); // 420 字
    const longAnswer = '回答内容甲。'.repeat(100); // 600 字（无数字句）
    await recordConversationTurn(ws, longUser, longAnswer);
    const pair = cards(ws).find((c) => c.source === 'dialogue-pair');
    assert.ok(pair, '前置：对卡落盘');
    const [q, a] = pair.summary.split('\n');
    assert.ok(q.length <= 'Q: '.length + 160, `Q 侧 ≤160 字，got ${q.length - 'Q: '.length}`);
    assert.ok(a.length <= 'A: '.length + 400, `A 侧 ≤400 字，got ${a.length - 'A: '.length}`);
  });
});

describe('A2：isFactSentence → confidenceOf 分类器', () => {
  it('五级分档：数字 1.0 / CJK 0.8 / 第一人称+大写开头 0.7 / 全大写缩写 0.7 / 其余 0.4', () => {
    assert.equal(confidenceOf('我在2023年1月19日跑了5公里'), 1.0, '含数字=1.0');
    assert.equal(confidenceOf('我在上海工作，职位是后端工程师'), 0.8, '含 CJK=0.8');
    assert.equal(confidenceOf('My favorite editor is Zed'), 0.7, '第一人称词+大写开头=0.7');
    assert.equal(confidenceOf('NASA announced the mission'), 0.7, '全大写缩写=0.7');
    assert.equal(confidenceOf('unit testing works nicely'), 0.4, '其余=0.4');
  });

  it('低置信句（0.4）不再发射句级卡，但不阻断对卡', async () => {
    await recordConversationTurn(ws, 'unit testing works nicely', 'sure thing buddy');
    const all = cards(ws);
    const pair = all.find((c) => c.source === 'dialogue-pair');
    assert.ok(pair, '0.4 句不影响对卡（未命中不再阻断）');
    const sentenceCards = all.filter((c) => c.summary.startsWith('【对话事实'));
    assert.equal(sentenceCards.length, 0, '双侧均低置信 → 零句级补充卡');
  });
});

describe('A3：整轮总帽 8（分侧 3 帽删除）', () => {
  it('对卡 1 + 每侧句级补充 ≤2 = 5 张，且整轮 ≤8', async () => {
    const user = Array.from({ length: 5 }, (_, i) => `用户事实第${i}条发生在2023年5月${i + 1}日的记录。`).join('');
    const asst = Array.from({ length: 5 }, (_, i) => `助手确认第${i}条在6月${i + 1}日已完成归档。`).join('');
    const r = await recordConversationTurn(ws, user, asst);
    assert.ok((r.recorded ?? 0) <= 8, `整轮总帽 8，got ${r.recorded}`);
    assert.equal(r.recorded, 5, '对卡 1 + user 句级 2 + assistant 句级 2');
  });
});

describe('A4：配对牵连修复（user=好的 时 assistant 事实仍落卡）', () => {
  it('user 命中噪音硬门只跳过 user 侧句级评估，assistant 数字事实句独立成卡', async () => {
    const r = await recordConversationTurn(ws, '好的', '我的团队有12名工程师，分布在北京和上海。');
    assert.ok(r.recorded >= 1, '旧实现整轮 early-return 把答侧事实一并杀死');
    const sent = cards(ws).find((c) => c.summary.startsWith('【对话事实·助手'));
    assert.ok(sent, 'assistant 事实句仍单独评估落卡');
    assert.ok(cards(ws).some((c) => c.source === 'dialogue-pair'), '对卡也在');
  });

  it('user 过短（<8 字符）同样只跳 user 侧，不杀整轮', async () => {
    const r = await recordConversationTurn(ws, '嗯', '数据库迁移在2024年3月1日完成。');
    assert.ok(r.recorded >= 1, 'too-short 不再整轮 early-return');
    assert.ok(cards(ws).some((c) => c.summary.includes('2024')), '答侧数字事实入卡');
  });
});

describe('A6：分句器缩写保护（Dr. Smith 不被切碎）', () => {
  it('splitSentences：缩写点（Dr./Mr./vs./e.g. 等）不当句边界，切后还原', () => {
    const parts = splitSentences('Dr. Smith is my doctor. I will run 5K on May 3rd.');
    assert.deepEqual(parts, ['Dr. Smith is my doctor.', 'I will run 5K on May 3rd.'], 'Dr. 的点不被当句号');
    const parts2 = splitSentences('Compare vs. last year. Sales grew 10%.');
    assert.equal(parts2.length, 2, 'vs. 同样受保护');
    assert.ok(parts2[0].includes('vs. last year'));
  });

  it('行为面：缩写句整句成卡（旧实现把 Dr. 切碎后首片被丢弃）', async () => {
    await recordConversationTurn(ws, 'Dr. Smith is my doctor. I will run 5K on May 3rd.', 'noted');
    const sent = cards(ws).find((c) => c.summary.includes('Dr. Smith is my doctor'));
    assert.ok(sent, '缩写句作为完整事实句入卡');
  });
});

describe('A5：80 帽硬拒绝移除（存储层 kind 分桶淘汰生效）', () => {
  it('盘上已有 80 张 preference 时新轮照常落卡；新进旧出，最旧种子被淘汰', async () => {
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    const seeds = Array.from({ length: 80 }, (_, i) => ({
      id: `seed-${i}`,
      kind: 'preference',
      category: 'OTHER',
      memoryCategory: 'insight',
      summary: `旧偏好记忆第${i}条内容`,
      weight: 0.5,
      taskStyle: 'all',
      count: 1,
      lastSeen: now - 10_000 - i,
      firstSeen: now - 10_000,
      applicableTiers: [],
      sourceContext: 'seed',
      decayWeight: 1.0,
      lastUsedAt: now - 10_000,
    }));
    store.save(seeds as any);
    assert.equal(store.load().cards.length, 80, '前置：preference 桶满 80（存储层容量帽）');

    const r = await recordConversationTurn(ws, '我在柏林的新工作今天正式开始了', '祝你好运');
    assert.ok(r.recorded > 0, '旧实现在此处 return（80 帽硬拒绝，把最新 session 整拒）');

    // 用新实例读盘（RefinedMemoryStore 实例级 cache 在外部写入后是陈旧的）
    const after = new RefinedMemoryStore(ws).load().cards;
    assert.ok(after.length <= 80, `存储层容量治理保持（got ${after.length}）`);
    assert.ok(after.some((c) => c.source === 'dialogue-pair'), '最新对卡存活（新进）');
    assert.ok(!after.some((c) => c.id === 'seed-79'), '最旧种子被淘汰（旧出；seed-79 lastSeen 最小）');
  });
});
