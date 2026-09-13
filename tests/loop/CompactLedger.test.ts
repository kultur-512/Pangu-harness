// tests/loop/CompactLedger.test.ts
// 包B 对抗性回归（压缩账本 / 嵌套封顶 / cancel 竞态）：
//
// 【P2】B4 kept 收缩不落账本：applyCompactResult 的 kept 收缩（remaining.shift()）
// 丢最旧 kept 轮，但 marker 只写快照 coveredTurnIds → resume 重放
// （rolloutStore.replayInto 按 coveredIds 保留其余）会复活被收缩轮次。
// 修复：被 shift 掉的 kept 轮 id 一并写入 coveredTurnIds。
//
// 【P2】嵌套摘要封顶只落 fallback：compactStrategies.turnFullBrief 的
// result.summary 无 cap（NESTED_SUMMARY_MAX_CHARS=400 只用于 fallbackSummary）→
// [COMPACT] 合成轮再压缩时上一代摘要全文内联进摘要 prompt，代代膨胀。
// 修复：turnFullBrief 对 summary 同样 400 字符封顶（加省略标记）。
//
// 【P2】compact cancel 竞态：startBackgroundCompact 只在 await 前判一次
// cancelled，cancel 后 compute 落定仍 ready=true → 边界处 apply 已取消的结果。
// 修复：落定后再查一次 cancelled，已取消则丢弃结果不置 ready。
// （旧测试是 40ms 空过时序；此处为手动控制 promise resolve 的确定时序。）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCompactResult, estimateSessionTokens, startBackgroundCompact } from '../../src/cli/repl/compactService.js';
import { turnFullBrief, NESTED_SUMMARY_MAX_CHARS } from '../../src/cli/repl/compactStrategies.js';
import { Session } from '../../src/cli/repl/Session.js';
import { appendTurn, resumeSession, deleteRollout } from '../../src/cli/repl/rolloutStore.js';
import type { Turn } from '../../src/cli/repl/types.js';

function mkTurn(i: number, override?: Partial<Turn>): Turn {
  return {
    id: 't' + i,
    timestamp: Date.now() + i,
    userInput: `任务 ${i}: 修复 alpha 模块 KEYWORD-${i}`,
    userInputType: 'task',
    tier: 'high',
    result: { success: true, summary: 's' + i },
    ...override,
  } as Turn;
}

// ==================== 【P2】issue 6：B4 kept 收缩落账本 ====================
describe('B4 kept 收缩落账本（coveredTurnIds 含被 shift 的 kept 轮）', () => {
  it('kept 收缩丢弃的轮 id 必须进入账本：返回值、磁盘 marker、resume 重放三处一致', () => {
    const id = 'b4-ledger-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    try {
      const s = new Session({ tier: 'high', workspace: '/tmp/ws-b4ledger' });
      s.id = id;
      // 18 轮：t1..t12 被 covered；t13..t18 是 kept 区巨轮（触发 B4 收缩）
      const turns: Turn[] = [];
      for (let i = 1; i <= 18; i++) {
        const giant = i >= 13 ? 'GIANT: ' + 'Y'.repeat(50000) : `任务 ${i}`;
        const t = mkTurn(i, { userInput: giant });
        turns.push(t);
        s.addTurn(t);
        appendTurn(id, t); // 真实宿主由 TurnController 落盘；测试显式补齐 turn 事件
      }

      const res = {
        ok: true, removed: 12, kept: 6,
        summary: '[摘要] t1..t12',
        beforeTokens: estimateSessionTokens(s),
        afterTokens: 0,
        generation: { turnCount: 18, lastTurnId: 't18' },
        coveredTurnIds: turns.slice(0, 12).map((t) => t.id),
        summarySource: 'model' as const,
        syntheticTurn: {
          id: 'compact-' + id, timestamp: Date.now(),
          userInput: '[COMPACT] 已压缩 12 轮历史', userInputType: 'command' as const,
          tier: 'high', result: { success: true, summary: '[摘要] t1..t12' },
        },
        message: 'test',
      } as any;

      // cap = 2000*0.6 = 1200 tokens → 巨 kept 轮（≈12.5K tokens/轮）触发收缩到下限 2
      const applied = applyCompactResult(s, res, 2000);
      assert.ok(applied.ok, applied.message);
      assert.equal(s.turns.length, 3, '1 synthetic + 2 kept（下限）');
      assert.ok(applied.message.includes('再收缩'), applied.message);

      // 返回值账本：被 shift 的 t13..t16 必须进入 coveredTurnIds
      const ids = applied.coveredTurnIds ?? [];
      for (const dropped of ['t13', 't14', 't15', 't16']) {
        assert.ok(ids.includes(dropped), `被收缩轮 ${dropped} 必须写入账本（旧实现只在 marker 前定格快照）`);
      }
      assert.ok(!ids.includes('t17') && !ids.includes('t18'), '下限保留轮不进账本');

      // resume 重放：被收缩轮不得复活（旧实现按快照账本保留 → t13..t16 复活）
      const s2 = new Session({ tier: 'high', workspace: '/tmp/ws-b4ledger' });
      s2.id = id;
      assert.ok(resumeSession(s2, id) > 0, 'turn 事件已落盘');
      const replayIds = s2.turns.map((t) => t.id);
      for (const dropped of ['t13', 't14', 't15', 't16']) {
        assert.ok(!replayIds.includes(dropped), `resume 重放复活了被收缩轮 ${dropped}：${replayIds.join(',')}`);
      }
      assert.ok(replayIds.includes('t17') && replayIds.includes('t18'), '下限保留轮必须幸存');
      assert.equal(s2.turns[0].userInput, '[COMPACT] 已压缩 12 轮历史', 'synthetic 轮在首位');
    } finally {
      deleteRollout(id);
    }
  });
});

// ==================== 【P2】issue 7：turnFullBrief 嵌套摘要封顶 ====================
describe('嵌套摘要封顶（turnFullBrief 对 summary 同样 400 字符封顶）', () => {
  it('上一代摘要超 400 字符 → brief 内截断并带省略标记（不再全文内联）', () => {
    const longSummary = '[摘要] ' + 'Z'.repeat(600);
    const t = {
      id: 'x', timestamp: 1, userInput: '[COMPACT] 已压缩 9 轮历史',
      userInputType: 'command', tier: 'high', durationMs: 1,
      result: { success: true, summary: longSummary },
    } as any;
    const brief = turnFullBrief(t);
    assert.ok(brief.length < 600, `brief 必须有界：${brief.length}`);
    assert.ok(brief.includes('已截断'), '带省略标记');
    assert.ok(!brief.includes('Z'.repeat(NESTED_SUMMARY_MAX_CHARS + 1)), '超限部分不得内联');
    assert.ok(brief.includes('Z'.repeat(50)), '截断前缀保留（可读性）');
  });

  it('短摘要原样保留（回归）', () => {
    const t = {
      id: 'x', timestamp: 1, userInput: '任务X',
      userInputType: 'task', tier: 'high', durationMs: 1,
      result: { success: true, summary: 'score=90' },
    } as any;
    const brief = turnFullBrief(t);
    assert.ok(brief.endsWith('→ score=90'), brief);
    assert.ok(!brief.includes('已截断'));
  });
});

// ==================== 【P2】issue 8：compact cancel 竞态（确定时序） ====================
describe('compact cancel 竞态（手动控制 promise resolve 的确定时序）', () => {
  it('compute 落定晚于 cancel → 结果被丢弃，ready 恒 false', async () => {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-cancel' });
    for (let i = 1; i <= 20; i++) s.addTurn(mkTurn(i));

    let resolveCompute!: (v: string) => void;
    const gated = {
      async complete() {
        return new Promise<string>((res) => { resolveCompute = res; });
      },
    };
    const h = startBackgroundCompact(s, gated as any)!;
    assert.ok(h, '启动成功');
    // cancel（此刻 compute 仍停在 await client.complete）
    h.cancel();
    // 之后 compute 才落定——旧实现 finally 无条件 ready=true → 边界处 apply 僵尸结果
    resolveCompute('[摘要] late-arrival');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.isReady(), false, 'cancel 后落定不得置 ready（旧实现 ready=true）');
    assert.equal(h.result(), null, '被取消的结果必须丢弃');

    // cancel 释放 in-flight 门：允许再次启动
    const h2 = startBackgroundCompact(s, { async complete() { return '[摘要] x'; } });
    assert.ok(h2, 'cancel 后允许再次启动');
    h2!.cancel();
  });

  it('未取消：compute 落定后 ready=true、result 可取（回归）', async () => {
    const s = new Session({ tier: 'high', workspace: '/tmp/ws-cancel2' });
    for (let i = 1; i <= 20; i++) s.addTurn(mkTurn(i));
    let resolveCompute!: (v: string) => void;
    const gated = {
      async complete() {
        return new Promise<string>((res) => { resolveCompute = res; });
      },
    };
    const h = startBackgroundCompact(s, gated as any)!;
    resolveCompute('[摘要] on-time');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.isReady(), true);
    const res = h.result();
    assert.ok(res && res.ok);
    assert.equal(res.summary, '[摘要] on-time');
  });
});
