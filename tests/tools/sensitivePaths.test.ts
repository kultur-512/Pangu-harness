// tests/tools/sensitivePaths.test.ts
// M2-6: sensitive-path write protection —
// - write_file/edit_file denied at EVERY tier (readonly/default/full),
//   approval bridge never consulted (cannot override);
// - non-sensitive paths write normally;
// - /undo restore of a sensitive path denied;
// - path normalization (`./.ssh/x` ≡ `.ssh/x`).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSensitiveRelPath,
  isSensitiveWorkspacePath,
  normalizeRelPath,
} from '../../src/tools/sensitivePaths.js';
import { createEngineAdapter } from '../../src/tools/engineAdapter.js';
import { checkpointFile, undoLatest, clearHistoryForWorkspace } from '../../src/tools/fileHistory.js';
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
  return [{ toolName: tool, params: Object.entries(params).map(([name, value]) => ({ name, value })), rawBlock: '' } as any];
}

describe('sensitive path matcher', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-sp-matcher-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('flags every manifest entry (dirs, files, globs, nested)', () => {
    for (const p of [
      '.ssh', '.ssh/config', '.ssh/known_hosts',
      '.aws', '.aws/credentials',
      '.kube', '.kube/config',
      '.git-credentials', '.netrc',
      'id_rsa', 'id_rsa.pub', 'id_rsa_2024',
      '.env', '.env.local', '.env.production',
      'packages/x/.ssh/known_hosts',   // nested dir segment
      'config/.env.local',             // nested env file
    ]) {
      assert.equal(isSensitiveRelPath(p), true, `expected sensitive: ${p}`);
    }
  });

  it('does not flag ordinary paths', () => {
    for (const p of [
      'src/a.ts', 'readme.md', '.gitignore', 'package.json',
      'env.local', 'my_id_rsa.txt', '.sshbar/config', 'ssh/config',
    ]) {
      assert.equal(isSensitiveRelPath(p), false, `expected allowed: ${p}`);
    }
  });

  it('normalizes ./ prefixes, backslashes and trailing slashes', () => {
    assert.equal(normalizeRelPath('./.ssh/x'), '.ssh/x');
    assert.equal(normalizeRelPath('.ssh/'), '.ssh');
    assert.equal(normalizeRelPath('.ssh\\x'), '.ssh/x');
    assert.equal(isSensitiveRelPath('./.ssh/x'), true);
    assert.equal(isSensitiveRelPath('.ssh/x'), true);
    assert.equal(isSensitiveRelPath('.env/'), true);
  });

  it('resolves workspace paths: ./ form, absolute form, out-of-workspace', () => {
    assert.equal(isSensitiveWorkspacePath(root, './.ssh/x'), true);
    assert.equal(isSensitiveWorkspacePath(root, path.join(root, '.env')), true);
    assert.equal(isSensitiveWorkspacePath(root, '../.env'), false, 'outside workspace is pathGuard territory');
    assert.equal(isSensitiveWorkspacePath(root, ''), false);
  });
});

describe('adapter write gate (M2-6)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-sp-'));
  });
  afterEach(() => {
    clearHistoryForWorkspace(root);
    fs.rmSync(root, { recursive: true, force: true });
    setStdoutTty(undefined);
    delete process.env.PANSHA_SMOKE;
    delete process.env.PANSHA_HEADLESS;
  });

  it('full tier: write_file to .env denied, nothing on disk', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root, tierConfig: fakeTierConfig(), approvalMode: 'full',
    });
    const out = await adapter.execute(call('write_file', { file_path: '.env', content: 'SECRET=1' }));
    assert.ok(out.startsWith('TOOL_ERROR: SENSITIVE_PATH'), out);
    assert.ok(out.includes('✗ SENSITIVE_PATH: .env 位于敏感路径清单，任何档位禁止写入'));
    assert.ok(!fs.existsSync(path.join(root, '.env')));
  });

  it('default tier + y-all bridge: approval never consulted, override impossible', async () => {
    setStdoutTty(true);
    let bridgeCalls = 0;
    const adapter = createEngineAdapter({
      workspaceRoot: root, tierConfig: fakeTierConfig(), approvalMode: 'default',
      approvalTimeoutMs: 100,
      approvalBridge: async () => { bridgeCalls++; return 'y'; },
    });
    const out = await adapter.execute(call('write_file', { file_path: '.ssh/config', content: 'x' }));
    assert.ok(out.startsWith('TOOL_ERROR: SENSITIVE_PATH'), out);
    assert.equal(bridgeCalls, 0, 'sensitive denial must precede the approval gate');
    assert.ok(!fs.existsSync(path.join(root, '.ssh', 'config')));
  });

  it('readonly tier: SENSITIVE_PATH wins over DENIED_READONLY (gate priority)', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root, tierConfig: fakeTierConfig(), approvalMode: 'readonly',
    });
    const out = await adapter.execute(call('edit_file', { file_path: '.aws/credentials', old_string: 'a', new_string: 'b' }));
    assert.ok(out.startsWith('TOOL_ERROR: SENSITIVE_PATH'), out);
    assert.ok(!out.includes('DENIED_READONLY'));
  });

  it('edit_file + ./ prefixed + write alias all denied at full tier', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root, tierConfig: fakeTierConfig(), approvalMode: 'full',
    });
    const e1 = await adapter.execute(call('edit_file', { file_path: './.kube/config', old_string: 'a', new_string: 'b' }));
    assert.ok(e1.startsWith('TOOL_ERROR: SENSITIVE_PATH'), e1);
    const e2 = await adapter.execute(call('write', { file_path: '.netrc', content: 'x' }));
    assert.ok(e2.startsWith('TOOL_ERROR: SENSITIVE_PATH'), e2);
    assert.ok(!fs.existsSync(path.join(root, '.kube', 'config')));
    assert.ok(!fs.existsSync(path.join(root, '.netrc')));
  });

  it('non-sensitive paths write normally at full tier', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root, tierConfig: fakeTierConfig(), approvalMode: 'full',
    });
    const out = await adapter.execute(call('write_file', { file_path: 'notes.txt', content: 'fine' }));
    assert.ok(out.startsWith('WRITE_SUCCESS:'), out);
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf-8'), 'fine');
  });
});

describe('undo rejection (M2-6)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-sp-undo-'));
  });
  afterEach(() => {
    clearHistoryForWorkspace(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('/undo refuses to restore a sensitive path (file untouched)', () => {
    const abs = path.join(root, '.ssh', 'config');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'original');
    checkpointFile(abs, root);
    fs.writeFileSync(abs, 'hacked');

    const r = undoLatest(root);
    assert.equal(r.ok, false);
    assert.ok(r.message.includes('SENSITIVE_PATH'), r.message);
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'hacked', 'undo must not touch the file');
  });

  it('/undo of a normal path still works (check is not overbroad)', () => {
    const abs = path.join(root, 'a.txt');
    fs.writeFileSync(abs, 'v1');
    checkpointFile(abs, root);
    fs.writeFileSync(abs, 'v2');

    const r = undoLatest(root);
    assert.ok(r.ok, r.message);
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'v1');
  });
});
