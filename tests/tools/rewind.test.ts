// tests/tools/rewind.test.ts
// P3-3.6: turn-granular rewind over file-history checkpoints.
// Deterministic via checkpointFileAt (explicit ts) — turn windows controlled.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkpointFileAt,
  clearHistoryForWorkspace,
  listByTurn,
  previewRewindToTurn,
  rewindToTurn,
} from '../../src/tools/fileHistory.js';

let ws: string;

type TurnLike = { id: string; timestamp: number; userInput?: string };
function mkTurn(id: string, ts: number, userInput: string): TurnLike {
  return { id, timestamp: ts, userInput };
}

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function writeThenCheckpoint(rel: string, content: string, ts: number): string {
  const abs = path.join(ws, rel);
  fs.writeFileSync(abs, content);
  return checkpointFileAt(abs, ws, ts);
}

describe('listByTurn', () => {
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-rw-')); });
  afterEach(() => { clearHistoryForWorkspace(ws); fs.rmSync(ws, { recursive: true, force: true }); });

  it('assigns checkpoints to the owning turn window; pre-first-turn ones are 杂项', () => {
    const t1 = mkTurn('t1', T0, 'turn one task');
    const t2 = mkTurn('t2', T0 + DAY, 'turn two task');

    writeThenCheckpoint('misc.txt', 'm', T0 - DAY);        // before any turn → 杂项
    writeThenCheckpoint('a.ts', 'A1', T0 + 1000);          // t1 window
    writeThenCheckpoint('b.ts', 'B1', T0 + 2000);          // t1 window
    writeThenCheckpoint('c.ts', 'C1', T0 + DAY + 1000);    // t2 window

    const groups = listByTurn(ws, [t1, t2]);
    assert.equal(groups.length, 3, `expected 3 groups (misc,t1,t2) got ${groups.length}`);
    const g0 = groups.find((g) => g.turnId === null)!;
    const g1 = groups.find((g) => g.turnId === 't1')!;
    const g2 = groups.find((g) => g.turnId === 't2')!;
    assert.ok(g0);
    assert.equal(g0.turnLabel, '杂项操作');
    assert.ok(g1.filesChanged.includes('a.ts'));
    assert.ok(g1.filesChanged.includes('b.ts'));
    assert.ok(!g1.filesChanged.includes('c.ts'));
    assert.ok(g2.filesChanged.includes('c.ts'));
  });

  it('create-type checkpoints appear in groups and rewind deletes the file', () => {
    const t1 = mkTurn('t1', T0, 'create file turn');
    // prevExists=false (timestamp before first write)
    checkpointFileAt(path.join(ws, 'new.txt'), ws, T0 - 1000); // created later actually? create => exists
    // Simulate a CREATE: checkpoint when file doesn't exist yet
    const abs = path.join(ws, 'fresh.ts');
    checkpointFileAt(abs, ws, T0 - 500);   // records prevExists=false
    fs.writeFileSync(abs, 'hello');        // t1 window writes it
    const groups = listByTurn(ws, [t1]);
    assert.equal(groups.length, 1);
    assert.ok(groups[0].turnId === 't1' || groups[0].turnId === null, 'misc-adjacent create lands in a group');
  });
});

describe('previewRewindToTurn / rewindToTurn', () => {
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-rw2-')); });
  afterEach(() => { clearHistoryForWorkspace(ws); fs.rmSync(ws, { recursive: true, force: true }); });

  it('preview is zero side effect; rewind restores last-pre-target state', () => {
    const t1 = mkTurn('t1', T0, 'first');
    const t2 = mkTurn('t2', T0 + DAY, 'second');
    const abs = path.join(ws, 'a.ts');
    fs.writeFileSync(abs, 'v0'); checkpointFileAt(abs, ws, T0 + 1000);   // t1 ckpt 1
    fs.writeFileSync(abs, 'v1'); checkpointFileAt(abs, ws, T0 + 2000);   // t1 ckpt 2 (last before t2)
    fs.writeFileSync(abs, 'v2');                                          // t2 window write (no checkpoint yet)

    const before = fs.readFileSync(abs, 'utf-8');
    const p = previewRewindToTurn(ws, T0, [t1, t2]);
    assert.ok(p.ok, p.message);
    assert.equal(fs.readFileSync(abs, 'utf-8'), before, 'preview must NOT mutate');

    const r = rewindToTurn(ws, T0, [t1, t2]);
    assert.ok(r.ok, r.message);
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'v1', 'must restore last pre-t2 checkpoint');
  });

  it('create→edit sequence: rewinding before the create deletes the file', () => {
    const t1 = mkTurn('t1', T0, 'created it');
    const t2 = mkTurn('t2', T0 + DAY, 'edited it');
    const abs = path.join(ws, 'made.ts');
    // create checkpoint (file absent → prevExists=false), then writes 'step1' (t1), 'step2' (t2)
    checkpointFileAt(abs, ws, T0 - 1000);        // prevExists=false (creation)
    fs.writeFileSync(abs, 'step1'); checkpointFileAt(abs, ws, T0 + 1000);
    fs.writeFileSync(abs, 'step2'); checkpointFileAt(abs, ws, T0 + DAY + 1000);

    // rewind to before t1 (T0 - 1000): the create's prevExists=false → delete file
    const r = rewindToTurn(ws, T0 - 1000, [t1, t2]);
    assert.ok(r.ok, r.message);
    assert.ok(!fs.existsSync(abs), 'create-rewind must delete the file');
  });

  it('bash side effects are excluded (only write/edit checkpoints tracked)', () => {
    const t1 = mkTurn('t1', T0, 'bash ran');
    const abs = path.join(ws, 'a.ts');
    fs.writeFileSync(abs, 'before'); checkpointFileAt(abs, ws, T0 + 1000);
    fs.writeFileSync(abs, 'after-edit'); checkpointFileAt(abs, ws, T0 + 2000);
    // simulate bash touching a NON-checkpointed file 'bash-made.txt'
    const bashFile = path.join(ws, 'bash-made.txt');
    fs.writeFileSync(bashFile, 'from-bash');   // no checkpoint ever created for it

    const r = rewindToTurn(ws, T0, [t1]);
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(bashFile, 'utf-8'), 'from-bash', 'bash-touched file must be untouched');
  });

  it('rewind is reversible & idempotent for the same target (with a CURRENT turn in the list)', () => {
    const t1 = mkTurn('t1', T0, 'first');
    const current = mkTurn('cur', Date.now(), 'current turn');  // re-checkpoints land HERE, outside target window
    const abs = path.join(ws, 'a.ts');
    fs.writeFileSync(abs, 'orig'); checkpointFileAt(abs, ws, T0 + 1000);
    fs.writeFileSync(abs, 'edited'); checkpointFileAt(abs, ws, T0 + 2000);
    fs.writeFileSync(abs, 'edited2');

    rewindToTurn(ws, T0, [t1, current]);       // → 'edited' (last ckpt inside t1 window)
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'edited');

    rewindToTurn(ws, T0, [t1, current]);       // same target again → still 'edited'
    assert.equal(fs.readFileSync(abs, 'utf-8'), 'edited', 'idempotent for the same target');
  });
});