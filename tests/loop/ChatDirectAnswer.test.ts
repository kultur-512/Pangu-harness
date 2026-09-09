// tests/loop/ChatDirectAnswer.test.ts
// 0.8.1 对话链路迭代——chaser chat 直答分支行为锁定：
// - R2：空回答不伪装成功（EMPTY_RESPONSE 吞错转空串 → stopReason='error'，非 answered）
// - R3：流式直答（streamChatMessages 优先 + message.delta 增量发射 + 截断标注 + 显式 maxTokens）
//   与能力回落阶梯（streamChatMessages → chat → complete）。
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
