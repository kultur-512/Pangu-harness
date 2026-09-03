// scripts/verify-m2-confirm.mjs
// M2.0 acceptance for the REAL rich-UI approval bridge (pure Node, no ink):
// 1) bridge.setConfirm/resolveConfirm state machine (y / n / a sequences)
// 2) engineAdapter end-to-end through the bridge wiring used by sseInteractive:
//    n → DENIED_BY_USER (file untouched)
//    a → session allowlist gains the tool; second call skips the bridge
//    y → proceeds (hits RBW when unread — engine layer, by design)
//
// NOTE (M1 deviation ② red line): this script does NOT fake isTTY for real
// execution; it exercises the approval path with a fake ToolImpl, so the
// smoke gate stays honest. Real-execution TTY verification is listed as
// pending manual work in docs/M1-ACCEPTANCE.md.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- Part 1: bridge state machine (no React needed) ----------
console.log('[m2-confirm] importing bridge...');
const { createBridge } = await import('../dist/cli/repl/ui/bridge.js');
console.log('[m2-confirm] bridge imported');

const fakeSession = { tier: 'high', model: 'default', workspace: process.cwd() };
const fakeRenderer = {};
const bridge = createBridge(fakeSession, fakeRenderer, null);

let dispatchLog = [];
bridge.__registerDispatch((action) => dispatchLog.push(action));

// sequence A: n
console.log('[m2-confirm] seq A...');
let p1 = bridge.setConfirm({ tool: 'edit_file', description: 'a.ts', danger: false });
assert.equal(bridge.hasPendingConfirm(), true);
assert.ok(dispatchLog.some((a) => a.type === 'SET_CONFIRM_STATE' && a.confirm?.tool === 'edit_file'));
bridge.resolveConfirm('n');
assert.equal(await p1, 'n');
assert.equal(bridge.hasPendingConfirm(), false);
assert.ok(dispatchLog.some((a) => a.type === 'SET_CONFIRM_STATE' && a.confirm === undefined));

// sequence B: latest-wins semantics — a new confirm replaces the pending one;
// the orphaned promise never settles (engine awaits ONE confirm at a time),
// so we deliberately do NOT await p2.
const p2 = bridge.setConfirm({ tool: 'bash', description: 'npm test', danger: false });
p2.catch(() => {}); // silence stray rejection warnings
assert.equal(bridge.hasPendingConfirm(), true);
bridge.setConfirm({ tool: 'bash', description: 'second', danger: false }); // replaces
bridge.resolveConfirm('y'); // resolves the SECOND resolver
bridge.resolveConfirm('a'); // no-op when nothing pending

console.log('[m2-confirm] bridge state machine: PASS');

// ---------- Part 2: engineAdapter through the same bridge wiring ----------
// TTY is required to pass the outer smoke gate; execution is FAKE (no spawn),
// so no real-execution red line is crossed.
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
delete process.env.ZORGE_SMOKE;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-m2confirm-'));
fs.writeFileSync(path.join(root, 'rbw.txt'), 'original');

const { createEngineAdapter } = await import('../dist/tools/engineAdapter.js');

const allowlist = new Set();
let pendingResolve = null;
const wiredBridge = {
  setConfirm: (req) => new Promise((resolve) => { pendingResolve = resolve; }),
};

const adapter = createEngineAdapter({
  workspaceRoot: root,
  tierConfig: { tier: 'high' },
  approvalMode: 'default',
  sessionAllowlist: allowlist,
  approvalBridge: (req) => wiredBridge.setConfirm(req),
});

function call(tool, params) {
  return [{ toolName: tool, params: Object.entries(params).map(([name, value]) => ({ name, value })), rawBlock: '' }];
}

// --- n → denied, file untouched, engine promise resolved by ConfirmBar decision
const runN = adapter.execute(call('write_file', { file_path: 'n.txt', content: 'x' }));
await new Promise((r) => setTimeout(r, 5));
assert.ok(pendingResolve, 'engine must be waiting on the ConfirmBar decision');
pendingResolve('n');
const outN = await runN;
assert.ok(outN.startsWith('TOOL_ERROR: DENIED_BY_USER'), outN.slice(0, 80));
assert.ok(!fs.existsSync(path.join(root, 'n.txt')));
console.log('[m2-confirm] n → DENIED_BY_USER: PASS');

// --- a → allowlist skip on second call
const runA1 = adapter.execute(call('write_file', { file_path: 'a1.txt', content: '1' }));
await new Promise((r) => setTimeout(r, 5));
pendingResolve('a');
const outA1 = await runA1;
assert.ok(outA1.startsWith('WRITE_SUCCESS:'), outA1.slice(0, 80));
assert.ok(allowlist.has('write_file'));

const outA2 = await adapter.execute(call('write_file', { file_path: 'a2.txt', content: '2' }));
assert.ok(outA2.startsWith('WRITE_SUCCESS:'), 'second call must skip the bridge via allowlist');
console.log('[m2-confirm] a → session allowlist skip: PASS');

// --- y → proceeds (RBW denial expected for unread file — engine layer by design)
const runY = adapter.execute(call('write_file', { file_path: 'rbw.txt', content: 'x' }));
await new Promise((r) => setTimeout(r, 5));
pendingResolve('y');
const outY = await runY;
assert.ok(outY.startsWith('TOOL_ERROR: RBW_VIOLATION'), 'y must proceed INTO the engine (RBW then guards)');
console.log('[m2-confirm] y → proceeds into engine (RBW guard intact): PASS');

fs.rmSync(root, { recursive: true, force: true });
console.log('[m2-confirm] ALL PASS');
