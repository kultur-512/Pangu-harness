// tests/model/openai-compatible.073.test.ts
// 0.7.3 T2#7 / T2#10 行为锁定：
//   T2#7 finish_reason=length → complete() 返回对象带 truncated:true（含 toolCalls
//        与纯文本两条路径）；streamChat 在尾 delta / 回退 chunk 上透传 finishReason。
//   T2#10 MAX_RETRIES 3→5；isRetryableErr 补传输类错误（TypeError / fetch failed）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';

const origFetch = (globalThis as any).fetch;

describe('0.7.3 T2#7 finish_reason=length 防御（client 层）', () => {
  afterEach(() => { (globalThis as any).fetch = origFetch; });

  it('doComplete：纯文本 + finish_reason=length → { content, truncated:true }', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '半截答复…' }, finish_reason: 'length' }],
      }),
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out: any = await client.complete('hi');
    assert.equal(out.content, '半截答复…');
    assert.equal(out.truncated, true, '截断必须显式标记（裸 string 无法携带）');
  });

  it('doComplete：tool_calls + finish_reason=length → 对象同时带 toolCalls 与 truncated', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ech' } }],
          },
          finish_reason: 'length',
        }],
      }),
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out: any = await client.complete('hi');
    assert.equal(out.toolCalls.length, 1, '残缺 JSON arguments 也按原样转换（截断防御在上层）');
    assert.equal(out.truncated, true);
  });

  it('finish_reason=stop → 行为不变（纯文本仍返回 string）', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '完整答复' }, finish_reason: 'stop' }],
      }),
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out = await client.complete('hi');
    assert.equal(out, '完整答复');
  });

  it('streamChat：SSE 尾 delta 携带 finish_reason=length → 透传 finishReason chunk', async () => {
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '截断的文本' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      'data: [DONE]',
      '',
    ].join('\n\n');
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      body: { getReader: () => ({
        read: async () => {
          const val = sse;
          return { done: false, value: new TextEncoder().encode(val) };
        },
      }) },
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const chunks: any[] = [];
    for await (const c of client.streamChat('hi')!) chunks.push(c);
    assert.ok(chunks.some((c) => c.type === 'text' && c.finishReason === 'length'),
      '尾 delta 的 finish_reason=length 必须透传为 finishReason chunk');
  });
});

describe('0.7.3 T2#10 withRetry 对齐', () => {
  afterEach(() => { (globalThis as any).fetch = origFetch; });

  it('TypeError（传输层）→ 可重试，最多 1+5 次后抛出', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      throw new TypeError('terminated');
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    await assert.rejects(() => client.complete('hi'), /terminated|network/);
    assert.ok(calls >= 6, `1 次原始 + 5 次重试（MAX_RETRIES=5），实际 ${calls} 次`);
  });

  it('message 含 "fetch failed" 的错误 → 可重试后成功', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      };
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out = await client.complete('hi');
    assert.equal(out, 'ok');
    assert.equal(calls, 2, 'fetch failed 触发一次重试即恢复');
  });

  it('TASK_ABORTED（用户中止）不得被传输类规则误重试', async () => {
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      const e: any = new Error('TASK_ABORTED');
      e.code = 'ABORTED';
      e.name = 'AbortError';
      throw e;
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    await assert.rejects(() => client.complete('hi'), (err: any) => err.code === 'ABORTED');
    assert.equal(calls, 1, '中止错误不重试');
  });
});
