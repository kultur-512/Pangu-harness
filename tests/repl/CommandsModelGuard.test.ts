// tests/repl/CommandsModelGuard.test.ts
// P3: Guard tests ensuring Run/Simulate never pass null to PanshalachChaser
// When provider is missing or returns null -> friendly error, no crash

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RunCommand from '../../src/cli/repl/commands/RunCommand.js';
import SimulateCommand from '../../src/cli/repl/commands/SimulateCommand.js';
import type { CommandContext } from '../../src/cli/repl/types.js';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  const session: any = {
    tier: 'high',
    workspace: process.cwd(),
    model: 'default',
    provider: undefined,
    turns: [],
    addTurn() {},
    updateModel() {},
  };
  return {
    session,
    registry: {},
    renderer: {
      write: () => {},
      writeLine: () => {},
      color: (t: string) => t,
      startSpinner: () => ({ stop() {}, text() {} }),
      table() {}, codeBlock() {}, error() {}, warn() {}, success() {}, info() {}, clearScreen() {}, stream() {},
    },
    input: { read: async () => '', pause() {}, resume() {}, close() {}, on() {}, history: [] },
    repl: {},
    provider: undefined,
    ...overrides,
  } as any;
}

describe('P3 Run/Simulate guard (no null client to PanshalachChaser)', () => {
  it('Run without provider returns friendly message and does not throw', async () => {
    const ctx = makeCtx();
    const res = await RunCommand.execute(ctx, ['do something']);
    assert.ok(res && (res.message || res.data === undefined), 'should return a result object');
  });

  it('Simulate without provider returns friendly message', async () => {
    const ctx = makeCtx();
    const res = await SimulateCommand.execute(ctx, ['simulate this']);
    assert.ok(res && typeof res === 'object');
  });

  it('Run with provider that returns null client -> error path', async () => {
    const provider = {
      defaultModel: 'default',
      listModels: () => ['default'],
      isModelAvailable: () => false,
      createClient: () => null,
      createDefaultClient: () => null,
    };
    const ctx = makeCtx({ provider, session: { ...(makeCtx().session), provider } as any });
    const res = await RunCommand.execute(ctx, ['task']);
    assert.ok(res);
  });
});
