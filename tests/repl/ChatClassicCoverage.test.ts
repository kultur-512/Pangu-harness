// tests/repl/ChatClassicCoverage.test.ts
// B11：classic REPL 与 complete-only 回退的记忆覆盖缺口补齐。
//  - complete-only 客户端（只有 complete()，无 chat/streamChatMessages）在 chat
//    意图下此前零记忆零上下文——现在 basePrompt 内联 记忆块 + 【最近对话】段；
//  - messages 通道（chat/streamChatMessages）行为不变（仍走独立 user 组装，
//    见 ChatUserAssembly.test.ts）。
//
// 写法沿用仓库惯例（tests/repl/ChatUserAssembly.test.ts）：临时目录 + afterEach 清理。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';

const TMP_DIRS: string[] = [];
const tmpWs = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-chat-classic-'));
  TMP_DIRS.push(d);
  return d;
};

afterEach(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  TMP_DIRS.length = 0;
});

/** 只有 complete() 的假客户端（无 chat / 无 streamChatMessages）——捕获 prompt。 */
function completeOnlyClient(captured: string[]): any {
  return {
    async complete(prompt: string) {
      captured.push(prompt);
      return '这是回答。';
    },
  };
}

const MEM = '【相关记忆】\n  - [M1] [对话记忆] Q: 我的车停哪\n    A: B2 泳池旁';
const RECENT = '【最近对话】\n用户：第一个方案是什么\n助手：先做 A 方案';

describe('B11：complete-only 回退通道的 chat 记忆覆盖', () => {
  it('basePrompt 同时含记忆块与最近对话段（此前两者皆缺）', async () => {
    const captured: string[] = [];
    const chaser = new PanshalachChaser(completeOnlyClient(captured), 'standard');
    const r = await chaser.solveIssue('那第二个呢', tmpWs(), {
      tier: 'standard',
      intent: 'chat',
      chatMemoryBlock: MEM,
      chatRecentTurns: RECENT,
    });
    assert.equal(r.success, true, 'complete-only 客户端应答成功');
    assert.equal(captured.length, 1, '走且仅走一次 complete');
    assert.ok(captured[0].includes(MEM), 'basePrompt 必须带记忆块');
    assert.ok(captured[0].includes(RECENT), 'basePrompt 必须带【最近对话】段');
    assert.ok(captured[0].includes('那第二个呢'), 'basePrompt 必须带用户原话');
  });

  it('顺序固定：记忆块 → 最近对话 → 用户原话', async () => {
    const captured: string[] = [];
    const chaser = new PanshalachChaser(completeOnlyClient(captured), 'standard');
    await chaser.solveIssue('追问原话', tmpWs(), {
      tier: 'standard',
      intent: 'chat',
      chatMemoryBlock: MEM,
      chatRecentTurns: RECENT,
    });
    const p = captured[0];
    const iMem = p.indexOf(MEM);
    const iRecent = p.indexOf(RECENT);
    const iIssue = p.lastIndexOf('追问原话');
    assert.ok(
      iMem >= 0 && iRecent > iMem && iIssue > iRecent,
      `顺序应为 记忆块 → 最近对话 → 用户原话（实际 ${iMem}/${iRecent}/${iIssue}）`
    );
  });

  it('无记忆块 / 无最近对话段时不注入空块头（向后兼容）', async () => {
    const captured: string[] = [];
    const chaser = new PanshalachChaser(completeOnlyClient(captured), 'standard');
    await chaser.solveIssue('你好', tmpWs(), { tier: 'standard', intent: 'chat' });
    assert.ok(!captured[0].includes('【相关记忆】'), '无记忆块时不得出现【相关记忆】段头');
    assert.ok(!captured[0].includes('【最近对话】'), '无最近对话时不得出现段头');
    assert.ok(captured[0].includes('你好'), '用户原话仍在');
  });
});
