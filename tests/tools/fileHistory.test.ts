// tests/tools/fileHistory.test.ts
// M2.1: checkpoint/undo roundtrip — modify→restore, create→undo deletes,
// per-path filter, workspace isolation, reversibility (undo of undo).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkpointFile, latestCheckpoint, undoLatest, clearHistoryForWorkspace } from '../../src/tools/fileHistory.js';

let ws: string;

describe('fileHistory', () => {
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-fh-'));
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'original\nline2\n');
  });
  afterEach(() => {
    clearHistoryForWorkspace(ws);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('modify → undo restores previous content with diff', () => {
    const abs = path.join(ws, 'src', 'a.ts');
    checkpointFile(abs, ws);                       // snapshot before edit
    fs.writeFileSync(abs, 'original\nCHANGED\n');  // simulated real edit

    const r = undoLatest(ws);
    assert.ok(r.ok, r.message);
    assert.equal(r.rel, 'src/a.ts');
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'original\nline2\n');
    assert.ok(r.diff?.some((h) => h.type === 'del' && h.text === 'CHANGED'));
    assert.ok(r.diff?.some((h) => h.type === 'add' && h.text === 'line2'));
  });

  it('undo is reversible (undo of undo returns the edited state)', () => {
    const abs = path.join(ws, 'src', 'a.ts');
    checkpointFile(abs, ws);
    fs.writeFileSync(abs, 'edited\n');
    undoLatest(ws);                                  // back to original
    const r2 = undoLatest(ws);                       // undo the restore → edited again
    assert.ok(r2.ok);
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'edited\n');
  });

  it('undo of a creation deletes the file', () => {
    const abs = path.join(ws, 'created.txt');
    checkpointFile(abs, ws);                         // prevExists=false
    fs.writeFileSync(abs, 'fresh');
    const r = undoLatest(ws);
    assert.ok(r.ok);
    assert.ok(!fs.existsSync(abs), 'freshly created file must be deleted by undo');
  });

  it('rel filter undoes only that path', () => {
    const a = path.join(ws, 'src', 'a.ts');
    const b = path.join(ws, 'src', 'b.ts');
    fs.writeFileSync(b, 'b\n');
    checkpointFile(a, ws);
    fs.writeFileSync(a, 'a2\n');
    checkpointFile(b, ws);
    fs.writeFileSync(b, 'b2\n');

    const r = undoLatest(ws, 'src/a.ts');
    assert.ok(r.ok);
    assert.equal(r.rel, 'src/a.ts');
    assert.equal(fs.readFileSync(a, 'utf-8'), 'original\nline2\n');
    assert.equal(fs.readFileSync(b, 'utf-8'), 'b2\n', 'b untouched');
  });

  it('empty history → friendly message', () => {
    const r = undoLatest(ws);
    assert.equal(r.ok, false);
    assert.ok(r.message.includes('没有可撤销'));
  });

  it('latestCheckpoint returns the most recent entry', () => {
    const abs = path.join(ws, 'src', 'a.ts');
    checkpointFile(abs, ws);
    fs.writeFileSync(abs, 'v2\n');
    checkpointFile(abs, ws);
    const e = latestCheckpoint(ws);
    assert.ok(e);
    // latest backup must contain the CURRENT (pre-next-mutation) content
    assert.equal(fs.readFileSync(e.backupPath!, 'utf-8'), 'v2\n');
  });
});
