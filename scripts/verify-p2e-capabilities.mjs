// scripts/verify-p2e-capabilities.mjs
// Pure-Node (no tsx, no child spawn) verification for P2-E TerminalCapabilities.
// Exercises detection with injected TerminalEnv (no real console side effects).
// Must pass in <1ms per detect on average.

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const root = process.cwd();

async function load() {
  const url = pathToFileURL(pathResolve(root, 'dist/cli/repl/TerminalCapabilities.js')).href;
  const mod = await import(url);
  if (!mod.detectTerminalCapabilities) throw new Error('detectTerminalCapabilities not exported');
  return {
    detect: mod.detectTerminalCapabilities,
    reset: mod.resetTerminalCapabilitiesCache || (() => {}),
  };
}

function makeEnv(overrides) {
  return {
    platform: overrides.platform ?? 'win32',
    env: overrides.env ?? {},
    isTTY: overrides.isTTY ?? true,
  };
}

async function main() {
  const { detect, reset } = await load();

  // 1) non-TTY: all false
  reset();
  let c = detect(makeEnv({ platform: 'linux', env: {}, isTTY: false }));
  if (c.color || c.keypress || c.multiline || c.progress || c.ansiCursor) {
    console.error('FAIL non-TTY'); process.exit(1);
  }

  // 2) Unix TTY: all true (color + interactive)
  reset();
  c = detect(makeEnv({ platform: 'linux', env: { TERM: 'xterm-256color' }, isTTY: true }));
  if (!(c.color && c.keypress && c.multiline && c.progress && c.ansiCursor)) {
    console.error('FAIL unix-tty'); process.exit(1);
  }

  // 3) Windows Terminal (WT_SESSION): full on TTY
  reset();
  c = detect(makeEnv({ platform: 'win32', env: { WT_SESSION: '1', TERM: 'xterm-256color' }, isTTY: true }));
  if (!(c.color && c.keypress && c.multiline && c.progress && c.ansiCursor)) {
    console.error('FAIL wt'); process.exit(1);
  }

  // 4) Old Windows cmd (no WT, no COLORTERM, TERM not sufficient): advanced features off
  reset();
  c = detect(makeEnv({ platform: 'win32', env: { TERM: 'xterm' }, isTTY: true }));
  if (c.keypress || c.multiline || c.progress || c.ansiCursor) {
    console.error('FAIL old-cmd'); process.exit(1);
  }

  // 5) PowerShell ISE: keypress/multiline/progress/ansiCursor disabled
  reset();
  c = detect(makeEnv({
    platform: 'win32',
    env: { PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules', TERM: 'xterm' },
    isTTY: true,
  }));
  if (c.keypress || c.multiline || c.progress || c.ansiCursor) {
    console.error('FAIL ise'); process.exit(1);
  }

  // 6) Performance: average detect < 1ms over many calls
  reset();
  const env = makeEnv({ platform: 'linux', env: { TERM: 'xterm-256color' }, isTTY: true });
  const iters = 2000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    detect(env);
  }
  const t1 = process.hrtime.bigint();
  const avgMs = Number(t1 - t0) / iters / 1e6;
  if (avgMs >= 1) {
    console.error('FAIL perf avgMs=' + avgMs.toFixed(4));
    process.exit(1);
  }

  console.error('P2-E checks:');
  console.error('  non-TTY disables all: OK');
  console.error('  Unix TTY full: OK');
  console.error('  WT full: OK');
  console.error('  old Windows cmd disables advanced: OK');
  console.error('  ISE disables advanced: OK');
  console.error('  detect <1ms: OK (avg ' + avgMs.toFixed(4) + 'ms)');
  console.error('P2-E OK');
}

main().catch(e => { console.error(e); process.exit(1); });
