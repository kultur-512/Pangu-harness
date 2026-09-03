// tests/tools/readFile.test.ts
// M1-2.1: read_file semantics — cat -n numbering, offset/limit paging,
// nextOffset continuation hint, binary withholding, not-found.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from '../../src/tools/readFile.js';
import type { ToolContext } from '../../src/tools/types.js';

let root: string;
let ctx: ToolContext;

describe('readFile tool', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-read-'));
    const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(root, 'big.txt'), lines.join('\n'));
    fs.writeFileSync(path.join(root, 'small.txt'), 'alpha\nbeta\ngamma');
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x00, 0x04]));
    // dogfood-T2: control-char boundary file — 0x1F (US, byte 31) only, no NULs.
    // looksBinary must flag byte 31 (b > 13 && b < 32 includes 31).
    fs.writeFileSync(path.join(root, 'ctrl31.dat'), Buffer.alloc(64, 0x1f));
    // dogfood-③: boundary pairs for the b < 9 and b < 32 edges
    fs.writeFileSync(path.join(root, 'ctrl08.dat'), Buffer.alloc(64, 0x08)); // 0x08 backspace < 0x09 → suspicious
    fs.writeFileSync(path.join(root, 'tab09.dat'), Buffer.alloc(64, 0x09));  // 0x09 TAB == lower edge → NOT suspicious
    fs.writeFileSync(path.join(root, 'space20.dat'), Buffer.alloc(64, 0x20));// 0x20 space == upper edge → NOT suspicious
    ctx = { workspaceRoot: root, approvalMode: 'readonly' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns cat -n numbered lines with header', async () => {
    const r = await readFile({ file_path: 'small.txt' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.startsWith('READ_SUCCESS: small.txt'));
    assert.ok(r.output.includes('1\talpha'));
    assert.ok(r.output.includes('2\tbeta'));
    assert.ok(r.output.includes('3\tgamma'));
  });

  it('respects default 500-line limit and reports nextOffset', async () => {
    const r = await readFile({ file_path: 'big.txt' }, ctx);
    assert.ok(r.ok);
    assert.equal(r.truncated, true);
    assert.equal(r.meta?.lines, 500);
    assert.equal(r.meta?.nextOffset, 501);
    assert.ok(r.output.includes('续读位置：offset=501'));
    assert.ok(r.output.includes('500\tline 500'));
    assert.ok(!r.output.includes('501\tline 501'));
  });

  it('respects explicit offset/limit', async () => {
    const r = await readFile({ file_path: 'big.txt', offset: '10', limit: '3' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.includes('10\tline 10'));
    assert.ok(r.output.includes('12\tline 12'));
    assert.ok(!r.output.includes('13\tline 13'));
    assert.equal(r.meta?.nextOffset, 13);
  });

  it('handles empty file', async () => {
    const r = await readFile({ file_path: 'empty.txt' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.includes('(empty file)'));
  });

  it('withholds binary content with a notice', async () => {
    const r = await readFile({ file_path: 'bin.dat' }, ctx);
    assert.ok(r.output.includes('binary file'));
    assert.ok(!r.output.includes('\u0000'), 'raw binary bytes must not leak');
  });

  it('flags byte-31 control-char files as binary (boundary 31 vs 32) (dogfood-T2)', async () => {
    const r = await readFile({ file_path: 'ctrl31.dat' }, ctx);
    assert.ok(r.output.includes('binary file'),
      'a file of 0x1F (byte 31) control chars must be detected as binary');
    assert.ok(!r.output.includes('READ_SUCCESS'), 'binary content must be withheld, not returned');
  });

  // dogfood-③: looksBinary boundary pairs (regression guard for the T2-seed
  // 31-vs-32 off-by-one). If that off-by-one were re-seeded, the ctrl31 case
  // below goes RED — the seeded bug escaped the pre-T2 suite because no test
  // covered these boundary values.
  it('boundary 0x1F/0x20: byte 31 flagged binary, byte 32 (space) is text (dogfood-③)', async () => {
    const bin = await readFile({ file_path: 'ctrl31.dat' }, ctx);
    assert.ok(bin.output.includes('binary file'), '0x1F (31) must be suspicious (b<32)');
    const txt = await readFile({ file_path: 'space20.dat' }, ctx);
    assert.ok(txt.ok && txt.output.startsWith('READ_SUCCESS: space20.dat'), '0x20 (32) must be text');
  });

  it('boundary 0x08/0x09: byte 8 flagged binary, byte 9 (TAB) is text (dogfood-③)', async () => {
    const bin = await readFile({ file_path: 'ctrl08.dat' }, ctx);
    assert.ok(bin.output.includes('binary file'), '0x08 (8) must be suspicious (b<9)');
    const txt = await readFile({ file_path: 'tab09.dat' }, ctx);
    assert.ok(txt.ok && txt.output.startsWith('READ_SUCCESS: tab09.dat'), '0x09 (TAB) must be text');
  });

  it('rejects path escape', async () => {
    const r = await readFile({ file_path: '../escape.txt' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PATH_ESCAPED');
  });

  it('rejects missing file', async () => {
    const r = await readFile({ file_path: 'nope.txt' }, ctx);
    assert.equal(r.ok, false);
  });

  // S3: file content that contains key material must be redacted before it
  // reaches the model / terminal — same leak chain as the anchor redaction.
  it('redacts sk- keys and apiKey pairs from file content (S3)', async () => {
    fs.writeFileSync(
      path.join(root, 'secrets.json'),
      '{\n  "apiKey": "sk-tp-SECRET-VALUE-1234567890",\n  "note": "plain text survives"\n}\n'
    );
    const r = await readFile({ file_path: 'secrets.json' }, ctx);
    assert.ok(r.ok);
    assert.ok(!r.output.includes('sk-tp-SECRET'), 'sk- key leaked from read_file output');
    assert.ok(r.output.includes('plain text survives'), 'ordinary text must not be damaged');
    assert.ok(r.output.includes('REDACTED') || r.output.includes('***'), 'expected a redaction marker');
  });
});
