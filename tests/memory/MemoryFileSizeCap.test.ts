// tests/memory/MemoryFileSizeCap.test.ts
// C1（ROADMAP-NEXT §3.2）：MEMORY_LIMITS.MAX_FILE_SIZE_BYTES(200KiB) 声明执行——
// save() 序列化后超限必须 reject（throw + 告警文案，与既有 writeFileSync 错误风格
// 一致）且不落盘；未超限正常写入（对照组）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import { MEMORY_LIMITS } from '../../src/memory/RefinedMemoryCard.js';
import type { RefinedMemoryCard } from '../../src/memory/RefinedMemoryCard.js';

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-sizecap-')); });
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

function bigCard(i: number, summaryChars: number): RefinedMemoryCard {
  return {
    id: `sizecap-${i}`,
    category: 'OTHER',
    memoryCategory: 'general',
    summary: 'x'.repeat(summaryChars) + ` (#${i})`,
    weight: 1,
    taskStyle: 'all',
    count: 1,
    lastSeen: Date.now(),
    firstSeen: Date.now(),
    applicableTiers: [],
    sourceContext: 'C1 文件大小上限测试',
  };
}

describe('C1: MAX_FILE_SIZE_BYTES save-time enforcement', () => {
  it('save rejects (throws) with warning over 200KiB and writes NOTHING', () => {
    const store = new RefinedMemoryStore(ws, 'sizecap-memory.json');
    // 10 张（≤ MAX_PER_CATEGORY=10）× ~24KiB 摘要 ≈ 240KiB > 200KiB
    const cards = Array.from({ length: 10 }, (_, i) => bigCard(i, 24 * 1024));
    assert.throws(
      () => store.save(cards),
      (e: any) => {
        const msg = String(e?.message || e);
        return msg.includes('MAX_FILE_SIZE_BYTES') && msg.includes('上限') && msg.includes('未写盘');
      },
      '超限必须以告警文案 reject（点名上限常量）'
    );
    assert.equal(
      fs.existsSync(path.join(ws, 'sizecap-memory.json')),
      false,
      '超限 save 不得写盘'
    );
  });

  it('save under the limit still succeeds (control)', () => {
    const store = new RefinedMemoryStore(ws, 'sizecap-memory.json');
    const cards = Array.from({ length: 5 }, (_, i) => bigCard(i, 256));
    const r = store.save(cards);
    assert.equal(r.written, 5);
    assert.ok(fs.existsSync(path.join(ws, 'sizecap-memory.json')));
  });

  it('declared limit is 200KiB', () => {
    assert.equal(MEMORY_LIMITS.MAX_FILE_SIZE_BYTES, 200 * 1024);
  });
});
