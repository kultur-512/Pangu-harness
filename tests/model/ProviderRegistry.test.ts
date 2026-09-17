// tests/model/ProviderRegistry.test.ts
// Unit tests for ProviderRegistry (no real network, we mock the inner client creation).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../src/model/ProviderRegistry.js';

describe('ProviderRegistry', () => {
  it('isProviderConfigured returns false when no config', () => {
    const reg = new ProviderRegistry({});
    assert.equal(reg.isProviderConfigured('scnet'), false);
    assert.equal(reg.isProviderConfigured('ghost'), false);
  });

  it('createClient returns null when provider not configured', async () => {
    const reg = new ProviderRegistry({});
    const c = await reg.createClient('scnet');
    assert.equal(c, null);
  });

  it('listModels returns config models if present (no network)', async () => {
    const reg = new ProviderRegistry({
      providers: {
        scnet: {
          type: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-xxx',
          models: ['openPangu-7B', 'openPangu-1B'],
          modelContexts: { 'openPangu-7B': 128000 },
        },
      },
    });

    const models = await reg.listModels('scnet');
    assert.deepEqual(models, ['openPangu-7B', 'openPangu-1B']);

    const withCtx = await reg.listModelsWithContext('scnet');
    assert.ok(withCtx);
    assert.equal(withCtx![0].id, 'openPangu-7B');
    assert.equal(withCtx![0].contextLength, 128000);
    assert.equal(withCtx![1].contextLength, 256000); // default
  });

  it('createClientSync binds the model and returns a callable client when configured', async () => {
    // We cannot easily mock the inner fetch here without more setup,
    // but we can at least verify it constructs without throwing and returns something with complete.
    const reg = new ProviderRegistry({
      providers: {
        scnet: {
          type: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-xxx',
          models: ['test-model'],
        },
      },
      model: 'test-model',
    });

    const client = reg.createClientSync('scnet');
    assert.ok(client);
    assert.equal(typeof (client as any).complete, 'function');
  });
});

// ── 包D 修复：provider 前缀剥离此前只在 !effectiveModel（config.model）分支做，
// 显式 modelName 路径不剥——createClientSync('openpangu','openpangu:openPangu-7B')
// 会把整串路由串发网关。统一抽 stripProviderPrefix 在所有出口剥离。──
describe('ProviderRegistry provider 前缀剥离（包D修复）', () => {
  const origFetch = (globalThis as any).fetch;
  beforeEach(() => { (globalThis as any).fetch = undefined; });
  afterEach(() => { (globalThis as any).fetch = origFetch; });

  function makeRegistry() {
    return new ProviderRegistry({
      providers: {
        openpangu: {
          type: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-xxx',
          models: ['openPangu-7B'],
        },
      },
      model: 'openpangu:openPangu-7B',
    });
  }

  /** 替换 global fetch 捕获请求体里的 model 字段 */
  function captureModelOnFetch(): { seen: () => string | undefined } {
    let captured: string | undefined;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      let body: any = {};
      try { body = JSON.parse(init?.body ?? '{}'); } catch {}
      captured = body.model;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as any;
    };
    return { seen: () => captured };
  }

  it('显式 modelName 带前缀 → 剥离后才发网关（此前整串直达）', async () => {
    const cap = captureModelOnFetch();
    const client = makeRegistry().createClientSync('openpangu', 'openpangu:openPangu-7B');
    assert.ok(client);
    await client!.complete('hi');
    assert.equal(
      cap.seen(), 'openPangu-7B',
      `显式 modelName 的 provider 前缀必须剥离，got: ${cap.seen()}`
    );
  });

  it('config.model 路由串（无显式 modelName）→ 同样剥离（行为保持）', async () => {
    const cap = captureModelOnFetch();
    const client = makeRegistry().createClientSync('openpangu');
    assert.ok(client);
    await client!.complete('hi');
    assert.equal(cap.seen(), 'openPangu-7B');
  });

  it('无前缀 modelName 原样透传；全空 → default 兜底', async () => {
    const cap = captureModelOnFetch();
    const reg = new ProviderRegistry({
      providers: {
        openpangu: { type: 'openai-compatible', baseUrl: 'https://example.com/v1', apiKey: 'sk-xxx' },
      },
    });
    const c1 = reg.createClientSync('openpangu', 'openPangu-7B');
    await c1!.complete('hi');
    assert.equal(cap.seen(), 'openPangu-7B', '无前缀 modelName 不得被改写');

    const c2 = reg.createClientSync('openpangu');
    await c2!.complete('hi');
    assert.equal(cap.seen(), 'default', '无任何模型信息 → default 兜底');
  });
});
