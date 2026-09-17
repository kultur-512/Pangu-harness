// tests/server/ChatAnswerText.test.ts
// R1（0.8.1）chat 正文渲染修复——runAgentTask 层行为锁定：
// chat 直答 / loop answered 的模型正文必须以 RunResult.answerText 带出，
// result 事件同步携带（三端 line/rich/headless 呈现与 turn 落盘的唯一正文通道）。
// 回归语义：此前 RunResult 无 answerText、宿主读不存在的 bestTrajectory →
// chat 正文三端不可见（被 mock 漂移的绿测试掩盖）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentTask } from '../../src/server/runAgentTask.js';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

const TMP_DIRS: string[] = [];
function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-answertxt-'));
  TMP_DIRS.push(d);
  return d;
}

afterEach(() => {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  TMP_DIRS.length = 0;
});

/** complete-only 假 provider（chat 直答路径的回落形态，同 intentAndMemory 手法）。 */
function fakeProvider(reply: string): any {
  const client = {
    complete: async (_p: string) => reply,
  };
  return {
    createClient: () => client,
    createDefaultClient: () => client,
    invalidateProviderCache: () => {},
    listModels: () => [],
    isModelAvailable: () => true,
  };
}

describe('R1（0.8.1）：answered 正文经 RunResult.answerText 带出', () => {
  it('chat 直答：answerText = 模型正文，result 事件同步携带', async () => {
    const ws = tmpWs();
    const events: any[] = [];
    const r = await runAgentTask(
      { task: '你好', tier: 'standard', workspace: ws },
      { provider: fakeProvider('你好！我是烛龙。'), onEvent: (e) => events.push(e) }
    );

    assert.equal(r.stopReason, 'answered', 'chat 直答以 answered 终止');
    assert.equal(r.success, true);
    assert.equal(r.answerText, '你好！我是烛龙。', 'chat 直答正文必须进 RunResult.answerText');

    const resultEv = events.find((e) => e.type === 'result');
    assert.ok(resultEv, '必须发出 result 事件');
    assert.equal(resultEv.answerText, '你好！我是烛龙。', 'result 事件必须携带 answerText（rich 桥消费）');
  });

  it('loop 路径 answered：轨迹末步 result 同样带出（非 chat 专属）', async () => {
    const ws = tmpWs();
    const proto = VerifyCritiqueLoop.prototype as any;
    const origRun = proto.run;
    proto.run = async function () {
      return {
        success: true,
        stopReason: 'answered',
        steps: [{
          stepNumber: 1,
          reasoning: { thinking: '', plan: '', raw: '' },
          toolCalls: [],
          verificationResult: '循环路径的自然停正文XYZ',
          userFacing: true, // 2026-09-16 新语义：空转 answered 步带 userFacing 标记
        }],
      };
    };
    try {
      const events: any[] = [];
      const r = await runAgentTask(
        { task: '修复 src/a.ts 的 bug', tier: 'standard', workspace: ws },
        { provider: fakeProvider('unused'), onEvent: (e) => events.push(e) }
      );

      assert.equal(r.stopReason, 'answered');
      assert.equal(r.answerText, '循环路径的自然停正文XYZ', 'loop answered 正文也必须带出');
      assert.equal(events.find((e) => e.type === 'result')?.answerText, '循环路径的自然停正文XYZ');
    } finally {
      proto.run = origRun;
    }
  });

  it('非 answered 回合不携带 answerText（completed/aborted 不受污染）', async () => {
    const ws = tmpWs();
    const proto = VerifyCritiqueLoop.prototype as any;
    const origRun = proto.run;
    proto.run = async function () {
      return { success: true, stopReason: 'completed', steps: [] };
    };
    try {
      const r = await runAgentTask(
        { task: '修复 src/a.ts 的 bug', tier: 'standard', workspace: ws },
        { provider: fakeProvider('unused'), onEvent: () => {} }
      );
      assert.equal(r.stopReason, 'completed');
      assert.equal(r.answerText, undefined, 'completed 回合不得携带 answerText');
    } finally {
      proto.run = origRun;
    }
  });
});
