// 对话事实记忆（0.8.2 → 2026-09-13 写路径"宽进严排"改造）：
// 对卡无条件落卡（source='dialogue-pair'）/ 去重 / 噪音不再整轮拒收
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordChatFact } from '../../src/memory/chatFactMemory.js';

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lme-chatfact-'));
}

describe('recordChatFact', () => {
  let ws: string;
  beforeEach(() => { ws = tmpWs(); });

  it('正常对话 → 对卡 1 张 + 句级补充卡（宽进严排）', async () => {
    const r = await recordChatFact(ws, '我今天买了一辆红色的特斯拉', '好的，已记录你的新车信息');
    assert.equal(r.recorded, true);
    const file = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach-memory.json'), 'utf8'));
    // 对卡（无条件）+ user/assistant 高置信句级补充卡
    const pair = file.cards.filter((c: any) => c.source === 'dialogue-pair');
    assert.equal(pair.length, 1, '每轮恰 1 张对卡');
    assert.equal(pair[0].kind, 'preference', 'kind 沿用 preference（容量桶语义不变）');
    assert.equal(typeof pair[0].confidence, 'number', '对卡带分类器置信度');
    for (const c of file.cards) {
      assert.equal(c.kind, 'preference');
      assert.equal(c.memoryCategory, 'insight', 'insight 才在 high 档可见');
    }
    assert.ok(file.cards.some((c: any) => c.summary.includes('特斯拉')));
  });

  it('短输入 / 问候噪音 → 只落对卡（噪音不再整轮拒收，质量后移到检索端软惩罚）', async () => {
    const r1 = await recordChatFact(ws, '1', '答');
    assert.equal(r1.recorded, true, '过短轮也落对卡（宽进）');
    const f1 = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach-memory.json'), 'utf8'));
    assert.equal(f1.cards.length, 1, '且仅对卡 1 张（碎片被写入侧拦住，无句级卡）');
    assert.equal(f1.cards[0].source, 'dialogue-pair');

    const ws2 = tmpWs();
    const r2 = await recordChatFact(ws2, '你好', '你好！');
    assert.equal(r2.recorded, true, '问候轮也落对卡');
    const f2 = JSON.parse(fs.readFileSync(path.join(ws2, '.panshalach-memory.json'), 'utf8'));
    assert.equal(f2.cards.length, 1, '且仅对卡 1 张');
    fs.rmSync(ws2, { recursive: true, force: true });
  });

  it('重复内容 → 去重不落卡', async () => {
    await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
    const r2 = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
    assert.equal(r2.recorded, false, 'duplicate');
    assert.equal(r2.reason, 'duplicate');
  });

  it('PANSHA_CHAT_MEMORY=0 → 功能关闭', async () => {
    process.env.PANSHA_CHAT_MEMORY = '0';
    try {
      const r = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
      assert.equal(r.reason, 'disabled');
    } finally {
      delete process.env.PANSHA_CHAT_MEMORY;
    }
  });
});

describe('recordChatFact 拒绝性回答过滤（2026-09-16 NO_TOOL_CALLS 学舌循环修复）', () => {
  let ws: string;
  beforeEach(() => { ws = tmpWs(); });

  it('自我指涉拒绝回答 → 整轮不入卡（斩断学舌源）', async () => {
    const r = await recordChatFact(ws, '这些文件都是用来做什么的',
      '抱歉，我这边其实并没有看到任何文件内容——上一轮只是输出了 NO_TOOL_CALLS，并没有真正列出工作区里的文件列表。');
    assert.equal(r.recorded, false);
    assert.equal(r.reason, 'refusal');
    assert.equal(fs.existsSync(path.join(ws, '.panshalach-memory.json')), false, '拒绝轮不产任何卡（不写盘）');
  });

  it('拒绝 + 引导列表编号（1. 贴给我 / 2. 告诉我）仍判定拒绝', async () => {
    const r = await recordChatFact(ws, '看看工作区',
      '抱歉，我这边看不到你的目录。你可以： 1. 直接把文件内容贴给我； 2. 告诉我文件名列表。');
    assert.equal(r.recorded, false);
    assert.equal(r.reason, 'refusal', '列表编号不得击穿无数字豁免判据');
  });

  it('带实质日期/数字的"抱歉"类回答放行（误伤防护）', async () => {
    const r = await recordChatFact(ws, '会议是几点',
      '抱歉我无法参加现场会议，但线上会议定在 2026 年 9 月 20 日 14:00。');
    assert.equal(r.recorded, true, '含事实数字的道歉回答仍是有效事实');
  });

  it('普通能力说明（非自我拒绝）照常入卡', async () => {
    const r = await recordChatFact(ws, '你能做什么', '我可以读写文件、执行命令、回答知识问答。');
    assert.equal(r.recorded, true);
  });
});
