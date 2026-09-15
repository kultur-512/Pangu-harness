// tests/tools/mcpVerificationTail.test.ts
// B5（ROADMAP-NEXT §B5）：MCP 工具结果的验证尾标策略。
//   - MCP 调用成功**不得**追加任何 VERIFICATION 尾标（宁缺毋滥：MCP 自述输出
//     没有外部退出码佐证，追加 PASS 就等于让第三方工具凭自述伪装真实验证——
//     classifySignal 的 PASS 是 completed 的唯一来源）；
//   - 关键回归：命名空间名 `mcp_<server>_<tool>` 内含 read/glob/grep 子串时
//     （如 `mcp_srv_read`）不得被 `name.includes('read')` 误判为 NEUTRAL
//     （NEUTRAL=PARTIAL，会清零连败计数、看着像部分验证）；
//   - 内置工具的尾标行为不变。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngineAdapter } from '../../src/tools/engineAdapter.js';
import type { TierConfig } from '../../src/tiers/TierConfig.js';

let root: string;

function fakeTierConfig(): TierConfig {
  return {
    tier: 'high',
    typicalUseCase: 'test',
    maxRollouts: 1,
    maxStepsPerRollout: 5,
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

/** 造一个 MCP 工具（名字可带 read/glob/grep 子串以覆盖误判回归）。 */
function mcpTool(name: string, output = 'MCP service says: 已完成') {
  return { server: 'srv', name, description: 'test mcp', call: async () => ({ ok: true, output }) };
}

function call(toolName: string, params: Record<string, string> = {}): any {
  return {
    toolName,
    params: Object.entries(params).map(([name, value]) => ({ name, value })),
    rawBlock: '',
  };
}

describe('B5：MCP 结果验证尾标策略', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-mcp-tail-'));
    fs.writeFileSync(path.join(root, 'f.txt'), 'content');
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setStdoutTty(undefined);
  });

  it('MCP 成功结果不追加任何 VERIFICATION 尾标', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      mcpTools: [mcpTool('mcp_srv_do_thing')],
    });
    const out = await adapter.execute([call('mcp_srv_do_thing')]);
    assert.ok(out.includes('已完成'), 'MCP 输出原样回灌');
    assert.ok(!/VERIFICATION:\s*(PASS|NEUTRAL|APPLIED)/.test(out), 'MCP 结果不得带任何验证尾标');
  });

  it('回归：名字含 read 子串的 MCP 工具不得被误标 NEUTRAL', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      mcpTools: [mcpTool('mcp_srv_read')],
    });
    const out = await adapter.execute([call('mcp_srv_read')]);
    assert.ok(!out.includes('VERIFICATION: NEUTRAL'), 'mcp_srv_read 不得被 name.includes("read") 误判');
    assert.ok(!/VERIFICATION:/.test(out), '任何 MCP 名形态都不得带验证尾标');
  });

  it('回归：名字含 glob/grep 子串的 MCP 工具同样不带尾标', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      mcpTools: [mcpTool('mcp_srv_glob'), mcpTool('mcp_srv_grep')],
    });
    const out = await adapter.execute([call('mcp_srv_glob'), call('mcp_srv_grep')]);
    assert.ok(!/VERIFICATION:\s*(NEUTRAL|PASS|APPLIED)/.test(out), 'glob/grep 子串 MCP 名不得带尾标');
  });

  it('内置工具尾标行为不变（bash=PASS / write=APPLIED / read=NEUTRAL）', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      mcpTools: [mcpTool('mcp_srv_read')],
    });
    const readOut = await adapter.execute([call('read_file', { file_path: path.join(root, 'f.txt') })]);
    assert.ok(readOut.includes('VERIFICATION: NEUTRAL'), '内置 read_file 仍标 NEUTRAL');

    const bashOut = await adapter.execute([call('bash', { command: 'true' })]);
    assert.ok(bashOut.includes('VERIFICATION: PASS'), '内置 bash 仍标 PASS');
  });

  it('MCP 与内置工具同批：尾标互不串扰', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
      mcpTools: [mcpTool('mcp_srv_read')],
    });
    const out = await adapter.execute([
      call('mcp_srv_read'),
      call('read_file', { file_path: path.join(root, 'f.txt') }),
    ]);
    const segments = out.split('\n---\n');
    const mcpSeg = segments.find((s) => s.startsWith('MCP_OK:'));
    const readSeg = segments.find((s) => s.startsWith('READ_SUCCESS:') && s.includes('content'));
    assert.ok(mcpSeg, 'MCP 走独立 head 前缀（不得被 read 子串误标 READ_SUCCESS）');
    assert.ok(!/VERIFICATION:/.test(mcpSeg!), 'MCP 段无尾标');
    assert.ok(readSeg && readSeg.includes('VERIFICATION: NEUTRAL'), '内置 read 段仍标 NEUTRAL');
  });
});
