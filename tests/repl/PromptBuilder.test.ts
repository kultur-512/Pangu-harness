// tests/repl/PromptBuilder.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptBuilder, TierConstraintRegistry } from '../../src/cli/repl/PromptBuilder.js';
import { Session } from '../../src/cli/repl/Session.js';
import { TierRegistry, Tier } from '../../src/tiers/TierConfig.js';
import { SENTENCE_HARD_CUT_CHARS, PAIR_A_CHARS } from '../../src/memory/chatFactMemory.js';

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
    assert.ok(prompt.includes('纪律规则强度'));
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

  it('quick tier now has memoryLoadLevel light (not none)', () => {
    const tierCfg = TierRegistry.get('quick');
    // quick 原为 'none'（零注入），遗留修复改为 'light'（至少注入一层记忆）
    assert.strictEqual(tierCfg.memoryLoadLevel, 'light');
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
    assert.ok(header.includes('纪律规则强度'));
  });
});

// ==================== P0-2: Tier Constraint tests (blueprint) ====================
describe('P0-2 TierConstraintRegistry + PromptBuilder integration', () => {
  const tiers: Tier[] = ['quick', 'standard', 'high', 'max', 'ex', 'pangu'];

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
    sess.updateTier('pangu');

    const cfgPanshalach = TierRegistry.get('pangu');
    // Re-create builder with new tierConfig to simulate real usage, or reuse (PromptBuilder reads session.tier live)
    const pb2 = new PromptBuilder(sess, cfgPanshalach);
    let p2 = await pb2.buildForTask('task2');

    assert.ok(p2.includes('<tier_constraint tier="pangu">'), 'after switch, pangu constraint must appear');
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

    // B3：无合成轮时给诚实提示（不再声称"已做内部压缩"）
    const note = '历史较长';
    const matches = (prompt.match(new RegExp(note, 'g')) || []).length;
    assert.equal(matches, 1, 'compaction note must appear exactly once');
    assert.ok(prompt.includes('/compact 生成压缩摘要'), '诚实提示指向 /compact');
    assert.ok(!prompt.includes('已做内部压缩'), '不再对模型谎称已压缩');

    // tier_constraint must still be present (never deduped)
    assert.ok(prompt.includes('<tier_constraint tier="high">'), 'tier_constraint must always be injected');
  });

  it('B3: [COMPACT] 合成轮存在 → 注入【历史压缩摘要】正文（压缩收益进 prompt）', async () => {
    const sess = new Session({ tier: 'high' });
    sess.addTurn({
      id: 'compact-1',
      timestamp: Date.now(),
      userInput: '[COMPACT] 已压缩 12 轮历史',
      userInputType: 'command',
      tier: 'high',
      durationMs: 1,
      result: { success: true, summary: '用户要求修复 alpha 登录 bug（原文：修复 alpha 模块的登录 bug 并跑通测试）；已验证通过。' },
    });
    for (let i = 0; i < 3; i++) {
      sess.addTurn({ id: 't' + i, timestamp: Date.now(), userInput: '后续任务 ' + i, userInputType: 'task', tier: 'high', durationMs: 1 });
    }
    const cfg = TierRegistry.get('high');
    const pb = new PromptBuilder(sess, cfg);
    const prompt = await pb.buildForTask('继续下一项');
    assert.ok(prompt.includes('【历史压缩摘要】'), '摘要块必须注入');
    assert.ok(prompt.includes('修复 alpha 模块的登录 bug'), '摘要正文必须可见（getRecentContext(3) 取不到合成轮）');
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

// ==================== F7: buildForTask 按 intent 分支注入 ====================
// 0.7：taskIntent 分类已存在（src/cli/taskIntent.ts），buildForTask 参数化接收
// intent。chat 意图不注入重工程块（验证铁律 + 格式教学）；不传 intent = 现状行为
// 完全不变（向后兼容——调用方尚无 intent 信息，接线待分类前移）。
describe('PromptBuilder.buildForTask intent 分支（F7）', () => {
  it("intent='chat'：不注入重工程块（硬约束/档位契约/格式教学/项目验证命令）", async () => {
    const sess = new Session({ tier: 'high' });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    const prompt = await pb.buildForTask('你好，回答我你是谁', 'chat');

    assert.ok(!prompt.includes('【硬约束】'), 'L0 验证铁律块不注入');
    assert.ok(!prompt.includes('【档位契约】'), '档位契约（纪律规则强度）块不注入');
    assert.ok(!prompt.includes('<negative_tool_list>'), '格式教学块不注入');
    assert.ok(!prompt.includes('纪律规则强度'), '无纪律教学文本');

    // R4（0.8.1）：chat 减负——tier XML/thinking_budget/任务状态三块跳过
    // （tier XML 是工具纪律契约，与 chat 指令"不要调用任何工具"同框自相矛盾）。
    assert.ok(!prompt.includes('<tier_constraint'), 'R4：tier_constraint XML 不注入');
    assert.ok(!prompt.includes('<thinking_budget>'), 'R4：thinking_budget 不注入');
    assert.ok(!prompt.includes('【任务状态】'), 'R4：TaskState 不注入');
    // 0.8.1：injection summary 调试块不进模型 prompt（元讨论污染），审计走 lastBuildMeta
    assert.ok(!prompt.includes('<injection_summary>'), '调试块不进模型 prompt');

    // 轻量块保留：身份、当前任务
    assert.ok(prompt.includes('当前档位: high'), '系统身份保留');
    assert.ok(prompt.includes('【当前任务】'), '当前任务块保留');
    assert.ok(prompt.includes('你好，回答我你是谁'), '任务正文保留');
  });

  it("intent='execution'：与现状一致，重工程块全部注入", async () => {
    const sess = new Session({ tier: 'high' });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    const prompt = await pb.buildForTask('修复登录 bug', 'execution');
    assert.ok(prompt.includes('【硬约束】'));
    assert.ok(prompt.includes('【档位契约】'));
    assert.ok(prompt.includes('<negative_tool_list>'));
  });

  it('不传 intent：向后兼容——关键注入块与现状完全一致', async () => {
    const sess = new Session({ tier: 'high' });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    const prompt = await pb.buildForTask('修复登录 bug');
    for (const block of ['【硬约束】', '【档位契约】', '<negative_tool_list>', '<tier_constraint tier="high">']) {
      assert.ok(prompt.includes(block), `不传 intent 必须仍注入 ${block}`);
    }
  });
});

// ==================== 包C 缺陷12：卡 id 契约——去重跳过时无孤儿 id ====================
// 旧代码 `this.lastInjectedCardIds = concat(...)` 在 `if (added)` 之外——tryInject
// 因 key 去重跳过时块未渲染，先行 concat 产出没有 [M*] 行对应的孤儿 id
// （下游 markInjected / ContextSnapshot 审计到"注入了看不见的卡"）。
// 修复：concat 移入 if 内，保证"lastInjectedCardIds 顺序 == [M*] 渲染顺序"契约。
describe('包C 缺陷12：memory-cards key 去重跳过时不产生孤儿注入 id', () => {
  it('预占 memory-cards key 后 appendMemoryCardsDedup 跳过渲染 → lastInjectedCardIds 不新增', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-orphan-'));
    const memFile = path.join(wsRoot, 'mem.json');
    const prevMemFile = process.env.PANSHA_MEMORY_FILE;
    const prevNoMem = process.env.PANSHA_NO_MEMORY;
    process.env.PANSHA_MEMORY_FILE = memFile; // RefinedMemoryStore isAbsolute 直采，隔离于仓库真实记忆
    delete process.env.PANSHA_NO_MEMORY;
    try {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const store = new RefinedMemoryStore(wsRoot);
      const now = Date.now();
      store.save([
        { id: 'orphan-check-1', kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure', summary: '登录空指针修复教训 keywordorphan', weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now },
        { id: 'orphan-check-2', kind: 'failure', category: 'WEAK_VERIFICATION', memoryCategory: 'failure', summary: '终端命令检查教训 keywordorphan', weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now },
      ] as any[]);

      const sess = new Session({ tier: 'high' });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      (pb as any).injectedKeys.add('memory-cards'); // 预占 key → tryInject 必跳过

      const added = await (pb as any).appendMemoryCardsDedup([], undefined, 'fix keywordorphan login');
      assert.equal(added, false, '块被去重跳过 → 返回 false');
      // 旧实现：concat 在 if 外 → 孤儿 id 混入注入账本（红）
      assert.deepEqual((pb as any).lastInjectedCardIds, [], '去重跳过时不得产生孤儿注入 id');
    } finally {
      if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
      else process.env.PANSHA_MEMORY_FILE = prevMemFile;
      if (prevNoMem !== undefined) process.env.PANSHA_NO_MEMORY = prevNoMem;
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it('对照组：正常注入时 ids 与 [M*] 行同批产生（契约不回归）', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-orphan-ok-'));
    const memFile = path.join(wsRoot, 'mem.json');
    const prevMemFile = process.env.PANSHA_MEMORY_FILE;
    const prevNoMem = process.env.PANSHA_NO_MEMORY;
    process.env.PANSHA_MEMORY_FILE = memFile;
    delete process.env.PANSHA_NO_MEMORY;
    try {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const store = new RefinedMemoryStore(wsRoot);
      const now = Date.now();
      const mk = (id: string, summary: string) => ({ id, kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure', summary, weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now });
      store.save([mk('ctl-1', '控制组教训甲 ctrltoken'), mk('ctl-2', '控制组教训乙 ctrltoken'), mk('ctl-3', '控制组教训丙 ctrltoken')] as any[]);

      const sess = new Session({ tier: 'high' });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, 'ctrltoken fix');
      assert.equal(added, true, '前置：正常注入');
      const mLines = lines.filter((l) => l.includes('  - [M'));
      const ids = (pb as any).lastInjectedCardIds as string[];
      assert.equal(ids.length, mLines.length, 'id 数 == [M*] 渲染行数（顺序契约）');
    } finally {
      if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
      else process.env.PANSHA_MEMORY_FILE = prevMemFile;
      if (prevNoMem !== undefined) process.env.PANSHA_NO_MEMORY = prevNoMem;
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});

// ==================== R6（0.8.1）：最近上下文带答案摘要 ====================
describe('PromptBuilder.getRecentContext 答案落盘（R6）', () => {
  it("answered 轮的 answerText 进入最近上下文（截 200 字符，换行折叠）", async () => {
    const sess = new Session({ tier: 'high' });
    const longAnswer = 'BASH是一种Unix shell。' + '补充说明内容很长很长。'.repeat(40);
    sess.addTurn({
      id: 't1',
      timestamp: Date.now(),
      userInput: '什么是bash',
      userInputType: 'task',
      tier: 'high',
      result: {
        success: true,
        summary: '已回复',
        stopReason: 'answered',
        outcome: 'answered',
        answerText: longAnswer,
      },
    } as any);
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    const prompt = await pb.buildForTask('继续刚才的话题', 'chat');

    assert.ok(prompt.includes('【最近上下文'), 'chat 仍保留最近上下文块');
    assert.ok(prompt.includes('什么是bash'), '问题侧保留');
    assert.ok(prompt.includes('已回复'), 'summary 保留');
    assert.ok(prompt.includes('→ BASH是一种Unix shell。'), '答案摘要以 → 前缀进入最近上下文');
    const prefix = longAnswer.slice(0, 200);
    assert.ok(prompt.includes(prefix), '答案前 200 字符可见');
    assert.ok(!prompt.includes(longAnswer.slice(0, 201)), '答案超 200 字符部分截断（防膨胀）');
  });

  it('无 answerText 的轮（completed/旧数据）摘要不变（向后兼容）', async () => {
    const sess = new Session({ tier: 'high' });
    sess.addTurn({
      id: 't2',
      timestamp: Date.now(),
      userInput: '修复登录 bug',
      userInputType: 'task',
      tier: 'high',
      result: { success: true, summary: '已通过验证', stopReason: 'completed', outcome: 'completed' },
    } as any);
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    const prompt = await pb.buildForTask('继续', 'execution');
    assert.ok(prompt.includes('修复登录 bug 已通过验证'), '原摘要行形状保持');
    assert.ok(!prompt.includes(' → '), '无答案轮不引入答案段');
  });
});

// ==================== 0.8.3 记忆时间锚定：消费者今天感知 + 事实时间渲染 ====================
// temporal-reasoning 题型 0/15 修复的两处产品面：
//   (a) stable 段身份行带"今天是 …"（QA prompt 此前没有今天是几号）；
//   (b) 卡带 factDateText → 渲染 [事实时间:…]；悬空 [S日期] 规则替换为事实时间差值规则。
describe('PromptBuilder 时间锚定（0.8.3）', () => {
  let savedToday: string | undefined;
  const setToday = (v?: string) => {
    if (v === undefined) delete process.env.PANSHA_TODAY;
    else process.env.PANSHA_TODAY = v;
  };
  const withToday = async (v: string | undefined, fn: () => Promise<void>) => {
    savedToday = process.env.PANSHA_TODAY;
    setToday(v);
    try { await fn(); } finally {
      if (savedToday !== undefined) process.env.PANSHA_TODAY = savedToday;
      else setToday(undefined);
    }
  };

  it('stable 段身份行带"今天是 …"（PANSHA_TODAY 可控，天内字节稳定）', async () => {
    await withToday('2023-01-19', async () => {
      const sess = new Session({ tier: 'high' });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const s1 = pb.buildStableSegment('chat');
      const s2 = pb.buildStableSegment('chat');
      assert.ok(s1.includes('今天是 2023-01-19。'), '身份行注入今天');
      assert.equal(s1, s2, 'stable 段逐字节相同（天内，前缀缓存友好）');
      const p1 = await pb.buildForTask('任务甲', 'chat');
      assert.ok(p1.includes('今天是 2023-01-19。'), 'buildForTask 产物带今天');
    });
  });

  it('悬空 [S日期] 规则替换为事实时间差值规则（不再引用无人产出的前缀）', async () => {
    const sess = new Session({ tier: 'high' });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    const prompt = await pb.buildForTask('任意任务');
    if (prompt.includes('【相关记忆】')) {
      assert.ok(prompt.includes('事实发生时间'), '新规则文案在场');
      assert.ok(!prompt.includes('[S日期]'), '悬空规则移除');
    }
  });

  it('卡带 factDateText → 渲染 [事实时间:…]；无字段老卡渲染不变（溢出块同规则）', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-factdate-'));
    const memFile = path.join(wsRoot, 'mem.json');
    const prevMemFile = process.env.PANSHA_MEMORY_FILE;
    process.env.PANSHA_MEMORY_FILE = memFile;
    try {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const store = new RefinedMemoryStore(wsRoot);
      const now = Date.now();
      const mk = (id: string, summary: string, extra: object = {}) => ({
        id, kind: 'preference', category: 'OTHER', memoryCategory: 'insight', summary,
        weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now,
        applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now, ...extra,
      });
      store.save([
        mk('fact-1', '用户完成了一次 5K 跑步 facttag', { factDate: Date.UTC(2023, 0, 19), factDateText: '2023-01-19' }),
        mk('fact-2', '用户喜欢清晨跑步 facttag', { factDate: Date.UTC(2023, 4, 1), factDateText: '2023-05-01' }),
        mk('fact-3', '用户住在西雅图 facttag'), // 老卡：无字段
      ] as any[]);

      const sess = new Session({ tier: 'high' });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, 'facttag');
      assert.equal(added, true, '前置：注入成功');
      const mLines = lines.filter((l) => l.includes('  - [M'));
      const withTag = mLines.filter((l) => l.includes('[事实时间:'));
      const withoutTag = mLines.filter((l) => !l.includes('[事实时间:'));
      assert.ok(mLines.some((l) => l.includes('[事实时间:2023-01-19]') && l.includes('5K 跑步')), '渲染形状 [M] [标签] [事实时间:…] 摘要');
      assert.ok(withTag.length >= 2, '带字段卡都渲染事实时间');
      assert.ok(withoutTag.some((l) => l.includes('西雅图')), '无字段老卡渲染不变');
      // 溢出块（auto-pull）同样规则：预占 L1 名额，把剩余卡挤进溢出块
      const pb2 = new PromptBuilder(sess, TierRegistry.get('high'));
      process.env.PANSHA_MEMORY_LIMIT = '1';
      try {
        const lines2: string[] = [];
        await (pb2 as any).appendMemoryCardsDedup(lines2, undefined, 'facttag');
        (pb2 as any).autoPulledThisBuild = false;
        (pb2 as any).memoryNumberSeq = (pb2 as any).lastInjectedCardIds.length;
        const store2 = new RefinedMemoryStore(wsRoot);
        const overflow = store2.getOverflowCards({ tier: 'high', keywords: ['facttag'] }, (pb2 as any).lastInjectedCardIds);
        assert.ok(overflow.pulled.length >= 1, '前置：存在溢出卡');
        const r = await (pb2 as any).buildVolatileSegment('facttag');
        assert.ok(r.includes('【额外记忆】'), '溢出块注入');
        const extra = r.split('【额外记忆】')[1] || '';
        assert.ok(extra.includes('[事实时间:'), '溢出块卡渲染事实时间');
      } finally {
        delete process.env.PANSHA_MEMORY_LIMIT;
      }
    } finally {
      if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
      else process.env.PANSHA_MEMORY_FILE = prevMemFile;
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});

// ==================== chat/execution 出口一致性（2026-09-13 迭代包） ====================
// 【3】ghost 行修复：模板里的 '\n' 前缀使 lastMemoryBlockText 过滤器
// l.startsWith('（另有') 永不匹配 → chat 块永远没有"另有 N 张"提示；
// 【2】auto-pull 审计如实：chat 意图不做 auto-pull——额外卡进不了 chat 块，
// 只白耗嵌入计算并让 lastInjectedCardIds（注入审计账本）虚报。
describe('chat/execution 出口一致性（2026-09-13 迭代包）', () => {
  const seedCards = (store: any): void => {
    const now = Date.now();
    store.save([
      { id: 'exit-1', kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure', summary: '记忆卡甲 exitgate', weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now },
      { id: 'exit-2', kind: 'failure', category: 'WEAK_VERIFICATION', memoryCategory: 'failure', summary: '记忆卡乙 exitgate', weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now },
      { id: 'exit-3', kind: 'failure', category: 'WEAK_VERIFICATION', memoryCategory: 'failure', summary: '记忆卡丙 exitgate', weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now },
    ] as any[]);
  };

  const withIsoWs = async (fn: (wsRoot: string) => Promise<void>): Promise<void> => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-exit-consistency-'));
    const prevMemFile = process.env.PANSHA_MEMORY_FILE;
    const prevNoMem = process.env.PANSHA_NO_MEMORY;
    const prevLimit = process.env.PANSHA_MEMORY_LIMIT;
    process.env.PANSHA_MEMORY_FILE = path.join(wsRoot, 'mem.json');
    delete process.env.PANSHA_NO_MEMORY;
    process.env.PANSHA_MEMORY_LIMIT = '1'; // L1 只装 1 张 → 必有溢出
    try {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      seedCards(new RefinedMemoryStore(wsRoot));
      await fn(wsRoot);
    } finally {
      if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
      else process.env.PANSHA_MEMORY_FILE = prevMemFile;
      if (prevNoMem !== undefined) process.env.PANSHA_NO_MEMORY = prevNoMem;
      else delete process.env.PANSHA_NO_MEMORY;
      if (prevLimit !== undefined) process.env.PANSHA_MEMORY_LIMIT = prevLimit;
      else delete process.env.PANSHA_MEMORY_LIMIT;
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  };

  it('【3】L1 溢出时 getChatMemoryBlock 含"另有 N 张相关记忆未注入"提示（\n 前缀曾致过滤器永不匹配）', async () => {
    await withIsoWs(async () => {
      const sess = new Session({ tier: 'high', workspace: process.cwd() });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      await pb.buildForTask('exitgate 相关任务');
      const block = pb.getChatMemoryBlock();
      assert.ok(block.includes('【相关记忆】'), '前置：chat 记忆块存在');
      assert.ok(
        block.includes('（另有 2 张相关记忆未注入，/memory 查看）'),
        `chat 块必须带 ghost 提示，got: ${JSON.stringify(block.slice(-200))}`
      );
    });
  });

  it('【3】rich prompt 渲染仍含 ghost 行（去 \n 前缀不丢内容）', async () => {
    await withIsoWs(async () => {
      const sess = new Session({ tier: 'high', workspace: process.cwd() });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const prompt = await pb.buildForTask('exitgate 相关任务');
      assert.ok(prompt.includes('（另有 2 张相关记忆未注入，/memory 查看）'), 'rich 渲染 ghost 行保留');
    });
  });

  it('【2】chat 意图不做 auto-pull：lastInjectedCardIds 只含 L1 可见卡（审计不虚报）', async () => {
    await withIsoWs(async () => {
      const sess = new Session({ tier: 'high', workspace: process.cwd() });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      await pb.buildForTask('exitgate 相关任务', 'chat');
      const ids = pb.lastBuildMeta?.injectedCardIds ?? [];
      assert.equal(ids.length, 1, `chat 只注 L1 的 1 张（旧实现 auto-pull 虚报到 3），got ${ids.length}`);
      const visibleM = (pb.getChatMemoryBlock().match(/  - \[M\d+\]/g) ?? []).length;
      assert.equal(visibleM, ids.length, '审计 ids 数 == chat 块可见 [M*] 行数（出口一致）');
    });
  });

  it('【2】非 chat（execution/缺省）auto-pull 行为不变：溢出卡照常拉进【额外记忆】', async () => {
    await withIsoWs(async () => {
      const sess = new Session({ tier: 'high', workspace: process.cwd() });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const prompt = await pb.buildForTask('exitgate 相关任务');
      assert.ok(prompt.includes('【额外记忆】'), '非 chat 溢出块照常注入');
      const ids = pb.lastBuildMeta?.injectedCardIds ?? [];
      assert.equal(ids.length, 3, '非 chat 审计账本含 L1+溢出共 3 张');
    });
  });
});

// ==================== 2026-09-14 ZL vs CC 差距修复：注入面扩容 ====================
const withIsoMemFile = async (fn: (wsRoot: string, memFile: string) => Promise<void>): Promise<void> => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-inject-scale-'));
  const memFile = path.join(wsRoot, 'mem.json');
  const prevMemFile = process.env.PANSHA_MEMORY_FILE;
  process.env.PANSHA_MEMORY_FILE = memFile;
  try {
    await fn(wsRoot, memFile);
  } finally {
    if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
    else process.env.PANSHA_MEMORY_FILE = prevMemFile;
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
};

describe('#1 普通卡渲染帽 240（与写侧句切分硬切同源）', () => {
  it('长 summary 第 120-240 字符段的数字在渲染后存活', async () => {
    assert.equal(SENTENCE_HARD_CUT_CHARS, 240, '共享常量 = 240（渲染帽与 splitSentences 硬切同源）');
    await withIsoMemFile(async (wsRoot) => {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const now = Date.now();
      // 无句末标点的长 summary：'42' 位于第 ~162 字符（120 帽会截掉、240 帽存活）
      const summary = `render240kw ${'Y'.repeat(150)} 42 ${'Z'.repeat(200)}`;
      const store = new RefinedMemoryStore(wsRoot);
      store.save([{
        id: 'r240-1', kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure',
        summary, weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now,
        applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now,
      }] as any[]);

      const sess = new Session({ tier: 'high' });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, 'render240kw task');
      assert.equal(added, true, '前置：注入成功');
      const mLines = lines.filter((l) => l.includes('  - [M'));
      assert.equal(mLines.length, 1);
      assert.ok(mLines[0].includes(' 42 '), '第 120-240 字符段的数字存活（旧 120 渲染帽会截掉）');
    });
  });
});

describe('#3 对卡 A 行渲染 400（C2：smartSlice 数字句优先；写侧 PAIR_A_CHARS=800 不动）', () => {
  it('A 侧 800 字符盘上保留；渲染 ≤400 且 600 字符处的数字句存活', async () => {
    assert.equal(PAIR_A_CHARS, 800, '写侧 A 行预算 = 800（盘上数据不丢，渲染时才裁）');
    await withIsoMemFile(async (wsRoot) => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const now = Date.now();
      // A 侧 800 字符：数字句（含 '10 hours'）位于第 ~601 字符——旧 slice(0,400)
      // 渲染必截掉；smartSlice(400) 数字句优先把它拉进渲染段。
      const aBody =
        'p'.repeat(300) + '. ' + 'q'.repeat(297) + '. ' + 'AMARK800 worked 10 hours in total. ' + 'r'.repeat(164);
      assert.equal(aBody.length, 800, '前置：A 侧 800 字符');
      const store = new RefinedMemoryStore(wsRoot);
      store.save([{
        id: 'pair-render400', kind: 'preference', category: 'OTHER', memoryCategory: 'insight',
        source: 'dialogue-pair', summary: `Q: 渲染帽同步测试\nA: ${aBody}`,
        weight: 0.8, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now,
        applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now, confidence: 1.0,
      }] as any[]);

      const sess = new Session({ tier: 'high' });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, '渲染帽同步测试');
      assert.equal(added, true, '前置：注入成功');
      const aLine = lines.find((l) => l.startsWith('    A: '));
      assert.ok(aLine, '对卡渲染 A 行');
      assert.ok(aLine!.includes('AMARK800') && aLine!.includes('10 hours'), '600 字符处的数字句渲染后存活（数字句优先）');
      // it2 迭代回退（assistant 8→5/user 7→5 实证 400 裁剪净损失）：渲染与写侧同源 800
      assert.ok(aLine!.length <= '    A: '.length + 800, `渲染 A 行 ≤800 字符，got ${aLine!.length - '    A: '.length}`);
      // 盘上数据不丢：写侧 800 原文仍在
      const onDisk = JSON.parse(fs.readFileSync(path.join(wsRoot, 'mem.json'), 'utf8'));
      const diskA = String(onDisk.cards[0].summary).split('\n')[1].replace(/^A:\s*/i, '');
      assert.equal(diskA.length, 800, '盘上 A 侧仍 800 字符（写侧 PAIR_A_CHARS 不动）');
      assert.ok(diskA.includes('AMARK800'), '盘上原文完整');
    });
  });
});

describe('#2 注入预算随窗口放大（memoryBudgetTokens / memoryCardLimitForLevel）', () => {
  const withCtx = async (w: string, fn: () => void): Promise<void> => {
    const prev = process.env.PANSHA_CTX_WINDOW;
    process.env.PANSHA_CTX_WINDOW = w;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.PANSHA_CTX_WINDOW;
      else process.env.PANSHA_CTX_WINDOW = prev;
    }
  };

  it('memoryBudgetTokens：8K→1229（R2 统一 15%）、32K→1600 帽不变；1M→15625 不变', async () => {
    const sess = new Session({ tier: 'high' });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    await withCtx('8192', () => assert.equal((pb as any).memoryBudgetTokens(), 1229, '8K 窗预算 10%→15%（819 只装 3.8 张对卡的第一瓶颈）'));
    await withCtx('32768', () => assert.equal((pb as any).memoryBudgetTokens(), 1600, '32K 窗预算帽不变'));
    await withCtx('1000000', () => assert.equal((pb as any).memoryBudgetTokens(), 15625, '1M 窗预算不变'));
  });

  it('memoryCardLimitForLevel：8K→29 随预算放大、32K→39 不变、1M→200；PANSHA_MEMORY_LIMIT 逃生门优先', async () => {
    const sess = new Session({ tier: 'high' });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    // high 档的 memoryLoadLevel='medium'（mult=1.0 基准，行为不变）
    await withCtx('8192', () => assert.equal((pb as any).memoryCardLimitForLevel('medium'), 29, '8K 张数帽随预算 1229 放大（floor(1229/41)=29）'));
    await withCtx('32768', () => assert.equal((pb as any).memoryCardLimitForLevel('medium'), 39, '32K 窗张数帽不变'));
    await withCtx('1000000', () => assert.equal((pb as any).memoryCardLimitForLevel('medium'), 200, '1M 窗张数帽 200'));
    const prevLimit = process.env.PANSHA_MEMORY_LIMIT;
    process.env.PANSHA_MEMORY_LIMIT = '5';
    try {
      await withCtx('1000000', () => assert.equal((pb as any).memoryCardLimitForLevel('medium'), 5, '显式逃生门优先（1M 窗也尊重）'));
    } finally {
      if (prevLimit === undefined) delete process.env.PANSHA_MEMORY_LIMIT;
      else process.env.PANSHA_MEMORY_LIMIT = prevLimit;
    }
  });

  it('73 卡库：1M 窗全注；32K 窗同库仍 39 张（张数帽）', async () => {
    await withIsoMemFile(async (wsRoot) => {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const now = Date.now();
      const store = new RefinedMemoryStore(wsRoot);
      store.save(Array.from({ length: 73 }, (_, i) => ({
        id: `s3-${i}`, kind: 'preference', category: 'OTHER', memoryCategory: 'insight',
        summary: `seventy3 记忆卡第${i}条`, weight: 0.8, taskStyle: 'all', count: 1,
        lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
        decayWeight: 1.0, lastUsedAt: now,
      })) as any[]);

      const inject = async (w: string): Promise<number> => {
        const prev = process.env.PANSHA_CTX_WINDOW;
        process.env.PANSHA_CTX_WINDOW = w;
        try {
          const sess = new Session({ tier: 'high' });
          const pb = new PromptBuilder(sess, TierRegistry.get('high'));
          const lines: string[] = [];
          await (pb as any).appendMemoryCardsDedup(lines, undefined, 'seventy3 相关任务');
          return lines.filter((l) => l.includes('  - [M')).length;
        } finally {
          if (prev === undefined) delete process.env.PANSHA_CTX_WINDOW;
          else process.env.PANSHA_CTX_WINDOW = prev;
        }
      };

      assert.equal(await inject('1000000'), 73, '1M 窗：73 卡库全注（旧 40 帽只放 40）');
      assert.equal(await inject('32768'), 39, '32K 窗：张数帽仍 39（小窗行为不变）');
    });
  });
});

// ==================== 2026-09-14 LME 1B 失败归因驱动：R1/C1/L1 ====================
// 归因：819 token 预算实际只装 3.8 张对卡是注入面第一瓶颈（R1/R2）；KU 新旧值
// 选错是管道主动误导（C1a 渲染顺序 + C1b 规则行）；语言/单位不匹配（L1）。
//   R1 注入贪心 break→skip：装不下的大卡跳过，其后小卡继续装满预算；
//   C1(a) 注入块按 factDate 升序稳定重排（后注入者=事实时间更新者）；
//   C1(b)+L1 规则行补"以[事实时间]最新为准"冲突规则与答案语言镜像。
const LME_ENV_KEYS = [
  'PANSHA_MEMORY_FILE',
  'PANSHA_NO_MEMORY',
  'PANSHA_CTX_WINDOW',
  'PANSHA_MEMORY_LIMIT',
  'PANSHA_SEMANTIC_SEARCH',
] as const;
let lmeSavedEnv: Record<string, string | undefined> = {};

/**
 * 隔离记忆文件 + 关语义通道（词面排序路径确定：同分回退稳定插入序，测试可
 * 精确构造"存盘顺序 ≠ 期望渲染顺序"）。测试后恢复全部 env。
 */
const withLmeIsoMem = async (fn: (wsRoot: string) => Promise<void>): Promise<void> => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-lme2-'));
  lmeSavedEnv = {};
  for (const k of LME_ENV_KEYS) lmeSavedEnv[k] = process.env[k];
  process.env.PANSHA_MEMORY_FILE = path.join(wsRoot, 'mem.json');
  delete process.env.PANSHA_NO_MEMORY;
  process.env.PANSHA_SEMANTIC_SEARCH = '0';
  try {
    await fn(wsRoot);
  } finally {
    for (const k of LME_ENV_KEYS) {
      if (lmeSavedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = lmeSavedEnv[k];
    }
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
};

const withLmeWindow = async (w: string, fn: () => Promise<void> | void): Promise<void> => {
  const prev = process.env.PANSHA_CTX_WINDOW;
  process.env.PANSHA_CTX_WINDOW = w;
  try {
    await fn(); // await：appendMemoryCardsDedup 是异步的，不等待会让 env 在生效前还原
  } finally {
    if (prev === undefined) delete process.env.PANSHA_CTX_WINDOW;
    else process.env.PANSHA_CTX_WINDOW = prev;
  }
};

const lmeBaseCard = (id: string, summary: string, extra: object = {}) => ({
  id,
  kind: 'failure',
  category: 'COMMAND_FAILED',
  memoryCategory: 'failure',
  summary,
  weight: 2,
  taskStyle: 'all',
  count: 1,
  // review 建议-2 去 flake：loadFiltered 同分回退是 lastSeen desc（非插入序），
  // 由调用方用 extra.lastSeen 显式错开（Date.now() 同毫秒假设是 flake 源）
  lastSeen: Date.now(),
  firstSeen: Date.now(),
  applicableTiers: [],
  sourceContext: '',
  decayWeight: 1.0,
  lastUsedAt: Date.now(),
  ...extra,
});

describe('LME-R1：注入贪心 break→skip（装不下的大卡跳过，后面小卡继续装）', () => {
  it('大卡在预算中段落选后，其后的小卡仍入选（旧 break 语义下落选）', async () => {
    await withLmeIsoMem(async (wsRoot) => {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const store = new RefinedMemoryStore(wsRoot);
      // w=1024 → 预算 ceil(1024×0.15)=154 tokens（R2 统一 15%）。
      // 满长普通卡渲染成本：'  - [M1] [失败教训] ' + 240 ascii + '...' = 70 tokens；
      // 短卡（17 ascii）= 14 tokens。
      // c1+c2 装入（140 ≤ 154）→ big 卡 140+70=210 > 154 跳过 → small 卡
      // 140+14=154 ≤ 154 入选。旧 break 语义在 big 卡处直接终止 → small 落选。
      // review 建议-2 去 flake：显式 lastSeen 错开且保持断言所需序（FILLER1 →
      // FILLER2 → big → small，lastSeen desc 回退 = 插入序），消除同毫秒假设
      let seq = 0;
      const full = (id: string, marker: string) =>
        lmeBaseCard(id, `r1skip ${marker} ${'x'.repeat(232)}`, { lastSeen: Date.now() - ++seq * 1000 }); // 240 ascii 满长
      store.save([
        full('r1-c1', 'FILLER1'),
        full('r1-c2', 'FILLER2'),
        full('r1-big', 'R1BIGONE'),
        lmeBaseCard('r1-small', 'r1skip R1SMALLTWO', { lastSeen: Date.now() - 4000 }),
      ]);

      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      await withLmeWindow('1024', async () => {
        const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, 'r1skip task');
        assert.equal(added, true, '前置：注入成功');
      });
      const joined = lines.join('\n');
      const mLines = lines.filter((l) => l.includes('  - [M'));
      assert.equal(mLines.length, 3, `c1/c2/small 入选（big 跳过），got ${mLines.length}`);
      assert.ok(joined.includes('R1SMALLTWO'), '大卡落选后其后小卡仍入选（R1 核心断言，旧 break 下必红）');
      assert.ok(!joined.includes('R1BIGONE'), '装不下的大卡被跳过（不占预算）');
      assert.ok(joined.includes('FILLER1') && joined.includes('FILLER2'), '前置小卡不受影响');
    });
  });

  it('首卡超预算仍收录（"至少保 1 张"语义保留）', async () => {
    await withLmeIsoMem(async (wsRoot) => {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const store = new RefinedMemoryStore(wsRoot);
      store.save([lmeBaseCard('r1-only', `r1skip ONLYCARD ${'x'.repeat(230)}`)]);
      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      await withLmeWindow('256', async () => {
        // w=256 → 预算 ceil(38.4)=39 < 单卡 70：首卡仍必收
        const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, 'r1skip task');
        assert.equal(added, true, '首卡超预算仍注入');
      });
      assert.ok(lines.join('\n').includes('ONLYCARD'), '"至少保 1 张"语义保留');
    });
  });
});

describe('LME-C1a：注入渲染按 factDate 升序（后注入者=事实时间更新者）', () => {
  it('同主题卡 factDate 升序渲染；无 factDate 老卡排最后且保持原序；[M*] 连续重编', async () => {
    await withLmeIsoMem(async (wsRoot) => {
      const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
      const store = new RefinedMemoryStore(wsRoot);
      // 存盘顺序故意与新→旧日期一致——检索同分回退是 lastSeen desc（review
      // 建议-2 去 flake）：显式指定 lastSeen 锁定排序，消除 Date.now() 同毫秒假设
      store.save([
        lmeBaseCard('ku-new', 'kuorder KUNEWER 部门预算改为 300 万', {
          factDate: Date.UTC(2023, 4, 1),
          factDateText: '2023-05-01',
          lastSeen: Date.now() + 2000,
        }),
        lmeBaseCard('ku-old', 'kuorder KUOLDER 部门预算为 200 万', {
          factDate: Date.UTC(2023, 0, 19),
          factDateText: '2023-01-19',
          lastSeen: Date.now() + 1000,
        }),
        lmeBaseCard('ku-nd1', 'kuorder KUNODATE1 无日期事实甲', { lastSeen: Date.now() + 500 }),
        lmeBaseCard('ku-nd2', 'kuorder KUNODATE2 无日期事实乙', { lastSeen: Date.now() + 100 }),
      ]);

      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, 'kuorder 部门预算');
      assert.equal(added, true, '前置：注入成功');
      const mLines = lines.filter((l) => l.includes('  - [M'));
      assert.equal(mLines.length, 4, '前置：4 张全部入选');
      const idx = (marker: string): number => mLines.findIndex((l) => l.includes(marker));
      assert.ok(idx('KUOLDER') >= 0 && idx('KUNEWER') >= 0, '前置：两卡都渲染');
      assert.ok(idx('KUOLDER') < idx('KUNEWER'), 'factDate 升序：旧日期卡在前（存盘顺序相反，证明重排发生）');
      assert.ok(idx('KUNEWER') < idx('KUNODATE1'), '无 factDate 卡排在有日期卡之后');
      assert.ok(idx('KUNODATE1') < idx('KUNODATE2'), '无 factDate 卡之间保持原序（稳定）');
      assert.ok(mLines[idx('KUOLDER')].includes('[M1]'), '[M*] 按重排后顺序连续编（重排后的首卡 = M1）');
      assert.ok(mLines[idx('KUNODATE2')].includes('[M4]'), '末卡编号 [M4]');
      assert.deepEqual(
        (pb as any).lastInjectedCardIds,
        ['ku-old', 'ku-new', 'ku-nd1', 'ku-nd2'],
        '注入账本顺序 == [M*] 渲染顺序（接口契约 v3）'
      );
    });
  });
});

describe('LME-C1b+L1：规则行补"新旧值取最新"与答案语言镜像', () => {
  const seedOne = async (wsRoot: string): Promise<void> => {
    const { RefinedMemoryStore } = await import('../../src/memory/RefinedMemoryStore.js');
    const store = new RefinedMemoryStore(wsRoot);
    store.save([lmeBaseCard('rule-1', 'rulecheck 规则行验证卡')]);
  };

  it('注入规则行含冲突规则（同一事实以[事实时间]最新为准）', async () => {
    await withLmeIsoMem(async (wsRoot) => {
      await seedOne(wsRoot);
      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      await (pb as any).appendMemoryCardsDedup(lines, undefined, 'rulecheck');
      const joined = lines.join('\n');
      assert.ok(
        joined.includes('同一事实出现新旧不同数值时，以[事实时间]最新的一条为准。'),
        'C1b 冲突规则文案在场'
      );
    });
  });

  it('注入规则行含答案语言镜像（以提问语言作答，数字与单位保留原文写法）', async () => {
    await withLmeIsoMem(async (wsRoot) => {
      await seedOne(wsRoot);
      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      await (pb as any).appendMemoryCardsDedup(lines, undefined, 'rulecheck');
      const joined = lines.join('\n');
      assert.ok(
        joined.includes('以用户提问的语言作答，数字与单位保留提问原文的写法'),
        'L1 语言镜像文案在场'
      );
    });
  });

  it('规则行整行仍进 chat 直答记忆块（过滤器按 l.includes("（规则：") 放行）', async () => {
    await withLmeIsoMem(async (wsRoot) => {
      await seedOne(wsRoot);
      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      await pb.buildForTask('rulecheck 相关提问', 'chat');
      const block = pb.getChatMemoryBlock();
      assert.ok(block.includes('（规则：'), '前置：规则行进 chat 块');
      assert.ok(block.includes('同一事实出现新旧不同数值时'), 'C1b 冲突规则进 chat 块');
      assert.ok(block.includes('以用户提问的语言作答'), 'L1 语言镜像进 chat 块');
    });
  });
});

// ==================== B2：env 快照跨任务存活（挂在 Session 上） ====================
// 旧实现把 prevEnvSnapshot 存 PromptBuilder 实例字段上，而三个调用方
// （Repl.getPromptBuilder / runAgentTask / SimulateCommand）每任务 new 实例 →
// 快照每任务重置为 null，env 增量比对恒从 null 基线起（每次全量 cwd delta）。
// 修复后快照挂在 Session 上：同一 session 内第二次 buildForTask 且 env 无变化
// → delta 段为空；env 有增量 → delta 只含增量。每 build 都 new 独立 builder
// （镜像真实调用方），旧实现下本组断言必红。
describe('B2 env 快照跨任务存活（Session 承载）', () => {
  it('同一 session 连续两次 buildForTask：第二次 env delta 段为空', async () => {
    const { execFileSync } = await import('node:child_process');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-env-session-'));
    try {
      execFileSync('git', ['init', '-q', wsRoot], { stdio: 'ignore' });
      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const cfg = TierRegistry.get('high');

      // 第一次 build（新 builder）：session 无快照 → cwd 基线注入（语义不变）
      const p1 = await new PromptBuilder(sess, cfg).buildForTask('任务一');
      assert.ok(p1.includes('【环境变更】'), '首 build 注入 env 基线段');
      assert.ok(p1.includes('【环境变更】\ncwd:'), '首 build 基线只报 cwd');
      assert.ok(!p1.includes('changed:'), '首 build 不 flood fs');

      // 第二次 build（换新 builder，同一 session）：env 无变化 → delta 为空
      const p2 = await new PromptBuilder(sess, cfg).buildForTask('任务二');
      assert.ok(!p2.includes('【环境变更】'), 'env 无变化 → 第二次 delta 段为空（旧实现每任务 new builder 必全量重注）');

      // 快照已落在 session 上
      assert.ok(sess.envSnapshot, '快照挂在 Session 上');
      assert.equal(sess.envSnapshot!.cwd, wsRoot, '快照记录 workspace');
    } finally {
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it('session 内新增文件后第三次 build：delta 只含该项（不重注 cwd/branch）', async () => {
    const { execFileSync } = await import('node:child_process');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-env-session2-'));
    try {
      execFileSync('git', ['init', '-q', wsRoot], { stdio: 'ignore' });
      const sess = new Session({ tier: 'high', workspace: wsRoot });
      const cfg = TierRegistry.get('high');

      await new PromptBuilder(sess, cfg).buildForTask('任务一'); // 基线
      const p2 = await new PromptBuilder(sess, cfg).buildForTask('任务二'); // 无变化
      assert.ok(!p2.includes('【环境变更】'), '前置：第二次 delta 为空');

      // env 变化：工作区新增文件（git status --porcelain 可见）
      fs.writeFileSync(path.join(wsRoot, 'newfile.txt'), 'hello');

      const p3 = await new PromptBuilder(sess, cfg).buildForTask('任务三');
      assert.ok(p3.includes('【环境变更】'), 'env 有变化 → delta 段出现');
      assert.ok(p3.includes('【环境变更】\nchanged: newfile.txt'), 'delta 只含新增的文件');
      assert.ok(!p3.includes('【环境变更】\ncwd:'), 'cwd 未变 → 不重注');
      assert.ok(!p3.includes('【环境变更】\nbranch:'), 'branch 未变 → 不重注');
    } finally {
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it('快照按 session 隔离：另一 session 首 build 仍从 cwd 基线起（非全局/静态缓存）', async () => {
    const { execFileSync } = await import('node:child_process');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-env-session3-'));
    try {
      execFileSync('git', ['init', '-q', wsRoot], { stdio: 'ignore' });
      const cfg = TierRegistry.get('high');

      const sess1 = new Session({ tier: 'high', workspace: wsRoot });
      await new PromptBuilder(sess1, cfg).buildForTask('任务一');

      const sess2 = new Session({ tier: 'high', workspace: wsRoot });
      const p = await new PromptBuilder(sess2, cfg).buildForTask('任务一');
      assert.ok(p.includes('【环境变更】\ncwd:'), '新 session 无快照 → 首 build 仍注入 cwd 基线');
      assert.ok(!p.includes('changed:'), '基线只报 cwd');
    } finally {
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});

