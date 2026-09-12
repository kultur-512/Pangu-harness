// tests/tools/persistOutput.test.ts
// M2-3: 工具结果落盘 + 回读 —
// - 超 cap 的 bash/grep 结果完整写 <workspace>/.panshalach/scratch/tool-<seq>.txt，
//   上下文内替换为"头 1500 + 尾 500 + <persisted-output path> 预览"；
// - read_file 结果永不落盘（防落盘→再读→再落盘死循环）；
// - scratch 目录被根 .gitignore 覆盖。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createEngineAdapter, SCRATCH_DIR, SCRATCH_SUBDIR } from '../../src/tools/engineAdapter.js';
import type { TierConfig } from '../../src/tiers/TierConfig.js';

let root: string;

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

function call(tool: string, params: Record<string, string>) {
  return { toolName: tool, params: Object.entries(params).map(([name, value]) => ({ name, value })), rawBlock: '' } as any;
}

function scratchDir() {
  return path.join(root, SCRATCH_DIR, SCRATCH_SUBDIR);
}

describe('M2-3 工具结果落盘 + 回读', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-persist-'));
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

  it('超限 bash 结果落盘 + 预览含路径 + 完整文件存在', async () => {
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
      approvalMode: 'full',
    });
    const out = await adapter.execute([call('bash', { command: "node -e \"console.log('x'.repeat(30000))\"" })]);

    assert.ok(out.includes('BASH_SUCCESS'), out);
    assert.ok(out.includes('VERIFICATION: PASS'), 'ok bash 仍判 PASS');
    assert.ok(out.includes('…[中间'), 'preview 应含省略标记');
    assert.ok(out.length < 3000, `preview 应远小于完整输出，got ${out.length} chars`);

    const m = /<persisted-output path="([^"]+)">/.exec(out);
    assert.ok(m, `preview 必须含 persisted-output 路径: ${out.slice(0, 500)}`);
    assert.ok(m![1].startsWith(`${SCRATCH_DIR}/${SCRATCH_SUBDIR}/tool-`), m![1]);

    const abs = path.join(root, m![1].split('/').join(path.sep));
    assert.ok(fs.existsSync(abs), `落盘文件必须存在: ${abs}`);
    const content = fs.readFileSync(abs, 'utf-8');
    assert.equal(content.trim(), 'x'.repeat(30000), '落盘文件应包含完整输出');
  });

  it('grep 超限也落盘（glob/grep/bash 超限才落）', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 300 }, () => 'm'.repeat(200)).join('\n'));
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
    });
    const out = await adapter.execute([call('grep', { pattern: 'm', path: '.' })]);
    const m = /<persisted-output path="([^"]+)">/.exec(out);
    assert.ok(m, `grep 超限应落盘: ${out.slice(0, 300)}`);
    const abs = path.join(root, m![1].split('/').join(path.sep));
    assert.ok(fs.existsSync(abs), `落盘文件必须存在: ${abs}`);
    const content = fs.readFileSync(abs, 'utf-8');
    assert.ok(content.includes('GREP_SUCCESS'), content.slice(0, 100));
    assert.ok(content.length > 20_000, `落盘应为完整输出，got ${content.length} chars`);
  });

  it('read_file 超限永不落盘（无 persisted-output、scratch 目录不创建）', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), 'y'.repeat(25_000));
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig(),
    });
    const out = await adapter.execute([call('read_file', { file_path: 'big.txt' })]);
    assert.ok(out.includes('[truncated at 20000 chars]'), 'read_file 仍走 20k cap');
    assert.ok(!out.includes('persisted-output'), 'read_file 结果不得落盘');
    assert.equal(fs.existsSync(scratchDir()), false, 'scratch 目录不得创建');
  });

  it('scratch 目录被根 .gitignore 覆盖（文本 + git check-ignore）', (t) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..');
    const gi = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');
    assert.ok(gi.includes('.panshalach/scratch/'), '根 .gitignore 必须含 .panshalach/scratch/ 条目');

    try {
      execFileSync('git', ['check-ignore', '-q', '.panshalach/scratch/tool-1.txt'], { cwd: repoRoot });
    } catch (e: any) {
      if (e && e.code === 'ENOENT') {
        t.skip('git not available in test environment');
        return;
      }
      assert.fail(`git check-ignore 应覆盖 scratch 路径: ${e?.message || e}`);
    }
  });
});
