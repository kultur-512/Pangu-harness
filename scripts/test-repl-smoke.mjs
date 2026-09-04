// scripts/test-repl-smoke.mjs
// Smoke test for built ZIS REPL (blueprint v1.1)
// Runs runOneShot(['help']) and checks it doesn't hard-crash on logic.
// May get EPERM on ~/.panshalach in sandboxed envs; we treat that as non-fatal if help output happened.

import { runOneShot } from '../dist/cli/repl.js';

async function main() {
  // Capture stdout to detect if help text was produced
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => {
    captured += String(chunk);
    return origWrite(chunk);
  };

  try {
    await runOneShot(['help']);
  } catch (e) {
    // If it's only a filesystem permission error on home dir persistence, tolerate it.
    const msg = e && e.message ? e.message : String(e);
    if (/EPERM|mkdir|permission/i.test(msg)) {
      console.error('\n[smoke] Non-fatal FS error during oneShot (likely ~/.panshalach sandbox):', msg);
    } else {
      console.error('\n[smoke] Unexpected error:', msg);
      process.exitCode = 1;
    }
  } finally {
    process.stdout.write = origWrite;
  }

  const looksLikeHelp = /可用命令|help|system|state|task/i.test(captured);
  console.log('\n[smoke] Captured output includes help-like content:', looksLikeHelp);
  console.log('[smoke] First 300 chars of output:\n' + captured.slice(0, 300));

  if (!looksLikeHelp) {
    console.error('[smoke] FAIL: did not see expected help content.');
    process.exitCode = 1;
  } else {
    console.log('[smoke] PASS (logical execution succeeded).');
  }
}

main().catch(e => {
  console.error('[smoke] Top-level crash:', e && e.message ? e.message : e);
  process.exit(1);
});
