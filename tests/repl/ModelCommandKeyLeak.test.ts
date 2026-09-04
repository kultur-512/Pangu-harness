// tests/repl/ModelCommandKeyLeak.test.ts
// S1 (security): /model list must NEVER surface key material to the terminal —
// no raw snippets, no masked key echo, no [scnet-debug]/[scnet-raw] output.
// Regression: the old SUPER DEFENSIVE regex block printed the file snippet
// (including apiKey) and an "extracted key" line.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ModelCommand from '../../src/cli/repl/commands/ModelCommand.js';
import type { CommandContext } from '../../src/cli/repl/types.js';

const FAKE_KEY = 'sk-tp-SUPER-SECRET-KEY-VALUE-1234567890';

function makeCtx(ws: string): CommandContext {
  const session: any = {
    id: 'test-session',
    tier: 'high',
    workspace: ws,
    model: 'default',
    provider: undefined,
    turns: [],
    addTurn() {},
    updateModel() {},
  };
  const outputs: string[] = [];
  const renderer: any = {
    write: () => {},
    writeLine: (t: string) => { outputs.push(String(t)); },
    color: (t: string) => t,
    startSpinner: () => ({ stop() {}, text() {} }),
    table() {}, codeBlock() {},
    error() {}, warn() {}, success() {}, info() {}, clearScreen() {}, stream() {},
  };
  const provider: any = {
    defaultModel: 'default',
    listModels: () => [],
    isModelAvailable: () => false,
    invalidateProviderCache: () => {},
    forceScnetConfig: () => {},
    adoptRemoteModels: () => {},
    listProviderModels: async () => null,
    listProviderModelsWithContext: async () => null,
  };
  const ctx = {
    session,
    registry: {},
    renderer,
    input: { read: async () => '', pause() {}, resume() {}, close() {}, on() {}, history: [] },
    repl: {},
    provider,
  } as any;
  (ctx as any).__outputs = outputs;
  return ctx as CommandContext;
}

describe('S1 /model list key-leak regression', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'pangu-s1-'));
  });

  afterEach(() => {
    try { rmSync(ws, { recursive: true, force: true }); } catch {}
  });

  it('never prints key material when the workspace config contains a key', async () => {
    // Workspace with a config that DOES contain a scnet key (worst case).
    writeFileSync(join(ws, '.panshalach.json'), JSON.stringify({
      model: 'GLM-5.1',
      providers: {
        scnet: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1', // unreachable -> fast failure, no network
          apiKey: FAKE_KEY,
        },
      },
    }), 'utf-8');

    const ctx = makeCtx(ws) as any;
    await ModelCommand.execute(ctx, ['list']);

    const joined = ctx.__outputs.join('\n');
    // The raw key must never appear anywhere in the terminal output.
    assert.ok(!joined.includes(FAKE_KEY), 'raw key leaked into /model list output');
    // Legacy debug prefixes / diagnostics are gone.
    assert.ok(!joined.includes('[scnet-debug]'), 'legacy [scnet-debug] output still present');
    assert.ok(!joined.includes('[scnet-raw]'), 'legacy [scnet-raw] output still present');
    assert.ok(!joined.includes('extracted key'), 'legacy "extracted key" diagnostic still present');
    assert.ok(!joined.includes('file snippet'), 'legacy file snippet diagnostic still present');
    // No masked echo of the configured key (the old "sk-tp-abc…wxyz" line).
    assert.ok(!joined.includes('sk-tp-') || joined.includes('sk-tp-你的密钥'),
      'key-shaped material (other than the help placeholder) leaked into /model list output');
    // Diagnostics still give a TYPE-level hint (not the content).
    assert.ok(joined.includes('诊断') || joined.includes('最后错误') || joined.includes('未能'),
      'expected a type-level diagnostic message');
  });

  it('never prints key material even when the config file is malformed', async () => {
    // Malformed JSON that still contains the raw key text (worst case for
    // the old regex/snippet probe).
    writeFileSync(join(ws, '.panshalach.json'),
      `{ "providers": { "scnet": { "apiKey": "${FAKE_KEY}", `,
      'utf-8');

    const ctx = makeCtx(ws) as any;
    await ModelCommand.execute(ctx, ['list']);

    const joined = ctx.__outputs.join('\n');
    assert.ok(!joined.includes(FAKE_KEY), 'raw key leaked into output for malformed config');
    assert.ok(!joined.includes('file snippet'), 'snippet diagnostic still present for malformed config');
    assert.ok(!joined.includes('extracted key'), 'extracted-key diagnostic still present for malformed config');
    assert.ok(!joined.includes('[scnet-debug]'), 'legacy [scnet-debug] output still present for malformed config');
  });

  it('leaves no global state behind (S2 regression)', async () => {
    writeFileSync(join(ws, '.panshalach.json'), JSON.stringify({
      providers: { scnet: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: FAKE_KEY } },
    }), 'utf-8');

    const ctx = makeCtx(ws) as any;
    await ModelCommand.execute(ctx, ['list']);

    assert.ok(!('__lastScnetListError' in globalThis),
      'globalThis.__lastScnetListError must not exist (S2: module-private only)');
  });

  it('does not write the key back into the persisted config on failure', async () => {
    writeFileSync(join(ws, '.panshalach.json'), JSON.stringify({
      providers: { scnet: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: FAKE_KEY } },
    }), 'utf-8');

    const ctx = makeCtx(ws) as any;
    await ModelCommand.execute(ctx, ['list']);

    // Failure path must not persist models (persist happens only on success).
    const p = join(ws, '.panshalach.json');
    const raw = existsSync(p) ? readFileSync(p, 'utf-8') : '';
    assert.ok(!raw.includes('"models"'), 'failed /model list persisted models list');
  });
});
