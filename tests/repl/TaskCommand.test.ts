// tests/repl/TaskCommand.test.ts
// R5 赵天昂 own 端:`/task` CLI 验收。
// 覆盖:
//   status  6 例(formatTaskStatus 字段覆盖、空数组占位、不存在 taskId、
//              无 taskId、session 绑定、占位 usage 已替换为真实实现)
//   risks   2 例(formatTaskRisks 空显式 (无风险)、多条按时间正序)
//   next    3 例(优先 nextStep 字段并标注来源、推导自未 done milestone、
//              全部未知 UNKNOWN 态显式 + 引导 decide)
//   decide  4 例(严格走 update:applyEvents 守卫、decisions 新增 version+1、
//              what 空拒绝不写盘、双参数形态 taskId+what+why 解析)
//
// 写法沿用 InitCommand.test.ts(ctx factory) + TaskState.test.ts(临时 ws + cleaners)。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import taskCommand from '../../src/cli/repl/commands/TaskCommand.js';
import { formatTaskStatus } from '../../src/cli/repl/commands/TaskCommand.format.js';
import { TaskStateStore } from '../../src/memory/taskState.js';

let ws: string;
const cleaners: Array<() => void> = [];
function cleanupAll(): void {
  for (const c of cleaners) {
    try { c(); } catch {}
  }
  cleaners.length = 0;
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-taskcmd-'));
  cleaners.push(() => fs.rmSync(ws, { recursive: true, force: true }));
});
afterEach(cleanupAll);

/** 伪 ctx:把 renderer 输出按通道捕获到数组,input 不读。 */
function ctx(opts: { session?: any } = {}): any {
  const out: { channel: string; msg: string }[] = [];
  return {
    session: opts.session ?? null,
    renderer: {
      writeLine: (m: string) => out.push({ channel: 'line', msg: m }),
      info: (m: string) => out.push({ channel: 'info', msg: m }),
      warn: (m: string) => out.push({ channel: 'warn', msg: m }),
      success: (m: string) => out.push({ channel: 'success', msg: m }),
      error: (m: string) => out.push({ channel: 'error', msg: m }),
    } as any,
    input: { read: async () => '' } as any,
    registry: null,
    repl: null,
    provider: null,
    _out: out,
  } as any;
}

describe('/task status 最小版 (R5 赵天昂 own 端)', () => {
  it('formatTaskStatus 渲染全部王佐原话字段', () => {
    // 准备:用 store 建一张台账,确保字段类型与 format 对齐
    const store = new TaskStateStore(ws);
    store.create('t1', '修复登录偶发 500');
    // 走 update 注入 currentGoal/nextStep(originalRequirement 不可漂移)
    store.update('t1', (cur) => ({ ...cur, currentGoal: '定位 500 根因', nextStep: '复现 → 看日志' }));
    const fresh = store.get('t1')!;
    const lines = formatTaskStatus(fresh);
    const text = lines.join('\n');

    assert.ok(Array.isArray(lines) && lines.length > 0, '返回 string[]');
    assert.ok(text.includes('taskId:           t1'), 'taskId 字段');
    assert.ok(text.includes('originalRequirement:'), 'originalRequirement 标题');
    assert.ok(text.includes('修复登录偶发 500'), 'originalRequirement 值');
    assert.ok(text.includes('currentGoal:'), 'currentGoal 字段');
    assert.ok(text.includes('decisions ('), 'decisions 段');
    assert.ok(text.includes('milestones ('), 'milestones 段');
    assert.ok(text.includes('verified ('), 'verified 段');
    assert.ok(text.includes('risks ('), 'risks 段');
    assert.ok(text.includes('nextStep:'), 'nextStep 字段');
    assert.ok(text.includes('version:'), 'version 字段');
    assert.ok(text.includes('updatedAt:'), 'updatedAt 字段');
  });

  it('formatTaskStatus 空数组显式占位 "(空)",缺失可选字段显式 "(未设置)"', () => {
    const store = new TaskStateStore(ws);
    store.create('t2', '初始需求');
    const fresh = store.get('t2')!;
    const text = formatTaskStatus(fresh).join('\n');

    assert.ok(text.includes('decisions (0):'), '空 decisions 计数');
    assert.ok(text.match(/decisions \(0\):\s*\n\s*\(空\)/), '空 decisions 显式占位');
    assert.ok(text.includes('risks (0):'), '空 risks 计数');
    assert.ok(text.includes('currentGoal:      (未设置)'), 'currentGoal 缺失显式 UNKNOWN');
    assert.ok(text.includes('nextStep:         (未设置)'), 'nextStep 缺失显式 UNKNOWN');
  });

  it('/task status <未存在 taskId> → renderer.warn + 提示', async () => {
    // store 文件不在也没关系:store.get 不存在的 taskId 自然返回 null
    const c = ctx();
    const result = await taskCommand.execute(c, ['status', 'nope-task']);
    const warnMsgs = c._out.filter((x: any) => x.channel === 'warn').map((x: any) => x.msg);
    const infoMsgs = c._out.filter((x: any) => x.channel === 'info').map((x: any) => x.msg);

    assert.ok(warnMsgs.some((m: string) => m.includes('nope-task')), 'warn 含 taskId');
    assert.ok(infoMsgs.some((m: string) => m.includes('/task orig')), 'info 引导到 orig');
    assert.equal(result.message, 'task 未找到');
  });

  it('/task status 无 taskId 且 session 未绑定 → renderer.warn + 用法', async () => {
    const c = ctx({ session: null });
    const result = await taskCommand.execute(c, ['status']);
    const warnMsgs = c._out.filter((x: any) => x.channel === 'warn').map((x: any) => x.msg);
    const infoMsgs = c._out.filter((x: any) => x.channel === 'info').map((x: any) => x.msg);
    const lineMsgs = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg);

    assert.ok(warnMsgs.some((m: string) => m.includes('未指定 taskId')), 'warn 提示未指定');
    assert.ok(infoMsgs.some((m: string) => m.includes('/task status [taskId]')), 'info 含用法');
    // 未生成台账数据(data 应为 undefined)
    assert.equal(result.data, undefined);
    // 不应走到 writeLine(纯 line 通道)
    assert.equal(lineMsgs.length, 0, '无 taskId 时不应走 writeLine');
  });

  it('session 绑定 currentTaskId 时,`/task status` 默认读取它', async () => {
    const store = new TaskStateStore(ws);
    store.create('sess-task', 'session 绑定的任务');
    const c = ctx({ session: { workspace: ws, currentTaskId: 'sess-task' } as any });
    const result = await taskCommand.execute(c, ['status']);
    const lineMsgs = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg);
    const text = lineMsgs.join('\n');

    assert.ok(text.includes('taskId:           sess-task'), '默认取 session.currentTaskId');
    assert.ok(text.includes('session 绑定的任务'), '展示 originalRequirement');
    assert.ok(result.data, '返回 data 为台账');
    assert.equal(result.data.taskId, 'sess-task');
  });

  it('子命令 risks / next / decide 占位 usage 已被真实实现替换', async () => {
    // 9/9 之前占位返回 "子命令待实现";现在各自走真实路径。
    // 这里只断言不再走占位分支(避免覆盖各子命令的细节测试)。
    // session 为 null + 不存在 taskId 走"task 未找到"(risks/next)/ "taskId 未指定"(decide 双参探测歧义)
    const c = ctx({ session: null });
    c._out.length = 0;
    const r = await taskCommand.execute(c, ['risks', 'never-exists']);
    assert.notEqual(r.message, '子命令待实现', 'risks 不再占位');
    assert.equal(r.message, 'task 未找到');

    c._out.length = 0;
    const r2 = await taskCommand.execute(c, ['next', 'never-exists']);
    assert.notEqual(r2.message, '子命令待实现', 'next 不再占位');
    assert.equal(r2.message, 'task 未找到');

    c._out.length = 0;
    const r3 = await taskCommand.execute(c, ['decide', 'never-exists', '"x"']);
    assert.notEqual(r3.message, '子命令待实现', 'decide 不再占位');
    // decide 解析时探测 rest[0] 为 what(因 taskId 不存在),taskId 未指定 → 拒绝
    assert.equal(r3.message, 'taskId 未指定');
  });
});

describe('/task risks (R5 赵天昂 own 端 · 9/9)', () => {
  it('空数组渲染 "(无风险)" 显式占位', async () => {
    const store = new TaskStateStore(ws);
    store.create('risk-empty', 'x');
    const c = ctx({ session: { workspace: ws } as any });
    const result = await taskCommand.execute(c, ['risks', 'risk-empty']);
    const lineMsgs = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg);
    const text = lineMsgs.join('\n');

    assert.ok(text.includes('risks (0):'), 'risks 计数行');
    assert.ok(text.includes('(无风险)'), '空显式占位');
    assert.equal(result.data.taskId, 'risk-empty');
  });

  it('多条 risks 按时间正序渲染,mitigation 后缀', async () => {
    const store = new TaskStateStore(ws);
    store.create('risk-multi', 'x');
    // 倒序写入两个风险,验证渲染层排序
    store.update('risk-multi', (cur) => ({
      ...cur,
      risks: [
        { ts: 200, risk: '第二个', mitigation: 'second-fix' },
        { ts: 100, risk: '第一个' },
      ],
    }));
    const c = ctx({ session: { workspace: ws } as any });
    await taskCommand.execute(c, ['risks', 'risk-multi']);
    const lineMsgs = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg);
    const text = lineMsgs.join('\n');

    const idxFirst = text.indexOf('第一个');
    const idxSecond = text.indexOf('第二个');
    assert.ok(idxFirst >= 0 && idxSecond >= 0, '两条都渲染');
    assert.ok(idxFirst < idxSecond, '按时间正序');
    assert.ok(text.includes('mitigation=second-fix'), 'mitigation 后缀');
  });

  it('无 taskId 且 session 未绑定 → warn + 用法', async () => {
    const c = ctx({ session: null });
    const result = await taskCommand.execute(c, ['risks']);
    const warnMsgs = c._out.filter((x: any) => x.channel === 'warn').map((x: any) => x.msg);
    const infoMsgs = c._out.filter((x: any) => x.channel === 'info').map((x: any) => x.msg);
    assert.ok(warnMsgs.some((m: string) => m.includes('未指定 taskId')), 'warn');
    assert.ok(infoMsgs.some((m: string) => m.includes('/task risks')), 'info 用法');
    assert.equal(result.message, '无可展示的风险');
  });
});

describe('/task next (R5 赵天昂 own 端 · 9/9)', () => {
  it('优先 nextStep 字段,标注 "来源: nextStep 字段"', async () => {
    const store = new TaskStateStore(ws);
    store.create('next-direct', 'x');
    store.update('next-direct', (cur) => ({ ...cur, nextStep: '直接看日志' }));
    const c = ctx({ session: { workspace: ws } as any });
    const result = await taskCommand.execute(c, ['next', 'next-direct']);
    const lineMsgs = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg);
    const text = lineMsgs.join('\n');

    assert.ok(text.includes('字段: 直接看日志'), 'nextStep 值直显');
    assert.ok(text.includes('来源: nextStep 字段'), '标注来源');
    assert.equal(result.data.nextStep, '直接看日志');
    assert.equal(result.data.derived, null, '有 nextStep 不推导');
  });

  it('缺失 nextStep,推导自未 done milestone.title,标注 "来源: 推导"', async () => {
    const store = new TaskStateStore(ws);
    store.create('next-derive', 'x');
    store.update('next-derive', (cur) => ({
      ...cur,
      milestones: [
        { ts: 100, title: '建表', done: true },
        { ts: 200, title: '写 service', done: true },
        { ts: 300, title: 'OAuth 回调回归', done: false },
      ],
    }));
    const c = ctx({ session: { workspace: ws } as any });
    const result = await taskCommand.execute(c, ['next', 'next-derive']);
    const lineMsgs = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg);
    const text = lineMsgs.join('\n');

    assert.ok(text.includes('字段: OAuth 回调回归'), '推导值正确');
    assert.ok(text.includes('来源: 推导'), '标注来源');
    assert.ok(text.includes('最后一个未 done milestone 的 title'), '推导路径说明');
    assert.equal(result.data.derived?.from, 'milestone-title', 'derived.from 正确');
  });

  it('缺失 title 但有 evidence,推导自 evidence', async () => {
    const store = new TaskStateStore(ws);
    store.create('next-evidence', 'x');
    store.update('next-evidence', (cur) => ({
      ...cur,
      milestones: [{ ts: 100, title: '', done: false, evidence: '复现 OAuth 网关 500' }],
    }));
    const c = ctx({ session: { workspace: ws } as any });
    await taskCommand.execute(c, ['next', 'next-evidence']);
    const text = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg).join('\n');
    assert.ok(text.includes('evidence'), '标注来源是 evidence');
  });

  it('milestones 全 done、risks 无 mitigation → UNKNOWN 态显式 + 引导 decide', async () => {
    const store = new TaskStateStore(ws);
    store.create('next-unknown', 'x');
    store.update('next-unknown', (cur) => ({
      ...cur,
      milestones: [{ ts: 100, title: '全做完', done: true }],
      risks: [{ ts: 200, risk: '风险无 mitigation' }],
    }));
    const c = ctx({ session: { workspace: ws } as any });
    const result = await taskCommand.execute(c, ['next', 'next-unknown']);
    const lineMsgs = c._out.filter((x: any) => x.channel === 'line').map((x: any) => x.msg);
    const infoMsgs = c._out.filter((x: any) => x.channel === 'info').map((x: any) => x.msg);
    const text = lineMsgs.join('\n');

    assert.ok(text.includes('无法推断'), 'UNKNOWN 显式');
    assert.ok(infoMsgs.some((m: string) => m.includes('/task decide')), '引导 decide');
    assert.equal(result.data.derived, null, '全缺不推导');
  });
});

describe('/task decide (R5 赵天昂 own 端 · 9/9 · 严格走 update)', () => {
  /** 守卫:applyEvents 一旦被调用即抛错,验证 decide 路径不调它。 */
  it('严格走 update:applyEvents 被调用即抛错', async () => {
    const store = new TaskStateStore(ws);
    store.create('guard-update', 'x');
    const TaskStateStoreMod = await import('../../src/memory/taskState.js');
    const proto: any = TaskStateStoreMod.TaskStateStore.prototype;
    const original = proto.applyEvents;
    let applyEventsCalled = false;
    proto.applyEvents = function () {
      applyEventsCalled = true;
      throw new Error('applyEvents must NOT be called from /task decide');
    };
    try {
      const c = ctx({ session: { workspace: ws } as any });
      await taskCommand.execute(c, ['decide', 'guard-update', '用 Redis 存 session']);
      assert.equal(applyEventsCalled, false, 'applyEvents 不被调用');
    } finally {
      proto.applyEvents = original;
    }
  });

  it('写盘后 store.get 看到 decisions 新增,version+1', async () => {
    const store = new TaskStateStore(ws);
    store.create('decide-write', 'x');
    const before = store.get('decide-write')!;
    assert.equal(before.decisions.length, 0, '起始无 decisions');
    assert.equal(before.version, 1, '起始 version=1');

    const c = ctx({ session: { workspace: ws } as any });
    const result = await taskCommand.execute(c, ['decide', 'decide-write', '改用 Redis 存 session', '避免重启丢登录态']);

    // 注:TaskStateStore cache 是 per-instance;TaskCommand 内创建的 store2 写盘后,
    // test 的 store1 缓存仍是旧值。用新实例从盘重读(对齐 TaskState.test.ts:51-52 王佐写法)。
    const after = new TaskStateStore(ws).get('decide-write')!;
    assert.equal(after.decisions.length, 1, '新增 1 条 decision');
    assert.equal(after.decisions[0].what, '改用 Redis 存 session');
    assert.equal(after.decisions[0].why, '避免重启丢登录态');
    assert.equal(after.version, 2, 'version+1');
    assert.equal(result.data.version, 2);
  });

  it('what 为空 → warn + 拒绝,不写盘', async () => {
    const store = new TaskStateStore(ws);
    store.create('decide-empty', 'x');
    const c = ctx({ session: { workspace: ws } as any });
    const result = await taskCommand.execute(c, ['decide', 'decide-empty', '   ']);
    const warnMsgs = c._out.filter((x: any) => x.channel === 'warn').map((x: any) => x.msg);
    assert.ok(warnMsgs.some((m: string) => m.includes('决策内容不能为空')), 'warn');
    assert.equal(result.message, '决策内容为空');
    const after = new TaskStateStore(ws).get('decide-empty')!;
    assert.equal(after.decisions.length, 0, '不写盘');
    assert.equal(after.version, 1, 'version 不变');
  });

  it('双参数形态(taskId 探测歧义):rest[0] 是 taskId 还是 what', async () => {
    const store = new TaskStateStore(ws);
    store.create('my-task', 'x');
    const c = ctx({ session: { workspace: ws } as any });
    // 输入:["my-task", "改用 Redis"]
    // rest[0]="my-task" 探测是已存在 taskId → 形态 A
    await taskCommand.execute(c, ['decide', 'my-task', '改用 Redis', '理由']);
    const after = new TaskStateStore(ws).get('my-task')!;
    assert.equal(after.decisions.length, 1, '决策写入 my-task');
    assert.equal(after.decisions[0].what, '改用 Redis');
    assert.equal(after.decisions[0].why, '理由');

    // 输入:["only-what"]
    // rest[0]="only-what" 探测不在 store → 视为 what,taskId 走 session 兜底
    const c2 = ctx({ session: { workspace: ws, currentTaskId: 'my-task' } as any });
    await taskCommand.execute(c2, ['decide', '另一种选择', '另一种 why']);
    const after2 = new TaskStateStore(ws).get('my-task')!;
    assert.equal(after2.decisions.length, 2, '第二条决策');
    assert.equal(after2.decisions[1].what, '另一种选择');
    assert.equal(after2.decisions[1].why, '另一种 why');
  });
});