// tests/tools/glob.test.ts
// M1-2.1: glob — deep ** matching, ignoreDirs, 200-result cap.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glob } from '../../src/tools/glob.js';
import { walkFiles } from '../../src/tools/walk.js';
import type { ToolContext } from '../../src/tools/types.js';

let root: string;
let ctx: ToolContext;

describe('glob tool', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-glob-'));
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'b.ts'), 'y');
    fs.writeFileSync(path.join(root, 'readme.md'), 'z');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'c.ts'), 'w');
    ctx = { workspaceRoot: root, approvalMode: 'readonly' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches deep ** patterns and ignores node_modules', async () => {
    const r = await glob({ pattern: '**/*.ts' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.includes('src/a.ts'));
    assert.ok(r.output.includes('src/deep/b.ts'));
    assert.ok(!r.output.includes('node_modules'));
  });

  it('returns relative posix paths', async () => {
    const r = await glob({ pattern: 'src/**/*.ts' }, ctx);
    assert.ok(r.ok);
    assert.ok(!r.output.includes('\\'), 'paths must use / separators');
  });

  it('supports * and ? wildcards', async () => {
    const r1 = await glob({ pattern: '*.md' }, ctx);
    assert.ok(r1.output.includes('readme.md'));
    const r2 = await glob({ pattern: 'src/?.ts' }, ctx);
    assert.ok(r2.output.includes('src/a.ts'));
    assert.ok(!r2.output.includes('src/deep/b.ts'));
  });

  it('caps results at 200 with truncated flag', async () => {
    for (let i = 0; i < 210; i++) {
      fs.writeFileSync(path.join(root, 'src', `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const r = await glob({ pattern: 'src/*.txt' }, ctx);
    assert.ok(r.ok);
    assert.equal(r.truncated, true);
    assert.equal(r.meta?.lines, 200);
  });

  it('scan hard-stop mechanism: walkFiles maxFiles truncates deterministically (dogfood-T6)', () => {
    const dir = path.join(root, 'scanstop');
    fs.mkdirSync(dir);
    for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    const r = walkFiles(dir, { maxFiles: 50 });
    assert.equal(r.files.length, 50, 'must stop at the maxFiles hard limit');
    assert.equal(r.truncated, true, 'must flag truncation');
    // default cap (no opts) = 2000
    const d = walkFiles(dir);
    assert.equal(d.files.length, 120);
    assert.equal(d.truncated, false);
  });

  it('rejects escaping base path', async () => {
    const r = await glob({ pattern: '*.txt', path: '..' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PATH_ESCAPED');
  });
});
