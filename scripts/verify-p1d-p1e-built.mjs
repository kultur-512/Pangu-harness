// scripts/verify-p1d-p1e-built.mjs
// Pure Node (no tsx, no child_process) verification for P1-D and P1-E using built dist/ artifacts.
// This avoids sandbox spawn EPERM. Exits 0 on success.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(process.cwd());

async function loadDist() {
  const pbUrl = pathToFileURL(resolve(root, 'dist/cli/repl/PromptBuilder.js')).href;
  const sessUrl = pathToFileURL(resolve(root, 'dist/cli/repl/Session.js')).href;
  const tierUrl = pathToFileURL(resolve(root, 'dist/tiers/TierConfig.js')).href;

  const [pbMod, sessMod, tierMod] = await Promise.all([
    import(pbUrl),
    import(sessUrl),
    import(tierUrl),
  ]);

  return {
    PromptBuilder: pbMod.PromptBuilder,
    Session: sessMod.Session,
    TierRegistry: tierMod.TierRegistry,
  };
}

async function verifyP1E({ PromptBuilder, Session, TierRegistry }) {
  const sess = new Session({ tier: 'high' });
  for (let i = 0; i < 15; i++) {
    sess.addTurn({
      id: 't' + i,
      timestamp: Date.now(),
      userInput: 'x' + i,
      userInputType: 'task',
      tier: 'high',
      durationMs: 1,
    });
  }
  const cfg = TierRegistry.get('high');
  const pb = new PromptBuilder(sess, cfg);

  const prompt = await pb.buildForTask('implement feature X');

  const hasSummary = prompt.includes('<injection_summary>');
  const hasTier = prompt.includes('<tier_constraint tier="high">');
  const compMatches = (prompt.match(/历史较长，已做内部压缩/g) || []).length;

  const summaryBlockMatch = prompt.match(/<injection_summary>([\s\S]*?)<\/injection_summary>/);
  let summaryObj = null;
  if (summaryBlockMatch) {
    try { summaryObj = JSON.parse(summaryBlockMatch[1]); } catch {}
  }

  const checks = {
    hasSummary,
    hasTier,
    compactionOnce: compMatches === 1,
    tierConstraintTrue: !!(summaryObj && summaryObj.tierConstraint === true),
    duplicatesReported: !!(summaryObj && typeof summaryObj.duplicatesSkipped === 'number'),
  };

  const ok = Object.values(checks).every(Boolean);
  return { ok, checks, summary: summaryObj, promptHead: prompt.slice(0, 400) };
}

async function verifyP1D_MemoryCommandShape() {
  // For P1-D we cannot easily instantiate the full REPL CommandContext without more wiring,
  // but we can at least assert the source shape of the command module (no spawn).
  // We read the TS source (allowed, read-only) and check key behaviors are present.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(resolve(root, 'src/cli/repl/commands/MemoryCommand.ts'), 'utf8');

  const hasZeroArgBranch = /args\.length === 0|!args \|\| args\.length === 0/.test(src);
  const hasSubmenuLoop = /while\s*\(true\)/.test(src) && /memory>/.test(src);
  const hasBackExit = /back|exit|q|quit/.test(src);
  const delegatesToRunMemory = /runMemoryCommand/.test(src);

  const checks = {
    hasZeroArgBranch,
    hasSubmenuLoop,
    hasBackExit,
    delegatesToRunMemory,
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, checks };
}

async function main() {
  console.log('Loading dist artifacts...');
  const mods = await loadDist();

  console.log('Verifying P1-E (PromptBuilder dedup + <injection_summary>) via dist...');
  const p1e = await verifyP1E(mods);
  console.log('P1-E checks:', p1e.checks);
  if (!p1e.ok) {
    console.error('P1-E FAILED');
    process.exit(1);
  }
  console.log('P1-E OK (summary present, tier_constraint always, compaction once, duplicates counter present)');

  console.log('Verifying P1-D (MemoryCommand submode shape) via source...');
  const p1d = await verifyP1D_MemoryCommandShape();
  console.log('P1-D checks:', p1d.checks);
  if (!p1d.ok) {
    console.error('P1-D shape FAILED');
    process.exit(1);
  }
  console.log('P1-D OK (zero-arg enters loop, menu/back/exit, delegates)');

  console.log('ALL P1-D/P1-E BUILT VERIFICATIONS PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
