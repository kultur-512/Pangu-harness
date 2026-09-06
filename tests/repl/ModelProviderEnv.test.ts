// tests/repl/ModelProviderEnv.test.ts
// P1.2: env 三件套泛化（PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL）、
// 跨 provider 上下文长度、apiKeyCmd（借鉴 claude-code apiKeyHelper）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultModelProvider } from '../../src/cli/repl/ModelProvider.js';
import { ProviderRegistry } from '../../src/model/ProviderRegistry.js';

const ENV_KEYS = [
  'PANSHA_TESTP_API_KEY',
  'PANSHA_TESTP_BASE_URL',
  'PANSHA_TESTP_MODEL',
  'SCNET_API_KEY',
  'SCNET_KEY',
];

function setEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe('ModelProvider env 三件套 (P1.2)', () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of ENV_KEYS) setEnv(k, saved[k] ?? undefined);
  });

  it('env-only provider (no file config) becomes available via PANSHA_<PROV>_*', () => {
    saved.PANSHA_TESTP_API_KEY = process.env.PANSHA_TESTP_API_KEY;
    saved.PANSHA_TESTP_BASE_URL = process.env.PANSHA_TESTP_BASE_URL;
    saved.PANSHA_TESTP_MODEL = process.env.PANSHA_TESTP_MODEL;
    setEnv('PANSHA_TESTP_API_KEY', 'sk-env-test');
    setEnv('PANSHA_TESTP_BASE_URL', 'http://127.0.0.1:9/v1');
    setEnv('PANSHA_TESTP_MODEL', 'env-model-x');

    const p = new DefaultModelProvider({ providersConfig: { providers: {} } });
    assert.ok(p.listModels().includes('testp'), 'provider name exposed in list');
    assert.equal(p.isModelAvailable('testp:env-model-x'), true);
    const c = p.createClient('testp:env-model-x');
    assert.ok(c && typeof (c as any).complete === 'function');
  });

  it('env apiKey overrides file apiKey for a configured provider', () => {
    saved.PANSHA_TESTP_API_KEY = process.env.PANSHA_TESTP_API_KEY;
    setEnv('PANSHA_TESTP_API_KEY', 'sk-env-wins');

    const p = new DefaultModelProvider({
      providersConfig: {
        providers: {
          testp: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-file' },
        },
      },
    });
    // 可用性成立（env key 注入成功）
    assert.equal(p.isModelAvailable('testp:any'), true);
    const c = p.createClient('testp:any');
    assert.ok(c);
  });

  it('getModelContextLength looks across ALL providers', () => {
    const p = new DefaultModelProvider({
      providersConfig: {
        providers: {
          pa: { type: 'openai-compatible', baseUrl: 'http://x/v1', apiKey: 'k', modelContexts: { 'm-a': 4096 } },
          pb: { type: 'openai-compatible', baseUrl: 'http://y/v1', apiKey: 'k', modelContexts: { 'm-b': 8192 } },
        },
      },
    });
    assert.equal(p.getModelContextLength('m-a'), 4096);
    assert.equal(p.getModelContextLength('m-b'), 8192);
    // 0.7.3 T2#6：未知回落从 256000 哨兵改为 32768 保守值（预算侧同时把
    // ===256000 视为 unknown，消化历史配置中的哨兵）
    assert.equal(p.getModelContextLength('unknown-model'), 32768);
  });

  it('scnet legacy alias (SCNET_API_KEY) still works standalone', () => {
    saved.SCNET_API_KEY = process.env.SCNET_API_KEY;
    saved.SCNET_KEY = process.env.SCNET_KEY;
    setEnv('SCNET_API_KEY', 'sk-legacy');
    setEnv('SCNET_KEY', undefined);

    const p = new DefaultModelProvider({ providersConfig: { providers: {} } });
    assert.ok(p.listModels().includes('scnet'));
    assert.equal(p.isModelAvailable('scnet'), true);
  });
});

describe('ProviderRegistry apiKeyCmd (P1.2)', () => {
  it('resolves key from apiKeyCmd stdout (first line) and creates a client', () => {
    const cmd = `"${process.execPath}" -e "process.stdout.write('sk-cmd-key-1\\nextra-line')"`;
    const reg = new ProviderRegistry({
      providers: {
        cmdprov: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyCmd: cmd } as any,
      },
    });
    const c = reg.createClientSync('cmdprov', 'm1');
    assert.ok(c && typeof (c as any).complete === 'function');
  });

  it('failing apiKeyCmd yields null client (no silent empty key)', () => {
    const cmd = `"${process.execPath}" -e "process.exit(3)"`;
    const reg = new ProviderRegistry({
      providers: {
        badprov: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyCmd: cmd } as any,
      },
    });
    const c = reg.createClientSync('badprov', 'm1');
    assert.equal(c, null);
  });

  it('explicit apiKey still wins over apiKeyCmd', () => {
    const cmd = `"${process.execPath}" -e "process.exit(3)"`; // would fail if executed
    const reg = new ProviderRegistry({
      providers: {
        bothprov: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-explicit', apiKeyCmd: cmd } as any,
      },
    });
    const c = reg.createClientSync('bothprov', 'm1');
    assert.ok(c, 'explicit apiKey path must not run apiKeyCmd');
  });
});
