// tests/repl/FeatureTracker.test.ts
// P1-T14 (L08): feature_list.json state — add/markDone/setNext, evidence
// REQUIRED for done, one active at a time, prompt injection carries only the
// active feature.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadFeatures, saveFeatures, activeFeature, addFeature, markFeatureDone, setFeatureNext, featureListPath,
} from '../../src/cli/repl/FeatureTracker.js';

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-feat-')); });
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

describe('FeatureTracker', () => {
  it('addFeature creates an active item and demotes any previous active', () => {
    const a = addFeature(ws, '第一个特性')!;
    assert.ok(a);
    assert.equal(a.status, 'in-progress');
    const b = addFeature(ws, '第二个特性')!;
    assert.equal(b.status, 'in-progress');
    const items = loadFeatures(ws);
    assert.equal(items.filter((f) => f.status === 'in-progress').length, 1, 'only one active');
    assert.equal(items.find((f) => f.id === a.id)!.status, 'planned', 'previous active demoted');
  });

  it('markFeatureDone REQUIRES evidence', () => {
    addFeature(ws, 'x');
    const noEvidence = markFeatureDone(ws, 'feature-1', '');
    assert.ok(noEvidence, 'empty evidence must be rejected');
    assert.equal(markFeatureDone(ws, 'feature-1', 'tests/FeatureTracker.test.ts 通过'), null);
    const items = loadFeatures(ws);
    assert.equal(items[0].status, 'done');
    assert.ok(items[0].evidence!.includes('FeatureTracker'));
  });

  it('setFeatureNext activates the target and sets nextStep', () => {
    addFeature(ws, 'x');
    addFeature(ws, 'y');
    assert.equal(setFeatureNext(ws, 'feature-1', '接 MCP'), null);
    const items = loadFeatures(ws);
    assert.equal(activeFeature(items)!.id, 'feature-1');
    assert.equal(activeFeature(items)!.nextStep, '接 MCP');
  });

  it('missing feature id returns an error', () => {
    assert.ok(markFeatureDone(ws, 'nope', 'ev'));
    assert.ok(setFeatureNext(ws, 'nope', 'next'));
  });

  it('persists across load/save round-trips', () => {
    const item = addFeature(ws, '持久化')!;
    const reloaded = loadFeatures(ws);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].id, item.id);
    assert.ok(fs.existsSync(featureListPath(ws)));
  });

  it('corrupt/missing file → empty list (never throws)', () => {
    assert.deepEqual(loadFeatures(ws), []);
    fs.mkdirSync(path.dirname(featureListPath(ws)), { recursive: true });
    fs.writeFileSync(featureListPath(ws), '{not json', 'utf-8');
    assert.deepEqual(loadFeatures(ws), []);
  });
});
