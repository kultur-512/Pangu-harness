// tests/tools/fileHistory.test.ts
// M2.1: checkpoint/undo roundtrip — modify→restore, create→undo deletes,
// per-path filter, workspace isolation, reversibility (undo of undo).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkpointFile, latestCheckpoint, undoLatest, clearHistoryForWorkspace, checkpointBeforeMutation, checkpointFileAt, previewRewindToTurn, rewindToTurn } from '../../src/tools/fileHistory.js';

let ws: string;

describe('fileHistory', () => {
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-fh-'));
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

// ==================== P1: checkpoint realpath 逃逸防御 ====================
describe('fileHistory escape defense (realpath)', () => {
  let ws: string;
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-fh-esc-'));
    const outside = path.join(base, 'outside');
    ws = path.join(base, 'ws');
    fs.mkdirSync(outside);
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
    // junction (Windows) / dir symlink (POSIX) — both resolvable by realpathSync
    fs.symlinkSync(outside, path.join(ws, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  });

  afterEach(() => {
    // best-effort: remove any history this workspace created (incl. leaked backups)
    try {
      const e = latestCheckpoint(ws);
      if (e?.backupPath) fs.rmSync(path.dirname(e.backupPath), { recursive: true, force: true });
    } catch {}
    clearHistoryForWorkspace(ws);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('checkpointBeforeMutation refuses to snapshot through a workspace-escaping link', () => {
    let threw: unknown = null;
    try {
      checkpointBeforeMutation('write_file', { file_path: path.join('link', 'secret.txt') }, ws);
    } catch (e) { threw = e; }
    assert.ok(threw, 'escaping path must be refused (skipped with an explicit error), not silently snapshotted');
    assert.ok(/CHECKPOINT/i.test(String((threw as Error)?.message)), `explicit checkpoint error expected, got: ${String(threw)}`);
    const e = latestCheckpoint(ws);
    assert.equal(e, null, 'no index entry / backup may exist for the escaping path');
    if (e?.backupPath) {
      assert.ok(!fs.readFileSync(e.backupPath, 'utf-8').includes('TOP-SECRET-OUTSIDE'), 'external content leaked into a backup copy');
    }
  });

  it('fresh create through an escaping link is also refused (no __ABSENT__ marker outside)', () => {
    assert.throws(
      () => checkpointBeforeMutation('write_file', { file_path: path.join('link', 'newfile.txt') }, ws),
      /CHECKPOINT/i
    );
    assert.equal(latestCheckpoint(ws), null);
  });

  it('normal in-workspace checkpoints still work (no overblock)', () => {
    const abs = path.join(ws, 'normal.txt');
    fs.writeFileSync(abs, 'v1');
    checkpointBeforeMutation('write_file', { file_path: 'normal.txt' }, ws);
    const e = latestCheckpoint(ws);
    assert.ok(e, 'in-workspace checkpoint must still be created');
    assert.equal(e!.rel, 'normal.txt');
    assert.equal(fs.readFileSync(e!.backupPath!, 'utf-8'), 'v1');
  });
});

// ==================== P2: rewind/undo/clear 健壮性 ====================
describe('fileHistory hygiene (rewind partial failure / undo tmp residue / clear recursive)', () => {
  let ws: string;

  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-fh-hyg-')); });
  afterEach(() => { clearHistoryForWorkspace(ws); fs.rmSync(ws, { recursive: true, force: true }); });

  it('clearHistoryForWorkspace removes the backup directory (recursive rm)', () => {
    const abs = path.join(ws, 'a.txt');
    fs.writeFileSync(abs, 'v1');
    checkpointFile(abs, ws);
    const e = latestCheckpoint(ws);
    assert.ok(e?.backupPath);
    const backupDir = path.dirname(e.backupPath);
    assert.ok(fs.existsSync(backupDir));
    clearHistoryForWorkspace(ws);
    assert.equal(fs.existsSync(backupDir), false, 'backup dir must be deleted, not silently skipped');
    assert.equal(latestCheckpoint(ws), null, 'index must be gone too');
  });

  it('undoLatest cleans up the .tmp-undo residue when the rename fails', () => {
    const abs = path.join(ws, 'a.txt');
    fs.writeFileSync(abs, 'v1');
    checkpointFile(abs, ws);
    fs.writeFileSync(abs, 'v2');

    const origRename = fs.renameSync;
    (fs as any).renameSync = (p: any, dest: any) => {
      if (String(p).includes('.tmp-undo-')) throw new Error('SIMULATED_RENAME_FAIL');
      return origRename.call(fs, p, dest);
    };
    try {
      assert.throws(() => undoLatest(ws), /SIMULATED_RENAME_FAIL/);
    } finally {
      (fs as any).renameSync = origRename;
    }
    const residue = fs.readdirSync(ws).filter((f) => f.includes('.tmp-undo-'));
    assert.deepEqual(residue, [], '.tmp-undo-* residue must be removed on the failure path');
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'v2', 'failed undo must leave the file untouched');
  });

  it('rewindToTurn: one failing file does not abort the rest; summary reports failures', () => {
    const T0 = 1_700_000_000_000;
    const t1 = { id: 't1', timestamp: T0, userInput: 'turn' };
    const a = path.join(ws, 'a.ts');
    const b = path.join(ws, 'b.ts');
    fs.writeFileSync(a, 'A-v0'); checkpointFileAt(a, ws, T0 + 1000);
    fs.writeFileSync(a, 'A-v1');
    fs.writeFileSync(b, 'B-v0'); checkpointFileAt(b, ws, T0 + 1000);
    fs.writeFileSync(b, 'B-v1');

    const preview = previewRewindToTurn(ws, T0, [t1]);
    assert.ok(preview.ok, preview.message);
    const aEntry = preview._plan.find(([abs]) => abs === a);
    assert.ok(aEntry, 'plan must contain a.ts');
    fs.rmSync(aEntry![1].backupPath!, { force: true }); // sabotage ONE restore

    let r: ReturnType<typeof rewindToTurn> | null = null;
    let err: unknown = null;
    try { r = rewindToTurn(ws, T0, [t1]); } catch (e) { err = e; }
    assert.equal(err, null, `single-file failure must not abort the whole rewind: ${String(err)}`);
    assert.ok(r);
    assert.equal(fs.readFileSync(b, 'utf-8'), 'B-v0', 'the other file must still be restored');
    assert.equal(fs.readFileSync(a, 'utf-8'), 'A-v1', 'the failed file stays as-is');
    assert.ok((r!.failed || []).includes('a.ts'), `failure list must include a.ts, got: ${JSON.stringify(r!.failed)}`);
    assert.ok(/失败 1/.test(r!.message), `message must summarize the failure count: ${r!.message}`);
  });
});
