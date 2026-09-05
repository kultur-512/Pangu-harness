// tests/memory/MemoryMark.test.ts
// 接口契约 v3 回归：
// - 衰减锚修复：effectiveWeight 取 max(lastSeen, lastUsedAt)，复发卡的 lastSeen 刷新必须可见
// - archived 卡必须退出注入（merge 软删语义真正生效）
// - markInjected：纯记账（不写盘、不改 count/lastUsedAt）
// - markVerified：机器判定的"真实使用"——lastUsedAt=now + count+1 + 持久化

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';

const DAY = 24 * 60 * 60 * 1000;

let ws: string;
function makeWs(): string {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-mark-'));
  return ws;
}
function memPath(): string { return path.join(ws, '.panshalach-memory.json'); }
function writeCards(cards: any[]): void {
  fs.writeFileSync(memPath(), JSON.stringify({ meta: { lastUpdated: Date.now() }, cards }, null, 2), 'utf-8');
}
function baseCard(id: string, summary: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    id, kind: 'failure', summary, weight: 1, count: 1,
    lastSeen: now, firstSeen: now, memoryCategory: 'implementation',
    ...extra,
  };
}
const cleaners: Array<() => void> = [];
function cleanupAll() { for (const c of cleaners) { try { c(); } catch {} } cleaners.length = 0; }

describe('接口契约 v3：记忆二态与衰减锚', () => {
  afterEach(cleanupAll);

  it('衰减锚取 max(lastSeen, lastUsedAt)：复发 100 天前创建、昨天复发的卡不衰减出局', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    // lastUsedAt 停在 100 天前（旧行为 ?? 短路恒取它），lastSeen 昨天刚刷新
    const card = baseCard('c1', '复发卡', { lastSeen: now - DAY, lastUsedAt: now - 100 * DAY, count: 3 });
    const eff = store.effectiveWeightOf(card as any, now);
    assert.ok(eff > 0.9, `fresh lastSeen 必须保鲜，got ${eff}`);
    // 对照：两个时间戳都很旧（>2×半衰期 90d）→ 正常衰减（<0.3 丢弃线以下）
    const stale = baseCard('c2', '陈年卡', { lastSeen: now - 200 * DAY, lastUsedAt: now - 200 * DAY, count: 1, memoryCategory: 'failure' });
    const eff2 = store.effectiveWeightOf(stale as any, now);
    assert.ok(eff2 < 0.3, `双旧时间戳必须衰减，got ${eff2}`);
  });

  it('archived 卡不进入 loadFiltered（merge 软删真正退出注入）', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    writeCards([
      baseCard('keep-1', '活跃卡'),
      baseCard('gone-1', '已归档卡', { status: 'archived' }),
    ]);
    const store = new RefinedMemoryStore(ws);
    const cards = store.loadFiltered({});
    const ids = cards.map(c => c.id);
    assert.ok(ids.includes('keep-1'));
    assert.ok(!ids.includes('gone-1'), 'archived 卡必须被过滤');
  });

  it('markInjected 仅记账：不改 count/lastUsedAt、不写盘', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    writeCards([baseCard('c1', '卡一', { count: 2 })]);
    const store = new RefinedMemoryStore(ws);
    const before = fs.readFileSync(memPath(), 'utf-8');
    const r = store.markInjected(['c1', 'c2']);
    assert.equal(r.injected, 2);
    assert.ok(store.injectedAtOf('c1') !== undefined, '内存账本应记录注入时间');
    // 文件未被改写
    assert.equal(fs.readFileSync(memPath(), 'utf-8'), before, 'markInjected 禁止写盘');
    // 卡数据未被修改
    const raw = JSON.parse(before);
    assert.equal(raw.cards[0].count, 2);
  });

  it('markVerified：lastUsedAt=now + count+1 + 持久化', async () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    writeCards([baseCard('c1', '被验证的卡', { count: 2, lastUsedAt: Date.now() - 30 * DAY })]);
    const store = new RefinedMemoryStore(ws);
    const r = store.markVerified(['c1', 'missing-id']);
    assert.equal(r.updated, 1, '只更新存在的卡');
    // 新实例重读验证持久化
    const store2 = new RefinedMemoryStore(ws);
    const file = JSON.parse(fs.readFileSync(memPath(), 'utf-8'));
    const c1 = file.cards.find((c: any) => c.id === 'c1');
    assert.equal(c1.count, 3, 'count+1');
    assert.ok(Math.abs(c1.lastUsedAt - Date.now()) < 60_000, 'lastUsedAt 刷新到 now');
  });
});

describe('接口契约 v3.1：count 翻倍修复回归（对抗清单 #6）', () => {
  afterEach(cleanupAll);

  function failTraj(): any {
    return { id: 't', steps: [{ stepNumber: 1, readBeforeWriteViolation: true } as any], success: false };
  }

  it('同一失败信号连续两次 refine+save → count 恰为 2（旧实现翻倍为 4）', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new RefinedMemoryStore(ws);
    const cards1 = store.refine({ trajectory: failTraj(), taskStyle: 'swe', attemptCount: 2, userFeedback: '' });
    store.save(cards1);
    const cards2 = store.refine({ trajectory: failTraj(), taskStyle: 'swe', attemptCount: 2, userFeedback: '' });
    store.save(cards2);
    // kind 在落盘时未写，经 loadFiltered 归一化为 failure
    const hit = store.loadFiltered({}).find(c => c.kind === 'failure');
    assert.ok(hit, '失败卡存在（归一化后）');
    assert.equal(hit.count, 2, `恰好 +1/次，got ${hit.count}`);
  });

  it('/remember 同文本两次 → count 恰为 2', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new RefinedMemoryStore(ws);
    store.save([store.addRemember('项目优先用 pnpm', false)]);
    store.save([store.addRemember('项目优先用 pnpm', false)]);
    const file = JSON.parse(fs.readFileSync(memPath(), 'utf-8'));
    const hit = file.cards.find((c: any) => c.kind === 'preference');
    assert.ok(hit);
    assert.equal(hit.count, 2, `恰好 +1/次，got ${hit.count}`);
  });

  it('正向成功重复两次（同摘要）→ count 恰为 2', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new RefinedMemoryStore(ws);
    // 0.7：success 卡信号源 = stopReason==='completed'
    const t1 = store.refine({ trajectory: { id: 't1', steps: [], success: true, stopReason: 'completed' as const }, taskStyle: 'swe', attemptCount: 1, userFeedback: '' });
    store.save(t1);
    const t2 = store.refine({ trajectory: { id: 't2', steps: [], success: true, stopReason: 'completed' as const }, taskStyle: 'swe', attemptCount: 1, userFeedback: '' });
    store.save(t2);
    const file = JSON.parse(fs.readFileSync(memPath(), 'utf-8'));
    const hits = file.cards.filter((c: any) => c.kind === 'success');
    assert.equal(hits.length, 1, '同摘要同 id → 单卡');
    assert.equal(hits[0].count, 2, `恰好 +1/次，got ${hits[0].count}`);
  });
});
