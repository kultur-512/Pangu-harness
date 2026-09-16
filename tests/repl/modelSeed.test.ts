// tests/repl/modelSeed.test.ts
// applyConfigModel：配置文件 model 字段兜底播种 session.model（env 优先之后的第二级）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyConfigModel, envApprovalMode, envTier } from '../../src/cli/repl/modelSeed.js';

test('applyConfigModel seeds model from project config when session is default', () => {
  const root = mkdtempSync(join(tmpdir(), 'pansa-seed-'));
  try {
    writeFileSync(join(root, '.panshalach.json'), JSON.stringify({ model: 'prov:test-model' }), 'utf-8');
    const session = { model: 'default' };
    applyConfigModel(session, root);
    assert.equal(session.model, 'prov:test-model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyConfigModel keeps explicit/env-selected model untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'pansa-seed-'));
  try {
    writeFileSync(join(root, '.panshalach.json'), JSON.stringify({ model: 'prov:other' }), 'utf-8');
    const session = { model: 'env:picked' };
    applyConfigModel(session, root);
    assert.equal(session.model, 'env:picked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('envApprovalMode parses PANSHA_APPROVAL and rejects invalid values', () => {
  const prev = process.env.PANSHA_APPROVAL;
  try {
    delete process.env.PANSHA_APPROVAL;
    assert.equal(envApprovalMode(), undefined);
    process.env.PANSHA_APPROVAL = 'full';
    assert.equal(envApprovalMode(), 'full');
    process.env.PANSHA_APPROVAL = 'DEFAULT';
    assert.equal(envApprovalMode(), 'default');
    process.env.PANSHA_APPROVAL = 'yolo';
    assert.equal(envApprovalMode(), undefined);
  } finally {
    if (prev === undefined) delete process.env.PANSHA_APPROVAL;
    else process.env.PANSHA_APPROVAL = prev;
  }
});

test('envTier parses PANSHA_TIER（六档 + 别名）and rejects invalid values', () => {
  const prev = process.env.PANSHA_TIER;
  try {
    delete process.env.PANSHA_TIER;
    assert.equal(envTier(), undefined);
    process.env.PANSHA_TIER = 'max';
    assert.equal(envTier(), 'max');
    process.env.PANSHA_TIER = 'PANGU';
    assert.equal(envTier(), 'pangu');
    process.env.PANSHA_TIER = 'rapid'; // 旧别名 → 归一化为规范 tier（quick）
    assert.equal(envTier(), 'quick');
    process.env.PANSHA_TIER = 'yolo';
    assert.equal(envTier(), undefined);
  } finally {
    if (prev === undefined) delete process.env.PANSHA_TIER;
    else process.env.PANSHA_TIER = prev;
  }
});
