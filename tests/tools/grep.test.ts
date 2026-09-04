// tests/tools/grep.test.ts
// M1-2.1: grep — multi-file hits, include filter, invalid regex, 250 cap,
// file:line:text output shape.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grep } from '../../src/tools/grep.js';
import type { ToolContext } from '../../src/tools/types.js';

let root: string;
let ctx: ToolContext;

describe('grep tool', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-grep-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'alpha again\nnothing here\n');
    fs.writeFileSync(path.join(root, 'notes.md'), 'alpha in markdown\n');
    ctx = { workspaceRoot: root, approvalMode: 'readonly' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds matches across multiple files with file:line:text output', async () => {
    const r = await grep({ pattern: 'alpha' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.includes('src/a.ts:1:const alpha = 1;'));
    assert.ok(r.output.includes('src/b.ts:1:alpha again'));
    assert.ok(r.output.includes('notes.md:1:alpha in markdown'));
    assert.equal(r.meta?.lines, 3);
  });

  it('respects include glob filter', async () => {
    const r = await grep({ pattern: 'alpha', include: '*.ts' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.includes('src/a.ts'));
    assert.ok(!r.output.includes('notes.md'));
  });

  it('returns INVALID_REGEX for illegal patterns', async () => {
    const r = await grep({ pattern: '([unclosed' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'INVALID_REGEX');
  });

  it('caps matches at 250 with truncated flag', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `hit ${i}`);
    fs.writeFileSync(path.join(root, 'src', 'big.txt'), lines.join('\n'));
    const r = await grep({ pattern: 'hit' }, ctx);
    assert.ok(r.ok);
    assert.equal(r.meta?.lines, 250);
    assert.equal(r.truncated, true);
  });

  it('rejects path escape', async () => {
    const r = await grep({ pattern: 'x', path: '..' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PATH_ESCAPED');
  });

  it('skips binary files', async () => {
    fs.writeFileSync(path.join(root, 'src', 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    const r = await grep({ pattern: 'alpha' }, ctx);
    assert.ok(!r.output.includes('bin.dat'));
  });
});
