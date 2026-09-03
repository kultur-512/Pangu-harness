// tests/repl/EnvContext.test.ts
// P1-T17 (Codex): incremental environment delta — unchanged → empty injection;
// cwd/branch/fs changes → only the changed fields; render block format.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildEnvDelta, renderEnvDelta, describeEnvironment, renderEnvSelfDescription, renderEnvSummary,
} from '../../src/cli/repl/EnvContext.js';

const BASE = { cwd: '/ws', branch: 'main', fs: ['src/a.ts'] };

describe('buildEnvDelta / renderEnvDelta (P1-T17)', () => {
  it('identical snapshots → unchanged, empty render', () => {
    const d = buildEnvDelta(BASE, { ...BASE });
    assert.equal(d.unchanged, true);
    assert.equal(renderEnvDelta(d), '');
  });

  it('first snapshot (prev null) → cwd baseline only', () => {
    const d = buildEnvDelta(null, { cwd: '/ws', branch: 'main' });
    assert.equal(d.cwd, '/ws');
    assert.equal(d.branch, undefined, 'first snapshot does not flood branch/fs');
    assert.ok(renderEnvDelta(d).includes('cwd: /ws'));
  });

  it('branch change → only branch field injected', () => {
    const d = buildEnvDelta(BASE, { ...BASE, branch: 'dev' });
    assert.equal(d.unchanged, false);
    assert.equal(d.branch, 'dev');
    assert.equal(d.cwd, undefined, 'unchanged fields omitted');
    const r = renderEnvDelta(d);
    assert.ok(r.includes('branch: dev'));
    assert.ok(!r.includes('cwd:'));
  });

  it('fs change → changed-files list injected', () => {
    const d = buildEnvDelta(BASE, { ...BASE, fs: ['src/a.ts', 'src/b.ts'] });
    assert.equal(d.unchanged, false);
    const r = renderEnvDelta(d);
    assert.ok(r.includes('changed: src/a.ts, src/b.ts'));
  });

  it('cwd change → cwd injected', () => {
    const d = buildEnvDelta(BASE, { ...BASE, cwd: '/other' });
    assert.ok(renderEnvDelta(d).includes('cwd: /other'));
  });
});

describe('describeEnvironment / renderEnvSummary (A-T12)', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-env-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('probes runtime, package manager, deps, verification, lockfiles', () => {
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test', build: 'tsc' },
      dependencies: { a: '^1.0.0', b: '^2.0.0' },
      devDependencies: { c: '^3.0.0' },
    }));
    fs.writeFileSync(path.join(ws, 'package-lock.json'), '{}');
    const desc = describeEnvironment(ws);
    assert.ok(desc.runtime.node.startsWith('v'), 'node version present');
    assert.equal(typeof desc.runtime.platform, 'string');
    assert.equal(desc.packageManager, 'npm');
    assert.deepEqual(desc.deps.map((d) => d.name), ['a', 'b']);
    assert.deepEqual(desc.devDeps.map((d) => d.name), ['c']);
    assert.ok(desc.verification.some((v) => v.includes('node --test')));
    assert.deepEqual(desc.lockfiles, ['package-lock.json']);
  });

  it('no package.json → empty deps + empty verification (graceful)', () => {
    const desc = describeEnvironment(ws);
    assert.deepEqual(desc.deps, []);
    assert.deepEqual(desc.verification, []);
    assert.ok(desc.runtime.node, 'runtime still probed');
  });

  it('renderEnvSummary is ≤10 lines and mentions ENV.md when truncated', () => {
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
      scripts: { test: 't' },
      dependencies: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`dep${i}`, '^1.0.0'])),
    }));
    const summary = renderEnvSummary(describeEnvironment(ws), 10);
    assert.ok(summary.split('\n').length <= 10, `summary too long: ${summary.split('\n').length} lines`);
    // aggressive cap → truncation marker + pointer to full file
    const tight = renderEnvSummary(describeEnvironment(ws), 3);
    assert.ok(tight.split('\n').length <= 4);
    assert.ok(tight.includes('ENV.md'), 'points to full file when truncated');
  });

  it('renderEnvSelfDescription is stable and complete', () => {
    const md = renderEnvSelfDescription(describeEnvironment(ws));
    assert.ok(md.includes('# Environment Self-Description'));
    assert.ok(md.includes('Node '));
  });
});
