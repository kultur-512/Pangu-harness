// tests/model/errorClassify.test.ts
// M2-5 错误分类器（docs/panshalach/PLAN-0.8-FOUNDATION.md §3 M2-5）：
// - 分类表全覆盖（8 类 + 优先级）
// - withRetry 接入：auth/billing/context_overflow 快速失败（1 次请求，
//   不再白吃 5 次退避）；timeout 可重试（瞬态）
// - TASK_ABORTED（用户中止）不得被误分类/误重试

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApiError, ApiErrorClass } from '../../src/model/errorClassify.js';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';

const origFetch = (globalThis as any).fetch;

describe('M2-5 classifyApiError 分类表', () => {
  const cases: Array<[string, any, ApiErrorClass]> = [
    ['429 rate limited', { status: 429, body: 'rate limited' }, 'rate_limit'],
    ['仅正文 rate limit（无 status）', { message: 'rate limit exceeded, retry later' }, 'rate_limit'],
    ['500', { status: 500, body: 'internal error' }, 'server'],
    ['502', { status: 502, body: 'bad gateway' }, 'server'],
    ['503', { status: 503, body: 'unavailable' }, 'server'],
    ['504', { status: 504, body: 'gateway timeout' }, 'server'],
    ['timeout 显式标记', { timeout: true, message: 'complete timeout' }, 'timeout'],
    ['裸 AbortError 无 ABORTED 码', { name: 'AbortError', message: 'This operation was aborted' }, 'timeout'],
    ['400 + maximum context length', { status: 400, body: 'maximum context length exceeded' }, 'context_overflow'],
    ['400 + context length', { status: 400, body: "This model's maximum context length is 8192" }, 'context_overflow'],
    ['400 + too many tokens', { status: 400, body: 'too many tokens in the prompt' }, 'context_overflow'],
    ['413 + token limit', { status: 413, body: 'token limit exceeded' }, 'context_overflow'],
    ['422 + 超出上下文', { status: 422, body: '输入超出上下文长度限制' }, 'context_overflow'],
    ['422 + 上下文超限', { status: 422, body: '上下文长度超过上限' }, 'context_overflow'],
    ['401', { status: 401, body: 'unauthorized' }, 'auth'],
    ['403', { status: 403, body: 'forbidden' }, 'auth'],
    ['无 status 正文 invalid api key', { message: 'invalid api key provided' }, 'auth'],
    ['402', { status: 402, body: 'payment required' }, 'billing'],
    ['429 + insufficient balance → billing（优先级高于 rate_limit）', { status: 429, body: 'insufficient balance' }, 'billing'],
    ['400 + quota exceeded', { status: 400, body: 'your quota exceeded' }, 'billing'],
    ['network 标记', { network: true, message: 'fetch failed' }, 'network'],
    ['TypeError fetch failed', { name: 'TypeError', message: 'fetch failed' }, 'network'],
    ['TASK_ABORTED 用户中止 → unknown（不可重试）', { code: 'ABORTED', name: 'AbortError', message: 'TASK_ABORTED' }, 'unknown'],
    ['400 无 overflow 模式 → unknown', { status: 400, body: 'bad request' }, 'unknown'],
    ['418 无匹配 → unknown', { status: 418, body: 'teapot' }, 'unknown'],
    ['空对象 → unknown', {}, 'unknown'],
    ['null → unknown', null, 'unknown'],
  ];
  for (const [name, e, expected] of cases) {
    it(name, () => {
      assert.equal(classifyApiError(e), expected);
    });
  }

  it('400 + overflow 模式优先于 billing 模式', () => {
    assert.equal(classifyApiError({ status: 400, body: 'billing: maximum context length exceeded' }), 'context_overflow');
  });

  it('429 + rate limit 正文（无 billing）→ rate_limit', () => {
    assert.equal(classifyApiError({ status: 429, body: 'too many requests' }), 'rate_limit');
  });

  it('显式 apiErrorClass 标注优先', () => {
    assert.equal(classifyApiError({ apiErrorClass: 'billing', status: 500 }), 'billing');
  });
});

describe('M2-5 withRetry 接入分类器（快速失败）', () => {
  afterEach(() => { (globalThis as any).fetch = origFetch; });

  function client() { return createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' }); }

  it('auth 401 → 1 次请求即抛（不再白吃 5 次退避）', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'unauthorized' } as any;
    };
    await assert.rejects(() => client().complete('hi'), (err: any) => err.status === 401);
    assert.equal(calls, 1, `auth 快速失败，实际 ${calls} 次`);
  });

  it('billing（429 + insufficient balance）→ 1 次请求即抛', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'insufficient balance' } as any;
    };
    await assert.rejects(() => client().complete('hi'), (err: any) => err.status === 429);
    assert.equal(calls, 1, `billing 快速失败，实际 ${calls} 次`);
  });

  it('context_overflow（400）→ 客户端层 1 次请求即抛（重试由 loop 强制 compact 接管）', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return { ok: false, status: 400, statusText: 'Bad Request', text: async () => 'maximum context length exceeded' } as any;
    };
    await assert.rejects(() => client().complete('hi'), (err: any) => err.status === 400);
    assert.equal(calls, 1);
  });

  it('rate_limit（429 无 billing 正文）→ 维持重试', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, statusText: 'Too Many Requests', headers: { get: () => '0' }, text: async () => 'rate limited' } as any;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) } as any;
    };
    assert.equal(await client().complete('hi'), 'ok');
    assert.equal(calls, 2, '429 rate_limit 仍重试');
  });

  it('timeout（裸 AbortError 无外部中止）→ 可重试后恢复', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls === 1) {
        const e: any = new Error('The operation was aborted due to timeout');
        e.name = 'AbortError';
        throw e;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '恢复' }, finish_reason: 'stop' }] }) } as any;
    };
    const out = await client().complete('hi');
    assert.equal(out, '恢复');
    assert.equal(calls, 2, 'timeout 瞬态可重试');
  });

  it('TASK_ABORTED（用户中止）→ 不重试', async () => {
    let calls = 0;
    (globalThis as any).fetch = () => {
      calls++;
      const e: any = new Error('TASK_ABORTED');
      e.code = 'ABORTED';
      e.name = 'AbortError';
      throw e;
    };
    await assert.rejects(() => client().complete('hi'), (err: any) => err.code === 'ABORTED');
    assert.equal(calls, 1);
  });
});
