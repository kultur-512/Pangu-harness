// tests/repl/streamingMarkdown.test.ts
// P1.3: frozen-blocks scanner — block settling on blank lines, fence handling,
// partial-line retention across deltas, and chunk-boundary independence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamScanState, feedStreamDelta, getStreamParts } from '../../src/cli/repl/ui/streamingMarkdown.js';

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
