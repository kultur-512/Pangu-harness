// tests/memory/MemorySFixes.test.ts
// S 级记忆缺陷修复回归（2026-09-11 记忆机制审计）：
// - 缺陷1 卡片 referencedFiles 断链：refine 增 writtenFiles 入参（共享提取器
//   src/memory/trajectoryFiles.ts 的 extractWrittenFilePaths，refine 与
//   finalizeTaskMemory 共用）→ 产卡引用非空，引用过滤与 markVerified 恢复工作
// - 缺陷2 通用成功卡零信息：summary 携带任务前 60 字 + 写入文件列表；
//   keywords 从任务文本与写入文件名提取；RBW 违规任务不产成功卡（失败教训卡保留）
// - 缺陷3 通用卡永生：calculateEffectiveWeight 的 count 半衰期乘数封顶 ×3
// - 附带：markVerified 防创建即自验证（excludeCreatedAfter）

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import { extractWrittenFilePaths } from '../../src/memory/trajectoryFiles.js';

const DAY = 24 * 60 * 60 * 1000;

let ws: string;
function makeStore(): RefinedMemoryStore {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-sfix-'));
  return new RefinedMemoryStore(ws);
}
function cleanupAll() {
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
}

/** 真实轨迹形状：steps[].action = ToolCall[]（{ toolName, params:[{name,value}] }） */
function realShapeTraj(overrides: Record<string, unknown> = {}): any {
  return {
    id: 't',
    steps: [{
      stepNumber: 1,
      thought: '',
      plan: '',
      action: [{
        toolName: 'write_file',
        params: [
          { name: 'file_path', value: 'src/auth.ts' },
          { name: 'content', value: 'export const login = 1;\n' },
        ],
        rawBlock: '',
      }],
      result: 'ALL_TESTS_PASSED',
    }],
    success: true,
    stopReason: 'completed',
    ...overrides,
  };
}

describe('缺陷1：写集提取共享化 + referencedFiles 断链修复', () => {
  afterEach(cleanupAll);

  it('共享提取器认识真实轨迹形状（{toolName, params}）', () => {
    const traj = realShapeTraj();
    assert.deepEqual(extractWrittenFilePaths(traj), ['src/auth.ts']);
  });

  it('refine 接收 writtenFiles → 成功卡 referencedFiles 非空（旧实现恒空）', () => {
    const store = makeStore();
    const traj = realShapeTraj();
    const cards = store.refine({
      trajectory: traj, taskStyle: 'swe', attemptCount: 1, userFeedback: '',
      writtenFiles: extractWrittenFilePaths(traj),
      taskText: '重构 src/auth.ts 的登录逻辑',
    });
    const success = cards.find(c => c.kind === 'success');
    assert.ok(success, 'completed → success 卡');
    assert.deepEqual((success as any).referencedFiles, ['src/auth.ts'], '引用必须落卡');
  });

  it('引用卡可被引用过滤命中 + 注入集∩写集 → markVerified 生效（闭环恢复）', () => {
    const store = makeStore();
    const traj = realShapeTraj();
    const cards = store.refine({
      trajectory: traj, taskStyle: 'swe', attemptCount: 1, userFeedback: '',
      writtenFiles: extractWrittenFilePaths(traj),
      taskText: '重构 src/auth.ts 的登录逻辑',
    });
    store.save(cards);
    const card = cards.find(c => c.kind === 'success')!;

    // 引用过滤：当前工作区涉及 src/auth.ts → 该卡在注入集内
    const loaded = store.loadFiltered({ currentWorkspaceFiles: ['src/auth.ts'], tier: 'high' });
    assert.ok(loaded.some(c => c.id === card.id), '引用交集命中');

    // markVerified：注入卡 ∩ 轨迹写集 ≠ ∅ → count+1
    const written = new Set(extractWrittenFilePaths(traj).map(p => p.replace(/\\/g, '/').toLowerCase()));
    const hit = [card.id].filter(id => ((store.load().cards.find(c => c.id === id) as any)?.referencedFiles ?? [])
      .some((r: string) => written.has(r.replace(/\\/g, '/').toLowerCase())));
    assert.equal(hit.length, 1, '交集判定非空');
    const r = store.markVerified(hit, Date.now(), { excludeCreatedAfter: Date.now() + 1000 });
    assert.equal(r.updated, 1);
    assert.equal(store.load().cards.find(c => c.id === card.id)?.count, 2, 'count+1');
  });

  it('不传 writtenFiles 时行为不变（referencedFiles 缺省，旧调用方兼容）', () => {
    const store = makeStore();
    const cards = store.refine({
      trajectory: realShapeTraj(), taskStyle: 'swe', attemptCount: 1, userFeedback: '',
    });
    const success = cards.find(c => c.kind === 'success');
    assert.ok(success);
    assert.equal((success as any).referencedFiles, undefined, '无写集 → 无引用字段');
  });
});

describe('缺陷2：成功卡携带任务信息 + keywords + RBW 违规不产成功卡', () => {
  afterEach(cleanupAll);

  it('summary 携带任务前 60 字 + 写入文件列表', () => {
    const store = makeStore();
    // >60 字：60 字截断必须可观测
    const longTask = '修复 src/auth.ts 登录空指针并为鉴权中间件补齐回归用例，同时整理模块导出与注释，让后续审查与二次开发更顺畅不踩坑';
    assert.ok(longTask.length > 60, '前置：任务文本须超 60 字');
    const cards = store.refine({
      trajectory: realShapeTraj(), taskStyle: 'swe', attemptCount: 1, userFeedback: '',
      writtenFiles: ['src/auth.ts'], taskText: longTask,
    });
    const success = cards.find(c => c.kind === 'success')!;
    const head = longTask.replace(/\s+/g, ' ').trim().slice(0, 60);
    assert.ok(success.summary.startsWith('已验证可行的做法：'));
    assert.ok(success.summary.includes(head), `summary 应含任务前 60 字：${success.summary}`);
    assert.ok(success.summary.includes('（写：src/auth.ts）'), `summary 应含写集：${success.summary}`);
    assert.ok(!success.summary.includes(longTask), '任务部分必须截断在 60 字内（不得整段带入）');
  });

  it('文件列表超过 5 个时以"等N个"收尾（防 summary 膨胀）', () => {
    const store = makeStore();
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const cards = store.refine({
      trajectory: realShapeTraj(), taskStyle: 'swe', attemptCount: 1, userFeedback: '',
      writtenFiles: files, taskText: '批量重构',
    });
    const s = cards.find(c => c.kind === 'success')!.summary;
    assert.ok(s.includes('a.ts、b.ts、c.ts、d.ts、e.ts'), '前 5 个列出');
    assert.ok(s.includes('等7个'), `超出以等N个收尾：${s}`);
    assert.ok(!s.includes('g.ts'), '第 6+ 个文件不得整名出现');
  });

  it('keywords 从任务文本与写入文件名提取（≤4、小写、去重、文件名优先）', () => {
    const store = makeStore();
    const cards = store.refine({
      trajectory: realShapeTraj(), taskStyle: 'swe', attemptCount: 1, userFeedback: '',
      writtenFiles: ['src/auth.ts'], taskText: 'Fix Login bug in auth module',
    });
    const kw = (cards.find(c => c.kind === 'success') as any).keywords as string[];
    assert.ok(Array.isArray(kw) && kw.length >= 1 && kw.length <= 4, `2-4 个 token：${JSON.stringify(kw)}`);
    assert.ok(kw.includes('auth'), '文件名主干（auth）必须入选');
    assert.ok(kw.every(k => k === k.toLowerCase()), '小写归一');
    assert.equal(new Set(kw).size, kw.length, '去重');
  });

  it('同任务重复成功 → 同摘要同 id → count 恰 +1（信息化摘要不破坏去重）', () => {
    const store = makeStore();
    const input = {
      trajectory: realShapeTraj(), taskStyle: 'swe' as const, attemptCount: 1, userFeedback: '',
      writtenFiles: ['src/auth.ts'], taskText: '重构 src/auth.ts 的登录逻辑',
    };
    store.save(store.refine(input));
    store.save(store.refine(input));
    const hits = store.load().cards.filter(c => c.kind === 'success');
    assert.equal(hits.length, 1, '同任务同卡');
    assert.equal(hits[0].count, 2, 'count 恰 +1/次');
  });

  it('RBW 违规 + completed → 不产成功卡；失败教训卡照常产出', () => {
    const store = makeStore();
    const traj = realShapeTraj({
      steps: [{ stepNumber: 1, thought: '', plan: '', action: [], result: 'ALL_TESTS_PASSED', readBeforeWriteViolation: true }],
    });
    const cards = store.refine({
      trajectory: traj, taskStyle: 'swe', attemptCount: 1, userFeedback: '',
      writtenFiles: ['src/auth.ts'], taskText: '先写后读的坏习惯任务',
    });
    assert.equal(cards.filter(c => c.kind === 'success').length, 0, '违反 RBW 不给成功卡');
    const failure = cards.find(c => c.kind !== 'success' && c.category === 'READ_BEFORE_WRITE_VIOLATION');
    assert.ok(failure, '失败教训卡保留');
  });

  it('answered（非 completed、无正向反馈）仍不产成功卡（0.7 语义保持）', () => {
    const store = makeStore();
    const cards = store.refine({
      trajectory: realShapeTraj({ stopReason: 'answered' }), taskStyle: 'swe', attemptCount: 1, userFeedback: '',
      writtenFiles: ['src/auth.ts'], taskText: '闲聊任务',
    });
    assert.equal(cards.filter(c => c.kind === 'success').length, 0);
  });
});

describe('缺陷3：count 半衰期乘数封顶 ×3（防 refine 充值永生）', () => {
  afterEach(cleanupAll);

  it('count 10 与 count 3 同效（封顶）；仍优于 count 1（常用加成保留）', () => {
    const store = makeStore();
    const now = Date.now();
    const age = 250 * DAY; // failure HL=90d
    const mk = (id: string, count: number): any => ({
      id, kind: 'failure', category: 'OTHER', memoryCategory: 'failure',
      summary: `卡${id}`, weight: 1, taskStyle: 'all', count,
      lastSeen: now - age, firstSeen: now - age, applicableTiers: [],
      sourceContext: '', decayWeight: 1.0, lastUsedAt: now - age,
    });
    const e1 = store.effectiveWeightOf(mk('c1', 1), now);
    const e3 = store.effectiveWeightOf(mk('c3', 3), now);
    const e10 = store.effectiveWeightOf(mk('c10', 10), now);
    // 未封顶时 count10 → HL 900d → age 250d 落第一段（×1.0，永生）；封顶后 = count3（HL 270d → ×0.7）
    assert.ok(Math.abs(e10 - 0.7) < 0.02, `count10 必须按 ×3 封顶衰减（0.7），got ${e10}`);
    assert.equal(e10, e3, 'count 10 与 count 3 同效');
    assert.ok(e10 > e1, `常用加成保留：${e10} > count1 的 ${e1}`);
  });

  it('count 5（旧永生卡）的半衰期上限 = 基础 ×3', () => {
    const store = makeStore();
    const now = Date.now();
    // success 卡 memoryCategory=implementation，HL=180d → 封顶后 HL≤540d
    const card: any = {
      id: 's', kind: 'success', category: 'OTHER', memoryCategory: 'implementation',
      summary: '已验证可行的做法：一次通过且真实验证通过', weight: 1, taskStyle: 'all', count: 5,
      lastSeen: now - 500 * DAY, firstSeen: now - 500 * DAY, applicableTiers: [],
      sourceContext: '', decayWeight: 1.0, lastUsedAt: now - 500 * DAY,
    };
    // 未封顶 HL=900d → 500d 落第二段 ×0.7；封顶 HL=540d → 500d 落第二段（0.5HL=270, 1HL=540）×0.7…
    // 选 600d：未封顶 <900 → ×0.7；封顶 600>540 → ×0.4
    const card600: any = { ...card, lastSeen: now - 600 * DAY, lastUsedAt: now - 600 * DAY };
    const eff = store.effectiveWeightOf(card600, now);
    assert.ok(Math.abs(eff - 0.4) < 0.02, `600d 龄期 count5 必须按封顶 HL=540d 衰减（×0.4），got ${eff}`);
  });
});

describe('附带：markVerified 防创建即自验证（excludeCreatedAfter）', () => {
  afterEach(cleanupAll);

  it('时间窗内新建的卡跳过；窗口前已存在的卡照常 count+1', () => {
    const store = makeStore();
    const now = Date.now();
    const startedAt = now - 60 * 1000; // 任务 1 分钟前开始
    const mk = (id: string, firstSeen: number): any => ({
      id, kind: 'failure', category: 'OTHER', memoryCategory: 'failure',
      summary: `卡${id}`, weight: 1, taskStyle: 'all', count: 1,
      lastSeen: firstSeen, firstSeen, applicableTiers: [],
      sourceContext: '', decayWeight: 1.0, lastUsedAt: firstSeen,
    });
    store.save([mk('old-card', startedAt - 10 * DAY), mk('fresh-card', now)]);

    const r = store.markVerified(['old-card', 'fresh-card'], now + 5000, { excludeCreatedAfter: startedAt });
    assert.equal(r.updated, 1, '只更新窗口前已存在的卡');
    const file = store.load();
    const oldCard = file.cards.find(c => c.id === 'old-card') as any;
    const fresh = file.cards.find(c => c.id === 'fresh-card') as any;
    assert.equal(oldCard.count, 2, '旧卡 count+1');
    assert.equal(oldCard.lastUsedAt, now + 5000, '旧卡 lastUsedAt 刷新');
    assert.equal(fresh.count, 1, '本轮新建卡不得自验证');
    assert.equal(fresh.lastUsedAt, now, 'fresh 卡 lastUsedAt 不被刷新');
  });

  it('不传 opts 时行为完全不变（向后兼容）', () => {
    const store = makeStore();
    const now = Date.now();
    const mk = (id: string): any => ({
      id, kind: 'failure', category: 'OTHER', memoryCategory: 'failure',
      summary: id, weight: 1, taskStyle: 'all', count: 1,
      lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now,
    });
    store.save([mk('c1')]);
    const r = store.markVerified(['c1'], now);
    assert.equal(r.updated, 1);
    assert.equal(store.load().cards[0].count, 2);
  });
});
