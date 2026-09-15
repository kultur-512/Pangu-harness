#!/usr/bin/env node
// Debug: directly test RefinedMemoryStore loading
import { RefinedMemoryStore } from '../../../src/memory/RefinedMemoryStore.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const tmpDir = resolve('P:/MY_codes/Pangu/scripts/eval/longmemeval-48/tmp-zl-debug');
mkdirSync(tmpDir, { recursive: true });

const now = Date.now();
const cards = [{
  id: createHash('sha1').update('chatfact-test').digest('hex').slice(0, 12),
  kind: 'preference', category: 'OTHER', memoryCategory: 'insight',
  summary: 'I have 25 postcards', weight: 0.7, taskStyle: 'all', count: 1,
  lastSeen: now, firstSeen: now,
  applicableTiers: ['general', 'failure', 'implementation', 'insight'],
  sourceContext: 'test', decayWeight: 1.0, lastUsedAt: now,
}];

writeFileSync(join(tmpDir, '.panshalach-memory.json'), JSON.stringify({ version: 1, cards }, null, 2), 'utf8');
console.log('Written .panshalach-memory.json');

// Test 1: loadFiltered with tier='high'
const memStore = new RefinedMemoryStore(tmpDir);
console.log('raw load():', memStore.load().cards.length, 'cards');
const all = memStore.loadFiltered({ tier: 'high', maxCards: 10 });
console.log('loadFiltered(high, maxCards=10) returned:', all.length, 'cards');
for (const c of all) console.log(' -', c.id, c.summary);

// Test 2: getOverflowCards
const overflow = memStore.getOverflowCards({ tier: 'high', keywords: ['postcards'] }, []);
console.log('getOverflowCards(high, keywords=[postcards]) returned:', overflow.pulled.length, 'cards');
for (const c of overflow.pulled) console.log(' -', c.id, c.summary);

// Test 3: with empty keywords
const overflow2 = memStore.getOverflowCards({ tier: 'high', keywords: [] }, []);
console.log('getOverflowCards(high, keywords=[]) returned:', overflow2.pulled.length, 'cards');
for (const c of overflow2.pulled) console.log(' -', c.id, c.summary);
