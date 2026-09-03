// tests/loop/CritiqueContext.test.ts
// P0.5-A (v2): 验证静态分析注入 Critique 的位置顺序
// 断言：<static_analysis_context> 在 <user_request> 之前，且在 <current_diff> 之前

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';
import { StructuredReasoner } from '../../src/reasoning/StructuredReasoner.js';

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

describe('P0.5-A CritiqueContext ordering (v2)', () => {
  it('static_analysis_context appears before user_request and current_diff in critiqueInput', async () => {
    const captured: string[] = [];

    // 捕获传给 modelClient.complete 的 prompt
    const modelClient = {
      async complete(prompt: string): Promise<string> {
        captured.push(prompt);
        // 简单返回，包含 critique 触发内容，让循环能继续
        return `
<thinking>ok</thinking>
<plan>do nothing</plan>
<verify>ok</verify>
<critique>分析完成</critique>
<>
  <Read>
    <file_path>package.json</file_path>
  </Read>
</>
`;
      }
    };

    const verificationEngine = {
      async execute(_calls: any[]) {
        return 'VERIFICATION: ALL_TESTS_PASSED';
      }
    };

    const staticBlocks = [
      '<static_analysis_result tool="tsc" language="typescript" passed="false" errors="1" warnings="0">\nsrc/x.ts(1,1): error TS1000\n</static_analysis_result>'
    ];

    const loop = new VerifyCritiqueLoop(modelClient, verificationEngine, {
      practicalMode: false,
      isStrongMode: true,
      maxSteps: 3,
      staticAnalysisBlocks: staticBlocks,
      userRequest: '修复类型错误',
      currentDiff: 'diff --git a/src/x.ts ...',
      // 强制高频 critique（跳过前几步限制）
      critiqueFrequency: { periodicEvery: 1, onProblem: true, longNoVerifyThreshold: 1, skipFirstN: 0 }
    });

    await loop.run('Issue: test static analysis injection order\n\nExploration: {}');

    // 找到包含 critique prompt 的那次调用
    // StructuredReasoner.buildCritiquePrompt 会把 previousStep（即 critiqueInput）放进最终 prompt
    const critiqueCall = captured.find(p => p.includes('<static_analysis_context>') || p.includes('<user_request>'));
    assert.ok(critiqueCall, 'should have captured a critique-related prompt');

    const idxStatic = critiqueCall!.indexOf('<static_analysis_context>');
    const idxUser = critiqueCall!.indexOf('<user_request>');
    const idxDiff = critiqueCall!.indexOf('<current_diff>');

    assert.ok(idxStatic >= 0, 'should contain <static_analysis_context>');
    assert.ok(idxUser >= 0, 'should contain <user_request>');
    assert.ok(idxDiff >= 0, 'should contain <current_diff>');

    // 关键断言：static_analysis_context 必须在 user_request 之前，且在 current_diff 之前
    assert.ok(idxStatic < idxUser, '<static_analysis_context> must appear before <user_request>');
    assert.ok(idxStatic < idxDiff, '<static_analysis_context> must appear before <current_diff>');
    // 额外：user_request 应在 current_diff 之前（符合 v2 描述顺序）
    assert.ok(idxUser < idxDiff, '<user_request> must appear before <current_diff>');
  });

  it('when using raw staticAnalysis, it is still formatted and placed before user_request', async () => {
    const captured: string[] = [];

    const modelClient = {
      async complete(prompt: string): Promise<string> {
        captured.push(prompt);
        return `
<thinking>ok</thinking>
<plan>noop</plan>
<verify>ok</verify>
<critique>ok</critique>
<>
  <Bash>
    <command>echo 1</command>
  </Bash>
</>
`;
      }
    };

    const verificationEngine = { async execute() { return 'VERIFICATION: ALL_TESTS_PASSED'; } };

    // 构造一个极简的 StaticAnalysisResult
    const rawResults = [{
      language: 'typescript' as const,
      tool: 'tsc' as const,
      command: 'npx tsc --noEmit',
      passed: false,
      output: 'error TS2322',
      durationMs: 10,
      errorCount: 1,
      warningCount: 0,
      triggered: true,
    }];

    const loop = new VerifyCritiqueLoop(modelClient, verificationEngine, {
      practicalMode: false,
      isStrongMode: true,
      maxSteps: 2,
      staticAnalysis: rawResults as any,
      userRequest: 'fix type error',
      currentDiff: 'some diff',
      critiqueFrequency: { periodicEvery: 1, onProblem: true, longNoVerifyThreshold: 1, skipFirstN: 0 }
    });

    await loop.run('Issue: raw static analysis test');

    const critiqueCall = captured.find(p => p.includes('<static_analysis_context>') || p.includes('<user_request>'));
    assert.ok(critiqueCall, 'should capture critique prompt');

    const hasStatic = critiqueCall!.includes('<static_analysis_context>');
    const hasUser = critiqueCall!.includes('<user_request>');

    assert.ok(hasStatic, 'should have formatted static_analysis_context from raw results');
    assert.ok(hasUser, 'should have user_request');

    const idxStatic = critiqueCall!.indexOf('<static_analysis_context>');
    const idxUser = critiqueCall!.indexOf('<user_request>');
    assert.ok(idxStatic < idxUser, 'static_analysis_context must still precede user_request when using raw staticAnalysis');
  });
});
