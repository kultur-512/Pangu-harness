// tests/repl/turn/TurnUxAlign.test.ts
// 0.8 UI/UX 对齐三项改进（U1/U2/U4）行为锁定：
//  - U1 spinner 字符帧动画：帧序列/120ms 节奏/4s 动词轮换桶/帧行组装（青帧+亮动词+dim 耗时）
//  - U2 流式正文行缓冲：flushBufferedMarkdown 边界切分/段内行内 markdown 转换/残段冲刷兜底
//  - U4 空闲状态行：buildIdleStatusLine 组装 + 回合边界一次性刷新（drain 中间轮不打）
// 手法同 TurnBehavior.lock.test.ts：createTurnContext + createTurnController +
// ctx.loadRunAgentTask 假体 + fake renderer；stdout 写出经临时补丁捕获（用后即还原）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../../src/cli/repl/Session.js';
import {
  createTurnContext,
  type TurnContext,
} from '../../../src/cli/repl/turn/TurnContext.js';
import { createTurnController } from '../../../src/cli/repl/turn/TurnController.js';
import { createModeRing } from '../../../src/cli/repl/turn/CommandRouter.js';
import {
  ANSI_CYAN,
  ANSI_RESET,
  buildIdleStatusLine,
  endMessageStream,
  flushBufferedMarkdown,
  mapSseToBridge,
  reconLine,
  renderInlineMarkdown,
  renderSseEvent,
  spinnerRunningLine,
  spinnerToolLine,
  idleStatusSegments,
  buildModelMenuRows,
  formatModelMenuRow,
  buildEffortSliderBlock,
  redrawEffortSliderLines,
  ANSI_GREEN,
  ANSI_DIM,
} from '../../../src/cli/repl/turn/TurnRenderer.js';
import { handleEffortSelKey } from '../../../src/cli/repl/turn/CommandRouter.js';
import {
  GERUND_ROTATE_MS,
  SPINNER_FRAMES,
  SPINNER_FRAME_MS,
  gerundBucket,
  nextSpinnerFrame,
  resetSpinnerFrame,
  spinnerRedrawMs,
} from '../../../src/cli/repl/GerundSpinner.js';
import { deleteRollout } from '../../../src/cli/repl/rolloutStore.js';

// ==================== 测试替身 ====================

const TMP_DIRS: string[] = [];
const TOUCHED_SESSION_IDS: string[] = [];

function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ux08-'));
  TMP_DIRS.push(d);
  return d;
}

function fakeRenderer() {
  const lines: string[] = [];
  const push = (t: any) => { lines.push(String(t)); };
  return {
    lines,
    writeLine: push,
    write: push,
    stream: push,
    color: (t: string) => String(t),
    warn: push,
    error: push,
    success: push,
    info: push,
    clearScreen: () => {},
  } as any;
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 捕获 process.stdout 直写（spinner/流式正文不经 renderer，只能在此断言）。
 *  注意：node:test 的 TAP 报告也写 process.stdout——补丁窗口必须保持同步
 *  （窗口内不得 await，否则会把 runner 的 TAP 行吞进 sink，输出/计数错乱）。 */
function captureStdout() {
  const orig = process.stdout.write;
  const chunks: string[] = [];
  const patched = function (s: any) { chunks.push(String(s)); return true; } as any;
  (process.stdout as any).write = patched;
  return {
    chunks,
    joined: () => chunks.join(''),
    restore: () => { (process.stdout as any).write = orig; },
  };
}

function makeHarness(init?: { renderer?: any }) {
  const session = new Session({ tier: 'high', workspace: tmpWs() });
  TOUCHED_SESSION_IDS.push(session.id);
  const renderer = init?.renderer ?? fakeRenderer();
  const ctx = createTurnContext({ session, renderer });
  ctx.modeRing = createModeRing(ctx);
  const controller = createTurnController(ctx);
  return { session, ctx, renderer, controller };
}

afterEach(() => {
  for (const id of TOUCHED_SESSION_IDS) { try { deleteRollout(id); } catch {} }
  TOUCHED_SESSION_IDS.length = 0;
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  TMP_DIRS.length = 0;
});

// ==================== U1：spinner 字符帧动画 ====================

describe('U1 spinner 帧序列（CC 同款）', () => {
  it('帧序列为 CC 同款六帧，帧间隔 120ms，动词轮换 4s', () => {
    assert.deepEqual([...SPINNER_FRAMES], ['·', '✢', '✳', '✶', '✻', '✽']);
    assert.equal(SPINNER_FRAME_MS, 120);
    assert.equal(GERUND_ROTATE_MS, 4000);
  });

  it('nextSpinnerFrame 顺序循环取帧（含回绕）；resetSpinnerFrame 归零；redraw 节奏 120/4000', () => {
    resetSpinnerFrame();
    const drawn = [nextSpinnerFrame(), nextSpinnerFrame(), nextSpinnerFrame(), nextSpinnerFrame(), nextSpinnerFrame(), nextSpinnerFrame(), nextSpinnerFrame()];
    assert.deepEqual(drawn, ['·', '✢', '✳', '✶', '✻', '✽', '·'], '7 帧回绕到首帧');
    resetSpinnerFrame();
    assert.equal(nextSpinnerFrame(), '·', 'reset 后从首帧开始');
    assert.equal(spinnerRedrawMs(true), 120, '动画路径 120ms/帧');
    assert.equal(spinnerRedrawMs(false), 4000, '退化路径保持旧 4s 文本刷新');
  });

  it('gerundBucket 按 4s 桶轮换动词（桶变化即换词，帧动画不停）', () => {
    assert.equal(gerundBucket(0), 0);
    assert.equal(gerundBucket(3999), 0);
    assert.equal(gerundBucket(4000), 1);
    assert.equal(gerundBucket(8000), 2);
    assert.equal(gerundBucket(-5), 0, '负值钳到 0');
  });

  it('spinnerRunningLine：帧字符青色 + 动词亮色（bold）+ 耗时 dim；负耗时钳 0s', () => {
    const line = spinnerRunningLine('✳', '研磨中', 42000);
    assert.ok(line.includes(`${ANSI_CYAN}✳\x1b[39m`), `帧字符青色，got: ${JSON.stringify(line)}`);
    assert.ok(line.includes('\x1b[1m研磨中\x1b[22m'), '动词亮色（bold）');
    assert.ok(line.includes('\x1b[2m⏱ 42s\x1b[22m'), '耗时 dim');
    assert.ok(line.startsWith(`${ANSI_CYAN}`), '帧字符在最前（前缀形态）');
    const zero = spinnerRunningLine('·', '凝神中', -3);
    assert.ok(zero.includes('⏱ 0s'), '负耗时钳到 0s');
  });

  it('spinnerToolLine：进行时工具标签套帧字符前缀（Writing xxx… ⏱ Ns 形态保留）', () => {
    const line = spinnerToolLine('·', 'Writing', 'README.md', 5000);
    assert.ok(line.startsWith(`${ANSI_CYAN}·\x1b[39m `), '帧字符前缀');
    assert.ok(line.includes('\x1b[1mWriting\x1b[22m README.md…'), '动词 + 参数摘要');
    assert.ok(line.includes('\x1b[2m⏱ 5s\x1b[22m'), '耗时 dim');
    void ANSI_RESET; // 常量导出可用性锁定
  });
});

// ==================== U2：流式正文行缓冲（行内 markdown 渐进） ====================

describe('U2 flushBufferedMarkdown 行缓冲', () => {
  it('无完整段（无 \\n 且无 。）→ 全部留缓冲，不输出', () => {
    assert.deepEqual(flushBufferedMarkdown('加粗 **重'), { ready: '', rest: '加粗 **重' });
    assert.deepEqual(flushBufferedMarkdown(''), { ready: '', rest: '' });
  });

  it('\\n 边界：完整段做行内 markdown 转换输出，残段留缓冲', () => {
    const { ready, rest } = flushBufferedMarkdown('说 **重点** 好\n尾段残');
    assert.ok(ready.includes('\x1b[1m重点\x1b[22m'), `粗体转换，got: ${JSON.stringify(ready)}`);
    assert.ok(!ready.includes('**'), '星号不原样外泄');
    assert.ok(ready.endsWith('\n'), '段终止符保留');
    assert.equal(rest, '尾段残');
  });

  it('。边界：句号同样触发冲刷；`行内码` 青色转换', () => {
    const { ready, rest } = flushBufferedMarkdown('用 `code` 跑通了。继续的残段');
    assert.ok(ready.includes('\x1b[36mcode\x1b[39m'), `行内码青色，got: ${JSON.stringify(ready)}`);
    assert.ok(!ready.includes('`'), '反引号不原样外泄');
    assert.ok(ready.endsWith('。'), '句号终止符保留');
    assert.equal(rest, '继续的残段');
  });

  it('粗体跨 。边界不误转（边界即切分点，闭合对被切断 → 两半都保持字面）', () => {
    const { ready, rest } = flushBufferedMarkdown('**前。后**');
    assert.equal(ready, '**前。', '前半未闭合保持字面');
    assert.equal(rest, '后**', '后半留缓冲');
  });
});

describe('U2 message.delta 流式接线', () => {
  it('残段不足一段不写 stdout；补齐段后一次性转换输出并清缓冲', () => {
    const { ctx } = makeHarness();
    const cap = captureStdout();
    try {
      renderSseEvent(ctx, 'message.delta', { text: '模型 **回' }, ctx.renderer);
      assert.equal(cap.chunks.length, 0, '无完整段 → 零写出（spinner 行不被打扰）');
      assert.equal(ctx.lineUi.messageBuf, '模型 **回');
      assert.equal(ctx.lineUi.messageStreaming, true, '流式态仍置位（gerund 暂停语义不回归）');
      assert.equal(ctx.lineUi.streamedAnswerChars, '模型 **回'.length, '流式计数含缓冲残段');

      renderSseEvent(ctx, 'message.delta', { text: '答** 完。\n' }, ctx.renderer);
      assert.ok(cap.joined().includes('\x1b[1m回答\x1b[22m 完。\n'), `段内转换输出，got: ${JSON.stringify(cap.joined())}`);
      assert.equal(ctx.lineUi.messageBuf, '', '完整段冲刷后缓冲清空');
      assert.equal(ctx.lineUi.streamedAnswerChars, '模型 **回答** 完。\n'.length);
    } finally {
      cap.restore();
    }
  });

  it('result 事件收尾冲刷残段（未闭合标记保持字面）+ 补换行；endMessageStream 幂等', () => {
    const { ctx } = makeHarness();
    renderSseEvent(ctx, 'message.delta', { text: 'hello **wor' }, ctx.renderer);
    assert.equal(ctx.lineUi.messageBuf, 'hello **wor');
    const cap = captureStdout();
    try {
      renderSseEvent(ctx, 'result', { stopReason: 'answered', success: true }, ctx.renderer);
      assert.ok(cap.joined().includes('hello **wor'), `残段兜底落屏（未闭合 ** 保持字面），got: ${JSON.stringify(cap.joined())}`);
      assert.ok(cap.joined().endsWith('\n'), '流式态收尾补换行');
      assert.equal(ctx.lineUi.messageBuf, '');
      assert.equal(ctx.lineUi.messageStreaming, false);
      // 幂等：缓冲已空且未流式 → 不再写任何字节
      const before = cap.chunks.length;
      endMessageStream(ctx);
      assert.equal(cap.chunks.length, before, '二次调用 no-op');
    } finally {
      cap.restore();
    }
  });

  it('answered 兜底路径冲刷缓冲残段，差量补齐不重复（全链路）', async () => {
    const { ctx, renderer, controller } = makeHarness();
    ctx.loadRunAgentTask = async () => ({
      runAgentTask: (async (_req: any, cctx: any) => {
        cctx.onEvent({ type: 'message.delta', text: '模型最终回答' }); // 无边界 → 全程在缓冲
        return { success: true, stopReason: 'answered', durationMs: 10, answerText: '模型最终回答全文ABC' };
      }) as any,
    });
    await controller.runTask('你好');
    // 残段无边界、不会经 message.delta 冲刷——运行后 messageBuf 已空 ⇒ answered
    // 路径确实调用了 endMessageStream 冲刷（冲刷字节直写 stdout，锁在同文件直调用例）。
    assert.equal(ctx.lineUi.messageBuf, '', 'answered 路径必须冲刷行缓冲残段');
    assert.equal(ctx.lineUi.streamedAnswerChars, 6);
    assert.ok(renderer.lines.includes('全文ABC'), '差量「全文ABC」经 writeLine 补齐');
    assert.ok(!renderer.lines.includes('模型最终回答全文ABC'), '不得整段重复输出');
  });
});

describe('U2 renderInlineMarkdown 补充确认', () => {
  it('有序列表 `1. ` 前缀不转换不着色（原样透传）', () => {
    const src = '1. 第一步\n2. 第二步\n10. 第十步';
    assert.equal(renderInlineMarkdown(src), src);
    assert.ok(!renderInlineMarkdown(src).includes('\x1b['), '无任何 ANSI 着色');
  });
});

// ==================== U4：空闲状态行（提示符上方，回合边界刷新） ====================

describe('U4 buildIdleStatusLine', () => {
  it('组装 `<模型短名> · <tier> · <模式> · ctx ~N%`；剥 provider 前缀；ctx 封顶 100%', () => {
    assert.equal(
      buildIdleStatusLine({ model: 'openpangu:m3', tier: 'high', mode: 'default', ctxUsedChars: 6554, ctxWindowTokens: 32768 }),
      'm3 · high · default · ctx ~5%',
      '6554/4/32768 ≈ 5%'
    );
    assert.equal(
      buildIdleStatusLine({ model: 'glm-5', tier: 'low', mode: 'plan', ctxUsedChars: 4e9, ctxWindowTokens: 32768 }),
      'glm-5 · low · plan · ctx ~100%',
      '超界封顶 100%'
    );
    assert.equal(
      buildIdleStatusLine({ model: 'm', tier: 'high', mode: 'default', ctxUsedChars: 0, ctxWindowTokens: 0 }),
      'm · high · default · ctx ~0%',
      '窗口 0 不产生 NaN（分母钳 1）'
    );
  });

  it('line 模式任务结束 → 提示符上方打一行状态行（模型短名/tier/模式/ctx 占比）', async () => {
    const { session, ctx, renderer, controller } = makeHarness();
    session.updateModel('openpangu:glm-5');
    ctx.ctxUsedChars = 6554;
    ctx.ctxWindowTokens = 32768;
    // A2 计量口径：任务落定后 ctxUsedChars 以实测锚点重校准——fake 返回
    // usageMeasured budgetReport（lastPromptTokens=1638 → ×4=6554 → 5%）。
    ctx.loadRunAgentTask = async () => ({
      runAgentTask: (async () => ({
        success: true, stopReason: 'completed', durationMs: 5,
        budgetReport: { usageMeasured: true, lastPromptTokens: 1638 },
      })) as any,
    });
    await controller.runTask('任务一');
    const status = renderer.lines.find((l: string) => /ctx ~\d+%$/.test(l));
    assert.ok(status, `空闲状态行存在，got: ${JSON.stringify(renderer.lines)}`);
    assert.equal(status, 'glm-5 · high · default · ctx ~5%', '回合边界按实测锚点刷新');
  });

  it('drain 中间轮不打状态行（队列非空即跑下一个），只在回到空闲打一次', async () => {
    const { ctx, renderer, controller } = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    ctx.loadRunAgentTask = async () => ({
      runAgentTask: (async () => {
        calls++;
        if (calls === 1) await gate;
        return { success: true, stopReason: 'completed', durationMs: 1 };
      }) as any,
    });

    const p1 = controller.handleLine('第一条');
    await waitUntil(() => calls === 1);
    await controller.handleLine('第二条任务'); // 运行中 → 入队
    release();
    await p1;
    await waitUntil(() => calls === 2);
    await waitUntil(() => ctx.queue.taskCount === 0);
    await new Promise((r) => setTimeout(r, 20)); // drain 收尾

    const statusLines = renderer.lines.filter((l: string) => /ctx ~\d+%$/.test(l));
    assert.equal(statusLines.length, 1, `只在回到空闲时打一次，got: ${JSON.stringify(statusLines)}`);
  });

  it('aborted 保留队列时也打状态行（用户回到空闲手动重跑）', async () => {
    const { ctx, renderer, controller } = makeHarness();
    let calls = 0;
    ctx.loadRunAgentTask = async () => ({
      runAgentTask: (async (_req: any, cctx: any) => {
        calls++;
        // 等 abort 信号才 settle（等价 SIGINT 链路；同步返回会让运行态提前复位）
        await new Promise<void>((resolve) => {
          if (cctx.signal?.aborted) { resolve(); return; }
          const iv = setInterval(() => {
            if (cctx.signal?.aborted) { clearInterval(iv); resolve(); }
          }, 5);
        });
        return { success: false, stopReason: 'aborted', durationMs: 1, partialText: 'p' };
      }) as any,
    });
    const p1 = controller.handleLine('会被中断的任务');
    await waitUntil(() => calls === 1);
    await controller.handleLine('排队的第二条'); // 入队
    ctx.currentAbort!.abort();
    await p1;
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(ctx.lastAborted, true);
    assert.equal(ctx.queue.taskCount, 1, '排队项保留');
    const statusLines = renderer.lines.filter((l: string) => /ctx ~\d+%$/.test(l));
    assert.equal(statusLines.length, 1, `aborted 分支同样打一行状态行，got: ${JSON.stringify(statusLines)}`);
  });
});

// ==================== CC 式档位视觉 + /model 菜单（2026-09-12 真机对标） ====================

describe('idleStatusSegments：状态行分段（模式段独立上色）', () => {
  const opts = { model: 'openpangu:m3', tier: 'high', mode: 'plan', ctxUsedChars: 6554, ctxWindowTokens: 32768 } as const;

  it('head + mode + tail === buildIdleStatusLine（旧纯文本口径不变）', () => {
    const seg = idleStatusSegments(opts);
    assert.equal(seg.head + seg.mode + seg.tail, buildIdleStatusLine(opts));
    assert.equal(seg.head, 'm3 · high · ');
    assert.equal(seg.mode, 'plan');
    assert.equal(seg.tail, ' · ctx ~5%');
  });

  it('modeColor 来自 modeBadgeVisual（plan→blue）', () => {
    assert.equal(idleStatusSegments(opts).modeColor, 'blue');
    assert.equal(idleStatusSegments({ ...opts, mode: 'auto-accept' }).modeColor, 'cyan');
    assert.equal(idleStatusSegments({ ...opts, mode: 'default' }).modeColor, 'gray');
  });
});

describe('buildModelMenuRows / formatModelMenuRow：CC 式 /model 菜单', () => {
  it('编号从 1 起、当前项标记（剥 provider 前缀 + 大小写不敏感匹配）', () => {
    const rows = buildModelMenuRows(['openpangu:GLM-5', 'scnet:qwen3-32b', 'MiniMax-M3'], 'openpangu:glm-5');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.index), [1, 2, 3]);
    assert.equal(rows[0].current, true, 'GLM-5 ≡ 当前 glm-5（大小写不敏感）');
    assert.equal(rows[0].desc, '当前生效');
    assert.equal(rows[1].current, false);
    assert.equal(rows[1].desc, '');
    assert.equal(rows[0].name, 'GLM-5');
  });

  it('空清单 / 空当前模型不抛、无当前项', () => {
    assert.deepEqual(buildModelMenuRows([], 'glm-5'), []);
    const rows = buildModelMenuRows(['a', 'b'], '');
    assert.equal(rows.every((r) => !r.current), true);
  });

  it('formatModelMenuRow 纯文本：`> N. 名称  描述` 当前行前缀；无描述行不留尾随填充', () => {
    const rows = buildModelMenuRows(['glm-5', 'ab', 'MiniMax-M3'], 'glm-5');
    const w = Math.max(...rows.map((r) => r.name.length));
    assert.equal(formatModelMenuRow(rows[0], w, false), `>  1. glm-5${' '.repeat(w - 5)}  当前生效`);
    assert.equal(formatModelMenuRow(rows[1], w, false), '   2. ab');
    assert.equal(formatModelMenuRow(rows[2], w, false), '   3. MiniMax-M3');
  });

  it('着色版：当前行绿色名称、其余青色；编号与描述 dim（含 ANSI 段）', () => {
    const rows = buildModelMenuRows(['glm-5'], 'glm-5');
    const colored = formatModelMenuRow(rows[0], 5, true);
    assert.ok(colored.includes(ANSI_GREEN + 'glm-5'), '当前项名称绿色');
    assert.ok(colored.includes(ANSI_DIM), '编号 dim');
    const other = formatModelMenuRow(buildModelMenuRows(['ab'], 'x')[0], 5, true);
    assert.ok(other.includes('\x1b[36m'), '非当前项名称青色');
    assert.ok(!other.includes(ANSI_GREEN), '非当前项无绿色');
  });
});

// ==================== CC 式 /tier 思考强度滑杆（2026-09-12 真机对标 /effort） ====================

describe('buildEffortSliderBlock：CC 式思考强度滑杆', () => {
  const TIERS = ['quick', 'standard', 'high', 'max', 'ex', 'pangu'];
  const SUBS = ['热修复、临时检查', '常规小修改', '日常主力（推荐）', '重要/高风险任务', '极难任务、核心模块', '极致追求（终极长程记忆模式）'];

  it('纯文本：8 行结构（标题/空/端标签/轨道/档名/副标注/空/页脚）', () => {
    const lines = buildEffortSliderBlock({ tiers: TIERS, sublabels: SUBS, index: 2, useColor: false, width: 80 });
    assert.equal(lines.length, 8);
    assert.equal(lines[0], '思考强度');
    assert.equal(lines[1], '');
    assert.ok(lines[2].includes('更快') && lines[2].includes('更强'), '端标签两端齐全');
    assert.ok(lines[3].includes('▲'), '轨道含 ▲ 光标');
    assert.ok(lines[3].includes('┊'), '扩展区边界 ┊ 分隔');
    assert.ok(lines[4].includes('quick') && lines[4].includes('pangu'), '档名行含全部六档');
    assert.ok(lines[5].startsWith('▲ high · 日常主力（推荐）'), '副标注行 = 当前档 + typicalUseCase');
    assert.equal(lines[7], '←/→ 调节 · Enter 确认 · Esc 取消');
  });

  it('▲ 落在当前档列中心；无副标注时只输出 `▲ <档名>`', () => {
    const lines = buildEffortSliderBlock({ tiers: TIERS, sublabels: SUBS, index: 0, useColor: false, width: 80 });
    assert.ok(lines[5].startsWith('▲ quick · 热修复、临时检查'));
    const idx4 = buildEffortSliderBlock({ tiers: TIERS, index: 4, useColor: false, width: 80 });
    assert.ok(idx4[5].startsWith('▲ ex'), '无 sublabels 时不带 · 后缀');
  });

  it('着色版：扩展档品红、其余 dim、当前档无色标记（默认白亮）', () => {
    const lines = buildEffortSliderBlock({ tiers: TIERS, sublabels: SUBS, index: 2, useColor: true, width: 80 });
    assert.ok(lines[4].includes('\x1b[35mex'), '扩展档 ex 品红');
    assert.ok(lines[4].includes('\x1b[35mpangu'), '扩展档 pangu 品红');
    assert.ok(lines[4].includes('\x1b[2mquick'), '非当前主档 dim');
    assert.ok(!/\x1b\[2mhigh/.test(lines[4]), '当前档 high 不 dim');
    assert.ok(lines[2].includes('\x1b[35m更强'), '更强端品红');
  });

  it('index 钳位：越界取边界，不抛', () => {
    const over = buildEffortSliderBlock({ tiers: TIERS, index: 99, useColor: false, width: 80 });
    assert.ok(over[5].startsWith('▲ pangu'));
    const under = buildEffortSliderBlock({ tiers: TIERS, index: -5, useColor: false, width: 80 });
    assert.ok(under[5].startsWith('▲ quick'));
  });
});

describe('redrawEffortSliderLines：原位重绘 ANSI 序列', () => {
  it('光标回块顶（N 行上移）+ 每行清行重写 + 尾行回提示符行', () => {
    const seq = redrawEffortSliderLines(['a', 'b', 'c']);
    assert.ok(seq.startsWith('\r\x1b[3A\r'), `上移 3 行，got: ${JSON.stringify(seq)}`);
    assert.equal(seq.split('\x1b[2K').length - 1, 3, '三行各清一次');
    assert.equal(seq.split('\x1b[1B').length - 1, 3, '三次下移（最后一行后回提示符行）');
    assert.ok(seq.includes('a') && seq.includes('b') && seq.includes('c'));
  });
});

describe('handleEffortSelKey：/tier 交互滑杆按键消费', () => {
  it('未激活 → false（透传 readline）', () => {
    const { ctx } = makeHarness();
    assert.equal(handleEffortSelKey(ctx, { name: 'left' }), false);
  });

  it('←→ 移动钳位并重绘；Enter 切换 tier + 回执；Esc 保留现状', async () => {
    const { session, ctx, renderer } = makeHarness();
    ctx.effortSel = { active: true, tiers: ['quick', 'standard', 'high', 'max', 'ex', 'pangu'], sublabels: ['a', 'b', 'c', 'd', 'e', 'f'], index: 2 };
    let redraws = 0;
    ctx.renderer.write = () => { redraws++; };
    ctx.lineRefreshLine = () => {};

    assert.equal(handleEffortSelKey(ctx, { name: 'left' }), true, '← 已消费');
    assert.equal(ctx.effortSel?.index, 1);
    assert.ok(redraws >= 1, '← 触发重绘');
    assert.equal(handleEffortSelKey(ctx, { name: 'left' }), true);
    assert.equal(handleEffortSelKey(ctx, { name: 'left' }), true);
    assert.equal(ctx.effortSel?.index, 0, '钳位到 0');
    assert.equal(handleEffortSelKey(ctx, { name: 'right' }), true);
    assert.equal(ctx.effortSel?.index, 1);

    // 字母键不消费（透传 readline 输入行）
    assert.equal(handleEffortSelKey(ctx, { name: 'x' }), false);
    assert.equal(ctx.effortSel?.active, true, '未消费键不影响选择态');

    // Enter → 切换 standard + 回执
    assert.equal(handleEffortSelKey(ctx, { name: 'return' }), true);
    assert.equal(session.tier, 'standard');
    assert.equal(ctx.effortSel, null);
    assert.ok(renderer.lines.some((l: string) => l.includes('✓ 思考强度已切换: standard')), '切换回执');

    // Esc → 保留
    ctx.effortSel = { active: true, tiers: ['quick', 'high'], sublabels: ['', ''], index: 1 };
    assert.equal(handleEffortSelKey(ctx, { name: 'escape' }), true);
    assert.equal(session.tier, 'standard', 'Esc 不改档');
    assert.equal(ctx.effortSel, null);
    assert.ok(renderer.lines.some((l: string) => l.includes('（已保留 high）')), '保留回执');
  });

  it('Ctrl+C 关闭选择态并放行（返回 false 交给 SIGINT 链）', () => {
    const { ctx } = makeHarness();
    ctx.effortSel = { active: true, tiers: ['high'], sublabels: [''], index: 0 };
    assert.equal(handleEffortSelKey(ctx, { name: 'c', ctrl: true }), false, '放行');
    assert.equal(ctx.effortSel, null, '选择态已关闭');
  });
});

describe('handleSlashCommand /tier 内联分支：滑杆 + 编号直达', () => {
  it('无参：打印 8 行滑杆块并置 effortSel（line 模式）', async () => {
    const { ctx, renderer } = makeHarness();
    const { createCommandEmitter } = await import('../../../src/cli/repl/turn/CommandRouter.js');
    const emit = createCommandEmitter(ctx, false, null);
    const { handleSlashCommand } = await import('../../../src/cli/repl/turn/CommandRouter.js');
    const handled = await handleSlashCommand(ctx, { cmd: '/tier', arg: '', emit, useRich: false, bridge: null });
    assert.equal(handled, true);
    const sliderIdx = renderer.lines.findIndex((l: string) => l === '思考强度');
    assert.ok(sliderIdx >= 0, `滑杆块已打印，got: ${JSON.stringify(renderer.lines).slice(0, 200)}`);
    assert.ok(renderer.lines[sliderIdx + 7].includes('←/→ 调节'), '页脚在块底');
    assert.equal(ctx.effortSel?.active, true, 'line 模式进入交互选择态');
    assert.equal(ctx.effortSel?.tiers.length, 6);
  });

  it('编号直达：/tier 2 → standard + 回执；越界编号 warn；无效名 warn', async () => {
    const { session, ctx, renderer } = makeHarness();
    const { createCommandEmitter, handleSlashCommand } = await import('../../../src/cli/repl/turn/CommandRouter.js');
    const emit = createCommandEmitter(ctx, false, null);
    await handleSlashCommand(ctx, { cmd: '/tier', arg: '2', emit, useRich: false, bridge: null });
    assert.equal(session.tier, 'standard');
    assert.ok(renderer.lines.some((l: string) => l.includes('✓ 思考强度已切换: standard · 常规小修改')));
    assert.equal(ctx.effortSel, null, '带参切换不进选择态');
    await handleSlashCommand(ctx, { cmd: '/tier', arg: '99', emit, useRich: false, bridge: null });
    assert.ok(renderer.lines.some((l: string) => l.includes('超出范围')));
    await handleSlashCommand(ctx, { cmd: '/tier', arg: 'nope', emit, useRich: false, bridge: null });
    assert.ok(renderer.lines.some((l: string) => l.includes('无效档位: nope')));
  });
});

// ==================== 侦察内容透出（recon 事件，2026-09-15） ====================
// 真机实证：侦察相位线与执行相位线之间此前无任何内容（记忆注入审计只进 HOME
// 账本）。recon 事件把侦察结论（注入记忆数/意图/档位）带进 rich/line/headless。

describe('reconLine：侦察结论行组装（纯函数）', () => {
  it('组装核心字段：注入记忆数 + 意图 + 档位；缺失字段静默省略', () => {
    assert.equal(
      reconLine({ memoryCards: 3, intent: 'execution', tier: 'max' }),
      '侦察完成: 注入记忆 3 张 · 意图 execution · 档位 max'
    );
    assert.equal(
      reconLine({ memoryCards: 0, intent: 'search' }),
      '侦察完成: 注入记忆 0 张 · 意图 search'
    );
    assert.equal(
      reconLine({ memoryCards: 2, memoryOverflow: 5, promptChars: 100 }),
      '侦察完成: 注入记忆 2 张 · 记忆溢出 5 张 · 提示 100 字符'
    );
    assert.equal(reconLine({}), '侦察完成: 注入记忆 0 张', '空事件仍有基线文案');
    assert.equal(reconLine(null), '侦察完成: 注入记忆 0 张', 'null 安全');
  });
});

describe('recon 事件渲染：rich 桥 + line 模式', () => {
  it('rich 桥：pushFeed 落 info 文本行（toSafeFeedItem 安全形态）', () => {
    const feeds: any[] = [];
    mapSseToBridge('recon', { memoryCards: 2, intent: 'execution', tier: 'high' }, { pushFeed: (f: any) => feeds.push(f) });
    assert.deepEqual(feeds, [{ type: 'text', text: '侦察完成: 注入记忆 2 张 · 意图 execution · 档位 high', level: 'info' }]);
  });

  it('line 模式：renderSseEvent 输出侦察行（相位线之间的内容）', () => {
    const { ctx, renderer } = makeHarness();
    renderSseEvent(ctx, 'phase', { phase: 'explore' }, ctx.renderer);
    renderSseEvent(ctx, 'recon', { memoryCards: 4, intent: 'execution', tier: 'max' }, ctx.renderer);
    renderSseEvent(ctx, 'phase', { phase: 'rollout' }, ctx.renderer);
    const idx = renderer.lines.findIndex((l: string) => l.includes('侦察完成'));
    assert.ok(idx >= 0, `侦察行已渲染，got: ${JSON.stringify(renderer.lines).slice(0, 200)}`);
    const phaseIdx = renderer.lines.findIndex((l: string) => l === '── 侦察 ──');
    const rollIdx = renderer.lines.findIndex((l: string) => l === '── 执行 ──');
    assert.ok(phaseIdx >= 0 && rollIdx >= 0, '相位线双在');
    assert.ok(phaseIdx < idx && idx < rollIdx, '侦察行位于侦察/执行相位线之间');
  });
});

describe('handleSlashCommand /workspace：统一派发器补全（D2）', () => {
  it('带参：session.workspace 更新 + 成功回执；无参：打印当前工作区', async () => {
    const { session, ctx, renderer } = makeHarness();
    const { createCommandEmitter, handleSlashCommand } = await import('../../../src/cli/repl/turn/CommandRouter.js');
    const emit = createCommandEmitter(ctx, false, null);
    const target = tmpWs();
    const handled = await handleSlashCommand(ctx, { cmd: '/workspace', arg: target, emit, useRich: false, bridge: null });
    assert.equal(handled, true, '本地处理，绝不提交引擎');
    assert.equal(session.workspace, target, 'workspace 即时生效');
    assert.ok(renderer.lines.some((l: string) => l.includes(`工作区已切换到: ${target}`)));

    renderer.lines.length = 0;
    const handled2 = await handleSlashCommand(ctx, { cmd: '/workspace', arg: '', emit, useRich: false, bridge: null });
    assert.equal(handled2, true);
    assert.ok(renderer.lines.some((l: string) => l.includes(`当前工作区: ${target}`)), '无参打印当前工作区');
  });

  it('/ws 别名等价派发', async () => {
    const { session, ctx, renderer } = makeHarness();
    const { createCommandEmitter, handleSlashCommand } = await import('../../../src/cli/repl/turn/CommandRouter.js');
    const emit = createCommandEmitter(ctx, false, null);
    const target = tmpWs();
    const handled = await handleSlashCommand(ctx, { cmd: '/ws', arg: target, emit, useRich: false, bridge: null });
    assert.equal(handled, true);
    assert.equal(session.workspace, target, '/ws 别名切换生效');
  });
});
