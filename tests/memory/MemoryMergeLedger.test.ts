// tests/memory/MemoryMergeLedger.test.ts
// 包C 缺陷11 + 缺陷8 对抗性回归（2026-09-13 记忆系统审计）：
//
// 缺陷11【P2】mergeSimilarCards：
//   (a) firstSeen/count 为 undefined 时 Math.min(...)/求和得 NaN → 合并卡出生即
//       near-death（effectiveWeight=NaN 永不过注入线）。修复：数值字段 ?? 0，
//       firstSeen 缺失取另一卡或 now。
//   (b) 停用词单字集合与 w.length>=2 过滤矛盾恒不过滤 → 改 ≥2 字词表。
//
// 缺陷8【P2】markInjected 一次性实例记账即弃（runAgentTask 每步 new 即弃）：
//   账本升级为进程级（模块级 Map）→ 短命实例的记账在同进程任意实例可读
//   （/memory stats 的一次性 CLI 实例因此可见）；同一实例两次 markInjected
//   注入次数/最近注入时间均可查。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore, resetInjectionLedgerForTest } from '../../src/memory/RefinedMemoryStore.js';

let ws = '';
function mkWs(): string {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-merge-'));
  return ws;
}
function cleanupAll() {
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
  resetInjectionLedgerForTest();
}
function memPath(): string { return path.join(ws, '.panshalach-memory.json'); }

describe('包C 缺陷11：mergeSimilarCards 数值字段 NaN 不再传播', () => {
  afterEach(cleanupAll);

  it('firstSeen undefined 的 legacy 卡合并后 effectiveWeight 为有限数', () => {
    mkWs();
    const now = Date.now();
    // legacy 卡：无 firstSeen / 无 count（旧实现 Math.min(now, undefined)=NaN、0+undefined=NaN）
    const legacy = [
      {
        id: 'l1', kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure',
        summary: '修复登录空指针问题并补回归用例', weight: 2, taskStyle: 'all',
        lastSeen: now, applicableTiers: [], sourceContext: 'legacy',
      },
      {
        id: 'l2', kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure',
        summary: '修复登录空指针问题的最终方案', weight: 1, count: 3, taskStyle: 'all',
        lastSeen: now - 1000, firstSeen: now - 5000, applicableTiers: [], sourceContext: '',
      },
    ];
    fs.writeFileSync(memPath(), JSON.stringify({ meta: { version: '1.0.0', lastUpdated: now, totalCards: 2 }, cards: legacy }, null, 2), 'utf-8');

    const store = new RefinedMemoryStore(ws);
    const results = store.mergeSimilarCards(now + 10);
    assert.equal(results.length, 1, '两卡 2-gram 重叠 ≥2 → 同组合并');
    const merged = store.list().find(c => c.id === results[0].mergedId) as any;
    assert.ok(merged, '合并卡已落盘');
    assert.ok(Number.isFinite(merged.firstSeen), `firstSeen 必须有限（旧 NaN）：${merged.firstSeen}`);
    assert.equal(merged.firstSeen, now - 5000, 'firstSeen 缺失取另一卡的最早值');
    assert.ok(Number.isFinite(merged.count), `count 必须有限（旧 NaN）：${merged.count}`);
    assert.equal(merged.count, 3, 'count = Σ(count ?? 0)');
    assert.ok(Number.isFinite(merged.weight) && merged.weight === 2, 'weight = max(weight ?? 0)');
    const eff = store.effectiveWeightOf(merged, now + 10);
    assert.ok(Number.isFinite(eff), `effectiveWeight 必须有限（旧 NaN 出生即 near-death）：${eff}`);
    assert.ok(eff >= 0.5, '合并卡可过注入候选线');
  });

  it('weight undefined 的 legacy 卡合并后 weight 不为 NaN', () => {
    mkWs();
    const now = Date.now();
    const legacy = [
      { id: 'w1', kind: 'success', category: 'OTHER', memoryCategory: 'implementation', summary: 'deploy pipeline verified green build', weight: undefined as any, count: 1, taskStyle: 'all', lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '' },
      { id: 'w2', kind: 'success', category: 'OTHER', memoryCategory: 'implementation', summary: 'deploy pipeline verified with smoke tests', weight: 3, count: 1, taskStyle: 'all', lastSeen: now - 5, firstSeen: now - 5, applicableTiers: [], sourceContext: '' },
    ];
    fs.writeFileSync(memPath(), JSON.stringify({ meta: { version: '1.0.0', lastUpdated: now, totalCards: 2 }, cards: legacy }, null, 2), 'utf-8');
    const store = new RefinedMemoryStore(ws);
    const results = store.mergeSimilarCards(now + 10);
    assert.equal(results.length, 1);
    const merged = store.list().find(c => c.id === results[0].mergedId) as any;
    assert.ok(Number.isFinite(merged.weight), `weight 必须有限：${merged.weight}`);
  });
});

describe('包C 缺陷8：markInjected 账本进程级（短命实例记账不丢）', () => {
  afterEach(cleanupAll);

  it('同一 store 实例 markInjected 两次 → 最近时间与注入次数均可查', () => {
    resetInjectionLedgerForTest();
    mkWs();
    const store = new RefinedMemoryStore(ws);
    store.markInjected(['c-a'], 1000);
    store.markInjected(['c-a'], 2000);
    assert.equal(store.injectedAtOf('c-a'), 2000, 'injectedAtOf 可查最近注入时间');
    assert.equal(store.injectedCountOf('c-a'), 2, '两次注入都有账（注入次数）');
  });

  it('跨实例可读：runAgentTask 每步 new 的短命实例记账后，/memory stats 的新实例可查', () => {
    resetInjectionLedgerForTest();
    mkWs();
    // 模拟 runAgentTask：短命实例记账即弃
    new RefinedMemoryStore(ws).markInjected(['card-x'], 1234);
    // 另一个全新实例（runMemoryCommand stats 路径每次 new）——旧实例级账本在此归零
    const fresh = new RefinedMemoryStore(ws);
    assert.equal(fresh.injectedAtOf('card-x'), 1234, '进程级账本跨实例可读');
    assert.equal(fresh.injectedCountOf('card-x'), 1);
    // markInjected 契约不变：仍不写盘
    const before = fs.existsSync(memPath()) ? fs.readFileSync(memPath(), 'utf-8') : '';
    fresh.markInjected(['card-y'], 5678);
    const after = fs.existsSync(memPath()) ? fs.readFileSync(memPath(), 'utf-8') : '';
    assert.equal(after, before, 'markInjected 禁止写盘（契约 v3 不变）');
  });
});
