// tests/adapter/UniversalToolCallAdapter.adversarial.test.ts
// T3 解析器高危形态对抗表（20 形态）+ T6 NO_NAMED_PARAMS 按工具兜底映射。
//
// 背景（三路探查实证）：文本协议下弱模型产出 20 种畸形形态，其中 ~30% 明显
// "有调用意图"却被解析器吞掉或解析成错误工具。本表锁定：
//  - 原本已救回的形态不回归（容错切分 / 尾块残缺 / 残参闭合 / 散文 <>）；
//  - 本次新修补的形态翻转（全角 C06 / 属性式 C08+C09 / 首标签错配 C13 / 双调用合并 C19）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UniversalToolCallAdapter } from '../../src/adapter/UniversalToolCallAdapter.js';

interface Form {
  id: string;
  name: string;
  input: string;
  /** 期望的调用列表（toolName + 关键参数）；空数组 = 期望零调用 */
  expect: Array<{ toolName: string; params?: Record<string, string> }>;
  /** 期望出现的诊断（至少其一） */
  warningsInclude?: string[];
}

const FORMS: Form[] = [
  // ---- 基线：原已救回，不回归 ----
  {
    id: 'F01', name: '基线：标准单块',
    input: '<>\n<read_file><file_path>a.txt</file_path></read_file>\n</>',
    expect: [{ toolName: 'read_file', params: { file_path: 'a.txt' } }],
  },
  {
    id: 'F02', name: '基线：块1漏</> 直接开块2 → 两调用都收',
    input: '<>\n<read_file><file_path>a.txt</file_path></read_file>\n<>\n<write_file><file_path>b.txt</file_path><content>x</content></write_file>\n</>',
    expect: [
      { toolName: 'read_file' },
      { toolName: 'write_file' },
    ],
  },
  {
    id: 'F03', name: '基线：规范双块',
    input: '<><read_file><file_path>a.txt</file_path></read_file></><><bash><command>ls</command></bash></>',
    expect: [{ toolName: 'read_file' }, { toolName: 'bash' }],
  },
  {
    id: 'F04', name: '基线：尾块残缺（全文无 </>）',
    input: '<><read_file><file_path>a.txt</file_path>',
    expect: [{ toolName: 'read_file', params: { file_path: 'a.txt' } }],
  },
  {
    id: 'F05', name: '基线：参数闭合残缺 <content>x</cont → best-effort 收值',
    input: '<><write_file><file_path>a.ts</file_path><content>HELLO</cont',
    expect: [{ toolName: 'write_file', params: { file_path: 'a.ts', content: 'HELLO' } }],
  },
  {
    id: 'F06', name: '基线：散文孤立 <> 不误收',
    input: '随便聊聊 <> 好的，我们继续。',
    expect: [],
  },
  // ---- 新修补：翻转形态 ----
  {
    id: 'C06', name: '全角尖括号整块（＜＞＜/＞）→ 归一后解析',
    input: '＜＞\n＜read_file＞\n＜file_path＞a.txt＜/file_path＞\n＜/read_file＞\n＜/＞',
    expect: [{ toolName: 'read_file', params: { file_path: 'a.txt' } }],
  },
  {
    id: 'C08', name: '属性式参数（带闭合标签）<read_file path="a.txt"></read_file>',
    input: '<><read_file path="a.txt"></read_file></>',
    expect: [{ toolName: 'read_file', params: { path: 'a.txt' } }],
    warningsInclude: ['ATTRIBUTE_PARAM'],
  },
  {
    id: 'C08b', name: '属性式参数（自闭合）<read_file file_path="a.txt"/>',
    input: '<><read_file file_path="a.txt"/></>',
    expect: [{ toolName: 'read_file', params: { file_path: 'a.txt' } }],
    warningsInclude: ['ATTRIBUTE_PARAM'],
  },
  {
    id: 'C09', name: '属性式裸标签（无 <> 包裹）<read_file path="a.txt">',
    input: '我来读取文件 <read_file path="a.txt">',
    expect: [{ toolName: 'read_file', params: { path: 'a.txt' } }],
    warningsInclude: ['ATTRIBUTE_PARAM'],
  },
  {
    id: 'C13', name: '首标签错配：<plan> 在块内、真工具在后 → 取 read_file',
    input: '<>\n<plan>先读取目标文件</plan>\n<read_file><file_path>a.txt</file_path></read_file>\n</>',
    expect: [{ toolName: 'read_file', params: { file_path: 'a.txt' } }],
    warningsInclude: ['FIRST_TAG_NOT_A_TOOL'],
  },
  {
    id: 'C13b', name: '首标签错配：<thinking> + bash → 取 bash',
    input: '<><thinking>分析完毕，执行</thinking><bash><command>ls</command></bash></>',
    expect: [{ toolName: 'bash', params: { command: 'ls' } }],
    warningsInclude: ['FIRST_TAG_NOT_A_TOOL'],
  },
  {
    id: 'C19', name: '双调用合并：同名工具标签 ×2 → 拆两个 call',
    input: '<><bash><command>echo a</command></bash><bash><command>echo b</command></bash></>',
    expect: [
      { toolName: 'bash', params: { command: 'echo a' } },
      { toolName: 'bash', params: { command: 'echo b' } },
    ],
    warningsInclude: ['DUPLICATE_PARAM'],
  },
  {
    id: 'C19b', name: '同名参数收集 ×2 → 每对开闭标签一个 call + DUPLICATE_PARAM',
    input: '<><read_file><file_path>a.txt</file_path><file_path>b.txt</file_path></read_file></>',
    expect: [
      { toolName: 'read_file', params: { file_path: 'a.txt' } },
      { toolName: 'read_file', params: { file_path: 'b.txt' } },
    ],
    warningsInclude: ['DUPLICATE_PARAM:file_path'],
  },
  // ---- T6：NO_NAMED_PARAMS 按工具兜底映射 ----
  {
    id: 'T6a', name: '无名参 bash：裸命令体 → command 参数',
    input: '<><bash>npm test</bash></>',
    expect: [{ toolName: 'bash', params: { command: 'npm test' } }],
  },
  {
    id: 'T6b', name: '无名参 read_file：裸路径体 → file_path 参数',
    input: '<><read_file>a.txt</read_file></>',
    expect: [{ toolName: 'read_file', params: { file_path: 'a.txt' } }],
  },
  {
    id: 'T6c', name: '无名参 glob：裸模式体 → pattern 参数',
    input: '<><glob>src/**/*.ts</glob></>',
    expect: [{ toolName: 'glob', params: { pattern: 'src/**/*.ts' } }],
  },
  {
    id: 'T6d', name: '无名参 write_file：裸内容体 → content 参数（原行为保持）',
    input: '<><write_file>hello world</write_file></>',
    expect: [{ toolName: 'write_file', params: { content: 'hello world' } }],
  },
  {
    id: 'T6e', name: '无名参未知工具：保持 content 兜底（原行为保持）',
    input: '<><frobnicate>xyz</frobnicate></>',
    expect: [{ toolName: 'frobnicate', params: { content: 'xyz' } }],
  },
  // ---- 防误伤回归 ----
  {
    id: 'R01', name: '散文含 HTML 链接 + 后随规范块：属性式扫描不误触发',
    input: '看 <a href="x">链接</a>，然后 <><read_file><file_path>a.txt</file_path></read_file></>',
    expect: [{ toolName: 'read_file' }],
  },
  {
    id: 'R02', name: '参数值含 HTML 属性样文本：解析不破坏',
    input: '<><bash><command>echo \'<div class="x">y</div>\'</command></bash></>',
    expect: [{ toolName: 'bash', params: { command: 'echo \'<div class="x">y</div>\'' } }],
  },
  {
    id: 'R03', name: '大写工具名 <READ_FILE>：正常解析（executor 侧归一）',
    input: '<><READ_FILE><file_path>a.txt</file_path></READ_FILE></>',
    expect: [{ toolName: 'READ_FILE', params: { file_path: 'a.txt' } }],
  },
];

describe('T3 解析器高危形态对抗表（20 形态）', () => {
  const adapter = new UniversalToolCallAdapter();
  for (const f of FORMS) {
    it(`[${f.id}] ${f.name}`, () => {
      const r = adapter.parse(f.input);
      assert.equal(
        r.toolCalls.length, f.expect.length,
        `[${f.id}] 调用数不符：got ${JSON.stringify(r.toolCalls.map((c) => ({ t: c.toolName, p: c.params })))}, warnings=${JSON.stringify(r.warnings)}`
      );
      f.expect.forEach((exp, i) => {
        const got = r.toolCalls[i];
        assert.equal(got.toolName, exp.toolName, `[${f.id}] 第 ${i + 1} 个调用工具名不符`);
        if (exp.params) {
          for (const [k, v] of Object.entries(exp.params)) {
            const p = got.params.find((x) => x.name === k);
            assert.ok(p, `[${f.id}] 缺参数 <${k}>，got: ${JSON.stringify(got.params)}`);
            assert.equal(p.value, v, `[${f.id}] 参数 <${k}> 值不符`);
          }
        }
      });
      if (f.warningsInclude) {
        for (const w of f.warningsInclude) {
          assert.ok(
            r.warnings.some((x) => x.includes(w)),
            `[${f.id}] 缺诊断 ${w}，got: ${JSON.stringify(r.warnings)}`
          );
        }
      }
    });
  }
});

describe('rootless 兜底（0.8.6 工具配合度：已知工具标签开头丢壳救回）', () => {
  const a = new UniversalToolCallAdapter();
  it('以 <read_file> 开头丢 <> 壳 → 补壳救回（实测任务4/5 各丢 2 步的形态）', () => {
    const r = a.parse('<read_file>\n  <file_path>package.json</file_path>\n</read_file>\n\n<grep>\n  <pattern>x</pattern>\n</grep>', { tolerant: true });
    assert.ok(r.toolCalls.length >= 1, '至少救回第一个调用');
    assert.equal(r.toolCalls[0].toolName, 'read_file');
    assert.ok(r.warnings.some((w) => w.includes('ROOTLESS')), '带 ROOTLESS 诊断');
  });

  it('散文中段提及工具名 → 不误伤（三重门控之开头锚定）', () => {
    const r = a.parse('你可以用 <read_file> 工具读取文件，然后再用 bash 执行命令。', { tolerant: true });
    assert.ok(!r.warnings.some((w) => w.includes('ROOTLESS')), '散文不得触发 rootless 兜底');
  });

  it('非核心工具开头 → 不救（防扩展工具/散文误伤）', () => {
    const r = a.parse('<my_custom_thing>\n  <file_path>x</file_path>\n</my_custom_thing>', { tolerant: true });
    assert.ok(!r.warnings.some((w) => w.includes('ROOTLESS')), '非核心工具不触发兜底');
  });
});
