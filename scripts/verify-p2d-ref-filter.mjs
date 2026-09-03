// scripts/verify-p2d-ref-filter.mjs
// Pure-Node (no tsx, no child spawn) verification for P2-D reference filtering (v2).
// Semantics:
// - Provide currentWorkspaceFiles (non-empty) → intersect on referencedFiles.
// - If intersection non-empty → return only matching refs.
// - If intersection empty → fallback to the set before reference filtering (保底).
// - If no currentWorkspaceFiles provided → normal tier/style/decay filtering.
// Uses built dist only. Exits 0 on success.

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = process.cwd();

function makeWs() {
  const dir = mkdtempSync(pathResolve(tmpdir(), 'zorge-p2d-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir) { try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch {} }

function writeMemory(ws, cards) {
  const fp = pathResolve(ws, '.zorge-memory.json');
  const file = { meta: { version: '1.0.0', lastUpdated: Date.now(), totalCards: cards.length }, cards };
  writeFileSync(fp, JSON.stringify(file, null, 2), 'utf-8');
}

async function load() {
  const storeUrl = pathToFileURL(pathResolve(root, 'dist/memory/RefinedMemoryStore.js')).href;
  const mod = await import(storeUrl);
  if (!mod.RefinedMemoryStore) throw new Error('RefinedMemoryStore not found in dist');
  return { RefinedMemoryStore: mod.RefinedMemoryStore };
}

async function main() {
  const { RefinedMemoryStore } = await load();
  const ws = makeWs();
  const now = Date.now();

  try {
    // Two cards with different referenced files
    const cAuth = {
      id: 'c-auth',
      category: 'READ_BEFORE_WRITE_VIOLATION',
      summary: '重要教训：写入前应先读',
      weight: 2,
      taskStyle: 'all',
      count: 1,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: [],
      sourceContext: 'test',
      memoryCategory: 'failure',
      decayWeight: 1,
      lastUsedAt: now,
      referencedFiles: ['src/auth.ts'],
    };
    const cOther = {
      id: 'c-other',
      category: 'COMMAND_FAILED',
      summary: '重要教训：命令后应检查',
      weight: 2,
      taskStyle: 'all',
      count: 1,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: [],
      sourceContext: 'test',
      memoryCategory: 'failure',
      decayWeight: 1,
      lastUsedAt: now,
      referencedFiles: ['src/other.ts'],
    };
    writeMemory(ws, [cAuth, cOther]);

    const store = new RefinedMemoryStore(ws);

    // 1) scope matches auth only → only c-auth (含 → 加载；不含 → 不加载)
    let res = store.loadFiltered({ currentWorkspaceFiles: ['src/auth.ts'], tier: 'high', now });
    let ids = res.map(r => r.id);
    if (!(ids.includes('c-auth') && !ids.includes('c-other'))) {
      console.error('FAIL case 1');
      process.exit(1);
    }

    // 2) scope matches other only → only c-other (不含 → 不加载)
    res = store.loadFiltered({ currentWorkspaceFiles: ['src/other.ts'], tier: 'high', now });
    ids = res.map(r => r.id);
    if (ids.includes('c-auth') || !ids.includes('c-other')) {
      console.error('FAIL case 2');
      process.exit(1);
    }

    // 3) scope matches nothing → fallback to full (过滤后为空 → 回退全量)
    res = store.loadFiltered({ currentWorkspaceFiles: ['src/nothing.ts'], tier: 'high', now });
    if (res.length < 2) {
      console.error('FAIL case 3 fallback');
      process.exit(1);
    }

    // 4) decay + ref coexist: old card (>2*HL for failure HL=90) should be filtered by decay (effective < 0.3)
    // Use weight=2 so at >=2*HL: 2 * 0.1 = 0.2 < 0.3 → dropped by loadFiltered
    // Use a fresh dedicated workspace because the store caches the loaded file content.
    const decayWs = makeWs();
    try {
      const old = {
        id: 'old',
        category: 'WEAK_VERIFICATION',
        summary: '重要教训：弱验证',
        weight: 2,
        taskStyle: 'all',
        count: 1,
        lastSeen: now - (200 * 24 * 60 * 60 * 1000),
        firstSeen: now - (200 * 24 * 60 * 60 * 1000),
        applicableTiers: [],
        sourceContext: 'x',
        memoryCategory: 'failure',
        decayWeight: 1,
        lastUsedAt: now - (200 * 24 * 60 * 60 * 1000),
        referencedFiles: ['src/a.ts'],
      };
      const fresh = {
        id: 'fresh',
        category: 'READ_BEFORE_WRITE_VIOLATION',
        summary: '重要教训：读后写',
        weight: 2,
        taskStyle: 'all',
        count: 1,
        lastSeen: now,
        firstSeen: now,
        applicableTiers: [],
        sourceContext: 'x',
        memoryCategory: 'failure',
        decayWeight: 1,
        lastUsedAt: now,
        referencedFiles: ['src/a.ts'],
      };
      writeMemory(decayWs, [old, fresh]);
      const decayStore = new RefinedMemoryStore(decayWs);
      res = decayStore.loadFiltered({ currentWorkspaceFiles: ['src/a.ts'], tier: 'high', now });
      ids = res.map(r => r.id);
      if (!ids.includes('fresh') || ids.includes('old')) {
        console.error('FAIL case 4 decay+ref (ids=' + ids.join(',') + ')');
        process.exit(1);
      }
    } finally {
      cleanup(decayWs);
    }

    console.error('P2-D checks:');
    console.error('  scope match narrows (含 → 加载；不含 → 不加载): OK');
    console.error('  no ref match → fallback (空 → 回退全量): OK');
    console.error('  decay + ref coexist: OK');
    console.error('P2-D OK');

  } finally {
    cleanup(ws);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
