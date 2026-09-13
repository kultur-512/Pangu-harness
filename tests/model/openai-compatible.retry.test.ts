// tests/model/openai-compatible.retry.test.ts
// 改动包 B（对抗清单 #1/#三）：429/5xx 重试、Retry-After 优先、
// EMPTY_RESPONSE 可重试且耗尽返回空。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';

const origFetch = (globalThis as any).fetch;
describe('openai-compatible withRetry（改动包 B）', () => {
  afterEach(() => { (globalThis as any).fetch = origFetch; });

  it('429 + Retry-After:0 → 重试后成功', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false, status: 429, statusText: 'Too Many Requests',
          headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '0' : null) },
          async text() { return 'rate limited'; },
        } as any;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out = await client.complete('hi');
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  });

  it('持续 429 → 重试耗尽后抛出（status 保留）', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return {
        ok: false, status: 429, statusText: 'Too Many Requests',
        headers: { get: () => '0' },
        async text() { return 'rate limited'; },
      } as any;
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    await assert.rejects(
      () => client.complete('hi'),
      (err: any) => err.status === 429
    );
    assert.ok(calls >= 4, `1 次原始 + 3 次重试，got ${calls}`);
  });

  it('200 空响应（无 content/text/toolCalls）→ EMPTY_RESPONSE 重试耗尽返回空串', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => { calls++; return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as any; };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out = await client.complete('hi');
    assert.equal(out, '');
    assert.ok(calls >= 4, `EMPTY_RESPONSE 可重试，got ${calls}`);
  });

  it('500 → 可重试（Retry-After 头优先于本地退避，0 延迟不拖慢测试）', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls <= 2) {
        return {
          ok: false, status: 500, statusText: 'Server Error',
          headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '0' : null) },
          async text() { return 'boom'; },
        } as any;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) } as any;
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    assert.equal(await client.complete('hi'), 'recovered');
    assert.equal(calls, 3);
  });

  // ── 包D 修复：Retry-After ≤30s 按服务端等待；>30s 该错误最多一次性补试
  // （此前钳到 30s 后照常最多 5 连发——服务端明确说"一小时后再来"还连锤 6 次）──

  it('Retry-After:3600（>30s）→ 总请求数 == 2 而非 6（包D修复）', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return {
        ok: false, status: 503, statusText: 'Service Unavailable',
        headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '3600' : null) },
        async text() { return 'overloaded, come back later'; },
      } as any;
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    await assert.rejects(
      () => client.complete('hi'),
      (err: any) => err.status === 503
    );
    assert.equal(calls, 2, `>30s 的 Retry-After 只允许 1 次原始 + 1 次一次性补试，got ${calls}`);
  });

  it('Retry-After ≤30s 仍按服务端值等待并走常规重试（语义保持）', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls <= 2) {
        return {
          ok: false, status: 429, statusText: 'Too Many Requests',
          headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '1' : null) },
          async text() { return 'slow down'; },
        } as any;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    };
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    assert.equal(await client.complete('hi'), 'ok');
    assert.equal(calls, 3, '≤30s 按服务端等待 + 常规 MAX_RETRIES 循环');
  });
});
