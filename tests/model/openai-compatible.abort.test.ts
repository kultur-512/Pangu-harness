// tests/model/openai-compatible.abort.test.ts
// 0.7 F2：外部 AbortSignal abort 传播（backlog F2 / 方案书 §8）。
// - fetch 层（complete 带 opts.signal）：中途 abort / 预先 abort 都要中断请求，
//   抛 TASK_ABORTED（code ABORTED）；abort 是终态，不进入 withRetry 重试。
// - streamChat 层：连接阶段 abort → TASK_ABORTED（不得吞掉或静默回退成普通完成）；
//   流中途 abort → 循环顶部 signal 检查抛 TASK_ABORTED。
// mock fetch 风格与 tests/model/openai-compatible.retry.test.ts 一致（替换 globalThis.fetch）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';

const origFetch = (globalThis as any).fetch;
afterEach(() => { (globalThis as any).fetch = origFetch; });

/** fetch 调用方传入的 init.signal（内部 controller 合并外部 signal 后的信号）上挂 AbortError reject */
function hangUntilAborted(init: any): Promise<never> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => {
      const e: any = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (init?.signal?.aborted) onAbort();
    else init?.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeClient() {
  return createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
}

describe('openai-compatible 外部 AbortSignal 传播（0.7 F2）', () => {
  it('complete: 请求挂起时外部 abort → TASK_ABORTED（ABORTED 码），且不触发重试', async () => {
    const controller = new AbortController();
    let fetchCalls = 0;
    (globalThis as any).fetch = (_url: string, init: any) => {
      fetchCalls++;
      return hangUntilAborted(init);
    };
    const client = makeClient();
    const p = client.complete('hi', { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10)); // 让请求进入挂起态
    controller.abort();
    await assert.rejects(p, (err: any) =>
      err.message === 'TASK_ABORTED' && err.code === 'ABORTED',
      'abort 必须以 TASK_ABORTED/ABORTED 语义浮出');
    assert.equal(fetchCalls, 1, 'abort 是终态——不得进入 withRetry 重试');
  });

  it('complete: 传入已 abort 的 signal → 立即 TASK_ABORTED', async () => {
    const controller = new AbortController();
    controller.abort(); // 预先中止
    (globalThis as any).fetch = (_url: string, init: any) => hangUntilAborted(init);
    const client = makeClient();
    await assert.rejects(
      () => client.complete('hi', { signal: controller.signal }),
      (err: any) => err.message === 'TASK_ABORTED' && err.code === 'ABORTED'
    );
  });

  it('streamChat: 连接阶段外部 abort → TASK_ABORTED', async () => {
    const controller = new AbortController();
    (globalThis as any).fetch = (_url: string, init: any) => hangUntilAborted(init);
    const client = makeClient();
    const iter = client.streamChat!('hi', { signal: controller.signal })[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await assert.rejects(
      () => iter.next(),
      (err: any) => err.message === 'TASK_ABORTED' && err.code === 'ABORTED',
      '传输层 AbortError 必须被 streamChat 转换为 TASK_ABORTED，而不是挂死'
    );
  });

  it('streamChat: 流中途 abort → 下一次循环顶部 signal 检查抛 TASK_ABORTED', async () => {
    const controller = new AbortController();
    const enc = new TextEncoder();
    let reads = 0;
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              reads++;
              if (reads === 1) {
                // 第一个 SSE 事件：一段正文增量
                return {
                  done: false,
                  value: enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '你' } }] })}\n\n`),
                };
              }
              // 实现回归（顶部不检查 signal）时会挂在这里 → 测试超时暴露
              return new Promise(() => {});
            },
          };
        },
      },
    });
    const client = makeClient();
    const iter = client.streamChat!('hi', { signal: controller.signal })[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.equal(first.value?.type, 'text', 'abort 前首个正文 chunk 正常产出');
    controller.abort();
    await assert.rejects(
      () => iter.next(),
      (err: any) => err.message === 'TASK_ABORTED' && err.code === 'ABORTED',
      '流中途 abort 必须在下一轮循环顶部被检查到并抛 TASK_ABORTED'
    );
    assert.ok(reads <= 2, `abort 后不得继续大量读取流（reads=${reads}）`);
  });
});
