// tests/integration/realEngineLoop.test.ts
// 0.7.3 T1#2/T1#3（docs/panshalach/USABLE-PLAN-0.7.3.md）：集成测试去 mock 回环。
//
// 红队 P0/A2：completed 在真机不可达 → 记忆闭环（finalizeTaskMemory）是死码，
// 因为唯一 PASS 产出方是 smoke mock。本文件用【真实 engineAdapter】（真实
// describeResult 形状 + 真实写盘）+ 脚本模型输出（文本协议）驱动全链：
//
//   write_file 调用 → 引擎真实写盘并返回含 `VERIFICATION: PASS` 的结果
//   → classifySignal=PASS → end_turn → stopReason='completed'
//   → finalizeTaskMemory 链产卡（memory.finalized 事件 + 记忆文件 success 卡）
//
// 另含 T1#2 三入口透传的 RunCommand 级断言（approvalMode/sessionAllowlist/
// approvalBridge/signal 必须从 CommandContext 抵达 solveIssue）。

process.env.PANSHA_HEADLESS = '1'; // 0.8 起为兼容别名（非 TTY 默认真执行）；node --test 每文件独立进程，互不影响

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentTask } from '../../src/server/runAgentTask.js';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { Session } from '../../src/cli/repl/Session.js';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import RunCommand from '../../src/cli/repl/commands/RunCommand.js';
import type { CommandContext } from '../../src/cli/repl/types.js';

const TMP_DIRS: string[] = [];
function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-073-'));
  TMP_DIRS.push(d);
  return d;
}

/** 脚本模型：按调用次序回放文本协议输出（无 streamChat → chaser 回退 plain complete）。 */
function scriptedProvider(responses: string[]): any {
  let i = 0;
  const client = {
    complete: async (_p: string) => responses[Math.min(i++, responses.length - 1)],
  };
  return {
    createClient: () => client,
    createDefaultClient: () => client,
    invalidateProviderCache: () => {},
    listModels: () => [],
    isModelAvailable: () => true,
  };
}

describe('0.7.3 真实引擎 completed 闭环（T1#3）', () => {
  afterEach(() => {
    for (const d of TMP_DIRS) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    TMP_DIRS.length = 0;
  });

  it('write_file + bash 真实验证（bash 尾标 VERIFICATION: PASS）→ completed + finalizeTaskMemory 产卡 + 文件落盘', async () => {
    const ws = tmpWs();
    const events: any[] = [];
    const r = await runAgentTask(
      {
        task: '在 hello.txt 写入一行文本 pong，然后读取验证',
        tier: 'standard',
        workspace: ws,
      },
      {
        provider: scriptedProvider([
          // 第 1 步：文本协议 write_file 调用（引擎真实写盘，尾标 APPLIED=PARTIAL——
          // 评审 P1-2：写盘成功 ≠ 验证通过）
          '\n<>\n  <write_file>\n    <file_path>hello.txt</file_path>\n    <content>pong</content>\n  </write_file>\n</>\n',
          // 第 2 步：bash cat 验证（引擎真实执行，EXIT_CODE:0 + VERIFICATION: PASS）
          '\n<>\n  <bash>\n    <command>cat hello.txt</command>\n  </bash>\n</>\n',
          // 第 3 步：end_turn 有正文 → answered → 有真实验证 PASS → upgraded completed
          'hello.txt 已写入 pong，cat 读回确认内容正确，任务完成。',
        ]),
        onEvent: (e) => events.push(e),
        approvalMode: 'full',
      }
    );

    assert.equal(r.success, true, '真实成功信号 → success');
    assert.equal(r.stopReason, 'completed', 'completed 在真实引擎形状下可达（A2 修复）');

    // 真实写盘确证（非 mock：mock 引擎不落盘）
    assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf-8'), 'pong', '引擎真实写盘');

    // 记忆闭环激活：completed → refine→save 产卡。
    // 语义更新（2026-09-11 S 级记忆缺陷修复）：本任务首步"未读先写"，引擎判
    // readBeforeWriteViolation → 按新规则不再产"已验证可行的做法"成功卡，改产
    // RBW 失败教训卡；且写集提取器修复后 referencedFiles 不再恒空（引用落在卡上，
    // 引用过滤与 markVerified 才有交集可判）。
    const file = new RefinedMemoryStore(ws).load();
    assert.ok(file.cards.length >= 1, `completed 任务必须自动产卡，实际 ${file.cards.length} 张`);
    const rbw = file.cards.find((c) => c.category === 'READ_BEFORE_WRITE_VIOLATION');
    assert.ok(rbw, 'RBW 违规 → 失败教训卡');
    assert.deepEqual((rbw as any)?.referencedFiles, ['hello.txt'], '写集提取修复：引用落在卡上');
    assert.ok(!file.cards.some((c) => String(c.summary || '').startsWith('已验证可行的做法')),
      'RBW 违规任务不得产成功卡');

    const ev = events.find((e) => e.type === 'memory.finalized');
    assert.ok(ev, '必须发出 memory.finalized 事件');
    assert.ok(ev.cards >= 1, '事件携带产卡数');
  });

  it('readonly 审批档位下同一任务：写被拒（TOOL_ERROR，无 PASS 尾标）→ 不 completed 不产卡', async () => {
    const ws = tmpWs();
    const events: any[] = [];
    const r = await runAgentTask(
      {
        task: '在 hello.txt 写入一行文本 pong，然后读取验证',
        tier: 'standard',
        workspace: ws,
      },
      {
        provider: scriptedProvider([
          '\n<>\n  <write_file>\n    <file_path>hello.txt</file_path>\n    <content>pong</content>\n  </write_file>\n</>\n',
          '已写入。',
        ]),
        onEvent: (e) => events.push(e),
        // 不传 approvalMode → runAgentTask 默认 readonly（安全底线）
      }
    );
    assert.notEqual(r.stopReason, 'completed', '被拒的写不产生 PASS → 不 completed');
    assert.equal(fs.existsSync(path.join(ws, 'hello.txt')), false, 'readonly 下文件不得落盘');
    const file = new RefinedMemoryStore(ws).load();
    assert.equal(file.cards.length, 0, '非 completed 不产卡');
  });
});

describe('0.7.3 T2#4 中断现场落盘（runAgentTask 链）', () => {
  afterEach(() => {
    for (const d of TMP_DIRS) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    TMP_DIRS.length = 0;
  });

  it('abort 于模型调用后：RunResult 与 result 事件均携带 partialText（宿主可落 aborted turn）', async () => {
    const controller = new AbortController();
    const ws = tmpWs();
    const events: any[] = [];
    let calls = 0;
    const partialBody = '我已经分析了文件，接下来写入修复。';
    const client = {
      complete: async (_p: string) => {
        if (++calls === 1) {
          controller.abort(); // 模拟 Ctrl+C 竞态：正文+工具块刚返回即中止
          return partialBody + '\n<>\n  <write_file>\n    <file_path>hello.txt</file_path>\n    <content>pong</content>\n  </write_file>\n</>\n';
        }
        return '不应到达';
      },
    };
    const provider = {
      createClient: () => client,
      createDefaultClient: () => client,
      invalidateProviderCache: () => {},
      listModels: () => [],
      isModelAvailable: () => true,
    };
    const r = await runAgentTask(
      { task: '在 hello.txt 写入 pong', tier: 'standard', workspace: ws },
      { provider, onEvent: (e) => events.push(e), signal: controller.signal, approvalMode: 'full' }
    );

    assert.equal(r.stopReason, 'aborted');
    assert.equal(r.partialText, partialBody, 'RunResult 必须携带已流出正文');
    assert.equal(fs.existsSync(path.join(ws, 'hello.txt')), false, 'abort 后工具不执行');

    const resultEv = events.find((e) => e.type === 'result');
    assert.ok(resultEv, 'result 事件必须发出');
    assert.equal(resultEv.partialText, partialBody, 'result 事件携带 partialText（sseInteractive 据此落 turn）');
  });
});

describe('0.7.3 T1#2 RunCommand 三入口透传', () => {
  afterEach(() => {
    for (const d of TMP_DIRS) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    TMP_DIRS.length = 0;
  });

  it('RunCommand 把 session 审批态 + ctx.approvalBridge/signal 原样透传给 solveIssue', async () => {
    // 捕获 solveIssue config（原型补丁——node --test + tsx 下最稳的打桩层级）
    const orig = PanshalachChaser.prototype.solveIssue;
    let captured: any = null;
    (PanshalachChaser.prototype as any).solveIssue = async function (
      _issue: string, _ws: string, config: any = {}
    ) {
      captured = config;
      return { success: true, bestTrajectory: { stopReason: 'answered' }, budgetReport: { estimatedUsedTokens: 0 } };
    };
    const ws = tmpWs();
    try {
      const session = new Session({ workspace: ws, tier: 'standard' });
      session.approvalMode = 'default';
      session.sessionApprovalAllowlist.add('write_file');
      const bridge = async (req: any) => 'y:' + req.tool;
      const controller = new AbortController();
      const fakeRenderer: any = {
        write: () => {}, writeLine: () => {}, color: (t: string) => t,
        startSpinner: () => ({ stop() {}, text() {} }),
        table() {}, codeBlock() {}, error() {}, warn() {}, success() {}, info() {}, clearScreen() {}, stream() {},
      };
      const ctx: CommandContext = {
        session: session as any,
        registry: {} as any,
        renderer: fakeRenderer,
        input: { read: async () => '', pause() {}, resume() {}, close() {}, on() {}, history: [] } as any,
        repl: null,
        provider: scriptedProvider([]),
        approvalBridge: bridge,
        signal: controller.signal,
      };
      await RunCommand.execute(ctx, ['在 hello.txt 写入 pong']);

      assert.ok(captured, 'solveIssue 必须被调用');
      assert.equal(captured.approvalMode, 'default', 'approvalMode 从 session 透传');
      assert.ok(captured.sessionAllowlist instanceof Set && captured.sessionAllowlist.has('write_file'),
        'sessionAllowlist 从 session 透传');
      assert.equal(captured.approvalBridge, bridge, 'approvalBridge 从 CommandContext 透传');
      assert.equal(captured.signal, controller.signal, 'signal 从 CommandContext 透传');
    } finally {
      PanshalachChaser.prototype.solveIssue = orig;
    }
  });
});
