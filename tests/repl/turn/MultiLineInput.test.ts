// 多行输入拆分（真机 M3 REPL 缺陷回归）：
// /workspace + 任务文本多行一起提交时，旧逻辑整段命中 startsWith('/')
// 被当作命令参数，任务文本被静默吞掉。修复后命令行/任务行分离。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitMultiLineInput } from '../../../src/cli/repl/turn/TurnController.js';

describe('splitMultiLineInput 多行输入拆分', () => {
  it('命令 + 任务混合多行：命令行提取、任务行合并', () => {
    const r = splitMultiLineInput('/workspace D:\\zl-repl\\md-toc\n运行 node --test tests/paginate.test.js 会失败。修复分页 bug。');
    assert.deepEqual(r.commandLines, ['/workspace D:\\zl-repl\\md-toc']);
    assert.equal(r.taskText, '运行 node --test tests/paginate.test.js 会失败。修复分页 bug。');
  });

  it('多条命令 + 多行任务：全部命令按序提取，任务行 \\n 合并', () => {
    const r = splitMultiLineInput('/workspace /tmp/x\n/model gpt\ndata.md 生成目录\n并写 toc.js');
    assert.deepEqual(r.commandLines, ['/workspace /tmp/x', '/model gpt']);
    assert.equal(r.taskText, 'data.md 生成目录\n并写 toc.js');
  });

  it('纯多行任务（无命令）：taskText 保留全部行，commandLines 空', () => {
    const r = splitMultiLineInput('写 src/a.js\n再写 tests/a.test.js\n运行测试');
    assert.deepEqual(r.commandLines, []);
    assert.equal(r.taskText, '写 src/a.js\n再写 tests/a.test.js\n运行测试');
  });

  it('CRLF 与行内空格归一；空行剔除', () => {
    const r = splitMultiLineInput('/ws  X  \r\n\r\n任务A\r\n\n任务B');
    assert.deepEqual(r.commandLines, ['/ws  X']);
    assert.equal(r.taskText, '任务A\n任务B');
  });

  it('单行输入：命令/任务各归其位（不改变单行语义）', () => {
    assert.deepEqual(splitMultiLineInput('/help').commandLines, ['/help']);
    assert.equal(splitMultiLineInput('/help').taskText, '');
    assert.deepEqual(splitMultiLineInput('普通任务').commandLines, []);
    assert.equal(splitMultiLineInput('普通任务').taskText, '普通任务');
  });

  it('空/空白输入：全空', () => {
    assert.deepEqual(splitMultiLineInput('').commandLines, []);
    assert.equal(splitMultiLineInput('  \n  ').taskText, '');
  });
});
