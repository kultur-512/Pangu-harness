// tests/repl/rolloutB7.test.ts
// ROADMAP-NEXT §B7 三项工程遗留的回归（事件层底座 rolloutStore.ts）：
//   a) rewind 事件 replay 消费——回退边界生效（回退后 resume 不得比真实历史长）
//   b) compact 标记幂等——同一 synthetic/覆盖账本重复回放不产生重复轮
//   c) 分支索引——listBranches/listSessionTree 单次扫描（结果语义与旧实现一致）
//
// 写法沿用仓库惯例（tests/repl/rolloutBranch.test.ts）：随机 sessionId + afterEach 删除文件。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  appendMeta, appendTurn, appendEvent, appendCompactMarker, appendRewindAudit,
  replayInto, resumeSession, forkRollout, isBranch, listBranches, directBranches,
  listSessionTree, deleteRollout,
} from '../../src/cli/repl/rolloutStore.js';
import { Session } from '../../src/cli/repl/Session.js';
import type { Turn } from '../../src/cli/repl/types.js';

const ids: string[] = [];
function track(id: string) { ids.push(id); return id; }
function mkSession(id: string): Session {
  const s = new Session({ workspace: '/tmp/b7' });
  s.id = id;
  return s;
}
function mkTurn(i: number, task: string, ts?: number): Turn {
  return {
    id: 't' + i, timestamp: ts ?? Date.now() + i, userInput: task, userInputType: 'task',
    tier: 'high', durationMs: 10, result: { success: true, summary: '已通过验证' },
  };
}
function fileFor(id: string): string {
  return join(homedir(), '.panshalach', 'rollouts', `${id}.jsonl`);
}

describe('B7-a：rewind 事件 replay 消费（回退边界）', () => {
  afterEach(() => { for (const id of ids.splice(0)) deleteRollout(id); });

  it('rewind 到 number(timestamp)：回退点之后的轮次在 resume 中消失', () => {
    const id = track(new Session({ workspace: '/tmp/b7' }).id);
    appendMeta(mkSession(id));
    const t1 = mkTurn(1, 'first', 1000);
    const t2 = mkTurn(2, 'second', 2000);
    const t3 = mkTurn(3, 'third', 3000);
    appendTurn(id, t1);
    appendTurn(id, t2);
    appendTurn(id, t3);
    // 回退到 t2（ts=2000）→ t3 应消失
    appendRewindAudit(id, 2000);

    const s = mkSession(id);
    resumeSession(s, id);
    assert.deepEqual(s.turns.map((t) => t.id), ['t1', 't2'], '回退点之后的轮次不得复活');
  });

  it('rewind 到 string(回合 id)：截断到该轮为止；再写新轮保留', () => {
    const id = track(new Session({ workspace: '/tmp/b7' }).id);
    appendMeta(mkSession(id));
    appendTurn(id, mkTurn(1, 'a'));
    appendTurn(id, mkTurn(2, 'b'));
    appendTurn(id, mkTurn(3, 'c'));
    appendRewindAudit(id, 't1'); // 回退到第 1 轮
    appendTurn(id, mkTurn(4, 'd-after-rewind')); // 回退后新写的一轮

    const s = mkSession(id);
    resumeSession(s, id);
    assert.deepEqual(s.turns.map((t) => t.id), ['t1', 't4'], '回退后新轮保留，中间轮丢弃');
  });

  it('rewind 找不到目标（事件指向不存在的轮）不破坏会话', () => {
    const id = track(new Session({ workspace: '/tmp/b7' }).id);
    appendMeta(mkSession(id));
    appendTurn(id, mkTurn(1, 'a'));
    appendTurn(id, mkTurn(2, 'b'));
    appendRewindAudit(id, 'no-such-turn');

    const s = mkSession(id);
    resumeSession(s, id);
    assert.deepEqual(s.turns.map((t) => t.id), ['t1', 't2'], '无匹配目标时回放保持原样');
  });

  it('回退后压缩：rewind + compact 顺序消费，历史与在线状态一致', () => {
    const id = track(new Session({ workspace: '/tmp/b7' }).id);
    appendMeta(mkSession(id));
    for (let i = 1; i <= 4; i++) appendTurn(id, mkTurn(i, 'turn' + i));
    appendRewindAudit(id, 't2'); // 砍掉 t3/t4
    // 压缩覆盖 t1/t2 → 合成为 t-syn
    const syn: Turn = {
      id: 't-syn', timestamp: Date.now() + 100, userInput: '[压缩摘要]', userInputType: 'command',
      tier: 'high', role: 'assistant',
    };
    appendCompactMarker(id, syn, ['t1', 't2']);

    const s = mkSession(id);
    resumeSession(s, id);
    assert.deepEqual(s.turns.map((t) => t.id), ['t-syn'], '回退后的历史被压缩覆盖，仅剩合成轮');
  });
});

describe('B7-b：compact 标记幂等（重复回放不产生重复轮）', () => {
  afterEach(() => { for (const id of ids.splice(0)) deleteRollout(id); });

  it('同一 compact 事件回放两次 → synthetic 轮只出现一次', () => {
    const session = mkSession('s-idem');
    const syn: Turn = {
      id: 't-syn', timestamp: Date.now(), userInput: '[摘要]', userInputType: 'command',
      tier: 'high', role: 'assistant',
    };
    session.addTurn(mkTurn(1, 'a'));
    session.addTurn(mkTurn(2, 'b'));
    const ev = { type: 'compact' as const, ts: Date.now(), syntheticTurn: syn, coveredTurnIds: ['t1', 't2'] };

    replayInto(session, [ev]);
    const afterFirst = session.turns.map((t) => t.id);
    replayInto(session, [ev]); // 重入（resume 重放 / 在线 apply 后再 replay）
    assert.deepEqual(session.turns.map((t) => t.id), afterFirst, '重放不得改变结果');
    assert.equal(session.turns.filter((t) => t.id === 't-syn').length, 1, '合成轮只出现一次');
  });

  it('两枚 compact 标记覆盖重叠区间 → 合成轮仍各一份且不重复覆盖', () => {
    const session = mkSession('s-idem2');
    session.addTurn(mkTurn(1, 'a'));
    session.addTurn(mkTurn(2, 'b'));
    session.addTurn(mkTurn(3, 'c'));
    const syn1: Turn = { id: 'syn1', timestamp: 1, userInput: '[s1]', userInputType: 'command', tier: 'high', role: 'assistant' };
    const syn2: Turn = { id: 'syn2', timestamp: 2, userInput: '[s2]', userInputType: 'command', tier: 'high', role: 'assistant' };
    replayInto(session, [
      { type: 'compact', ts: 1, syntheticTurn: syn1, coveredTurnIds: ['t1', 't2'] },
      { type: 'compact', ts: 2, syntheticTurn: syn2, coveredTurnIds: ['t2', 't3'] },
    ]);
    const ids2 = session.turns.map((t) => t.id);
    assert.deepEqual(ids2, ['syn2', 'syn1'], '后到的压缩标记在前，历史按覆盖账本移除');
    // 再整体重放一次仍等值
    const snap = [...ids2];
    replayInto(session, [
      { type: 'compact', ts: 1, syntheticTurn: syn1, coveredTurnIds: ['t1', 't2'] },
      { type: 'compact', ts: 2, syntheticTurn: syn2, coveredTurnIds: ['t2', 't3'] },
    ]);
    assert.deepEqual(session.turns.map((t) => t.id), snap, '整批重放幂等');
  });

  it('compact 标记经真实 jsonl 往返：重复 resume 结果稳定', () => {
    const id = track(new Session({ workspace: '/tmp/b7' }).id);
    appendMeta(mkSession(id));
    appendTurn(id, mkTurn(1, 'a'));
    appendTurn(id, mkTurn(2, 'b'));
    const syn: Turn = { id: 't-syn', timestamp: Date.now(), userInput: '[摘要]', userInputType: 'command', tier: 'high', role: 'assistant' };
    appendCompactMarker(id, syn, ['t1', 't2']);

    const s1 = mkSession(id); resumeSession(s1, id);
    const s2 = mkSession(id); resumeSession(s2, id);
    assert.deepEqual(s1.turns.map((t) => t.id), s2.turns.map((t) => t.id), '两次 resume 结果一致');
    assert.equal(s1.turns.length, 1);
  });
});

describe('B7-c：分支索引用例（单次扫描语义等价）', () => {
  afterEach(() => { for (const id of ids.splice(0)) deleteRollout(id); });

  it('listBranches / directBranches / listSessionTree 与分支链语义一致', () => {
    const origin = track(new Session().id);
    appendMeta(mkSession(origin));
    const b1 = track(`${origin}--branch-l1`);
    const b2 = track(`${origin}--branch-l2`);
    const sub = track(`${b1}--branch-l3`);
    forkRollout(origin, b1);
    forkRollout(origin, b2);
    forkRollout(b1, sub); // branch-of-branch

    assert.deepEqual(listBranches(origin).sort(), [b1, b2, sub].sort(), 'top-most origin 聚合全部后代');
    assert.deepEqual(directBranches(origin).sort(), [b1, b2].sort(), '直接子节点');
    assert.deepEqual(directBranches(b1), [sub], '子分支的直接子节点');

    const tree = listSessionTree(origin);
    assert.equal(tree.id, origin);
    assert.deepEqual(tree.children.map((c) => c.id).sort(), [b1, b2].sort());
    const n1 = tree.children.find((c) => c.id === b1)!;
    assert.deepEqual(n1.children.map((c) => c.id), [sub]);
    // 非分支文件
    assert.equal(isBranch(origin), null);
    assert.equal(isBranch(b1), origin);
    assert.equal(isBranch(sub), origin, '深链解析到 TOP-MOST');
  });

  it('损坏行 / 无 meta 文件不进入分支索引，且不抛错', () => {
    const origin = track(new Session().id);
    appendMeta(mkSession(origin));
    const broken = track(`${origin}--branch-broken`);
    fs.writeFileSync(fileFor(broken), '{"type":"meta","ts":1,"id":"x","tier":', 'utf-8'); // torn
    // 不应抛
    assert.deepEqual(listBranches(origin), [], '损坏文件不产生分支条目');
    assert.equal(isBranch(broken), null);
  });
});
