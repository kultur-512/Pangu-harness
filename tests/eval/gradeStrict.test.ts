// tests/eval/gradeStrict.test.ts
// grader v2（2026-09-14 ZL vs CC 差距修复 #4）单元测试：
//   (a) 句子子候选切分：gold "30 days. 31 days (including the last day) is also
//       acceptable." 整段一个候选旧永不命中 "30 days had passed"；逐句切出
//       "30 days" 与 "31 days" 两个独立子候选后任一字串命中即过。
//   (b) 短数字 gold 的数字 token 匹配：gold 归一化后为纯数字（"3"/"15"）时改从
//       响应抽取全部数字 token 做相等判断——英文连写（"3 months ago" → 归一化
//       "3months"）里 "3" 不再是孤词、\b 词界永不命中；中文数字两侧是 CJK 反而
//       命中（系统性偏袒）。token 相等同样防御列表编号误命中（gold=3 不命中
//       "13"/"30"/"123"）。
//   (c) 非纯数字短 gold 维持 \b 逻辑；复述豁免与长 gold 子串逻辑不变。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gradeStrict, gradeLenient, goldCandidates, normalize } from '../../scripts/eval/longmemeval-90/grade.mjs';

describe('gradeStrict（grader v2）句子子候选切分', () => {
  it('"30 days. 31 days (including the last day)" 响应 "30 days had passed" → 1', () => {
    const gold = '30 days. 31 days (including the last day) is also acceptable.';
    const q = 'How many days had passed between the Sunday mass and the Ash Wednesday service?';
    assert.equal(gradeStrict(gold, '30 days had passed', q), 1, '拆出 "30 days" 子候选命中');
  });

  it('响应 "31 days had passed"（含末日的等价答案）→ 1', () => {
    const gold = '30 days. 31 days (including the last day) is also acceptable.';
    const q = 'How many days had passed between the Sunday mass and the Ash Wednesday service?';
    assert.equal(gradeStrict(gold, '31 days had passed', q), 1, '拆出 "31 days" 子候选命中');
  });

  it('完全不相关的响应 → 0', () => {
    const gold = '30 days. 31 days (including the last day) is also acceptable.';
    const q = 'How many days had passed?';
    assert.equal(gradeStrict(gold, 'about two months', q), 0, '无子候选命中则判负');
  });
});

describe('gradeStrict（grader v2）短数字 gold 数字 token 匹配', () => {
  it('gold "3" 响应 "3 months ago"（归一化 "3months"）→ 1（旧 \b3\b 永不命中）', () => {
    const q = 'How many months ago did I attend the photography workshop?';
    assert.equal(gradeStrict('3', '3 months ago', q), 1);
  });

  it('gold "15" 响应 "15 weeks"（归一化 "15weeks"）→ 1', () => {
    const q = 'How many weeks had passed?';
    assert.equal(gradeStrict('15', '15 weeks', q), 1);
  });

  it('gold "3" 响应 "30 days had passed" → 0（token 30 ≠ 3，防御列表编号/进位误命中）', () => {
    const q = 'How many days had passed?';
    assert.equal(gradeStrict('3', '30 days had passed', q), 0);
  });

  it('gold "3" 响应 "13 items" → 0（token 13 ≠ 3）', () => {
    const q = 'How many items?';
    assert.equal(gradeStrict('3', '13 items', q), 0);
  });

  it('gold "3" 响应 "we have 3 people"（孤词 3）→ 1（新旧皆过）', () => {
    const q = 'How many people?';
    assert.equal(gradeStrict('3', 'we have 3 people', q), 1);
  });
});

describe('gradeStrict（grader v2）回归：非纯数字短 gold 与长 gold 逻辑不变', () => {
  it('非纯数字短 gold 仍走 \b 词界（gold "OK" 响应 "ok" → 1）', () => {
    assert.equal(gradeStrict('OK', 'ok', 'how are you feeling'), 1);
  });

  it('长 gold 子串匹配不变（gold "fifty dollars" 响应 "fifty dollars total" → 1）', () => {
    assert.equal(gradeStrict('fifty dollars', 'fifty dollars total', 'how much?'), 1);
  });

  it('复述豁免仍生效（gold 是问题原文子串时跳过，防拒答句误判）', () => {
    // gold "days" 出现在问题文本里 → 跳过该候选 → 0（而非靠词界命中）
    assert.equal(gradeStrict('days', 'days', 'how many days had passed'), 0);
  });
});

describe('normalize / goldCandidates / gradeLenient（grader v2 兼容）', () => {
  it('normalize 剥除标点与空白（对照契约不变）', () => {
    assert.equal(normalize('Hello, World! 你好'), 'helloworld你好');
  });

  it('goldCandidates 多候选拆分（括号/or/或）不变', () => {
    const c = goldCandidates('30 days. 31 days (including the last day) is also acceptable.');
    assert.ok(c.length >= 2, '括号拆分出 ≥2 个候选');
  });

  it('gradeLenient 数字回退口径不变', () => {
    assert.equal(gradeLenient('30 days', '30 days had passed'), 1);
    assert.equal(gradeLenient('30 days', 'no numbers here'), 0);
  });
});

describe('grader v2 review 返工回归（词内 or 不拆 / 列表编号不误命中）', () => {
  it('review FAIL-1：词内 or 不拆出碎片候选——"information" 不产 "mation"', () => {
    const c = goldCandidates('Tell me about the information you have.');
    assert.ok(!c.some((x) => x.trim() === 'mation' || x.trim() === 'inf'), `词内 or 不得切出碎片，got ${JSON.stringify(c)}`);
    // 答案含碎片同形串（任意词尾的 "mation"）不得命中——词界拆分后按整句/子句语义判
    assert.equal(gradeStrict('Tell me about the information you have.', 'I have no information about that, so I cannot answer.', ''), 0, '碎片同形不得命中');
    // 词界 or 拆分的真实场景：gold "A or B" 拆成 A/B 两个候选，响应含其一即命中
    assert.equal(gradeStrict('30 days or 31 days', '30 days had passed', ''), 1, '词界 or 拆出 30 days 候选');
    // 词内 or（transportation）不被拆出碎片：gold 含 transportation 的词内 or
    // 时 goldCandidates 不产出 "tation" 类碎片，且子串命中按完整候选算
    const c2 = goldCandidates('transportation options or walking');
    assert.ok(!c2.some((x) => x.trim() === 'tation'), `词内 or 不得切出碎片，got ${JSON.stringify(c2)}`);
    assert.equal(gradeStrict('transportation options or walking', 'transportation options', ''), 1, '词界 or 拆出完整候选命中');
  });

  it('review FAIL-3：列表项编号 token 不误命中（1a8a66a6 防回归：答"5 份订阅"不因 "2." 编号得分）', () => {
    // gold=2；响应是编号清单，其中 "2." 是列表项编号而非答案数字
    assert.equal(gradeStrict('2', 'I currently have 5 subscriptions: 1. The Atlantic 2. National Geographic 3. NYT', ''), 0);
    // 真答案数字仍命中
    assert.equal(gradeStrict('2', 'I subscribed to 2 magazines', ''), 1);
  });

  it('数字 token 排除行首编号但保留正文数字（"3 months" 连写命中）', () => {
    assert.equal(gradeStrict('3', 'it was 3 months ago', ''), 1);
    assert.equal(gradeStrict('3', '3. The third item', ''), 0);
  });
});
