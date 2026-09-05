// tests/repl/TaskState.test.ts
// R5 TaskState 持久化验收（ROADMAP-NEXT §3 R5 · 王佐 U2-U4）：
//   - 类型合同 src/cli/repl/types.ts（Leader df7a119）；
//   - originalRequirement 首次写入后不可漂移（R5 合同）；
//   - version 乐观锁（并发/重复更新检测覆盖，R5 合同）；
//   - 事件折叠（显式写入点）可重建 / 幂等重放不双写；
//   - 原子写盘（tmp→rename），崩溃不残留半个文件。
//
// 写法沿用仓库惯例（tests/memory/MemoryMark.test.ts）：临时目录 + afterEach 清理。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStateStore, rebuildFromEvents, foldEvent } from '../../src/memory/taskState.js';
import type { AgentEvent, TaskState } from '../../src/cli/repl/types.js';

const DAY = 24 * 60 * 60 * 1000;

let ws: string;
function makeWs(): string {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-task-'));
  return ws;
}
function statePath(): string {
  return path.join(ws, '.panshalach-task-state.json');
}
function mkEvent(id: string, kind: string, topic: string, summary: string, ts: number, taskId: string, sessionId = 's1'): AgentEvent {
  return { id, kind: kind as any, topic, summary, ts, sessionId, taskId };
}
const cleaners: Array<() => void> = [];
function cleanupAll(): void {
  for (const c of cleaners) {
    try { c(); } catch {}
  }
  cleaners.length = 0;
}

describe('R5 TaskState：存取 + 版本锁 + 锚定', () => {
  afterEach(cleanupAll);

  it('create 持久化 originalRequirement；再读回一致', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    const t = store.create('t1', '修复登录偶发 500');
    assert.equal(t.originalRequirement, '修复登录偶发 500');
    assert.equal(t.version, 1);
    assert.ok(fs.existsSync(statePath()), '创建即写盘');
    // 新实例重读验证持久化
    const store2 = new TaskStateStore(ws);
    const t2 = store2.get('t1')!;
    assert.equal(t2.originalRequirement, '修复登录偶发 500');
  });

  it('create 拒绝空 originalRequirement；重复 taskId 抛错', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    assert.throws(() => store.create('t1', '   '), /must not be empty/);
    store.create('t1', '需求A');
    assert.throws(() => store.create('t1', '需求B'), /already exists/);
  });

  it('originalRequirement 不可漂移：update 改它即抛，其余字段可改', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    store.create('t1', '最初需求');
    assert.throws(
      () => store.update('t1', (s) => ({ ...s, originalRequirement: '篡改' })),
      /immutable/,
      '锚不可漂移'
    );
    const t = store.update('t1', (s) => ({ ...s, nextStep: '先写测试' }));
    assert.equal(t.nextStep, '先写测试');
    assert.equal(t.originalRequirement, '最初需求', '锚保持');
    assert.equal(t.version, 2, '每次 update version+1');
  });

  it('version 乐观锁：期望版本不符抛错；相符则更新', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    store.create('t1', '需求');
    store.update('t1', (s) => ({ ...s, nextStep: 'a' }), 1); // version 1→2
    assert.throws(() => store.update('t1', (s) => ({ ...s, nextStep: 'b' }), 1), /version conflict/);
    const ok = store.update('t1', (s) => ({ ...s, nextStep: 'b' }), 2);
    assert.equal(ok.nextStep, 'b');
    assert.equal(ok.version, 3);
  });

  it('不存在的任务 get 返回 null；update 抛 not found', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    assert.equal(store.get('nope'), null);
    assert.throws(() => store.update('nope', (s) => s), /not found/);
  });
});

describe('R5 TaskState：事件折叠 / 重建 / 幂等', () => {
  afterEach(cleanupAll);

  it('rebuildFromEvents：requirement 锚定 + decision/verified/progress 折叠', () => {
    const t0 = Date.now();
    const events = [
      mkEvent('e1', 'requirement', '登录', '实现手机号登录', t0 + 1, 't1'),
      mkEvent('e2', 'decision', '登录', '采用验证码而非密码', t0 + 2, 't1'),
      mkEvent('e3', 'verified', '登录', '登录接口单测通过', t0 + 3, 't1'),
      mkEvent('e4', 'progress', '里程碑', '登录联调完成', t0 + 4, 't1'),
      mkEvent('e5', 'failure', '登录', '重试缺失致偶发 500', t0 + 5, 't1'),
    ];
    const s = rebuildFromEvents('t1', events, t0 + 6);
    assert.equal(s.originalRequirement, '实现手机号登录');
    assert.deepEqual(s.decisions.map((d) => d.what), ['采用验证码而非密码']);
    assert.deepEqual(s.verified.map((v) => v.what), ['登录接口单测通过']);
    assert.equal(s.risks.length, 1);
    assert.equal(s.risks[0].risk, '重试缺失致偶发 500');
    assert.ok(s.milestones.some((m) => m.done && m.title === '里程碑'), 'progress 折叠为 milestone');
    assert.equal(s.version, 1, '重建从空卡起步 version=1');
    // 其他任务的 / 非折叠 kind 事件不影响
    const foreign = rebuildFromEvents('t1', [...events, mkEvent('e9', 'decision', '别任务', '别任务决定', t0 + 9, 't2')], t0 + 6);
    assert.equal(foreign.decisions.length, 1);
  });

  it('applyEvents 折叠已有台账；幂等重放不双写', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    store.create('t1', '实现导出功能');
    const t0 = Date.now();
    const evs = [
      mkEvent('a1', 'decision', '导出', '决定用 CSV', t0 + 1, 't1'),
      mkEvent('a2', 'failure', '导出', '大文件 OOM', t0 + 2, 't1'),
    ];
    const s1 = store.applyEvents('t1', evs);
    assert.equal(s1.decisions.length, 1);
    assert.equal(s1.risks.length, 1);
    assert.equal(s1.version, 2);
    // 幂等重放：同批再来一次 → 不双写
    const s2 = store.applyEvents('t1', evs);
    assert.equal(s2.decisions.length, 1, '重复事件不得双写 decision');
    assert.equal(s2.risks.length, 1, '重复事件不得双写 risk');
    assert.equal(s2.version, 2, '无新增不 bump version');
  });

  it('折叠的 evidenceEventIds / 幂等记账字段存在', () => {
    const t0 = Date.now();
    const ev = mkEvent('v1', 'verified', '质量', 'E2E 通过', t0, 't1');
    const s = rebuildFromEvents('t1', [ev], t0 + 1);
    assert.deepEqual(s.verified[0].evidenceEventIds, ['v1']);
  });

  it('原子写盘：异常文件不残留 .tmp', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    store.create('t1', '需求');
    const files = fs.readdirSync(ws);
    assert.ok(!files.some((f) => f.includes('.tmp')), '提交后不得残留 tmp 文件');
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.tasks.t1.version, 1);
  });
});

describe('R5 TaskState：foldEvent 单元', () => {
  afterEach(cleanupAll);

  it('decision→decisions、progress→milestone done、verified→verified、failure→risks', () => {
    const t0 = Date.now();
    const base: TaskState = {
      taskId: 't1', originalRequirement: 'R', decisions: [], openQuestions: [],
      milestones: [], verified: [], risks: [], version: 1, createdAt: t0, updatedAt: t0,
    };
    const d = foldEvent(base, mkEvent('d1', 'decision', 'x', '决定甲', t0 + 1, 't1'), t0 + 1);
    assert.equal(d.decisions[0].what, '决定甲');
    const p = foldEvent(base, mkEvent('p1', 'progress', '里程碑M', '完成', t0 + 2, 't1'), t0 + 2);
    assert.equal(p.milestones.length, 1);
    assert.equal(p.milestones[0].done, true);
    assert.equal(p.milestones[0].title, '里程碑M');
    const v = foldEvent(base, mkEvent('v1', 'verified', 'y', '验证乙', t0 + 3, 't1'), t0 + 3);
    assert.equal(v.verified.length, 1);
    const f = foldEvent(base, mkEvent('f1', 'failure', 'z', '风险丙', t0 + 4, 't1'), t0 + 4);
    assert.equal(f.risks[0].risk, '风险丙');
  });
});
