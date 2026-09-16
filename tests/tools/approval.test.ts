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
import { latestCheckpoint, clearHistoryForWorkspace } from '../../src/tools/fileHistory.js';
import type { TierConfig } from '../../src/tiers/TierConfig.js';

let root: string;

function fakeTierConfig(tier: string = 'high'): TierConfig {
  return {
    tier,
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

  it("session allowlist ('a'): write/benign-bash skip, DANGEROUS bash never skips", () => {
    const allow = new Set<string>(['write_file', 'bash']);
    const w = classify('write_file', { file_path: 'x' }, { mode: 'default', sessionAllowlist: allow, isReadonlyAllowed });
    assert.equal(w.needsApproval, false, "write_file allow-always still skips (session + persist semantics kept)");

    const benign = classify('bash', { command: 'node script.js' }, { mode: 'default', sessionAllowlist: allow, isReadonlyAllowed });
    assert.equal(benign.needsApproval, false, 'benign bash is covered by the session allowlist');

    const evil = classify('bash', { command: 'rm -rf build' }, { mode: 'default', sessionAllowlist: allow, isReadonlyAllowed });
    assert.equal(evil.needsApproval, true, 'dangerous bash must re-prompt even when the session allowlist hits');
    assert.equal(evil.denied, false, 'dangerous bash is an approval, not a hard deny');
  });

  it('alias-normalized tool names hit the write/bash classification', () => {
    const w = classify('write', { file_path: 'x', content: 'y' }, { ...base, mode: 'readonly' });
    assert.equal(w.denied, true, "'write' alias must be treated as write_file in readonly");
    assert.ok(w.reason!.includes('/approvals default'));
    const wU = classify('WRITE_FILE', { file_path: 'x' }, { ...base, mode: 'readonly' });
    assert.equal(wU.denied, true, 'case variants must normalize');
    const e = classify('edit', { file_path: 'x' }, { ...base, mode: 'default' });
    assert.equal(e.needsApproval, true, "'edit' alias must be treated as edit_file");
    const sh = classify('run_command', { command: 'node x.js' }, { ...base, mode: 'default' });
    assert.equal(sh.needsApproval, true, "'run_command' alias must be treated as bash");
  });

  it('describeRequest: bash shows command; write shows path + size', () => {
    assert.equal(describeRequest('bash', { command: 'npm test' }), 'npm test');
    assert.ok(describeRequest('write_file', { file_path: 'a.ts', content: 'hello' }).includes('a.ts'));
  });
});

describe('engineAdapter approval gate', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-appr-'));
    fs.writeFileSync(path.join(root, 'rbw.txt'), 'original');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setStdoutTty(undefined);
    delete process.env.PANSHA_SMOKE;
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
    // 评审 Bug#1 回归断言：'a' = 加入 allowlist 且**本次放行**（首次调用必须成功写盘）
    assert.ok(fs.existsSync(path.join(root, 'a1.txt')), "first 'a' decision must approve the current call");
    await adapter.execute(call('write_file', { file_path: 'a2.txt', content: '2' }));
    assert.equal(bridgeCalls, 1, 'second write must skip the bridge via allowlist');
    assert.ok(allowlist.has('write_file'));
    assert.equal(fs.readFileSync(path.join(root, 'a2.txt'), 'utf-8'), '2');
  });

  it('default 档无审批桥 → auto-deny，TTY 与非 TTY 同语义（0.8：非 TTY 也抵达审批层）', async () => {
    // 0.8 语义反转后 outer mock 门已摘除：非 TTY 与 TTY 一样抵达审批层，
    // 无 bridge → safe default 拒绝（never hangs, never writes）。
    // 先在 fake TTY 下验证，再还原 non-TTY（测试进程本身非 TTY）复核同语义。
    setStdoutTty(true);
    delete process.env.PANSHA_SMOKE;
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

    // 非 TTY（不再被 mock 门拦截）同样 auto-deny
    setStdoutTty(undefined);
    const outNonTty = await adapter.execute(call('write_file', { file_path: 'no2.txt', content: 'x' }));
    assert.ok(outNonTty.startsWith('TOOL_ERROR: DENIED_BY_USER'));
    assert.ok(!fs.existsSync(path.join(root, 'no2.txt')));
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

  // ==================== P0: 工具别名不得绕过审批门 ====================

  it('readonly: write alias (`write`) denied with guidance, nothing written', async () => {
    setStdoutTty(true);
    let bridgeCalls = 0;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'readonly',
      approvalBridge: async () => { bridgeCalls++; return 'y'; },
    });
    const out = await adapter.execute(call('write', { file_path: 'alias.txt', content: 'hacked' }));
    assert.ok(out.startsWith('TOOL_ERROR: DENIED_READONLY'), out.slice(0, 80));
    assert.ok(out.includes('当前档位为只读；使用 /approvals default 或切换档位放行'), 'reason must carry readonly guidance');
    assert.equal(bridgeCalls, 0);
    assert.ok(!fs.existsSync(path.join(root, 'alias.txt')), 'alias must NOT slip past the readonly gate');
  });

  it('plan mode: write alias returns PLAN_MODE and writes nothing', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'full',
      planMode: true,
    });
    const out = await adapter.execute(call('write', { file_path: 'plan.txt', content: 'nope' }));
    assert.ok(out.includes('PLAN_MODE'), out.slice(0, 120));
    assert.ok(!fs.existsSync(path.join(root, 'plan.txt')), 'alias must NOT slip past plan-mode precheck');
  });

  it('readonly denial segment ends with the [TOOL_DENIED_READONLY <tool>] tail marker', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'readonly',
    });
    const out = await adapter.execute(call('bash', { command: 'curl http://evil.example' }));
    assert.ok(out.includes('DENIED_READONLY'));
    const seg = out.split('\n---\n')[0];
    assert.ok(seg.trimEnd().endsWith('[TOOL_DENIED_READONLY bash]'), `segment must end with the tail marker, got: ${JSON.stringify(seg.slice(-120))}`);
  });

  it("write alias still checkpoints + passes the write mutex (normalization at :674/:681)", async () => {
    clearHistoryForWorkspace(root);
    setStdoutTty(true);
    fs.writeFileSync(path.join(root, 'rbw.txt'), 'original');
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'full',
    });
    await adapter.execute(call('read_file', { file_path: 'rbw.txt' })); // RBW prerequisite
    const out = await adapter.execute(call('write', { file_path: 'rbw.txt', content: 'v2' }));
    assert.ok(out.includes('VERIFICATION: APPLIED'), out.slice(0, 120));
    const e = latestCheckpoint(root);
    assert.ok(e, 'alias write must still create a file-history checkpoint');
    assert.equal(e.rel, 'rbw.txt');
    clearHistoryForWorkspace(root);
  });

  // ==================== P1: 'a' 对 bash 的克制语义 ====================

  it("'a' on bash is session-scoped ONLY: no persist; dangerous bash still re-prompts", async () => {
    setStdoutTty(true);
    const allowlist = new Set<string>();
    let bridgeCalls = 0;
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 100,
      approvalBridge: async () => { bridgeCalls++; return 'a'; },
      sessionAllowlist: allowlist,
    });
    const out1 = await adapter.execute(call('bash', { command: 'node -e "console.log(1)"' }));
    assert.ok(out1.includes('BASH_SUCCESS'), out1.slice(0, 120)); // 'a' approves the current call
    assert.ok(allowlist.has('bash'), 'session allowlist gains bash for this session');
    const cfgPath = path.join(root, '.panshalach.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      assert.ok(!(cfg.approvalAllowlist || []).includes('bash'), "'a' on bash must NOT persist to project config");
    }
    await adapter.execute(call('bash', { command: 'node -e "console.log(2)"' }));
    assert.equal(bridgeCalls, 1, 'benign bash reuses the session allowlist without re-prompting');

    // control: 'a' on write_file KEEPS the persist semantics
    await adapter.execute(call('write_file', { file_path: 'persist.txt', content: 'x' }));
    assert.ok(fs.existsSync(cfgPath), "write_file 'a' still persists project config");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    assert.ok((cfg.approvalAllowlist || []).includes('write_file'), 'write_file allow-always persisted');

    // dangerous bash while the session allowlist contains bash → bridge again, 'n' → denied
    let evilBridgeCalls = 0;
    const evil = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 100,
      approvalBridge: async () => { evilBridgeCalls++; return 'n'; },
      sessionAllowlist: new Set<string>(['bash']),
    });
    const out2 = await evil.execute(call('bash', { command: 'rm -rf everything' }));
    assert.ok(out2.startsWith('TOOL_ERROR: DENIED_BY_USER'), out2.slice(0, 120));
    assert.equal(evilBridgeCalls, 1, 'dangerous bash must reach the bridge even when allowlisted');
    assert.ok(!out2.includes('BASH_SUCCESS'), 'dangerous command must not execute');
  });

  it("'a' on bash persists nothing even across a fresh adapter (control: no .panshalach.json entry)", async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 100,
      approvalBridge: async () => 'a',
      sessionAllowlist: new Set<string>(),
    });
    await adapter.execute(call('bash', { command: 'node -e "console.log(3)"' }));
    const cfgPath = path.join(root, '.panshalach.json');
    assert.ok(!fs.existsSync(cfgPath), "bash 'a' must never create the project config entry");
  });
});

// ==================== P2: adapter 级共享 decisionTimer 并发互踩 ====================
describe('engineAdapter MCP approval concurrency (timer hygiene)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-appr-mcp-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setStdoutTty(undefined);
    delete process.env.PANSHA_SMOKE;
  });

  it('a fast MCP approval must not clear the slow one\'s timeout (timer is per-call)', async () => {
    setStdoutTty(true);
    const adapter = createEngineAdapter({
      workspaceRoot: root,
      tierConfig: fakeTierConfig('high'),
      approvalMode: 'default',
      approvalTimeoutMs: 400,
      sessionAllowlist: new Set<string>(),
      approvalBridge: (req) =>
        req.tool === 'mcp_fast_ping'
          ? new Promise<string>((r) => setTimeout(() => r('y'), 100))
          : new Promise<string>(() => {}), // slow bridge hangs forever
      mcpTools: [
        { server: 'f', name: 'mcp_fast_ping', description: 'fast', call: async () => ({ ok: true, output: 'FAST-OK' }) },
        { server: 's', name: 'mcp_slow_tool', description: 'slow', call: async () => ({ ok: true, output: 'SLOW-OK' }) },
      ] as any,
    });
    const guarded = (p: Promise<any>, ms: number) =>
      Promise.race([
        p.then(() => 'settled', () => 'settled'),
        new Promise<string>((r) => setTimeout(() => r('HUNG'), ms)),
      ]);

    const pFast = adapter.executor.execute('mcp_fast_ping', {});
    await new Promise((r) => setTimeout(r, 50)); // fast timer set FIRST, slow clobbers the shared handle
    const pSlow = adapter.executor.execute('mcp_slow_tool', {});

    const slowState = await guarded(pSlow, 5000);
    assert.equal(slowState, 'settled', 'slow MCP approval must settle via its OWN timeout (shared handle was clobbered by the fast call)');
    const slowRes = await pSlow;
    assert.equal((slowRes as any).error, 'DENIED_BY_USER', `slow tool must be denied by timeout, got: ${JSON.stringify((slowRes as any).error)}`);
    const fastRes = await pFast;
    assert.ok(String((fastRes as any).output).includes('FAST-OK'), 'fast approval unaffected');
  });
});
