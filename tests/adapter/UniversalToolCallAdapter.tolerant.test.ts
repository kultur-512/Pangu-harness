// 容错切分（0.8.2 真机 1B 实录）：弱模型漏写 </> 的多块形态
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UniversalToolCallAdapter } from '../../src/adapter/UniversalToolCallAdapter.js';

describe('UniversalToolCallAdapter 容错切分（漏写 </> 的连续块）', () => {
  const adapter = new UniversalToolCallAdapter();

  it('块 1 漏 </> 直接开块 2 → 两个调用都被解析（此前第二个被吞）', () => {
    const content = `先读再写。
<>
  <read_file>
    <file_path>sc/main_content.txt</file_path>
  </read_file>
<>
  <write_file>
    <file_path>sc/main_content.txt</file_path>
    <content>整理后的内容</content>
  </write_file>
</>`;
    const r = adapter.parse(content);
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.toolCalls[0].toolName, 'read_file');
    assert.equal(r.toolCalls[1].toolName, 'write_file');
    assert.ok(r.warnings.some((w) => w.includes('TOOL_TAG_IMBALANCE')), '错配要有警告');
  });

  it('规范双块（都有 </>）行为不变', () => {
    const content = '<>\n<read_file><file_path>a.txt</file_path></read_file>\n</>\n<>\n<write_file><file_path>b.txt</file_path><content>x</content></write_file>\n</>';
    const r = adapter.parse(content);
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.toolCalls[0].toolName, 'read_file');
    assert.equal(r.toolCalls[1].toolName, 'write_file');
  });

  it('单块规范形态不受影响', () => {
    const r = adapter.parse('<>\n<read_file><file_path>a.txt</file_path></read_file>\n</>');
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].toolName, 'read_file');
  });
});
