// tests/repl/InitCommand.test.ts
// P1-T13 (L06): /init generates .zorge/AGENTS.md with verification commands
// + feature_list.json template; idempotent (keeps existing without --force).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initCommand from '../../src/cli/repl/commands/InitCommand.js';

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-init-'));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
    name: 'sample', description: 'Sample project',
    scripts: { build: 'tsc', test: 'node --test' },
    devDependencies: { typescript: '^5.0.0' },
  }, null, 2));
});
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

function ctx(over: string = 'n') {
  const out: string[] = [];
  return {
    session: { workspace: ws } as any,
    renderer: {
      success: (m: string) => out.push('ok:' + m),
      warn: (m: string) => out.push('warn:' + m),
      error: (m: string) => out.push('err:' + m),
      info: (m: string) => out.push('info:' + m),
      writeLine: (m: string) => out.push('line:' + m),
    } as any,
    input: { read: async () => over } as any,
    registry: null as any,
    repl: null as any,
    provider: null as any,
  } as any;
}

describe('InitCommand (P1-T13)', () => {
  it('generates AGENTS.md with verification commands + feature_list.json template', async () => {
    await initCommand.execute(ctx('y'), []);
    const agents = fs.readFileSync(path.join(ws, '.zorge', 'AGENTS.md'), 'utf-8');
    assert.ok(agents.includes('# Project Instructions'));
    assert.ok(agents.includes('## Verification commands'));
    assert.ok(agents.includes('node --test'), 'test script detected');
    assert.ok(agents.includes('tsc'), 'build script detected');
    assert.ok(fs.existsSync(path.join(ws, '.zorge', 'feature_list.json')), 'feature template created');
  });

  it('idempotent: existing AGENTS.md kept without --force', async () => {
    fs.mkdirSync(path.join(ws, '.zorge'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.zorge', 'AGENTS.md'), 'ORIGINAL', 'utf-8');
    await initCommand.execute(ctx('n'), []); // answer n → keep
    assert.equal(fs.readFileSync(path.join(ws, '.zorge', 'AGENTS.md'), 'utf-8'), 'ORIGINAL');
    // with --force → overwrite
    await initCommand.execute(ctx('n'), ['--force']);
    assert.ok(fs.readFileSync(path.join(ws, '.zorge', 'AGENTS.md'), 'utf-8').includes('# Project Instructions'));
  });

  it('no package.json → graceful (verification list falls back)', async () => {
    fs.rmSync(path.join(ws, 'package.json'));
    await initCommand.execute(ctx('y'), []);
    const agents = fs.readFileSync(path.join(ws, '.zorge', 'AGENTS.md'), 'utf-8');
    assert.ok(agents.includes('Verification commands'));
  });

  it('AGENTS.md links the Panshalach directory page (A-T10)', async () => {
    await initCommand.execute(ctx('y'), []);
    const agents = fs.readFileSync(path.join(ws, '.zorge', 'AGENTS.md'), 'utf-8');
    assert.ok(agents.includes('目录页'), 'AGENTS.md is a directory page');
    assert.ok(agents.includes('panshalach/README.md'), 'links the Panshalach docs directory page');
  });
});
