// tests/loop/CritiqueContext.test.ts
// P0.5-A (v2): 验证静态分析注入 Critique 的位置顺序
// 断言：<static_analysis_context> 在 <user_request> 之前，且在 <current_diff> 之前

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

// fix-#10: chain test — an over-limit read_file result in step N must carry a
// visible trim marker into step N+1's prompt (silent truncation made the
// model believe the file never loaded and refuse to edit under RBW).
// 0.7.3 T2#9：阈值从 300 字符改为 4000（≤4000 原样保留）；超限保留
// 头 2500 + 尾 800 + 显式「已修剪 N 字符」标记——断言随新契约更新。
describe('fix-#10 buildHistory truncation marker (v2, T2#9 契约)', () => {
  it('超限 verificationResult（>4000 字符）→ next prompt contains trim marker + re-read hint', async () => {
    const captured: string[] = [];

    const longRead = 'READ_SUCCESS: src/tools/glob.ts\n' +
      Array.from({ length: 200 }, (_, i) => `${i + 1}\tconst line${i} = ${i};`).join('\n'); // ~4600 chars > 4000 阈值

    const modelClient = {
      callCount: 0,
      async complete(prompt: string): Promise<string> {
        captured.push(prompt);
        this.callCount++;
        if (this.callCount === 1) {
          // Step 1: issue a read_file call
          return `
<thinking>read first</thinking>
<plan>read the file</plan>
<verify>will check</verify>
<critique>ok</critique>
<>
  <read_file>
    <file_path>src/tools/glob.ts</file_path>
  </read_file>
</>
`;
        }
        // Step 2: stop (no tool calls)
        return `
<thinking>done</thinking>
<plan>no more</plan>
<verify>ok</verify>
<critique>finish</critique>
<>
</>
`;
      }
    };

    const verificationEngine = {
      async execute(calls: any[]) {
        return calls.some((c) => String(c.toolName || '').toLowerCase().includes('read'))
          ? longRead
          : 'VERIFICATION: ALL_TESTS_PASSED';
      }
    };

    const loop = new VerifyCritiqueLoop(modelClient as any, verificationEngine as any, {
      practicalMode: false,   // high tier → resultLimit = 300
      isStrongMode: true,
      maxSteps: 2,
    });

    await loop.run('Issue: add maxDepth\n\nExploration: {}');

    // The step-N prompt carries [历史执行记录]; the FIRST one (step 1) has an
    // empty history — take the LAST history prompt (step 2's, with step 1's
    // result). Critique prompts may also appear per step; ignore them here.
    const historyPrompts = captured.filter((p) => p.includes('[历史执行记录]'));
    const step2Prompt = historyPrompts[historyPrompts.length - 1] || '';
    assert.ok(step2Prompt.length > 0, 'must have a history-carrying prompt');
    assert.ok(
      step2Prompt.includes('已修剪') && step2Prompt.includes('read_file'),
      `step prompt must warn about trimming + re-read hint, got tail: ${step2Prompt.slice(-260)}`
    );
    // T2#9：头 2500 + 尾 800 必须保留（不再只留前 300）
    assert.ok(step2Prompt.includes(longRead.slice(0, 2000)), '结果头部必须保留');
    assert.ok(step2Prompt.includes(longRead.slice(-500)), '结果尾部必须保留');
  });
});

// P0.5-A CritiqueContext ordering（2 例）已随 critique 机制摘除归档
// （archive/2026-09-05-removals/，2026-09-05）：它们驱动 loop.run() 断言 critique
// prompt 装配顺序，而 critique 运行期生成已不存在。休眠的
// StructuredReasoner.buildCritiquePrompt 已随死代码收口整体删除，用例不再恢复。
