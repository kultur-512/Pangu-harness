// tests/integration/intentAndMemory.test.ts
// 0.7.2 反思迭代验收器（docs/panshalach/REFLECTION-0.7.2.md）：
//
// 1. greeting → chat：入口对【原始输入】分类（接线后），"你好，回答我你是谁"
//    以 intent='chat' 进入 solveIssue → buildForTask 不注入格式教学/L0 硬约束，
//    chaser 走单次 complete 直答（stopReason='answered'）。
//    回归语义：接线前分类发生在 solveIssue 内、对象是富化文本（必含 bash 等
//    执行词）→ 恒判 execution → 格式教学块必然出现 → 本文件红灯。
//
// 2. "整理 src/foo.ts 的导出" → search：intent='search'，受限只读循环
//    （maxSteps=3）+ approvalMode 强制 readonly。
//
// 3. completed → finalizeTaskMemory：stopReason==='completed' 的任务自动
//    refine→save 产出 success 卡；注入卡（lastBuildMeta.injectedCardIds）与
//    轨迹写集（steps[].action 的 write_file file_path）交集非空 → markVerified。
//
// 手法：与 tests/loop/ChaserSingleCall.test.ts 一致——对
// PanshalachChaser.prototype.solveIssue / VerifyCritiqueLoop.prototype.run 打
// 原型补丁（node --test + tsx 下 ESM 具名导出打桩最稳的层级）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentTask } from '../../src/server/runAgentTask.js';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';

const TMP_DIRS: string[] = [];
function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-072-'));
  TMP_DIRS.push(d);
  return d;
}

function fakeProvider(prompts: string[], reply = 'plain text answer'): any {
  const client = {
    complete: async (p: string) => {
      prompts.push(String(p));
      return reply;
    },
  };
  return {
    createClient: () => client,
    createDefaultClient: () => client,
    invalidateProviderCache: () => {},
    listModels: () => [],
    isModelAvailable: () => true,
  };
}

// ---- 原型补丁：捕获 solveIssue config 与 loop 实例 ----
const solveIssueOrig = PanshalachChaser.prototype.solveIssue;
const loopRunOrig = VerifyCritiqueLoop.prototype.run;
let solveIssueConfigs: any[] = [];
let loopInstances: any[] = [];
let scriptedLoopResult: any = null; // 非 null 时 loop.run 直接返回脚本结果

function patchPrototypes(): void {
  (PanshalachChaser.prototype as any).solveIssue = async function (
    issue: string, ws: string, config: any = {}
  ) {
    solveIssueConfigs.push(config);
    return solveIssueOrig.call(this, issue, ws, config);
  };
  (VerifyCritiqueLoop.prototype as any).run = async function (prompt: string) {
    loopInstances.push(this);
    if (scriptedLoopResult) return scriptedLoopResult;
    return loopRunOrig.call(this, prompt);
  };
}

function restorePrototypes(): void {
  PanshalachChaser.prototype.solveIssue = solveIssueOrig;
  VerifyCritiqueLoop.prototype.run = loopRunOrig;
  solveIssueConfigs = [];
  loopInstances = [];
  scriptedLoopResult = null;
}

describe('0.7.2 意图前移接线 + 记忆落定（集成）', () => {
  afterEach(() => {
    restorePrototypes();
    for (const d of TMP_DIRS) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    TMP_DIRS.length = 0;
  });

  it('greeting → chat：入口原文分类，prompt 无格式教学/L0 硬约束，直答 answered', async () => {
    patchPrototypes();
    const ws = tmpWs();
    const prompts: string[] = [];
    const events: any[] = [];
    const r = await runAgentTask(
      { task: '你好，回答我你是谁', tier: 'standard', workspace: ws },
      { provider: fakeProvider(prompts), onEvent: (e) => events.push(e) }
    );

    // 入口把分类结果传给 solveIssue（接线断言）
    assert.equal(
      solveIssueConfigs.at(-1)?.intent, 'chat',
      'solveIssue 必须收到入口前移分类的 intent=chat'
    );
    assert.equal(r.stopReason, 'answered', 'chat 走单次直答（answered）');
    assert.equal(r.success, true);

    // 模型看到的 prompt：chat 不得携带重工程块
    const seen = prompts.join('\n');
    assert.ok(seen.includes('你好，回答我你是谁'), '用户原文必须到达模型');
    assert.ok(!seen.includes('工具调用格式（必须遵守）'), 'chat prompt 不得含格式教学块');
    assert.ok(!seen.includes('【硬约束】'), 'chat prompt 不得含 L0 硬约束块');
    // chat 不进 agent 循环
    assert.equal(loopInstances.length, 0, 'chat 意图不得构造/进入 VerifyCritiqueLoop');
  });

  it('"整理 src/foo.ts 的导出" → search：intent 透传 + ≤3 步 + 强制 readonly', async () => {
    patchPrototypes();
    const ws = tmpWs();
    const prompts: string[] = [];
    const r = await runAgentTask(
      { task: '整理 src/foo.ts 的导出', tier: 'standard', workspace: ws },
      // 调用方故意放宽审批 → search 意图必须仍被强制 readonly
      { provider: fakeProvider(prompts), onEvent: () => {}, approvalMode: 'default' }
    );

    assert.equal(
      solveIssueConfigs.at(-1)?.intent, 'search',
      'solveIssue 必须收到入口前移分类的 intent=search'
    );
    const loop: any = loopInstances.at(-1);
    assert.ok(loop, 'search 意图进入受限 agent 循环');
    assert.equal(loop.maxSteps, 3, `search 循环必须 ≤3 步，实际 ${loop?.maxSteps}`);
    assert.equal(
      loop.verificationEngine?.ctx?.approvalMode, 'readonly',
      'search 强制 readonly（覆盖调用方的 default）'
    );
    const seen = prompts.join('\n');
    assert.ok(seen.includes('只读'), 'search 指令（只读约束）必须到达模型');
    assert.ok(!seen.includes('有两种工作方式'),
      'search 不走 execution 的推理模板（buildReasoningPrompt）');
    // 说明：loop 实用模式第一步会对任何进入循环的任务注入一次工具格式教学，
    // 但 search 下可用工具集已被引擎收窄为只读（glob/grep/read_file）——这是
    // 既有 loop 行为，不属于执行路径的重工程注入，这里不做反向断言。
    assert.ok(r.stopReason === 'answered' || r.stopReason === 'no-verification',
      '假模型无工具调用 → 快速自然停');
  });

  it('completed → finalizeTaskMemory 自动产卡（refine→save）+ 交集 markVerified', async () => {
    patchPrototypes();
    const ws = tmpWs();

    // 预置一张可被注入的记忆卡（implementation 卡在 standard/high 档可见）
    const seed = {
      id: 'seedcard0001',
      kind: 'success',
      category: 'OTHER',
      memoryCategory: 'implementation',
      summary: 'SEED_CARD：src/foo.ts 导出整理的既有经验',
      weight: 2,
      taskStyle: 'all',
      count: 1,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
      applicableTiers: [],
      sourceContext: 'seed',
      decayWeight: 1.0,
      lastUsedAt: Date.now(),
      referencedFiles: ['src/foo.ts'],
    } as any;
    new RefinedMemoryStore(ws).save([seed]);

    // 脚本化 loop：一步 write_file + ALL_TESTS_PASSED → completed
    scriptedLoopResult = {
      success: true,
      stopReason: 'completed',
      steps: [{
        stepNumber: 1,
        reasoning: { thinking: '', plan: '', verify: '', raw: '' },
        toolCalls: [{
          toolName: 'write_file',
          params: [
            { name: 'file_path', value: 'src/foo.ts' },
            { name: 'content', value: 'export const answer = 42;\n' },
          ],
          rawBlock: '',
        }],
        verificationResult: 'ALL_TESTS_PASSED',
        verificationSignal: 'PASS',
      }],
    };

    const events: any[] = [];
    const r = await runAgentTask(
      { task: '修复 src/foo.ts 并跑测试', tier: 'standard', workspace: ws },
      { provider: fakeProvider([]), onEvent: (e) => events.push(e) }
    );

    assert.equal(r.stopReason, 'completed', '脚本化轨迹以 completed 终止');
    assert.equal(r.success, true);

    // R1：refine→save 落定 —— 记忆文件出现新的 success 卡
    const file = new RefinedMemoryStore(ws).load();
    const positive = file.cards.filter((c) => String(c.summary || '').startsWith('已验证可行的做法'));
    assert.ok(positive.length >= 1, `completed 任务必须自动产出 success 卡，实际 ${file.cards.length} 张`);

    // R2：注入卡 ∩ 轨迹写集 → markVerified（seed 卡 count 1→2）
    const seedAfter = file.cards.find((c) => c.id === 'seedcard0001');
    assert.ok(seedAfter, 'seed 卡仍在');
    assert.equal(seedAfter?.count, 2, 'seed 卡必须被 markVerified（count+1，lastUsedAt 刷新）');

    // 轻量事件
    const ev = events.find((e) => e.type === 'memory.finalized');
    assert.ok(ev, '必须发出 memory.finalized 事件');
    assert.ok(ev.cards >= 1 && ev.verified >= 1, '事件携带产卡数与验证卡数');
  });

  it('失败/中止任务不产卡：stopReason 非 completed 时 finalizeTaskMemory 零写入', async () => {
    patchPrototypes();
    const ws = tmpWs();
    const events: any[] = [];
    const r = await runAgentTask(
      { task: '修复 src/missing.ts 的 bug 并跑测试', tier: 'standard', workspace: ws },
      { provider: fakeProvider([]), onEvent: (e) => events.push(e) }
    );
    // 假模型无工具调用 → answered / no-verification（非 completed）
    assert.notEqual(r.stopReason, 'completed');
    const file = new RefinedMemoryStore(ws).load();
    assert.equal(file.cards.length, 0, '非 completed 任务不得产卡');
    assert.equal(events.find((e) => e.type === 'memory.finalized'), undefined,
      '非 completed 任务不发 memory.finalized');
  });
});
