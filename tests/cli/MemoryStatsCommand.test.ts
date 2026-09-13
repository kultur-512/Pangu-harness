// tests/cli/MemoryStatsCommand.test.ts
// 包C 缺陷7 对抗性回归：/memory stats 注入审计视图——
//   总卡数（按 kind 分列）+ markInjected 账本（cardId → 注入次数 / 最近注入时间）
//   + 最近 10 条 memory_injected 事件（复用 events.ts）。
// 三处路由（src/cli/MemoryCommand.ts switch、repl/commands/MemoryCommand.ts、
// CommandRouter /memory 直通）中本文件覆盖 CLI 入口 runMemoryCommand；
// 未知子命令行为不回归。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runMemoryCommand } from '../../src/cli/MemoryCommand.js';
import { RefinedMemoryStore, resetInjectionLedgerForTest } from '../../src/memory/RefinedMemoryStore.js';
import { appendAgentEvent, deleteRollout } from '../../src/cli/repl/rolloutStore.js';

let ws = '';
const eventSessions: string[] = [];

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-memstats-'));
  resetInjectionLedgerForTest();
});
afterEach(() => {
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
  for (const sid of eventSessions) deleteRollout(sid);
  eventSessions.length = 0;
  delete process.env.PANSHA_SESSION_ID;
});

function mkCard(id: string, kind: string): any {
  const now = Date.now();
  return {
    id, kind, category: 'OTHER', memoryCategory: kind === 'preference' ? 'insight' : 'implementation',
    summary: `${kind} 卡 ${id}`, weight: 1, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now,
  };
}

describe('包C 缺陷7：/memory stats 注入审计视图', () => {
  it('输出总卡数（按 kind 分列）与注入账本行（次数/最近时间）', async () => {
    const store = new RefinedMemoryStore(ws);
    store.save([mkCard('f-1', 'failure'), mkCard('f-2', 'failure'), mkCard('s-1', 'success'), mkCard('p-1', 'preference')]);

    // 注入账本：p-1 注入两次、f-1 一次（记账在 stats 之前、任意实例上发生）
    store.markInjected(['p-1'], 1_000);
    store.markInjected(['p-1'], 2_000);
    store.markInjected(['f-1'], 3_000);

    const out = await runMemoryCommand(['stats'], ws);
    assert.ok(out.includes('总卡数'), `输出含总卡数：\n${out}`);
    assert.ok(out.includes('4'), '总卡数 4');
    assert.ok(out.includes('failure 2') && out.includes('success 1') && out.includes('preference 1'), `按 kind 分列：\n${out}`);
    // 注入账本行：cardId → 注入次数 / 最近注入时间
    assert.ok(/\[p-1\][^\n]*注入\s*2\s*次/.test(out), `含注入次数行：\n${out}`);
    assert.ok(out.includes('[p-1]'), '账本含卡 id');
    assert.ok(out.includes('[f-1]') && out.includes('注入 1 次'));
    assert.ok(!out.includes('[s-1]') || out.indexOf('[s-1] 注入') === -1, '未注入的卡不进账本行');
  });

  it('最近 memory_injected 事件可见（复用 events.ts，经 PANSHA_SESSION_ID 定位会话）', async () => {
    const store = new RefinedMemoryStore(ws);
    store.save([mkCard('f-1', 'failure')]);
    store.markInjected(['f-1'], Date.now());

    const sid = 'memstats-' + crypto.randomBytes(6).toString('hex');
    eventSessions.push(sid);
    appendAgentEvent(sid, {
      id: 'evt-inj-1', ts: Date.now(), kind: 'memory_injected', topic: 'injection',
      summary: '本次任务注入 1 张记忆卡', refs: ['f-1'], sessionId: sid, taskId: 't-stats',
    });
    process.env.PANSHA_SESSION_ID = sid;

    const out = await runMemoryCommand(['stats'], ws);
    assert.ok(out.includes('memory_injected'), `含 memory_injected 事件区：\n${out}`);
    assert.ok(out.includes('本次任务注入 1 张记忆卡'), '事件 summary 可见');
  });

  it('空库 + 无事件 → 给出指引而非抛错', async () => {
    const out = await runMemoryCommand(['stats'], ws);
    assert.ok(out.includes('总卡数'), `空库也有统计骨架：\n${out}`);
  });

  it('未知子命令行为不回归', async () => {
    const out = await runMemoryCommand(['nosuchthing'], ws);
    assert.ok(out.includes('未知子命令'), `旧错误路径保持：\n${out}`);
    assert.ok(out.includes('memory list'), '未知子命令回显帮助');
  });

  it('help 含 stats 行', async () => {
    const out = await runMemoryCommand(['help'], ws);
    assert.ok(out.includes('stats'), `帮助含 stats：\n${out}`);
  });
});
