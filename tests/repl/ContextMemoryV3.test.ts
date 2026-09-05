// tests/repl/ContextMemoryV3.test.ts
// 接口契约 v3 回归（上下文生命周期）：
// - compact 安全合并：快照→apply 之间新增的轮次绝不丢失（对抗评审 F5 修复）
// - CompactResult 携带 generation/coveredTurnIds/summarySource/syntheticTurn
// - rollout compact 标记事件：replayInto 消费后 resume 无模型重建压缩态（F6 修复）
// - PromptBuilder [M1] 卡号单一序列 == lastInjectedCardIds 顺序；无 score=score 双前缀

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/cli/repl/Session.js';
import { PromptBuilder } from '../../src/cli/repl/PromptBuilder.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';
import {
  startBackgroundCompact, applyCompactResult, buildFallbackCompactResult,
} from '../../src/cli/repl/compactService.js';
import {
  replayInto, appendEvent, readContextSnapshots, appendContextSnapshot,
} from '../../src/cli/repl/rolloutStore.js';

const fakeModel = { async complete() { return '模型生成的摘要'; } };

function mkTurn(id: string): any {
  return {
    id, timestamp: Date.now(), userInput: `任务 ${id}`,
    userInputType: 'task', tier: 'high', durationMs: 1,
    result: { success: true, summary: `score=8${id.length}` },
  };
}
async function waitReady(h: { isReady(): boolean }): Promise<void> {
  for (let i = 0; i < 100 && !h.isReady(); i++) await new Promise(r => setTimeout(r, 20));
}

const cleaners: Array<() => void> = [];
function tmpWs(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-v3-'));
  cleaners.push(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} });
  return ws;
}
function cleanupAll() { for (const c of cleaners) { try { c(); } catch {} } cleaners.length = 0; }

describe('接口契约 v3：compact 安全合并（F5 修复）', () => {
  afterEach(cleanupAll);

  it('快照→apply 之间新增轮次不丢失（旧 kept ∪ 新增轮全保留）', async () => {
    const session = new Session({ tier: 'high' });
    for (let i = 1; i <= 10; i++) session.addTurn(mkTurn(`t${String(i).padStart(2, '0')}`));

    const h = startBackgroundCompact(session, fakeModel)!;
    await waitReady(h);
    const res = h.result()!;
    assert.ok(res.ok);
    assert.deepEqual(
      res.coveredTurnIds,
      ['t01', 't02', 't03', 't04'],
      'coveredTurnIds 来自快照（10 轮保 6，移除前 4）'
    );
    assert.equal(res.summarySource, 'model');
    assert.ok(res.syntheticTurn, 'syntheticTurn 必须内嵌（标记自足化）');
    assert.deepEqual(res.generation, { turnCount: 10, lastTurnId: 't10' });

    // 快照与 apply 之间新增 4 轮（旧行为会静默丢弃 t05..t08）
    for (let i = 11; i <= 14; i++) session.addTurn(mkTurn(`t${i}`));

    const applied = applyCompactResult(session, res);
    assert.ok(applied.ok);
    const ids = session.turns.map(t => t.id);
    assert.ok(ids[0].startsWith('compact-'), 'synthetic turn 置顶');
    for (const id of ['t05', 't06', 't07', 't08']) {
      assert.ok(ids.includes(id), `旧 kept 轮 ${id} 不得丢失`);
    }
    for (const id of ['t11', 't12', 't13', 't14']) {
      assert.ok(ids.includes(id), `快照后新增轮 ${id} 不得丢失`);
    }
    for (const id of res.coveredTurnIds!) {
      assert.ok(!ids.includes(id), `被摘要覆盖的 ${id} 应被移除`);
    }
    assert.ok(applied.message.includes('安全合并'), '代际漂移必须显式提示');
  });

  it('无新增轮次时 apply 行为与旧版一致', async () => {
    const session = new Session({ tier: 'high' });
    for (let i = 1; i <= 10; i++) session.addTurn(mkTurn(`t${String(i).padStart(2, '0')}`));
    const h = startBackgroundCompact(session, fakeModel)!;
    await waitReady(h);
    const applied = applyCompactResult(session, h.result()!);
    assert.equal(session.turns.length, 7); // synthetic + 6 kept
    assert.ok(!applied.message.includes('安全合并'));
  });

  it('rewind 断血统（lastTurnId 消失）→ apply 被拒绝且会话不被触碰（N1）', async () => {
    const session = new Session({ tier: 'high' });
    for (let i = 1; i <= 10; i++) session.addTurn(mkTurn(`t${String(i).padStart(2, '0')}`));
    const h = startBackgroundCompact(session, fakeModel)!;
    await waitReady(h);
    const res = h.result()!;
    // 模拟 rewind：砍掉 t08/t09/t10（generation.lastTurnId='t10' 随之消失）
    session.turns = session.turns.filter(t => !['t08', 't09', 't10'].includes(t.id));
    const before = session.turns.map(t => t.id);
    const rejected = applyCompactResult(session, res);
    assert.equal(rejected.ok, false, '血统断开必须拒绝');
    assert.ok(rejected.message.includes('拒绝'));
    assert.deepEqual(session.turns.map(t => t.id), before, '拒绝时绝不能修改会话');
  });

  it('异常兜底结果携带覆盖账本，apply 走安全合并（N4）', async () => {
    const session = new Session({ tier: 'high' });
    for (let i = 1; i <= 10; i++) session.addTurn(mkTurn(`t${String(i).padStart(2, '0')}`));
    const res = buildFallbackCompactResult(session);
    assert.equal(res.summarySource, 'fallback');
    assert.ok(res.coveredTurnIds && res.coveredTurnIds.length === 4, '兜底结果必须带 coveredTurnIds');
    for (let i = 11; i <= 13; i++) session.addTurn(mkTurn(`t${i}`));
    const applied = applyCompactResult(session, res);
    const ids = session.turns.map(t => t.id);
    for (const id of ['t05', 't06', 't11', 't12', 't13']) {
      assert.ok(ids.includes(id), `安全合并必须保留 ${id}`);
    }
    assert.ok(!applied.message.includes('拒绝'));
  });

  it('确定性摘要兜底显式化（不再静默）', async () => {
    const session = new Session({ tier: 'high' });
    for (let i = 1; i <= 10; i++) session.addTurn(mkTurn(`t${String(i).padStart(2, '0')}`));
    const h = startBackgroundCompact(session, { async complete() { throw new Error('down'); } })!;
    await waitReady(h);
    const res = h.result()!;
    assert.equal(res.summarySource, 'fallback');
    assert.ok(res.message.includes('兜底'));
  });
});

describe('接口契约 v3：rollout compact 标记 × replay（F6 修复）', () => {
  afterEach(cleanupAll);

  it('replayInto 消费 compact 标记：covered 轮以 synthetic 替换，其余保留', () => {
    const session = new Session({ tier: 'high' });
    const synthetic = {
      id: 'compact-x', timestamp: Date.now(),
      userInput: '[COMPACT] 已压缩 6 轮历史', userInputType: 'command' as const,
      tier: 'high', result: { success: true, summary: '摘要正文' },
    };
    const events: any[] = [];
    for (let i = 1; i <= 8; i++) events.push({ type: 'turn', ts: Date.now(), turn: mkTurn(`t${String(i).padStart(2, '0')}`) });
    events.push({
      type: 'compact', ts: Date.now(), syntheticTurn: synthetic,
      coveredTurnIds: ['t01', 't02', 't03', 't04', 't05', 't06'],
      beforeTokens: 100, afterTokens: 50,
    });
    events.push({ type: 'turn', ts: Date.now(), turn: mkTurn('t09') });

    const applied = replayInto(session, events);
    assert.equal(applied, 9, 'turn 事件计数不含 compact 标记');
    const ids = session.turns.map(t => t.id);
    assert.deepEqual(ids, ['compact-x', 't07', 't08', 't09']);
    assert.equal(session.turns[0].result?.summary, '摘要正文', 'resume 无模型也能拿到摘要正文');
  });
});

describe('接口契约 v3：ContextSnapshot 事件', () => {
  afterEach(cleanupAll);

  it('appendContextSnapshot → readContextSnapshots round-trip', () => {
    tmpWs();
    const id = 'snap-test-session';
    cleaners.push(() => { try { fs.rmSync(path.join(os.homedir(), '.panshalach', 'rollouts', `${id}.jsonl`), { force: true }); } catch {} });
    appendContextSnapshot(id, { model: 'openpangu:openPangu-7B', injectedCardIds: ['c1'], promptHash: 'abc' });
    appendContextSnapshot(id, { model: 'openpangu:openPangu-7B', injectedCardIds: [], promptHash: 'def' });
    const snaps = readContextSnapshots(id);
    assert.equal(snaps.length, 2);
    assert.deepEqual(snaps[0].injectedCardIds, ['c1']);
  });
});

describe('接口契约 v3：PromptBuilder [M1] 编号契约', () => {
  afterEach(cleanupAll);

  it('记忆块渲染 [M1]/[M2] 且顺序与 lastInjectedCardIds 一致；无 score=score 双前缀', async () => {
    const ws = tmpWs();
    const now = Date.now();
    fs.writeFileSync(path.join(ws, '.panshalach-memory.json'), JSON.stringify({
      meta: { lastUpdated: now },
      cards: [
        { id: 'card-a', kind: 'failure', summary: 'redis 连接必须重试', weight: 1, count: 1, lastSeen: now, firstSeen: now, memoryCategory: 'implementation' },
        { id: 'card-b', kind: 'failure', summary: 'redis 键名要有命名空间', weight: 1, count: 1, lastSeen: now, firstSeen: now, memoryCategory: 'implementation' },
      ],
    }), 'utf-8');

    const session = new Session({ tier: 'high', workspace: ws } as any);
    session.addTurn({ id: 't1', timestamp: Date.now(), userInput: '旧任务', userInputType: 'task', tier: 'high', result: { success: true, summary: 'score=88' } } as any);
    const pb = new PromptBuilder(session, TierRegistry.get('high'));
    const prompt = await pb.buildForTask('redis 连接优化');

    assert.ok(prompt.includes('[M1]'), '必须渲染 [M1] 卡号');
    assert.ok(prompt.includes('[M2]'), '必须渲染 [M2] 卡号');
    const meta = pb.lastBuildMeta!;
    assert.equal(meta.injectedCardIds.length, 2, '编号数与注入卡数一致');
    // 编号顺序契约：prompt 中 [M1] 行引用的卡 == injectedCardIds[0]
    const m1Line = prompt.split('\n').find(l => l.includes('[M1]')) ?? '';
    const first = meta.injectedCardIds[0];
    const order = new Map([
      ['card-a', 'redis 连接必须重试'],
      ['card-b', 'redis 键名要有命名空间'],
    ]);
    const expectedSummary = order.get(first)!;
    assert.ok(m1Line.includes(expectedSummary), 'injectedCardIds[0] 必须对应 [M1] 行');
    assert.ok(!prompt.includes('score=score'), '禁止 score=score 双前缀');
  });
});
