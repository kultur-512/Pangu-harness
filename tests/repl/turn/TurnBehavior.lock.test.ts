// tests/repl/turn/TurnBehavior.lock.test.ts
// M1-TurnController 第 1 步（测试先行，行为锁定）：
// 在 sseInteractive 拆分为 turn/ 四模块之前，锁定 runTaskViaSse 与命令路由的
// 关键行为 —— 拆分前后本文件都必须全绿（零行为变更的验收标准）。
//
// 测试手法：sseInteractive 是 TTY 门控的，无法在测试里拉起 startSseInteractive；
// 改走 0.8 新增的最小可测缝 —— createTurnContext（巨状态显式化）+
// createTurnController（runTaskViaSse/handleUserLine 绑定）+ ctx.loadRunAgentTask
// （fake runAgentTask 注入，参考 Resilience073/runAgentTaskSession 对 runAgentTask
// 的替身手法）+ fake renderer / fake bridge（不落 TTY）。
// 断言不 mock rolloutStore：turn 落盘形状直接读 ~/.panshalach/rollouts/<id>.jsonl。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../../src/cli/repl/Session.js';
import {
  createTurnContext,
  createTurnController,
  createModeRing,
  handleLocalCommand,
  type TurnContext,
} from '../../../src/cli/repl/sseInteractive.js';
import { deleteRollout } from '../../../src/cli/repl/rolloutStore.js';

// ==================== 测试替身 ====================

const TMP_DIRS: string[] = [];
const TOUCHED_SESSION_IDS: string[] = [];

function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-m1turn-'));
  TMP_DIRS.push(d);
  return d;
}

/** 记录行输出的假 renderer（不碰 TTY；color 恒等）。 */
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

/** 记录 feed 的假 rich bridge（Ink UI 未启动形态）。 */
function fakeBridge() {
  const feeds: any[] = [];
  const tops: any[] = [];
  const running: boolean[] = [];
  return {
    feeds,
    tops,
    running,
    pushFeed: (f: any) => { feeds.push(f); },
    setTop: (t: any) => { tops.push(t); },
    setRunning: (v: boolean) => { running.push(v); },
    resetStream: () => {},
    appendStream: () => {},
  } as any;
}

interface FakeCall { req: any; ctx: any }

/** 注入 fake runAgentTask（ctx.loadRunAgentTask 缝）；返回调用记录。 */
function useFakeRun(
  ctx: TurnContext,
  impl: (req: any, cctx: any) => Promise<any>
): FakeCall[] {
  const calls: FakeCall[] = [];
  ctx.loadRunAgentTask = async () => ({
    runAgentTask: (async (req: any, cctx: any) => {
      calls.push({ req, ctx: cctx });
      return impl(req, cctx);
    }) as any,
  });
  return calls;
}

/** 轮询直到 cond 成立（防测试挂死的有限等待）。 */
async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 构造接线好的 ctx + controller（等价 startSseInteractive 壳内的装配顺序）。 */
function makeHarness(init?: { renderer?: any; bridge?: any }) {
  const session = new Session({ tier: 'high', workspace: tmpWs() });
  TOUCHED_SESSION_IDS.push(session.id);
  const renderer = init?.renderer ?? fakeRenderer();
  const ctx = createTurnContext({ session, renderer });
  if (init?.bridge) ctx.bridgeRef.current = init.bridge;
  ctx.modeRing = createModeRing(ctx);
  const controller = createTurnController(ctx);
  return { session, ctx, renderer, controller };
}

/** 读取 rollout jsonl 的最后一条事件（真实落盘形状断言用）。 */
function readLastRolloutEvent(sessionId: string): any {
  const file = path.join(os.homedir(), '.panshalach', 'rollouts', `${sessionId}.jsonl`);
  assert.ok(fs.existsSync(file), `rollout file must exist: ${file}`);
  const text = fs.readFileSync(file, 'utf-8');
  const rows = text.split('\n').filter((l) => l.trim());
  return JSON.parse(rows[rows.length - 1]);
}

afterEach(() => {
  for (const id of TOUCHED_SESSION_IDS) { try { deleteRollout(id); } catch {} }
  TOUCHED_SESSION_IDS.length = 0;
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  TMP_DIRS.length = 0;
});

// ==================== 1) runTaskViaSse → result → turn 落盘 ====================

describe('M1 行为锁定：runTaskViaSse 全链 turn 落盘', () => {
  it('result(completed)：session.addTurn + rollout appendTurn 落 stopReason 形状，LIVE session 透传', async () => {
    const { session, ctx, controller } = makeHarness();
    const calls = useFakeRun(ctx, async () => ({
      success: true,
      stopReason: 'completed',
      durationMs: 1234,
      budgetReport: { estimatedUsedTokens: 900, usageRatio: 0.12 },
      changedFiles: ['a.txt'],
      verifyCmd: ['npm test'],
    }));

    await controller.runTask('修复 README 错别字');

    // runAgentTask 收到 LIVE session 与原始任务文本
    assert.equal(calls.length, 1);
    assert.equal(calls[0].req.task, '修复 README 错别字');
    assert.equal(calls[0].req.session, session, '必须传 LIVE session（B2 契约）');
    assert.equal(calls[0].req.tier, session.tier);
    assert.equal(calls[0].req.workspace, session.workspace);

    // session.addTurn 的 turn 形状
    const turn: any = session.turns[session.turns.length - 1];
    assert.ok(turn, '完成后必须落一个 turn');
    assert.equal(turn.userInput, '修复 README 错别字');
    assert.equal(turn.userInputType, 'task');
    assert.equal(turn.tier, 'high');
    assert.equal(turn.result.stopReason, 'completed');
    assert.equal(turn.result.success, true);
    assert.equal(turn.result.summary, '已通过验证');
    assert.equal(turn.result.outcome, 'completed', 'mapOutcome(completed) 恒等映射');
    assert.deepEqual(turn.result.changedFiles, ['a.txt']);
    assert.deepEqual(turn.result.verifyCmd, ['npm test']);
    assert.equal('partialText' in turn, false, '非 aborted 回合不携带 partialText');

    // rollout jsonl 最后一行 = { type:'turn', turn }（appendTurn 形状）
    const last = readLastRolloutEvent(session.id);
    assert.equal(last.type, 'turn');
    assert.equal(last.turn.result.stopReason, 'completed');
    assert.equal(last.turn.result.summary, '已通过验证');
    assert.equal(last.turn.userInput, '修复 README 错别字');

    // aborted 未发生 → 排队 drain 不受阻断（lastAborted=false）
    assert.equal(ctx.lastAborted, false);
    // 运行态已复位
    assert.equal(controller.isRunning(), false);
  });

  it('空任务直接早退，不触碰 runAgentTask', async () => {
    const { ctx, controller } = makeHarness();
    const calls = useFakeRun(ctx, async () => ({ success: true, stopReason: 'completed' }));
    await controller.runTask('   ');
    assert.equal(calls.length, 0);
  });
});

// ==================== 2) aborted 路径：partialText turn 落盘 ====================

describe('M1 行为锁定：abort → partialText 落盘', () => {
  it('abort 后 runPromise 以 stopReason=aborted settle，turn 携带 partialText 且阻断 drain', async () => {
    const { session, ctx, controller } = makeHarness();
    const calls = useFakeRun(ctx, (req, cctx) => new Promise((resolve) => {
      const done = () => resolve({
        success: false,
        stopReason: 'aborted',
        durationMs: 5,
        partialText: '已流出的部分正文…',
      });
      if (cctx.signal?.aborted) { done(); return; }
      const iv = setInterval(() => {
        if (cctx.signal?.aborted) { clearInterval(iv); done(); }
      }, 5);
    }));

    const p = controller.runTask('长任务');
    await waitUntil(() => calls.length === 1);
    assert.equal(controller.isRunning(), true, '运行中 currentAbort 非空');

    // 等价 SIGINT 链路：ctx.currentAbort.abort() → loop signal → aborted settle
    ctx.currentAbort!.abort();
    await p;

    const turn: any = session.turns[session.turns.length - 1];
    assert.equal(turn.result.stopReason, 'aborted');
    assert.equal(turn.result.summary, '已中断');
    assert.equal(turn.outcome ?? turn.result.outcome, 'aborted');
    assert.equal(turn.partialText, '已流出的部分正文…', 'aborted 回合必须携带 partialText');

    const last = readLastRolloutEvent(session.id);
    assert.equal(last.type, 'turn');
    assert.equal(last.turn.result.stopReason, 'aborted');
    assert.equal(last.turn.partialText, '已流出的部分正文…');

    // 中断语义：lastAborted=true 会阻断排队任务自动执行
    assert.equal(ctx.lastAborted, true);
  });
});

// ==================== 3) answered 路径：正文流式呈现 / 兜底全文 ====================

describe('M1 行为锁定：answered 正文呈现', () => {
  it('line 模式无流式 → 兜底输出全文（bestTrajectory 末步 result）', async () => {
    const { ctx, renderer, controller } = makeHarness();
    useFakeRun(ctx, async () => ({
      success: true,
      stopReason: 'answered',
      durationMs: 10,
      bestTrajectory: { steps: [{ result: '模型最终回答全文ABC' }] },
    }));

    await controller.runTask('你好');

    assert.ok(
      renderer.lines.includes('模型最终回答全文ABC'),
      `兜底全文必须原样呈现，got: ${JSON.stringify(renderer.lines)}`
    );
  });

  it('line 模式流式部分送达 → 只补差量，防尾部静默丢失且不重复', async () => {
    const { ctx, renderer, controller } = makeHarness();
    useFakeRun(ctx, async (req, cctx) => {
      cctx.onEvent({ type: 'message.delta', text: '模型最终回答' });
      return {
        success: true,
        stopReason: 'answered',
        durationMs: 10,
        bestTrajectory: { steps: [{ result: '模型最终回答全文ABC' }] },
      };
    });

    await controller.runTask('你好');

    assert.ok(
      renderer.lines.includes('全文ABC'),
      `流式已出「模型最终回答」（6 字）→ 兜底只补差量「全文ABC」`
    );
    assert.ok(
      !renderer.lines.includes('模型最终回答全文ABC'),
      '已流式部分不得整段重复输出'
    );
    assert.equal(ctx.lineUi.streamedAnswerChars, '模型最终回答'.length);
  });

  it('rich 模式（fake bridge）→ answered 正文走 pushFeed markdown，流式缓冲复位', async () => {
    const bridge = fakeBridge();
    const { session, ctx, controller } = makeHarness({ bridge });
    useFakeRun(ctx, async (req, cctx) => {
      cctx.onEvent({ type: 'message.start' });
      cctx.onEvent({ type: 'message.delta', text: '流式片段' });
      cctx.onEvent({ type: 'result', stopReason: 'answered', success: true });
      return {
        success: true,
        stopReason: 'answered',
        durationMs: 10,
        bestTrajectory: { steps: [{ result: '模型最终回答全文ABC' }] },
      };
    });

    await controller.runTask('你好', bridge);

    assert.ok(
      bridge.feeds.some((f: any) => f.type === 'markdown' && f.content === '模型最终回答全文ABC'),
      'rich 路径 answered 正文必须以 markdown feed 呈现'
    );
    assert.ok(
      bridge.feeds.some((f: any) => f.type === 'text' && f.text === '已回复' && f.level === 'success'),
      'result 事件四态文案：answered → 已回复(success)'
    );
    assert.deepEqual(bridge.running, [true, false], 'setRunning(true) 提交、result 后复位');
    assert.equal(session.turns[session.turns.length - 1].result.stopReason, 'answered');
  });
});

// ==================== 4) 运行中第二条输入 → queue drain ====================

describe('M1 行为锁定：运行中排队与 drain', () => {
  it('第二条输入入队不并发执行；回合 settle 后 FIFO drain 顺序执行', async () => {
    const { ctx, renderer, controller } = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = useFakeRun(ctx, async () => {
      await gate;
      return { success: true, stopReason: 'completed' };
    });

    const p1 = controller.handleLine('第一条任务');
    await waitUntil(() => calls.length === 1);
    assert.equal(controller.isRunning(), true);

    // 运行中提交第二条 → 入队，不并发
    const p2 = controller.handleLine('第二条任务');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctx.queue.taskCount, 1, '第二条必须排队');
    assert.equal(calls.length, 1, '不得并发执行');
    assert.ok(renderer.lines.some((l) => l.includes('queued ×1：第二条任务')), '排队回执');

    release();
    await p1;
    await p2;

    // drain 自动执行第二条（FIFO、串行）
    await waitUntil(() => calls.length === 2);
    assert.equal(calls[1].req.task, '第二条任务');
    assert.equal(ctx.queue.taskCount, 0);
    assert.ok(renderer.lines.some((l) => l.includes('▶ 执行排队任务：')), 'drain 前有提示行');
  });

  it('运行中 ！插话 → 下一轮（drain 轮）注入任务 prompt 且即刻消费', async () => {
    const { ctx, controller } = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = useFakeRun(ctx, async () => { await gate; return { success: true, stopReason: 'completed' }; });

    const p1 = controller.handleLine('第一轮');
    await waitUntil(() => calls.length === 1);
    await controller.handleLine('!记得检查边界条件');
    assert.equal(ctx.queue.steerCount, 1, '插话进收件箱待注入');

    await controller.handleLine('第二轮');
    assert.equal(ctx.queue.taskCount, 1);

    release();
    await p1;
    await waitUntil(() => calls.length === 2);

    assert.ok(
      calls[1].req.task.startsWith('第二轮'),
      'drain 轮仍以排队任务文本为主体'
    );
    assert.ok(
      calls[1].req.task.includes('【用户插话（运行中收到，必须在本轮考虑）】'),
      '未注入插话拼进本轮 prompt（formatSteerInjection）'
    );
    assert.ok(calls[1].req.task.includes('- 记得检查边界条件'));
    assert.equal(ctx.queue.steerCount, 0, '注入即消费，不可召回');
    // turn 的 userInput 保留原始任务文本（插话剥离）
    const turn = ctx.session.turns[ctx.session.turns.length - 1];
    assert.equal(turn.userInput, '第二轮');
  });

  it('aborted 回合阻断 drain —— 排队项保留给用户手动重跑', async () => {
    const { ctx, controller } = makeHarness();
    const calls = useFakeRun(ctx, (req, cctx) => new Promise((resolve) => {
      const done = () => resolve({ success: false, stopReason: 'aborted', partialText: 'p' });
      if (cctx.signal?.aborted) { done(); return; }
      const iv = setInterval(() => {
        if (cctx.signal?.aborted) { clearInterval(iv); done(); }
      }, 5);
      void req;
    }));

    const p1 = controller.handleLine('会被中断的任务');
    await waitUntil(() => calls.length === 1);
    await controller.handleLine('排队的第二条');
    assert.equal(ctx.queue.taskCount, 1);

    ctx.currentAbort!.abort();
    await p1;
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(calls.length, 1, 'aborted 后不得自动 drain 排队任务');
    assert.equal(ctx.queue.taskCount, 1, '排队项保留');
  });
});

// ==================== 5) 命令路由：/help /mode 未知命令建议 ====================

describe('M1 行为锁定：命令路由', () => {
  it('handleLocalCommand：/help 返回 true 并输出分组帮助；普通文本返回 false', async () => {
    const { ctx, renderer } = makeHarness();
    assert.equal(await handleLocalCommand(ctx, '/help'), true);
    assert.ok(renderer.lines.some((l) => l.includes('可用命令:')), '三处统一走 HelpCommand 分组渲染');
    assert.equal(await handleLocalCommand(ctx, '写一个冒泡排序'), false, '非本地命令 → 交给任务流');
  });

  it('handleLocalCommand：/status 输出传输/上下文/队列行', async () => {
    const { ctx, renderer } = makeHarness();
    assert.equal(await handleLocalCommand(ctx, '/status'), true);
    assert.ok(renderer.lines.some((l) => l.includes('传输: 进程内直连')));
    assert.ok(renderer.lines.some((l) => l.includes('上下文估算: ~0% of 32768 tokens（启发式）')));
    assert.ok(renderer.lines.some((l) => l.includes('队列: 0 个排队任务')));
  });

  it('/mode plan：ModeRing set → session.setPlanMode(true) + 切换回执', async () => {
    const { session, ctx, renderer, controller } = makeHarness();
    await controller.runTask('/mode plan');
    assert.equal(session.planMode, true, '/mode plan 必须落在 plan（set 而非 cycle）');
    assert.equal(session.approvalMode, 'readonly');
    assert.ok(renderer.lines.some((l) => l.includes('已切换: plan') && l.includes('只读计划模式')));
  });

  it('/mode 无参：cycle 推进一格（default → auto-accept）', async () => {
    const { session, controller } = makeHarness();
    await controller.runTask('/mode');
    assert.equal(session.approvalMode, 'full');
    assert.equal(session.planMode, false);
  });

  it('未知命令：line 空闲态置 pendingSuggestion + 建议文案；绝不提交引擎', async () => {
    const { ctx, renderer, controller } = makeHarness();
    const calls = useFakeRun(ctx, async () => ({ success: true, stopReason: 'completed' }));
    await controller.runTask('/modl');
    assert.equal(calls.length, 0, '铁律：斜杠行永不发给引擎');
    assert.equal(ctx.pendingSuggestion, '/mode', '最近命令建议待定（回车确认执行）');
    assert.ok(
      renderer.lines.some((l) => l.includes('未知命令 /modl · 你是不是想要 /mode？（回车确认执行，Esc/其他输入取消）'))
    );
  });

  it('未知命令无法给出建议 → 固定提示文案，pendingSuggestion 不置位', async () => {
    const { ctx, renderer, controller } = makeHarness();
    await controller.runTask('/zzzz');
    assert.equal(ctx.pendingSuggestion, null);
    assert.ok(renderer.lines.some((l) => l.includes('未知命令: /zzzz（输入 /help 查看可用命令；斜杠命令均本地执行）')));
  });

  it('rich 模式未知命令只提示建议，不置 pendingSuggestion', async () => {
    const bridge = fakeBridge();
    const { ctx, controller } = makeHarness({ bridge });
    await controller.runTask('/modl', bridge);
    assert.equal(ctx.pendingSuggestion, null, 'pendingSuggestion 仅 line 空闲态置位');
    assert.ok(
      bridge.feeds.some((f: any) => f.text.includes('你是不是想要 /mode？（输入 /help 查看全部命令）'))
    );
  });
});
