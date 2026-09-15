// tests/loop/guardrails.test.ts
// M2-2 卡死检测硬闸（docs/panshalach/PLAN-0.8-FOUNDATION.md §3 M2-2）：
//   - exactFailureBlockAfter=5：同工具+同参数连续失败 5 次 → before_call 阻断
//   - sameToolFailureHaltAfter=8：同工具失败 8 次 → 强制终局 consecutive-failures
//   - noProgressBlockAfter=5：幂等工具（read_file/glob/grep）同参数同结果重复 5 次 → 阻断
//   - loop 接入：与 maxConsecutiveFailures 并行（互不替代）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolCallGuardrailController, toolCallSignature } from '../../src/loop/guardrails.js';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';
import { createEngineAdapter } from '../../src/tools/engineAdapter.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';
import type { ToolCall } from '../../src/types/toolCall.js';

function call(toolName: string, params: Record<string, string>): ToolCall {
  return {
    toolName,
    rawBlock: `<${toolName}>${Object.entries(params).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</${toolName}>`,
    params: Object.entries(params).map(([name, value]) => ({ name, value })),
  };
}

const FAIL = 'ERROR: command failed';

describe('M2-2 ToolCallGuardrailController 单元', () => {
  it('签名：参数顺序无关（JSON 排序序列化）', () => {
    assert.equal(
      toolCallSignature(call('bash', { command: 'x', cwd: 'y' })),
      toolCallSignature(call('bash', { cwd: 'y', command: 'x' }))
    );
    assert.notEqual(toolCallSignature(call('bash', { command: 'x' })), toolCallSignature(call('bash', { command: 'y' })));
  });

  it('exact 闸：4 次失败不拦，5 次拦（reason 含"已连续失败 5 次"）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('bash', { command: 'exit 1' });
    for (let i = 0; i < 4; i++) g.recordResult(c, FAIL);
    assert.equal(g.beforeCall([c]).blocked, false, '4 次失败不拦');
    g.recordResult(c, FAIL); // 第 5 次失败
    const d = g.beforeCall([c]);
    assert.equal(d.blocked, true, '5 次失败拦');
    assert.match(d.reason ?? '', /已连续失败 5 次/);
    assert.equal(d.halt, undefined, 'exact 阻断不是 halt 级');
  });

  it('exact 闸：参数不同不算同参数（不同签名各自计数）', () => {
    const g = new ToolCallGuardrailController();
    const c1 = call('bash', { command: 'exit 1' });
    for (let i = 0; i < 5; i++) g.recordResult(c1, FAIL);
    assert.equal(g.beforeCall([c1]).blocked, true);
    assert.equal(g.beforeCall([call('bash', { command: 'exit 2' })]).blocked, false, '不同参数不拦');
  });

  it('exact 闸：成功归零连败（5 次内穿插成功不拦）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('bash', { command: 'exit 1' });
    g.recordResult(c, FAIL);
    g.recordResult(c, FAIL);
    g.recordResult(c, 'EXIT_CODE:0\nok'); // 成功 → 归零
    g.recordResult(c, FAIL);
    g.recordResult(c, FAIL);
    g.recordResult(c, FAIL);
    assert.equal(g.beforeCall([c]).blocked, false, '累计 5 次失败但中间有成功 → 不拦');
  });

  it('exact 闸：failed 缺省时按结果串降级推断（含 FAIL/ERROR）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('bash', { command: 'exit 1' });
    for (let i = 0; i < 5; i++) g.recordResult(c, FAIL);
    assert.equal(g.beforeCall([c]).blocked, true);
  });

  it('halt 闸：同工具 7 次失败不终局，8 次强制终局（参数可变也计）', () => {
    const g = new ToolCallGuardrailController();
    for (let i = 0; i < 7; i++) g.recordResult(call('bash', { command: `exit ${i}` }), FAIL);
    const next = call('bash', { command: 'exit 99' });
    assert.equal(g.beforeCall([next]).blocked, false, '7 次不终局');
    g.recordResult(next, FAIL); // 第 8 次
    const d = g.beforeCall([call('bash', { command: 'exit 100' })]);
    assert.equal(d.blocked, true, '8 次强制终局');
    assert.equal(d.halt, true, 'halt 级');
    assert.match(d.reason ?? '', /consecutive-failures/, '复用现有终态 stopReason');
  });

  it('halt 闸：该工具成功即归零（换参数重试中偶发成功不终局）', () => {
    const g = new ToolCallGuardrailController();
    for (let i = 0; i < 7; i++) g.recordResult(call('bash', { command: `exit ${i}` }), FAIL);
    g.recordResult(call('bash', { command: 'echo ok' }), 'EXIT_CODE:0');
    assert.equal(g.beforeCall([call('bash', { command: 'exit 100' })]).blocked, false);
  });

  it('noProgress 闸：read_file 同参数同结果 4 次不拦，5 次拦（reason 含"无进展"）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('read_file', { file_path: 'a.txt' });
    for (let i = 0; i < 4; i++) g.recordResult(c, 'same content');
    assert.equal(g.beforeCall([c]).blocked, false, '4 次不拦');
    g.recordResult(c, 'same content'); // 第 5 次同结果
    const d = g.beforeCall([c]);
    assert.equal(d.blocked, true, '5 次拦');
    assert.match(d.reason ?? '', /无进展/);
  });

  it('noProgress 闸：结果变化即重置（同参数不同结果不拦）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('read_file', { file_path: 'a.txt' });
    for (let i = 0; i < 5; i++) g.recordResult(c, `content ${i}`);
    assert.equal(g.beforeCall([c]).blocked, false, '结果每次不同 → 不拦');
  });

  it('noProgress 闸：仅幂等工具跟踪（bash 同结果重复不拦 noProgress）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('bash', { command: 'echo hi' });
    for (let i = 0; i < 10; i++) g.recordResult(c, 'EXIT_CODE:0\nhi');
    const d = g.beforeCall([c]);
    assert.equal(d.blocked, false, 'bash 不是幂等工具，不受 noProgress 约束');
  });

  it('noProgress 闸：结果比较按截断预览（前 200 字符）', () => {
    const g = new ToolCallGuardrailController({ progressPreviewLength: 200 });
    const c = call('read_file', { file_path: 'big.txt' });
    const head = 'A'.repeat(200);
    for (let i = 0; i < 4; i++) g.recordResult(c, head + `tail-${i}`);
    assert.equal(g.beforeCall([c]).blocked, false, '预览截断后前 200 字符相同 → 同结果');
    g.recordResult(c, head + 'tail-x');
    assert.equal(g.beforeCall([c]).blocked, true, '第 5 次同预览 → 拦');
  });

  it('闸门优先级：halt > exact（同参数 8 次失败 → halt 判定）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('bash', { command: 'exit 1' });
    for (let i = 0; i < 8; i++) g.recordResult(c, FAIL);
    const d = g.beforeCall([c]);
    assert.equal(d.blocked, true);
    assert.equal(d.halt, true, 'halt 优先于 exact');
  });
});

// ==================== 0.8.1 UX：只读拒绝快速通道（DENIED_READONLY ≥2 阻断） ====================
// 契约（包A engineAdapter）：聚合文本中对每个 gate readonly 拒绝的调用，在其结果
// 段落【末尾】追加 `[TOOL_DENIED_READONLY <toolName>]` 标记行。guardrails 侧
// recordDenied 以分段尾锚定检测该标记行判定（与 classifySignal 同分段方式）。

const RO_DENY = 'TOOL_ERROR: DENIED_READONLY ✗ DENIED (readonly) · 写类工具在只读模式被禁用。当前档位为只读；使用 /approvals default 或切换档位放行';

/** engineAdapter 契约形状：拒绝消息 + 段尾标记行。 */
const RO_ENGINE_DENY = (tool: string) => `${RO_DENY}\n[TOOL_DENIED_READONLY ${tool}]`;

describe('0.8.1 只读拒绝快速通道（ToolCallGuardrailController）', () => {
  it('readonly 闸：1 次 DENIED_READONLY 不拦，连续 2 次 → beforeCall 阻断并注入强指引', () => {
    const g = new ToolCallGuardrailController();
    const c = call('write_file', { file_path: 'a.txt', content: 'x' });
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([c]).blocked, false, '1 次不拦（阈值 2）');
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    const d = g.beforeCall([c]);
    assert.equal(d.blocked, true, '连续 2 次 → 阻断');
    assert.match(d.reason ?? '', /GUARDRAIL_READONLY_DENIED/);
    assert.match(d.reason ?? '', /请立即 end_turn，并向用户说明/);
    assert.match(d.reason ?? '', /\/approvals default/, '强指引必须点名 /approvals default');
    assert.equal(d.halt, undefined, '阻断不是 halt 级（模型仍有 end_turn 报告机会）');
  });

  it('readonly 闸（0.8.2 跨工具计数）：write 1 次 + edit 1 次 = 不同工具也阻断（真机实录场景）', () => {
    const g = new ToolCallGuardrailController();
    const w = call('write_file', { file_path: 'notes.md', content: 'x' });
    const e = call('edit_file', { file_path: 'notes.md', content: 'y' });
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    g.recordDenied('edit_file', RO_ENGINE_DENY('edit_file'));
    // 跨工具总计数 2 → 即使第 3 次换成 edit_file 也阻断（旧分桶实现永不触发）
    const d = g.beforeCall([e]);
    assert.equal(d.blocked, true, '跨工具总数达阈值 → 阻断');
    assert.match(d.reason ?? '', /与具体工具无关/);
  });

  it('readonly 闸：reason 非只读拒绝 / 工具执行成功 → 计数归零', () => {
    const g = new ToolCallGuardrailController();
    const c = call('write_file', { file_path: 'a.txt', content: 'x' });
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    g.recordDenied('write_file', 'TOOL_ERROR: DENIED_BY_USER 用户拒绝'); // 拒绝性质变化 → 归零
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([c]).blocked, false, '中间被其它拒绝打断 → 不算连续');
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([c]).blocked, true);
    // 执行成功（用户已放行）→ 归零
    g.recordResult(c, 'TOOL_OK: write_file\nVERIFICATION: APPLIED', false);
    assert.equal(g.beforeCall([c]).blocked, false, '该工具成功即归零');
  });

  it('readonly 闸（P1-3 修复）：read_file 成功不得清零跨工具拒绝计数', () => {
    const g = new ToolCallGuardrailController();
    const w = call('write_file', { file_path: 'a.txt', content: 'x' });
    const r = call('read_file', { file_path: 'a.txt' });
    // 写拒 1 次 → 读成功（旧实现在这里把计数清零，读写交替永久饿死阈值 2）
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    g.recordResult(r, 'TOOL_OK: read_file\nfile content here', false);
    assert.equal(g.beforeCall([w]).blocked, false, '仅 1 次，未达阈值');
    // 写拒第 2 次 → 必须立即阻断（证明 read 成功没有清零）
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([w]).blocked, true, 'read 成功后计数应保留，第 2 次写拒达阈值 2');
  });
});

// ==================== 只读拒绝尾标契约：分段尾锚定检测 [TOOL_DENIED_READONLY <tool>] ====================
// 【原缺陷】recordDenied 对整段做 includes('DENIED_READONLY')——read_file/grep
// 结果正文里出现该字面量（如读到守卫源码自身）即被计成只读拒绝，计数虚高 →
// 假阻断。修复：分段（'\n---\n'）尾锚定检测标记行，段尾不是标记行不计数。

describe('只读拒绝尾标契约（分段尾锚定检测 [TOOL_DENIED_READONLY <tool>]）', () => {
  it('段落尾部的标记行 → 计数（连续 2 次 → 阻断）', () => {
    const g = new ToolCallGuardrailController();
    const c = call('write_file', { file_path: 'a.txt', content: 'x' });
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([c]).blocked, false, '1 次不拦');
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([c]).blocked, true, '尾标命中 ×2 → 阻断');
  });

  it('多调用聚合结果：任一分段【末尾】的标记行 → 计数（跨工具累计语义保持）', () => {
    const g = new ToolCallGuardrailController();
    const w = call('write_file', { file_path: 'a.txt', content: 'x' });
    const e = call('edit_file', { file_path: 'a.txt', content: 'y' });
    const agg = [
      'TOOL_ERROR: DENIED_READONLY ✗ DENIED (readonly)\n[TOOL_DENIED_READONLY write_file]',
      'READ_SUCCESS: b.txt\nVERIFICATION: NEUTRAL',
    ].join('\n---\n');
    g.recordDenied('write_file', agg);
    g.recordDenied('edit_file', agg);
    assert.equal(g.beforeCall([e]).blocked, true, '分段尾锚定命中 → 跨工具计数 2 → 阻断');
  });

  it('【原缺陷】正文含 DENIED_READONLY 字样但段尾无标记行 → 不计数不误阻断', () => {
    const g = new ToolCallGuardrailController();
    const w = call('write_file', { file_path: 'a.txt', content: 'x' });
    // 一次真实拒绝（带段尾标记）
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    // read_file 结果正文出现 DENIED_READONLY 字样（读到守卫源码自身），
    // 但段落结尾是 NEUTRAL 尾标——旧 includes 实现把计数抬到 2 → 假阻断
    const readBody = 'READ_SUCCESS: src/loop/guardrails.ts\nthis file mentions DENIED_READONLY in comments\nVERIFICATION: NEUTRAL';
    g.recordDenied('read_file', readBody);
    assert.equal(g.beforeCall([w]).blocked, false, '【原缺陷断言】正文出现字面量不是只读拒绝（旧实现此处误阻断）');
    // 字面量把计数归零了：需再累积 2 次真实拒绝才达阈值
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([w]).blocked, false, '仍只有 1 次真实拒绝 → 不拦');
    g.recordDenied('write_file', RO_ENGINE_DENY('write_file'));
    assert.equal(g.beforeCall([w]).blocked, true, '真实第 2 次连续拒绝 → 正常阻断');
  });

  it('标记行不在段落末尾（后随其它正文）→ 不计数', () => {
    const g = new ToolCallGuardrailController();
    const w = call('write_file', { file_path: 'a.txt', content: 'x' });
    g.recordDenied('write_file', 'READ_SUCCESS: notes.txt\n[TOOL_DENIED_READONLY write_file]\n后续还有正文行\nVERIFICATION: NEUTRAL');
    g.recordDenied('write_file', 'READ_SUCCESS: notes2.txt\n[TOOL_DENIED_READONLY write_file] 后随同段文字\nVERIFICATION: NEUTRAL');
    assert.equal(g.beforeCall([w]).blocked, false, '非尾锚定不计数（旧实现两次 includes 均命中 → 误阻断）');
  });

  it('接缝集成：真实 engineAdapter（readonly）拒绝聚合文本 → recordDenied 2 次后阻断', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ro-seam-'));
    const adapter = createEngineAdapter({
      workspaceRoot: ws,
      tierConfig: TierRegistry.get('standard'),
      approvalMode: 'readonly',
    });
    try {
      const writeCall = {
        toolName: 'write_file',
        params: [{ name: 'file_path', value: 'x.txt' }, { name: 'content', value: 'hi' }],
        rawBlock: '',
      } as any;
      const agg = await adapter.execute([writeCall]);
      assert.ok(
        /\[TOOL_DENIED_READONLY write_file\]\s*$/.test(agg),
        `adapter 聚合文本段尾必须带标记行（跨代理契约）：${agg.slice(-120)}`,
      );
      const g = new ToolCallGuardrailController();
      g.recordDenied('write_file', agg);
      assert.equal(g.beforeCall([writeCall]).blocked, false, '1 次不拦');
      g.recordDenied('write_file', agg);
      const d = g.beforeCall([writeCall]);
      assert.equal(d.blocked, true, '真实 adapter 输出 2 次 → 阻断');
      assert.match(d.reason ?? '', /GUARDRAIL_READONLY_DENIED/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('0.8.1 只读拒绝快速通道（loop 接入）', () => {
  it('write_file 连续 2 次 DENIED_READONLY → 第 3 步 beforeCall 阻断（不再 execute），强指引回灌后模型 end_turn 报告', async () => {
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return RO_ENGINE_DENY('write_file'); },
    };
    const writeBlock = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <write_file><file_path>a.txt</file_path><content>x</content></write_file>
</>
`;
    const model = textModel([writeBlock, writeBlock, writeBlock, '写操作被只读档位拒绝。请执行 /approvals default 切换档位后重试。']);
    // maxConsecutiveFailures 拉高：让 readonly 快速通道（而非连败保护）成为触发者
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 20, maxConsecutiveFailures: 99 });
    const out = await loop.run('写一个文件');

    assert.equal(engine.executeCalls.length, 2, '前 2 步执行被拒，第 3 步被 readonly 快速通道阻断不执行');
    const blockedStep = out.steps.find((s) => s.verificationResult.includes('GUARDRAIL_READONLY_DENIED'));
    assert.ok(blockedStep, '强指引必须作为工具结果回灌（模型可见）');
    assert.match(blockedStep!.verificationResult, /\/approvals default/);
    assert.equal(blockedStep!.verificationSignal, 'FAIL');
    assert.equal(out.stopReason, 'answered', '模型看到强指引后 end_turn 报告 → answered');
  });

  it('只拒绝 1 次不触发：第 2 步仍执行（阈值 2 语义）', async () => {
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return RO_DENY; },
    };
    const writeBlock = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <write_file><file_path>a.txt</file_path><content>x</content></write_file>
</>
`;
    const model = textModel([writeBlock, '只被拒绝了一次，我停止并向用户报告。']);
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 10, maxConsecutiveFailures: 99 });
    const out = await loop.run('写一个文件');
    assert.equal(engine.executeCalls.length, 1, '仅 1 次拒绝 → 不阻断');
    assert.ok(!out.steps.some((s) => s.verificationResult.includes('GUARDRAIL')), '未达阈值不注入阻断 reason');
  });

  it('【原缺陷回归】失败 read 结果正文含 DENIED_READONLY 字样（非只读拒绝）不抬计数', async () => {
    const writeBlockLocal = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <write_file><file_path>a.txt</file_path><content>x</content></write_file>
</>
`;
    const readBlockLocal = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <read_file><file_path>src/loop/guardrails.ts</file_path></read_file>
</>
`;
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) {
        // 第 1 步：write 被拒（带段尾标记）；第 2 步起：read_file 失败（FAIL 信号），
        // 但失败正文里的 DENIED_READONLY 只是字面量（无段尾标记）——不算只读拒绝。
        this.executeCalls.push(calls);
        return this.executeCalls.length === 1
          ? RO_ENGINE_DENY('write_file')
          : 'TOOL_ERROR: READ_FAILED enoent（stderr 提及 DENIED_READONLY 字样）';
      },
    };
    const model = textModel([writeBlockLocal, readBlockLocal, readBlockLocal, readBlockLocal, '失败与只读拒绝无关，我改变方法后停止。']);
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 10, maxConsecutiveFailures: 99 });
    const out = await loop.run('先写后读');
    assert.equal(engine.executeCalls.length, 4, '正文字面量不得触发 readonly 假阻断（旧实现第 3 步即被拦：executeCalls=2）');
    assert.ok(!out.steps.some((s) => s.verificationResult.includes('GUARDRAIL_READONLY_DENIED')), '无假阻断 reason');
    assert.equal(out.stopReason, 'answered');
  });
});

// ==================== loop 接入（与 maxConsecutiveFailures 并行） ====================

function textModel(responses: string[]) {
  let i = 0;
  return {
    prompts: [] as string[],
    async complete(p: string) {
      this.prompts.push(p);
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

const failingBash = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <bash><command>exit 1</command></bash>
</>
`;

const readBlock = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <read_file><file_path>a.txt</file_path></read_file>
</>
`;

describe('M2-2 loop 接入', () => {
  it('exact 闸：同参数同工具 5 连败 → 第 6 步阻断，reason 回灌 history，模型换方法后正常收尾', async () => {
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return 'ERROR: command failed'; },
    };
    const model = textModel([failingBash, failingBash, failingBash, failingBash, failingBash, failingBash, '好的，我改变方法，直接用文本答复。']);
    // maxConsecutiveFailures 拉高：让硬闸（而非连败保护）成为触发者——证明二者并存
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 20, maxConsecutiveFailures: 99 });
    const out = await loop.run('跑一个会失败的命令');

    assert.equal(engine.executeCalls.length, 5, '前 5 步执行，第 6 步被 before_call 阻断不执行');
    const blockedStep = out.steps.find((s) => s.verificationResult.includes('已连续失败 5 次'));
    assert.ok(blockedStep, '阻断 reason 必须作为工具结果回灌（模型可见）');
    assert.equal(blockedStep?.verificationSignal, 'FAIL');
    assert.equal(out.stopReason, 'answered', '模型看到提示后换方法（end_turn）→ 正常收尾');
  });

  it('exact 闸不触发：4 连败 + 阻断前成功一次 → 不阻断', async () => {
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return 'ERROR: command failed'; },
    };
    const model = textModel([failingBash, failingBash, failingBash, failingBash, '完成了。']);
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 10, maxConsecutiveFailures: 99 });
    const out = await loop.run('跑命令');
    assert.equal(engine.executeCalls.length, 4, '4 次失败均执行');
    assert.ok(!out.steps.some((s) => s.verificationResult.includes('已连续失败')), '未达 5 次不注入阻断 reason');
  });

  it('halt 闸：同工具换参数 8 连败 → 强制终局 stopReason=consecutive-failures', async () => {
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return 'ERROR: command failed'; },
    };
    let n = 0;
    const model = {
      async complete() {
        return `<thinking>t</thinking>\n<plan>p</plan>\n<verify>v</verify>\n<>\n  <bash><command>exit ${++n}</command></bash>\n</>`;
      },
    };
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 20, maxConsecutiveFailures: 99 });
    const out = await loop.run('反复失败');

    assert.equal(engine.executeCalls.length, 8, '8 次失败均执行，第 9 步被 halt 阻断');
    assert.equal(out.stopReason, 'consecutive-failures', 'halt 复用现有终态');
    assert.equal(out.success, false);
    const haltStep = out.steps[out.steps.length - 1];
    assert.match(haltStep.verificationResult, /GUARDRAIL_HALT/);
  });

  it('noProgress 闸：read_file 同参数同结果 5 次 → 第 6 步阻断（NEUTRAL 不触发连败保护）', async () => {
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return 'line1\nline2\nVERIFICATION: NEUTRAL'; },
    };
    const model = textModel([readBlock, readBlock, readBlock, readBlock, readBlock, readBlock, '我已确认内容，任务完成。']);
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 20, maxConsecutiveFailures: 3 });
    const out = await loop.run('反复读同一文件');

    assert.equal(engine.executeCalls.length, 5, '同结果重复 5 次后第 6 步阻断');
    const blockedStep = out.steps.find((s) => s.verificationResult.includes('无进展'));
    assert.ok(blockedStep, 'noProgress reason 回灌 history');
    assert.equal(out.stopReason, 'answered', 'NEUTRAL 步不累计连败 → 硬闸先于 maxConsecutiveFailures 触发');
  });

  it('与 maxConsecutiveFailures 并存：连败保护先行（硬闸未达阈值时不干扰既有语义）', async () => {
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return 'ERROR: command failed'; },
    };
    const model = textModel([failingBash, failingBash, failingBash, failingBash, failingBash, failingBash]);
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 20, maxConsecutiveFailures: 2 });
    const out = await loop.run('失败');

    assert.equal(out.stopReason, 'consecutive-failures');
    assert.equal(out.steps.length, 2, '连败 2 次（旧闸）即停——硬闸阈值（5/8）未达，不干扰');
    assert.ok(!out.steps.some((s) => s.verificationResult.includes('GUARDRAIL')), '旧闸触发路径无硬闸 reason');
  });
});
