// tests/tools/executor.test.ts
// M1-2.1: executor kernel — unknown tool, alias normalization, 20k cap,
// TTY/SMOKE safety gate via engineAdapter.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolExecutor, normalizeToolName } from '../../src/tools/executor.js';
import { createEngineAdapter, SMOKE_MOCK_RESULT, isSmokeEnvironment } from '../../src/tools/engineAdapter.js';
import type { ToolContext, ToolImpl } from '../../src/tools/types.js';
import type { TierConfig } from '../../src/tiers/TierConfig.js';

let root: string;
let ctx: ToolContext;

function fakeTierConfig(): TierConfig {
  return {
    tier: 'high',
    typicalUseCase: 'test',
    maxRollouts: 1,
    maxStepsPerRollout: 5,
    critiqueFrequency: { periodicEvery: 0, onProblem: true, longNoVerifyThreshold: 0, skipFirstN: 0 },
    ironLawInjectionLevel: 'high',
    maxConsecutiveFailures: 3,
    verifyFirstBias: true,
    explorationDepth: 2,
    memoryLoadLevel: 'none',
    budgetBehavior: 'soft_limit',
    parallelRollouts: 1,
    userConfirmationRequired: false,
    isStrongMode: true,
    anchorMax: 4,
  } as unknown as TierConfig;
}

function setStdoutTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true, writable: true });
}

describe('executor', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-exec-'));
    fs.writeFileSync(path.join(root, 'f.txt'), 'content');
    ctx = { workspaceRoot: root, approvalMode: 'readonly' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('normalizes aliases case-insensitively', () => {
    assert.equal(normalizeToolName('Read'), 'read_file');
    assert.equal(normalizeToolName('READ_FILE'), 'read_file');
    assert.equal(normalizeToolName('ReadFile'), 'read_file');
    assert.equal(normalizeToolName('Glob'), 'glob');
    assert.equal(normalizeToolName('GREP'), 'grep');
  });

  it('rejects unknown tools with available list', async () => {
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('teleport', {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'UNKNOWN_TOOL');
    assert.ok(r.output.includes('可用工具'));
    assert.ok(r.output.includes('read_file'));
  });

  it('executes read via alias with 20k output cap', async () => {
    const big = 'x'.repeat(25_000);
    fs.writeFileSync(path.join(root, 'big.txt'), big);
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('Read', { file_path: 'big.txt' });
    assert.ok(r.ok);
    assert.equal(r.truncated, true);
    assert.ok(r.output.length <= 21_000);
  });

  it('applies 5s timeout to hanging file tools', { timeout: 10000 }, async () => {
    const slow: ToolImpl = async () => new Promise(() => {});
    const ex = createToolExecutor(ctx, { read_file: slow });
    const t0 = Date.now();
    const r = await ex.execute('read_file', {});
    const dt = Date.now() - t0;
    assert.equal(r.error, 'TIMEOUT');
    assert.ok(dt >= 4900 && dt < 7000, `expected ~5s, got ${dt}ms`);
  });
});

describe('engineAdapter safety gate', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-adapter-'));
    fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP-SECRET-CONTENT');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setStdoutTty(undefined);
    delete process.env.PANSHA_SMOKE;
    delete process.env.PANSHA_HEADLESS; // dogfood-① teardown
  });

  it('non-TTY environment → mock string, real file never read', async () => {
    setStdoutTty(undefined); // pipe
    delete process.env.PANSHA_SMOKE;
    assert.equal(isSmokeEnvironment(), true);

    const adapter = createEngineAdapter({ workspaceRoot: root, tierConfig: fakeTierConfig() });
    const out = await adapter.execute([
      { toolName: 'read_file', params: [{ name: 'file_path', value: 'secret.txt' }], rawBlock: '' } as any,
    ]);
    assert.equal(out, SMOKE_MOCK_RESULT);
    assert.ok(!out.includes('TOP-SECRET-CONTENT'));
  });

  it('PANSHA_SMOKE=1 forces mock even in TTY', async () => {
    setStdoutTty(true);
    process.env.PANSHA_SMOKE = '1';
    assert.equal(isSmokeEnvironment(), true);

    const adapter = createEngineAdapter({ workspaceRoot: root, tierConfig: fakeTierConfig() });
    const out = await adapter.execute([
      { toolName: 'read_file', params: [{ name: 'file_path', value: 'secret.txt' }], rawBlock: '' } as any,
    ]);
    assert.equal(out, SMOKE_MOCK_RESULT);
  });

  it('TTY + no SMOKE → real execution with READ_SUCCESS string', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
    assert.equal(isSmokeEnvironment(), false);

    const adapter = createEngineAdapter({ workspaceRoot: root, tierConfig: fakeTierConfig() });
    const out = await adapter.execute([
      { toolName: 'read_file', params: [{ name: 'file_path', value: 'secret.txt' }], rawBlock: '' } as any,
    ]);
    assert.ok(out.startsWith('READ_SUCCESS: secret.txt'));
    assert.ok(out.includes('TOP-SECRET-CONTENT'));
  });

  it('PANSHA_HEADLESS=1 opts out of mock in non-TTY (real execution) (dogfood-①)', async () => {
    setStdoutTty(undefined); // pipe (non-TTY)
    delete process.env.PANSHA_SMOKE;
    process.env.PANSHA_HEADLESS = '1';
    assert.equal(isSmokeEnvironment(), false, 'HEADLESS must escape the isTTY gate');

    const adapter = createEngineAdapter({ workspaceRoot: root, tierConfig: fakeTierConfig() });
    const out = await adapter.execute([
      { toolName: 'read_file', params: [{ name: 'file_path', value: 'secret.txt' }], rawBlock: '' } as any,
    ]);
    assert.ok(out.startsWith('READ_SUCCESS: secret.txt'), `expected real execution, got: ${out.slice(0, 40)}`);
    assert.ok(out.includes('TOP-SECRET-CONTENT'));
  });

  it('PANSHA_SMOKE=1 still forces mock even with PANSHA_HEADLESS=1 (dogfood-①)', async () => {
    process.env.PANSHA_HEADLESS = '1';
    process.env.PANSHA_SMOKE = '1';
    assert.equal(isSmokeEnvironment(), true, 'SMOKE must win over HEADLESS');
  });

  it('unset both + non-TTY → mock (default unchanged) (dogfood-①)', async () => {
    delete process.env.PANSHA_HEADLESS;
    delete process.env.PANSHA_SMOKE;
    setStdoutTty(undefined);
    assert.equal(isSmokeEnvironment(), true, 'default non-TTY must stay mock');
  });

  it('HEADLESS flag only escapes mock when explicitly set — TTY+SMOKE unset still real (dogfood-①)', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_HEADLESS;
    delete process.env.PANSHA_SMOKE;
    assert.equal(isSmokeEnvironment(), false);
  });

  // ==================== fix-#9-②: UNKNOWN_TOOL runtime guard ====================

  it('UNKNOWN_TOOL returns error code + available list (fix-#9-②)', async () => {
    const exec = createToolExecutor({ workspaceRoot: root, approvalMode: 'full', signal: undefined } as any);
    const r = await exec.execute('iron_law_check', {});
    assert.equal(r.error, 'UNKNOWN_TOOL');
    assert.ok(r.output.includes('可用工具'));
    assert.ok(r.output.includes('iron_law_check'));
  });

  it('adapter records UNKNOWN_TOOL to failureMemory + adds intent guidance (fix-#9-②)', async () => {
    setStdoutTty(true); // real path (UNKNOWN_TOOL only reachable outside mock)
    delete process.env.PANSHA_SMOKE;
    const records: string[] = [];
    const mockFM = {
      record(cat: string, desc: string) { records.push(`${cat}:${desc}`); },
    } as any;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      failureMemory: mockFM,
    });
    const out = await adapter.execute([
      { toolName: 'iron_law_check', params: [], rawBlock: '' } as any,
    ]);
    assert.ok(out.includes('请用 read_file'), 'must add intent→tool guidance');
    assert.equal(records.length, 1, 'must record to failureMemory');
    assert.ok(records[0].startsWith('TOOL_FORMAT_ERROR:'), `category must be TOOL_FORMAT_ERROR, got ${records[0]}`);
    assert.ok(records[0].includes('iron_law_check'));
  });

  it('3 consecutive UNKNOWN_TOOL → hard guidance to stop guessing (fix-#9-②)', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
    const adapter = createEngineAdapter({ workspaceRoot: root, tierConfig: fakeTierConfig() });
    const mk = (name: string) => [{ toolName: name, params: [], rawBlock: '' } as any];

    const o1 = await adapter.execute(mk('iron_law_check'));
    assert.ok(!o1.includes('停止猜测工具名'), 'single unknown: guidance only, no hard stop');
    const o2 = await adapter.execute(mk('thinking'));
    assert.ok(!o2.includes('停止猜测工具名'));
    const o3 = await adapter.execute(mk('plan'));
    assert.ok(o3.includes('停止猜测工具名'), '3rd consecutive unknown must hard-stop');
    // a known tool resets the drift streak
    await adapter.execute([{ toolName: 'read_file', params: [{ name: 'file_path', value: 'f.txt' }], rawBlock: '' } as any]);
    const o4 = await adapter.execute(mk('critique'));
    assert.ok(!o4.includes('停止猜测工具名'), 'streak resets after a known tool');
  });

  it('formats unknown tool errors as TOOL_ERROR', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
    const adapter = createEngineAdapter({ workspaceRoot: root, tierConfig: fakeTierConfig() });
    const out = await adapter.execute([
      { toolName: 'make_coffee', params: [], rawBlock: '' } as any,
    ]);
    assert.ok(out.startsWith('TOOL_ERROR: UNKNOWN_TOOL'));
    assert.ok(out.includes('可用工具'));
  });

  it('emits tools/pre-execute + tools/post-execute events (P1-T16)', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
    const events: any[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      emitEvent: (e: any) => events.push(e),
    });
    await adapter.execute([
      { toolName: 'read_file', params: [{ name: 'file_path', value: 'f.txt' }], rawBlock: '' } as any,
    ]);
    const pre = events.find((e) => e.type === 'tools/pre-execute');
    const post = events.find((e) => e.type === 'tools/post-execute');
    assert.ok(pre, 'pre-execute emitted');
    assert.equal(pre.tool, 'read_file');
    assert.ok(pre.params, 'params attached');
    assert.ok(post, 'post-execute emitted');
    assert.equal(post.tool, 'read_file');
    assert.equal(typeof post.durationMs, 'number');
    assert.equal(typeof post.ok, 'boolean');
  });

  it('T-27: MCP always-allow unlocks only that tool (full name), never bash', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
    let approvals = 0;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'default' as any, // 默认档：MCP 需审批 → 验证 'a' 决策按全名放行
      mcpTools: [{ name: 'mcp_srv_read', description: 'read', call: async () => ({ ok: true, output: 'ok' }) }],
      approvalBridge: async () => { approvals++; return 'a'; },
    });
    const callMCP = { toolName: 'mcp_srv_read', params: [], rawBlock: '' } as any;
    await adapter.execute([callMCP]); // 1st → approval 'a'
    assert.equal(approvals, 1, 'first MCP call needs approval');
    await adapter.execute([callMCP]); // 2nd → allowlisted by full name
    assert.equal(approvals, 1, 'second MCP call is allowlisted');
    await adapter.execute([{ toolName: 'bash', params: [{ name: 'command', value: 'rm -rf x' }], rawBlock: '' } as any]);
    assert.equal(approvals, 2, 'bash remains gated after MCP always-allow');
  });

  it('T-27: readonly mode still denies MCP tools (classify fallback preserved)', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'readonly' as any,
      mcpTools: [{ name: 'mcp_srv_read', description: 'read', call: async () => ({ ok: true, output: 'ok' }) }],
    });
    const out = await adapter.execute([{ toolName: 'mcp_srv_read', params: [], rawBlock: '' } as any]);
    assert.ok(out.includes('DENIED'), 'MCP denied in readonly');
  });

  // B1 (review defect): the six-tier contract must give write tools to
  // high/max/ex/pangu — 'max' was missing (isStrongMode + all-write confirm).
  it('registers write/edit tools for high/max/ex/pangu but NOT quick/standard (B1)', async () => {
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;

    for (const tier of ['high', 'max', 'ex', 'pangu'] as const) {
      const adapter = createEngineAdapter({
        workspaceRoot: root,
        tierConfig: { ...fakeTierConfig(), tier } as unknown as TierConfig,
      });
      const tools = adapter.executor.availableTools();
      assert.ok(tools.includes('write_file'), `${tier}: write_file missing`);
      assert.ok(tools.includes('edit_file'), `${tier}: edit_file missing`);
    }

    for (const tier of ['quick', 'standard'] as const) {
      const adapter = createEngineAdapter({
        workspaceRoot: root,
        tierConfig: { ...fakeTierConfig(), tier } as unknown as TierConfig,
      });
      const tools = adapter.executor.availableTools();
      assert.ok(!tools.includes('write_file'), `${tier}: write_file must NOT be present`);
      assert.ok(!tools.includes('edit_file'), `${tier}: edit_file must NOT be present`);
    }
  });
});
