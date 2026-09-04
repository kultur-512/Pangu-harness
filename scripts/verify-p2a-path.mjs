// scripts/verify-p2a-path.mjs
// Pure-Node (no tsx, no child_process spawn) verification for P2-A @path expansion.
// Uses only built dist/ artifacts. Exits 0 on success.

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = process.cwd();

async function load() {
  const typesUrl = pathToFileURL(pathResolve(root, 'dist/cli/repl/types.js')).href;
  const mod = await import(typesUrl);
  if (!mod.expandAtPaths) {
    // PathExpansionResult may be erased at runtime (interface), check function
    throw new Error('expandAtPaths not exported from dist');
  }
  return { expandAtPaths: mod.expandAtPaths };
}

function makeWorkspace() {
  const base = mkdtempSync(pathResolve(tmpdir(), 'pangu-p2a-'));
  // create some structure
  mkdirSync(pathResolve(base, 'src'), { recursive: true });
  mkdirSync(pathResolve(base, 'docs'), { recursive: true });
  writeFileSync(pathResolve(base, 'src', 'main.ts'), 'export const x=1;');
  writeFileSync(pathResolve(base, 'README.md'), '# test');
  return base;
}

function cleanup(dir) {
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function main() {
  const { expandAtPaths } = await load();

  const ws = makeWorkspace();
  const wsRoot = pathResolve(ws);

  try {
    // 1) inside path should expand
    const input1 = 'fix bug in @src/main.ts and update docs';
    const r1 = expandAtPaths(input1, ws);
    if (!r1.result.expanded.some(p => p.includes('src') && p.includes('main.ts'))) {
      console.error('FAIL: expected inside path to be expanded');
      process.exit(1);
    }
    if (r1.result.rejected.length !== 0) {
      console.error('FAIL: no rejected expected for inside path');
      process.exit(1);
    }
    if (!r1.cleaned.includes('fix bug in') || r1.cleaned.includes('@src')) {
      console.error('FAIL: cleaned should remove @token for inside path');
      process.exit(1);
    }

    // 2) outside path (parent traversal) should be rejected
    const input2 = 'do not touch @../evil.txt';
    const r2 = expandAtPaths(input2, ws);
    if (r2.result.rejected.length === 0) {
      console.error('FAIL: parent traversal should be rejected');
      process.exit(1);
    }
    if (r2.result.expanded.length !== 0) {
      console.error('FAIL: no expanded expected for outside path');
      process.exit(1);
    }

    // 3) absolute outside should be rejected
    const outsideAbs = pathResolve(ws, '..', 'outside-abs.txt');
    const input3 = 'avoid @' + outsideAbs.replace(/\\/g, '/');
    const r3 = expandAtPaths(input3, ws);
    if (r3.result.rejected.length === 0) {
      console.error('FAIL: absolute outside should be rejected');
      process.exit(1);
    }

    // 4) boundary: exact workspace root token should be accepted (edge case)
    // Use a token that resolves exactly to wsRoot
    const input4 = 'root @.';
    const r4 = expandAtPaths(input4, ws);
    if (r4.result.expanded.length === 0) {
      console.error('FAIL: @. should expand to workspace root');
      process.exit(1);
    }

    // 5) multiple mixed
    const input5 = 'touch @src/main.ts and @docs and @../bad';
    const r5 = expandAtPaths(input5, ws);
    if (r5.result.expanded.length < 2) {
      console.error('FAIL: expected at least two expanded');
      process.exit(1);
    }
    if (!r5.result.rejected.some(t => t.includes('bad'))) {
      console.error('FAIL: expected ../bad to be rejected');
      process.exit(1);
    }

    console.log('P2-A checks:');
    console.log('  inside expanded:', r1.result.expanded.length);
    console.log('  outside rejected (parent):', r2.result.rejected.length);
    console.log('  absolute outside rejected:', r3.result.rejected.length);
    console.log('  root @. expanded:', r4.result.expanded.length);
    console.log('  mixed expanded/rejected:', r5.result.expanded.length, '/', r5.result.rejected.length);
    console.log('P2-A OK (path.resolve + prefix check + rejectedPaths + cleaned)');

  } finally {
    cleanup(ws);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
