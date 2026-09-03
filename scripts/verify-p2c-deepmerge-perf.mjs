// scripts/verify-p2c-deepmerge-perf.mjs
// Pure-Node (no tsx, no child spawn) perf check for P2-C deepMerge < 1ms.
// Uses built dist artifact.

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const root = process.cwd();

async function main() {
  const url = pathToFileURL(pathResolve(root, 'dist/cli/repl/ConfigManager.js')).href;
  const mod = await import(url);
  const { deepMerge } = mod;
  if (typeof deepMerge !== 'function') {
    console.error('FAIL: deepMerge not exported');
    process.exit(1);
  }

  // Realistic nested object + array mix
  const base = {
    tier: 'high',
    repl: { autoCompact: true, maxHistory: 100, skipFor: ['quick'] },
    memory: { autoRefine: false, maxCardsPerLoad: 8 },
    nested: { a: { b: { c: 1, d: [1,2,3] } } },
  };
  const override = {
    tier: 'max',
    repl: { maxHistory: 200, colorEnabled: true },
    memory: { maxCardsPerLoad: 12 },
    nested: { a: { b: { c: 99 } } },
  };

  const iters = 1000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    deepMerge(base, override);
  }
  const end = process.hrtime.bigint();
  const avgMs = (Number(end - start) / iters) / 1e6;

  // Use stderr so any hijacked stdout does not swallow result
  console.error(`P2-C deepMerge perf: ${iters} iterations, avg ${avgMs.toFixed(4)} ms`);
  if (avgMs >= 1) {
    console.error('FAIL: deepMerge average >= 1ms');
    process.exit(1);
  }
  console.error('P2-C deepMerge perf OK (< 1ms)');
}

main().catch(e => { console.error(e); process.exit(1); });
