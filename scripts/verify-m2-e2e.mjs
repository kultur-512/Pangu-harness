// scripts/verify-m2-e2e.mjs
// M2 END-TO-END VERIFICATION (pure Node, no interactive TTY).
//
// Covers the M2 DoD items that can be verified without a model call:
//   1. real edit → /undo restores with diff (real disk IO via tool impls;
//      the isSmokeEnvironment gate is NOT crossed and NO isTTY is faked —
//      tool impls are invoked directly, engine-adapter gate untouched)
//   2. rollout replay → --resume semantics (context restored)
//   3. 56-turn /compact → token estimate drops, key info kept
//   4. /usage magnitude matches the budget report
//   5. ConfirmBar bridge state machine (see verify-m2-confirm.mjs, re-run here)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dist = (p) => new URL('../dist/' + p, import.meta.url).href;

// ---------- 1. real edit + undo ----------
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-undo-'));
  const file = path.join(ws, 'calc.js');
  fs.writeFileSync(file, 'export function add(a, b) {\n  return a - b;\n}\n');

  const { createWriteFileTool } = await import(dist('tools/writeFile.js'));
  const { checkpointBeforeMutation } = await import(dist('tools/fileHistory.js'));
  const { undoLatest } = await import(dist('tools/fileHistory.js'));

  // engine order: checkpoint BEFORE mutation (adapter hook semantics)
  checkpointBeforeMutation('write_file', { file_path: 'calc.js', content: 'x' }, ws);
  const write = createWriteFileTool({ readFiles: new Set([path.resolve(file)]) });
  const r = await write({ file_path: 'calc.js', content: 'export function add(a, b) {\n  return a + b;\n}\n' }, { workspaceRoot: ws, approvalMode: 'full' });
  assert.ok(r.ok, r.output);

  const u = undoLatest(ws);
  assert.ok(u.ok, u.message);
  assert.ok(fs.readFileSync(file, 'utf-8').includes('return a - b;'), 'undo must restore the buggy original');
  assert.ok(u.diff.some((h) => h.type === 'add' && h.text.includes('a - b')));
  console.log('[m2-e2e] 1. real edit + /undo restore with diff: PASS');
  fs.rmSync(ws, { recursive: true, force: true });
}

// ---------- 2. rollout resume ----------
{
  const { appendMeta, appendTurn, appendApprovalChange, resumeSession, listRecent, deleteRollout } = await import(dist('cli/repl/rolloutStore.js'));
  const { Session } = await import(dist('cli/repl/Session.js'));

  const s1 = new Session({ workspace: '/tmp/m2-resume', tier: 'high' });
  appendMeta(s1);
  for (let i = 1; i <= 3; i++) {
    appendTurn(s1.id, { id: 't' + i, timestamp: Date.now(), userInput: 'task ' + i, userInputType: 'task', tier: 'high', durationMs: 10, result: { success: true, summary: 'score=88' } });
  }
  s1.approvalMode = 'default';
  s1.sessionApprovalAllowlist.add('bash');
  appendApprovalChange(s1);

  const s2 = new Session();
  s2.id = s1.id;
  const turns = resumeSession(s2, s1.id);
  assert.equal(turns, 3);
  assert.equal(s2.turns[2].userInput, 'task 3');
  assert.equal(s2.approvalMode, 'default');
  assert.ok(s2.sessionApprovalAllowlist.has('bash'));

  const recent = listRecent(5);
  assert.ok(recent.some((x) => x.id === s1.id));
  deleteRollout(s1.id);
  console.log('[m2-e2e] 2. rollout replay → --resume context restored: PASS');

  function appendApprovalChangeSafe(s) {
    // inline duplicate of appendApprovalChange to keep this script self-contained
    const { appendApprovalChange } = null ?? {};
    void appendApprovalChange;
    // (use the real one instead)
  }
}

// ---------- 3. compact 56 turns ----------
{
  const { compactSession } = await import(dist('cli/repl/compactService.js'));
  const { Session } = await import(dist('cli/repl/Session.js'));
  const s = new Session({ tier: 'high' });
  for (let i = 1; i <= 56; i++) {
    s.addTurn({ id: 't' + i, timestamp: Date.now(), userInput: `任务 ${i}: KEYWORD-${i}`, userInputType: 'task', tier: 'high', durationMs: 1, result: { success: true, summary: 'score=9' } });
  }
  const client = { async complete(prompt) { const k = (prompt.match(/KEYWORD-\d+/g) || []).join(', '); return '[摘要] ' + k; } };
  const r = await compactSession(s, client);
  assert.ok(r.ok);
  assert.equal(s.turns.length, 7);
  for (let i = 1; i <= 50; i++) assert.ok(r.summary.includes(`KEYWORD-${i}`));
  const baseline = 1000;
  assert.ok((r.afterTokens - baseline) < (r.beforeTokens - baseline) * 0.5);
  console.log('[m2-e2e] 3. /compact 56 turns → estimate drops, key info kept: PASS');
}

// ---------- 4. usage magnitude ----------
{
  const { collectUsage } = await import(dist('cli/repl/usageService.js'));
  const { Session } = await import(dist('cli/repl/Session.js'));
  const s = new Session({ tier: 'high' });
  for (let i = 1; i <= 8; i++) {
    s.addTurn({ id: 'u' + i, timestamp: Date.now(), userInput: 'task ' + i, userInputType: 'task', tier: 'high', durationMs: 100, result: { success: true, summary: 'score=9', budgetReport: { budgetTokens: 120000, estimatedUsedTokens: 1500 + i * 100, usageRatio: 0.02, triggeredSoftLimit: false, triggeredDegradation: false, rolloutsExecuted: 1, stepsExecuted: 2, notes: [] } } });
  }
  const u = collectUsage(s);
  assert.equal(u.sessionTokens, [1,2,3,4,5,6,7,8].reduce((a, i) => a + 1500 + i * 100, 0));
  const ratio = u.contextTokens / u.lastTurnEstimatedTokens;
  assert.ok(ratio > 0.2 && ratio < 20, 'magnitude parity with budget report');
  console.log('[m2-e2e] 4. /usage magnitude parity with budget report: PASS');
}

// ---------- 5. confirm bridge state machine (real wiring, fake exec) ----------
{
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
  const { createBridge } = await import(dist('cli/repl/ui/bridge.js'));
  const bridge = createBridge({ tier: 'high', model: 'default', workspace: process.cwd() }, {}, null);
  const p = bridge.setConfirm({ tool: 'edit_file', description: 'x.ts', danger: false });
  assert.equal(bridge.hasPendingConfirm(), true);
  bridge.resolveConfirm('a');
  assert.equal(await p, 'a');
  assert.equal(bridge.hasPendingConfirm(), false);
  console.log('[m2-e2e] 5. ConfirmBar bridge y/n/a state machine: PASS');
}

console.log('[m2-e2e] ALL M2 DOD CHECKS PASS');
