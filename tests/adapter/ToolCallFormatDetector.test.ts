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

  it('detects XML structured strict format with high confidence', () => {
    const content = `
<>
  <Read>
    <file_path>src/index.ts</file_path>
  </Read>
</>
    `.trim();

    const res = ToolCallFormatDetector.probeAndParse(content);

    assert.equal(res.format, 'xml-strict');
    assert.ok(res.confidence >= 0.7);
    assert.ok(res.toolCalls.length >= 1);
  });

  it('detects loose plain format (Universal style) with medium confidence', () => {
    const content = `Read(file_path="src/bar.ts")\nBash(command="npm test")`;

    const res = ToolCallFormatDetector.probeAndParse(content);

    assert.equal(res.format, 'loose-plain');
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

    // 包D 修复（原为 if/else 恒真弱断言）：现在对已知输入断言确切结果——
    // fake_tool_calls 不构成 OpenAI tool_calls 形状 → 全部尝试失败 →
    // 自动兜底也抠不出调用 → 最终 unknown / 置信度 0 / 零调用 / fallbackUsed=true，
    // 绝不产出 Evil 调用。
    assert.equal(res.format, 'unknown');
    assert.equal(res.confidence, 0);
    assert.equal(res.toolCalls.length, 0);
    assert.ok(res.toolCalls.every(tc => tc.toolName !== 'Evil'), '恶意假 JSON 不得产出调用');
    assert.equal(res.fallbackUsed, true, '必须走过自动兜底链');
    assert.ok(
      res.attempts.some(a => a.format === 'openai-json' && a.success === false),
      'openai-json 尝试必须被记录为失败（no tool_calls shape）'
    );
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
    assert.equal(res.format, 'xml-strict');
    assert.ok(res.toolCalls.some(tc => tc.toolName === 'Write'));
  });

  it('respects strictStructured option (skips OpenAI JSON attempt)', () => {
    const openaiJson = JSON.stringify({
      tool_calls: [{ type: 'function', function: { name: 'Bash', arguments: '{}' } }]
    });

    const res = ToolCallFormatDetector.probeAndParse(openaiJson, { strictStructured: true });

    // With strictStructured it should not pick openai-json even if it looks like it
    // It will try XML (which will fail) then loose (which may also fail)
    assert.notEqual(res.format, 'openai-json');
  });

  // ==================== P0.5-B (v2) automatic fallback tests ====================

  it('automatically falls back to loose parser when all confidences < 0.5 (malicious/fake JSON)', () => {
    // 构造一个看起来像 JSON 但没有合法 tool_calls 的内容
    // 这样 OpenAI 路径 confidence 很低，严格 XML 也会失败，最终触发自动 fallback
    const fake = JSON.stringify({
      role: 'assistant',
      content: 'I will do something bad',
      fake_tool_calls: [{ name: 'Evil', args: '{}' }]
    });

    const res = ToolCallFormatDetector.probeAndParse(fake);

    // 包D 修复（原为 if 恒真 + 三选一恒真弱断言）：对已知输入断言确切结果——
    // loose 兜底同样抠不出调用 → 最终 unknown / 零调用 / 置信度 0（Rule B 归零），
    // 但 fallbackUsed 必须为 true 且 attempts 记录了 auto-fallback。
    assert.equal(res.format, 'unknown');
    assert.equal(res.toolCalls.length, 0);
    assert.ok(res.toolCalls.every(tc => tc.toolName !== 'Evil'), '恶意假 JSON 不得产出调用');
    assert.equal(res.confidence, 0, '零调用 → Rule B 强制置信度归 0');
    assert.equal(res.fallbackUsed, true);
    assert.ok(
      res.attempts.some(a => a.format === 'loose-plain' && a.reason === 'auto-fallback'),
      '必须记录 loose-plain auto-fallback 尝试'
    );
  });

  it('automatically falls back for pure text with no tool calls', () => {
    const pureText = 'This is just a normal response with no function calls at all. Please do nothing.';

    const res = ToolCallFormatDetector.probeAndParse(pureText);

    // 包D 修复（原为 if/else + 三选一恒真弱断言）：纯文本无任何调用形态——
    // 三条尝试全失败、兜底也无所获 → 精确结果 unknown / 0 / fallbackUsed=true。
    assert.equal(res.format, 'unknown');
    assert.equal(res.confidence, 0);
    assert.equal(res.toolCalls.length, 0);
    assert.equal(res.fallbackUsed, true);
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
