// tests/memory/RefinedMemoryStoreP2D.test.ts
// P2-D: Reference-based memory filtering tests (引用追踪版)
// Acceptance cases:
// 1. Memory references src/auth.ts; load with currentWorkspaceFiles containing it → loaded
// 2. Not containing → not loaded
// 3. After filtering empty → falls back to full load
// 4. Step decay (P1-C) + reference filtering coexist

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import type { RefinedMemoryCard } from '../../src/memory/RefinedMemoryCard.js';

function makeTempWorkspace(): string {
  const dir = join(tmpdir(), 'pangu-p2d-mem-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir: string) { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }

function writeMemory(ws: string, cards: any[]) {
  const fp = join(ws, '.panshalach-memory.json');
  const file = {
    meta: { version: '1.0.0', lastUpdated: Date.now(), totalCards: cards.length },
    cards,
  };
  writeFileSync(fp, JSON.stringify(file, null, 2), 'utf-8');
}

describe('P2-D RefinedMemoryStore reference filtering (v2)', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempWorkspace(); });
  afterEach(() => { cleanup(tmp); });

  it('references src/auth.ts; currentWorkspaceFiles includes it → loaded', () => {
    const card: Partial<RefinedMemoryCard> & { referencedFiles?: string[] } = {
      id: 'c1',
      category: 'READ_BEFORE_WRITE_VIOLATION',
      summary: '重要教训：写入前应先读',
      weight: 2,
      taskStyle: 'all',
      count: 1,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
      applicableTiers: [],
      sourceContext: 'test',
      memoryCategory: 'failure',
      decayWeight: 1,
      lastUsedAt: Date.now(),
      referencedFiles: ['src/auth.ts'],
    };
    writeMemory(tmp, [card]);

    const store = new RefinedMemoryStore(tmp);
    const res = store.loadFiltered({
      currentWorkspaceFiles: ['src/auth.ts', 'src/other.ts'],
      tier: 'high',
    });
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 'c1');
  });

  it('references src/auth.ts; currentWorkspaceFiles does NOT include → excluded when refSet is non-empty', () => {
    // M2.5 aligned with implementation semantics: reference filtering keeps
    // ONLY cards whose referencedFiles intersect currentWorkspaceFiles; if
    // that intersection is EMPTY the loader falls back to preReference (so
    // the user is never left without memory — see the fallback test below).
    // Strict exclusion is therefore observable only when at least one other
    // card matches.
    const card: Partial<RefinedMemoryCard> & { referencedFiles?: string[] } = {
      id: 'c2',
      category: 'COMMAND_FAILED',
      summary: '重要教训：命令后应检查',
      weight: 2,
      taskStyle: 'all',
      count: 1,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
      applicableTiers: [],
      sourceContext: 'test',
      memoryCategory: 'failure',
      decayWeight: 1,
      lastUsedAt: Date.now(),
      referencedFiles: ['src/auth.ts'],
    };
    const matcher: Partial<RefinedMemoryCard> & { referencedFiles?: string[] } = {
      ...card,
      id: 'c2-match',
      category: 'READ_BEFORE_WRITE_VIOLATION',
      summary: '与当前工作区相关的教训',
      referencedFiles: ['src/unrelated.ts'],
    };
    writeMemory(tmp, [card, matcher]);

    const store = new RefinedMemoryStore(tmp);
    const res = store.loadFiltered({
      currentWorkspaceFiles: ['src/unrelated.ts'],
      tier: 'high',
    });
    const ids = res.map(r => r.id);
    assert.ok(!ids.includes('c2'), 'non-matching card must be excluded when refSet is non-empty');
    assert.ok(ids.includes('c2-match'), 'matching card must be loaded');
  });

  it('filtering yields empty → falls back to full load', () => {
    const card: Partial<RefinedMemoryCard> & { referencedFiles?: string[] } = {
      id: 'c3',
      category: 'WEAK_VERIFICATION',
      summary: '重要教训：弱验证',
      weight: 2,
      taskStyle: 'all',
      count: 1,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
      applicableTiers: [],
      sourceContext: 'test',
      memoryCategory: 'failure',
      decayWeight: 1,
      lastUsedAt: Date.now(),
      referencedFiles: ['src/only.ts'],
    };
    writeMemory(tmp, [card]);

    const store = new RefinedMemoryStore(tmp);
    // No intersection
    const res = store.loadFiltered({
      currentWorkspaceFiles: ['src/nothing.ts'],
      tier: 'high',
    });
    // Fallback must return the card
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 'c3');
  });

  it('step decay (P1-C) + reference filtering coexist', () => {
    const now = Date.now();
    const freshRef: Partial<RefinedMemoryCard> & { referencedFiles?: string[] } = {
      id: 'fresh',
      category: 'READ_BEFORE_WRITE_VIOLATION',
      summary: '重要教训：读后写',
      weight: 3,
      taskStyle: 'all',
      count: 1,
      lastSeen: now,               // fresh
      firstSeen: now,
      applicableTiers: [],
      sourceContext: 'x',
      memoryCategory: 'failure',
      decayWeight: 1,
      lastUsedAt: now,
      referencedFiles: ['src/a.ts'],
    };
    const oldRef: Partial<RefinedMemoryCard> & { referencedFiles?: string[] } = {
      id: 'old',
      category: 'COMMAND_FAILED',
      summary: '重要教训：检查退出码',
      weight: 3,
      taskStyle: 'all',
      count: 1,
      lastSeen: now - (200 * 24 * 60 * 60 * 1000), // ~200 days ago, failure HL=90d → >2*HL → *0.1
      firstSeen: now - (200 * 24 * 60 * 60 * 1000),
      applicableTiers: [],
      sourceContext: 'x',
      memoryCategory: 'failure',
      decayWeight: 1,
      lastUsedAt: now - (200 * 24 * 60 * 60 * 1000),
      referencedFiles: ['src/a.ts'],
    };
    writeMemory(tmp, [freshRef, oldRef]);

    const store = new RefinedMemoryStore(tmp);
    const res = store.loadFiltered({
      currentWorkspaceFiles: ['src/a.ts'],
      tier: 'high',
      now,
    });

    // Both should be considered by reference filter; then decay filters old below 0.3 effective
    const ids = res.map(r => r.id);
    assert.ok(ids.includes('fresh'));
    assert.ok(!ids.includes('old'), 'old card should be filtered by decay (<0.3 after >2*HL)');
  });
});
