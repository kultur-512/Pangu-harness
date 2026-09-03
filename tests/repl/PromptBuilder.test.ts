// tests/repl/PromptBuilder.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PromptBuilder, TierConstraintRegistry } from '../../src/cli/repl/PromptBuilder.js';
import { Session } from '../../src/cli/repl/Session.js';
import { TierRegistry, Tier } from '../../src/tiers/TierConfig.js';

describe('PromptBuilder', () => {
  it('includes tier contract and recent context', async () => {
    const sess = new Session({ tier: 'high' });
    sess.addTurn({
      id: 't1',
      timestamp: Date.now(),
      userInput: 'fix add function',
      userInputType: 'task',
      tier: 'high',
      durationMs: 100,
      result: { success: true, summary: 'score=88' },
    });

    const tierCfg = TierRegistry.get('high');
    const pb = new PromptBuilder(sess, tierCfg);
    const prompt = await pb.buildForTask('refactor login');

    assert.ok(prompt.includes('当前档位: high'));
    assert.ok(prompt.includes('铁律强度'));
    assert.ok(prompt.includes('最近上下文'));
    assert.ok(prompt.includes('fix add function'));
    assert.ok(prompt.includes('当前任务'));
    assert.ok(prompt.includes('refactor login'));
  });

  it('injects negative tool list block (fix-#9-①)', async () => {
    const sess = new Session({ tier: 'high' });
    const tierCfg = TierRegistry.get('high');
    const pb = new PromptBuilder(sess, tierCfg);
    const prompt = await pb.buildForTask('task');
    assert.ok(prompt.includes('<negative_tool_list>'), 'negative list injected');
    assert.ok(prompt.includes('iron_law_check'), 'mis-called names enumerated');
    assert.ok(prompt.includes('不是工具'), 'explicitly non-tool');
    assert.ok(prompt.includes('edit_file 或 write_file'), 'intent→tool mapping present');
  });

  it('skips memory block when level is none (quick)', async () => {
    const sess = new Session({ tier: 'quick' });
    const tierCfg = TierRegistry.get('quick');
    const pb = new PromptBuilder(sess, tierCfg);
    const prompt = await pb.buildForTask('hotfix');

    // quick tier has memoryLoadLevel 'none'
    assert.ok(!prompt.includes('提炼后的教训'));
  });

  it('compactIfNeeded shortens very long prompt', () => {
    const sess = new Session({ tier: 'high' });
    const tierCfg = TierRegistry.get('high');
    const pb = new PromptBuilder(sess, tierCfg);

    const huge = 'X'.repeat(200_000);
    const compacted = pb.compactIfNeeded(huge, 10_000);

    assert.ok(compacted.length < huge.length);
    assert.ok(compacted.includes('...[中间历史已压缩]...'));
  });

  it('buildSystemHeader returns tier contract without task body', () => {
    const sess = new Session({ tier: 'max' });
    const tierCfg = TierRegistry.get('max');
    const pb = new PromptBuilder(sess, tierCfg);

    const header = pb.buildSystemHeader();
    assert.ok(header.includes('档位 max'));
    assert.ok(header.includes('铁律强度'));
  });
});

// ==================== P0-2: Tier Constraint tests (blueprint) ====================
describe('P0-2 TierConstraintRegistry + PromptBuilder integration', () => {
  const tiers: Tier[] = ['quick', 'standard', 'high', 'max', 'ex', 'zorge'];

  it('every tier produces a <tier_constraint> block with correct tier attribute', async () => {
    for (const t of tiers) {
      const sess = new Session({ tier: t });
      const cfg = TierRegistry.get(t);
      const pb = new PromptBuilder(sess, cfg);
      const prompt = await pb.buildForTask('test task');

      assert.ok(
        prompt.includes(`<tier_constraint tier="${t}">`),
        `tier ${t} must include <tier_constraint tier="${t}">`
      );
    }
  });

  it('quick/standard/high have correct max_tool_calls_per_step numbers', async () => {
    const cases: Array<{ tier: Tier; expected: number }> = [
      { tier: 'quick', expected: 3 },
      { tier: 'standard', expected: 5 },
      { tier: 'high', expected: 8 },
    ];

    for (const c of cases) {
      const sess = new Session({ tier: c.tier });
      const cfg = TierRegistry.get(c.tier);
      const pb = new PromptBuilder(sess, cfg);
      const prompt = await pb.buildForTask('x');

      const match = prompt.match(new RegExp(`<max_tool_calls_per_step>(\\d+)</max_tool_calls_per_step>`));
      assert.ok(match, `tier ${c.tier} should contain max_tool_calls_per_step`);
      assert.equal(Number(match![1]), c.expected, `tier ${c.tier} max_tool_calls_per_step should be ${c.expected}`);
    }
  });

  it('tier switch is immediately reflected (no caching)', async () => {
    const sess = new Session({ tier: 'quick' });
    const cfgQuick = TierRegistry.get('quick');
    const pb = new PromptBuilder(sess, cfgQuick);

    let p1 = await pb.buildForTask('task1');
    assert.ok(p1.includes('<tier_constraint tier="quick">'));

    // Switch tier on the same session
    sess.updateTier('zorge');

    const cfgZorge = TierRegistry.get('zorge');
    // Re-create builder with new tierConfig to simulate real usage, or reuse (PromptBuilder reads session.tier live)
    const pb2 = new PromptBuilder(sess, cfgZorge);
    let p2 = await pb2.buildForTask('task2');

    assert.ok(p2.includes('<tier_constraint tier="zorge">'), 'after switch, zorge constraint must appear');
    assert.ok(!p2.includes('<tier_constraint tier="quick">'), 'quick constraint must be gone after switch');
  });

  it('TierConstraintRegistry.get returns correct structure for all tiers', () => {
    for (const t of tiers) {
      const c = TierConstraintRegistry.get(t);
      assert.equal(c.tier, t);
      assert.ok(c.xml.includes('<tier_constraint'), 'xml must contain <tier_constraint');
      assert.ok(c.xml.includes(`tier="${t}"`), 'xml must contain the tier attribute');
    }
  });
});

// ==================== P1-E: Deduplication tests ====================
describe('P1-E PromptBuilder deduplication (v2)', () => {
  it('same logical block (anchor/compaction) appears only once per build', async () => {
    const sess = new Session({ tier: 'high' });
    // >12 turns triggers compaction note
    for (let i = 0; i < 15; i++) {
      sess.addTurn({
        id: 't' + i,
        timestamp: Date.now(),
        userInput: 'x',
        userInputType: 'task',
        tier: 'high',
        durationMs: 1,
      });
    }
    const cfg = TierRegistry.get('high');
    const pb = new PromptBuilder(sess, cfg);
    const prompt = await pb.buildForTask('do the thing');

    const note = '历史较长，已做内部压缩';
    const matches = (prompt.match(new RegExp(note, 'g')) || []).length;
    assert.equal(matches, 1, 'compaction note must appear exactly once');

    // tier_constraint must still be present (never deduped)
    assert.ok(prompt.includes('<tier_constraint tier="high">'), 'tier_constraint must always be injected');
  });

  it('tryInject same key twice skips second and reports duplicatesSkipped', async () => {
    const sess = new Session({ tier: 'standard' });
    const cfg = TierRegistry.get('standard');
    const pb = new PromptBuilder(sess, cfg);

    // Access internals for targeted test (allowed for unit test of dedup mechanism)
    (pb as any).injectedKeys = new Set<string>();
    (pb as any).duplicatesSkipped = 0;

    const lines: string[] = [];
    const key = 'dup-test-key';
    const block = 'UNIQUE_DUP_BLOCK';

    const first = (pb as any).tryInject(key, block, lines);
    const second = (pb as any).tryInject(key, block, lines);

    assert.equal(first, true, 'first insert should succeed');
    assert.equal(second, false, 'second insert of same key must be skipped');
    const count = lines.filter((l: string) => l.includes('UNIQUE_DUP_BLOCK')).length;
    assert.equal(count, 1, 'block must appear only once in output');
    assert.equal((pb as any).duplicatesSkipped, 1, 'duplicatesSkipped must be 1');
  });

  it('tier_constraint is not subject to dedup (always emitted)', async () => {
    const sess = new Session({ tier: 'quick' });
    const cfg = TierRegistry.get('quick');
    const pb = new PromptBuilder(sess, cfg);

    const p1 = await pb.buildForTask('t1');
    const p2 = await pb.buildForTask('t2');

    // Each build must contain the quick tier_constraint (P0-2 rule)
    assert.ok(p1.includes('<tier_constraint tier="quick">'));
    assert.ok(p2.includes('<tier_constraint tier="quick">'));
  });
});
