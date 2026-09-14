// tests/eval/RunCellsSeed.test.ts
// B11（ZL-compact 锚定口径补全）：run-cells.mjs seedCompact 的行收集逻辑抽出的
// 纯函数 collectCompactSeedGroups 单测——
//   - 会话日期提取（## Session N (id, yyyy/MM/dd …) → yyyy-MM-dd）
//   - 行带正确【S·date】前缀且与所属会话对齐（逐会话分组 = recordFactLines
//     可按会话传 sessionDate 的前提）
//   - 跨会话边界：悬空 User 行不得与下一会话首条 Assistant 配对（review 曾揪
//     pendingQ 跨会话漏复位，此处回归钉死现有实现）
//   - 无会话头的行回退 unknown 组（与旧行为一致）
// 导入安全性：run-cells.mjs 顶层以 IS_MAIN 守卫（argv[1] === 本脚本时才
// 解析 --cell 并跑 main），测试 import 不触发 process.exit(2)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectCompactSeedGroups } from '../../scripts/eval/longmemeval-90/run-cells.mjs';

const hay = (lines: string[]): string => lines.join('\n');

describe('B11：collectCompactSeedGroups（seedCompact 逐会话分组）', () => {
  it('两会话各成组：日期提取 + 【S·date】前缀与会话对齐', () => {
    const groups = collectCompactSeedGroups(hay([
      '# Haystack for q1',
      '## Session 1 (answer_aaa, 2023/01/19 (Thu) 05:19)',
      '**User**: What did I plan for the garden?',
      '**Assistant**: You planned tomatoes and basil in raised beds.',
      '**User**: What bike goal did I set?',
      '**Assistant**: You aimed to ride 50 km in March.',
      '## Session 2 (answer_bbb, 2023/05/02 (Tue) 10:00)',
      '**User**: Where does my sister live now?',
      '**Assistant**: Your sister Anna moved to Oslo in April.',
    ]));
    assert.equal(groups.length, 2);
    assert.equal(groups[0].date, '2023-01-19');
    assert.equal(groups[1].date, '2023-05-02');
    assert.equal(groups[0].lines.length, 2, '会话内两对各产一行');
    assert.ok(groups[0].lines[0].startsWith('【S·2023-01-19】Q: What did I plan for the garden?'));
    assert.ok(groups[0].lines[0].includes('A: You planned tomatoes'), 'Q/A 同行配对');
    assert.ok(groups[1].lines[0].startsWith('【S·2023-05-02】Q: Where does my sister live now?'));
  });

  it('跨会话边界：会话 1 末尾悬空 User 不得与会话 2 的 Assistant 配对', () => {
    const groups = collectCompactSeedGroups(hay([
      '## Session 1 (answer_aaa, 2023/01/19 (Thu) 05:19)',
      '**User**: Answered question one?',
      '**Assistant**: Yes, answer one.',
      '**User**: Dangling question with no answer?',
      '## Session 2 (answer_bbb, 2023/05/02 (Tue) 10:00)',
      '**Assistant**: First line of session two.',
    ]));
    assert.equal(groups.length, 2);
    assert.equal(groups[0].lines.length, 1, '悬空 User 无 Assistant 跟随 → 丢弃');
    assert.equal(groups[1].lines.length, 0, '会话 2 首条 Assistant 无待配 User（pendingQ 已复位）→ 不产行');
    const all = groups.flatMap((g) => g.lines).join('\n');
    assert.ok(!all.includes('Dangling question'), '悬空问句不得泄漏进任何会话行');
    assert.ok(!all.includes('First line of session two'), '更不得与下会话 Assistant 跨界配对');
  });

  it('无会话头的行 → unknown 组（旧行为保持）', () => {
    const groups = collectCompactSeedGroups(hay([
      '**User**: early question',
      '**Assistant**: early answer',
    ]));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].date, '');
    assert.deepEqual(groups[0].lines, ['【S·unknown】Q: early question\nA: early answer']);
  });

  it('非会话行/非回合行被忽略；空输入 → []', () => {
    const groups = collectCompactSeedGroups(hay([
      '## Session 1 (answer_aaa, 2023/01/19 (Thu) 05:19)',
      '',
      'Free prose line should be ignored.',
      '**Assistant**: orphan answer ignored.',
    ]));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].lines.length, 0, '无 User 的 Assistant 行不成对');
    assert.deepEqual(collectCompactSeedGroups(''), []);
  });
});
