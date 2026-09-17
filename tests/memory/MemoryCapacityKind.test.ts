// tests/memory/MemoryCapacityKind.test.ts
// 包C 缺陷1+2 对抗性回归（2026-09-13 记忆系统审计）：
//
// 缺陷1【P1】容量分桶挤爆：applyCapacityLimits 旧按 category 分桶各留 10，而
//   success / preference(/remember) / chat-fact / merged 卡全部 category:'OTHER'
//   → 三类卡挤一个 10 张桶，第 11 张起静默截断最旧；chat-fact 声称的 80 张帽
//   （chatFactMemory MAX_TOTAL_CARDS=80）与全局 200 帽不可达。
//   修复语义：分桶按 kind 治理 —— MAX_PER_KIND { failure:40, success:10,
//   preference:80 }（chat-fact 卡 kind='preference'，以其实际 kind 为准）；
//   failure 类内每 category 10 张、类总 40；全局 200 不变；排序沿用 lastSeen
//   倒序 + weight。
//
// 缺陷2【P1】recordFactLines 返回值谎报：旧返回 recorded=cards.length（save()
//   截断前的候选数），save() 的 {written, capped} 被丢弃。修复：返回真实 save
//   后落盘数（本批 id 在盘上的实际存活数）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import { MEMORY_LIMITS } from '../../src/memory/RefinedMemoryCard.js';
import { recordFactLines } from '../../src/memory/chatFactMemory.js';

let ws = '';
function mkWs(): string {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-capkind-'));
  return ws;
}
function cleanupAll() {
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
}

function mkCard(i: number, kind: string, category: string, lastSeen: number, summary?: string): any {
  return {
    id: `${kind}-${category}-${i}`,
    kind,
    category,
    memoryCategory: kind === 'preference' ? 'insight' : 'implementation',
    summary: summary ?? `${kind}/${category} 卡 #${i}`,
    weight: 1,
    taskStyle: 'all',
    count: 1,
    lastSeen,
    firstSeen: lastSeen,
    applicableTiers: [],
    sourceContext: '包C 容量分桶测试',
    decayWeight: 1.0,
    lastUsedAt: lastSeen,
  };
}

describe('包C 缺陷1：容量分桶按 kind 治理（MAX_PER_KIND）', () => {
  afterEach(cleanupAll);

  it('声明 MAX_PER_KIND = { failure:40, success:10, preference:80 }（chat-fact kind 为准）', () => {
    assert.deepEqual(MEMORY_LIMITS.MAX_PER_KIND, { failure: 40, success: 10, preference: 80 });
    assert.equal(MEMORY_LIMITS.MAX_TOTAL_CARDS, 200, '全局 200 帽保持');
  });

  it('15 张 chat-fact（kind=preference）+ 3 张 success + 2 张偏好卡 → 各自保留至各自帽，互不挤掉', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    // chat-fact 卡形状对齐 chatFactMemory（kind='preference', category='OTHER'）
    const chatFacts = Array.from({ length: 15 }, (_, i) => mkCard(i, 'preference', 'OTHER', now - i, `【对话事实·用户·2026-09-13 10:00】对话事实卡 #${i}`));
    const successes = Array.from({ length: 3 }, (_, i) => mkCard(100 + i, 'success', 'OTHER', now - 100 - i));
    const prefs = Array.from({ length: 2 }, (_, i) => mkCard(200 + i, 'preference', 'OTHER', now - 200 - i, `用户偏好 #${i}`));

    const r = store.save([...chatFacts, ...successes, ...prefs]);
    // 旧实现：20 张全 category:'OTHER' → 一个 10 张桶 → written=10（红）
    assert.equal(r.written, 20, `三类卡各归各帽：preference-kind 17（帽 80）+ success 3（帽 10），got ${r.written}`);

    const onDisk = store.list();
    assert.equal(onDisk.filter(c => c.kind === 'success').length, 3, 'success 3 张全保');
    assert.equal(onDisk.filter(c => c.kind === 'preference').length, 17, '15 chat-fact + 2 偏好全保（同 kind 桶 80 帽）');
  });

  it('preference-kind 帽为 80：81 张时截到 80、最新保留', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    const cards = Array.from({ length: 81 }, (_, i) => mkCard(i, 'preference', 'OTHER', now - i));
    const r = store.save(cards);
    assert.equal(r.written, 80, 'chat-fact 的 80 张帽可达（旧 10 张帽不可达）');
    const onDisk = store.list().filter(c => c.kind === 'preference');
    assert.equal(onDisk.length, 80);
    assert.ok(onDisk.every(c => c.lastSeen >= now - 79), '截断保留最新（lastSeen 倒序）');
  });

  it('审查 CONCERN-7：pinned 卡免容量淘汰——chat 洪流挤不掉 /remember --pin 偏好', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    // 1 张 pinned 手工偏好（lastSeen 最旧）+ 80 张最新 chat-fact → preference 桶 81 张
    const pinnedCard: any = { ...mkCard(999, 'preference', 'OTHER', now - 1000, '用户钉住的偏好：永远用中文回复'), pinned: true };
    const flood = Array.from({ length: 80 }, (_, i) => mkCard(i, 'preference', 'OTHER', now - i));
    store.save([...flood, pinnedCard]);
    let onDisk = store.list().filter(c => c.kind === 'preference');
    // pinned 全保，非 pinned 竞争剩余名额（总 = 帽 80）
    assert.equal(onDisk.length, 80, '总数=帽 80（pinned 1 + 非 pinned 79）');
    assert.ok(onDisk.some(c => c.id === 'preference-OTHER-999'), 'pinned 手工偏好仍在盘上');
    assert.ok(!onDisk.some(c => c.id === 'preference-OTHER-79'), '被淘汰的是最旧的非 pinned 卡');
    // 继续洪流：pinned 持续存活，非 pinned 维持帽
    const more = Array.from({ length: 15 }, (_, i) => mkCard(1000 + i, 'preference', 'OTHER', now + 100 + i));
    store.save(more);
    onDisk = store.list().filter(c => c.kind === 'preference');
    assert.equal(onDisk.length, 80, '总数保持帽 80');
    assert.ok(onDisk.some(c => c.id === 'preference-OTHER-999'), 'pinned 仍未被挤出');
  });

  it('failure 类内不同 category 各自留 10；类总 40', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    // 同一次 save：12 张 COMMAND_FAILED + 12 张 READ_BEFORE_WRITE_VIOLATION
    const a = Array.from({ length: 12 }, (_, i) => mkCard(i, 'failure', 'COMMAND_FAILED', now - i));
    const b = Array.from({ length: 12 }, (_, i) => mkCard(i, 'failure', 'READ_BEFORE_WRITE_VIOLATION', now - 100 - i));
    const r1 = store.save([...a, ...b]);
    assert.equal(r1.written, 20, `每 category 留最新 10 张：12+12 → 10+10，got ${r1.written}`);
    let onDisk = store.list().filter(c => c.kind === 'failure');
    assert.equal(onDisk.filter(c => c.category === 'COMMAND_FAILED').length, 10);
    assert.equal(onDisk.filter(c => c.category === 'READ_BEFORE_WRITE_VIOLATION').length, 10);

    // 追加 3 个 category × 10 张（更新）→ failure 类总 50 > 40 → 截到 40
    const now2 = Date.now() + 10_000;
    const extra: any[] = [];
    for (const cat of ['COMMAND_FAILED', 'WEAK_VERIFICATION', 'SKIPPED_PLAN', 'STATE_MISMATCH', 'OVERCONFIDENCE']) {
      for (let i = 0; i < 10; i++) extra.push(mkCard(i, 'failure', cat, now2 + i));
    }
    store.save(extra);
    onDisk = store.list().filter(c => c.kind === 'failure');
    assert.equal(onDisk.length, 40, `failure 类总帽 40：got ${onDisk.length}`);
    // 保留的是最新 40 张：追加批次 5×10=50 中最旧的 10 张被截
    const cats = new Map<string, number>();
    for (const c of onDisk) cats.set(c.category, (cats.get(c.category) ?? 0) + 1);
    assert.ok([...cats.values()].every(n => n <= 10), '类总帽内每 category 仍 ≤10');
  });

  it('无 kind 的旧卡归 failure 桶（对齐 loadFiltered 归一化）', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    const legacy: any[] = Array.from({ length: 12 }, (_, i) => {
      const c = mkCard(i, 'failure', 'COMMAND_FAILED', now - i);
      delete c.kind; // 旧文件形状
      return c;
    });
    const r = store.save(legacy);
    assert.equal(r.written, 10, '无 kind → failure 桶 → category 帽 10');
  });
});

describe('包C 缺陷2：recordFactLines 返回真实落盘数', () => {
  afterEach(cleanupAll);

  it('帽满（80）时 recordFactLines 返回 recorded=0 且盘上总数保持帽值（旧谎报候选数）', async () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    // 预塞 80 张 preference-kind 卡，lastSeen 取未来 → 容量淘汰必保它们、新卡全被截
    const future = Date.now() + 3_600_000;
    const pre = Array.from({ length: 80 }, (_, i) => mkCard(i, 'preference', 'OTHER', future + i, `预填事实 #${i}`));
    store.save(pre);
    assert.equal(store.list().length, 80);

    const lines = ['评测记忆事实行甲内容', '评测记忆事实行乙内容', '评测记忆事实行丙内容'];
    const r = await recordFactLines(ws, lines);
    // 旧实现：recorded=3（save 截断前的候选数，谎报）→ 红
    assert.ok(r.recorded <= 0, `帽余量 0 → recorded 必须 ≤0，got ${r.recorded}`);
    assert.equal(r.total, 3);
    const onDisk = new RefinedMemoryStore(ws).list();
    assert.equal(onDisk.length, 80, '盘上总数保持帽值');
    assert.ok(!onDisk.some(c => lines.includes(c.summary)), '新行确实没落盘（recorded 与盘上一致）');
  });

  it('半满时 recorded ≤ 帽余量且 === 本批在盘上的实际存活数', async () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const future = Date.now() + 3_600_000;
    const pre = Array.from({ length: 78 }, (_, i) => mkCard(i, 'preference', 'OTHER', future + i, `预填事实 #${i}`));
    store.save(pre);

    const lines = ['评测记忆事实行甲内容', '评测记忆事实行乙内容', '评测记忆事实行丙内容', '评测记忆事实行丁内容'];
    const r = await recordFactLines(ws, lines);
    const remain = 80 - 78;
    assert.ok(r.recorded <= remain, `帽余量 ${remain} → recorded ≤${remain}，got ${r.recorded}`);
    // 与盘上实际一致（新实例重读盘，避免本进程缓存串扰）
    const onDisk = new RefinedMemoryStore(ws).list();
    const survived = onDisk.filter(c => lines.includes(c.summary)).length;
    assert.equal(survived, r.recorded, `recorded 必须等于本批在盘上的存活数：${r.recorded} vs ${survived}`);
    assert.equal(onDisk.length, 80);
  });
});
