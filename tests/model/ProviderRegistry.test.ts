// tests/model/ProviderRegistry.test.ts
// Unit tests for ProviderRegistry (no real network, we mock the inner client creation).

import { describe, it, beforeEach } from 'node:test';
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
          models: ['glm-4-plus', 'glm-4-long'],
          modelContexts: { 'glm-4-plus': 128000 },
        },
      },
    });

    const models = await reg.listModels('scnet');
    assert.deepEqual(models, ['glm-4-plus', 'glm-4-long']);

    const withCtx = await reg.listModelsWithContext('scnet');
    assert.ok(withCtx);
    assert.equal(withCtx![0].id, 'glm-4-plus');
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
