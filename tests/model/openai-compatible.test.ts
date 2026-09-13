// tests/model/openai-compatible.test.ts
// Unit tests for the generic OpenAI-compatible client (mocked fetch).
// No real network.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';

const origFetch = (globalThis as any).fetch;

function mockFetch(handler: (url: string, init?: any) => Promise<any>) {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const res = await handler(url, init);
    return {
      ok: res.ok !== false,
      status: res.status ?? 200,
      statusText: res.statusText ?? 'OK',
      async json() { return res.json ?? {}; },
      async text() { return res.text ?? ''; },
    } as any;
  };
}

function restoreFetch() {
  (globalThis as any).fetch = origFetch;
}

describe('openai-compatible client (mocked)', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('listModels parses data[].id', async () => {
    mockFetch(async (url) => {
      if (url.includes('/models')) {
        return {
          ok: true,
          json: {
            data: [
              { id: 'openPangu-7B' },
              { id: 'openPangu-1B' },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    });

    const client = createOpenAICompatClient({
      baseUrl: 'https://api.scnet.cn/api/llm/v1',
      apiKey: 'sk-test',
    });

    const models = await client.listModels();
    assert.deepEqual(models, ['openPangu-7B', 'openPangu-1B']);
  });

  it('complete extracts choices[0].message.content', async () => {
    mockFetch(async (url) => {
      if (url.includes('/chat/completions')) {
        return {
          ok: true,
          json: {
            choices: [{ message: { content: 'Hello from mock' } }],
          },
        };
      }
      return { ok: false };
    });

    const client = createOpenAICompatClient({
      baseUrl: 'https://api.scnet.cn/api/llm/v1',
      apiKey: 'sk-test',
    });

    const out = await client.complete('hi', { model: 'openPangu-7B' });
    assert.equal(out, 'Hello from mock');
  });

  it('non-200 throws with status', async () => {
    mockFetch(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: 'bad key',
    }));

    const client = createOpenAICompatClient({
      baseUrl: 'https://api.scnet.cn/api/llm/v1',
      apiKey: 'bad',
    });

    await assert.rejects(
      () => client.listModels(),
      (err: any) => err.status === 401
    );
  });

  it('baseUrl with/without trailing slash works', async () => {
    let seenUrls: string[] = [];
    mockFetch(async (url) => {
      seenUrls.push(url);
      return {
        ok: true,
        json: { data: [{ id: 'm1' }] },
      };
    });

    const client1 = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1/', apiKey: 'k' });
    await client1.listModels();

    const client2 = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    await client2.listModels();

    assert.ok(seenUrls.some(u => u.endsWith('/v1/models')));
    assert.ok(seenUrls.some(u => u.includes('/v1/models')));
  });
});

// ==================== P1.1: 原生 tool_calls 透传 ====================
describe('openai-compatible tool_calls passthrough (mocked)', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('complete returns structured output when message.tool_calls is present', async () => {
    mockFetch(async (url) => {
      if (url.includes('/chat/completions')) {
        return {
          ok: true,
          json: {
            choices: [{
              message: {
                content: '',
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: '{"file":"src/a.ts","content":"x=1"}',
                  },
                }],
              },
            }],
          },
        };
      }
      return { ok: false };
    });

    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out: any = await client.complete('do it', { model: 'openPangu-7B' });

    assert.equal(typeof out, 'object');
    assert.equal(out.detectedFormat, 'openai-json');
    assert.equal(out.content, '');
    assert.ok(Array.isArray(out.toolCalls) && out.toolCalls.length === 1);
    const tc = out.toolCalls[0];
    assert.equal(tc.toolName, 'write_file');
    assert.deepEqual(tc.params, [
      { name: 'file', value: 'src/a.ts' },
      { name: 'content', value: 'x=1' },
    ]);
    assert.ok(String(tc.rawBlock).includes('call_1'));
  });

  it('complete returns plain string when no tool_calls (unchanged behavior)', async () => {
    mockFetch(async () => ({
      ok: true,
      json: { choices: [{ message: { content: 'plain text' } }] },
    }));
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out = await client.complete('hi');
    assert.equal(out, 'plain text');
  });

  it('custom headers from config are merged into requests', async () => {
    let seenHeaders: Record<string, string> = {};
    mockFetch(async (url, init) => {
      seenHeaders = (init?.headers || {}) as Record<string, string>;
      return { ok: true, json: { choices: [{ message: { content: 'ok' } }] } };
    });

    const client = createOpenAICompatClient({
      baseUrl: 'https://ex.com/v1',
      apiKey: 'k',
      headers: { 'X-Gateway-Route': 'mindie-a' },
    });
    await client.complete('hi');

    assert.equal(seenHeaders['X-Gateway-Route'], 'mindie-a');
    assert.equal(seenHeaders['Authorization'], 'Bearer k');
  });

  it('convertOpenAIToolCalls tolerates malformed arguments', async () => {
    const { convertOpenAIToolCalls } = await import('../../src/model/openai-compatible.js');
    const out = convertOpenAIToolCalls([
      { function: { name: 'bash', arguments: '{not-json' } },
      { function: { name: 't2', arguments: '' } },
      { no_function: true },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].params, [{ name: 'args', value: '{not-json' }]);
    assert.deepEqual(out[1].params, []);
  });

  // ── 包D 修复：有 choices 但无 content/text/tool_calls 时，不把原始响应
  // JSON 当模型话语灌上下文——返回带明确标记的空回复占位 ──
  it('合法空 choices 响应 → 占位标记而非原始 JSON（包D修复）', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return {
        ok: true,
        json: {
          id: 'chatcmpl-SECRETID',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 0 },
        },
      };
    });
    const client = createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
    const out = await client.complete('hi');
    assert.equal(
      out,
      '[模型返回空回复 finish_reason=stop]',
      `got: ${JSON.stringify(out)}`
    );
    assert.ok(!String(out).includes('chatcmpl-SECRETID'), '原始响应字段不得当模型话语返回');
    assert.ok(!String(out).includes('"id"'), '不得 stringified 原始 JSON');
    assert.equal(calls, 1, '可识别形状（有 choices）不触发 EMPTY_RESPONSE 重试');
  });
});
