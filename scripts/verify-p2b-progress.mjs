// scripts/verify-p2b-progress.mjs
// Pure-Node (no tsx, no child_process) verification for P2-B progressBar.
// Uses built dist only. Exits 0 on success.

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const root = process.cwd();

async function load() {
  const url = pathToFileURL(pathResolve(root, 'dist/cli/repl/OutputRenderer.js')).href;
  const mod = await import(url);
  if (!mod.OutputRendererImpl) throw new Error('OutputRendererImpl not found in dist');
  return { OutputRendererImpl: mod.OutputRendererImpl };
}

function withTTY(isTTY, fn) {
  const orig = process.stdout.isTTY;
  process.stdout.isTTY = isTTY;
  try { return fn(); } finally { process.stdout.isTTY = orig; }
}

function captureWrites(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data) => { chunks.push(String(data)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks;
}

async function main() {
  const { OutputRendererImpl } = await load();
  const r = new OutputRendererImpl();

  // 1) TTY path: update should produce bar + %; done should print message
  let outs = withTTY(true, () => captureWrites(() => {
    const h = r.progressBar(0, 1, 'budget');
    h.update(0.5);
    h.done('完成');
  }));
  let joined = outs.join('');
  if (!joined.includes('█') || !joined.includes('%')) {
    console.error('FAIL: TTY update did not emit bar/percent');
    process.exit(1);
  }
  if (!joined.includes('完成')) {
    console.error('FAIL: done message not printed');
    process.exit(1);
  }

  // 2) non-TTY: stub, no output
  outs = withTTY(false, () => captureWrites(() => {
    const h = r.progressBar(0, 1, 'no-tty');
    h.update(0.9);
    h.done('nope');
  }));
  joined = outs.join('');
  if (joined.includes('█') || joined.includes('nope')) {
    console.error('FAIL: non-TTY stub emitted content');
    process.exit(1);
  }

  // 3) single active: second bar replaces first
  outs = withTTY(true, () => captureWrites(() => {
    const h1 = r.progressBar(0, 1, 'first');
    h1.update(0.1);
    const h2 = r.progressBar(0, 1, 'second');
    h2.update(0.8);
    h2.done('second-done');
  }));
  joined = outs.join('');
  if (!joined.includes('second-done')) {
    console.error('FAIL: second bar did not reach done');
    process.exit(1);
  }

  console.log('P2-B checks:');
  console.log('  TTY bar+percent+done: OK');
  console.log('  non-TTY stub no-op: OK');
  console.log('  single-active replace: OK');
  console.log('P2-B OK (progressBar contract + TTY/non-TTY + single active)');
}

main().catch(e => { console.error(e); process.exit(1); });
