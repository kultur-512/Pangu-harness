// tests/repl/TaskCommand.test.ts
// R5 赵天昂 own 端:`/task status` 最小版验收。
// 覆盖:
//   1) formatTaskStatus 纯函数基本渲染(全部字段标签可见)
//   2) formatTaskStatus 空数组显式占位(UNKNOWN 态归 CLI 渲染层)
//   3) /task status <不存在> → renderer.warn + 提示
//   4) /task status(无 taskId 且 session 未绑定) → renderer.warn + 用法
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

  it('子命令 risks / next / decide 占位 usage,不进入 status 路径', async () => {
    const c = ctx();
    for (const sub of ['risks', 'next', 'decide']) {
      c._out.length = 0;
      const r = await taskCommand.execute(c, [sub, 't1']);
      const infoMsgs = c._out.filter((x: any) => x.channel === 'info').map((x: any) => x.msg);
      assert.ok(infoMsgs.some((m: string) => m.includes(`/task ${sub}`)), `${sub} 提示明日交付`);
      assert.ok(infoMsgs.some((m: string) => m.includes('用法:')), `${sub} 含用法`);
      assert.equal(r.message, '子命令待实现');
    }
  });
});