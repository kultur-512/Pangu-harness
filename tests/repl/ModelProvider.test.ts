// tests/repl/ModelProvider.test.ts
// P3: ModelProvider tests (per ModelProvider blueprint acceptance)
// Covers:
// - listModels contains default + registered
// - isModelAvailable for default (with/without fallback) and unknown
// - createClient('default') with fallback returns callable client; without -> null
// - createClient(unknown) -> null
// - createDefaultClient fallback chain (explicit default > 'default' > fallback > null)

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultModelProvider, createDefaultModelProvider } from '../../src/cli/repl/ModelProvider.js';
import { Session } from '../../src/cli/repl/Session.js';
import { applyEnvModel } from '../../src/cli/repl.js';
import type { ModelClient, ModelProvider } from '../../src/cli/repl/types.js';

describe('P3 ModelProvider (DefaultModelProvider)', () => {
  it('listModels includes default and registered names', () => {
    const p = createDefaultModelProvider();
    p.register('maoyulin', () => ({ async complete() { return 'ok'; } } as ModelClient));
    const list = p.listModels();
    assert.ok(list.includes('default'));
    assert.ok(list.includes('maoyulin'));
  });

  it('isModelAvailable("default") is false when no fallback', () => {
    const p = createDefaultModelProvider(); // no fallback
    assert.equal(p.isModelAvailable('default'), false);
    assert.equal(p.isModelAvailable('nonexistent'), false);
  });

  it('createClient("default") returns callable client when fallback provided', async () => {
    const fb = async (prompt: string) => 'FB:' + prompt.slice(0, 10);
    const p = createDefaultModelProvider({ fallbackComplete: fb });
    const c = p.createClient('default');
    assert.ok(c && typeof c.complete === 'function');
    const out = await c!.complete('hello world');
    assert.equal(out, 'FB:hello worl');
  });

  it('createClient("default") returns null when no fallback (and no provider configured)', () => {
    // fix: 'default' now falls through to provider routing — with an explicit
    // EMPTY providersConfig (hermetic) nothing is configured → null.
    const p = createDefaultModelProvider({
      providersConfig: { providers: {} },
    });
    const c = p.createClient('default');
    assert.equal(c, null);
  });

  it('createClient(unknown name) returns null', () => {
    // M2.5: explicit empty providersConfig = authoritative & offline —
    // the provider must NOT discover .zorge.json from the filesystem.
    const p = createDefaultModelProvider({
      fallbackComplete: async () => 'x',
      providersConfig: { providers: {} },
    });
    const c = p.createClient('ghost');
    assert.equal(c, null);
  });

  it('createDefaultClient prefers explicit defaultModel when resolvable', async () => {
    const p = createDefaultModelProvider({ defaultModel: 'maoyulin' });
    p.register('maoyulin', () => ({ async complete() { return 'MAO'; } } as ModelClient));
    const c = p.createDefaultClient();
    assert.ok(c);
    const out = await c!.complete('p');
    assert.equal(out, 'MAO');
  });

  it('createDefaultClient falls back to fallbackComplete when default not registered', async () => {
    const fb = async () => 'FALLBACK';
    const p = createDefaultModelProvider({ fallbackComplete: fb });
    const c = p.createDefaultClient();
    assert.ok(c);
    const out = await c!.complete('anything');
    assert.equal(out, 'FALLBACK');
  });

  it('createDefaultClient returns null when nothing available', () => {
    // M2.5: authoritative empty config → no scnet fallback from ambient config
    const p = createDefaultModelProvider({
      providersConfig: { providers: {} },
    });
    const c = p.createDefaultClient();
    assert.equal(c, null);
  });

  it('listProviderModels works fully offline with mocked fetch (禁网纪律)', async () => {
    // M2.5: network is forbidden in tests — mock globalThis.fetch for the
    // one path that would otherwise hit the wire (ProviderRegistry.listModels).
    const realFetch = globalThis.fetch;
    let calledUrl = '';
    (globalThis as any).fetch = async (url: any) => {
      calledUrl = String(url);
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }),
      } as any;
    };
    try {
      const p = createDefaultModelProvider({
        providersConfig: {
          providers: {
            scnet: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-offline' },
          },
        },
      });
      const models = await p.listProviderModels!('scnet');
      assert.deepEqual(models, ['mock-model-a', 'mock-model-b']);
      assert.ok(calledUrl.includes('/models'), 'must call the models endpoint of the mock');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('registered factory returning null is treated as unavailable', () => {
    const p = createDefaultModelProvider();
    p.register('broken', () => null);
    assert.equal(p.isModelAvailable('broken'), false);
    assert.equal(p.createClient('broken'), null);
  });

  // ============ fix-a6-routing: generic provider:model routing ============

  function mockFetchCapturing(): { urls: string[]; restore: () => void } {
    const real = globalThis.fetch;
    const urls: string[] = [];
    (globalThis as any).fetch = async (url: any) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'mock-reply' } }] }),
        text: async () => JSON.stringify({ choices: [{ message: { content: 'mock-reply' } }] }),
      } as any;
    };
    return { urls, restore: () => { (globalThis as any).fetch = real; } };
  }

  it('createClient("a6:glm-5.3-flash") routes to the a6 provider (fix-a6-routing)', async () => {
    const mock = mockFetchCapturing();
    try {
      const p = createDefaultModelProvider({
        providersConfig: {
          providers: {
            scnet: { type: 'openai-compatible', baseUrl: 'http://scnet.test/v1', apiKey: 'sk-s' },
            a6: { type: 'openai-compatible', baseUrl: 'https://api.a6api.com/v1', apiKey: 'sk-a6' },
          },
        },
      });
      const c = p.createClient('a6:glm-5.3-flash');
      assert.ok(c, 'a6-prefixed name must produce a client when a6 is configured');
      await c!.complete('hi');
      assert.ok(mock.urls.some((u) => u.includes('api.a6api.com')),
        `must hit a6 baseUrl, got: ${mock.urls.join(',')}`);
    } finally {
      mock.restore();
    }
  });

  it('scnet semantics unchanged: createClient("scnet:GLM-5.1") and bare names still route to scnet (fix-a6-routing)', async () => {
    const mock = mockFetchCapturing();
    try {
      const p = createDefaultModelProvider({
        providersConfig: {
          providers: {
            scnet: { type: 'openai-compatible', baseUrl: 'http://scnet.test/v1', apiKey: 'sk-s' },
            a6: { type: 'openai-compatible', baseUrl: 'https://api.a6api.com/v1', apiKey: 'sk-a6' },
          },
        },
      });
      // explicit scnet prefix
      const c1 = p.createClient('scnet:GLM-5.1');
      assert.ok(c1, 'scnet prefix must still work');
      await c1!.complete('hi');
      assert.ok(mock.urls.every((u) => u.includes('scnet.test')), `scnet: must NOT hit a6: ${mock.urls.join(',')}`);
      // bare name still falls to scnet (branch 4) even with a6 configured
      mock.urls.length = 0;
      const c2 = p.createClient('GLM-5.1');
      assert.ok(c2, 'bare name must still produce a client (scnet fallback)');
      await c2!.complete('hi');
      assert.ok(mock.urls.every((u) => u.includes('scnet.test')), 'bare name must route to scnet, not a6');
    } finally {
      mock.restore();
    }
  });

  it('listModels includes a6 when configured (fix-model-abc Bug A)', () => {
    const p = createDefaultModelProvider({
      providersConfig: {
        providers: {
          scnet: { type: 'openai-compatible', baseUrl: 'http://scnet.test/v1', apiKey: 'sk-s' },
          a6: { type: 'openai-compatible', baseUrl: 'https://api.a6api.com/v1', apiKey: 'sk-a6' },
        },
      },
    });
    const names = p.listModels();
    assert.ok(names.includes('a6'), `listModels must expose a6, got: ${names.join(',')}`);
    assert.ok(names.includes('scnet'), 'scnet still present');
    assert.ok(names.includes('default'), 'default still present');
  });
});

describe('ZORGE_MODEL env seed (fix-a6-routing)', () => {
  it('applyEnvModel seeds session.model from ZORGE_MODEL', () => {
    const prev = process.env.ZORGE_MODEL;
    process.env.ZORGE_MODEL = 'a6:glm-5.3-flash';
    try {
      const s = applyEnvModel(new Session());
      assert.equal(s.model, 'a6:glm-5.3-flash');
    } finally {
      if (prev === undefined) delete process.env.ZORGE_MODEL;
      else process.env.ZORGE_MODEL = prev;
    }
  });

  it('applyEnvModel leaves model untouched when env unset/blank', () => {
    const prev = process.env.ZORGE_MODEL;
    delete process.env.ZORGE_MODEL;
    try {
      const s = applyEnvModel(new Session());
      assert.equal(s.model, 'default');
    } finally {
      if (prev !== undefined) process.env.ZORGE_MODEL = prev;
    }
  });
});

// B12 (review defect): upward project-root discovery used `require('path')`
// under "type":"module" — dead code swallowed by catch, so a .zorge.json in a
// PARENT directory of cwd was never found. Fixed to ESM dirname; this test
// proves the upward walk actually reaches a parent config.
describe('B12 upward .zorge.json discovery', () => {
  it('finds a parent-directory .zorge.json from a deeper cwd', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-b12-'));
    const parent = path.join(base, 'proj');
    const child = path.join(parent, 'src', 'deep');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(parent, '.zorge.json'), JSON.stringify({
      model: 'GLM-5.1',
      providers: {
        scnet: { type: 'openai-compatible', baseUrl: 'https://api.scnet.cn/api/llm/v1', apiKey: 'sk-b12-test-key-1234567890' },
      },
    }), 'utf-8');

    const prevCwd = process.cwd();
    try {
      process.chdir(child);
      const p = createDefaultModelProvider();
      // listModels must expose scnet (registry discovered from parent config).
      const names = p.listModels();
      assert.ok(names.includes('scnet'), `parent config not discovered (names=${names.join(',')})`);
      // And a client resolves for scnet.
      const c = p.createClient('scnet');
      assert.ok(c && typeof c.complete === 'function', 'scnet client must resolve via parent config');
    } finally {
      process.chdir(prevCwd);
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    }
  });
});
