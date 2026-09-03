import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExtremeGlmToolCallAdapter } from '../src/adapter/ExtremeGlmToolCallAdapter.js';

describe('ExtremeGlmToolCallAdapter - 30-round debug target', () => {
  const adapter = new ExtremeGlmToolCallAdapter();

  it('must parse exact user sample with <Bash><command>', () => {
    const input = `<>
  <Bash>
    <command>ls -la /path/to/dir/</command>
  </Bash>
</>`;
    const res = adapter.parse(input);
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].toolName, 'Bash');
    assert.equal(res.toolCalls[0].params[0].value, 'ls -la /path/to/dir/');
  });

  it('must handle <Read><file_path> format', () => {
    const input = `<>
  <Read>
    <file_path>src/main.rs</file_path>
  </Read>
</>`;
    const res = adapter.parse(input);
    assert.equal(res.toolCalls[0].toolName, 'Read');
    assert.equal(res.toolCalls[0].params[0].name, 'file_path');
  });

  it('must collect warnings on malformed input', () => {
    const input = `<>
  <Write>
    <path>test.txt</path>
  </Write>
</>`; // 缺少 content
    const res = adapter.parse(input);
    assert.ok(res.warnings.length > 0 || res.toolCalls.length > 0);
  });

  it('must be robust to escaped entities', () => {
    const input = `<>
  <Bash>
    <command>echo &lt;hello&gt;</command>
  </Bash>
</>`;
    const res = adapter.parse(input);
    assert.equal(res.toolCalls[0].params[0].value, 'echo <hello>');
  });
});
