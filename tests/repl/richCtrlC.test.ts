// tests/repl/richCtrlC.test.ts
// rich REPL Ctrl+C 语义锁定（2026-09-16 真机缺陷修复回归）：
// 旧语义"审批挂起 → 仅拒绝一次审批"把 Ctrl+C 吞成单次拒绝（模型立刻再请求
// 审批 → 永远打断不了），且 abort 不 resolve 挂起的 setConfirm → 引擎在审批
// 处 await 永不 settle。新语义：任务运行中 → 中断优先 + 清挂起审批；空闲 →
// 2s 内二次确认退出。
// 手法同 TurnUxAlign：createTurnContext + fake bridge；requestExit 必须 mock
// （默认实现 process.exit(0) 会杀 runner）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/cli/repl/Session.js';
import { createTurnContext, type TurnContext } from '../../src/cli/repl/turn/TurnContext.js';
import { buildRichCtrlCHandler } from '../../src/cli/repl/sseInteractive.js';
import { deleteRollout } from '../../src/cli/repl/rolloutStore.js';

const TMP_DIRS: string[] = [];
const TOUCHED_SESSION_IDS: string[] = [];

function makeHarness() {
  const session = new Session({ tier: 'high', workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ctrlc-')) });
  TMP_DIRS.push(session.workspace!);
  TOUCHED_SESSION_IDS.push(session.id);
  const ctx = createTurnContext({ session });
  const feeds: any[] = [];
  let exited = false;
  ctx.requestExit = () => { exited = true; };
  const bridge: any = {
    pushFeed: (f: any) => feeds.push(f),
    resolveConfirm: (d: string) => { bridge.decisions.push(d); },
    decisions: [] as string[],
    hasPendingConfirm: () => false,
  };
  return { session, ctx, bridge, feeds, getExited: () => exited };
}

afterEach(() => {
  for (const id of TOUCHED_SESSION_IDS) { try { deleteRollout(id); } catch {} }
  TOUCHED_SESSION_IDS.length = 0;
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  TMP_DIRS.length = 0;
});

describe('buildRichCtrlCHandler：rich Ctrl+C 语义', () => {
  it('任务运行中 + rich 审批挂起 → abort 优先且 resolveConfirm(n) 清审批（不再只拒绝一次）', () => {
    const h = makeHarness();
    const controller = new AbortController();
    h.ctx.currentAbort = controller;
    h.bridge.hasPendingConfirm = () => true;

    buildRichCtrlCHandler(h.ctx, h.session, h.bridge)();

    assert.equal(controller.signal.aborted, true, 'abort 必须被调用');
    assert.deepEqual(h.bridge.decisions, ['n'], '挂起的 rich 审批必须被拒绝，让引擎从审批处醒来');
    assert.equal(h.ctx.lineUi.idleCtrlCAt, 0, '不得进入空闲二次确认态');
    assert.equal(h.getExited(), false, '不得退出进程');
    assert.equal(h.feeds.length, 0, '运行中断路径不打空闲提示');
  });

  it('任务运行中、无审批挂起 → 只 abort，不 resolveConfirm', () => {
    const h = makeHarness();
    const controller = new AbortController();
    h.ctx.currentAbort = controller;
    h.bridge.hasPendingConfirm = () => false;

    buildRichCtrlCHandler(h.ctx, h.session, h.bridge)();

    assert.equal(controller.signal.aborted, true, 'abort 必须被调用');
    assert.equal(h.bridge.decisions.length, 0, '无审批挂起不得 resolveConfirm');
    assert.equal(h.getExited(), false);
  });

  it('空闲第一次按 → 提示 + 置 idleCtrlCAt，不退出', () => {
    const h = makeHarness();
    buildRichCtrlCHandler(h.ctx, h.session, h.bridge)();

    assert.ok(h.ctx.lineUi.idleCtrlCAt > 0, '置空闲计时');
    assert.ok(h.feeds.some((f: any) => f.text && f.text.includes('再按一次 Ctrl+C 退出')), '提示文案落 feed');
    assert.equal(h.getExited(), false, '第一次按不退出');
  });

  it('空闲 2s 内第二次按 → 卸载并 requestExit', () => {
    const h = makeHarness();
    h.ctx.lineUi.idleCtrlCAt = Date.now() - 1000;
    buildRichCtrlCHandler(h.ctx, h.session, h.bridge)();

    assert.equal(h.getExited(), true, '二次确认后调用 requestExit');
  });

  it('空闲超过 2s 再按 → 重新计时（不退出）', () => {
    const h = makeHarness();
    h.ctx.lineUi.idleCtrlCAt = Date.now() - 3000;
    buildRichCtrlCHandler(h.ctx, h.session, h.bridge)();

    assert.equal(h.getExited(), false, '超过 2s 窗口不退出');
    assert.ok(h.ctx.lineUi.idleCtrlCAt > Date.now() - 3000, '计时被刷新为本次时间');
  });

  it('bridge 缺 hasPendingConfirm 时不炸（防御路径）', () => {
    const h = makeHarness();
    const controller = new AbortController();
    h.ctx.currentAbort = controller;
    h.bridge.hasPendingConfirm = undefined;
    buildRichCtrlCHandler(h.ctx, h.session, h.bridge)();
    assert.equal(controller.signal.aborted, true);
  });
});
