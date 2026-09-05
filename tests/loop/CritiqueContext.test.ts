// tests/loop/CritiqueContext.test.ts
// P0.5-A (v2): 验证静态分析注入 Critique 的位置顺序
// 断言：<static_analysis_context> 在 <user_request> 之前，且在 <current_diff> 之前

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

// fix-#10: chain test — a truncated read_file result in step N must carry a
// visible "已截断" marker into step N+1's prompt (silent truncation made the
// model believe the file never loaded and refuse to edit under RBW).
describe('fix-#10 buildHistory truncation marker (v2)', () => {
  it('long verificationResult → next prompt contains truncation marker + re-read hint', async () => {
    const captured: string[] = [];

    const longRead = 'READ_SUCCESS: src/tools/glob.ts\n' +
      Array.from({ length: 60 }, (_, i) => `${i + 1}\tconst line${i} = ${i};`).join('\n'); // ~1000+ chars

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
      critiqueFrequency: { periodicEvery: 1, onProblem: true, longNoVerifyThreshold: 1, skipFirstN: 0 }
    });

    await loop.run('Issue: add maxDepth\n\nExploration: {}');

    // The step-N prompt carries [历史执行记录]; the FIRST one (step 1) has an
    // empty history — take the LAST history prompt (step 2's, with step 1's
    // result). Critique prompts may also appear per step; ignore them here.
    const historyPrompts = captured.filter((p) => p.includes('[历史执行记录]'));
    const step2Prompt = historyPrompts[historyPrompts.length - 1] || '';
    assert.ok(step2Prompt.length > 0, 'must have a history-carrying prompt');
    assert.ok(
      step2Prompt.includes('已截断') && step2Prompt.includes('read_file'),
      `step prompt must warn about truncation + re-read hint, got tail: ${step2Prompt.slice(-260)}`
    );
  });
});

// P0.5-A CritiqueContext ordering（2 例）已随 critique 机制摘除归档
// （archive/2026-09-05-removals/，2026-09-05）：它们驱动 loop.run() 断言 critique
// prompt 装配顺序，而 critique 运行期生成已不存在。休眠的
// StructuredReasoner.buildCritiquePrompt 恢复时随归档一起恢复用例。
