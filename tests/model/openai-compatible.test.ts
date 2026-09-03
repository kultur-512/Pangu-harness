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
              { id: 'glm-4-plus' },
              { id: 'glm-4-long' },
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
    assert.deepEqual(models, ['glm-4-plus', 'glm-4-long']);
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

    const out = await client.complete('hi', { model: 'glm-4-plus' });
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
