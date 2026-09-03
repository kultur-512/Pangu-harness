// scripts/verify-p1e-injection.mjs
// Lightweight verification for P1-E (PromptBuilder dedup + <injection_summary>)
// Does NOT use node:test runner to avoid sandbox spawn EPERM in this env.
// Runs via tsx and exits 0 on success, 1 on failure. Pure import + call.

import { Session } from '../src/cli/repl/Session.js';
import { TierRegistry } from '../src/tiers/TierConfig.js';
import { PromptBuilder } from '../src/cli/repl/PromptBuilder.js';

async function main() {
  const sess = new Session({ tier: 'high' });
  // Create enough turns to trigger compaction note (>12)
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
  const hasTierConstraint = prompt.includes('<tier_constraint tier="high">');
  const compactionMatches = (prompt.match(/历史较长，已做内部压缩/g) || []).length;

  // Also exercise tryInject path indirectly via a second build (should not duplicate system identity etc.)
  const prompt2 = await pb.buildForTask('second task');

  // Basic sanity
  if (!hasSummary) {
    console.error('FAIL: missing <injection_summary>');
    process.exit(1);
  }
  if (!hasTierConstraint) {
    console.error('FAIL: tier_constraint not present');
    process.exit(1);
  }
  if (compactionMatches !== 1) {
    console.error('FAIL: compaction note duplicated or missing; count=' + compactionMatches);
    process.exit(1);
  }

  // Memory card presence flag may be 0 or 1 depending on store state; we only assert shape
  if (!prompt.includes('"tierConstraint": true')) {
    console.error('FAIL: injection_summary.tierConstraint not true');
    process.exit(1);
  }

  console.log('P1-E injection_summary present:', hasSummary);
  console.log('P1-E tier_constraint present:', hasTierConstraint);
  console.log('P1-E compaction note count (must be 1):', compactionMatches);
  console.log('P1-E second build length (sanity):', prompt2.length);
  console.log('P1-E OK');
}

main().catch(e => { console.error(e); process.exit(1); });
