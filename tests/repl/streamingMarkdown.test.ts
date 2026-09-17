// tests/repl/streamingMarkdown.test.ts
// P1.3: frozen-blocks scanner — block settling on blank lines, fence handling,
// partial-line retention across deltas, and chunk-boundary independence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamScanState, feedStreamDelta, getStreamParts } from '../../src/cli/repl/ui/streamingMarkdown.js';
import { flushBufferedMarkdown, planBlockSummary, foldClosedPlanBlocks, planHoldbackIndex } from '../../src/cli/repl/turn/TurnRenderer.js';

describe('streamingMarkdown scanner', () => {
  it('settles blocks on blank lines outside fences', () => {
    const s = createStreamScanState();
    feedStreamDelta(s, '# 标题\n\n第一段。\n\n第二段。');
    const { blocks, tail } = getStreamParts(s);

    assert.deepEqual(blocks.map(b => b.trim()), ['# 标题', '第一段。']);
    // Trailing text without a following blank line stays in-flight
    assert.equal(tail.trim(), '第二段。');
  });

  it('keeps fence content together and ignores blank lines inside fences', () => {
    const s = createStreamScanState();
    feedStreamDelta(s, '说明：\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n之后的话。');
    const { blocks, tail } = getStreamParts(s);

    assert.equal(blocks.length, 2);
    assert.ok(blocks[1].includes('```ts'));
    assert.ok(blocks[1].includes('const a = 1;'));
    assert.ok(blocks[1].includes('\n\n'));
    assert.ok(blocks[1].trim().endsWith('```'));
    assert.equal(tail.trim(), '之后的话。');
  });

  it('partial trailing line stays in tail; a later delta with blank line settles it as one block', () => {
    const s = createStreamScanState();
    feedStreamDelta(s, '完整行\n不完整的半行');   // no trailing newline yet
    let parts = getStreamParts(s);

    // Nothing settled — both lines are still in-flight (one complete + one partial)
    assert.deepEqual(parts.blocks, []);
    assert.equal(parts.tail, '完整行\n不完整的半行');

    // The terminating newline of the second line + a blank line arrive:
    feedStreamDelta(s, '\n\n');
    parts = getStreamParts(s);
    assert.deepEqual(parts.blocks.map(b => b.replace(/\n/g, '⏎')), ['完整行⏎不完整的半行⏎']);
    assert.equal(parts.tail, '');
  });

  it('chunk-boundary independence: char-by-char deltas equal one-shot', () => {
    const full = '# A\n\ntext **bold**\n\n```js\nlet x = 1\n```\n\ntail end';

    const oneShot = createStreamScanState();
    feedStreamDelta(oneShot, full);

    const byChar = createStreamScanState();
    for (const ch of full) feedStreamDelta(byChar, ch);

    const a = getStreamParts(oneShot);
    const b = getStreamParts(byChar);
    assert.deepEqual(b.blocks, a.blocks);
    assert.equal(b.tail, a.tail);

    // And mid-size chunks too
    const byChunks = createStreamScanState();
    for (let i = 0; i < full.length; i += 7) feedStreamDelta(byChunks, full.slice(i, i + 7));
    const c = getStreamParts(byChunks);
    assert.deepEqual(c.blocks, a.blocks);
    assert.equal(c.tail, a.tail);
  });

  it('unterminated fence keeps accumulating into the in-flight remainder', () => {
    const s = createStreamScanState();
    feedStreamDelta(s, '前文\n\n```py\nprint(1)\nprint(2)');
    const { blocks, tail } = getStreamParts(s);

    assert.deepEqual(blocks.map(b => b.trim()), ['前文']);
    assert.ok(tail.includes('```py'));
    assert.ok(tail.includes('print(2)'));
    assert.equal(s.fenceOpen, true);
  });
});

// ==================== 计划文本流式折叠（真机 1B 实测：伪 XML 计划刷屏） ====================

describe('streamingMarkdown 计划块折叠（rich 流式）', () => {
  const PLAN = '<write_file>\n<file_path>src/foo.ts</file_path>\nconst a = 1;\n</write_file>';

  it('完整闭合的计划块 → 单行摘要；块内容绝不进 blocks/tail', () => {
    const s = createStreamScanState();
    feedStreamDelta(s, `我先给出计划：\n\n${PLAN}\n\n以上。`);
    const { blocks, tail } = getStreamParts(s);
    const planNotes = blocks.filter(b => b.includes('⎿ [计划] write_file'));
    assert.equal(planNotes.length, 1, '折叠为一条单行摘要');
    assert.ok(planNotes[0].includes('src/foo.ts'), '摘要含目标路径');
    const all = blocks.join('') + tail;
    assert.ok(!all.includes('const a = 1;'), '块内容不渲染');
    assert.ok(!all.includes('<file_path>'), '内嵌标签不渲染');
    assert.equal(tail.trim(), '以上。', '后续正文正常进 tail');
  });

  it('chunk 边界：逐字符 delta 与一次性投喂结果一致（holdback 状态机）', () => {
    const full = `说明\n\n<edit_file file_path="a.ts">\n-old\n+new\n</edit_file>\n\n结束`;
    const oneShot = createStreamScanState();
    feedStreamDelta(oneShot, full);
    const byChar = createStreamScanState();
    for (const ch of full) feedStreamDelta(byChar, ch);
    assert.deepEqual(getStreamParts(byChar), getStreamParts(oneShot));
    const { blocks } = getStreamParts(byChar);
    assert.ok(blocks.some(b => b.includes('⎿ [计划] edit_file → a.ts')), '摘要含属性路径');
  });

  it('未闭合计划块：内容扣留（holdback），tail 只给生成中提示', () => {
    const s = createStreamScanState();
    feedStreamDelta(s, '<verify_command>\nnpm test\n<stepNumber>1</stepNumber>');
    const { blocks, tail } = getStreamParts(s);
    assert.deepEqual(blocks, [], '未闭合不落摘要');
    assert.ok(!tail.includes('npm test'), '块内容被扣留');
    assert.ok(tail.includes('⎿ [计划] verify_command'), '仅一行生成中提示');
    // 闭标签到达后折叠
    feedStreamDelta(s, '\n</verify_command>\n');
    const parts = getStreamParts(s);
    assert.equal(parts.blocks.filter(b => b.includes('⎿ [计划] verify_command')).length, 1);
    assert.ok(!parts.tail.includes('npm test'), '闭合后内容仍不显示');
  });

  it('非计划标签（<div>/<think>）不折叠，正文语义不受影响', () => {
    const s = createStreamScanState();
    feedStreamDelta(s, '<div>x</div>\n\n<think>内部推理</think>\n\n正文。');
    const { blocks, tail } = getStreamParts(s);
    const all = blocks.join('') + tail;
    assert.ok(all.includes('<div>x</div>'));
    assert.ok(all.includes('<think>内部推理</think>'));
    assert.ok(!all.includes('⎿ [计划]'));
  });
});

describe('计划块折叠纯助手 + line 模式缓冲 holdback', () => {
  it('planBlockSummary：属性路径 / <file_path> / 首个纯文本行 三级提取', () => {
    assert.equal(
      planBlockSummary('<write_file file_path="b.md">\nhi\n</write_file>'),
      '⎿ [计划] write_file → b.md',
    );
    assert.equal(
      planBlockSummary('<read_file>\n<file_path>a/b.ts</file_path>\n</read_file>'),
      '⎿ [计划] read_file → a/b.ts',
    );
    assert.equal(
      planBlockSummary('<verify_command>\nnpm test --silent\n</verify_command>'),
      '⎿ [计划] verify_command → npm test --silent',
    );
  });

  it('foldClosedPlanBlocks / planHoldbackIndex：未闭合不折叠并给出扣留点', () => {
    const open = '前文\n<write_file>\nabc';
    assert.equal(planHoldbackIndex(open), open.indexOf('<write_file>'), '未闭合 → 扣留点=开标签处');
    assert.ok(foldClosedPlanBlocks(open).includes('<write_file>'), '未闭合原样保留');
    const closed = '前文\n<write_file>\n<file_path>x.md</file_path>\nabc\n</write_file>\n后文';
    const folded = foldClosedPlanBlocks(closed);
    assert.ok(folded.includes('⎿ [计划] write_file → x.md'), '闭合 → 摘要（目标取 file_path）');
    assert.ok(!folded.includes('abc'), '内容被折叠');
    assert.ok(folded.includes('后文'));
  });

  it('flushBufferedMarkdown：未闭合块整体扣留；闭合后以单行摘要放行', () => {
    // 未闭合 → ready 为空，块内容留在 rest
    const r1 = flushBufferedMarkdown('前文。\n<write_file>\n<file_path>notes.md</file_path>\nsecret line\n');
    assert.equal(r1.ready, '前文。\n');
    assert.ok(r1.rest.includes('<write_file>'));
    assert.ok(r1.rest.includes('secret line'));
    // 闭合 → 摘要放行，内容不再出现
    const r2 = flushBufferedMarkdown(r1.rest + '</write_file>\n后文。');
    assert.ok(r2.ready.includes('⎿ [计划] write_file → notes.md'), '摘要放行');
    assert.ok(!r2.ready.includes('secret line'), '内容不落屏');
    assert.ok(r2.ready.includes('后文。'));
  });
});
