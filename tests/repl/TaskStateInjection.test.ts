// tests/repl/TaskStateInjection.test.ts
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptBuilder } from '../../src/cli/repl/PromptBuilder.js';
import { Session } from '../../src/cli/repl/Session.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';
import { TaskStateStore } from '../../src/memory/taskState.js';

const dirs: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-task-inject-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('PromptBuilder TaskState injection U3', () => {
  it('injects task state before recent context when currentTaskId exists', async () => {
    const ws = workspace();
    const session = new Session({ workspace: ws, tier: 'high' });
    session.currentTaskId = 'task-inject-1';
    const store = new TaskStateStore(ws);
    store.create('task-inject-1', '修复登录接口偶发 500');
    store.update('task-inject-1', (s) => ({
      ...s,
      currentGoal: '完成重试逻辑',
      nextStep: '执行集成测试',
      decisions: [{ ts: Date.now(), what: '采用指数退避' }],
      risks: [{ ts: Date.now(), risk: '生产数据库连接尚未确认' }],
    }));
    session.addTurn({
      id: 'turn-1', timestamp: Date.now(), userInput: '最近上下文标记',
      userInputType: 'task', tier: 'high', result: { success: false, summary: '未完成' },
    });

    const prompt = await new PromptBuilder(session, TierRegistry.get('high')).buildForTask('继续修复');
    assert.ok(prompt.includes('【任务状态】'));
    assert.ok(prompt.includes('修复登录接口偶发 500'));
    assert.ok(prompt.includes('采用指数退避'));
    assert.ok(prompt.includes('执行集成测试'));
    assert.ok(prompt.indexOf('【任务状态】') < prompt.indexOf('【最近上下文'), '状态应位于最近上下文之前');
  });

  it('without current task state leaves the prompt usable', async () => {
    const session = new Session({ workspace: workspace(), tier: 'high' });
    const prompt = await new PromptBuilder(session, TierRegistry.get('high')).buildForTask('普通任务');
    assert.ok(prompt.includes('【当前任务】'));
    assert.ok(!prompt.includes('【任务状态】'));
  });
});
