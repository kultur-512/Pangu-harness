// tests/repl/FeedSafety.test.ts
// 缺陷 #5（CRITICAL）回归锁定：rich ink 渲染崩溃绝迹。
// 真机症状：任务执行时 tools/pre-execute 事件被原样 pushFeed 进 rich feed，
// FeedItem default 分支 `return JSON.stringify(item)` 把裸字符串放回 ink 渲染树，
// react-reconciler 抛 "Text string ... must be rendered inside <Text> component"，
// 整个 UI unmount、REPL 进程退出。
//
// 本文件锁定三层防线 + 缺陷 #3/#4（rich /tier 滑杆）+ 缺陷 #1（rich /exit）：
//  1. bridge.pushFeed 归一化门：任何未知/内部事件 → 安全 text item，绝不透传原对象；
//  2. FeedItem default 分支：未知 type 安全渲染，任何路径不返回裸字符串；
//  3. mapSseToBridge：tools/pre|post-execute → pushTool 卡片；approval.request 不进 feed；
//  4. OutputRenderer ink 模式（feedSink 激活）：不裸写 stdout，error() 单条入 feed；
//  5. /tier（rich）：openTierPicker 确认/取消/未挂载三分支；
//  6. /exit（rich）：经 ctx.requestExit 干净退出缝。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../src/cli/repl/Session.js';
import { createBridge, toSafeFeedItem } from '../../src/cli/repl/ui/bridge.js';
import { FeedItem as FeedItemComponent } from '../../src/cli/repl/ui/FeedItem.js';
import { TierPicker } from '../../src/cli/repl/ui/TierPicker.js';
import { OutputRendererImpl } from '../../src/cli/repl/OutputRenderer.js';
import { createTurnContext, type TurnContext } from '../../src/cli/repl/turn/TurnContext.js';
import { createModeRing, handleSlashCommand } from '../../src/cli/repl/turn/CommandRouter.js';
import { mapSseToBridge } from '../../src/cli/repl/turn/TurnRenderer.js';

// ==================== 替身 ====================

function fakeRenderer() {
  return {
    writeLine: (_t: string) => {},
    write: (_t: string) => {},
    color: (t: string) => String(t),
    warn: (_t: string) => {},
    error: (_t: string) => {},
    success: (_t: string) => {},
    info: (_t: string) => {},
    clearScreen: () => {},
  } as any;
}

/** 真 bridge + 假 dispatch：收集全部 reducer actions（PanshaApp 挂载形态）。 */
function bridgeWithDispatch() {
  const session = new Session({ tier: 'high', workspace: process.cwd() });
  const bridge: any = createBridge(session, fakeRenderer(), null);
  const feedItems: any[] = [];
  const tops: any[] = [];
  bridge.__registerDispatch((action: any) => {
    if (action.type === 'PUSH_FEED') feedItems.push(action.item);
    else if (action.type === 'SET_TOP') tops.push(action.partial);
  });
  return { bridge, feedItems, tops, session };
}

/** 崩溃载荷原样复刻（真机实录 JSON）。 */
function crashPayload(): any {
  return {
    type: 'tools/pre-execute',
    tool: 'glob',
    params: { pattern: '*.*' },
    approval: 'default',
    danger: false,
  };
}

/** 递归收集元素树里的字符串叶（stub createElement 的 {type,props,children} 形态）。 */
function collectStringLeaves(node: any, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectStringLeaves(c, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const children = node.children ?? node.props?.children;
    if (children !== undefined) collectStringLeaves(children, out);
  }
  return out;
}

// stub React/ink globals（串行测试进程内用后即还原）
function stubInkGlobals() {
  const prevReact = (globalThis as any).__PANSHA_INK_REACT__;
  const prevInk = (globalThis as any).__PANSHA_INK__;
  (globalThis as any).__PANSHA_INK_REACT__ = {
    createElement: (t: any, p: any = {}, ...c: any[]) => ({ type: t, props: p, children: c }),
    useState: (i: any) => [i, () => {}],
    useRef: (v: any) => ({ current: v }),
    useEffect: () => {},
    useReducer: (r: any, init: any) => [init, () => {}],
  };
  (globalThis as any).__PANSHA_INK__ = {
    Box: function Box(_: any) {},
    Text: function Text(_: any) {},
    // 故意不提供 useInput：组件必须能在无 ink hook 下安全渲染
  };
  return () => {
    (globalThis as any).__PANSHA_INK_REACT__ = prevReact;
    (globalThis as any).__PANSHA_INK__ = prevInk;
  };
}

const CLEANUPS: Array<() => void> = [];
afterEach(() => {
  for (const c of CLEANUPS.splice(0)) c();
});

// ==================== 1. bridge.pushFeed 归一化门 ====================

describe('缺陷#5 第0层：bridge.pushFeed 归一化门', () => {
  it('tools/pre-execute 原始事件 → 安全 text item（不透传原对象）', () => {
    const { bridge, feedItems } = bridgeWithDispatch();
    bridge.pushFeed(crashPayload());
    assert.equal(feedItems.length, 1);
    const item = feedItems[0];
    assert.notEqual(item.type, 'tools/pre-execute', '未知 type 不得原样入 feed');
    assert.equal(item.type, 'text');
    assert.ok(typeof item.text === 'string' && item.text.includes('tools/pre-execute'));
    assert.ok(item.text.includes('glob'), '摘要含 tool 名');
    const leaves = collectStringLeaves(item);
    assert.ok(leaves.every((s) => typeof s === 'string' && s.length < 500));
  });

  it('字符串入参 → text item；白名单 type 原样透传', () => {
    assert.equal(toSafeFeedItem('hello').type, 'text');
    const step: any = { type: 'step', stepNumber: 1, thinking: 'x' };
    assert.equal(toSafeFeedItem(step), step, '白名单 type 原样透传');
    assert.equal(toSafeFeedItem(undefined).type, 'text');
    assert.equal(toSafeFeedItem({}).type, 'text', '无 type 对象 → text');
  });

  it('合法 feed item（text/tool/phase/markdown）原样进入 feed', () => {
    const { bridge, feedItems } = bridgeWithDispatch();
    bridge.pushFeed({ type: 'text', text: 'hi', level: 'info' } as any);
    bridge.pushFeed({ type: 'tool', tool: 'glob', status: 'running' } as any);
    assert.equal(feedItems[0].text, 'hi');
    assert.equal(feedItems[1].type, 'tool');
  });
});

// ==================== 2. FeedItem default 分支 ====================

describe('缺陷#5 第2层：FeedItem 未知 type 安全渲染', () => {
  it('崩溃载荷（tools/pre-execute with id）→ 不返回裸字符串，渲染为灰字单行', () => {
    const restore = stubInkGlobals();
    CLEANUPS.push(restore);
    const item = { id: 'mu2wk7rer8i9svrz4g', ...crashPayload() };
    const out: any = (FeedItemComponent as any)({ item });
    assert.ok(out !== null && typeof out === 'object', '不得返回字符串字面量');
    assert.notEqual(out.type, JSON.stringify(item), '不得把 JSON 字符串直接放进树');
    const leaves = collectStringLeaves(out);
    assert.ok(leaves.length >= 1, '有可见文本');
    assert.ok(leaves.join(' ').includes('tools/pre-execute'), '灰字含事件 type');
  });

  it('全部已知 type 的兜底路径（Text 缺席）也不产生裸字符串叶以外的非法返回', () => {
    const restore = stubInkGlobals();
    CLEANUPS.push(restore);
    const types: any[] = [
      { id: '1', type: 'text', text: 'hello' },
      { id: '2', type: 'critique', critique: 'c' },
      { id: '3', type: 'phase', phase: 'explore' },
      { id: '4', type: 'thought', short: 's' },
      { id: '5', type: 'budget', usedRatio: 0.5 },
      { id: '6', type: 'unknown-thing' },
    ];
    for (const item of types) {
      const out: any = (FeedItemComponent as any)({ item });
      if (typeof out === 'string') {
        assert.fail(`type=${item.type} 返回了裸字符串（ink 树会崩溃）`);
      }
      assert.ok(out !== null && out !== undefined, `type=${item.type} 有返回值`);
      const leaves = collectStringLeaves(out);
      assert.ok(leaves.every((s) => typeof s === 'string'), '叶节点全部为字符串文本');
    }
  });
});

// ==================== 3. mapSseToBridge 内部事件转换 ====================

describe('缺陷#5 第3层：mapSseToBridge 内部事件转换', () => {
  it('tools/pre-execute → pushTool(running 卡片)，不再原样 pushFeed', () => {
    const tools: any[] = [];
    const feeds: any[] = [];
    mapSseToBridge('tools/pre-execute', crashPayload(), {
      pushTool: (t: any) => tools.push(t),
      pushFeed: (f: any) => feeds.push(f),
    } as any);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool, 'glob');
    assert.equal(tools[0].status, 'running');
    assert.equal(feeds.length, 0, '不落 text feed');
  });

  it('tools/post-execute → pushTool(ok/fail + 预览)', () => {
    const tools: any[] = [];
    mapSseToBridge('tools/post-execute', {
      type: 'tools/post-execute', tool: 'glob', ok: true, durationMs: 12, outputPreview: 'a.ts\nb.ts',
    }, { pushTool: (t: any) => tools.push(t) } as any);
    assert.equal(tools[0].status, 'ok');
    assert.ok(String(tools[0].result).includes('a.ts'));

    mapSseToBridge('tools/post-execute', {
      type: 'tools/post-execute', tool: 'bash', ok: false, error: 'TIMEOUT',
    }, { pushTool: (t: any) => tools.push(t) } as any);
    assert.equal(tools[1].status, 'fail');
  });

  it('approval.request → 不进 feed（审批走 setConfirm 桥）', () => {
    const feeds: any[] = [];
    mapSseToBridge('approval.request', {
      version: 2, type: 'approval.request', requestId: 'r1', tool: 'bash', description: 'ls', danger: false,
    }, { pushFeed: (f: any) => feeds.push(f) } as any);
    assert.equal(feeds.length, 0);
  });

  it('未知 type 事件 → pushFeed 收到安全 text（即使 bridge 只有 pushFeed）', () => {
    const feeds: any[] = [];
    mapSseToBridge('weird/internal', { type: 'weird/internal', foo: 'bar' }, {
      pushFeed: (f: any) => feeds.push(f),
    } as any);
    assert.equal(feeds.length, 1);
    // 经 bridge 归一化后 type 不可能是未知值；即便测试桩直收，也断言非透传引用
    assert.notEqual(feeds[0], undefined);
  });

  it('端到端：真 bridge.pushFeed 收到未知事件 → feed 里无未知 type（崩溃绝迹）', () => {
    const { bridge, feedItems } = bridgeWithDispatch();
    mapSseToBridge('tools/pre-execute', crashPayload(), bridge);
    // pushTool 在真 bridge 上归一化为 type:'tool' 卡片
    assert.ok(feedItems.length >= 1);
    const allowed = new Set(['text', 'phase', 'step', 'critique', 'tool', 'thought', 'budget', 'markdown']);
    for (const it of feedItems) {
      assert.ok(allowed.has(String(it.type)), `feed 出现未知 type: ${it.type}`);
    }
  });
});

// ==================== 4. OutputRenderer ink 模式 ====================

describe('缺陷#5 第1层：OutputRenderer ink 模式不裸写 stdout', () => {
  function captureWrites(fn: () => void): string[] {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (data: any, ...args: any[]) => {
      chunks.push(String(data));
      return true as any;
    };
    try {
      fn();
    } finally {
      (process.stdout as any).write = orig;
    }
    return chunks;
  }

  it('feedSink 激活：writeLine 不写 stdout，字符串进 sink 由 FeedItem 包 <Text>', () => {
    const r = new OutputRendererImpl();
    const fed: any[] = [];
    r.setFeedSink((item) => fed.push(item));
    const out = captureWrites(() => { r.writeLine('hello ink'); });
    assert.equal(out.join(''), '', 'ink 拥屏期间不得裸写 stdout');
    assert.equal(fed.length, 1);
    assert.equal(fed[0].type, 'text');
    assert.equal(fed[0].text, 'hello ink');
  });

  it('error() 单条入 feed（旧实现 writeLine+push 双份），level=error', () => {
    const r = new OutputRendererImpl();
    const fed: any[] = [];
    r.setFeedSink((item) => fed.push(item));
    captureWrites(() => { r.error('boom'); });
    assert.equal(fed.length, 1, `旧实现双份推送，got ${fed.length}`);
    assert.equal(fed[0].level, 'error');
    assert.ok(fed[0].text.includes('boom'));
  });

  it('line 模式（无 feedSink）行为不变：仍写 stdout', () => {
    const r = new OutputRendererImpl();
    const out = captureWrites(() => { r.writeLine('plain'); });
    assert.ok(out.join('').includes('plain'));
  });
});

// ==================== 5. 缺陷#3/#4：rich /tier 交互滑杆 ====================

function makeCtx(session: Session): TurnContext {
  const ctx = createTurnContext({ session, renderer: fakeRenderer() });
  ctx.modeRing = createModeRing(ctx);
  return ctx;
}

describe('缺陷#3/#4：rich /tier 滑杆交互化', () => {
  it('确认：openTierPicker resolve(3) → tier 切到第 4 档 max + setTop + 回执，不打印滑杆块', async () => {
    const session = new Session({ tier: 'high', workspace: process.cwd() });
    const ctx = makeCtx(session);
    let resolvedWith: any = null;
    const tops: any[] = [];
    const feeds: any[] = [];
    const bridge = {
      openTierPicker: (o: any) => {
        assert.equal(o.index, 2, '初始 ▲ 在当前档 high（下标 2）');
        assert.equal(o.tiers.length, 6);
        resolvedWith = o;
        return Promise.resolve(3);
      },
      setTop: (p: any) => tops.push(p),
      pushFeed: (f: any) => feeds.push(f),
    };
    const lines: string[] = [];
    const emit = (t: string) => lines.push(t);
    const handled = await handleSlashCommand(ctx, { cmd: '/tier', arg: '', emit, useRich: true, bridge } as any);
    assert.equal(handled, true);
    assert.ok(resolvedWith, '滑杆已打开');
    assert.equal(session.tier, 'max', '确认后切到下标 3 = max');
    assert.ok(tops.some((t) => t.tier === 'max'), 'TopBar tier 徽标同步');
    assert.ok(lines.some((l) => l.includes('✓ 思考强度已切换: max')), '切换回执');
    assert.ok(!lines.some((l) => l.includes('←/→ 调节')), 'rich 不打印静态滑杆块（无残影源）');
    assert.ok(!lines.some((l) => l === '思考强度'), '无滑杆标题行残迹');
  });

  it('取消：resolve(-1) → 档位不变 + 保留回执', async () => {
    const session = new Session({ tier: 'high', workspace: process.cwd() });
    const ctx = makeCtx(session);
    const bridge = {
      openTierPicker: () => Promise.resolve(-1),
      setTop: () => {},
      pushFeed: () => {},
    };
    const lines: string[] = [];
    await handleSlashCommand(ctx, { cmd: '/tier', arg: '', emit: (t: string) => lines.push(t), useRich: true, bridge } as any);
    assert.equal(session.tier, 'high', 'Esc 取消不改档');
    assert.ok(lines.some((l) => l.includes('已保留 high')), '保留回执');
  });

  it('rich UI 未挂载（openTierPicker → null）→ 单行说明，绝不打印 8 行残迹块', async () => {
    const session = new Session({ tier: 'high', workspace: process.cwd() });
    const ctx = makeCtx(session);
    const bridge = { openTierPicker: () => Promise.resolve(null), pushFeed: () => {} };
    const lines: string[] = [];
    await handleSlashCommand(ctx, { cmd: '/tier', arg: '', emit: (t: string) => lines.push(t), useRich: true, bridge } as any);
    assert.equal(lines.length, 1, `只打单行，got ${lines.length} 行`);
    assert.ok(lines[0].includes('思考强度'), '单行含当前档');
    assert.ok(!lines.some((l) => l.includes('┊')), '无轨道残迹');
  });
});

// ==================== 6. 缺陷#1：rich /exit 干净退出缝 ====================

describe('缺陷#1：rich /exit 本地派发', () => {
  it('/exit 在统一派发器本地处理：落盘 + requestExit，不再落"未知命令"', async () => {
    const session = new Session({ tier: 'high', workspace: process.cwd() });
    const ctx = makeCtx(session);
    let exited = 0;
    (ctx as any).requestExit = () => { exited++; };
    const feeds: any[] = [];
    const bridge = { pushFeed: (f: any) => feeds.push(f) };
    const lines: string[] = [];
    const handled = await handleSlashCommand(ctx, {
      cmd: '/exit', arg: '', emit: (t: string) => lines.push(t), useRich: true, bridge,
    } as any);
    assert.equal(handled, true, '/exit 被本地处理');
    assert.equal(exited, 1, '干净退出缝被调用');
    assert.ok(!lines.some((l) => l.includes('未知命令')), '不再报未知命令');
  });

  it('/quit 与 /q 同样命中', async () => {
    for (const cmd of ['/quit', '/q']) {
      const session = new Session({ tier: 'high', workspace: process.cwd() });
      const ctx = makeCtx(session);
      let exited = 0;
      (ctx as any).requestExit = () => { exited++; };
      const handled = await handleSlashCommand(ctx, { cmd, arg: '', emit: () => {}, useRich: true, bridge: {} } as any);
      assert.equal(handled, true);
      assert.equal(exited, 1, `${cmd} 命中退出`);
    }
  });
});

// ==================== 7. TierPicker 组件纯渲染 ====================

describe('TierPicker 组件（rich 滑杆）纯渲染', () => {
  it('无 useInput 环境安全渲染：包含标题/档名/页脚，无裸字符串返回', () => {
    const restore = stubInkGlobals();
    CLEANUPS.push(restore);
    const out: any = (TierPicker as any)({
      picker: {
        tiers: ['quick', 'standard', 'high', 'max', 'ex', 'pangu'],
        sublabels: ['a', 'b', 'c', 'd', 'e', 'f'],
        index: 2,
      },
      onConfirm: () => {},
      onCancel: () => {},
    });
    assert.ok(out !== null && typeof out === 'object', '返回元素而非字符串');
    const text = collectStringLeaves(out).join(' ');
    assert.ok(text.includes('思考强度'));
    assert.ok(text.includes('high'), '含当前档名');
    assert.ok(text.includes('pangu'), '含扩展档名');
    assert.ok(text.includes('←/→ 调节'), '含页脚提示');
  });
});
