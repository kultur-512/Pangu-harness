// tests/tools/glob.test.ts
// M1-2.1: glob — deep ** matching, ignoreDirs, 200-result cap.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glob } from '../../src/tools/glob.js';
import { walkFiles } from '../../src/tools/walk.js';
import type { ToolContext } from '../../src/tools/types.js';

let root: string;
let ctx: ToolContext;

describe('glob tool', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-glob-'));
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'b.ts'), 'y');
    fs.writeFileSync(path.join(root, 'readme.md'), 'z');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'c.ts'), 'w');
    ctx = { workspaceRoot: root, approvalMode: 'readonly' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches deep ** patterns and ignores node_modules', async () => {
    const r = await glob({ pattern: '**/*.ts' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.includes('src/a.ts'));
    assert.ok(r.output.includes('src/deep/b.ts'));
    assert.ok(!r.output.includes('node_modules'));
  });

  it('returns relative posix paths', async () => {
    const r = await glob({ pattern: 'src/**/*.ts' }, ctx);
    assert.ok(r.ok);
    assert.ok(!r.output.includes('\\'), 'paths must use / separators');
  });

  it('supports * and ? wildcards', async () => {
    const r1 = await glob({ pattern: '*.md' }, ctx);
    assert.ok(r1.output.includes('readme.md'));
    const r2 = await glob({ pattern: 'src/?.ts' }, ctx);
    assert.ok(r2.output.includes('src/a.ts'));
    assert.ok(!r2.output.includes('src/deep/b.ts'));
  });

  it('caps results at 200 with truncated flag', async () => {
    for (let i = 0; i < 210; i++) {
      fs.writeFileSync(path.join(root, 'src', `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const r = await glob({ pattern: 'src/*.txt' }, ctx);
    assert.ok(r.ok);
    assert.equal(r.truncated, true);
    assert.equal(r.meta?.lines, 200);
  });

  it('scan hard-stop mechanism: walkFiles maxFiles truncates deterministically (dogfood-T6)', () => {
    const dir = path.join(root, 'scanstop');
    fs.mkdirSync(dir);
    for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    const r = walkFiles(dir, { maxFiles: 50 });
    assert.equal(r.files.length, 50, 'must stop at the maxFiles hard limit');
    assert.equal(r.truncated, true, 'must flag truncation');
    // default cap (no opts) = 2000
    const d = walkFiles(dir);
    assert.equal(d.files.length, 120);
    assert.equal(d.truncated, false);
  });

  it('rejects escaping base path', async () => {
    const r = await glob({ pattern: '*.txt', path: '..' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PATH_ESCAPED');
  });
});

// ==================== C4: walkFiles 不跟随符号链接（受信工作区假设 + symlink 防御） ====================
describe('C4: walkFiles symlink defense', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-glob-c4-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'real.txt'), 'real');
    fs.writeFileSync(path.join(root, 'src', 'inside.txt'), 'inside');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('skips symlinked directories (no traversal into them, no cycles)', () => {
    // junction 在 Windows 无需管理员权限；POSIX 上等价于目录 symlink
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
    // 指向自身根的循环链接——不防御则无限递归（受 maxDepth 兜底），防御则完全不进入
    fs.symlinkSync(root, path.join(root, 'selfloop'), process.platform === 'win32' ? 'junction' : 'dir');

    const r = walkFiles(root, { maxDepth: 4 });
    const rels = r.files.map((f) => f.rel);
    assert.ok(rels.includes('real.txt'), 'real file must be listed');
    assert.ok(rels.includes('src/inside.txt'), 'real nested file must be listed');
    assert.ok(!rels.some((p) => p.startsWith('linkdir')), 'symlinked dir must NOT be traversed');
    assert.ok(!rels.some((p) => p.startsWith('selfloop')), 'self-referential link must NOT be followed');
  });

  it('skips symlinked files when the platform allows creating them', () => {
    try {
      fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'), 'file');
    } catch {
      // Windows 无开发者模式/管理员权限时创建文件符号链接会失败——跳过该断言
      return;
    }
    const r = walkFiles(root);
    const rels = r.files.map((f) => f.rel);
    assert.ok(rels.includes('real.txt'));
    assert.ok(!rels.includes('link.txt'), 'symlinked file must be skipped');
  });
});
