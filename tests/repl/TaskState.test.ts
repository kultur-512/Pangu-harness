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

// ==================== 包C 缺陷5：绝对路径直采（env/显式参数） ====================
// 旧实现一律 join(workspaceRoot, customFilename ?? DEFAULT)——env
// PANSHA_TASK_STATE_FILE 传绝对路径（runAgentTask.ts / PromptBuilder.ts 原样透传）
// 时拼成 `<ws>\P:\...` 垃圾路径 → 静默空台账。修复：对齐 RefinedMemoryStore，
// isAbsolute(resolved) 直接采用。

describe('包C 缺陷5：TaskStateStore 路径解析（绝对路径直采）', () => {
  afterEach(cleanupAll);

  it('customFilename 传绝对路径 → filePath 即该绝对路径（不被 join 成垃圾路径）', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const abs = path.join(ws, 'nested', 'state.json');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const store = new TaskStateStore(ws, abs);
    assert.equal(store.path, abs, '绝对路径原样采用');
    store.create('t1', '需求');
    assert.ok(fs.existsSync(abs), '落盘到该绝对路径');
    const store2 = new TaskStateStore(ws, abs);
    assert.equal(store2.get('t1')!.originalRequirement, '需求', '新实例可读回');
  });

  it('传相对名 → join(workspaceRoot, name) 行为不变', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws, 'custom-state.json');
    assert.equal(store.path, path.join(ws, 'custom-state.json'));
    store.create('t1', '需求');
    assert.ok(fs.existsSync(path.join(ws, 'custom-state.json')));
  });

  it('env PANSHA_TASK_STATE_FILE 绝对路径直采（runAgentTask/PromptBuilder 透传场景）', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const abs = path.join(ws, 'env-state.json');
    const prev = process.env.PANSHA_TASK_STATE_FILE;
    process.env.PANSHA_TASK_STATE_FILE = abs;
    try {
      const store = new TaskStateStore(ws); // 仅 env（显式参数缺省）
      assert.equal(store.path, abs, 'env 绝对路径不被 join 污染');
      store.create('t1', '需求');
      assert.ok(fs.existsSync(abs), 'env 指向的文件真实落盘（旧实现静默空台账）');
    } finally {
      if (prev === undefined) delete process.env.PANSHA_TASK_STATE_FILE;
      else process.env.PANSHA_TASK_STATE_FILE = prev;
    }
  });
});

// ==================== 9/14 接口对齐：TaskState.record* 原语 ====================
// 语义：显式记录（真实业务节点/CLI 用户声明调用），不猜轨迹。
// 纪律：全部走 update() → 沿用乐观锁 + originalRequirement 锚定。

describe('R5 TaskState：record* 显式记录原语', () => {
  afterEach(cleanupAll);

  it('recordDecision / recordRisk / recordOpenQuestion 追加且 version 递增', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    store.create('t1', '实现导出功能');

    const d = store.recordDecision('t1', '用 CSV 作为导出格式', '依赖少', ['src/export.ts']);
    assert.equal(d.decisions.length, 1);
    assert.equal(d.decisions[0].what, '用 CSV 作为导出格式');
    assert.equal(d.decisions[0].why, '依赖少');
    assert.deepEqual(d.decisions[0].refs, ['src/export.ts']);
    assert.equal(d.version, 2, '每次 record 走 update → version+1');

    const r = store.recordRisk('t1', '大文件可能 OOM', '分块写入');
    assert.equal(r.risks.length, 1);
    assert.equal(r.risks[0].risk, '大文件可能 OOM');
    assert.equal(r.risks[0].mitigation, '分块写入');

    const q = store.recordOpenQuestion('t1', '是否需要流式导出？');
    assert.equal(q.openQuestions.length, 1);
    assert.equal(q.openQuestions[0].status, 'open');
    assert.equal(q.version, 4);
  });

  it('recordMilestone / recordVerified / setNextStep / setCurrentGoal', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    store.create('t1', '需求原文');

    const m = store.recordMilestone('t1', '骨架落地', false);
    assert.equal(m.milestones[0].title, '骨架落地');
    assert.equal(m.milestones[0].done, false);

    const v = store.recordVerified('t1', '导出单测通过', 'npm test', 'node --test', ['evt-1']);
    assert.equal(v.verified[0].what, '导出单测通过');
    assert.deepEqual(v.verified[0].evidenceEventIds, ['evt-1']);

    const n = store.setNextStep('t1', '补边界用例');
    assert.equal(n.nextStep, '补边界用例');
    const cleared = store.setNextStep('t1', '   ');
    assert.equal(cleared.nextStep, undefined, '空串清空 nextStep（不留过期误导）');

    const g = store.setCurrentGoal('t1', '本迭代先做导出');
    assert.equal(g.currentGoal, '本迭代先做导出');
    assert.equal(g.originalRequirement, '需求原文', '锚不漂移');
  });

  it('record* 对不存在任务抛错；持久化可重读', () => {
    makeWs(); cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
    const store = new TaskStateStore(ws);
    assert.throws(() => store.recordDecision('nope', 'x'), /not found/);

    store.create('t1', '需求');
    store.recordDecision('t1', '决定A');
    store.recordRisk('t1', '风险B');
    // 新实例重读验证落盘
    const store2 = new TaskStateStore(ws);
    const t = store2.get('t1')!;
    assert.equal(t.decisions.length, 1);
    assert.equal(t.risks.length, 1);
    assert.equal(t.version, 3);
  });
});
