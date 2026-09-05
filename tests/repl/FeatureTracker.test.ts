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

// ==================== C3: markFeatureDone 检查 save 返回值（写失败不静默成功） ====================
describe('C3: FeatureTracker save-failure surfacing', () => {
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-feat-c3-')); });
  afterEach(() => {
    // 恢复可写后再清理（0o444 的文件 Windows 上删不掉）
    try { fs.chmodSync(featureListPath(ws), 0o666); } catch {}
    fs.rmSync(ws, { recursive: true, force: true });
  });

  function makeFileUnwritable(): void {
    // 0o444 → Windows 只读属性 / POSIX 去写位：readFileSync 仍可读（load 成功），
    // writeFileSync 必败（save 失败）——精确构造"读得到、写不进"的场景。
    fs.chmodSync(featureListPath(ws), 0o444);
  }

  it('markFeatureDone reports write failure instead of returning null', () => {
    const f = addFeature(ws, '写入会失败的特性')!;
    assert.ok(f);
    makeFileUnwritable();
    const err = markFeatureDone(ws, f.id, 'evidence-x');
    assert.ok(err, 'save 失败必须返回错误串（不得静默成功）');
    assert.ok(err.includes('失败'), `告警需点名写失败: ${err}`);
    // 状态不得被视为已持久化
    fs.chmodSync(featureListPath(ws), 0o666);
    const items = loadFeatures(ws);
    assert.equal(items.find((x) => x.id === f.id)!.status, 'in-progress', '写失败 → 磁盘上仍是 in-progress');
  });

  it('setFeatureNext reports write failure instead of returning null', () => {
    const f = addFeature(ws, 'next 也写不进')!;
    makeFileUnwritable();
    const err = setFeatureNext(ws, f.id, '下一步');
    assert.ok(err, 'save 失败必须返回错误串');
    assert.ok(err.includes('失败'), `告警需点名写失败: ${err}`);
  });

  it('control: healthy file still returns null', () => {
    const f = addFeature(ws, '正常路径')!;
    assert.equal(markFeatureDone(ws, f.id, 'evidence-ok'), null);
    assert.equal(setFeatureNext(ws, f.id, '收尾'), null, 'done 后 setNext 重新激活');
  });
});
