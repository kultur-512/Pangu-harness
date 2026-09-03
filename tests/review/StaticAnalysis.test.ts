// tests/review/StaticAnalysis.test.ts
// P0-3: Static analysis integration tests (blueprint v1)

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reviewer } from '../../src/review/Reviewer.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createTempWorkspace(hasTsconfig: boolean, hasEslint: boolean = false): string {
  const dir = join(tmpdir(), 'zorge-review-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });

  if (hasTsconfig) {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2));
    // minimal file to avoid empty project issues
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x: number = 1;\n');
  }

  if (hasEslint) {
    writeFileSync(join(dir, '.eslintrc.json'), JSON.stringify({ rules: {} }, null, 2));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test',
      devDependencies: { eslint: '*' }
    }, null, 2));
  }

  return dir;
}

function cleanup(dir: string) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Reviewer - Static Analysis (P0-3)', () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) cleanup(tmp);
  });

  it('returns empty array when no language config is present', async () => {
    tmp = createTempWorkspace(false);
    const reviewer = new Reviewer(null, 'standard');
    const report = await reviewer.review('src/index.ts', tmp);

    assert.ok(Array.isArray(report.staticAnalysis));
    assert.equal(report.staticAnalysis!.length, 0);
  });

  it('detects TypeScript via tsconfig.json and runs tsc', async () => {
    tmp = createTempWorkspace(true);
    const reviewer = new Reviewer(null, 'high');
    const report = await reviewer.review('src/index.ts', tmp);

    assert.ok(report.staticAnalysis && report.staticAnalysis.length > 0);

    const tscResult = report.staticAnalysis!.find(r => r.tool === 'tsc');
    assert.ok(tscResult, 'should have tsc result');
    assert.equal(tscResult!.language, 'typescript');
    assert.equal(tscResult!.triggered, true);
    // output may be empty or contain "error" depending on the project
    assert.ok(typeof tscResult!.output === 'string');
    assert.ok(tscResult!.durationMs >= 0);
  });

  it('marks passed=false and captures output on tsc failure', async () => {
    tmp = createTempWorkspace(true);

    // inject a type error
    writeFileSync(join(tmp, 'src', 'bad.ts'), 'const x: string = 123;\n');

    const reviewer = new Reviewer(null, 'high');
    const report = await reviewer.review('src/bad.ts', tmp);

    const tscResult = (report.staticAnalysis || []).find(r => r.tool === 'tsc');
    assert.ok(tscResult, 'should have tsc result even on failure');
    assert.equal(tscResult!.passed, false);
    assert.ok(tscResult!.output.length > 0, 'should capture error output');
    assert.ok(tscResult!.errorCount > 0 || tscResult!.output.includes('error'), 'should indicate errors');
  });

  it('does not crash and returns results when both tsconfig and eslint present', async () => {
    tmp = createTempWorkspace(true, true);
    const reviewer = new Reviewer(null, 'max');
    const report = await reviewer.review('.', tmp);

    assert.ok(Array.isArray(report.staticAnalysis));
    // At least tsc should be present
    const tools = (report.staticAnalysis || []).map(r => r.tool);
    assert.ok(tools.includes('tsc'));
  });
});
