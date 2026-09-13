// tests/repl/compactService.test.ts
// M2.3 DoD: 50+ turn session compacts — ctx estimate drops significantly and
// key info survives in the summary; auto-compact trigger threshold respected.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { compactSession, estimateSessionTokens, shouldAutoCompact } from '../../src/cli/repl/compactService.js';
import { measuredContextTokens } from '../../src/cli/repl/compactService.js';
import { Session } from '../../src/cli/repl/Session.js';
import type { Turn } from '../../src/cli/repl/types.js';

function mkTurn(i: number): Turn {
  return {
    id: 't' + i,
    timestamp: Date.now() + i,
    userInput: `任务 ${i}: 修复 alpha 模块的 bug-KEYWORD-${i} 并验证`,
    userInputType: 'task',
    tier: 'high',
    durationMs: 1000,
    result: { success: i % 5 !== 0, summary: `score=${90 - i}` },
  };
}

const fakeModelClient = {
  async complete(prompt: string) {
    // Deterministic "model" summary: keeps every KEYWORD visible so the
    // "key info preserved" assertion mirrors what a real summary should do.
    const keywords = (prompt.match(/KEYWORD-\d+/g) || []).join(', ');
    return `[摘要] 历史任务覆盖: ${keywords}`;
  },
};

describe('compactService', () => {
  let session: Session;

  beforeEach(() => {
    session = new Session({ tier: 'high', workspace: '/tmp/ws-compact' });
    for (let i = 1; i <= 56; i++) session.addTurn(mkTurn(i));
  });
  afterEach(() => {});

  it('56-turn session: compacts to 1 summary + 6 kept, estimate drops sharply', async () => {
    const before = estimateSessionTokens(session);
    const r = await compactSession(session, fakeModelClient);

    assert.ok(r.ok, r.message);
    assert.equal(r.removed, 50);
    assert.equal(r.kept, 6);
    assert.equal(session.turns.length, 7); // 1 synthetic + 6 kept
    assert.equal(session.turns[0].userInput, '[COMPACT] 已压缩 50 轮历史');

    // The 4000-char baseline is constant, so assert on the VARIABLE part:
    // compacted history must shed >50% of its non-baseline estimate.
    const baseline = 1000; // 4000 chars / 4
    const varBefore = r.beforeTokens - baseline;
    const varAfter = r.afterTokens - baseline;
    assert.ok(varAfter < varBefore * 0.5, `variable part must drop >50%: ${varBefore} → ${varAfter}`);
  });

  it('key info preserved: every compacted KEYWORD appears in the summary', async () => {
    const r = await compactSession(session, fakeModelClient);
    assert.ok(r.ok);
    for (let i = 1; i <= 50; i++) {
      assert.ok(r.summary.includes(`KEYWORD-${i}`), `KEYWORD-${i} must survive compaction`);
    }
  });

  it('model failure falls back to deterministic brief (no info loss)', async () => {
    const r = await compactSession(session, { async complete() { throw new Error('provider down'); } });
    assert.ok(r.ok);
    assert.ok(r.summary.includes('KEYWORD-1') && r.summary.includes('KEYWORD-50'));
  });

  it('refuses to compact when turns are below the threshold', async () => {
    const small = new Session();
    for (let i = 0; i < 5; i++) small.addTurn(mkTurn(i));
    const r = await compactSession(small, fakeModelClient);
    assert.equal(r.ok, false);
    assert.ok(r.message.includes('无需压缩'));
  });

  it('shouldAutoCompact: ≥85% ratio AND >12 turns', () => {
    assert.equal(shouldAutoCompact(session, 0.86), true);
    assert.equal(shouldAutoCompact(session, 0.5), false);
    const small = new Session();
    for (let i = 0; i < 5; i++) small.addTurn(mkTurn(i));
    assert.equal(shouldAutoCompact(small, 0.9), false);
  });
});

// ==================== A2 计量修复：实测锚点 + CJK-aware 估算 ====================
describe('A2 计量：measuredContextTokens + estimateSessionTokens', () => {
  it('取末尾最近一次实测 lastPromptTokens；无实测 → null', () => {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-a2' });
    s.addTurn({ ...mkTurn(1), result: { success: true, summary: 'x', budgetReport: { usageMeasured: true, lastPromptTokens: 12000 } as any } });
    s.addTurn({ ...mkTurn(2), result: { success: true, summary: 'x', budgetReport: { usageMeasured: false, estimatedUsedTokens: 999 } as any } });
    assert.equal(measuredContextTokens(s), 12000, 'usageMeasured=false 的估算值不可作锚点');
    s.addTurn({ ...mkTurn(3), result: { success: true, summary: 'x', budgetReport: { usageMeasured: true, lastPromptTokens: 15000 } as any } });
    assert.equal(measuredContextTokens(s), 15000, '取最近的实测锚点');
    const bare = new Session();
    bare.addTurn(mkTurn(1));
    assert.equal(measuredContextTokens(bare), null, '无实测 → 调用方回落估算');
  });

  it('estimateSessionTokens：CJK 按 1.5 token/字 + answerText 计入', () => {
    const s = new Session();
    s.addTurn({
      id: 'c1', timestamp: 1, userInput: '中'.repeat(100), userInputType: 'task', tier: 'high', durationMs: 1,
      result: { success: true, summary: '' },
    });
    const t1 = estimateSessionTokens(s);
    assert.ok(t1 >= 1000 + 150, `CJK 100 字必须 ≥150 tokens（旧 chars/4 只有 25）：got ${t1}`);
    s.addTurn({
      id: 'c2', timestamp: 2, userInput: 'answer turn', userInputType: 'task', tier: 'high', durationMs: 1,
      result: { success: true, summary: '', answerText: 'a'.repeat(400) },
    });
    assert.ok(estimateSessionTokens(s) - t1 >= 100, 'answerText（400 ascii ≈ 100 tokens）必须计入估算');
  });
});

// ==================== P3-3.7: background pre-compaction ====================
import { startBackgroundCompact, applyCompactResult } from '../../src/cli/repl/compactService.js';
import { registerStrategy, getStrategy, listStrategies, turnBrief, turnFullBrief, TURN_BRIEF_MAX_CHARS } from '../../src/cli/repl/compactStrategies.js';

// ==================== P1-T15: pluggable compaction strategies ====================
describe('compact strategies (P1-T15)', () => {
  it('built-ins registered: default + topic', () => {
    const ids = listStrategies();
    assert.ok(ids.includes('default'));
    assert.ok(ids.includes('topic'));
  });

  it('topic strategy produces sectioned output differing from default', () => {
    const turns = [
      { id: 't1', timestamp: 1, userInput: 'fix the login bug', userInputType: 'task' as const, tier: 'high' as const, durationMs: 1, result: { success: true, summary: 'score=90' } },
      { id: 't2', timestamp: 2, userInput: 'fix the login bug again', userInputType: 'task' as const, tier: 'high' as const, durationMs: 1, result: { success: true, summary: 'score=88' } },
      { id: 't3', timestamp: 3, userInput: 'add sql index', userInputType: 'task' as const, tier: 'high' as const, durationMs: 1, result: { success: true, summary: 'score=95' } },
    ] as any;
    const topic = getStrategy('topic').buildPrompt(turns);
    const def = getStrategy('default').buildPrompt(turns);
    assert.ok(topic.includes('## '), 'topic clusters into sections');
    assert.ok(topic.includes('fix') && topic.includes('sql'));
    assert.notEqual(topic, def);
  });

  it('custom strategy registers and resolves; unknown falls back to default', () => {
    registerStrategy({ id: 'custom', buildPrompt: () => 'CUSTOM-SUMMARY-PROMPT' });
    assert.equal(getStrategy('custom').buildPrompt([]), 'CUSTOM-SUMMARY-PROMPT');
    assert.equal(getStrategy('nope').id, 'default');
  });

  it('turnBrief keeps the existing brief format', () => {
    const t = { id: 'x', timestamp: 1, userInput: 'hello world task', userInputType: 'task', tier: 'high', durationMs: 1, result: { success: true, summary: 'score=88' } } as any;
    const b = turnBrief(t);
    assert.ok(b.includes('hello world task'));
    assert.ok(b.includes('score=88'));
  });

  it('B2 turnFullBrief：完整保留用户指令（≤2000），超长显式标记（不再 80 字符静默截断）', () => {
    const long = '修复登录模块的会话保持问题，要求：'.padEnd(300, '细') + 'END-MARKER';
    const t = { id: 'x', timestamp: 1, userInput: long, userInputType: 'task', tier: 'high', durationMs: 1, result: { success: true, summary: 'ok' } } as any;
    const full = turnFullBrief(t);
    assert.ok(full.includes('END-MARKER'), '300+ 字符指令必须完整进入摘要 prompt');
    assert.ok(!full.includes('…[超长已截断]'), '未超上限不截断');
    const giant = { ...t, userInput: 'A'.repeat(TURN_BRIEF_MAX_CHARS + 500) } as any;
    assert.ok(turnFullBrief(giant).includes('…[超长已截断]'), '超上限必须显式标记');
  });
});
describe('background compact (P3-3.7)', () => {
  let session: Session;
  beforeEach(() => {
    session = new Session({ tier: 'high', workspace: '/tmp/ws-bg' });
    for (let i = 1; i <= 24; i++) session.addTurn(mkTurn(i));
  });

  it('below-threshold session → null (no background work)', () => {
    const small = new Session();
    for (let i = 0; i < 5; i++) small.addTurn(mkTurn(i));
    const h = startBackgroundCompact(small, fakeModelClient);
    assert.equal(h, null);
  });

  it('re-entrancy: second start for the same session → null', () => {
    const h1 = startBackgroundCompact(session, fakeModelClient);
    assert.ok(h1, 'first start should succeed');
    const h2 = startBackgroundCompact(session, fakeModelClient);
    assert.equal(h2, null, 'second simultaneous start must be rejected');
    h1!.cancel();
  });

  it('background does NOT mutate session.turns; apply() at boundary is atomic', async () => {
    const beforeCount = session.turns.length;
    const h = startBackgroundCompact(session, fakeModelClient)!;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.isReady(), true, 'with a fast fake client, compaction latches within a tick');
    assert.equal(session.turns.length, beforeCount, 'background must not mutate session');
    const res = h.result();
    assert.ok(res && res.ok);
    const applied = applyCompactResult(session, res);
    assert.equal(session.turns.length, 7, '1 synthetic + 6 kept after apply');
    for (let i = 1; i <= 18; i++) assert.ok(applied.summary.includes(`KEYWORD-${i}`), `KEYWORD-${i} preserved`);
  });

  it('client failure → deterministic fallback summary, still ready', async () => {
    const h = startBackgroundCompact(session, { async complete() { throw new Error('down'); } })!;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.isReady(), true);
    const res = h.result();
    assert.ok(res && res.ok, 'fallback still produces a ready result');
    assert.ok(res.summary.includes('KEYWORD-1'), 'first removed turn survives in fallback');
    assert.ok(res.summary.includes('KEYWORD-18'), 'last removed turn (of 18) survives in fallback');
  });

  it('cancel() clears the re-entrancy guard', () => {
    const h1 = startBackgroundCompact(session, fakeModelClient);
    assert.ok(h1);
    h1!.cancel();
    const h2 = startBackgroundCompact(session, fakeModelClient);
    assert.ok(h2, 'after cancel, a new background run is allowed');
    h2!.cancel();
  });

  it('cancel prevents an in-flight result from latching as ready', async () => {
    const slow = { async complete() { await new Promise((r) => setTimeout(r, 200)); return '[摘要] KEYWORD-1'; } };
    const h = startBackgroundCompact(session, slow as any)!;
    h.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(h.isReady(), false, 'cancelled handle must not latch ready');
  });
});

// ==================== 0.7 F4：compact 补漏不喂 answered 轮 success 卡 ====================
// 背景见 backlog F4 / src/cli/repl/compactService.ts 补漏提炼段：
// 0.7 起补漏信号源从 result.success 收紧为 stopReason==='completed'——
// answered（纯问答自然停，success=true）轮被压缩移除时不得补提 success 卡。
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('compact 补漏提炼（0.7 stopReason 收紧）', () => {
  it('answered 轮不补产 success 卡；completed 轮产——同会话对照', async () => {
    const dir = join(tmpdir(), 'pangu-compact-mem-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    try {
      const sess = new Session({ tier: 'high', workspace: dir });
      const mkStopTurn = (id: string, input: string, stopReason: 'answered' | 'completed'): Turn => ({
        id,
        timestamp: Date.now(),
        userInput: input,
        userInputType: 'task',
        tier: 'high',
        result: { success: true, summary: stopReason === 'answered' ? '已回复' : '已通过验证', stopReason },
      });
      // 8 轮（> KEEP_RECENT+1=7）：前两轮被移除——一轮 answered、一轮 completed，
      // 其余 6 轮保留。success 都为 true，唯一区分信号是 stopReason。
      sess.addTurn(mkStopTurn('ans-1', 'ANSWERED-KEY 你好，回答我你是谁', 'answered'));
      sess.addTurn(mkStopTurn('done-1', 'COMPLETED-KEY 修复 alpha 模块并跑测试', 'completed'));
      for (let i = 3; i <= 8; i++) sess.addTurn(mkStopTurn('k' + i, `填充轮 ${i}`, 'completed'));

      const r = await compactSession(sess, fakeModelClient);
      assert.ok(r.ok, r.message);
      assert.equal(r.removed, 2, '前两轮（answered + completed）被移除');

      const store = new RefinedMemoryStore(dir);
      const successCards = store.list().filter((c) => c.kind === 'success');
      assert.equal(successCards.length, 1, '只有 completed 轮补提 success 卡');
      assert.ok(successCards[0].summary.includes('COMPLETED-KEY'), '补提卡来自 completed 轮');
      assert.ok(!successCards.some((c) => c.summary.includes('ANSWERED-KEY')), 'answered 轮绝不补提 success 卡');
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ==================== B1/B2/B4：路径统一 / 嵌套封顶 / kept 收缩 ====================
describe('B1 补漏提炼统一路径', () => {
  const tmpWs = () => join(tmpdir(), 'pangu-compact-b1-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const mkDone = (id: string, input: string): Turn => ({
    id, timestamp: Date.now(), userInput: input, userInputType: 'task', tier: 'high',
    result: { success: true, summary: '已通过验证', stopReason: 'completed' },
  });

  it('后台压缩 applyCompactResult 同样补提 success 卡（旧后台路径完全漏提炼）', async () => {
    const dir = tmpWs();
    mkdirSync(dir, { recursive: true });
    try {
      const sess = new Session({ tier: 'high', workspace: dir });
      sess.addTurn(mkDone('done-1', 'B1-BG-KEY 修复 beta 模块并跑测试'));
      for (let i = 2; i <= 20; i++) sess.addTurn(mkDone('k' + i, `填充轮 ${i}`));
      const h = startBackgroundCompact(sess, fakeModelClient)!;
      await new Promise((r) => setTimeout(r, 50));
      const applied = applyCompactResult(sess, h.result()!);
      assert.ok(applied.ok, applied.message);
      const store = new RefinedMemoryStore(dir);
      const cards = store.list().filter((c) => c.kind === 'success');
      assert.ok(cards.length >= 1, '后台路径必须补提');
      assert.ok(cards.some((c) => c.summary.includes('B1-BG-KEY')), '被移除的 completed 轮产卡');
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marker 写盘失败 → 不落任何 success 卡（修重试 count 虚增）', async () => {
    const dir = tmpWs();
    mkdirSync(dir, { recursive: true });
    const evilId = 'b1-evil-' + Date.now().toString(36);
    try {
      const sess = new Session({ tier: 'high', workspace: dir });
      sess.id = C2_EVIL_ID;
      for (let i = 1; i <= 20; i++) sess.addTurn(mkDone('k' + i, `B1-EVIL-KEY 填充轮 ${i}`));
      const r = await compactSession(sess, fakeModelClient);
      assert.equal(r.ok, false, 'marker 写盘失败必须拒绝');
      const store = new RefinedMemoryStore(dir);
      assert.equal(
        store.list().filter((c) => c.kind === 'success' && c.summary.includes('B1-EVIL-KEY')).length,
        0,
        '提炼必须在 marker 成功之后——失败路径绝不落卡',
      );
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      deleteRollout(C2_EVIL_ID);
      resetAuditStatus(C2_EVIL_ID);
    }
  });
});

describe('B2 嵌套压缩治理', () => {
  it('fallback 不再内联上一代摘要全文（>400 字符截断标记）', async () => {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-b2' });
    const id = 'b2-nest-' + Date.now().toString(36);
    s.id = id;
    try {
      for (let i = 1; i <= 20; i++) s.addTurn(mkTurn(i));
      const LONG = '[摘要] ' + 'Z'.repeat(600);
      const r1 = await compactSession(s, { async complete() { return LONG; } });
      assert.ok(r1.ok, r1.message);
      for (let i = 21; i <= 28; i++) s.addTurn(mkTurn(i));
      const r2 = await compactSession(s, { async complete() { throw new Error('down'); } });
      assert.ok(r2.ok, r2.message);
      assert.ok(r2.summary.includes('上一代摘要已截断'), '嵌套 [COMPACT] 轮的旧摘要必须截断，防代代膨胀');
    } finally {
      deleteRollout(id);
    }
  });
});

describe('B4 kept 字节感知收缩', () => {
  it('kept 巨轮超 60% 窗口 → 从最旧收缩到下限 2 轮，消息标注', async () => {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-b4' });
    const id = 'b4-shrink-' + Date.now().toString(36);
    s.id = id;
    try {
      for (let i = 1; i <= 18; i++) s.addTurn(mkTurn(i));
      // 最后 6 轮（kept 区）替换为 50K 巨轮（≈12.5K tokens/轮）
      for (let idx = s.turns.length - 6; idx < s.turns.length; idx++) {
        s.turns[idx] = { ...s.turns[idx], userInput: 'GIANT: ' + 'Y'.repeat(50000) };
      }
      const h = startBackgroundCompact(s, fakeModelClient)!;
      await new Promise((r) => setTimeout(r, 50));
      const applied = applyCompactResult(s, h.result()!, 2000); // cap = 1200 tokens
      assert.ok(applied.ok, applied.message);
      assert.equal(s.turns.length, 3, '1 synthetic + 2 kept（下限）');
      assert.ok(applied.message.includes('再收缩'), applied.message);
    } finally {
      deleteRollout(id);
    }
  });

  it('不传 windowTokens：保持按条数压缩的旧行为', async () => {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-b4b' });
    const id = 'b4-noWindow-' + Date.now().toString(36);
    s.id = id;
    try {
      for (let i = 1; i <= 18; i++) s.addTurn(mkTurn(i));
      for (let idx = s.turns.length - 6; idx < s.turns.length; idx++) {
        s.turns[idx] = { ...s.turns[idx], userInput: 'GIANT: ' + 'Y'.repeat(50000) };
      }
      const h = startBackgroundCompact(s, fakeModelClient)!;
      await new Promise((r) => setTimeout(r, 50));
      const applied = applyCompactResult(s, h.result()!);
      assert.ok(applied.ok);
      assert.equal(s.turns.length, 7, '1 synthetic + 6 kept（无窗口信息不收缩）');
    } finally {
      deleteRollout(id);
    }
  });
});

// ==================== C2: marker 先写盘成功再改内存（防双源分歧） ====================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteRollout, resetAuditStatus } from '../../src/cli/repl/rolloutStore.js';

const C2_EVIL_ID = 'c2-diverge/missing-subdir'; // 子目录不存在 → appendFileSync ENOENT → appendEvent false

describe('C2: durable-write-first compact (anti dual-source divergence)', () => {
  afterEach(() => {
    deleteRollout('c2-ok');
    deleteRollout(C2_EVIL_ID);
    resetAuditStatus(C2_EVIL_ID);
  });

  function mkSession(n: number, id?: string): Session {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-c2' });
    if (id) s.id = id;
    for (let i = 1; i <= n; i++) s.addTurn(mkTurn(i));
    return s;
  }

  it('happy path: compact marker reaches disk and memory compacts (control)', async () => {
    const s = mkSession(20, 'c2-ok');
    const r = await compactSession(s, fakeModelClient);
    assert.ok(r.ok, r.message);
    assert.equal(s.turns.length, 7, '1 synthetic + 6 kept');
    const file = path.join(os.homedir(), '.panshalach', 'rollouts', 'c2-ok.jsonl');
    const raw = fs.readFileSync(file, 'utf-8');
    assert.ok(raw.includes('"type":"compact"'), 'marker must be on disk after compactSession');
  });

  it('marker write failure → compactSession aborts WITHOUT mutating session.turns', async () => {
    const s = mkSession(20, C2_EVIL_ID);
    const beforeIds = s.turns.map((t) => t.id);
    const r = await compactSession(s, fakeModelClient);
    assert.equal(r.ok, false, 'must refuse to compact when the marker cannot be written');
    assert.ok(r.message.includes('写盘失败'), `message must name the write failure: ${r.message}`);
    assert.deepEqual(s.turns.map((t) => t.id), beforeIds, 'memory must stay untouched (no dual-source divergence)');
  });

  it('applyCompactResult refuses to apply when marker write fails (session untouched)', async () => {
    const s = mkSession(24, C2_EVIL_ID);
    const beforeCount = s.turns.length;
    const h = startBackgroundCompact(s, fakeModelClient)!;
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(h.isReady());
    const applied = applyCompactResult(s, h.result()!);
    assert.equal(applied.ok, false);
    assert.ok(applied.message.includes('写盘失败'));
    assert.equal(s.turns.length, beforeCount, 'session must NOT be compacted when marker write fails');
  });
});

// ==================== C5: append 审计状态（"零事件" vs "写失败"区分） ====================
import { appendEvent, auditStatusOf, appendMeta, appendTurn, resumeSession } from '../../src/cli/repl/rolloutStore.js';

describe('C5: rollout append audit status', () => {
  afterEach(() => {
    deleteRollout('c5-good');
    deleteRollout(C2_EVIL_ID);
    resetAuditStatus(C2_EVIL_ID);
    resetAuditStatus('c5-good');
  });

  it('unwritable session: appendEvent returns false and auditStatus becomes write-failed:N (cumulative)', () => {
    resetAuditStatus(C2_EVIL_ID);
    assert.equal(auditStatusOf(C2_EVIL_ID), 'ok', 'fresh session starts ok');
    assert.equal(appendEvent(C2_EVIL_ID, { type: 'rewind', ts: 1, target: 'x' }), false, 'failure must be reported');
    assert.equal(auditStatusOf(C2_EVIL_ID), 'write-failed:1');
    assert.equal(appendEvent(C2_EVIL_ID, { type: 'rewind', ts: 2, target: 'y' }), false);
    assert.equal(auditStatusOf(C2_EVIL_ID), 'write-failed:2', 'failure count is cumulative');
  });

  it('failures are session-scoped: a healthy session stays ok', () => {
    resetAuditStatus(C2_EVIL_ID);
    appendEvent(C2_EVIL_ID, { type: 'rewind', ts: 1, target: 'x' });
    assert.equal(appendEvent('c5-good', { type: 'rewind', ts: 1, target: 'x' }), true);
    assert.equal(auditStatusOf('c5-good'), 'ok');
    assert.notEqual(auditStatusOf(C2_EVIL_ID), 'ok');
  });

  it('backward compat: old events without auditStatus replay unchanged', () => {
    const s = new Session({ workspace: '/tmp/ws-c5' });
    s.id = 'c5-good';
    const legacyTurn: Turn = {
      id: 'legacy-1',
      timestamp: Date.now(),
      userInput: 'legacy turn (no auditStatus field)',
      userInputType: 'task',
      tier: 'high',
      result: { success: true, summary: 'ok' },
    };
    appendMeta(s);
    appendTurn(s.id, legacyTurn);
    const s2 = new Session();
    s2.id = s.id;
    assert.equal(resumeSession(s2, s.id), 1, '老格式（无 auditStatus 字段）照常 replay');
    assert.equal(s2.turns[0].userInput, 'legacy turn (no auditStatus field)');
  });
});
