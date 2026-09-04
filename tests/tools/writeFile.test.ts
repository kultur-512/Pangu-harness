// tests/tools/writeFile.test.ts
// M1-2.3: write_file — new file, existing+read (success+diff), existing unread
// (RBW), 1MB cap, dir auto-create, atomicity (no partial file, tmp cleaned).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteFileTool } from '../../src/tools/writeFile.js';
import type { ToolContext } from '../../src/tools/types.js';

let root: string;
let ctx: ToolContext;

describe('writeFile tool', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-write-'));
    ctx = { workspaceRoot: root, approvalMode: 'full' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes a new file and produces an all-add diff', async () => {
    const tool = createWriteFileTool({ readFiles: new Set() });
    const r = await tool({ file_path: 'new.txt', content: 'a\nb\n' }, ctx);
    assert.ok(r.ok, r.output);
    assert.ok(fs.readFileSync(path.join(root, 'new.txt'), 'utf-8') === 'a\nb\n');
    assert.ok(r.meta?.diff?.every((h) => h.type === 'add'));
    assert.ok(r.output.startsWith('WRITE_SUCCESS: new.txt'));
  });

  it('existing+read → success with real diff', async () => {
    fs.writeFileSync(path.join(root, 'code.txt'), 'one\ntwo\nthree');
    const readFiles = new Set<string>([path.resolve(path.join(root, 'code.txt'))]);
    const tool = createWriteFileTool({ readFiles });
    const r = await tool({ file_path: 'code.txt', content: 'one\nTWO\nthree' }, ctx);
    assert.ok(r.ok, r.output);
    assert.ok(r.meta?.diff?.some((h) => h.type === 'del' && h.text === 'two'));
    assert.ok(r.meta?.diff?.some((h) => h.type === 'add' && h.text === 'TWO'));
    assert.equal(fs.readFileSync(path.join(root, 'code.txt'), 'utf-8'), 'one\nTWO\nthree');
  });

  it('existing+unread → RBW_VIOLATION, file untouched, diff still provided', async () => {
    const p = path.join(root, 'rbw.txt');
    fs.writeFileSync(p, 'original');
    const recordings: any[] = [];
    const tool = createWriteFileTool({
      readFiles: new Set(),
      failureMemory: { record: (cat: any, desc: string) => recordings.push({ cat, desc }) },
    });
    const r = await tool({ file_path: 'rbw.txt', content: 'hacked' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'RBW_VIOLATION');
    assert.ok(r.output.includes('写入前必须先读取目标文件'));
    assert.equal(fs.readFileSync(p, 'utf-8'), 'original', 'file must be untouched');
    assert.ok((r.meta?.diff?.length ?? 0) > 0, 'diff computed even on denial');
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].cat, 'READ_BEFORE_WRITE_VIOLATION');
  });

  it('rejects content over 1MB', async () => {
    const tool = createWriteFileTool({ readFiles: new Set() });
    const r = await tool({ file_path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 1) }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'FILE_TOO_LARGE');
  });

  it('auto-creates missing directories', async () => {
    const tool = createWriteFileTool({ readFiles: new Set() });
    const r = await tool({ file_path: 'deep/nested/dir/file.txt', content: 'deep' }, ctx);
    assert.ok(r.ok, r.output);
    assert.equal(fs.readFileSync(path.join(root, 'deep', 'nested', 'dir', 'file.txt'), 'utf-8'), 'deep');
  });

  it('atomic: failed rename leaves no tmp file and no partial target', async () => {
    // Target path is an existing DIRECTORY → renameSync onto it fails.
    fs.mkdirSync(path.join(root, 'targetdir'));
    const tool = createWriteFileTool({ readFiles: new Set() });
    const r = await tool({ file_path: 'targetdir', content: 'x' }, ctx);
    assert.equal(r.ok, false);
    // No leftover tmp files in the parent dir
    const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('rejects path escape', async () => {
    const tool = createWriteFileTool({ readFiles: new Set() });
    const r = await tool({ file_path: '../evil.txt', content: 'x' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PATH_ESCAPED');
  });
});
