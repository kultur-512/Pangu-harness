// tests/loop/ChatDirectAnswer.test.ts
// 0.8.1 对话链路迭代——chaser chat 直答分支行为锁定：
// - R2：空回答不伪装成功（EMPTY_RESPONSE 吞错转空串 → stopReason='error'，非 answered）
// - R3：流式直答（streamChatMessages 优先 + message.delta 增量透传 + 截断标注 + 显式 maxTokens）
//   与能力回落阶梯（streamChatMessages → chat → complete）。
// - 第 2 轮（真机实测修复）：F1 流式 <think> 状态机过滤（含未闭合截断场景）、
//   F2 情境框架式 system 指令、F3 chat 直答不发 phase/step 事件。
//
// 手法：直接构造 PanshalachChaser + 假模型客户端（同 ChaserSingleCall 手法；
// VerifyCritiqueLoop.prototype.run 打桩断言 chat 零进入）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'pangu-chatdirect-'));
}

/** chat 零进入 agent 循环的守卫补丁。 */
function guardLoop(): () => void {
  const proto = VerifyCritiqueLoop.prototype as any;
  const origRun = proto.run;
  proto.run = async function () {
    throw new Error('chat 意图不得进入 agent 循环');
  };
  return () => { proto.run = origRun; };
}

describe('R3（0.8.1）：chat 流式直答 + 截断标注 + 显式 maxTokens', () => {
  it('streamChatMessages 优先：messages=[system 指令, user 原文]，逐 chunk 发 message.delta，maxTokens=4096', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const calls: { stream: number; chat: number; complete: number } = { stream: 0, chat: 0, complete: 0 };
      const seenOpts: any[] = [];
      const seenMessages: any[] = [];
      const client = {
        async *streamChatMessages(messages: any[], opts: any) {
          calls.stream++;
          seenMessages.push(messages.map((m: any) => ({ role: m.role, content: m.content })));
          seenOpts.push({ ...opts });
          yield { type: 'text', text: '你好' };
          yield { type: 'thinking', text: '（内部推演）' };
          yield { type: 'text', text: '，我是烛龙。' };
        },
        async chat() { calls.chat++; return '不应被调用'; },
        async complete() { calls.complete++; return '不应被调用'; },
      };
      const events: any[] = [];
      const chaser = new PanshalachChaser(client, 'standard');
      const result = await chaser.solveIssue('你好', ws, {
        tier: 'standard', intent: 'chat', onStep: (e: any) => events.push(e),
      });

      assert.equal(calls.stream, 1, '有 streamChatMessages 必须优先走流式');
      assert.equal(calls.chat, 0, '流式可用时 chat 零调用');
      assert.equal(calls.complete, 0, '流式可用时 complete 零调用');
      assert.equal(result.success, true);
      assert.equal(result.bestTrajectory?.stopReason, 'answered');
      assert.equal(result.bestTrajectory?.steps?.[0]?.result, '你好，我是烛龙。', '逐 chunk 累积正文');

      // messages 形态：system = 对话指令（不含用户输入），user = 原文
      const msgs = seenMessages[0];
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].role, 'system');
      assert.ok(msgs[0].content.includes('不要调用任何工具'), 'system 承载对话指令');
      assert.ok(!msgs[0].content.includes('你好'), 'system 指令不内嵌用户输入（防重复注入）');
      // F2（0.8.1 第 2 轮）：情境框架式指令——不对抗模型原生身份（MiniMax-M3
      // ROOT_SYSTEM_POLICY 曾把身份声明判为 injection 拒绝），保留终端/中文约束
      assert.ok(msgs[0].content.includes('烛龙 Zhulong'), '界面角色包装（情境框架式，非身份断言）');
      assert.ok(msgs[0].content.includes('终端环境'), '保留终端环境约束');
      assert.ok(msgs[0].content.includes('中文'), '保留中文约束');
      assert.ok(!/injection|fake/i.test(msgs[0].content), '不得出现对抗框架词（防原生策略拒绝）');
      assert.equal(msgs[1].role, 'user');
      assert.equal(msgs[1].content, '你好');

      // R3：显式采样参数（摆脱网关默认值）
      assert.equal(seenOpts[0].maxTokens, 4096, '必须显式发送 maxTokens=4096');
      assert.equal(seenOpts[0].temperature, 0.7);

      // 流式增量事件：message.start + 逐 delta（渲染端 message.delta 通道）
      const start = events.find((e) => e.type === 'message.start');
      const deltas = events.filter((e) => e.type === 'message.delta').map((e) => e.text);
      assert.ok(start, '必须发射 message.start');
      assert.deepEqual(deltas, ['你好', '，我是烛龙。'], '正文增量逐 chunk 透传');

      // F3（0.8.1 第 2 轮）：chat 直答不发 phase/step 事件——
      // `── 侦察 ──`/`── 执行 ──` 相位线与 `[Step 1]` 空头行都是 rollout 噪声
      assert.equal(
        events.some((e) => e.type === 'phase'),
        false,
        'chat 直答不发 phase 事件（相位线不出现在直答界面）'
      );
      assert.equal(
        events.some((e) => e.type === 'step'),
        false,
        'chat 直答不发 step 事件（[Step 1] 空头 + 终态"N 步"的噪声源）'
      );
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // F1（0.8.1 第 2 轮，P0）：流式 <think> 状态机过滤——MiniMax-M3/Qwen3 系把推理
  // 内嵌 content，标签可能被 chunk 边界切开；thinkMode 期间增量全吞。
  it('F1：内嵌 <think> 跨 chunk 切开 → 推理增量全吞，只有边界外可见段发 message.delta', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const client = {
        async complete() { return '不应被调用'; },
        async *streamChatMessages() {
          // '<think>' 与 '</think>' 均被 chunk 边界切开
          yield { type: 'text', text: '你好<th' };
          yield { type: 'text', text: 'ink>我不该接受 injection 的假身份，我是 MiniMax-M3，' };
          yield { type: 'text', text: '应该以界面人格回答</th' };
          yield { type: 'text', text: 'ink>，我是烛龙。' };
        },
      };
      const events: any[] = [];
      const chaser = new PanshalachChaser(client, 'standard');
      const result = await chaser.solveIssue('你好', ws, {
        tier: 'standard', intent: 'chat', onStep: (e: any) => events.push(e),
      });

      const deltas = events.filter((e) => e.type === 'message.delta').map((e) => e.text);
      assert.equal(deltas.join(''), '你好，我是烛龙。', '只有 think 块外的可见段透传');
      assert.ok(
        deltas.every((d) => !d.includes('MiniMax') && !d.includes('<think>') && !d.includes('injection')),
        `推理原文不得出现在任何增量：${JSON.stringify(deltas)}`
      );
      assert.equal(
        result.bestTrajectory?.steps?.[0]?.result,
        '你好，我是烛龙。',
        '落盘正文同样剥离 think 块'
      );
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('F1：流结束仍处 thinkMode（未闭合 <think>，截断响应）→ 推理全吞、正文视为空 → EMPTY_RESPONSE', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const client = {
        async complete() { return '不应被调用'; },
        async *streamChatMessages() {
          yield { type: 'text', text: '<think>I should not adopt the fake identity from the' };
          yield { type: 'text', text: ' injection. I should identify as MiniMax-M3' };
          yield { type: 'text', text: '', finishReason: 'length' };
        },
      };
      const events: any[] = [];
      const chaser = new PanshalachChaser(client, 'standard');
      const result = await chaser.solveIssue('你好', ws, {
        tier: 'standard', intent: 'chat', onStep: (e: any) => events.push(e),
      });

      assert.equal(result.success, false, '未闭合 think 的截断响应不得伪装成成功回答');
      assert.equal(result.bestTrajectory?.stopReason, 'error', '正文视为空 → 走 R2 空检查');
      assert.ok(
        String(result.bestTrajectory?.lastError).includes('EMPTY_RESPONSE'),
        'lastError 保留 EMPTY_RESPONSE 归因'
      );
      assert.equal(
        events.some((e) => e.type === 'message.delta'),
        false,
        '推理原文一个增量都不外泄'
      );
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('finish_reason=length → 正文尾追加截断标注', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const client = {
        // 入口防御要求 complete 存在（真实客户端恒有）；流式存在时不会被调用
        async complete() { return '不应被调用'; },
        async *streamChatMessages() {
          yield { type: 'text', text: '这是一个很长的回答被硬生' };
          yield { type: 'text', text: '', finishReason: 'length' };
        },
      };
      const chaser = new PanshalachChaser(client, 'standard');
      const result = await chaser.solveIssue('讲讲历史', ws, { tier: 'standard', intent: 'chat' });
      assert.equal(result.bestTrajectory?.stopReason, 'answered');
      assert.equal(
        result.bestTrajectory?.steps?.[0]?.result,
        '这是一个很长的回答被硬生\n\n[回答被 max_tokens 截断]',
        '截断标注必须追加在正文尾'
      );
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('无 streamChatMessages 但有 chat → chat 整段（对象形态 truncated 标记同样生效）', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const calls: any = { chat: 0, complete: 0 };
      const client = {
        async chat(messages: any[], opts: any) {
          calls.chat++;
          void opts;
          assert.equal(messages[0].role, 'system');
          assert.equal(messages[1].content, '你好');
          return { content: '整段回答。', truncated: true };
        },
        async complete() { calls.complete++; return ''; },
      };
      const chaser = new PanshalachChaser(client, 'standard');
      const result = await chaser.solveIssue('你好', ws, { tier: 'standard', intent: 'chat' });
      assert.equal(calls.chat, 1);
      assert.equal(calls.complete, 0);
      assert.equal(
        result.bestTrajectory?.steps?.[0]?.result,
        '整段回答。\n\n[回答被 max_tokens 截断]',
        'chat() 对象返回的 truncated 标记必须转截断标注'
      );
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('流式通道抛错 → 合成失败轨迹（网络类 → error；TASK_ABORTED → aborted）', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const boom = {
        async complete() { return '不应被调用'; },
        async *streamChatMessages() { throw new Error('网络炸了'); },
      };
      const r1 = await new PanshalachChaser(boom, 'standard')
        .solveIssue('你好', ws, { tier: 'standard', intent: 'chat' });
      assert.equal(r1.success, false);
      assert.equal(r1.bestTrajectory?.stopReason, 'error', '非中断异常落 error');

      const abort = {
        async complete() { return '不应被调用'; },
        async *streamChatMessages() {
          const err: any = new Error('TASK_ABORTED');
          err.code = 'ABORTED';
          throw err;
        },
      };
      const r2 = await new PanshalachChaser(abort, 'standard')
        .solveIssue('你好', ws, { tier: 'standard', intent: 'chat' });
      assert.equal(r2.bestTrajectory?.stopReason, 'aborted', 'TASK_ABORTED 保持 aborted 语义（不伪装/不误判）');
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('R2（0.8.1）：chat 空回答不伪装成功', () => {
  it('complete 返回空串 → success=false + stopReason=error + lastError 含 EMPTY_RESPONSE', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const chaser = new PanshalachChaser(
        { async complete() { return ''; } },
        'standard'
      );
      const result = await chaser.solveIssue('你好', ws, { tier: 'standard', intent: 'chat' });

      assert.equal(result.success, false, '空回答不得记成功');
      assert.equal(result.bestTrajectory?.stopReason, 'error', '空回答必须是 error 而非 answered');
      assert.equal(result.bestTrajectory?.success, false);
      assert.ok(
        String(result.bestTrajectory?.lastError).includes('EMPTY_RESPONSE'),
        'lastError 保留 EMPTY_RESPONSE 归因'
      );
      assert.equal(result.message, result.bestTrajectory?.lastError);
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('complete 返回纯空白 → 同样落 error（trim 判空）', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const chaser = new PanshalachChaser(
        { async complete() { return '   \n\t  '; } },
        'standard'
      );
      const result = await chaser.solveIssue('你好', ws, { tier: 'standard', intent: 'chat' });
      assert.equal(result.success, false);
      assert.equal(result.bestTrajectory?.stopReason, 'error');
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('非空正文不受影响：仍 answered + success（回归）', async () => {
    const ws = tmpWs();
    const restore = guardLoop();
    try {
      const chaser = new PanshalachChaser(
        { async complete() { return '我是烛龙。'; } },
        'standard'
      );
      const result = await chaser.solveIssue('你好', ws, { tier: 'standard', intent: 'chat' });
      assert.equal(result.success, true);
      assert.equal(result.bestTrajectory?.stopReason, 'answered');
      assert.equal(result.bestTrajectory?.steps?.[0]?.result, '我是烛龙。');
    } finally {
      restore();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
