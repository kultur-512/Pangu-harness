// tests/tools/ParamAliasAndInvalidParams.test.ts
// T2 参数名别名归一 + T5 INVALID_PARAMS 回灌正确参数名（红→绿）。
//
// T2 背景（探查实证）：文本协议下模型看不到参数名 → 参数幻觉 100%
//   （`filepath`→✗ EMPTY_PATH、grep `command`→requires pattern）——解析成功
//   但执行必败。别名在执行内核入口按工具收敛（executor + engineAdapter 门禁前），
//   使 gate / 敏感路径检查 / RBW checkpoint / 工具实现看到同一套规范键。
//
// T5 背景：UNKNOWN_TOOL 结果已带"可用工具"引导，INVALID_PARAMS 却零引导——
//   模型只看到 ✗ 后无从纠正。INVALID_PARAMS 结果必须追加正确参数集。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolExecutor, normalizeToolName } from '../../src/tools/executor.js';
import { createEngineAdapter } from '../../src/tools/engineAdapter.js';
import { ToolCallGuardrailController } from '../../src/loop/guardrails.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { ToolCall } from '../../src/types/toolCall.js';

let root: string;
let ctx: ToolContext;

function call(toolName: string, params: Record<string, string>): ToolCall {
  return {
    toolName,
    rawBlock: `<${toolName}>`,
    params: Object.entries(params).map(([name, value]) => ({ name, value })),
  };
}

describe('T2 参数名别名归一（executor 内核入口收敛）', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-alias-'));
    fs.writeFileSync(path.join(root, 'f.txt'), 'hello content');
    ctx = { workspaceRoot: root, approvalMode: 'full' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('read_file 接受 filepath 别名（实证：filepath → EMPTY_PATH 必败）', async () => {
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('read_file', { filepath: 'f.txt' });
    assert.equal(r.ok, true, `filepath 别名必须命中 file_path，got: ${r.error} ${r.output}`);
  });

  it('read_file 接受 filename 别名', async () => {
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('read_file', { filename: 'f.txt' });
    assert.equal(r.ok, true);
  });

  it('grep 接受 command 别名（实证：grep command → requires pattern 必败）', async () => {
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('grep', { command: 'hello' });
    assert.equal(r.ok, true, `grep command 别名必须收敛到 pattern，got: ${r.error} ${r.output}`);
  });

  it('grep 接受 query 别名', async () => {
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('grep', { query: 'content' });
    assert.equal(r.ok, true);
  });

  it('glob 接受 query / command 别名', async () => {
    const ex = createToolExecutor(ctx);
    assert.equal((await ex.execute('glob', { query: '*.txt' })).ok, true);
    assert.equal((await ex.execute('glob', { command: '*.txt' })).ok, true);
  });

  it('规范键优先：同时给 pattern 与 query 时 pattern 胜', async () => {
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('glob', { pattern: '*.txt', query: '*.md' });
    assert.equal(r.ok, true);
    assert.ok(String(r.output).includes('f.txt'), '必须按 pattern=*.txt 匹配（而非 query）');
  });

  it('别名不吞 path 语义：grep 的 path 仍是搜索目录（不被误当 pattern）', async () => {
    const ex = createToolExecutor(ctx);
    const r = await ex.execute('grep', { pattern: 'hello', path: '.' });
    assert.equal(r.ok, true, `path 参数语义保持，got: ${r.error} ${r.output}`);
  });

  it('write_file / edit_file 接受 filepath 别名（经 engineAdapter，门禁后仍规范）', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: TierRegistry.get('standard'),
      approvalMode: 'full',
    });
    const w = await adapter.execute([call('write_file', { filepath: 'new.txt', content: 'abc' })]);
    assert.ok(w.includes('WRITE_SUCCESS') || w.includes('TOOL_OK'), `filepath 写入必须成功，got: ${w}`);
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf-8'), 'abc');

    // edit_file 前置读取（RBW），随后用 filepath 别名编辑
    await adapter.execute([call('read_file', { file_path: 'new.txt' })]);
    const e = await adapter.execute([call('edit_file', { filepath: 'new.txt', old_string: 'abc', new_string: 'abcd' })]);
    assert.ok(!e.includes('INVALID_PARAMS'), `edit_file filepath 别名必须收敛，got: ${e}`);
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf-8'), 'abcd');
  });
});

describe('T5 INVALID_PARAMS 回灌正确参数名', () => {
  function mkAdapter(dir: string) {
    return createEngineAdapter({
      workspaceRoot: dir,
      tierConfig: TierRegistry.get('standard'),
      approvalMode: 'full',
    });
  }

  it('glob 缺 pattern → 结果追加（正确参数：<pattern>…</pattern>）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-inv-'));
    try {
      const r = await mkAdapter(dir).execute([call('glob', {})]);
      assert.ok(r.includes('INVALID_PARAMS') || r.includes('requires'), `形状前提：${r}`);
      assert.ok(
        /（正确参数：<pattern>[^<]*<\/pattern>）/.test(r),
        `INVALID_PARAMS 必须回灌正确参数集，got: ${r}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('write_file 缺 file_path → 追加 file_path + content 两个必填参数', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-inv-'));
    try {
      const r = await mkAdapter(dir).execute([call('write_file', {})]);
      assert.ok(r.includes('INVALID_PARAMS'), `形状前提：${r}`);
      assert.ok(r.includes('（正确参数：<file_path>'), '必须含 file_path');
      assert.ok(r.includes('<content>'), '必须含 content');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已知工具执行成功 / UNKNOWN_TOOL 分支不受影响', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-inv-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'ok');
      const adapter = mkAdapter(dir);
      const ok = await adapter.execute([call('read_file', { file_path: 'a.txt' })]);
      assert.ok(ok.includes('READ_SUCCESS'), `形状前提：${ok}`);
      assert.ok(!ok.includes('（正确参数：'), '成功结果不得追加参数提示');
      const unk = await adapter.execute([call('teleport', {})]);
      assert.ok(unk.includes('UNKNOWN_TOOL'), 'UNKNOWN_TOOL 行为保持');
      assert.ok(!unk.includes('（正确参数：'), 'UNKNOWN_TOOL 走原有可用工具引导（不混入参数提示）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T5 guardrails UNKNOWN_TOOL 停滞闸归一化键', () => {
  it('换花样写工具名（Read_File/readfile）失败 8 次 → halt 触发（旧实现按原始名分桶永不触发）', () => {
    const g = new ToolCallGuardrailController();
    const variants = ['Read_File', 'readfile', 'READ_FILE', 'read_file '];
    for (let i = 0; i < 8; i++) {
      g.recordResult(call(variants[i % variants.length], { x: String(i) }), 'ERROR: UNKNOWN_TOOL');
    }
    const d = g.beforeCall([call('read_file', { x: '99' })]);
    assert.equal(d.blocked, true, '归一化后同工具失败达阈值 → 阻断');
    assert.equal(d.halt, true, '达 sameToolFailureHaltAfter → halt 级');
  });

  it('任一别名形式成功 → 该工具连败计数归零', () => {
    const g = new ToolCallGuardrailController();
    for (let i = 0; i < 7; i++) {
      g.recordResult(call(i % 2 === 0 ? 'Read_File' : 'readfile', { x: String(i) }), 'ERROR: x');
    }
    g.recordResult(call('READ_FILE', { x: 'ok' }), 'READ_SUCCESS: ok');
    assert.equal(
      g.beforeCall([call('read_file', { x: 'next' })]).blocked, false,
      '别名成功也要清零（同一工具的归一化身份）'
    );
  });

  it('normalizeToolName 基线不回归', () => {
    assert.equal(normalizeToolName('Read'), 'read_file');
    assert.equal(normalizeToolName('ReadFile'), 'read_file');
  });
});
