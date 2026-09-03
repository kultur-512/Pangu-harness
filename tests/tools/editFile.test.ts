// tests/tools/editFile.test.ts
// M1-2.3: edit_file — unique-match success, 0/many match errors, replace_all,
// RBW rejection, atomic behavior.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEditFileTool } from '../../src/tools/editFile.js';
import type { ToolContext } from '../../src/tools/types.js';

let root: string;
let ctx: ToolContext;
let readFiles: Set<string>;

const FILE = 'src.ts';
const CONTENT = 'function add(a, b) {\n  return a - b;\n}\n';

describe('editFile tool', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-edit-'));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, FILE), CONTENT);
    fs.writeFileSync(path.join(root, 'sub', FILE), CONTENT);
    readFiles = new Set([path.resolve(path.join(root, FILE))]);
    ctx = { workspaceRoot: root, approvalMode: 'full' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('unique match succeeds and writes new content + diff', async () => {
    const tool = createEditFileTool({ readFiles });
    const r = await tool({ file_path: FILE, old_string: 'return a - b;', new_string: 'return a + b;' }, ctx);
    assert.ok(r.ok, r.output);
    assert.ok(r.output.startsWith('EDIT_SUCCESS:'));
    assert.equal(fs.readFileSync(path.join(root, FILE), 'utf-8'), CONTENT.replace('a - b', 'a + b'));
    assert.ok(r.meta?.diff?.some((h) => h.type === 'del' && h.text.includes('a - b')));
    assert.ok(r.meta?.diff?.some((h) => h.type === 'add' && h.text.includes('a + b')));
  });

  it('zero matches → error mentions found 0', async () => {
    const tool = createEditFileTool({ readFiles });
    const r = await tool({ file_path: FILE, old_string: 'NOT-PRESENT', new_string: 'x' }, ctx);
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('found 0'));
  });

  it('multiple matches without replace_all → error mentions found N', async () => {
    fs.writeFileSync(path.join(root, FILE), 'dup\ndup\nother');
    const tool = createEditFileTool({ readFiles });
    const r = await tool({ file_path: FILE, old_string: 'dup', new_string: 'x' }, ctx);
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('found 2'));
    assert.equal(fs.readFileSync(path.join(root, FILE), 'utf-8'), 'dup\ndup\nother', 'file untouched on error');
  });

  it('replace_all=true replaces every occurrence', async () => {
    fs.writeFileSync(path.join(root, FILE), 'dup\ndup\nother');
    const tool = createEditFileTool({ readFiles });
    const r = await tool({ file_path: FILE, old_string: 'dup', new_string: 'uniq', replace_all: 'true' }, ctx);
    assert.ok(r.ok, r.output);
    assert.equal(fs.readFileSync(path.join(root, FILE), 'utf-8'), 'uniq\nuniq\nother');
  });

  it('RBW: existing unread file → denied, untouched', async () => {
    const recordings: any[] = [];
    const tool = createEditFileTool({
      readFiles: new Set(), // sub/FILE deliberately unread
      failureMemory: { record: (cat: any, desc: string) => recordings.push({ cat, desc }) },
    });
    const r = await tool({ file_path: 'sub/' + FILE, old_string: 'a - b', new_string: 'a + b' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'RBW_VIOLATION');
    assert.equal(fs.readFileSync(path.join(root, 'sub', FILE), 'utf-8'), CONTENT);
    assert.equal(recordings[0].cat, 'READ_BEFORE_WRITE_VIOLATION');
  });

  it('old_string == new_string → INVALID_PARAMS', async () => {
    const tool = createEditFileTool({ readFiles });
    const r = await tool({ file_path: FILE, old_string: 'same', new_string: 'same' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'INVALID_PARAMS');
  });

  it('atomic: no leftover tmp files after failed rename (target is a dir)', async () => {
    fs.mkdirSync(path.join(root, 'adir'));
    readFiles.add(path.resolve(path.join(root, 'adir')));
    const tool = createEditFileTool({ readFiles });
    const r = await tool({ file_path: 'adir', old_string: 'x', new_string: 'y' }, ctx);
    assert.equal(r.ok, false);
    const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('rejects path escape', async () => {
    const tool = createEditFileTool({ readFiles });
    const r = await tool({ file_path: '../x.ts', old_string: 'a', new_string: 'b' }, ctx);
    assert.equal(r.ok, false);
  });
});
