// tests/memory/MemoryQuarantineAtomic.test.ts
// 包C 缺陷3/4/10 对抗性回归（2026-09-13 记忆系统审计）：
//
// 缺陷3【P1】load() 无校验 + 损坏静默：旧 JSON.parse 后直接 cast，cards 非数组
//   时下游 .map 抛 TypeError 被上层 catch 吞 → 静默零注入；撕裂 JSON → catch 后
//   返回空库缓存 → 下次 save 静默清库。修复：load 后校验 Array.isArray(cards)
//   + 逐卡 id/summary；不合格 → quarantine（原文件改名 <原名>.corrupt-<时间戳>）
//   + 从空库启动 + console.error 一条告警。
//
// 缺陷4【P1】非原子写：RefinedMemoryStore 7 处 writeFileSync 换共享
//   src/utils/atomicFile.ts atomicWriteFileSync（同目录 tmp + renameSync + 失败
//   清理；taskState.commitAtomic 同蓝本）。
//
// 缺陷10【P2】import 无校验：parsed.cards 原样写盘 → 形状坏 JSON 拒绝且盘不变。

import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsDefault from 'node:fs'; // mock 用默认导出对象（与 atomicFile 内部调用同源）
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import { atomicWriteFileSync } from '../../src/utils/atomicFile.js';

let ws = '';
function mkWs(): string {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-quarantine-'));
  return ws;
}
function cleanupAll() {
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
}
function memPath(): string { return path.join(ws, '.panshalach-memory.json'); }
function card(i: number): any {
  const now = Date.now();
  return {
    id: `c-${i}`, kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure',
    summary: `卡 ${i}`, weight: 1, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now,
  };
}

describe('包C 缺陷3：load() 校验 + 损坏隔离（quarantine）', () => {
  afterEach(cleanupAll);

  it('cards 非 JSON 数组（{"cards":"oops"}）→ load 空库 + 原文件改名 .corrupt-* + save 正常', () => {
    mkWs();
    fs.writeFileSync(memPath(), JSON.stringify({ meta: { version: '1.0.0', lastUpdated: 1, totalCards: 1 }, cards: 'oops' }), 'utf-8');
    const errLines: string[] = [];
    const errMock = mock.method(console, 'error', (...a: unknown[]) => { errLines.push(a.join(' ')); });
    try {
      const store = new RefinedMemoryStore(ws);
      const file = store.load();
      assert.equal(file.cards.length, 0, '损坏文件 → 空库启动');
      assert.ok(!fs.existsSync(memPath()), '原文件必须被改名隔离');
      const quarantined = fs.readdirSync(ws).filter(f => f.startsWith('.panshalach-memory.json.corrupt-'));
      assert.equal(quarantined.length, 1, `恰一个 .corrupt-* 隔离件：${quarantined}`);
      assert.ok(errLines.some(l => l.includes('.panshalach-memory.json')), '必须 console.error 一条告警');

      // 后续 save 正常（不再静默清库二次写坏文件）
      const r = store.save([card(1)]);
      assert.equal(r.written, 1);
      assert.equal(JSON.parse(fs.readFileSync(memPath(), 'utf-8')).cards.length, 1);
    } finally { errMock.mock.restore(); }
  });

  it('撕裂 JSON → 同样隔离，不静默返回空库缓存', () => {
    mkWs();
    const torn = JSON.stringify({ meta: { version: '1.0.0' }, cards: [card(9)] }, null, 2).slice(0, 40);
    fs.writeFileSync(memPath(), torn, 'utf-8');
    const errMock = mock.method(console, 'error', () => {});
    try {
      const store = new RefinedMemoryStore(ws);
      assert.equal(store.load().cards.length, 0);
      assert.ok(!fs.existsSync(memPath()), '撕裂文件被隔离');
      assert.equal(fs.readdirSync(ws).filter(f => f.includes('.corrupt-')).length, 1);
      // 隔离后 save 写出的是全新干净文件
      store.save([card(1)]);
      const reparsed = JSON.parse(fs.readFileSync(memPath(), 'utf-8'));
      assert.equal(reparsed.cards.length, 1);
    } finally { errMock.mock.restore(); }
  });

  it('逐卡校验：单卡缺 id / summary → 整文件隔离（防下游 .map TypeError）', () => {
    mkWs();
    const bad = { meta: { version: '1.0.0' }, cards: [card(1), { id: 42, summary: 'id 非字符串' }] };
    fs.writeFileSync(memPath(), JSON.stringify(bad), 'utf-8');
    const errMock = mock.method(console, 'error', () => {});
    try {
      const store = new RefinedMemoryStore(ws);
      assert.equal(store.load().cards.length, 0);
      assert.ok(fs.readdirSync(ws).some(f => f.includes('.corrupt-')));
    } finally { errMock.mock.restore(); }

    // 无 summary 同理
    mkWs();
    const bad2 = { meta: { version: '1.0.0' }, cards: [{ id: 'x' }] };
    fs.writeFileSync(memPath(), JSON.stringify(bad2), 'utf-8');
    const errMock2 = mock.method(console, 'error', () => {});
    try {
      const store = new RefinedMemoryStore(ws);
      assert.equal(store.load().cards.length, 0);
      assert.ok(fs.readdirSync(ws).some(f => f.includes('.corrupt-')));
    } finally { errMock2.mock.restore(); }
  });

  it('对照组：合法文件照常加载，不产生 .corrupt-*', () => {
    mkWs();
    fs.writeFileSync(memPath(), JSON.stringify({ meta: { version: '1.0.0', lastUpdated: 1, totalCards: 1 }, cards: [card(1)] }), 'utf-8');
    const store = new RefinedMemoryStore(ws);
    assert.equal(store.load().cards.length, 1);
    assert.equal(fs.readdirSync(ws).filter(f => f.includes('.corrupt-')).length, 0, '合法文件不受影响');
  });
});

describe('包C 缺陷4：原子写盘（atomicWriteFileSync）', () => {
  afterEach(cleanupAll);

  it('renameSync 抛错 → 原始错误上抛、目标文件保持旧内容、无 .tmp 残留', () => {
    mkWs();
    const target = path.join(ws, 'target.json');
    fs.writeFileSync(target, 'OLD-CONTENT', 'utf-8');
    const renameMock = mock.method(fsDefault, 'renameSync', () => { throw new Error('rename-boom'); });
    try {
      assert.throws(() => atomicWriteFileSync(target, 'NEW-CONTENT'), /rename-boom/);
      assert.equal(fs.readFileSync(target, 'utf-8'), 'OLD-CONTENT', '目标文件保持旧内容');
      assert.equal(fs.readdirSync(ws).filter(f => f.endsWith('.tmp')).length, 0, '无 tmp 残留');
    } finally { renameMock.mock.restore(); }
    // 恢复后同路径再写成功
    atomicWriteFileSync(target, 'NEW-CONTENT');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'NEW-CONTENT');
  });

  it('RefinedMemoryStore.save 走原子写：rename 失败时旧库保持 + 无 tmp 残留（7 处写盘统一）', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    store.save([card(1)]);
    const before = fs.readFileSync(memPath(), 'utf-8');
    const renameMock = mock.method(fsDefault, 'renameSync', () => { throw new Error('rename-fail'); });
    try {
      assert.throws(() => store.save([card(2)]));
      assert.equal(fs.readFileSync(memPath(), 'utf-8'), before, '写失败 → 旧记忆文件原封不动');
      assert.ok(!fs.readdirSync(ws).some(f => f.includes('.tmp')), '无 tmp 残留');
    } finally { renameMock.mock.restore(); }
    assert.equal(store.save([card(2)]).written, 2, '恢复后照常写盘');
  });

  it('forget / markVerified / clear 同走原子写（rename 失败不破坏旧文件）', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    store.save([card(1), card(2)]);
    for (const run of [
      () => store.forget('c-1'),
      () => store.markVerified(['c-2']),
      () => store.clear(),
    ]) {
      const snapshot = fs.readFileSync(memPath(), 'utf-8');
      const renameMock = mock.method(fsDefault, 'renameSync', () => { throw new Error('nope'); });
      try {
        assert.throws(() => run());
        assert.equal(fs.readFileSync(memPath(), 'utf-8'), snapshot, '失败不破坏旧文件');
        assert.ok(!fs.readdirSync(ws).some(f => f.includes('.tmp')));
      } finally { renameMock.mock.restore(); }
    }
  });

  it('taskState.commitAtomic 委托共享实现：行为不变（rename 失败 → 包裹错误 + 无 tmp）', async () => {
    mkWs();
    const { TaskStateStore } = await import('../../src/memory/taskState.js');
    const store = new TaskStateStore(ws);
    store.create('t1', '需求');
    const statePath = path.join(ws, '.panshalach-task-state.json');
    const before = fs.readFileSync(statePath, 'utf-8');
    const renameMock = mock.method(fsDefault, 'renameSync', () => { throw new Error('rename-x'); });
    try {
      assert.throws(() => store.update('t1', (s) => ({ ...s, nextStep: 'x' })), /task state write failed/);
      assert.equal(fs.readFileSync(statePath, 'utf-8'), before);
      assert.ok(!fs.readdirSync(ws).some(f => f.includes('.tmp')));
    } finally { renameMock.mock.restore(); }
  });
});

describe('包C 缺陷10：/memory import 校验（形状 + 大小）', () => {
  afterEach(cleanupAll);

  it('形状坏 JSON（cards 非数组 / 卡缺 id）→ 报错且盘上文件不变', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    store.save([card(1)]);
    const before = fs.readFileSync(memPath(), 'utf-8');

    assert.throws(() => store.import(JSON.stringify({ meta: {}, cards: 'oops' })), /导入被拒绝|cards/);
    assert.throws(() => store.import(JSON.stringify({ meta: {}, cards: [{ nope: true }] })), /导入被拒绝/);
    assert.equal(fs.readFileSync(memPath(), 'utf-8'), before, '盘上文件不变');

    // merge 路径同样拒绝
    assert.throws(() => store.import(JSON.stringify({ meta: {}, cards: [{ id: 'x' }] }), true), /导入被拒绝/);
    assert.equal(fs.readFileSync(memPath(), 'utf-8'), before);
  });

  it('超 200KiB → 拒绝（沿用 save 的 MAX_FILE_SIZE_BYTES）', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const big = { meta: { version: '1.0.0' }, cards: [{ ...card(1), summary: 'x'.repeat(220 * 1024) }] };
    assert.throws(() => store.import(JSON.stringify(big)), /导入被拒绝/);
  });

  it('合法导入照常工作（对照组）', () => {
    mkWs();
    const store = new RefinedMemoryStore(ws);
    const r = store.import(JSON.stringify({ meta: { version: '1.0.0', lastUpdated: 1, totalCards: 1 }, cards: [card(7)] }));
    assert.equal(r.imported, 1);
    assert.equal(store.list().length, 1);
  });
});
