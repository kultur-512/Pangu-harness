// tests/tools/parallelSegments.test.ts
// M2-1: engineAdapter.execute(calls) 并行分段调度 —
// - 连续 read_file/glob/grep 段并发（上限 3），写/bash/MCP 进 barrier 串行段；
// - 结果按原始调用顺序回填（LoopStep.verificationResult 顺序不变）；
// - pre/post-execute 事件按原始序发射（不按完成序）；
// - 整批 420s 超时（可注入 batchTimeoutMs），未完成 call 落 TIMEOUT。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngineAdapter } from '../../src/tools/engineAdapter.js';
import type { ToolImpl } from '../../src/tools/types.js';
import type { TierConfig } from '../../src/tiers/TierConfig.js';

let root: string;

function fakeTierConfig(): TierConfig {
  return {
    tier: 'high',
    typicalUseCase: 'test',
    maxStepsPerRollout: 5,
    ironLawInjectionLevel: 'high',
    maxConsecutiveFailures: 3,
    verifyFirstBias: true,
    memoryLoadLevel: 'none',
    isStrongMode: true,
    autoPullMemory: true,
  };
}

function setStdoutTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true, writable: true });
}

function call(tool: string, params: Record<string, string>) {
  return { toolName: tool, params: Object.entries(params).map(([name, value]) => ({ name, value })), rawBlock: '' } as any;
}

/** 可控 delay 的 fake 只读工具（经 extraTools 覆盖 glob/grep），并记录时序。 */
function makeDelayed(toolName: string, delayMs: number, log: string[], marker: string): ToolImpl {
  return async () => {
    log.push(`${toolName}:start`);
    await new Promise((r) => setTimeout(r, delayMs));
    log.push(`${toolName}:end`);
    return { ok: true, output: marker, durationMs: delayMs, meta: { lines: 1 } };
  };
}

describe('M2-1 并行分段调度', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-seg-'));
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
    delete process.env.PANSHA_HEADLESS;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setStdoutTty(undefined);
    delete process.env.PANSHA_SMOKE;
    delete process.env.PANSHA_HEADLESS;
  });

  it('连续只读段并发：3 个 120ms 读总耗时 < 串行 360ms，且全部先 start 后 end', async () => {
    const log: string[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      extraTools: {
        glob: makeDelayed('g1', 120, log, 'GLOB-1'),
        grep: makeDelayed('g2', 120, log, 'GREP-2'),
      },
    });
    const t0 = Date.now();
    await adapter.execute([call('glob', { pattern: 'a' }), call('grep', { pattern: 'b' }), call('glob', { pattern: 'c' })]);
    const dt = Date.now() - t0;
    assert.ok(dt < 320, `expected concurrent (~120ms), took ${dt}ms`);
    // 一波内 3 个全部先启动、后全部结束（真并发，非流水）。
    assert.deepEqual(log.slice(0, 3), ['g1:start', 'g2:start', 'g1:start']);
    assert.deepEqual(log.slice(3), ['g1:end', 'g2:end', 'g1:end']);
  });

  it('并发上限 3：4 个读分两波（3+1），第二波在第一波结束后才开始', async () => {
    const log: string[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      extraTools: {
        glob: makeDelayed('g', 120, log, 'G'),
      },
    });
    const t0 = Date.now();
    await adapter.execute([
      call('glob', { pattern: 'a' }), call('glob', { pattern: 'b' }),
      call('glob', { pattern: 'c' }), call('glob', { pattern: 'd' }),
    ]);
    const dt = Date.now() - t0;
    assert.ok(dt >= 200 && dt < 480, `expected two waves (~240ms), took ${dt}ms`);
    // 波1：3 个 start → 3 个 end；波2：1 个 start → 1 个 end。
    assert.deepEqual(log, ['g:start', 'g:start', 'g:start', 'g:end', 'g:end', 'g:end', 'g:start', 'g:end']);
  });

  it('写 barrier：read 段 → write → read 段串行，两侧读不与写重叠', async () => {
    const log: string[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      extraTools: {
        glob: makeDelayed('g', 120, log, 'G'),
      },
    });
    await adapter.execute([
      call('glob', { pattern: 'a' }),
      call('write_file', { file_path: 'notes.txt', content: 'barrier' }),
      call('glob', { pattern: 'b' }),
    ]);
    assert.deepEqual(log, ['g:start', 'g:end', 'g:start', 'g:end'], 'reads must not span the write barrier');
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf-8'), 'barrier');
  });

  it('MCP 工具进 barrier 串行段（只读段被其隔开）', async () => {
    const readLog: string[] = [];
    const mcpLog: string[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      extraTools: { glob: makeDelayed('g', 100, readLog, 'G') },
      mcpTools: [{
        server: 'srv',
        name: 'mcp_srv_slow',
        description: 'slow mcp',
        call: async () => {
          mcpLog.push('mcp:start');
          await new Promise((r) => setTimeout(r, 150));
          mcpLog.push('mcp:end');
          return { ok: true, output: 'MCP-DONE' };
        },
      }],
    });
    await adapter.execute([
      call('glob', { pattern: 'a' }),
      call('mcp_srv_slow', {}),
      call('glob', { pattern: 'b' }),
    ]);
    assert.deepEqual(readLog, ['g:start', 'g:end', 'g:start', 'g:end'], 'reads must not overlap the MCP barrier');
    assert.deepEqual(mcpLog, ['mcp:start', 'mcp:end']);
  });

  it('结果按原始调用顺序回填（快完成的调用不抢位）', async () => {
    const log: string[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      extraTools: {
        glob: makeDelayed('g', 200, log, 'FIRST-OUTPUT'),
        grep: makeDelayed('grep', 20, log, 'SECOND-OUTPUT'),
      },
    });
    const out = await adapter.execute([
      call('glob', { pattern: 'a' }),
      call('grep', { pattern: 'b' }),
    ]);
    const iFirst = out.indexOf('FIRST-OUTPUT');
    const iSecond = out.indexOf('SECOND-OUTPUT');
    assert.ok(iFirst >= 0 && iSecond >= 0, out);
    assert.ok(iFirst < iSecond, 'glob (200ms, 后完成) 的结果必须排在 grep (20ms, 先完成) 之前');
    assert.ok(out.startsWith('GLOB_SUCCESS: 1 file(s)'), out);
    assert.ok(out.includes('GREP_SUCCESS: 1 match(es)'));
  });

  it('pre/post-execute 事件按原始序发射（不按完成序）', async () => {
    const events: any[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      emitEvent: (e: any) => events.push(e),
      extraTools: {
        glob: makeDelayed('g', 200, [], 'A'),
        grep: makeDelayed('grep', 20, [], 'B'),
      },
    });
    await adapter.execute([
      call('glob', { pattern: 'a' }),
      call('grep', { pattern: 'b' }),
      call('glob', { pattern: 'c' }),
    ]);
    const pres = events.filter((e) => e.type === 'tools/pre-execute');
    const posts = events.filter((e) => e.type === 'tools/post-execute');
    assert.deepEqual(pres.map((e) => e.tool), ['glob', 'grep', 'glob'], 'pre 事件按原始序');
    // 完成序是 grep(20ms) 先于 glob(200ms) — post 仍须原始序。
    assert.deepEqual(posts.map((e) => e.tool), ['glob', 'grep', 'glob'], 'post 事件按原始序，不按完成序');
    assert.ok(posts.every((e) => e.ok === true));
    assert.ok(posts.every((e) => typeof e.durationMs === 'number'));
  });

  it('串行段（write）事件顺序与逐 call 语义一致（pre→post 紧邻）', async () => {
    const events: any[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      emitEvent: (e: any) => events.push(e),
    });
    await adapter.execute([
      call('write_file', { file_path: 'a.txt', content: 'a' }),
      call('write_file', { file_path: 'b.txt', content: 'b' }),
    ]);
    const types = events.map((e) => `${e.type}:${e.tool}`);
    assert.deepEqual(types, [
      'tools/pre-execute:write_file',
      'tools/post-execute:write_file',
      'tools/pre-execute:write_file',
      'tools/post-execute:write_file',
    ]);
  });

  it('整批超时：未完成 call 落 TIMEOUT，已完成的保结果，且顺序不变', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      batchTimeoutMs: 150,
      extraTools: {
        glob: makeDelayed('slow-glob', 800, [], 'SLOW'),
        grep: makeDelayed('fast-grep', 20, [], 'FAST'),
      },
    });
    const t0 = Date.now();
    const out = await adapter.execute([
      call('glob', { pattern: 'a' }),
      call('grep', { pattern: 'b' }),
    ]);
    const dt = Date.now() - t0;
    assert.ok(dt < 700, `batch deadline should fire ~150ms, took ${dt}ms`);
    assert.ok(out.includes('TOOL_ERROR: TIMEOUT'), out);
    assert.ok(out.includes('FAST'), 'fast call finished before the deadline — result kept');
    const iTimeout = out.indexOf('TOOL_ERROR: TIMEOUT');
    const iFast = out.indexOf('FAST');
    assert.ok(iTimeout < iFast, '原始序：glob(超时) 段在 grep(成功) 段之前');
  });

  it('超时后未启动的段不再执行（写不进盘），全部落 TIMEOUT', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      batchTimeoutMs: 150,
      extraTools: {
        glob: makeDelayed('slow-glob', 800, [], 'SLOW'),
      },
    });
    const out = await adapter.execute([
      call('glob', { pattern: 'a' }),
      call('write_file', { file_path: 'late.txt', content: 'nope' }),
    ]);
    assert.equal(fs.existsSync(path.join(root, 'late.txt')), false, 'deadline hit — later segments must not run');
    const timeouts = out.split('\n---\n').filter((s) => s.includes('TOOL_ERROR: TIMEOUT'));
    assert.equal(timeouts.length, 2, out);
  });

  it('超时未启动 call 也补齐 pre/post 事件（配对不变）', async () => {
    const events: any[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      batchTimeoutMs: 150,
      emitEvent: (e: any) => events.push(e),
      extraTools: { glob: makeDelayed('slow-glob', 800, [], 'SLOW') },
    });
    await adapter.execute([
      call('glob', { pattern: 'a' }),
      call('grep', { pattern: 'b' }),
    ]);
    const pres = events.filter((e) => e.type === 'tools/pre-execute');
    const posts = events.filter((e) => e.type === 'tools/post-execute');
    assert.equal(pres.length, 2, 'both calls get pre');
    assert.equal(posts.length, 2, 'both calls get post');
    assert.ok(posts.some((e) => e.error === 'TIMEOUT' && e.ok === false));
  });
});
