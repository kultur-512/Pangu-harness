// tests/tools/pathGuard.test.ts
// M1-2.1: pathGuard security cases (traversal, absolute escape, drive switch,
// symlink escape, empty path, legal relative path).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveUnderWorkspace } from '../../src/tools/pathGuard.js';

let root: string;

describe('pathGuard', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-pg-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'world');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('allows a legal relative path inside workspace', () => {
    const r = resolveUnderWorkspace('sub/b.txt', root);
    assert.ok(r.ok);
    if (r.ok) assert.ok(fs.existsSync(r.real));
  });

  it('allows the workspace root itself', () => {
    const r = resolveUnderWorkspace('.', root);
    assert.ok(r.ok);
  });

  it('rejects empty path', () => {
    const r = resolveUnderWorkspace('', root);
    assert.equal(r.ok, false);
  });

  it('rejects ../ traversal escape', () => {
    const r = resolveUnderWorkspace('../outside.txt', root);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.reason.startsWith('PATH_ESCAPED'));
  });

  it('rejects deep ../ traversal', () => {
    const r = resolveUnderWorkspace('sub/../../x.txt', root);
    assert.equal(r.ok, false);
  });

  it('rejects absolute path outside workspace (tmpdir target)', () => {
    const outside = path.join(os.tmpdir(), 'pangu-pg-outside.txt');
    fs.writeFileSync(outside, 'x');
    try {
      const r = resolveUnderWorkspace(outside, root);
      assert.equal(r.ok, false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('rejects absolute path outside workspace', () => {
    const outside = path.join(os.tmpdir(), 'pangu-pg-outside2.txt');
    fs.writeFileSync(outside, 'x');
    try {
      const r = resolveUnderWorkspace(outside, root);
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.reason.startsWith('PATH_ESCAPED'));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('rejects drive-letter switch on Windows', { skip: process.platform !== 'win32' }, () => {
    const r = resolveUnderWorkspace('D:\\somewhere\\evil.txt', root);
    assert.equal(r.ok, false);
  });

  it('rejects symlink pointing outside workspace', (t) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-pg-out-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    try {
      const link = path.join(root, 'evil-link');
      try {
        fs.symlinkSync(outsideDir, link, 'dir');
      } catch (e: any) {
        if (e && (e.code === 'EPERM' || e.code === 'ENOENT')) {
          t.skip(`symlink not permitted on this host: ${e.code}`);
          return;
        }
        throw e;
      }
      const r = resolveUnderWorkspace('evil-link/secret.txt', root);
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.reason.includes('PATH_ESCAPED'));
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('mustExist=false allows not-yet-existing file under workspace', () => {
    const r = resolveUnderWorkspace('newdir/newfile.txt', root, { mustExist: false });
    assert.ok(r.ok);
  });

  it('mustExist=false still rejects escape via ..', () => {
    const r = resolveUnderWorkspace('../../evil.txt', root, { mustExist: false });
    assert.equal(r.ok, false);
  });
});
