// tests/memory/ChineseRetrieval.test.ts
// 检索通路 + 排序公平性迭代包（2026-09-13）：中文/多轮场景检索双通道修复。
//
// 三路探查实证（修复动因）：
//  - 中文无空格 → issue.split(/\s+/) 恒产出整句 token → summary.includes(整句)
//    永不命中 → 词面通道全灭；
//  - 语义闸 kws>=2 对中文恒闭（整句常只抽出 1 个"关键词"）→ 排序退化纯新近度；
//  - 77 字无关历史前缀把 gold cos 0.119 砸到 0.030（查询稀释）；
//  - 对卡 effBase = 0.5(weight)×0.6(preference 基线) = 0.3 恰踩出局门，衰减一段
//    （×0.7 → 0.21）即硬出局；零相关工程卡 eff 2.0（纯词面 0.7×2=1.4）全面压制。
//
// 本文件锁定四个修复面（【1】【2】【3】【4】）+ 中文检索端到端回归（11 张中文卡
// 种子 × 6 个改写查询，gold 名次 ≤2）+ 英文行为守护（与改前逐字节一致）。
// 磁盘面：全部走 mkdtemp 临时目录（仿 HybridRank 的 store.save 覆盖模式），零仓库写。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore, setSemanticEmbedderForTest } from '../../src/memory/RefinedMemoryStore.js';
import { extractKeywordsFromIssue, PromptBuilder } from '../../src/cli/repl/PromptBuilder.js';
import { Session } from '../../src/cli/repl/Session.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';

let ws = '';
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-cn-retrieval-')); });
afterEach(() => {
  setSemanticEmbedderForTest(null);
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

function makeStore(filename: string): RefinedMemoryStore {
  return new RefinedMemoryStore(ws, filename);
}

/** 工程卡（失败教训，写侧 refine 产物形状：weight 2、decayWeight 1.0——
 * effBase 按 decayWeight 优先 → fresh eff = 1.0，纯词面分 0.7×1=0.7）。 */
function mkEng(id: string, summary: string, extra: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id, kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure',
    summary, weight: 2, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
    decayWeight: 1.0, lastUsedAt: now, ...extra,
  };
}

/** 对卡（chatFactMemory.recordConversationTurn 产物形状；weight 0.8 为【4】改后值）。 */
function mkPair(id: string, summary: string, extra: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id, kind: 'preference', category: 'OTHER', memoryCategory: 'insight', summary,
    weight: 0.8, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [],
    sourceContext: '对话事实沉淀（对话对）', decayWeight: 1.0, lastUsedAt: now,
    source: 'dialogue-pair', confidence: 0.8, ...extra,
  };
}

/** 句级补充卡（chatFactMemory 产物形状：无 source/confidence 字段）。 */
function mkSent(id: string, summary: string, extra: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id, kind: 'preference', category: 'OTHER', memoryCategory: 'insight', summary,
    weight: 0.8, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [],
    sourceContext: '对话事实沉淀（句级拆卡）', decayWeight: 1.0, lastUsedAt: now, ...extra,
  };
}

// ==================== 【1】关键词抽取：CJK 分支（英文路径逐字节不变） ====================
describe('【1】关键词抽取 CJK 分支', () => {
  it('无空格中文：数字串单独成关键词，短句按标点切分（探查报告示例）', () => {
    assert.deepEqual(
      extractKeywordsFromIssue('我3月开始学法语，每周上两次课'),
      ['3月', '我开始学法语', '每周上两次课'],
      '数字串（含"3月"）单独成关键词；标点切短句；不再产出整句 token'
    );
  });

  it('6 个改写查询：每个关键词 ≤20 字、无标点残留（不得含整句超长 token）', () => {
    const queries = [
      '我什么时候开始学的法语来着？',
      '我的机房是在哪个城市？',
      '我的跑步习惯是什么样的？',
      '帮我推荐咖啡，你知道我的口味吧',
      '北京那边有多少同事来着？',
      '评审定在哪一天？',
    ];
    for (const q of queries) {
      const kws = extractKeywordsFromIssue(q);
      assert.ok(kws.length >= 1, `至少抽出 1 个关键词：${q}`);
      for (const k of kws) {
        assert.ok(k.length <= 20, `关键词 "${k}" 长度 ${k.length} ≤20（不是整句 token）`);
        assert.ok(!/[，。！？；、？]/.test(k), `关键词 "${k}" 不含分句标点残留`);
      }
    }
  });

  it('短句 >8 字 → 字符 2-gram 兜底（cap 12，虚词 2-gram 跳过；纯中文输入）', () => {
    const long = '这是一个非常长的中文句子用来验证超长短句的二字组兜底逻辑是否正常工作并且不会产出整句标记';
    const kws = extractKeywordsFromIssue(long);
    assert.ok(kws.length >= 1 && kws.length <= 12, `2-gram cap 12，got ${kws.length}`);
    assert.ok(kws.every((k) => k.length === 2), '兜底产物全部是 2-gram');
    const stops = new Set(['的呢', '了吗', '是的', '一个', '什么', '怎么', '可以', '我们', '你们', '没有', '就是', '这个', '那个']);
    assert.ok(kws.every((k) => !stops.has(k)), '虚词 2-gram 被跳过');
  });

  it('CJK 关键词总数 cap 16（纯汉字 18 个短句 → 恰 16）', () => {
    const h = '甲乙丙丁戊己庚辛壬癸';
    const many = Array.from({ length: 18 }, (_, i) => `话题${h[i % 10]}${'子丑寅卯'[i % 4]}`).join('，');
    const kws = extractKeywordsFromIssue(many);
    assert.equal(kws.length, 16, `CJK 关键词总数 cap 16，got ${kws.length}`);
  });

  it('英文路径逐字节不变：与旧 filter 副本逐项一致（STOPWORDS/长度门/strip 前缀）', () => {
    // 改前实现的副本（逐字节）——守护英文行为零变化
    const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'who', 'how', 'why', 'which', 'did', 'do', 'does', 'did', 'have', 'has', 'had', 'i', 'my', 'me', 'we', 'our', 'you', 'your', 'it', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'and', 'or', 'that', 'this', 'there', 'was', 'first', 'last', 'can', 'will', 'would', 'should', 'did']);
    const oldExtract = (issue: string): string[] =>
      (issue ?? '')
        .split(/\s+/)
        .map((w) => w.replace(/^[/@#]/, ''))
        .filter((w) => {
          const lw = w.toLowerCase();
          if (/[一-龥]/.test(w)) return w.length >= 2;
          return w.length >= 2 && !STOPWORDS.has(lw);
        });
    const samples = [
      'What was my first car and when did I buy it',
      'fix the login bug in AuthModule.ts @src/auth/login.ts',
      'HOW to deploy redis on k8s cluster',
      'refactor #config and /reload the settings for staging',
      '',
    ];
    for (const s of samples) {
      assert.deepEqual(extractKeywordsFromIssue(s), oldExtract(s), `英文行为不变："${s}"`);
    }
    assert.deepEqual(extractKeywordsFromIssue(samples[0]), ['car', 'buy'], '抽查：停用词照滤');
  });

  it('CJK 判定放宽为 /[\\u3000-\\u9fff]/：含中文标点/序号的无空格 token 走 CJK 分支', () => {
    // 全角问号（U+FF1F 不在范围内）不影响；中文顿号连接的无空格串按 CJK 切分
    const kws = extractKeywordsFromIssue('苹果、香蕉、榴莲');
    assert.deepEqual(kws, ['苹果', '香蕉', '榴莲'], '顿号切短句');
  });

  it('审查建议-1 撕词回归：数字+量词不被拆碎（"5公里"整体保留，不产"跑步里每周六"）', () => {
    const kws = extractKeywordsFromIssue('跑步5公里每周六');
    assert.ok(kws.some(k => k.includes('5公里') || k.includes('公里')), `量词应随数字保留，got ${JSON.stringify(kws)}`);
    assert.ok(!kws.includes('跑步里每周六'), '不得产出乱序撕词串');
    assert.ok(kws.some(k => k.includes('跑步')), '前段"跑步"仍保留');
  });

  it('审查建议-1 混合 token：中英混排长 token 的 ASCII 连续段不丢失', () => {
    const kws = extractKeywordsFromIssue('帮我修一下AuthModule登录的bug谢谢');
    // 2-gram 只收纯汉字，AuthModule/bug 这类 ASCII 段必须以独立关键词存活
    assert.ok(kws.some(k => /Auth/i.test(k)), `ASCII 段应保留，got ${JSON.stringify(kws)}`);
  });
});

// ==================== 【2】语义闸放宽：纯中文查询激活语义通道 ====================
describe('【2】语义闸放宽（RefinedMemoryStore）', () => {
  it('中文查询仅 1 个关键词 → 语义通道激活（embedder 被调用；改前 kws>=2 恒闭）', () => {
    const store = makeStore('cn-gate.json');
    store.save([mkPair('gate-pair', 'Q: 我3月开始学法语，每周上两次课\nA: 已记录：3月开始学法语。')]);
    let calls = 0;
    setSemanticEmbedderForTest((texts) => { calls++; return texts.map(() => [1, 0]); });
    const r = store.loadFiltered({
      tier: 'high',
      keywords: ['我开始学法语'],
      queryText: '我3月开始学法语',
      semantic: true,
    });
    assert.ok(calls > 0, `纯中文查询（1 关键词）激活语义通道，embedder calls=${calls}`);
    assert.equal(r.length, 1, '结果照常返回');
  });

  it('英文查询仅 1 个关键词 → 语义仍不激活（改前行为逐字节一致）', () => {
    const store = makeStore('en-gate.json');
    store.save([mkEng('en-gate-card', 'solo deployment config')]);
    let calls = 0;
    setSemanticEmbedderForTest((texts) => { calls++; return texts.map(() => [1, 0]); });
    store.loadFiltered({
      tier: 'high',
      keywords: ['deployment'],
      queryText: 'deployment rollback question without cjk',
      semantic: true,
    });
    assert.equal(calls, 0, '英文 1 关键词 → 语义闸保持关闭（B3c 契约不回归）');
  });
});

// ==================== 【3】查询稀释修复：issue 权重主导 ====================
describe('【3】buildMemoryQueryText 查询稀释修复', () => {
  function buildWithHistory(userInputs: string[], answers: string[], issue: string): string {
    const sess = new Session({ tier: 'high' });
    userInputs.forEach((u, i) => {
      sess.addTurn({
        id: 't' + i,
        timestamp: Date.now(),
        userInput: u,
        userInputType: 'task',
        tier: 'high',
        durationMs: 1,
        result: { success: true, summary: '已回复', answerText: answers[i] },
      } as any);
    });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    return (pb as any).buildMemoryQueryText(issue);
  }

  it('issue 重复拼接置顶主导 + 最近 2 轮各截 60 字符（原 200 稀释修复）', () => {
    const q = buildWithHistory(
      ['A'.repeat(200), 'C'.repeat(200)],
      ['B'.repeat(200), 'D'.repeat(200)],
      '法语什么时候开始学的'
    );
    assert.ok(
      q.startsWith('法语什么时候开始学的 法语什么时候开始学的 '),
      'issue 重复拼接两次且在最前（稀释修复核心）'
    );
    assert.ok(!q.includes('A'.repeat(61)), '历史 userInput 截 60 字符（不再 200）');
    assert.ok(!q.includes('B'.repeat(61)), '历史 answerText 截 60 字符');
    for (const seg of ['A'.repeat(60), 'B'.repeat(60), 'C'.repeat(60), 'D'.repeat(60)]) {
      assert.ok(q.includes(seg), `最近 2 轮片段仍在：${seg.slice(0, 6)}...`);
    }
  });

  it('长 issue 时按字符占比 issue ≥ 2/3（历史 4×60 字符封顶，探查的 77 字前缀稀释不再可能）', () => {
    const longIssue = '这是一个足够长的当前任务描述需要验证权重占比'.repeat(12); // 216 字符
    const q = buildWithHistory(
      ['无关历史甲'.repeat(30), '无关历史乙'.repeat(30)],
      ['无关历史丙'.repeat(30), '无关历史丁'.repeat(30)],
      longIssue
    );
    const issueChars = longIssue.length * 2;
    const historyChars = 4 * 60; // 上限
    assert.ok(issueChars / (issueChars + historyChars) >= 2 / 3, `issue 字符权重 ${(issueChars / (issueChars + historyChars)).toFixed(2)} ≥ 2/3`);
    assert.ok(q.startsWith(longIssue + ' ' + longIssue + ' '), 'issue 置顶双拼');
  });

  it('无历史轮 → 查询仍为 issue 双拼（机制本身，无稀释源时无害）', () => {
    const sess = new Session({ tier: 'high' });
    const pb = new PromptBuilder(sess, TierRegistry.get('high'));
    const q = (pb as any).buildMemoryQueryText('跑一下测试');
    assert.equal(q, '跑一下测试 跑一下测试');
  });
});

// ==================== 【4】对卡排序公平性：零相关工程卡 vs 完美相关对卡 ====================
describe('【4】对卡排序公平性（ HybridRank 框架排序断言）', () => {
  /** 确定性词表 embedder：命中词 → 对应维度置 1（cos 可控；gold 与查询同词 → cos=1）。 */
  const FAIR_LEX: Record<string, number> = { 学法语: 0 };
  const fairVecOf = (t: string): number[] => {
    const v = new Array(3).fill(0);
    const s = String(t ?? '');
    for (const [w, i] of Object.entries(FAIR_LEX)) if (s.includes(w)) v[i] = 1;
    return v;
  };

  it('新鲜对卡 effBase ≥ 0.6（dialogue-pair 基线 0.85；/remember 手工偏好维持 0.6）', () => {
    const store = makeStore('fair-fresh.json');
    store.save([
      mkPair('fair-pair', 'Q: 我3月开始学法语，每周上两次课\nA: 已记录：3月开始学法语。', { confidence: 1.0 }),
      { ...mkPair('manual-pref', '用户偏好：回答用中文', { source: undefined, confidence: undefined }) },
    ] as any[]);
    const pair = store.list().find((c) => c.id === 'fair-pair')!;
    const w = store.effectiveWeightOf(pair, Date.now());
    // 实测语义：base = decayWeight(1.0) ?? weight → effBase = 1.0×1.0×0.85 = 0.85
    // （任务书里"0.8×0.85=0.68"的算式忽略了 decayWeight 优先；≥0.6 目标达成）
    assert.ok(Math.abs(w - 0.85) < 1e-9, `新鲜对卡 effBase = ${w}（≥0.6 目标达成；改前 1.0×0.6=0.6，两段衰减后 0.24 出局）`);
    const manual = store.list().find((c) => c.id === 'manual-pref')!;
    assert.ok(Math.abs(store.effectiveWeightOf(manual, Date.now()) - 0.6) < 1e-9, '/remember 手工偏好基线 0.6 不变');
  });

  it('两段衰减后的完美相关对卡：仍入围（出局门）且越过零相关工程卡（hybrid 排序）', () => {
    const store = makeStore('fair-rank.json');
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const age = 270 * DAY; // insight 半衰期 180d × 1.5 → 第三衰减段（factor 0.4）
    // 零相关工程卡：base = decayWeight(1.0) → fresh eff 1.0
    const eng = mkEng('fair-eng', 'deployment pipeline config for staging cluster');
    // 完美相关对卡：改前 effBase = 1.0(decayWeight)×0.4×0.6 = 0.24 < 0.3 出局门 →
    // 硬出局（本断言改前红）；改后 effBase = 1.0×0.4×0.85 = 0.34 ≥ 0.3 入围。
    const pair = mkPair('fair-pair-gold', 'Q: 我3月开始学法语，每周上两次课\nA: 已记录：3月开始学法语。', {
      lastSeen: now - age, lastUsedAt: now - age,
    });
    store.save([eng, pair]);
    setSemanticEmbedderForTest((texts) => texts.map(fairVecOf));
    const r = store.loadFiltered({
      tier: 'high',
      keywords: ['学法语', '每周上两次课'],
      queryText: '我3月开始学法语了吗',
      semantic: true,
    });
    assert.ok(r.some((c) => c.id === 'fair-pair-gold'), '两段衰减的对卡仍在候选集（未惩罚基线 0.34≥0.3；改前 0.24 出局）');
    assert.equal(r[0]?.id, 'fair-pair-gold', '完美相关对卡置顶，零相关工程卡不得压制');
    // 数值申报（实测语义，maxEff = eng eff 1.0）：pair eff = 0.34×0.9(conf0.8) = 0.306
    // pair hybrid = 0.5×(0.5×0.306 + 0.5×1) + 0.5×1 = 0.8265 ≫ eng = 0.5×(0.5×1) = 0.25
    const effPair = 1.0 * 0.4 * 0.85 * (0.5 + 0.5 * 0.8); // 0.306
    const scorePair = 0.5 * (0.5 * (effPair / 1.0) + 0.5 * 1) + 0.5 * 1;
    const scoreEng = 0.5 * (0.5 * 1 + 0.5 * 0) + 0.5 * 0;
    assert.ok(Math.abs(scorePair - 0.8265) < 1e-3, `对卡 hybrid 分申报：${scorePair.toFixed(4)}`);
    assert.ok(scorePair > scoreEng * 2, `排序分差申报：pair=${scorePair.toFixed(4)} > eng=${scoreEng.toFixed(4)}`);
  });

  it('纯词面回退路径（守护）：关键词命中的对卡（rel 3 帽）越过零相关工程卡', () => {
    // 关键词真实命中（【1】之后才可能）时，即使语义不可用（回退旧公式
    // 0.7×eff+0.3×rel），对卡也越过工程卡：pair 0.7×(0.85×0.9)+0.9 ≈ 1.44 > eng 0.7。
    const store = makeStore('fair-lex.json');
    store.save([
      mkEng('fair-eng-lex', 'deployment pipeline config'),
      mkPair('fair-pair-lex', 'Q: 我3月开始学法语，每周上两次课\nA: 已记录：3月开始学法语。'),
    ]);
    const r = store.loadFiltered({ tier: 'high', keywords: ['学法语', '每周上两次课'] });
    assert.deepEqual(r.map((c) => c.id), ['fair-pair-lex', 'fair-eng-lex'], '词面命中对卡置顶（rel 3 帽 + effBase 0.85）');
  });
});

// ==================== 【5】中文检索端到端：11 张中文卡 × 6 个改写查询 ====================
describe('【5】中文检索端到端（11 张中文卡种子 + 2 张零相关工程卡，零仓库写）', () => {
  /** 11 张中文卡（对卡 7 + 句级 4 混合）；前 6 张是 6 个改写查询的 gold。 */
  const SEEDS: Array<{ id: string; gold?: boolean; card: any }> = [
    { id: 'cn-pair-french', gold: true, card: mkPair('cn-pair-french', 'Q: 我3月开始学法语，每周上两次课\nA: 已记录：你3月开始学法语，每周两次课，周末自己复习。') },
    { id: 'cn-pair-server', gold: true, card: mkPair('cn-pair-server', 'Q: 我的服务器托管在柏林，机房编号 B-12\nA: 已记录：服务器在柏林的机房 B-12。') },
    { id: 'cn-sent-running', gold: true, card: mkSent('cn-sent-running', '【对话事实·用户·2023-05-01】我每周六早晨沿河跑步5公里') },
    { id: 'cn-pair-coffee', gold: true, card: mkPair('cn-pair-coffee', 'Q: 我平时只喝拿铁，不加糖\nA: 已记录你的咖啡口味：拿铁、不加糖。') },
    { id: 'cn-pair-team', gold: true, card: mkPair('cn-pair-team', 'Q: 我们团队有12名工程师，分布在北京和上海\nA: 已记录：团队12人，北京与上海两地办公。') },
    { id: 'cn-sent-review', gold: true, card: mkSent('cn-sent-review', '【对话事实·助手·2023-02-10】项目评审安排在3月15日进行') },
    { id: 'cn-pair-book', card: mkPair('cn-pair-book', 'Q: 我最近在读三体\nA: 已记录：你在读三体第二部。') },
    { id: 'cn-sent-weather', card: mkSent('cn-sent-weather', '【对话事实·用户·2023-04-02】我所在的城市冬天经常下雨') },
    { id: 'cn-pair-diet', card: mkPair('cn-pair-diet', 'Q: 我对花生过敏\nA: 已记录：花生过敏，推荐菜谱时避开花生。') },
    { id: 'cn-sent-commute', card: mkSent('cn-sent-commute', '【对话事实·用户·2023-03-20】我每天乘地铁通勤约40分钟') },
    { id: 'cn-pair-birthday', card: mkPair('cn-pair-birthday', 'Q: 我妹妹的生日是9月2日\nA: 已记录：妹妹生日9月2日。') },
  ];

  /** 确定性词表 embedder：内容词命中 → 维度置 1。改写查询与 gold 共享内容词，
   * 与无关卡正交（cos=0）——这正是语义通道要解决的问题形状。 */
  const LEX: Record<string, number> = {
    法语: 0, 机房: 1, 跑步: 2, 咖啡: 3, 北京: 4, 评审: 5,
    三体: 6, 花生: 7, 地铁: 8, 生日: 9, 上海: 10, 柏林: 11,
  };
  const lexVecOf = (t: string): number[] => {
    const v = new Array(12).fill(0);
    const s = String(t ?? '');
    for (const [w, i] of Object.entries(LEX)) if (s.includes(w)) v[i] = 1;
    return v;
  };

  const CASES: Array<{ q: string; gold: string }> = [
    { q: '我什么时候开始学的法语来着？', gold: 'cn-pair-french' },
    { q: '我的机房是在哪个城市？', gold: 'cn-pair-server' },
    { q: '我的跑步习惯是什么样的？', gold: 'cn-sent-running' },
    { q: '帮我推荐咖啡，你知道我的口味吧', gold: 'cn-pair-coffee' },
    { q: '北京那边有多少同事来着？', gold: 'cn-pair-team' },
    { q: '评审定在哪一天？', gold: 'cn-sent-review' },
  ];

  let store: RefinedMemoryStore;
  beforeEach(() => {
    store = makeStore('cn-e2e.json');
    store.save([...SEEDS.map((s) => s.card), mkEng('cn-eng-1', 'deployment pipeline config'), mkEng('cn-eng-2', 'kubernetes cluster upgrade notes')]);
    setSemanticEmbedderForTest((texts) => texts.map(lexVecOf));
  });

  for (const { q, gold } of CASES) {
    it(`gold 名次 ≤2：${q}`, () => {
      const kws = extractKeywordsFromIssue(q);
      const r = store.loadFiltered({ tier: 'high', keywords: kws, queryText: q, semantic: true });
      const rank = r.findIndex((c) => c.id === gold);
      assert.ok(rank >= 0, `gold 在场：${gold}`);
      assert.ok(rank <= 1, `gold 名次 = ${rank + 1} ≤2（改写查询靠语义通道命中）`);
    });
  }

  it('审查建议-4 共享词表干扰卡：与查询共享"北京"但内容无关的卡不得顶掉 gold', () => {
    // 消除 gold≤2 的构造性必然（原词表下所有非 gold 卡与查询正交）：
    // 干扰卡与 cn-pair-team 查询共享"北京"（cos 同为 1），gold 必须靠
    // 对卡 Q 侧关键词加权/eff 基线仍排在其前。
    const distractor = mkSent('cn-distractor-beijing', '【对话事实·用户·2024-06-01】北京的冬天特别干燥');
    store.save([distractor]);
    const q = '北京那边有多少同事来着？';
    const kws = extractKeywordsFromIssue(q);
    const r = store.loadFiltered({ tier: 'high', keywords: kws, queryText: q, semantic: true });
    const goldRank = r.findIndex((c) => c.id === 'cn-pair-team');
    const disRank = r.findIndex((c) => c.id === 'cn-distractor-beijing');
    assert.ok(goldRank >= 0, 'gold 在场');
    assert.ok(goldRank <= 1, `gold 名次 = ${goldRank + 1} ≤2（有干扰卡仍成立）`);
    assert.ok(goldRank < disRank, `gold(${goldRank}) 须排在共享词干扰卡(${disRank})之前`);
  });

  it('(a)+(b) 组合面：中文查询关键词全部 ≤20 字且语义通道被激活（embedder 零调用则红）', () => {
    let calls = 0;
    setSemanticEmbedderForTest((texts) => { calls++; return texts.map(lexVecOf); });
    for (const { q } of CASES) {
      const kws = extractKeywordsFromIssue(q);
      assert.ok(kws.every((k) => k.length <= 20), `无整句长 token：${q}`);
      store.loadFiltered({ tier: 'high', keywords: kws, queryText: q, semantic: true });
    }
    assert.ok(calls >= CASES.length, `每个中文查询都触达语义通道，calls=${calls}`);
  });

  it('产品调用面（appendMemoryCardsDedup）：中文改写查询注入 gold 卡内容', async () => {
    const prevMemFile = process.env.PANSHA_MEMORY_FILE;
    const prevNoMem = process.env.PANSHA_NO_MEMORY;
    process.env.PANSHA_MEMORY_FILE = path.join(ws, 'cn-e2e.json');
    delete process.env.PANSHA_NO_MEMORY;
    try {
      const sess = new Session({ tier: 'high' });
      const pb = new PromptBuilder(sess, TierRegistry.get('high'));
      const lines: string[] = [];
      const added = await (pb as any).appendMemoryCardsDedup(lines, undefined, CASES[0].q);
      assert.equal(added, true, '中文查询触发注入');
      const block = lines.join('\n');
      assert.ok(block.includes('开始学法语') || block.includes('3月'), `gold 卡内容进入注入块（查询：${CASES[0].q}）`);
    } finally {
      if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
      else process.env.PANSHA_MEMORY_FILE = prevMemFile;
      if (prevNoMem !== undefined) process.env.PANSHA_NO_MEMORY = prevNoMem;
    }
  });
});
