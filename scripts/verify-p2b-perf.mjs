// scripts/verify-p2b-perf.mjs
// Pure-Node micro-benchmark for P2-B: single update < 5ms (no spawn, no tsx).
// Uses built dist.

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const root = process.cwd();

async function main() {
  const url = pathToFileURL(pathResolve(root, 'dist/cli/repl/OutputRenderer.js')).href;
  const mod = await import(url);
  const { OutputRendererImpl } = mod;

  // Force TTY for real rendering path
  const orig = process.stdout.isTTY;
  process.stdout.isTTY = true;

  // Capture writes to avoid terminal noise
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  try {
    const r = new OutputRendererImpl();
    const h = r.progressBar(0, 1, 'perf');

    const iters = 200;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      h.update(i / iters);
    }
    const end = process.hrtime.bigint();
    h.done();

    const totalNs = Number(end - start);
    const avgMs = (totalNs / iters) / 1e6;

    // Use stderr so hijacked stdout (for bar) does not swallow the measurement result
    console.error(`P2-B perf: ${iters} updates, avg ${avgMs.toFixed(3)} ms per update`);
    if (avgMs >= 5) {
      console.error('FAIL: single update average >= 5ms');
      process.exit(1);
    }
    console.error('P2-B perf OK (< 5ms per update)');
  } finally {
    process.stdout.isTTY = orig;
    process.stdout.write = origWrite;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
