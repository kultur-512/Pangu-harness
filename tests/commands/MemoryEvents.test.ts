// tests/commands/MemoryEvents.test.ts
// R4 挂载验收：`/memory events` 事件查询视图（CLI 层）。
//   数据源 = ~/.panshalach/rollouts/<sessionId>.jsonl 的 agent 事件（只读）；
//   覆盖：默认列明细 / --kind / --task / --topic / --limit / --stats / 空会话容错。
//
// 写法沿用仓库惯例：随机 sessionId 避免污染真实会话；afterEach 删除生成的 rollout 文件。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runMemoryCommand } from '../../src/cli/MemoryCommand.js';
import { appendAgentEvent, deleteRollout } from '../../src/cli/repl/rolloutStore.js';
import type { AgentEvent, AgentEventKind } from '../../src/cli/repl/types.js';

const cleanup: string[] = [];
function freshSession(): string {
  const sid = 'evtcmd-' + crypto.randomBytes(6).toString('hex');
  cleanup.push(sid);
  return sid;
}
function mk(id: string, kind: AgentEventKind, topic: string, summary: string, ts: number, taskId?: string): AgentEvent {
  return { id, kind, topic, summary, ts, sessionId: 'unused', taskId };
}

describe('R4 /memory events 子命令', () => {
  afterEach(() => {
    for (const sid of cleanup) deleteRollout(sid);
    cleanup.length = 0;
  });

  it('默认列出事件明细（含 kind / topic / summary）', async () => {
    const sid = freshSession();
    const t0 = Date.now();
    appendAgentEvent(sid, { ...mk('e1', 'decision', '架构', '采用事件账本', t0 + 1, 'task-a'), sessionId: sid });
    appendAgentEvent(sid, { ...mk('e2', 'verified', '质量', '单测通过', t0 + 2, 'task-a'), sessionId: sid });

    const out = await runMemoryCommand(['events', '--session', sid], process.cwd());
    assert.match(out, /会话 evtcmd-/);
    assert.match(out, /decision/);
    assert.match(out, /采用事件账本/);
    assert.match(out, /verified/);
    assert.match(out, /单测通过/);
    assert.match(out, /task=task-a/);
  });

  it('--kind 过滤；--limit 截断并提示', async () => {
    const sid = freshSession();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      appendAgentEvent(sid, { ...mk(`f${i}`, 'failure', '测试', `失败 ${i}`, t0 + i, 'task-b'), sessionId: sid });
    }
    const onlyFailures = await runMemoryCommand(['events', '--session', sid, '--kind', 'failure'], process.cwd());
    assert.match(onlyFailures, /失败 0/);
    assert.match(onlyFailures, /kind=failure/);

    const limited = await runMemoryCommand(['events', '--session', sid, '--limit', '2'], process.cwd());
    assert.match(limited, /已截断至 2 条/);

    const noMatch = await runMemoryCommand(['events', '--session', sid, '--kind', 'decision'], process.cwd());
    assert.match(noMatch, /没有匹配的事件/);
  });

  it('--task / --topic 过滤', async () => {
    const sid = freshSession();
    const t0 = Date.now();
    appendAgentEvent(sid, { ...mk('a1', 'decision', '架构', '决定甲', t0 + 1, 'task-a'), sessionId: sid });
    appendAgentEvent(sid, { ...mk('b1', 'decision', '部署', '决定乙', t0 + 2, 'task-b'), sessionId: sid });

    const byTask = await runMemoryCommand(['events', '--session', sid, '--task', 'task-b'], process.cwd());
    assert.match(byTask, /决定乙/);
    assert.doesNotMatch(byTask, /决定甲/);

    const byTopic = await runMemoryCommand(['events', '--session', sid, '--topic', '架构'], process.cwd());
    assert.match(byTopic, /决定甲/);
    assert.doesNotMatch(byTopic, /决定乙/);
  });

  it('--stats 聚合视图（按 topic / 按任务）', async () => {
    const sid = freshSession();
    const t0 = Date.now();
    appendAgentEvent(sid, { ...mk('s1', 'failure', '测试', '失败甲', t0 + 1, 'task-a'), sessionId: sid });
    appendAgentEvent(sid, { ...mk('s2', 'failure', '测试', '失败乙', t0 + 2, 'task-a'), sessionId: sid });
    appendAgentEvent(sid, { ...mk('s3', 'decision', '架构', '决定丙', t0 + 3, 'task-b'), sessionId: sid });

    const out = await runMemoryCommand(['events', '--session', sid, '--stats'], process.cwd());
    assert.match(out, /事件统计/);
    assert.match(out, /按 topic/);
    assert.match(out, /按任务/);
    assert.match(out, /测试/);
    assert.match(out, /task-b/);
  });

  it('空会话返回指引而非抛错', async () => {
    const sid = freshSession();
    const out = await runMemoryCommand(['events', '--session', sid], process.cwd());
    assert.match(out, /暂无业务事件|没有匹配的事件/);
  });

  it('help 文本包含 events 用法', async () => {
    const out = await runMemoryCommand(['help'], process.cwd());
    assert.match(out, /memory events/);
  });
});
