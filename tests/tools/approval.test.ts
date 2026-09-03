// tests/tools/approval.test.ts
// M1-2.4: classify semantics + adapter gate integration —
// readonly denies with guidance; default y/n/a via mock bridge; full passes;
// non-TTY auto-deny; allowlist session effect + clear; timeout → n.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, createHeadlessApprovalBridge, describeRequest } from '../../src/tools/approval.js';
import { createEngineAdapter } from '../../src/tools/engineAdapter.js';
import { isReadonlyAllowed } from '../../src/tools/readonlyAllowlist.js';
import type { TierConfig } from '../../src/tiers/TierConfig.js';

let root: string;

function fakeTierConfig(tier: string = 'high'): TierConfig {
  return {
    tier,
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

describe('classify', () => {
  const base = { sessionAllowlist: new Set<string>(), isReadonlyAllowed };

  it('readonly: writes denied with guidance; bash non-allowlisted denied; allowlisted bash free', () => {
    const w = classify('write_file', { file_path: 'x' }, { ...base, mode: 'readonly' });
    assert.equal(w.denied, true);
    assert.ok(w.reason!.includes('/approvals default'));

    const b = classify('bash', { command: 'rm -rf x' }, { ...base, mode: 'readonly' });
    assert.equal(b.denied, true);
    assert.ok(b.reason!.includes('/approvals default'));

    const ok = classify('bash', { command: 'npm test' }, { ...base, mode: 'readonly' });
    assert.equal(ok.denied, false);
    assert.equal(ok.needsApproval, false);
  });

  it('default: writes need approval; bash outside allowlist needs approval; allowlisted bash free', () => {
    const w = classify('write_file', { file_path: 'x' }, { ...base, mode: 'default' });
    assert.equal(w.needsApproval, true);
    assert.equal(w.denied, false);

    const b = classify('bash', { command: 'node script.js' }, { ...base, mode: 'default' });
    assert.equal(b.needsApproval, true);

    const ok = classify('bash', { command: 'git status' }, { ...base, mode: 'default' });
    assert.equal(ok.needsApproval, false);
  });

  it('full: everything free but danger still flagged', () => {
    const r = classify('bash', { command: 'rm -rf build' }, { ...base, mode: 'full' });
    assert.equal(r.needsApproval, false);
    assert.equal(r.denied, false);
    assert.equal(r.danger, true);
  });

  it("session allowlist ('a') skips approval in default mode", () => {
    const allow = new Set<string>(['write_file']);
    const r = classify('write_file', { file_path: 'x' }, { mode: 'default', sessionAllowlist: allow, isReadonlyAllowed });
    assert.equal(r.needsApproval, false);
  });

  it('describeRequest: bash shows command; write shows path + size', () => {
    assert.equal(describeRequest('bash', { command: 'npm test' }), 'npm test');
    assert.ok(describeRequest('write_file', { file_path: 'a.ts', content: 'hello' }).includes('a.ts'));
  });
});

describe('engineAdapter approval gate', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-appr-'));
    fs.writeFileSync(path.join(root, 'rbw.txt'), 'original');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setStdoutTty(undefined);
    delete process.env.ZORGE_SMOKE;
  });

  it('readonly: write denied without touching the bridge or the file', async () => {
    setStdoutTty(true);
    let bridgeCalls = 0;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'readonly',
      approvalBridge: async () => { bridgeCalls++; return 'y'; },
    });
    const out = await adapter.execute(call('write_file', { file_path: 'rbw.txt', content: 'hacked' }));
    assert.ok(out.startsWith('TOOL_ERROR: DENIED_READONLY'));
    assert.ok(out.includes('/approvals default'));
    assert.equal(bridgeCalls, 0);
    assert.equal(fs.readFileSync(path.join(root, 'rbw.txt'), 'utf-8'), 'original');
  });

  it('default: bridge y → file written; bridge n → DENIED_BY_USER untouched', async () => {
    setStdoutTty(true);

    const yes = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 100, // M2.0 hang fix: race-timer hygiene
      approvalBridge: createHeadlessApprovalBridge('y-all'),
      sessionAllowlist: new Set<string>(),
    });
    const outYes = await yes.execute(call('write_file', { file_path: 'new.txt', content: 'approved' }));
    assert.ok(outYes.startsWith('WRITE_SUCCESS:'));
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf-8'), 'approved');

    const no = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 100, // M2.0 hang fix
      approvalBridge: createHeadlessApprovalBridge('n-all'),
      sessionAllowlist: new Set<string>(),
    });
    const outNo = await no.execute(call('write_file', { file_path: 'new2.txt', content: 'rejected' }));
    assert.ok(outNo.startsWith('TOOL_ERROR: DENIED_BY_USER'));
    assert.ok(!fs.existsSync(path.join(root, 'new2.txt')));
  });

  it("default: 'a' adds tool to session allowlist (subsequent calls skip bridge)", async () => {
    setStdoutTty(true);
    const allowlist = new Set<string>();
    let bridgeCalls = 0;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 100, // M2.0 hang fix
      approvalBridge: async () => { bridgeCalls++; return 'a'; },
      sessionAllowlist: allowlist,
    });
    const p = { file_path: 'rbw.txt', content: 'x' };
    // NOTE: first call needs prior read for RBW; use a NEW file to isolate approval logic
    await adapter.execute(call('write_file', { file_path: 'a1.txt', content: '1' }));
    await adapter.execute(call('write_file', { file_path: 'a2.txt', content: '2' }));
    assert.equal(bridgeCalls, 1, 'second write must skip the bridge via allowlist');
    assert.ok(allowlist.has('write_file'));
    assert.equal(fs.readFileSync(path.join(root, 'a2.txt'), 'utf-8'), '2');
  });

  it('TTY without bridge → auto-deny (never hangs, never writes); non-TTY never even reaches approval (outer mock gate)', async () => {
    // Outer safety gate (non-TTY → mock) is covered by executor.test.ts.
    // Here: TTY=true so we reach the approval layer, but no bridge configured.
    setStdoutTty(true);
    delete process.env.ZORGE_SMOKE;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      // no bridge
    });
    const t0 = Date.now();
    const out = await adapter.execute(call('write_file', { file_path: 'no.txt', content: 'x' }));
    assert.ok(Date.now() - t0 < 1000, 'must not hang');
    assert.ok(out.startsWith('TOOL_ERROR: DENIED_BY_USER'));
    assert.ok(!fs.existsSync(path.join(root, 'no.txt')));
  });

  it('approval timeout (short, injected) → treated as n', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 150,
      approvalBridge: async () => new Promise<'y'>(() => {}), // never resolves
    });
    const t0 = Date.now();
    const out = await adapter.execute(call('write_file', { file_path: 'slow.txt', content: 'x' }));
    const dt = Date.now() - t0;
    assert.ok(dt < 2000, `timeout path should be fast, took ${dt}ms`);
    assert.ok(out.startsWith('TOOL_ERROR: DENIED_BY_USER'));
    assert.ok(!fs.existsSync(path.join(root, 'slow.txt')));
  });

  it('emits approval.request event via emitEvent', async () => {
    setStdoutTty(true);
    const events: any[] = [];
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 100, // M2.0 hang fix
      approvalBridge: createHeadlessApprovalBridge('y-all'),
      emitEvent: (e) => events.push(e),
    });
    await adapter.execute(call('write_file', { file_path: 'evt.txt', content: 'x' }));
    const req = events.find((e) => e.type === 'approval.request');
    assert.ok(req, 'approval.request event must be emitted');
    assert.equal(req.tool, 'write_file');
    assert.ok(req.description.includes('evt.txt'));
  });
});
