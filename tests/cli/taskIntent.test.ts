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

  it('本地元命令前缀 → meta（R5：^run 前缀已从意图分类移除）', () => {
    assert.equal(classifyTaskIntent('/model x'), 'meta');
    // R5（0.8.1）：isMeta 的 ^r(un)?\s 支移除——run 命令别名语义只在交互层
    // 本地命令派发有意义，不进意图分类；含操作动词的 run 行按词表归 execution。
    assert.equal(classifyTaskIntent('run 修复 x'), 'execution');
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

// ==================== R5（0.8.1）：红队对抗性词表锁定 ====================
// 红队探针 2 的 12 边界输入——概念提问/文创请求不得误进 execution（完整循环
// 白烧步数），疑问句不得被 ^run meta 劫持成实际执行。
describe('R5 红队 12 输入词表锁定', () => {
  afterEach(() => { delete process.env.PANSHA_INTENT_GATE; });

  it('纯对话/概念提问/文创 → chat；疑问句不判 execution；文件参照降级 search', () => {
    // 1-2 纯问候
    assert.equal(classifyTaskIntent('你好'), 'chat', '#1 你好');
    assert.equal(classifyTaskIntent('在吗'), 'chat', '#2 在吗（问候）');
    // 3-6 概念提问：工具词命中但疑问标记抑制 execution
    assert.equal(classifyTaskIntent('什么是bash'), 'chat', '#3 什么是bash（bash 命中+疑问 → chat）');
    assert.equal(classifyTaskIntent('git rebase 和 merge 有什么区别'), 'chat', '#4 git+疑问 → chat');
    assert.equal(classifyTaskIntent('python 怎么读取一个文件'), 'chat', '#5 python+怎么 → chat');
    assert.equal(classifyTaskIntent('glob 和 grep 有何差异？'), 'chat', '#6 工具对比疑问 → chat');
    // 7-8 文创/润饰：动词命中但无工程宾语
    assert.equal(classifyTaskIntent('帮我写一首关于秋天的诗'), 'chat', '#7 写诗 → chat');
    assert.equal(classifyTaskIntent('优化一下这段话的表达'), 'chat', '#8 润色表达 → chat');
    // 9 "run …会发生什么"：非 meta（曾被执行劫持）；疑问标记 → chat
    assert.equal(classifyTaskIntent('run npm install 会发生什么'), 'chat', '#9 疑问句不因 ^run 进 meta/执行');
    // 10-11 真执行任务保持 execution
    assert.equal(classifyTaskIntent('把 README.md 里的错别字改掉'), 'execution', '#10 明确写任务 → execution');
    assert.equal(classifyTaskIntent('运行 npm test'), 'execution', '#11 无疑问标记的命令 → execution');
    // 12 文件存在性疑问 → search（含文件扩展名降级 search 而非 chat）
    assert.equal(classifyTaskIntent('看看 src/foo.ts 里有什么'), 'search', '#12 文件+疑问 → search');
  });

  it('疑问标记不吞掉执行语义：PANSHA_INTENT_GATE=0 仍恒 execution', () => {
    process.env.PANSHA_INTENT_GATE = '0';
    assert.equal(classifyTaskIntent('什么是bash'), 'execution');
  });
});

// 第 3 轮补丁回归：显式写/续接请求不得降级 search（真机：续接 memo.txt 任务被
// .txt 扩展名判成 search 只读，模型遵命只查不写——续接任务卡死）
describe('第 3 轮：显式写/续接请求优先', () => {
  const cases: Array<[string, string]> = [
    ['继续完成 memo.txt 任务', 'execution'],
    ['能在 memo.txt 里加一行吗', 'execution'],
    ['把 config.json 里的超时改成 30 秒', 'execution'],
    ['memo.txt 在哪', 'search'],
    ['看看 README.md 里写了什么', 'search'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(classifyTaskIntent(input), expected);
    });
  }
});

// R7（0.8.2）：英文疑问/第一人称回忆（LongMemEval 接入驱动）
describe('R7 英文疑问与第一人称回忆分类', () => {
  it('英文疑问句开头 → chat（无问号结尾也识别）', () => {
    assert.equal(classifyTaskIntent('What was the first issue I had with my new car after its first service'), 'chat');
    assert.equal(classifyTaskIntent('How many children do I have'), 'chat');
    assert.equal(classifyTaskIntent('Which speaker did I return'), 'chat');
  });
  it('第一人称经历回忆（中英）→ chat', () => {
    assert.equal(classifyTaskIntent('Did I ever break my fast while traveling'), 'chat');
    assert.equal(classifyTaskIntent('我第一次保养是什么时候'), 'chat');
    assert.equal(classifyTaskIntent('我的新车出现过什么问题'), 'chat');
  });
  it('工程任务不被新规则误判', () => {
    assert.equal(classifyTaskIntent('修复 login 页面的报错'), 'execution');
    assert.equal(classifyTaskIntent('继续完成 memo.txt 任务'), 'execution');
  });
});

// ==================== T6（openPangu 配合度修复）：检索/枚举类动词 → execution ====================
// 实证："列出 src 文件"/"搜 TODO" 被误判 chat → 零动作记 success（假完成）。
// EXECUTION_VERBS 补 列出|搜索|查找|列举|查看|list|search|find。
describe('T6 检索/枚举类动词分类', () => {
  it('列出/搜索/查找/列举/查看 + list/search/find → execution', () => {
    assert.equal(classifyTaskIntent('列出 src 下的所有文件'), 'execution', '列出');
    assert.equal(classifyTaskIntent('搜索 TODO 标记并汇总'), 'execution', '搜索');
    assert.equal(classifyTaskIntent('查找 config.json 里的超时配置'), 'execution', '查找');
    assert.equal(classifyTaskIntent('列举 tests 目录下的用例'), 'execution', '列举');
    assert.equal(classifyTaskIntent('查看 package.json 的内容'), 'execution', '查看');
    assert.equal(classifyTaskIntent('list all TODO comments'), 'execution', 'list');
    assert.equal(classifyTaskIntent('search for memory leaks'), 'execution', 'search');
    assert.equal(classifyTaskIntent('find the entry point'), 'execution', 'find');
  });

  it('不过度捕获：疑问/概念/文创类仍 chat（既有反例不回归）', () => {
    assert.equal(classifyTaskIntent('什么是查找算法'), 'chat', '疑问标记优先');
    assert.equal(classifyTaskIntent('帮我写一首关于秋天的诗'), 'chat', '文创优先');
    assert.equal(classifyTaskIntent('这首歌在名单里吗'), 'chat', '吗 结尾疑问');
    assert.equal(classifyTaskIntent('什么是 list comprehension'), 'chat', '英文概念提问');
    assert.equal(classifyTaskIntent('how do I find my purpose'), 'chat', '英文疑问词开头');
    assert.equal(classifyTaskIntent('看看 src/foo.ts 里有什么'), 'search', '文件存在性疑问仍 search');
    assert.equal(classifyTaskIntent('memo.txt 在哪'), 'search', '位置疑问仍 search');
  });
});
