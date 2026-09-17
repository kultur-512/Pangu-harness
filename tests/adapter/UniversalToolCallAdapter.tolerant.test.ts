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
    // 包D 修复后：块 1 的 </read_file> 完整保留（不再被 -3 砍残成伪错配），
    // 强制闭合本身以 ROOT_OPEN_FORCED_CLOSE 诊断记录
    assert.ok(r.warnings.includes('ROOT_OPEN_FORCED_CLOSE'), '强制闭合要有诊断');
    assert.ok(
      !r.warnings.some((w) => w.includes('TOOL_TAG_IMBALANCE')),
      `块内标签完整时不得误报错配，got: ${JSON.stringify(r.warnings)}`
    );
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

// 包D 修复：容错切分分支的 block 不以 </> 结尾，此前对两分支共用
// slice(ROOT_OPEN.length, -ROOT_CLOSE.length) —— 容错块末尾 3 个真实字符
// 被咬掉（最后一个参数如 <content>HELLO</content> 被咬成残缺 → 参数静默丢失）。
describe('UniversalToolCallAdapter 容错块砍尾（包D 修复）', () => {
  const adapter = new UniversalToolCallAdapter();

  it('块 1 连工具闭合标签都没有且后跟块 2 → 两调用都解析、参数完整', () => {
    // 两个块都没有任何 </> / </write_file>——纯靠下一 <> 强制闭合前块
    const content = '<><write_file><file_path>a.ts</file_path><content>HELLO</content>'
      + '<><write_file><file_path>b.ts</file_path><content>WORLD</content>';
    const r = adapter.parse(content);
    assert.equal(r.toolCalls.length, 2, `两个调用都要解析出，got ${r.toolCalls.length}`);
    assert.equal(r.toolCalls[0].toolName, 'write_file');
    assert.equal(r.toolCalls[0].params.find((p) => p.name === 'file_path')?.value, 'a.ts');
    assert.equal(
      r.toolCalls[0].params.find((p) => p.name === 'content')?.value, 'HELLO',
      `第一个调用的 content 参数必须完整（此前被 -3 砍尾咬残丢失），got: ${JSON.stringify(r.toolCalls[0].params)}`
    );
    assert.equal(r.toolCalls[1].toolName, 'write_file', '第二个调用也必须解析出（不被 break 吞掉）');
    assert.equal(r.toolCalls[1].params.find((p) => p.name === 'content')?.value, 'WORLD');
  });

  it('残缺闭合标签 <content>x</cont → best-effort 提取已开标签的值到块末尾', () => {
    // 块 1 的 content 闭合标签写残（</cont），随后直接开块 2
    const content = '<><write_file><file_path>a.ts</file_path><content>HELLO</cont'
      + '<><read_file><file_path>b.ts</file_path></>';
    const r = adapter.parse(content);
    assert.equal(r.toolCalls.length, 2, `got ${r.toolCalls.length}: ${JSON.stringify(r.warnings)}`);
    const wf = r.toolCalls[0];
    assert.equal(wf.toolName, 'write_file');
    assert.equal(wf.params.find((p) => p.name === 'file_path')?.value, 'a.ts');
    assert.equal(
      wf.params.find((p) => p.name === 'content')?.value, 'HELLO',
      `残缺闭合标签的参数值要 best-effort 提取（剥掉 </cont 残迹），got: ${JSON.stringify(wf.params)}`
    );
    assert.equal(r.toolCalls[1].toolName, 'read_file');
    assert.equal(r.toolCalls[1].params.find((p) => p.name === 'file_path')?.value, 'b.ts');
  });

  it('尾块残缺（全文无任何 </>）→ 最后一块也被收，散文 <> 仍不误收', () => {
    // 末块无 </> 收尾：此前 else 分支 c===-1 直接 break，最后一块整块丢
    const r = adapter.parse('<><read_file><file_path>a.txt</file_path>');
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].toolName, 'read_file');
    assert.equal(r.toolCalls[0].params.find((p) => p.name === 'file_path')?.value, 'a.txt');

    // 散文里孤立的 <> 不含工具标签 → 不误收
    const prose = adapter.parse('随便聊聊 <> 好的，我们继续。');
    assert.equal(prose.toolCalls.length, 0, '纯散文 <> 不得产生伪调用');
  });
});
