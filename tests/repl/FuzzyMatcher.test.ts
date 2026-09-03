// tests/repl/FuzzyMatcher.test.ts
// P4-4.1: fuzzy scoring — tier monotonicity (prefix > substring > subsequence),
// empty query, no-hit, alias participation, stable ordering, top-8 cap.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fuzzyScore,
  fuzzyFilter,
  tokenizeSearchText,
  normalizeSlashSearchQuery,
  scoreSlashMenuItem,
  rankSlashCandidates,
} from '../../src/cli/repl/FuzzyMatcher.js';

const CMDS = [
  { name: 'help', description: '显示帮助' },
  { name: 'tier', description: '查看或切换档位' },
  { name: 'compact', description: '压缩会话历史' },
  { name: 'clear', aliases: ['cls'], description: '清屏' },
  { name: 'undo', description: '撤销最近写盘' },
  { name: 'usage', description: '用量与成本' },
  { name: 'status', description: '状态' },
  { name: 'exit', aliases: ['quit', 'q'], description: '退出' },
  { name: 'approvals', description: '审批模式' },
  { name: 'model', description: '模型' },
];

describe('fuzzyScore', () => {
  it('monotonic tiers: prefix > substring > subsequence', () => {
    const prefix = fuzzyScore('ti', 'tier');       // 'ti' is a prefix of tier
    const substring = fuzzyScore('ie', 'tier');    // substring, not prefix
    const subseq = fuzzyScore('tr', 'tier');       // in-order but not contiguous
    assert.ok(prefix > substring, `${prefix} > ${substring}`);
    assert.ok(substring > subseq, `${substring} > ${subseq}`);
    assert.ok(subseq > 0);
  });

  it('exact match scores 1', () => {
    assert.equal(fuzzyScore('tier', 'tier'), 1);
  });

  it('empty query matches everything with 1', () => {
    assert.equal(fuzzyScore('', 'anything'), 1);
    assert.equal(fuzzyScore('   ', 'anything'), 1);
  });

  it('impossible subsequence returns 0', () => {
    assert.equal(fuzzyScore('xyz', 'tier'), 0);
    assert.equal(fuzzyScore('tie', 'undo'), 0);
  });
});

describe('fuzzyFilter', () => {
  it('/tl → /tier (the DoD case)', () => {
    const res = fuzzyFilter('tl', CMDS);
    assert.ok(res.length > 0);
    assert.equal(res[0].name, 'tier');
  });

  it('prefix hit outranks others and stays first', () => {
    const res = fuzzyFilter('cl', CMDS); // 'clear' prefix; 'approvals' subseq?
    assert.equal(res[0].name, 'clear');
  });

  it('empty query returns all (order preserved)', () => {
    const res = fuzzyFilter('', CMDS);
    assert.equal(res.length, CMDS.length);
    assert.deepEqual(res.map((r) => r.name), CMDS.map((c) => c.name));
  });

  it('no hit returns empty', () => {
    assert.deepEqual(fuzzyFilter('zzzzzz', CMDS), []);
  });

  it('aliases participate in matching', () => {
    const res = fuzzyFilter('quit', CMDS); // alias of exit
    assert.ok(res.some((r) => r.name === 'exit'), 'alias quit must surface exit');
    const res2 = fuzzyFilter('cls', CMDS); // alias of clear
    assert.ok(res2.some((r) => r.name === 'clear'));
  });

  it('direct name match outranks alias-only match', () => {
    const items = [
      { name: 'other', aliases: ['exitx'] },
      { name: 'exit' },
    ];
    const res = fuzzyFilter('exit', items);
    assert.equal(res[0].name, 'exit');
  });

  it('stable ordering on equal scores (registration order)', () => {
    const items = [
      { name: 'aaa' },
      { name: 'aab' },
      { name: 'aac' },
    ];
    const res = fuzzyFilter('aa', items);
    assert.deepEqual(res.map((r) => r.name), ['aaa', 'aab', 'aac']);
  });

  it('caps results at 8', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `cmd${i}` }));
    const res = fuzzyFilter('cmd', many);
    assert.equal(res.length, 8);
  });

  it('DoD neighbor: /tier<Tab> resolves with prefix', () => {
    const res = fuzzyFilter('tier', CMDS);
    assert.equal(res[0].name, 'tier');
  });
});

// ============ description-aware search (fuzzy-desc, Hermes layering) ============

const DESC_CMDS = [
  { name: 'cron', description: 'schedule recurring tasks' },
  { name: 'summary', description: 'summarize the conversation and sessions' },
  { name: 'review', description: 'run the review checklist' },
];

describe('tokenizeSearchText / normalizeSlashSearchQuery', () => {
  it('tokenizes into full text + alphanumeric words', () => {
    const toks = tokenizeSearchText('summarize the conversation!');
    assert.ok(toks.includes('summarize'));
    assert.ok(toks.includes('conversation'));
    assert.ok(toks[0] === 'summarize the conversation!');
  });

  it('normalizes leading slashes, trim, case', () => {
    assert.equal(normalizeSlashSearchQuery('/Summary '), 'summary');
    assert.equal(normalizeSlashSearchQuery('///cron'), 'cron');
  });
});

describe('scoreSlashMenuItem / rankSlashCandidates', () => {
  it('/summary hits a command whose DESCRIPTION mentions summaries (no name prefix)', () => {
    const items = DESC_CMDS.map((c) => ({ id: c.name, description: c.description }));
    const ranked = rankSlashCandidates(items, '/summary', (c) => c);
    assert.ok(ranked.some((c) => c.id === 'summary'), 'description word match must surface /summary');
    // command-tier (cron: prefix? no) — the description tier wins here
    assert.equal(ranked[0].id, 'summary');
  });

  it('command name prefix beats description-only match (lower tier score wins)', () => {
    const items = [
      { id: 'review', description: 'run the review checklist' },
      { id: 'summary', description: 'summarize sessions' },
    ];
    const ranked = rankSlashCandidates(items, 'rev', (c) => c);
    assert.equal(ranked[0].id, 'review', 'command prefix (score 1) must beat description word prefix (score 4)');
  });

  it('empty query returns items in original order (browsing)', () => {
    const items = DESC_CMDS.map((c) => ({ id: c.name, description: c.description }));
    const ranked = rankSlashCandidates(items, '', (c) => c);
    assert.deepEqual(ranked.map((c) => c.id), ['cron', 'summary', 'review']);
  });

  it('no match → filtered out', () => {
    const items = DESC_CMDS.map((c) => ({ id: c.name, description: c.description }));
    const ranked = rankSlashCandidates(items, 'zzz', (c) => c);
    assert.deepEqual(ranked, []);
  });

  it('stable: equal scores keep original order', () => {
    const items = [
      { id: 'aaa', description: '' },
      { id: 'aab', description: '' },
      { id: 'aac', description: '' },
    ];
    const ranked = rankSlashCandidates(items, 'aa', (c) => c);
    assert.deepEqual(ranked.map((c) => c.id), ['aaa', 'aab', 'aac']);
  });

  it('index cache does not change results across repeated queries', () => {
    const items = DESC_CMDS.map((c) => ({ id: c.name, description: c.description }));
    const a = rankSlashCandidates(items, '/summ', (c) => c).map((c) => c.id);
    const b = rankSlashCandidates(items, '/summ', (c) => c).map((c) => c.id);
    assert.deepEqual(a, b);
  });
});
