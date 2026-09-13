import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { XmlStructuredToolParser } from '../src/adapter/XmlStructuredToolParser.js';

describe('XmlStructuredToolParser', () => {
  const parser = new XmlStructuredToolParser();

  it('parses the exact user-provided sample', () => {
    const input = `
<>
  <Bash>
    <command>ls -la /path/to/dir/</command>
  </Bash>
</>
    `.trim();

    const res = parser.parse(input);

    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].toolName, 'Bash');
    assert.equal(res.toolCalls[0].params.length, 1);
    assert.equal(res.toolCalls[0].params[0].name, 'command');
    assert.equal(res.toolCalls[0].params[0].value, 'ls -la /path/to/dir/');
    assert.ok(res.remainingText.length === 0 || res.remainingText.trim().length === 0);
  });

  it('extracts reasoning text outside the tool block', () => {
    const input = `我先思考一下。\n<>\n  <Read>\n    <path>src/index.ts</path>\n  </Read>\n</>\n思考完毕。`;

    const res = parser.parse(input);
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].toolName, 'Read');
    assert.ok(res.remainingText.includes('我先思考一下'));
    assert.ok(res.remainingText.includes('思考完毕'));
  });

  it('handles multiple tool blocks', () => {
    const input = `
<>
  <Bash>
    <command>echo hello</command>
  </Bash>
</>
中间文本
<>
  <Write>
    <path>test.txt</path>
    <content>hello world</content>
  </Write>
</>
    `;

    const res = parser.parse(input);
    assert.equal(res.toolCalls.length, 2);
    assert.equal(res.toolCalls[0].toolName, 'Bash');
    assert.equal(res.toolCalls[1].toolName, 'Write');
    assert.equal(res.toolCalls[1].params.length, 2);
  });

  it('returns empty toolCalls when no root blocks present', () => {
    const input = '只是普通的思考，没有调用工具。';
    const res = parser.parse(input);
    assert.equal(res.toolCalls.length, 0);
    assert.ok(res.remainingText.includes('只是普通的思考'));
  });
});
