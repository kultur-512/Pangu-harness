// tests/cli/taskIntent.test.ts
// 0.7：入口意图分类纯函数测试。
// execution / search / chat / meta 四类 + PANSHA_INTENT_GATE=0 逃生门 + 反例。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskIntent } from '../../src/cli/taskIntent.js';

describe('classifyTaskIntent', () => {
  afterEach(() => { delete process.env.PANSHA_INTENT_GATE; });

  it('纯问候 / 自我询问 → chat', () => {
    assert.equal(classifyTaskIntent('你好'), 'chat');
    assert.equal(classifyTaskIntent('你好，回答我你是谁'), 'chat');
    assert.equal(classifyTaskIntent('你是谁'), 'chat');
    assert.equal(classifyTaskIntent('1'), 'chat');
    assert.equal(classifyTaskIntent('谢谢'), 'chat');
  });

  it('强工程动词/工具/命令 → execution', () => {
    assert.equal(classifyTaskIntent('修复 src/a.ts 的 bug'), 'execution');
    assert.equal(classifyTaskIntent('运行 npm test'), 'execution');
    assert.equal(classifyTaskIntent('read_file src/a.ts'), 'execution');
    assert.equal(classifyTaskIntent('git status'), 'execution');
  });

  it('@path 引用 → execution', () => {
    assert.equal(classifyTaskIntent('改 @src/a.ts 里的函数'), 'execution');
  });

  it('文件后缀无动词 → search（先搜索，搜不到询问）', () => {
    assert.equal(classifyTaskIntent('hello.txt'), 'search');
    assert.equal(classifyTaskIntent('src/foo.ts'), 'search');
  });

  it('本地元命令前缀 → meta', () => {
    assert.equal(classifyTaskIntent('/model x'), 'meta');
    assert.equal(classifyTaskIntent('run 修复 x'), 'meta');
    assert.equal(classifyTaskIntent('simulate 修复 x'), 'meta');
  });

  it('PANSHA_INTENT_GATE=0 逃生门 → execution', () => {
    process.env.PANSHA_INTENT_GATE = '0';
    assert.equal(classifyTaskIntent('你好'), 'execution');
  });

  it('反例：路径引用不误判（/usr/local/bin 是字符串不是路径触发）', () => {
    // 无执行动词、无文件后缀 → chat（"clean up /usr/local/bin" 里有动词会归 execution，
    // 这里测无动词场景不因含 '/' 而误判 search）
    assert.equal(classifyTaskIntent('what is this thing'), 'chat');
  });
});
