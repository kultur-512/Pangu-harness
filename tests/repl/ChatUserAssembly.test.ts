// tests/repl/ChatUserAssembly.test.ts
// 【1】chat 直答补最近对话原文（2026-09-13 迭代包）：
// chat 直答模型此前看不到最近对话原文——【最近上下文】块只在被 chat 丢弃的
// enriched 里，指代型追问（"那第二个呢"）零上下文硬答。修复：
//  - runAgentTask 侧从 session 组装 ≤600 字符的【最近对话】段（最近 2 轮
//    userInput+answerText，新轮优先保尾部）传入 chaser；
//  - chaser chat user 组装处拼在【记忆块之后、用户原话之前】。
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { runAgentTask, buildChatRecentTurnsBlock } from '../../src/server/runAgentTask.js';
import { Session } from '../../src/cli/repl/Session.js';

const TMP_DIRS: string[] = [];
const tmpWs = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-chat-user-'));
  TMP_DIRS.push(d);
  return d;
};

afterEach(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  TMP_DIRS.length = 0;
});

/** 只带 chat() 通道的假客户端（捕获 messages）。 */
function chatCapturingClient(captured: any[][]): any {
  return {
    async chat(messages: any[]) {
      captured.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return '这是回答。';
    },
    async complete() { return '不应走 complete 回退'; },
  };
}

const MEM = '【相关记忆】\n  - [M1] [对话记忆] Q: 我的车停哪\n    A: B2 泳池旁';
const RECENT = '【最近对话】\n用户：第一个方案是什么\n助手：先做 A 方案';

describe('【1a】chaser chat user 组装：记忆块 + 最近对话 + 用户原话', () => {
  it('三段齐全 → user = 记忆块\\n\\n【最近对话】段\\n\\n用户原话（顺序固定）', async () => {
    const captured: any[][] = [];
    const chaser = new PanshalachChaser(chatCapturingClient(captured), 'standard');
    const r = await chaser.solveIssue('那第二个呢', tmpWs(), {
      tier: 'standard',
      intent: 'chat',
      chatMemoryBlock: MEM,
      chatRecentTurns: RECENT,
    });
    assert.equal(r.success, true);
    assert.equal(captured.length, 1);
    const user = captured[0].find((m) => m.role === 'user');
    assert.equal(user.content, `${MEM}\n\n${RECENT}\n\n那第二个呢`, '记忆块在前、最近对话居中、用户原话收尾');
    assert.ok(captured[0][0].role === 'system', 'system 首消息不变');
  });

  it('只有最近对话段（无记忆块）→ user = 段 + 用户原话', async () => {
    const captured: any[][] = [];
    const chaser = new PanshalachChaser(chatCapturingClient(captured), 'standard');
    await chaser.solveIssue('那第二个呢', tmpWs(), {
      tier: 'standard',
      intent: 'chat',
      chatRecentTurns: RECENT,
    });
    assert.equal(captured[0][1].content, `${RECENT}\n\n那第二个呢`);
  });

  it('只有记忆块（无最近对话段）→ 与 0.8.2 既有格式逐字节一致（回归）', async () => {
    const captured: any[][] = [];
    const chaser = new PanshalachChaser(chatCapturingClient(captured), 'standard');
    await chaser.solveIssue('你好', tmpWs(), {
      tier: 'standard',
      intent: 'chat',
      chatMemoryBlock: MEM,
    });
    assert.equal(captured[0][1].content, `${MEM}\n\n你好`);
  });

  it('两者皆无 → user 恰为用户原话（旧行为不回归）', async () => {
    const captured: any[][] = [];
    const chaser = new PanshalachChaser(chatCapturingClient(captured), 'standard');
    await chaser.solveIssue('你好', tmpWs(), { tier: 'standard', intent: 'chat' });
    assert.equal(captured[0][1].content, '你好');
  });
});

describe('【1b】buildChatRecentTurnsBlock：session 最近 2 轮 → ≤600 字符【最近对话】段', () => {
  const mkTurn = (id: string, userInput: string, answerText?: string): any => ({
    id,
    timestamp: Date.now(),
    userInput,
    userInputType: 'task',
    tier: 'high',
    result: { success: true, summary: 'done', ...(answerText ? { answerText } : {}) },
  });

  it('取最近 2 轮 userInput+answerText，按时间正序渲染', () => {
    const sess = new Session({ tier: 'high' });
    sess.turns.push(mkTurn('t1', '第一个问题', '第一个答案'));
    sess.turns.push(mkTurn('t2', '第二个问题', '第二个答案'));
    const block = buildChatRecentTurnsBlock(sess);
    assert.ok(block.startsWith('【最近对话】\n'), '段头');
    assert.ok(block.includes('用户：第一个问题'), '带用户侧标记');
    assert.ok(block.includes('助手：第一个答案'), '带助手侧标记');
    assert.ok(block.indexOf('第一个问题') < block.indexOf('第二个问题'), '时间正序');
  });

  it('无轮次 → 空串（chat user 不加段）', () => {
    const sess = new Session({ tier: 'high' });
    assert.equal(buildChatRecentTurnsBlock(sess), '');
  });

  it('无 answerText 的轮 → 只渲染用户行', () => {
    const sess = new Session({ tier: 'high' });
    sess.turns.push(mkTurn('t1', '只有输入没有答案'));
    const block = buildChatRecentTurnsBlock(sess);
    assert.ok(block.includes('用户：只有输入没有答案'));
    assert.ok(!block.includes('助手：'), '无答案不渲染空助手行');
  });

  it('长度自限：整段 ≤600 字符；超限时优先保留最新轮（尾部不丢）', () => {
    const sess = new Session({ tier: 'high' });
    sess.turns.push(mkTurn('t1', `旧问题${'x'.repeat(500)}`, `旧答案${'y'.repeat(500)}OLDTAIL`)); // ~1010 字符
    sess.turns.push(mkTurn('t2', '最新的追问内容', '最新的回答内容'));
    const block = buildChatRecentTurnsBlock(sess);
    assert.ok(block.length <= 600, `整段 ≤600，got ${block.length}`);
    assert.ok(block.includes('最新的追问内容'), '最新轮必须完整保留');
    assert.ok(block.includes('最新的回答内容'), '最新轮答案保留');
    assert.ok(!block.includes('OLDTAIL'), '预算耗尽时旧轮截断让位（其尾部不得进入段落）');
  });
});

describe('【1c】runAgentTask 接线：chat 直答的 user 带最近对话段', () => {
  it('chat 意图 + session 有轮 → 假客户端收到的 user 含【最近对话】+ 原话收尾', async () => {
    const ws = tmpWs();
    const prevMemFile = process.env.PANSHA_MEMORY_FILE;
    delete process.env.PANSHA_MEMORY_FILE;
    try {
      const session = new Session({ tier: 'high', workspace: ws });
      session.turns.push({
        id: 't1', timestamp: Date.now(),
        userInput: '第一个方案是什么', userInputType: 'task', tier: 'high',
        result: { success: true, summary: 'done', answerText: '先做 A 方案' },
      } as any);

      const captured: any[][] = [];
      const client = {
        async chat(messages: any[]) {
          captured.push(messages.map((m) => ({ role: m.role, content: m.content })));
          return '第二个是 B 方案。';
        },
        async complete() { return '不应走 complete 回退'; },
      };
      const provider = {
        createClient: () => client,
        createDefaultClient: () => client,
        invalidateProviderCache: () => {},
        listModels: () => [],
        isModelAvailable: () => true,
      };
      const r = await runAgentTask(
        { task: '那第二个呢', session },
        { provider, onEvent: () => {} }
      );
      assert.equal(r.success, true, 'chat 直答成功');
      assert.equal(r.answerText, '第二个是 B 方案。');
      assert.equal(captured.length, 1, 'chat 单次调用');
      const user = captured[0].find((m) => m.role === 'user');
      assert.ok(user.content.includes('【最近对话】'), 'user 必须带最近对话段');
      assert.ok(user.content.includes('用户：第一个方案是什么'), '最近轮原文进入 user');
      assert.ok(user.content.includes('助手：先做 A 方案'), '最近轮答案进入 user');
      assert.ok(user.content.endsWith('那第二个呢'), '用户原话仍收尾');
      assert.ok(
        user.content.indexOf('【最近对话】') < user.content.indexOf('那第二个呢'),
        '最近对话段在用户原话之前'
      );
    } finally {
      if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
      else process.env.PANSHA_MEMORY_FILE = prevMemFile;
    }
  });
});
