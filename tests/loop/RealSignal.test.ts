// tests/loop/RealSignal.test.ts
// 0.7.3 T1#1/T1#3（docs/panshalach/USABLE-PLAN-0.7.3.md）：真实成功信号入册。
//
// 红队实测的 P0：验证只认字面 ALL_TESTS_PASSED/VERIFICATION: PASS——唯一产出方
// 是 smoke mock；真实引擎的 EXIT_CODE:0 / WRITE_SUCCESS 被判 FAIL，勤奋模型被
// consecutive-failures 掐死。修复后：
//   - engineAdapter.describeResult 按 res.ok+工具类别确定性追加尾标
//     （bash/write/edit → VERIFICATION: PASS；read/glob/grep → VERIFICATION: NEUTRAL；
//     失败分支不追加）；
//   - classifySignal 纳入 NEUTRAL→PARTIAL 与尾部锚定的裸 EXIT_CODE:0。
//
// 本文件：classifySignal 单测 + loop 级 NEUTRAL 不清零断言 + 真实 engineAdapter
// 的 describeResult 尾标行为锁定。

process.env.PANSHA_HEADLESS = '1'; // 0.8 起为兼容别名（非 TTY 默认真执行）；node --test 每文件独立进程

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';
import { createEngineAdapter } from '../../src/tools/engineAdapter.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';

function makeLoop(modelClient: any, engine: any, opts: any = {}) {
  return new VerifyCritiqueLoop(modelClient, engine, { practicalMode: true, ...opts });
}

describe('0.7.3 T1#1 classifySignal（真实成功信号）', () => {
  const loop: any = new VerifyCritiqueLoop({}, {}, {});

  it('WRITE_SUCCESS + EXIT_CODE:0 + VERIFICATION: PASS → PASS', () => {
    assert.equal(
      loop.classifySignal('WRITE_SUCCESS: hello.txt\nEXIT_CODE:0\nVERIFICATION: PASS'),
      'PASS'
    );
  });

  it('P1-1 回归：read/grep 正文含字面 VERIFICATION: PASS 不得误判 PASS（分段尾锚定）', () => {
    // 本仓库自身源码含字面 VERIFICATION: PASS——读/搜它即触发（评审已实测复现）
    const fileBody = [
      'READ_SUCCESS: src/tools/engineAdapter.ts',
      "...head += '\\nVERIFICATION: PASS';...",
      'VERIFICATION: NEUTRAL',
    ].join('\n');
    assert.equal(loop.classifySignal(fileBody), 'PARTIAL', '正文中的字面 PASS 不是信号，只有尾标才算');
    // 多工具步：一写一读（无 bash 验证段）不得判 PASS
    const mixed = [
      'WRITE_SUCCESS: a.txt (2 bytes, +1/−0)',
      'VERIFICATION: APPLIED',
      '---',
      'READ_SUCCESS: b.txt',
      'VERIFICATION: NEUTRAL',
    ].join('\n');
    assert.equal(loop.classifySignal(mixed), 'PARTIAL', '无任何 bash 验证段时不得判 PASS');
    const withBash = [
      'WRITE_SUCCESS: a.txt (2 bytes, +1/−0)',
      'VERIFICATION: APPLIED',
      '---',
      'BASH_SUCCESS:',
      'pong',
      'EXIT_CODE:0',
      'VERIFICATION: PASS',
    ].join('\n');
    assert.equal(loop.classifySignal(withBash), 'PASS', 'bash 验证段存在 → PASS');
  });

  it('READ_SUCCESS + VERIFICATION: NEUTRAL → PARTIAL（只读成功无验证效力）', () => {
    assert.equal(
      loop.classifySignal('READ_SUCCESS: src/a.ts\nexport const x = 1;\nVERIFICATION: NEUTRAL'),
      'PARTIAL'
    );
  });

  it('TOOL_ERROR → FAIL', () => {
    assert.equal(
      loop.classifySignal('TOOL_ERROR: RBW_VIOLATION ✗ 写入前必须先读取目标文件'),
      'FAIL'
    );
  });

  it('正文内嵌字面 EXIT_CODE:0（非尾行）→ 不误判 PASS', () => {
    // 尾部锚定 /\nEXIT_CODE:0\s*$/：日志正文提到 EXIT_CODE:0 不算成功
    assert.equal(
      loop.classifySignal('BASH_SUCCESS:\n上次日志显示 EXIT_CODE:0\n本次实际输出：\nEXIT_CODE:1\n'),
      'FAIL'
    );
    // 尾行是 EXIT_CODE:0（允许尾随空白）→ PASS
    assert.equal(loop.classifySignal('BASH_SUCCESS:\npong\nEXIT_CODE:0'), 'PASS');
    assert.equal(loop.classifySignal('BASH_SUCCESS:\npong\nEXIT_CODE:0  \n'), 'PASS');
  });

  it('多调用步骤一成一败仍判 PASS（现有语义保持——显式 PASS 子句优先于 FAIL/ERROR）', () => {
    // 注：这是可接受的判定粒度——parts 以 '---' 连接后，任一调用带 PASS 尾标
    // 即整步 PASS。红队报告确认该粒度可接受，测试在此锁定防止回归。
    assert.equal(
      loop.classifySignal(
        'TOOL_ERROR: DENIED_BY_USER ✗ bash: rm -rf /\n---\nBASH_SUCCESS:\npong\nEXIT_CODE:0\nVERIFICATION: PASS'
      ),
      'PASS'
    );
  });
});

// ==================== 包B：ALL_TESTS_PASSED 分段尾锚定（残余全文 includes 清理） ====================
// 【原缺陷】classifySignal 及 run() 内 4 处 `verificationResult.includes('ALL_TESTS_PASSED')`
// ——读到含该字面量的文件正文（如本仓库历史日志、源码）即假"验证通过"。
// 修复：全部改为与 VERIFICATION: PASS 同款的分段尾锚定（segEndsWith）。
describe('包B ALL_TESTS_PASSED 尾锚定（残余全文 includes 清理）', () => {
  const loop: any = new VerifyCritiqueLoop({}, {}, {});

  it('【原缺陷】正文含 ALL_TESTS_PASSED 字样但结尾不是它 → 不判 PASS', () => {
    const r = [
      'READ_SUCCESS: docs/release-notes.md',
      '历史发布日志里记录过一次 ALL_TESTS_PASSED',
      'VERIFICATION: NEUTRAL',
    ].join('\n');
    assert.equal(loop.classifySignal(r), 'PARTIAL', '读到含该字面量的文件正文不是验证通过');
  });

  it('多调用：字面量只出现在段落中部、唯一尾标是 NEUTRAL → 不判 PASS', () => {
    const r = [
      'READ_SUCCESS: a.log\ngrep 命中行: ALL_TESTS_PASSED',
      'READ_SUCCESS: b.txt\nVERIFICATION: NEUTRAL',
    ].join('\n---\n');
    assert.equal(loop.classifySignal(r), 'PARTIAL');
  });

  it('结尾确实为 ALL_TESTS_PASSED → PASS（smoke mock 形状保持）', () => {
    assert.equal(loop.classifySignal('ALL_TESTS_PASSED'), 'PASS');
    assert.equal(loop.classifySignal('BASH_SUCCESS:\npong\nALL_TESTS_PASSED'), 'PASS');
    assert.equal(loop.classifySignal('BASH_SUCCESS:\npong\nALL_TESTS_PASSED  \n'), 'PASS', '容忍尾随空白');
    assert.equal(loop.classifySignal('VERIFICATION: ALL_TESTS_PASSED'), 'PASS', 'Termination mock 形状');
  });

  it('多调用一成一败：PASS 段存在即过（粒度锁定不回归）', () => {
    assert.equal(
      loop.classifySignal('TOOL_ERROR: x\n---\nALL_TESTS_PASSED'),
      'PASS'
    );
  });

  it('loop 级：engine 结果正文含字面量（非尾标）→ success=false、不 completed', async () => {
    const alwaysRead = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <read_file><file_path>docs.md</file_path></read_file>
</>
`;
    const model = { calls: 0, async complete(_p: string) { this.calls++; return alwaysRead; } };
    const engine = {
      async execute(_calls: any[]) {
        return 'READ_SUCCESS: docs.md\n日志正文提及 ALL_TESTS_PASSED\nVERIFICATION: NEUTRAL';
      },
    };
    const loop = makeLoop(model, engine, { maxSteps: 2 });
    const out = await loop.run('读文档');
    assert.equal(out.success, false, '字面量不是 PASS（旧实现 includes 假成功）');
    assert.equal(out.stopReason, 'max-steps', '无真实验证 → 不 completed');
  });
});

describe('0.7.3 T1#1 loop 级：NEUTRAL=PARTIAL 不计真实验证（不清零断言）', () => {
  it('read_file 成功（NEUTRAL）不置 hasPerformedRealVerification、不清零 stepsSinceLastVerification', async () => {
    const alwaysRead = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <read_file>
    <file_path>src/a.ts</file_path>
  </read_file>
</>
`;
    const model = {
      calls: 0,
      async complete(_p: string) { this.calls++; return alwaysRead; },
    };
    const engine = {
      async execute(_calls: any[]) {
        // 真实 engineAdapter 对 read_file 的 describeResult 形状
        return 'READ_SUCCESS: src/a.ts\nexport const x = 1;\nVERIFICATION: NEUTRAL';
      },
    };
    const loop = makeLoop(model, engine, { maxSteps: 3 });
    const out = await loop.run('只读任务');
    assert.equal(out.steps.length, 3, 'PARTIAL 不触发连错保护，跑到 maxSteps');
    assert.equal(out.success, false, 'NEUTRAL 不是 PASS——success=false');
    const status = loop.getIronLawStatus();
    assert.equal(status.hasPerformedRealVerification, false, 'NEUTRAL 不计真实验证');
    assert.equal(status.stepsSinceLastVerification, 3, '连败/未验证计数不清零');
  });
});

describe('0.7.3 T1#1 engineAdapter.describeResult 确定性尾标（真实引擎形状）', () => {
  function tmpWs(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-signal-'));
  }

  it('write_file 成功 → 结果尾行 VERIFICATION: PASS；read_file → NEUTRAL；bash 失败 → 无 VERIFICATION', async () => {
    const ws = tmpWs();
    const adapter = createEngineAdapter({
      workspaceRoot: ws,
      tierConfig: TierRegistry.get('standard'),
      approvalMode: 'full',
    });
    try {
      const writeRes = await adapter.execute([
        {
          toolName: 'write_file',
          params: [
            { name: 'file_path', value: 'hello.txt' },
            { name: 'content', value: 'pong' },
          ],
          rawBlock: '',
        } as any,
      ]);
      // 评审 P1-2 语义：写盘成功 ≠ 验证通过——write/edit 尾标是 APPLIED
      // （classifySignal=PARTIAL：清零连败但不计 PASS/不触发 completed）
      assert.ok(writeRes.includes('VERIFICATION: APPLIED'), `写文件结果必须带 APPLIED 尾标：${writeRes}`);
      assert.ok(/\nVERIFICATION: APPLIED\s*$/.test(writeRes), 'APPLIED 尾标必须在结果尾部');
      assert.ok(!writeRes.includes('VERIFICATION: PASS'), '写文件不得携带 PASS 尾标（PASS 留给真实验证命令）');

      const readRes = await adapter.execute([
        { toolName: 'read_file', params: [{ name: 'file_path', value: 'hello.txt' }], rawBlock: '' } as any,
      ]);
      assert.ok(readRes.startsWith('READ_SUCCESS: hello.txt'), `读取头行形状：${readRes}`);
      assert.ok(/\nVERIFICATION: NEUTRAL\s*$/.test(readRes), '只读成功必须带 NEUTRAL 尾标');

      const failRes = await adapter.execute([
        { toolName: 'bash', params: [{ name: 'command', value: 'exit 3' }], rawBlock: '' } as any,
      ]);
      assert.ok(failRes.includes('TOOL_ERROR'), `失败分支形状：${failRes}`);
      assert.ok(!failRes.includes('VERIFICATION:'), '失败分支绝不追加 VERIFICATION 行');

      // 落盘确证：真实引擎（非 mock）真的写了文件
      assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf-8'), 'pong');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
