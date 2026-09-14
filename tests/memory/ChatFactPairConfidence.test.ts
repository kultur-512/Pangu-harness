// tests/memory/ChatFactPairConfidence.test.ts
// 【5】对卡 confidence A 侧主导（2026-09-13 迭代包）：
// 旧实现 confidence = 轮内两侧各句分类器的全局 max——Q 侧一个数字就把纯客套
// A 拉满 1.0，检索端 (0.5+0.5×confidence) 软惩罚几乎永不生效。
// 新公式：confidence = 0.7×max(A 侧各句) + 0.3×max(Q 侧各句)
//（A 行是注入载荷主体、事实由回答承载；Q 侧 0.3 保留提问相关性、防答非所问）。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordConversationTurn } from '../../src/memory/chatFactMemory.js';

let ws = '';
const prevMemFile = process.env.PANSHA_MEMORY_FILE;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-pair-conf-'));
  delete process.env.PANSHA_MEMORY_FILE;
});
afterEach(() => {
  if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
  else process.env.PANSHA_MEMORY_FILE = prevMemFile;
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

async function pairConfidenceOf(userInput: string, answer: string): Promise<number> {
  const r = await recordConversationTurn(ws, userInput, answer);
  assert.ok((r.cardIds?.length ?? 0) > 0, '对卡必须落盘');
  const file = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach-memory.json'), 'utf8'));
  const pair = file.cards.find((c: any) => c.source === 'dialogue-pair');
  assert.ok(pair, '对卡在盘上');
  assert.equal(typeof pair.confidence, 'number', '对卡携带 confidence 字段');
  return pair.confidence as number;
}

describe('【5】对卡 confidence：0.7×max(A 侧各句) + 0.3×max(Q 侧各句)', () => {
  // 耦合申报（审查建议-3）：下方 0.58/0.82 为公式精确锁定，数值耦合 confidenceOf
  // 的内部分档（基线 0.4 / 数字 1.0）——纯调分档（不动复合公式）会打红，届时按
  // 新分档更新期望值即可；边界式断言（<0.8 / >0.75）承载主判别。
  it('Q 含数字 + A 纯客套 → confidence < 0.8（旧全局 max 恒 1.0——红→绿）', async () => {
    const conf = await pairConfidenceOf('My gate code is 4821', 'ok thanks');
    assert.ok(conf < 0.8, `客套 A 不得被 Q 侧数字拉满，got ${conf}`);
    // 精确锁定公式：A 侧 0.4（无数字/无 CJK/无第一人称）×0.7 + Q 侧 1.0（数字）×0.3
    assert.ok(Math.abs(conf - 0.58) < 1e-9, `0.7*0.4 + 0.3*1.0 = 0.58, got ${conf}`);
  });

  it('A 携带事实（数字）+ Q 客套 → confidence 由 A 主导（≥0.75），事实轮不被压低', async () => {
    const conf = await pairConfidenceOf('hey there', 'Your package ships on March 3.');
    assert.ok(conf > 0.75, `A 主导权重下事实轮应在 0.75 以上，got ${conf}`);
    assert.ok(Math.abs(conf - 0.82) < 1e-9, `0.7*1.0 + 0.3*0.4 = 0.82, got ${conf}`);
  });

  it('两侧都含事实（数字）→ 仍 1.0（与旧全局 max 等价，高质量轮零回退）', async () => {
    const conf = await pairConfidenceOf('flight UA 204 landing time', 'It lands at 9:40 pm.');
    assert.ok(Math.abs(conf - 1.0) < 1e-9, `0.7*1.0 + 0.3*1.0 = 1.0, got ${conf}`);
  });
});
