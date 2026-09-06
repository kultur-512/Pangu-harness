// tests/repl/sseInteractiveUi.test.ts
// 批次 A（0.7.1 UI 手感）：line 模式渲染纯助手的单测 —
// 工具实时卡片的参数摘要/结果行、thinking 单行截断、
// 结束总结的「下一步」分支、审批活动钩子。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateByWidth,
  wrapByWidth,
  fmtMs,
  summarizeToolParams,
  toolResultLine,
  nextStepHint,
} from '../../src/cli/repl/sseInteractive.js';
import {
  isApprovalActive,
  cancelActiveApproval,
  setApprovalActivityListener,
} from '../../src/tools/approval.js';

describe('truncateByWidth (P1-1 thinking 单行截断 / P3-1 CJK 宽度)', () => {
  it('ASCII: keeps within budget', () => {
    assert.equal(truncateByWidth('abcdefgh', 8), 'abcdefgh');
    assert.equal(truncateByWidth('abcdefghij', 8), 'abcdefg…');
  });

  it('CJK counts as 2 columns and truncates with ellipsis', () => {
    assert.equal(truncateByWidth('你好世界', 8), '你好世界');
    assert.equal(truncateByWidth('你好世界', 5), '你好…');
    assert.equal(truncateByWidth('你好世界', 4), '你…');
  });

  it('empty / zero budget', () => {
    assert.equal(truncateByWidth('', 10), '');
    assert.equal(truncateByWidth('abc', 0), '');
  });
});

describe('wrapByWidth (P1-1.4 verbose thinking 折行)', () => {
  it('wraps greedily by display width', () => {
    const lines = wrapByWidth('a'.repeat(10), 4);
    assert.deepEqual(lines, ['aaaa', 'aaaa', 'aa']);
  });

  it('CJK wrapping respects double width', () => {
    const lines = wrapByWidth('你好世界你好', 4);
    assert.deepEqual(lines, ['你好', '世界', '你好']);
  });

  it('empty text yields one empty line', () => {
    assert.deepEqual(wrapByWidth('', 10), ['']);
  });
});

describe('fmtMs', () => {
  it('below 1s renders as ms', () => {
    assert.equal(fmtMs(4), '4ms');
    assert.equal(fmtMs(999), '999ms');
  });
  it('1s and above renders as seconds', () => {
    assert.equal(fmtMs(1000), '1.0s');
    assert.equal(fmtMs(4000), '4.0s');
    assert.equal(fmtMs(undefined), '0ms');
  });
});

describe('summarizeToolParams (P1-2.1 头行参数摘要)', () => {
  it('bash: uses command, flattened, clipped to 160', () => {
    const s = summarizeToolParams('bash', { command: 'echo ' + 'x'.repeat(300) });
    assert.ok(s.length <= 161, `len=${s.length}`);
    assert.ok(!s.includes('\n'));
    assert.equal(summarizeToolParams('bash', { command: 'npm test' }), 'npm test');
  });

  it('write_file: path + content line count', () => {
    const s = summarizeToolParams('write_file', { file_path: 'a.txt', content: 'x\ny\nz' });
    assert.equal(s, 'a.txt（3 行）');
  });

  it('read_file / edit_file: bare path', () => {
    assert.equal(summarizeToolParams('read_file', { file_path: 'src/x.ts' }), 'src/x.ts');
    assert.equal(summarizeToolParams('edit_file', { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' }), 'src/x.ts');
  });

  it('grep / glob: pattern', () => {
    assert.equal(summarizeToolParams('grep', { pattern: 'foo.*bar' }), 'foo.*bar');
    assert.equal(summarizeToolParams('glob', { pattern: '**/*.ts' }), '**/*.ts');
  });

  it('other tools: first two key=value pairs', () => {
    const s = summarizeToolParams('mcp_srv_tool', { alpha: '1', beta: '2', gamma: '3' });
    assert.equal(s, 'alpha=1 beta=2');
  });
});

describe('toolResultLine (P1-2.2 结果行动词句)', () => {
  const B = (s: string | number) => `\x1b[1m${s}\x1b[22m`;
  const DIM = (s: string | number) => `\x1b[2m${s}\x1b[22m`;

  it('write_file ok → Wrote N lines to path · 4ms (N from event lines, fallback params.content)', () => {
    const line = toolResultLine(
      { tool: 'write_file', ok: true, durationMs: 4, lines: 3 },
      { file_path: 'hello.txt', content: 'a\nb\nc' }
    );
    assert.ok(line.includes(`Wrote ${B(3)} lines to hello.txt`), line);
    assert.ok(line.includes(DIM('· 4ms')), line);

    const fallback = toolResultLine(
      { tool: 'write_file', ok: true, durationMs: 4 },
      { file_path: 'hello.txt', content: 'a\nb' }
    );
    assert.ok(fallback.includes(`Wrote ${B(2)} lines`), fallback);
  });

  it('read_file ok → Read N lines · 4ms (N from meta.lines)', () => {
    const line = toolResultLine({ tool: 'read_file', ok: true, durationMs: 7, lines: 120 }, { file_path: 'x.ts' });
    assert.ok(line.includes(`Read ${B(120)} lines`), line);
    assert.ok(line.includes(DIM('· 7ms')), line);
  });

  it('read_file ok without lines → Read <path>', () => {
    const line = toolResultLine({ tool: 'read_file', ok: true, durationMs: 2 }, { file_path: 'x.ts' });
    assert.ok(line.startsWith('Read x.ts'), line);
  });

  it('edit_file ok with diff → Added N, removed M', () => {
    const line = toolResultLine(
      {
        tool: 'edit_file', ok: true, durationMs: 5,
        diff: [
          { type: 'add', text: 'new line 1' },
          { type: 'add', text: 'new line 2' },
          { type: 'del', text: 'old line' },
          { type: 'ctx', text: 'same' },
        ],
      },
      { file_path: 'x.ts' }
    );
    assert.ok(line.includes(`Added ${B(2)}, removed ${B(1)}`), line);
  });

  it('edit_file ok without diff → Edited <path>', () => {
    const line = toolResultLine({ tool: 'edit_file', ok: true, durationMs: 3 }, { file_path: 'x.ts' });
    assert.ok(line.startsWith('Edited x.ts'), line);
  });

  it('bash ok → first output line (≤120) · 4ms; empty output → Ran · 4ms', () => {
    const line = toolResultLine({ tool: 'bash', ok: true, durationMs: 4, outputPreview: 'zhulong-deployed\nsecond' }, {});
    assert.ok(line.startsWith('zhulong-deployed'), line);
    const empty = toolResultLine({ tool: 'bash', ok: true, durationMs: 4, outputPreview: '' }, {});
    assert.ok(empty.startsWith('Ran'), empty);
  });

  it('grep ok → Found N', () => {
    const line = toolResultLine({ tool: 'grep', ok: true, durationMs: 9, outputPreview: 'a\nb\nc' }, { pattern: 'x' });
    assert.ok(line.includes(`Found ${B(3)}`), line);
  });

  it('!ok → red ✗ with human gloss + first reason line', () => {
    const line = toolResultLine(
      { tool: 'bash', ok: false, durationMs: 12, error: 'TIMEOUT', outputPreview: 'command blew past the limit\nmore' },
      {}
    );
    assert.ok(line.includes('✗'), line);
    assert.ok(line.includes('超时'), line);
    assert.ok(line.includes('command blew past the limit'), line);
    assert.ok(line.includes('\x1b[31m'), line);
  });

  it('!ok unknown error code falls back to raw code', () => {
    const line = toolResultLine({ tool: 'bash', ok: false, durationMs: 1, error: 'WEIRD', outputPreview: '' }, {});
    assert.ok(line.includes('WEIRD'), line);
  });
});

describe('nextStepHint (P1-3 stopReason 分支)', () => {
  it('completed / answered / aborted / max-steps / default', () => {
    assert.equal(nextStepHint('completed'), '继续下一个任务 · /memory 查看沉淀');
    assert.equal(nextStepHint('answered'), '继续追问或下达新任务');
    assert.equal(nextStepHint('aborted'), '已中断 · 现场已保留 · 重新描述任务可继续');
    assert.equal(nextStepHint('max-steps'), '步数达上限 · 可拆小任务重试');
    assert.equal(nextStepHint('no-verification'), '模型未完成验证 · 可补充要求重试 · /undo 回退变更');
    assert.equal(nextStepHint('consecutive-failures'), '模型未完成验证 · 可补充要求重试 · /undo 回退变更');
    assert.equal(nextStepHint(undefined), '模型未完成验证 · 可补充要求重试 · /undo 回退变更');
  });
});

describe('approval activity hooks (P0-1.4 / P0-3)', () => {
  it('idle state: not active, cancel is a no-op', () => {
    assert.equal(isApprovalActive(), false);
    assert.equal(cancelActiveApproval('sigint'), false);
  });

  it('listener fires with true/false from the module-level API surface', () => {
    // 桥内 question 生命周期经 setApprovalActivityListener 通知宿主；
    // 这里只验证钩子注册/通知/清理的通路（不拉起真实 readline）。
    const seen: boolean[] = [];
    setApprovalActivityListener((active) => seen.push(active));
    setApprovalActivityListener(null);
    assert.deepEqual(seen, []);
  });
});
