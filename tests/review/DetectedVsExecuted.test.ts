// tests/review/DetectedVsExecuted.test.ts
// C6（ROADMAP-NEXT §3.2）：Reviewer verificationEvidence 两态语义——
// "探测到测试脚本"只是 detected（passed 恒 false），真实执行后才 executed-pass。
// 探测不得冒充验证证据（旧行为：探测即 passed:true 是语义谎言）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Reviewer } from '../../src/review/Reviewer.js';

let ws: string;

function mkWorkspace(): string {
  const dir = join(tmpdir(), 'pangu-review-c6-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(join(dir, 'src'), { recursive: true });
  // 被 review 的文件（真实读取 → executed-pass 证据）
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x: number = 1;\n');
  // 带 test 脚本的 package.json（探测 → detected 证据）
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'c6-fixture',
    scripts: {
      test: 'node --test "tests/**/*.test.ts"',
      'test:unit': 'node --test tests/unit/',
      lint: 'echo lint',
    },
  }, null, 2));
  return dir;
}

describe('C6: detected vs executed-pass semantics', () => {
  afterEach(() => { if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true }); });

  it('probed test scripts are status=detected with passed=false (never fake-pass)', async () => {
    ws = mkWorkspace();
    const report = await new Reviewer(null, 'standard').review('src/index.ts', ws);

    const npmTest = report.verificationEvidence.find(e => e.command === 'npm test');
    assert.ok(npmTest, 'npm test probe must be present');
    assert.equal(npmTest.status, 'detected');
    assert.equal(npmTest.passed, false, '探测到测试脚本不得标 passed=true');
    assert.ok(npmTest.result.includes('未执行'), `文案必须写明未执行: ${npmTest.result}`);

    const unit = report.verificationEvidence.find(e => e.command === 'npm run test:unit');
    assert.ok(unit, 'other-script probe must be present');
    assert.equal(unit.status, 'detected');
    assert.equal(unit.passed, false);
  });

  it('a real Read of an existing file is status=executed-pass', async () => {
    ws = mkWorkspace();
    const report = await new Reviewer(null, 'standard').review('src/index.ts', ws);

    const read = report.verificationEvidence.find(e => e.command === 'Read: src/index.ts');
    assert.ok(read, 'read evidence must be present');
    assert.equal(read.status, 'executed-pass', '真实发生的读取才算 executed-pass');
    assert.equal(read.passed, true);
  });

  it('summary separates executed evidence from detected-only probes', async () => {
    ws = mkWorkspace();
    const report = await new Reviewer(null, 'standard').review('src/index.ts', ws);

    assert.ok(report.summary.includes('仅探测'), `summary 必须区分两态: ${report.summary}`);
    assert.ok(report.summary.includes('已执行'), `summary 必须点名已执行项: ${report.summary}`);
  });
});
