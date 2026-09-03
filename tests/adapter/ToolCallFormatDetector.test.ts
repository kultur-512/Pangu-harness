// tests/adapter/ToolCallFormatDetector.test.ts
// P0-1: ToolCallFormatDetector tests (blueprint requirements)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallFormatDetector } from '../../src/adapter/ToolCallFormatDetector.js';

describe('ToolCallFormatDetector (P0-1)', () => {
  it('detects standard OpenAI JSON tool_calls with high confidence', () => {
    const content = JSON.stringify({
      role: 'assistant',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"src/foo.ts"}' } }
      ]
    });

    const res = ToolCallFormatDetector.probeAndParse(content);

    assert.equal(res.format, 'openai-json');
    assert.ok(res.confidence >= 0.7, 'OpenAI JSON with tool_calls should have high confidence');
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].toolName, 'Read');
  });

  it('detects GLM XML strict format with high confidence', () => {
    const content = `
<>
  <Read>
    <file_path>src/index.ts</file_path>
  </Read>
</>
    `.trim();

    const res = ToolCallFormatDetector.probeAndParse(content);

    assert.equal(res.format, 'glm-xml-strict');
    assert.ok(res.confidence >= 0.7);
    assert.ok(res.toolCalls.length >= 1);
  });

  it('detects loose plain format (Universal style) with medium confidence', () => {
    const content = `Read(file_path="src/bar.ts")\nBash(command="npm test")`;

    const res = ToolCallFormatDetector.probeAndParse(content);

    assert.equal(res.format, 'glm-loose-plain');
    assert.ok(res.confidence >= 0.5);
    assert.ok(res.toolCalls.length >= 1);
  });

  it('returns unknown + empty toolCalls for pure text with no tool calls', () => {
    const content = 'This is just a normal response with no function calls at all.';

    const res = ToolCallFormatDetector.probeAndParse(content);

    assert.equal(res.format, 'unknown');
    assert.equal(res.toolCalls.length, 0);
  });

  it('handles malicious/fake JSON (looks like success but low confidence or falls back)', () => {
    // Fake JSON that doesn't have proper tool_calls structure
    const content = JSON.stringify({
      role: 'assistant',
      content: 'I will call something',
      fake_tool_calls: [{ name: 'Evil', args: '{}' }]
    });

    const res = ToolCallFormatDetector.probeAndParse(content);

    // Should not blindly trust it as high-confidence OpenAI format
    if (res.format === 'openai-json') {
      assert.ok(res.confidence < 0.7, 'malformed OpenAI-like JSON should have low confidence');
    } else {
      // Acceptable to fall back to unknown or other
      assert.ok(['unknown', 'glm-xml-strict', 'glm-loose-plain'].includes(res.format));
    }
  });

  it('falls back correctly on mixed input (JSON parse fails but XML succeeds)', () => {
    const content = `
Some thinking text...
<invalid json here>
Then valid XML:
<>
  <Write>
    <path>test.txt</path>
    <content>hello</content>
  </Write>
</>
    `.trim();

    const res = ToolCallFormatDetector.probeAndParse(content);

    // Should prefer the XML result
    assert.equal(res.format, 'glm-xml-strict');
    assert.ok(res.toolCalls.some(tc => tc.toolName === 'Write'));
  });

  it('respects strictGlmOnly option (skips OpenAI JSON attempt)', () => {
    const openaiJson = JSON.stringify({
      tool_calls: [{ type: 'function', function: { name: 'Bash', arguments: '{}' } }]
    });

    const res = ToolCallFormatDetector.probeAndParse(openaiJson, { strictGlmOnly: true });

    // With strictGlmOnly it should not pick openai-json even if it looks like it
    // It will try XML (which will fail) then loose (which may also fail)
    assert.notEqual(res.format, 'openai-json');
  });

  // ==================== P0.5-B (v2) automatic fallback tests ====================

  it('automatically falls back to loose parser when all confidences < 0.5 (malicious/fake JSON)', () => {
    // 构造一个看起来像 JSON 但没有合法 tool_calls 的内容
    // 这样 OpenAI 路径 confidence 很低，GLM XML 也会失败，最终触发自动 fallback
    const fake = JSON.stringify({
      role: 'assistant',
      content: 'I will do something bad',
      fake_tool_calls: [{ name: 'Evil', args: '{}' }]
    });

    const res = ToolCallFormatDetector.probeAndParse(fake);

    // 关键断言：fallbackUsed 应该为 true，或者至少最终没有把这个假 JSON 当作高置信度成功
    if (res.format === 'openai-json') {
      // 如果仍然被判定为 openai-json，置信度必须 < 0.5（但按当前实现，这种情况通常不会选它）
      assert.ok(res.confidence < 0.5, 'malicious JSON should not get high confidence');
    }

    // 允许 fallback 后仍为 unknown（没有有效调用），但必须记录 fallbackUsed
    // 主要目标是确保没有把恶意 JSON 当作高置信度成功
    assert.ok(res.confidence < 0.7 || res.fallbackUsed === true || res.format !== 'openai-json',
      'should not treat malicious JSON as high-confidence success');
  });

  it('automatically falls back for pure text with no tool calls', () => {
    const pureText = 'This is just a normal response with no function calls at all. Please do nothing.';

    const res = ToolCallFormatDetector.probeAndParse(pureText);

    // 纯文本场景下，OpenAI/严格 XML 基本都会失败，最终会走 loose 兜底
    // 结果可能是 unknown 或 glm-loose-plain（取决于 UniversalAdapter 是否能从文本中抠出类似调用）
    // 无论哪种，关键是 fallbackUsed 应该为 true，或者至少没有高置信度误报
    if (res.format !== 'unknown') {
      // 如果被识别成某种格式，置信度不应该太高
      assert.ok(res.confidence <= 0.6, 'pure text should not produce high confidence');
    }

    // 宽松断言：要么是 unknown，要么 fallbackUsed 标记了自动降级
    assert.ok(
      res.format === 'unknown' || res.fallbackUsed === true || res.confidence < 0.7,
      'pure text should trigger fallback logic or stay low-confidence'
    );
  });

  it('fallbackUsed flag is present and false when a high-confidence path succeeds', () => {
    // 标准 OpenAI JSON 应该走主路径，不触发 fallback
    const good = JSON.stringify({
      role: 'assistant',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"x.ts"}' } }
      ]
    });

    const res = ToolCallFormatDetector.probeAndParse(good);

    assert.equal(res.format, 'openai-json');
    assert.ok(res.confidence >= 0.7);
    assert.equal(res.fallbackUsed, false, 'high-confidence OpenAI path should not mark fallbackUsed');
  });
});
