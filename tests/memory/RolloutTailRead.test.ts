// tests/memory/RolloutTailRead.test.ts
// 包C 缺陷9 对抗性回归：readAgentEvents 旧实现从头顺序读满
// MAX_DERIVED_EVENTS=5000 即 break——超 5000 条后最新事件永不可见（头重脚轻）。
// 修复：从文件尾部反向扫描凑满 5000 条再正序化 → 最新事件必须可见。
//
// 写法沿用 tests/memory/EventStore.test.ts：随机 sessionId 落真实 rollouts 目录，
// afterEach deleteRollout 清理。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readAgentEvents, deleteRollout } from '../../src/cli/repl/rolloutStore.js';

const sid = 'tailread-' + crypto.randomBytes(6).toString('hex');

function rolloutPath(id: string): string {
  return path.join(os.homedir(), '.panshalach', 'rollouts', `${id}.jsonl`);
}

function writeAgentLine(id: string, i: number): string {
  return JSON.stringify({
    type: 'agent',
    ts: 1_000_000 + i,
    event: { id: `evt-${i}`, kind: 'progress', topic: 'tail', summary: `事件 ${i}`, ts: 1_000_000 + i, sessionId: id },
  });
}

describe('包C 缺陷9：readAgentEvents 尾部反向读（最新事件可见）', () => {
  afterEach(() => { deleteRollout(sid); });

  it('写 5010 条事件 → 返回最新 5000 条，最后一条可见（旧实现头重脚轻只见到第 5000 条）', () => {
    const fp = rolloutPath(sid);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 5010; i++) lines.push(writeAgentLine(sid, i));
    // 中间夹一条撕裂行（容错：跳过损坏行）+ 头部一条 meta（非 agent 事件不计）
    lines.splice(3000, 0, '{"type":"agent","ts":1,"event":{"id":"torn"'); // 撕裂行
    lines.unshift(JSON.stringify({ type: 'meta', ts: 1, id: sid, tier: 'high', workspace: '', model: '' }));
    fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');

    const events = readAgentEvents(sid);
    assert.equal(events.length, 5000, `有界 5000 条：got ${events.length}`);
    assert.equal(events[events.length - 1].id, 'evt-5009', '最新事件（第 5010 条）必须可见');
    assert.equal(events[0].id, 'evt-10', '窗口取的是最新 5000 条（最旧的 10 条出局）');
    // 正序化：保持文件（时间）升序
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i - 1].ts <= events[i].ts, '升序返回');
    }
  });

  it('≤5000 条时行为不变（全量返回，对照组）', () => {
    const fp = rolloutPath(sid);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 42; i++) lines.push(writeAgentLine(sid, i));
    fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
    const events = readAgentEvents(sid);
    assert.equal(events.length, 42);
    assert.equal(events[0].id, 'evt-0');
    assert.equal(events[41].id, 'evt-41');
  });

  it('文件不存在 → 空数组（不抛）', () => {
    assert.deepEqual(readAgentEvents('tailread-no-such-session-xyz'), []);
  });
});
