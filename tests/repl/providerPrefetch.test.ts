// tests/repl/providerPrefetch.test.ts
// fix-rich-local-cmds ②: startup prefetch fills empty provider models arrays
// in .panshalach.json, preserving ALL other fields (apiKey/baseUrl/type), with a
// hard per-provider timeout and silent offline skip.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prefetchProviderModels } from '../../src/cli/repl/providerPrefetch.js';
import { ProviderRegistry } from '../../src/model/ProviderRegistry.js';

let ws: string;

function writeConfig(cfg: any) {
  fs.writeFileSync(path.join(ws, '.panshalach.json'), JSON.stringify(cfg, null, 2), 'utf-8');
}
function readConfig(): any {
  return JSON.parse(fs.readFileSync(path.join(ws, '.panshalach.json'), 'utf-8'));
}

describe('prefetchProviderModels (fix-rich-local-cmds ②)', () => {
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-prefetch-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('fills empty models arrays and preserves apiKey/baseUrl/type', async () => {
    writeConfig({
      providers: {
        scnet: { type: 'openai-compatible', baseUrl: 'http://scnet.test/v1', apiKey: 'sk-secret-a', models: [], modelContexts: {} },
        a6: { type: 'openai-compatible', baseUrl: 'http://a6.test/v1', apiKey: 'sk-secret-b', models: ['keep-me'], modelContexts: {} },
      },
    });

    // mock ProviderRegistry.listModels at the module level via the real
    // registry is hard (network) — instead stub global fetch so
    // reg.listModels(name) resolves from a fake /models endpoint.
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      const u = String(url);
      if (u.includes('scnet.test')) return { ok: true, json: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }) } as any;
      return { ok: true, json: async () => ({ data: [] }) } as any;
    };
    try {
      const changed = await prefetchProviderModels(ws);
      assert.equal(changed, true, 'must have updated the config');
      const cfg = readConfig();
      // scnet models filled
      assert.deepEqual(cfg.providers.scnet.models, ['m1', 'm2']);
      // apiKey/baseUrl/type preserved
      assert.equal(cfg.providers.scnet.apiKey, 'sk-secret-a');
      assert.equal(cfg.providers.scnet.baseUrl, 'http://scnet.test/v1');
      assert.equal(cfg.providers.scnet.type, 'openai-compatible');
      // non-empty provider untouched
      assert.deepEqual(cfg.providers.a6.models, ['keep-me']);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('no-op when all providers already have models or config missing', async () => {
    writeConfig({ providers: { a6: { type: 'x', baseUrl: 'y', apiKey: 'k', models: ['m1'] } } });
    assert.equal(await prefetchProviderModels(ws), false);
    fs.rmSync(path.join(ws, '.panshalach.json'));
    assert.equal(await prefetchProviderModels(ws), false);
  });

  it('offline/slow fetch → silent skip (file unchanged)', async () => {
    writeConfig({ providers: { down: { type: 'x', baseUrl: 'http://down.test/v1', apiKey: 'k', models: [] } } });
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error('offline'); };
    try {
      assert.equal(await prefetchProviderModels(ws), false);
      const cfg = readConfig();
      assert.deepEqual(cfg.providers.down.models, []);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  // S5: the write-back must merge over the CURRENT file, not the stale
  // in-memory snapshot — a concurrent edit (e.g. user saved a new key while
  // the prefetch was in flight) must survive, and no torn file may remain.
  it('preserves concurrent edits made while the fetch was in flight (S5)', async () => {
    writeConfig({
      providers: {
        scnet: { type: 'openai-compatible', baseUrl: 'http://scnet.test/v1', apiKey: 'sk-old', models: [], modelContexts: {} },
      },
    });

    const realFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as any).fetch = async () => {
      await gate; // hold the fetch so the test can edit the file mid-flight
      return { ok: true, json: async () => ({ data: [{ id: 'm1' }] }) } as any;
    };

    const runPromise = prefetchProviderModels(ws);
    // While the fetch is pending, simulate a concurrent user edit:
    // rotate the scnet key AND add a brand-new provider.
    await new Promise((r) => setTimeout(r, 20));
    writeConfig({
      providers: {
        scnet: { type: 'openai-compatible', baseUrl: 'http://scnet.test/v1', apiKey: 'sk-rotated', models: [], modelContexts: {} },
        newprov: { type: 'openai-compatible', baseUrl: 'http://new.test/v1', apiKey: 'sk-new', models: [] },
      },
    });
    release();
    try {
      const changed = await runPromise;
      assert.equal(changed, true);
      const cfg = readConfig();
      // Fetch result merged in for scnet.
      assert.deepEqual(cfg.providers.scnet.models, ['m1']);
      // Concurrent key rotation preserved (not clobbered by stale snapshot).
      assert.equal(cfg.providers.scnet.apiKey, 'sk-rotated');
      // Brand-new concurrent provider preserved.
      assert.equal(cfg.providers.newprov.apiKey, 'sk-new');
      assert.deepEqual(cfg.providers.newprov.models, []);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('skips the write entirely when the file is unreadable mid-flight (S5)', async () => {
    writeConfig({ providers: { scnet: { type: 'x', baseUrl: 'http://scnet.test/v1', apiKey: 'k', models: [] } } });
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'm1' }] }) }) as any;
    try {
      // Delete the file while the fetch is pending → mergeCurrentConfig must
      // return null and the prefetch must report no change (never resurrect
      // the config from the stale snapshot).
      const runPromise = prefetchProviderModels(ws);
      await new Promise((r) => setTimeout(r, 20));
      fs.rmSync(path.join(ws, '.panshalach.json'));
      const changed = await runPromise;
      assert.equal(changed, false);
      assert.equal(fs.existsSync(path.join(ws, '.panshalach.json')), false, 'must not recreate the deleted file');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});
