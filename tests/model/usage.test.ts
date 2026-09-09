// tests/model/usage.test.ts
// M2-4 真实 usage 计量（docs/panshalach/PLAN-0.8-FOUNDATION.md §3 M2-4）：
// - usage 解析（非流 json.usage / 流尾 usage chunk）
// - onUsage 回调（prompt/completion 字段；total_tokens 不进回调）
// - 无 usage → 回落字符长度 /4 估算（chaser 层）
// - chaser 累计口径（实测 vs 估算标志）

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

const origFetch = (globalThis as any).fetch;

describe('M2-4 usage 解析（client 层）', () => {
  afterEach(() => { (globalThis as any).fetch = origFetch; });

  it('非流：json.usage → onUsage 收到 prompt/completion（total_tokens 不进回调）', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '答案' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const seen: any[] = [];
    const out = await client.complete('hi', { onUsage: (u) => seen.push(u) });
    assert.equal(out, '答案', 'usage 不影响返回内容');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { prompt: 12, completion: 7 }, 'total_tokens 不参与回调');
  });

  it('非流：tool_calls 结构化输出路径同样触发 onUsage', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: { content: '', tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    let seen: any = null;
    const out: any = await client.complete('hi', { onUsage: (u) => { seen = u; } });
    assert.equal(out.toolCalls.length, 1);
    assert.deepEqual(seen, { prompt: 3, completion: 4 });
  });

  it('非流：无 usage 字段 → onUsage 不触发', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '无 usage' }, finish_reason: 'stop' }] }),
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    let calls = 0;
    const out = await client.complete('hi', { onUsage: () => { calls++; } });
    assert.equal(out, '无 usage');
    assert.equal(calls, 0, 'usage 缺失不回调，由上层回落估算');
  });

  it('流式：usage 挂在 [DONE] 前的空 choices usage chunk → onUsage 一次', async () => {
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '答案' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '是42' } }] }),
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }),
      'data: [DONE]',
      '',
    ].join('\n\n');
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => ({ done: false, value: new TextEncoder().encode(sse) }) }) },
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const seen: any[] = [];
    const chunks: any[] = [];
    for await (const c of client.streamChat!('hi', { onUsage: (u) => seen.push(u) })) chunks.push(c);
    const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('');
    assert.equal(text, '答案是42');
    assert.equal(seen.length, 1, '流式 usage 只回调一次');
    assert.deepEqual(seen[0], { prompt: 12, completion: 7 });
  });

  it('流式：usage 挂尾 delta（finish_reason=stop 的空 delta chunk）→ onUsage 一次', async () => {
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }),
      'data: [DONE]',
      '',
    ].join('\n\n');
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => ({ done: false, value: new TextEncoder().encode(sse) }) }) },
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const seen: any[] = [];
    for await (const c of client.streamChat!('hi', { onUsage: (u) => seen.push(u) })) void c;
    assert.deepEqual(seen, [{ prompt: 2, completion: 1 }]);
  });

  it('流式：无 usage → onUsage 不触发（有正文时不回落）', async () => {
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '纯流式' } }] }),
      'data: [DONE]',
      '',
    ].join('\n\n');
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => ({ done: false, value: new TextEncoder().encode(sse) }) }) },
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    let calls = 0;
    for await (const c of client.streamChat!('hi', { onUsage: () => { calls++; } })) void c;
    assert.equal(calls, 0);
  });
});

describe('M2-4 chaser 累计口径（实测 vs 估算）', () => {
  function tmpWs(): string { return mkdtempSync(join(tmpdir(), 'pangu-usage-')); }
  const proto = VerifyCritiqueLoop.prototype as any;
  const origRun = proto.run;

  afterEach(() => {
    (VerifyCritiqueLoop.prototype as any).run = origRun;
    (globalThis as any).fetch = origFetch;
  });

  it('execution：loop 经 wrapper 传 onUsage → budgetReport 实测累计 + usageMeasured=true', async () => {
    const ws = tmpWs();
    (VerifyCritiqueLoop.prototype as any).run = async function (prompt: string) {
      const client = (this as any).modelClient;
      const out = await client.complete(prompt, { signal: undefined });
      const text = typeof out === 'string' ? out : (out?.content ?? '');
      return {
        success: true,
        steps: [{ stepNumber: 1, reasoning: { raw: text }, toolCalls: [], verificationResult: 'ok', verificationSignal: 'PARTIAL' }],
        stopReason: 'completed',
      };
    };
    try {
      const mock = {
        async complete(_p: string, opts?: any) {
          opts?.onUsage?.({ prompt: 10, completion: 5 });
          return '模拟回复';
        },
      };
      const chaser = new PanshalachChaser(mock, 'standard');
      const r = await chaser.solveIssue('修复 src/a.ts 的 bug 并跑测试', ws, { tier: 'standard' });
      assert.equal(r.budgetReport?.usageMeasured, true, '网关返回 usage → 实测');
      assert.equal(r.budgetReport?.estimatedUsedTokens, 15, 'prompt+completion 累计');
      assert.ok(r.budgetReport?.notes?.some((n) => n.includes('实测')), 'budgetReport 注明实测');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('execution：网关无 usage → 回落 len/4 估算 + usageMeasured=false', async () => {
    const ws = tmpWs();
    (VerifyCritiqueLoop.prototype as any).run = async function (prompt: string) {
      const client = (this as any).modelClient;
      const out = await client.complete(prompt, { signal: undefined });
      const text = typeof out === 'string' ? out : (out?.content ?? '');
      return {
        success: true,
        steps: [{ stepNumber: 1, reasoning: { raw: text }, toolCalls: [], verificationResult: 'ok', verificationSignal: 'PARTIAL' }],
        stopReason: 'completed',
      };
    };
    try {
      const mock = { async complete(_p: string) { return '模拟回复'; } };
      const chaser = new PanshalachChaser(mock, 'standard');
      const r = await chaser.solveIssue('修复 src/a.ts 的 bug 并跑测试', ws, { tier: 'standard' });
      assert.equal(r.budgetReport?.usageMeasured, false, '无 usage → 估算');
      assert.ok((r.budgetReport?.estimatedUsedTokens ?? 0) > 0, 'len/4 估算 > 0');
      assert.ok(r.budgetReport?.notes?.some((n) => n.includes('估算')), 'budgetReport 注明估算');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('chat：单次回复同样计量（实测 usage 进 budgetReport）', async () => {
    const ws = tmpWs();
    try {
      const mock = {
        async complete(_p: string, opts?: any) {
          opts?.onUsage?.({ prompt: 5, completion: 3 });
          return '我是烛龙。';
        },
      };
      const chaser = new PanshalachChaser(mock, 'standard');
      const r = await chaser.solveIssue('你好，回答我你是谁', ws, { tier: 'standard' });
      assert.equal(r.budgetReport?.usageMeasured, true);
      assert.equal(r.budgetReport?.estimatedUsedTokens, 8);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});
