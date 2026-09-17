// tests/model/openai-compatible.bodyTimeout.test.ts
// 包D 修复：fetchWithTimeout 的 timer 在响应头返回即清，res.text() 可无限挂起——
// - 非流式路径：body 读取必须受同 timeoutMs 约束，超时以超时错误 reject（不挂起、不重试空转）；
// - 流式路径：整体 deadline（默认 10 分钟，从请求开始计）——SSE 中途停滞必须浮出超时，
//   而非永远卡在 reader.read()。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';

const origFetch = (globalThis as any).fetch;
afterEach(() => { (globalThis as any).fetch = origFetch; });

describe('openai-compatible body 读取超时（包D修复）', () => {
  it('complete: 响应头返回后 body 永不 resolve → timeoutMs 后以超时错误 reject（而非挂起）', async () => {
    let fetchCalls = 0;
    (globalThis as any).fetch = async () => {
      fetchCalls++;
      return {
        ok: true, status: 200, statusText: 'OK',
        // 头已返回、body 半挂起
        text: () => new Promise<string>(() => {}),
        json: () => new Promise(() => {}),
      } as any;
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k', timeoutMs: 150 });
    const t0 = Date.now();
    await assert.rejects(
      () => client.complete('hi'),
      (err: any) => err.timeout === true,
      'body 半挂起必须以超时错误浮出'
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `必须及时 reject（got ${elapsed}ms），不能无限挂起`);
    assert.equal(fetchCalls, 1, '头已到的 body 挂死不该被 withRetry 反复重发（重试收益低且可能重复生成）');
  });

  it('complete: 正常 body 不受影响（守卫不误伤）', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    }) as any;
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k', timeoutMs: 5_000 });
    assert.equal(await client.complete('hi'), 'ok');
  });

  it('streamChat: SSE 中途停滞 → 整体 deadline 到期抛超时（而非永远卡在 reader.read）', async () => {
    const enc = new TextEncoder();
    let reads = 0;
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              reads++;
              if (reads === 1) {
                return {
                  done: false,
                  value: enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`),
                };
              }
              // 流中途停滞：read 永不 resolve
              return new Promise(() => {});
            },
          };
        },
      },
    }) as any;
    const client = createOpenAICompatClient({
      baseUrl: 'https://ex.com/v1', apiKey: 'k', timeoutMs: 60_000,
      // 测试注入：整体 deadline 150ms（生产默认 10 分钟）
      streamDeadlineMs: 150,
    });
    const iter = client.streamChat!('hi')[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.equal(first.value?.type, 'text', 'deadline 前的正文 chunk 正常产出');
    const t0 = Date.now();
    await assert.rejects(
      () => iter.next(),
      (err: any) => err.timeout === true,
      'SSE 停滞必须在整体 deadline 到期时浮出超时'
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `deadline 必须及时触发（got ${elapsed}ms）`);
    assert.ok(reads <= 2, `deadline 后不得继续读取流（reads=${reads}）`);
  });
});
