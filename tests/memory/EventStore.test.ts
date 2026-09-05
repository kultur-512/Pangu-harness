// tests/memory/EventStore.test.ts
// R4 MemoryEventStore 验收（ROADMAP-NEXT §3 R4，王佐 U1-U3）：
// 在 rolloutStore 底座（appendAgentEvent/readAgentEvents，df7a119）之上做
// kind / topic / session / taskId 维度的**只读有界**查询；禁止自行读写 JSONL。
//
// 写法沿用仓库惯例（tests/repl/rolloutStore.test.ts / ContextMemoryV3.test.ts）：
// 用随机 sessionId 避免污染真实会话；afterEach 删除生成的 rollout 文件。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MemoryEventStore } from '../../src/memory/events.js';
import { appendAgentEvent, readAgentEvents, deleteRollout } from '../../src/cli/repl/rolloutStore.js';
import type { AgentEvent, AgentEventKind } from '../../src/cli/repl/types.js';

const DAY = 24 * 60 * 60 * 1000;
const cleanup: string[] = [];
function freshSession(): string {
  const sid = 'evt-' + crypto.randomBytes(6).toString('hex');
  cleanup.push(sid);
  return sid;
}
function mk(id: string, kind: AgentEventKind, topic: string, ts: number, taskId?: string): AgentEvent {
  return { id, kind, topic, summary: `${kind}@${topic}`, ts, sessionId: 'unused', taskId };
}
function writeAll(sid: string, events: AgentEvent[]): void {
  for (const e of events) appendAgentEvent(sid, { ...e, sessionId: sid });
}

describe('MemoryEventStore R4：只读有界查询', () => {
  afterEach(() => {
    for (const sid of cleanup) deleteRollout(sid);
    cleanup.length = 0;
  });

  it('query 按 kind 过滤；并集可多 kind', () => {
    const sid = freshSession();
    const t0 = Date.now();
    writeAll(sid, [
      mk('e1', 'decision', '架构', t0 + 1),
      mk('e2', 'failure', '测试', t0 + 2),
      mk('e3', 'decision', '部署', t0 + 3),
    ]);
    const store = new MemoryEventStore(sid);
    const decisions = store.query({ kind: 'decision' });
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions.map((e) => e.id), ['e1', 'e3']);

    const multi = store.query({ kind: ['decision', 'failure'] });
    assert.deepEqual(multi.map((e) => e.id), ['e1', 'e2', 'e3']);
  });

  it('query 支持 taskId / 时间窗 / 无匹配返回空数组', () => {
    const sid = freshSession();
    const t0 = Date.now();
    writeAll(sid, [
      mk('e1', 'decision', '架构', t0 + 1, 'task-a'),
      mk('e2', 'failure', '测试', t0 + 100, 'task-a'),
      mk('e3', 'progress', '部署', t0 + 200, 'task-b'),
    ]);
    const store = new MemoryEventStore(sid);
    assert.deepEqual(store.query({ taskId: 'task-a' }).map((e) => e.id), ['e1', 'e2']);
    assert.deepEqual(store.query({ kind: 'failure', taskId: 'task-a' }).map((e) => e.id), ['e2']);
    assert.deepEqual(store.query({ taskId: 'nope' }), [], '不存在的 task 返回空');
    assert.deepEqual(store.query({ sinceTs: t0 + 50 }).map((e) => e.id), ['e2', 'e3']);
    assert.deepEqual(store.query({ untilTs: t0 + 50 }).map((e) => e.id), ['e1']);
  });

  it('topic 为大小写不敏感子串匹配；不存在的 session 返回空', () => {
    const sid = freshSession();
    writeAll(sid, [
      mk('e1', 'decision', '架构设计', Date.now() + 1),
      mk('e2', 'decision', '接口对齐', Date.now() + 2),
    ]);
    const store = new MemoryEventStore(sid);
    assert.deepEqual(store.query({ topic: '接口' }).map((e) => e.id), ['e2']);
    const ghost = new MemoryEventStore('evt-no-such-session-' + crypto.randomBytes(4).toString('hex'));
    assert.deepEqual(ghost.query({}), [], '不存在的会话返回空且不抛');
  });

  it('latest 取尾部；countByKind 计数', () => {
    const sid = freshSession();
    const t0 = Date.now();
    writeAll(sid, [
      mk('e1', 'failure', 'a', t0 + 1),
      mk('e2', 'failure', 'b', t0 + 2),
      mk('e3', 'decision', 'c', t0 + 3),
    ]);
    const store = new MemoryEventStore(sid);
    assert.deepEqual(store.latest(2).map((e) => e.id), ['e2', 'e3'], '最新 N 条按 ts 升序返回尾部');
    assert.equal(store.countByKind('failure'), 2);
    assert.equal(store.countByKind('decision'), 1);
  });

  it('topicStats / taskSummaries 聚合正确；time 窗口对 topic 过滤生效', () => {
    const sid = freshSession();
    const t0 = Date.now();
    writeAll(sid, [
      mk('e1', 'failure', '测试', t0 + 1, 'task-a'),
      mk('e2', 'failure', '测试', t0 + 2, 'task-a'),
      mk('e3', 'failure', '测试', t0 + 2, 'task-b'),
      mk('e4', 'decision', '架构', t0 + 3, 'task-b'),
      mk('e5', 'failure', '测试', t0 + 3), // 无 taskId
    ]);
    const store = new MemoryEventStore(sid);
    const topicTop = store.topicStats()[0];
    assert.equal(topicTop.topic, '测试');
    assert.equal(topicTop.count, 4);

    const ts = store.taskSummaries();
    const taskA = ts.find((s) => s.taskId === 'task-a')!;
    const taskB = ts.find((s) => s.taskId === 'task-b')!;
    assert.equal(taskA.count, 2);
    assert.deepEqual(taskA.kinds, ['failure']);
    assert.equal(taskB.count, 2);
    assert.deepEqual(taskB.kinds, ['failure', 'decision']);
    assert.equal(ts.find((s) => s.taskId === '__untracked')!.count, 1, '无 taskId 事件归入 __untracked');

    // time 窗口与 topic 组合过滤
    const ranged = store.query({ kind: 'failure', topic: '测试', sinceTs: t0 + 3 });
    assert.deepEqual(ranged.map((e) => e.id), ['e5'], 'topic + kind + 时间窗组合生效');
  });
});
