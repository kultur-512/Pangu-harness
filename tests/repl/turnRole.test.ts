// tests/repl/turnRole.test.ts
// M2-7: Turn.role 加性字段 + 会话角色标注迁移（定向单测）。
// 覆盖：迁移推断规则（task/multiline→user，command/压缩合成→assistant）、
// 新 turn 带 role 落盘+回放、旧 JSONL 无 role 兼容、
// 压缩合成轮 'assistant' 标注、摘要 prompt 用户指令原文逐字保留约束。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session, inferTurnRole } from '../../src/cli/repl/Session.js';
import {
  appendMeta, appendTurn, appendCompactMarker, resumeSession, replayInto, deleteRollout,
} from '../../src/cli/repl/rolloutStore.js';
import { compactSession } from '../../src/cli/repl/compactService.js';
import { getStrategy, VERBATIM_RULE } from '../../src/cli/repl/compactStrategies.js';
import type { Turn } from '../../src/cli/repl/types.js';

const usedIds: string[] = [];

function mkTurn(i: number, type: Turn['userInputType'] = 'task'): Turn {
  return {
    id: 't' + i,
    timestamp: Date.now() + i,
    userInput: `任务 ${i}`,
    userInputType: type,
    tier: 'high',
    result: { success: true, summary: `score=${90 - i}` },
  };
}

function rolloutFile(id: string): string {
  return path.join(os.homedir(), '.panshalach', 'rollouts', `${id}.jsonl`);
}

function readLastEvent(id: string): any {
  const lines = fs.readFileSync(rolloutFile(id), 'utf-8').split('\n').filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

describe('M2-7 Turn.role 迁移标注', () => {
  afterEach(() => { for (const id of usedIds.splice(0)) deleteRollout(id); });

  it('inferTurnRole：task/multiline → user，command → assistant', () => {
    assert.equal(inferTurnRole(mkTurn(1, 'task')), 'user');
    assert.equal(inferTurnRole(mkTurn(1, 'multiline')), 'user');
    assert.equal(inferTurnRole(mkTurn(1, 'command')), 'assistant');
  });

  it('addTurn 标注：无 role 时按 userInputType 推断，且原对象就地携带（appendTurn 同对象序列化路径）', () => {
    const s = new Session();
    const t = mkTurn(1);
    assert.equal(t.role, undefined, '前置：构造时不带 role');
    s.addTurn(t);
    assert.equal(t.role, 'user', '原对象就地标注');
    assert.equal(s.turns[0].role, 'user');
    const c = mkTurn(2, 'command');
    s.addTurn(c);
    assert.equal(c.role, 'assistant');
  });

  it('addTurn 显式 role 优先，不被推断覆盖', () => {
    const s = new Session();
    const t: Turn = { ...mkTurn(1), role: 'assistant' };
    s.addTurn(t);
    assert.equal(t.role, 'assistant');
  });

  it('Session 构造（init.turns 组装点）：旧 turns 无 role → 迁移推断', () => {
    const old = mkTurn(1);
    assert.equal(old.role, undefined);
    const s = new Session({ turns: [old] });
    assert.equal(s.turns[0].role, 'user');
  });

  it('新 turn 带 role 落盘：jsonl 事件序列化 role，resume 回放保留', () => {
    const s1 = new Session({ workspace: '/tmp/ws-role-1' });
    usedIds.push(s1.id);
    appendMeta(s1);
    const t: Turn = { ...mkTurn(1), role: 'user' };
    appendTurn(s1.id, t);
    const last = readLastEvent(s1.id);
    assert.equal(last.type, 'turn');
    assert.equal(last.turn.role, 'user', '序列化携带 role');
    const s2 = new Session();
    s2.id = s1.id;
    assert.equal(resumeSession(s2, s1.id), 1);
    assert.equal(s2.turns[0].role, 'user', '回放保留 role');
  });

  it('无 role 的 turn 经 appendTurn 序列化时补标注（rollout 权威源）', () => {
    const s1 = new Session({ workspace: '/tmp/ws-role-2' });
    usedIds.push(s1.id);
    appendTurn(s1.id, mkTurn(1));
    assert.equal(readLastEvent(s1.id).turn.role, 'user');
  });

  it('旧 JSONL 无 role 字段：照常读 + 回放时迁移推断，无异常', () => {
    const id = 'legacy-role-' + Date.now().toString(36);
    usedIds.push(id);
    const file = rolloutFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'meta', ts: 1, id, tier: 'high', workspace: '/tmp/ws-legacy', model: 'm' }),
      JSON.stringify({ type: 'turn', ts: 2, turn: mkTurn(1) }), // 无 role 的旧格式
    ].join('\n') + '\n', 'utf-8');
    assert.ok(!fs.readFileSync(file, 'utf-8').includes('"role"'), '旧格式原始行确实无 role');

    const s2 = new Session();
    s2.id = id;
    assert.equal(resumeSession(s2, id), 1, '旧格式照常回放');
    assert.equal(s2.turns[0].userInput, '任务 1');
    assert.equal(s2.turns[0].role, 'user', '回放时按现状迁移推断');
  });

  it('旧 compact 标记无 role：照常读 + 回放补 assistant；covered 替换语义不变', () => {
    const id = 'legacy-compact-role-' + Date.now().toString(36);
    usedIds.push(id);
    const file = rolloutFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacySynthetic = {
      id: 'compact-x', timestamp: Date.now(),
      userInput: '[COMPACT] 已压缩 2 轮历史', userInputType: 'command',
      tier: 'high', result: { success: true, summary: '旧摘要正文' },
    };
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'meta', ts: 1, id, tier: 'high', workspace: '/tmp/ws-lc', model: 'm' }),
      JSON.stringify({ type: 'turn', ts: 2, turn: mkTurn(1) }),
      JSON.stringify({ type: 'turn', ts: 3, turn: mkTurn(2) }),
      JSON.stringify({ type: 'compact', ts: 4, syntheticTurn: legacySynthetic, coveredTurnIds: ['t1', 't2'], beforeTokens: 100, afterTokens: 50 }),
    ].join('\n') + '\n', 'utf-8');

    const s2 = new Session();
    s2.id = id;
    assert.equal(resumeSession(s2, id), 2);
    assert.equal(s2.turns.length, 1, 'covered 轮被 synthetic 替换');
    assert.equal(s2.turns[0].role, 'assistant', '旧标记回放时迁移为 assistant');
    assert.equal(s2.turns[0].result?.summary, '旧摘要正文');
  });

  it('appendCompactMarker 标注合成轮 assistant（对象与序列化同步），replayInto 保留', () => {
    const id = 'compact-role-' + Date.now().toString(36);
    usedIds.push(id);
    const synthetic: Turn = {
      id: 'compact-y', timestamp: Date.now(),
      userInput: '[COMPACT] 已压缩 3 轮历史', userInputType: 'command',
      tier: 'high', result: { success: true, summary: '摘要' },
    };
    assert.equal(appendCompactMarker(id, synthetic, ['a', 'b', 'c'], 100, 50), true);
    assert.equal(synthetic.role, 'assistant', '对象就地标注');
    assert.equal(readLastEvent(id).syntheticTurn.role, 'assistant', '序列化携带');

    const s = new Session();
    s.id = id;
    replayInto(s, [readLastEvent(id)]);
    assert.equal(s.turns[0].role, 'assistant');
  });

  it('compactSession 端到端：合成轮 assistant，保留轮维持 user', async () => {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-role-compact' });
    usedIds.push(s.id);
    for (let i = 1; i <= 8; i++) s.addTurn(mkTurn(i));
    const r = await compactSession(s, { async complete(_p: string) { return '[摘要] ok'; } });
    assert.ok(r.ok, r.message);
    assert.equal(s.turns[0].userInput, '[COMPACT] 已压缩 2 轮历史');
    assert.equal(s.turns[0].role, 'assistant', '压缩合成轮为 assistant 侧');
    assert.equal(s.turns[1].role, 'user', '保留轮维持 user');
  });
});

describe('M2-7 摘要 prompt 逐字保留约束', () => {
  it('default 与 topic 策略的摘要 prompt 均含用户指令原文逐字保留约束', () => {
    const turns = [mkTurn(1), mkTurn(2, 'multiline')];
    const def = getStrategy('default').buildPrompt(turns);
    const topic = getStrategy('topic').buildPrompt(turns);
    assert.ok(def.includes(VERBATIM_RULE), 'default 策略含约束');
    assert.ok(topic.includes(VERBATIM_RULE), 'topic 策略含约束');
    assert.ok(VERBATIM_RULE.includes('逐字保留'), '约束关键词：逐字保留');
  });
});
