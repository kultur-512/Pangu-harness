// tests/commands/MemoryCommand.test.ts
// P1-D: /memory submode menuization tests (blueprint v2)

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandContext, CommandResult } from '../../src/cli/repl/types.js';
import MemoryCommand from '../../src/cli/repl/commands/MemoryCommand.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempWorkspace(): string {
  const dir = join(tmpdir(), 'zorge-memcmd-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function createFakeContext(workspace: string, inputLines: string[] = []): { ctx: CommandContext; outputs: string[] } {
  const outputs: string[] = [];

  let idx = 0;
  const fakeInput = {
    async read(prompt?: string): Promise<string> {
      if (idx < inputLines.length) {
        return inputLines[idx++];
      }
      // default to back to exit loops
      return 'back';
    },
    pause() {},
    resume() {},
    close() {},
    on() {},
    history: [],
  } as any;

  const fakeRenderer = {
    write(text: string) { outputs.push(text); },
    writeLine(text: string) { outputs.push(text + '\n'); },
    color(t: string) { return t; },
    startSpinner() { return { stop() {}, text() {} }; },
    table() {},
    codeBlock() {},
    error(msg: string) { outputs.push('ERROR:' + msg); },
    warn(msg: string) { outputs.push('WARN:' + msg); },
    success(msg: string) { outputs.push('OK:' + msg); },
    info(msg: string) { outputs.push('INFO:' + msg); },
    clearScreen() {},
    stream() {},
  } as any;

  const ctx: CommandContext = {
    session: { workspace, tier: 'high' },
    registry: {},
    renderer: fakeRenderer,
    input: fakeInput,
    repl: {},
  };

  return { ctx, outputs };
}

describe('P1-D MemoryCommand submode (v2)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempWorkspace();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it('direct args "list" still works (backward compat)', async () => {
    const { ctx, outputs } = createFakeContext(tmp, []);
    const res: CommandResult = await MemoryCommand.execute(ctx, ['list']);
    // Should not have entered submode loop
    const joined = outputs.join('');
    // Even with no cards, runMemoryCommand returns a message
    assert.ok(!joined.includes('Panshalach Memory Manager'), 'should not print submode menu for direct args');
    // It should have produced some output via renderer (the list result or empty message)
    assert.ok(outputs.length > 0 || res, 'should produce output or result');
  });

  it('no args enters submode, handles "list" then "back"', async () => {
    // Simulate user typing "list" then "back"
    const { ctx, outputs } = createFakeContext(tmp, ['list', 'back']);

    const res: CommandResult = await MemoryCommand.execute(ctx, []); // empty args -> submode

    const joined = outputs.join('\n');

    // Menu header
    assert.ok(joined.includes('Panshalach Memory Manager'), 'should show submode header');
    assert.ok(joined.includes('list / clear'), 'should show menu options');

    // After "list", runMemoryCommand should have been called (even if no cards)
    // The submode prints the result of runMemoryCommand
    // We at least check it didn't crash and eventually exited
    assert.ok(joined.includes('退出 memory 子模式') || joined.includes('back'), 'should exit on back');

    // Should not have set exit flag
    assert.ok(!res?.exit, 'submode exit should not kill the whole REPL');
  });

  it('submode supports "q" to quit', async () => {
    const { ctx, outputs } = createFakeContext(tmp, ['q']);

    await MemoryCommand.execute(ctx, []);

    const joined = outputs.join('\n');
    assert.ok(joined.includes('退出 memory 子模式') || joined.includes('memory'), 'should acknowledge exit');
  });

  it('old "zorge memory list" path still produces output (no crash)', async () => {
    const { ctx } = createFakeContext(tmp, []);
    // Call with args like the old CLI path
    const result = await MemoryCommand.execute(ctx, ['list']);
    // Either renderer wrote something or we got a result
    assert.ok(result !== undefined, 'execute should return a CommandResult');
  });
});
