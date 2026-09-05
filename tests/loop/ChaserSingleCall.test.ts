// tests/loop/ChaserSingleCall.test.ts
// 0.7 F3：判官（continuationJudge）+ TestTimeOrchestrator 摘除后的 chaser 级
// "单次调用"断言（backlog F3 / 方案书 §8）。
// - execution 意图：VerifyCritiqueLoop.run 全程恰好被调一次（恒单 rollout，
//   无判官续跑/多 rollout/early-stop 预算裁剪）。
// - chat 意图：单次 complete 直接回答——complete 恰好一次、loop.run 零调用、
//   结果以 stopReason='answered' 返回（Trajectory 三态语义）。
//
// 手法：补丁 VerifyCritiqueLoop.prototype.run 计数（不 mock 模块——node --test +
// tsx 下对 ESM 具名导出打桩最稳的层级是原型方法）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

describe('0.7 判官摘除后的 chaser 级单次调用（F3）', () => {
  it('execution 意图：VerifyCritiqueLoop.run 全程只被调一次，stopReason 原样透传', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pangu-chaser-once-'));
    const proto = VerifyCritiqueLoop.prototype as any;
    const origRun = proto.run;
    let runCalls = 0;
    proto.run = async function (_prompt: string) {
      runCalls++;
      return { success: true, steps: [], stopReason: 'completed' };
    };
    try {
      const chaser = new PanshalachChaser(
        { async complete() { return '模拟回复'; } },
        'standard'
      );
      const result = await chaser.solveIssue('修复 src/a.ts 的 bug 并跑测试', ws, { tier: 'standard' });
      assert.equal(runCalls, 1, `判官摘除后 loop.run 必须恰好被调一次，实际 ${runCalls}`);
      assert.equal(result.success, true, 'loop 返回 success=true → 回合成功');
      assert.equal(result.bestTrajectory?.stopReason, 'completed', 'loop 的 stopReason 透传到 Trajectory');
      assert.equal(result.bestTrajectory?.success, true);
    } finally {
      proto.run = origRun;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('chat 意图：单次 complete 直接回答（loop.run 零调用），returns answered', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pangu-chat-once-'));
    const proto = VerifyCritiqueLoop.prototype as any;
    const origRun = proto.run;
    let runCalls = 0;
    proto.run = async function () {
      runCalls++;
      throw new Error('chat 意图不得进入 agent 循环');
    };
    let completes = 0;
    try {
      const chaser = new PanshalachChaser(
        { async complete(_prompt: string, _opts?: any) { completes++; return '我是烛龙。'; } },
        'standard'
      );
      const result = await chaser.solveIssue('你好，回答我你是谁', ws, { tier: 'standard' });
      assert.equal(completes, 1, `chat 单次路径 complete 必须恰好调用一次，实际 ${completes}`);
      assert.equal(runCalls, 0, 'chat 不进 agent 循环');
      assert.equal(result.success, true, 'CC 式自然停即成功');
      assert.equal(result.totalRollouts, 1);
      assert.equal(result.bestTrajectory?.stopReason, 'answered', 'chat 单次路径以 answered 终止');
      assert.equal(result.bestTrajectory?.success, true, 'answered 计入 success（但不喂记忆 success 卡）');
      assert.equal(result.bestTrajectory?.steps?.[0]?.result, '我是烛龙。', '回复正文进入轨迹 step');
      assert.equal(result.budgetReport?.notes?.some((n) => n.includes('chat 单次回复')), true, 'budgetReport 标注 chat 单次路径');
    } finally {
      proto.run = origRun;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
