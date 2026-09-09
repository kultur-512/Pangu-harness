// tests/repl/QuestionMarkPassthrough.test.ts
// 0.7.4 任务 C（控制人裁决："输入问号也是给模型的信息，/help 再显示帮助"）：
// line 模式主路径不再截获 `?`——`?` 作为普通任务文本透传给模型。
// handleLocalCommand 是闭包内函数（不可直接导入），用源码断言锁定行为：
//   1. `trimmed === '?'` 截获分支已删除；
//   2. 横幅不再宣传 `?` 快捷帮助；
//   3. buildQuickHelpLines 保留（/help 复用）；
//   4. taskIntent 对 `?` 分类为 chat（单次直答透传，与其它对话输入同路径）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildQuickHelpLines, buildBanner } from '../../src/cli/repl/turn/TurnRenderer.js';
import { classifyTaskIntent } from '../../src/cli/taskIntent.js';

const src = readFileSync(
  fileURLToPath(new URL('../../src/cli/repl/sseInteractive.ts', import.meta.url)),
  'utf-8'
);

describe('0.7.4 任务 C：`?` 透传（不再截获）', () => {
  it('handleLocalCommand 不再包含 `trimmed === "?"` 截获分支', () => {
    assert.ok(!src.includes('trimmed === \x27?\x27'), '截获分支必须删除——? 是给模型的信息');
  });

  it('buildQuickHelpLines 保留（/help 复用），横幅不再宣传 ? 快捷帮助', () => {
    // 函数本身保留（0.7.4 计划明示不强制删）
    const ql = buildQuickHelpLines(26);
    assert.equal(ql[0], '快捷帮助');
    // 横幅第三行不再含 `? 快捷帮助`
    const b = buildBanner({ model: 'm', tier: 'high', mode: 'default', workspace: 'C:\\ws', version: '0.7.4', width: 100 });
    assert.ok(!b[2].includes('? 快捷帮助'), b[2]);
    assert.ok(b[2].includes('/help 全部命令'), b[2]);
  });

  it('`?` 输入按意图分类落 chat → 单次 complete 直答（透传语义）', () => {
    assert.equal(classifyTaskIntent('?'), 'chat');
    assert.equal(classifyTaskIntent('？'), 'chat', '全角问号同语义');
  });
});
