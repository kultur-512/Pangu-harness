// tests/loop/messagesLoop.test.ts
// 0.8 P2（M1-PROTOCOL）messages 双轨回归：
// - loop messages 栈组装（system 首位 / assistant+tool 交替 / toolCallId 配对 / 截断防御沿用）
// - 双通道选择（chat 存在 → chat；PANSHA_MESSAGES_MODE=off → 文本路径逐字节等价）
// - 三态终止语义 chat 模式回归（completed/answered/no-verification）
// - chaser 接线（stable→system、volatile→首条 user、streamChatMessages 优先）
// - PromptBuilder 三段拆分等价（buildForTask == summary 块 + stable + volatile 拼接；
//   PANSHA_NO_MEMORY=1 零注入契约在 messages 模式下保持）

// 0.8 语义反转后非 TTY 默认真执行；PANSHA_HEADLESS=1 保留为兼容别名（no-op，
// 历史上用于逃出非 TTY mock 门）。chaser 级测试需要真实 engineAdapter
// （toolSchemas 非空 → 原生 FC pairing 断言）；node --test 每文件独立进程，互不影响。
process.env.PANSHA_HEADLESS = '1';

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { PromptBuilder } from '../../src/cli/repl/PromptBuilder.js';
import { Session } from '../../src/cli/repl/Session.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';

// ==================== 环境清理 ====================
const ORIG_MESSAGES_MODE = process.env.PANSHA_MESSAGES_MODE;
const ORIG_NO_MEMORY = process.env.PANSHA_NO_MEMORY;
function restoreEnv(): void {
  if (ORIG_MESSAGES_MODE === undefined) delete process.env.PANSHA_MESSAGES_MODE;
  else process.env.PANSHA_MESSAGES_MODE = ORIG_MESSAGES_MODE;
  if (ORIG_NO_MEMORY === undefined) delete process.env.PANSHA_NO_MEMORY;
  else process.env.PANSHA_NO_MEMORY = ORIG_NO_MEMORY;
}

const TMP_DIRS: string[] = [];
function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-msg-'));
  TMP_DIRS.push(d);
  return d;
}

// ==================== 模型 mock ====================
type ScriptEntry = string | { content?: string; toolCalls?: any[]; detectedFormat?: string; truncated?: boolean };

/** 双能力客户端（chat + complete），按脚本回放；记录 messages 快照与 prompt 序列。 */
function makeChatModel(script: ScriptEntry[]) {
  let i = 0;
  const model: any = {
    calls: { complete: 0, chat: 0 },
    promptsSeen: [] as string[],
    messagesSeen: [] as any[][],
  };
  model.complete = async (prompt: string) => {
    model.calls.complete++;
    model.promptsSeen.push(String(prompt));
    return script[Math.min(i++, script.length - 1)];
  };
  model.chat = async (messages: any[]) => {
    model.calls.chat++;
    model.messagesSeen.push(JSON.parse(JSON.stringify(messages)));
    return script[Math.min(i++, script.length - 1)];
  };
  return model;
}

/** 仅 complete 客户端（0.7.4 形态，无 messages 能力）。 */
function plainModel(script: ScriptEntry[]) {
  let i = 0;
  const model: any = {
    promptsSeen: [] as string[],
  };
  model.complete = async (prompt: string) => {
    model.promptsSeen.push(String(prompt));
    return script[Math.min(i++, script.length - 1)];
  };
  return model;
}

// 工具文本（文本协议规范块）
const BASH_ALL_TESTS = '\n<>\n  <bash><command>echo ALL_TESTS_PASSED</command></bash>\n</>\n';

/** 无 toolSchemas 的 mock 引擎（文本协议降级路径）。 */
const passEngine = {
  async execute(_calls: any[]) { return 'ALL_TESTS_PASSED'; },
};
/** 带 toolSchemas 的 mock 引擎（原生 FC 路径）。 */
const nativeEngine = {
  toolSchemas: () => [{ name: 'bash', description: 'run shell', parameters: { type: 'object', properties: {} } }],
  async execute(_calls: any[]) { return 'ALL_TESTS_PASSED'; },
};

describe('0.8 P2 messages 栈组装（loop 层）', () => {
  afterEach(restoreEnv);

  it('system 首位 + 首条 user = 初始 prompt；逐步注入为独立 user 消息', async () => {
    const model = makeChatModel(['你好。']);
    const loop = new VerifyCritiqueLoop(model, passEngine, {
      practicalMode: true, maxSteps: 3, systemSegment: 'STABLE',
    });
    const out = await loop.run('TASK-INIT');
    assert.equal(out.stopReason, 'answered');
    const first = model.messagesSeen[0];
    assert.equal(first.length, 3);
    assert.deepEqual(first[0], { role: 'system', content: 'STABLE' }, 'system 首位');
    assert.deepEqual(first[1], { role: 'user', content: 'TASK-INIT' }, '首条 user = 初始 prompt');
    assert.equal(first[2].role, 'user');
    assert.ok(first[2].content.includes('执行命令示例'), '首步格式教学作为独立 user 消息注入');
    assert.equal(model.calls.chat, 1);
    assert.equal(model.calls.complete, 0, 'chat 通道下 complete 零调用');
  });

  it('原生 FC：assistant 携带 wire tool_calls（还原网关 id）+ tool 消息 toolCallId 配对 + 交替', async () => {
    const mkRaw = (id: string) => ({ id, type: 'function', function: { name: 'bash', arguments: '{"command":"echo ALL_TESTS_PASSED"}' } });
    const mkCall = (id: string) => ({
      toolName: 'bash',
      params: [{ name: 'command', value: 'echo ALL_TESTS_PASSED' }],
      rawBlock: JSON.stringify(mkRaw(id)),
      format: 'openai-json',
    });
    const model = makeChatModel([
      { content: '我来跑验证', toolCalls: [mkCall('call_gw1')], detectedFormat: 'openai-json' },
      { content: '继续验证', toolCalls: [mkCall('call_gw2')], detectedFormat: 'openai-json' },
      '验证通过。',
    ]);
    const loop = new VerifyCritiqueLoop(model, nativeEngine, { practicalMode: true, maxSteps: 5 });
    const out = await loop.run('TASK');
    assert.equal(out.stopReason, 'completed');
    assert.equal(out.steps.length, 3);

    // 第 3 次 chat 调用快照 = 前两步的完整栈：user,user,assistant,tool,assistant,tool
    const third = model.messagesSeen[2];
    assert.deepEqual(third.map((m: any) => m.role), ['user', 'user', 'assistant', 'tool', 'assistant', 'tool'], 'assistant+tool 交替');
    assert.equal(third[2].content, '我来跑验证');
    assert.equal(third[2].toolCalls[0].id, 'call_gw1', '还原网关原生 id');
    assert.equal(third[2].toolCalls[0].function.name, 'bash');
    assert.equal(third[2].toolCalls[0].function.arguments, '{"command":"echo ALL_TESTS_PASSED"}');
    assert.equal(third[3].role, 'tool');
    assert.equal(third[3].toolCallId, 'call_gw1', 'tool 消息与 assistant tool_calls.id 配对');
    assert.equal(third[3].name, 'bash');
    assert.equal(third[3].content, 'ALL_TESTS_PASSED');
    assert.equal(third[4].toolCalls[0].id, 'call_gw2');
    assert.equal(third[5].role, 'tool');
    assert.equal(third[5].toolCallId, 'call_gw2');
  });

  it('文本协议（无 toolSchemas）：assistant 不带 toolCalls、rawBlock 剥离、tool 消息自增 id', async () => {
    const model = makeChatModel([BASH_ALL_TESTS, '完成。']);
    const loop = new VerifyCritiqueLoop(model, passEngine, { practicalMode: true, maxSteps: 5 });
    const out = await loop.run('TASK');
    assert.equal(out.stopReason, 'completed');
    assert.equal(out.steps.length, 2);

    const second = model.messagesSeen[1];
    assert.deepEqual(second.map((m: any) => m.role), ['user', 'user', 'assistant', 'tool']);
    assert.ok(!('toolCalls' in second[2]) || second[2].toolCalls === undefined, '文本协议 assistant 不携带 toolCalls');
    assert.ok(!second[2].content.includes('<bash>'), 'rawBlock 已从 assistant 正文剥离');
    assert.match(second[3].toolCallId, /^call_\d+$/, '文本协议无原生 id → 自增合成');
    assert.equal(second[3].name, 'bash');
    assert.equal(second[3].content, 'ALL_TESTS_PASSED');
  });

  it('多调用步骤：结果按 --- 分段数匹配时逐 call 切分、toolCallId 逐项配对', async () => {
    const mk = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const model = makeChatModel([
      {
        content: '',
        toolCalls: [
          { toolName: 'read_file', params: [{ name: 'file_path', value: 'a.txt' }], rawBlock: JSON.stringify(mk('call_a', 'read_file', { file_path: 'a.txt' })), format: 'openai-json' },
          { toolName: 'grep', params: [{ name: 'pattern', value: 'x' }], rawBlock: JSON.stringify(mk('call_b', 'grep', { pattern: 'x' })), format: 'openai-json' },
        ],
        detectedFormat: 'openai-json',
      },
      '完成。',
    ]);
    const segEngine = {
      toolSchemas: () => [
        { name: 'read_file', description: '', parameters: {} },
        { name: 'grep', description: '', parameters: {} },
      ],
      async execute(_calls: any[]) { return 'FILE-A\n---\nFILE-B'; },
    };
    const loop = new VerifyCritiqueLoop(model, segEngine, { practicalMode: true, maxSteps: 5 });
    const out = await loop.run('TASK');
    assert.equal(out.stopReason, 'answered', 'FILE-A/FILE-B 无 PASS 尾标 → 无真实验证 → answered');

    const second = model.messagesSeen[1];
    assert.equal(second[3].role, 'tool');
    assert.equal(second[3].toolCallId, 'call_a');
    assert.equal(second[3].content, 'FILE-A');
    assert.equal(second[4].role, 'tool');
    assert.equal(second[4].toolCallId, 'call_b');
    assert.equal(second[4].content, 'FILE-B');
  });

  it('截断防御沿用：truncated 响应不终局，下一步 user 消息携带精简提示', async () => {
    const model = makeChatModel([
      { content: '部分正文', truncated: true },
      '现在完成了。',
    ]);
    const loop = new VerifyCritiqueLoop(model, passEngine, { practicalMode: true, maxSteps: 5 });
    const out = await loop.run('TASK');
    assert.equal(out.stopReason, 'answered');
    assert.equal(out.steps.length, 2, '截断响应不终局，续跑一步');

    const second = model.messagesSeen[1];
    const notice = second.find((m: any) => m.role === 'user' && String(m.content).includes('max_tokens 截断'));
    assert.ok(notice, '下一步 user 消息携带截断续跑提示');
  });
});

describe('0.8 P2 双通道选择与 off 逐字节等价（loop 层）', () => {
  afterEach(restoreEnv);

  it('chat 存在 → chat 通道；PANSHA_MESSAGES_MODE=off → 文本路径', async () => {
    const script: ScriptEntry[] = [BASH_ALL_TESTS, '完成。'];
    const engine = { async execute() { return 'done: ok'; } };

    const a = makeChatModel(script);
    const outA = await new VerifyCritiqueLoop(a, engine, { practicalMode: true, maxSteps: 5 }).run('TASK');
    assert.equal(a.calls.chat, 2, '有 chat → 走 chat 通道');
    assert.equal(a.calls.complete, 0);

    process.env.PANSHA_MESSAGES_MODE = 'off';
    try {
      const b = makeChatModel(script);
      const outB = await new VerifyCritiqueLoop(b, engine, { practicalMode: true, maxSteps: 5 }).run('TASK');
      assert.equal(b.calls.chat, 0);
      assert.equal(b.calls.complete, 2, 'off → 文本路径');

      // 双通道等价：同一脚本模型产出相同 stopReason / 步骤数 / 信号 / 结果 / 落盘形状
      assert.equal(outB.stopReason, outA.stopReason);
      assert.equal(outB.steps.length, outA.steps.length);
      assert.deepEqual(outB.steps.map((s) => s.verificationSignal), outA.steps.map((s) => s.verificationSignal));
      assert.deepEqual(outB.steps.map((s) => s.verificationResult), outA.steps.map((s) => s.verificationResult));
      assert.deepEqual(Object.keys(outB.steps[0]).sort(), Object.keys(outA.steps[0]).sort(), '落盘形状键集合一致');
    } finally {
      restoreEnv();
    }
  });

  it('PANSHA_MESSAGES_MODE=off 与"无 chat 能力客户端"文本路径 prompt 逐字节一致', async () => {
    const script: ScriptEntry[] = [BASH_ALL_TESTS, '完成。'];
    const engine = { async execute() { return 'done: ok'; } };

    process.env.PANSHA_MESSAGES_MODE = 'off';
    try {
      const b = makeChatModel(script);
      await new VerifyCritiqueLoop(b, engine, { practicalMode: true, maxSteps: 5 }).run('TASK');
      const c = plainModel(script);
      await new VerifyCritiqueLoop(c, engine, { practicalMode: true, maxSteps: 5 }).run('TASK');

      assert.deepEqual(b.promptsSeen, c.promptsSeen, 'off 模式 prompt 序列逐字节一致');
      assert.equal(b.promptsSeen.length, 2);
      assert.ok(b.promptsSeen[0].includes('[历史执行记录]'), '文本路径历史回灌结构保持');
    } finally {
      restoreEnv();
    }
  });
});

describe('0.8 P2 三态终止语义 chat 模式回归（loop 层）', () => {
  afterEach(restoreEnv);

  it('completed：PASS 后 end_turn → completed', async () => {
    const model = makeChatModel([BASH_ALL_TESTS, '验证通过，完成。']);
    const loop = new VerifyCritiqueLoop(model, passEngine, { practicalMode: true, maxSteps: 5 });
    const out = await loop.run('TASK');
    assert.equal(out.stopReason, 'completed');
    assert.equal(out.success, true);
  });

  it('answered：有正文 end_turn 1 步即停', async () => {
    const model = makeChatModel(['你好，我是烛龙。']);
    const loop = new VerifyCritiqueLoop(model, passEngine, { practicalMode: true, maxSteps: 5 });
    const out = await loop.run('nihao');
    assert.equal(out.steps.length, 1);
    assert.equal(out.stopReason, 'answered');
    assert.equal(out.success, true);
  });

  it('no-verification：无正文空转 → no-verification', async () => {
    const model = makeChatModel(['<thinking>想一下</thinking><plan>计划</plan>']);
    const loop = new VerifyCritiqueLoop(model, passEngine, { practicalMode: true, maxSteps: 5 });
    const out = await loop.run('empty');
    assert.equal(out.stopReason, 'no-verification');
    assert.equal(out.success, false);
  });
});

describe('0.8 P2 chaser 接线（messages 通道）', () => {
  afterEach(() => {
    restoreEnv();
    for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    TMP_DIRS.length = 0;
  });

  it('stable→system 首消息、volatile→首条 user、streamChatMessages 优先（chat/complete 零调用）', async () => {
    const ws = tmpWs();
    const script: ScriptEntry[] = [BASH_ALL_TESTS, '验证通过。'];
    let i = 0;
    const messagesSeen: any[][] = [];
    const client: any = {
      async complete() { throw new Error('messages 模式不应调用 complete'); },
      async chat() { throw new Error('streamChatMessages 应优先于 chat'); },
      async *streamChatMessages(messages: any[], _opts?: any) {
        messagesSeen.push(JSON.parse(JSON.stringify(messages)));
        const r = script[Math.min(i++, script.length - 1)];
        yield { type: 'text', text: typeof r === 'string' ? r : (r.content ?? '') };
      },
    };

    const chaser = new PanshalachChaser(client, 'standard');
    const res = await chaser.solveIssue('修复 login 页面', ws, {
      tier: 'standard',
      stableSegment: 'STABLE-SEG',
      volatileSegment: 'VOLATILE-SEG：修复 login 页面',
      intent: 'execution',
      approvalMode: 'full',
    });

    assert.equal(res.bestTrajectory?.stopReason, 'completed', 'bash ALL_TESTS_PASSED → PASS → completed');
    assert.ok(messagesSeen.length >= 2, 'loop 走 messages 通道（多次流式调用）');

    const first = messagesSeen[0];
    assert.equal(first[0].role, 'system');
    assert.equal(first[0].content, 'STABLE-SEG', 'stable 段 → system 首消息');
    assert.ok(String(first[1].content).includes('VOLATILE-SEG：修复 login 页面'), '首条 user 携带 volatile（任务文本）');

    const second = messagesSeen[1];
    const aIdx = second.findIndex((m: any) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
    assert.ok(aIdx >= 0, 'assistant 携带 wire tool_calls');
    const tIdx = second.findIndex((m: any) => m.role === 'tool');
    assert.ok(tIdx > aIdx, 'tool 消息在 assistant 之后');
    assert.equal(second[tIdx].toolCallId, second[aIdx].toolCalls[0].id, 'toolCallId 配对');
  });

  it('PANSHA_MESSAGES_MODE=off：chat 能力不启用（文本路径、segments 忽略）', async () => {
    process.env.PANSHA_MESSAGES_MODE = 'off';
    try {
      const ws = tmpWs();
      const prompts: string[] = [];
      let chatCalls = 0;
      const client: any = {
        async complete(p: string) { prompts.push(String(p)); return '完成。'; },
        async chat() { chatCalls++; throw new Error('off 模式不应调用 chat'); },
        async *streamChatMessages() { chatCalls++; throw new Error('off 模式不应调用 streamChatMessages'); },
      };
      const chaser = new PanshalachChaser(client, 'standard');
      const res = await chaser.solveIssue('修复 login 页面', ws, {
        tier: 'standard',
        stableSegment: 'STABLE-SEG',
        volatileSegment: 'VOLATILE-SEG',
        intent: 'execution',
      });
      assert.equal(chatCalls, 0, 'off 模式零 messages 调用');
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0].includes('修复 login 页面'), 'off 模式任务文本走 issueDescription');
      assert.ok(!prompts[0].includes('STABLE-SEG'), 'off 模式 segments 不进入 prompt');
      assert.equal(res.bestTrajectory?.stopReason, 'answered');
    } finally {
      restoreEnv();
    }
  });
});

describe('0.8 P2 PromptBuilder 三段拆分', () => {
  afterEach(() => {
    restoreEnv();
    for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    TMP_DIRS.length = 0;
  });

  it('buildForTask == summary 块 + stable + \\n + volatile（拼接关系）', async () => {
    const ws = tmpWs();
    const mk = () => new PromptBuilder(new Session({ tier: 'high', workspace: ws }), TierRegistry.get('high'));

    const full = await mk().buildForTask('修复 login 并跑测试');
    const pb = mk();
    const stable = pb.buildStableSegment();
    const volatile = await pb.buildVolatileSegment('修复 login 并跑测试');

    const idx = full.indexOf(stable);
    assert.ok(idx >= 0, 'buildForTask 产物包含 stable 段');
    assert.ok(!full.slice(0, idx).includes('<injection_summary>'), '调试块不进模型 prompt（0.8.1 红队修复）');
    assert.equal(full.slice(idx), stable + '\n' + volatile, '拼接关系：stable + \\n + volatile（压缩恒等时）');
  });

  it('stable 任务间字节级相同；volatile 随任务变化', async () => {
    const ws = tmpWs();
    const pb = new PromptBuilder(new Session({ tier: 'high', workspace: ws }), TierRegistry.get('high'));

    const s1 = pb.buildStableSegment();
    const v1 = await pb.buildVolatileSegment('任务A 修复加法');
    const s2 = pb.buildStableSegment();
    const v2 = await pb.buildVolatileSegment('任务B 重构登录');

    assert.equal(s1, s2, 'stable 任务间字节级相同');
    assert.notEqual(v1, v2);
    assert.ok(v1.includes('任务A 修复加法'));
    assert.ok(v2.includes('任务B 重构登录'));
    assert.ok(!s1.includes('任务A 修复加法'), 'stable 不含任务文本');
    assert.ok(!s1.includes('【相关记忆】'), 'stable 不含记忆卡');
  });

  it('intent=chat：stable/volatile 跳过重工程块（F7 语义保持）', async () => {
    const ws = tmpWs();
    const pb = new PromptBuilder(new Session({ tier: 'high', workspace: ws }), TierRegistry.get('high'));

    const s = pb.buildStableSegment('chat');
    assert.ok(!s.includes('【硬约束】'), 'chat 跳过 L0 硬约束');
    assert.ok(!s.includes('档位契约'), 'chat 跳过档位契约');
    assert.ok(!s.includes('<negative_tool_list>'), 'chat 跳过 negative tool list');
    // R4（0.8.1）：tier XML 属工具纪律契约，chat 同样跳过（消除与"不要调用任何
    // 工具"指令的同框矛盾）；身份行保留。
    assert.ok(!s.includes('<tier_constraint'), 'R4：chat 跳过 tier_constraint XML');
    assert.ok(s.includes('当前档位: high'), '身份行保留');

    const v = await pb.buildVolatileSegment('你好', 'chat');
    assert.ok(!v.includes('项目验证命令'), 'chat 跳过项目验证块');

    const full = await pb.buildForTask('你好', 'chat');
    assert.ok(!full.includes('<negative_tool_list>'));
    assert.ok(full.includes('你好'));
  });

  it('PANSHA_NO_MEMORY=1：stable/volatile/buildForTask 均零记忆注入（messages 模式契约）', async () => {
    process.env.PANSHA_NO_MEMORY = '1';
    try {
      const ws = tmpWs();
      const pb = new PromptBuilder(new Session({ tier: 'high', workspace: ws }), TierRegistry.get('high'));
      const s = pb.buildStableSegment();
      const v = await pb.buildVolatileSegment('任务X');
      assert.ok(!s.includes('相关记忆'), 'stable 零记忆');
      assert.ok(!v.includes('相关记忆'), 'volatile 零记忆');
      const full = await pb.buildForTask('任务X');
      assert.ok(!full.includes('【相关记忆】'), 'buildForTask 零记忆');
    } finally {
      restoreEnv();
    }
  });
});
