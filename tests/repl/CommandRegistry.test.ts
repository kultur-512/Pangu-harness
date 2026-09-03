// tests/repl/CommandRegistry.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry } from '../../src/cli/repl/CommandRegistry.js';
import type { Command, CommandContext, CommandResult } from '../../src/cli/repl/types.js';

function makeDummyCommand(name: string, aliases?: string[]): Command {
  return {
    name,
    aliases,
    description: `desc ${name}`,
    category: 'system',
    async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
      return { message: `exec:${name}:${args.join(',')}` };
    },
  };
}

describe('CommandRegistry', () => {
  it('registers and retrieves by name', () => {
    const reg = new CommandRegistry();
    const cmd = makeDummyCommand('help');
    reg.register(cmd);
    assert.equal(reg.get('help'), cmd);
  });

  it('registers and retrieves by alias', () => {
    const reg = new CommandRegistry();
    const cmd = makeDummyCommand('exit', ['quit', 'q']);
    reg.register(cmd);
    assert.equal(reg.get('quit'), cmd);
    assert.equal(reg.get('q'), cmd);
  });

  it('list returns unique commands (no duplicates for aliases)', () => {
    const reg = new CommandRegistry();
    reg.register(makeDummyCommand('help', ['h']));
    reg.register(makeDummyCommand('tier'));
    const list = reg.list();
    assert.equal(list.length, 2);
    const names = list.map(c => c.name).sort();
    assert.deepEqual(names, ['help', 'tier']);
  });

  it('execute dispatches and returns result', async () => {
    const reg = new CommandRegistry();
    reg.register(makeDummyCommand('status'));
    const fakeCtx = {} as CommandContext;
    const res = await reg.execute(fakeCtx, 'status', ['a', 'b']);
    assert.equal(res.message, 'exec:status:a,b');
  });

  it('execute returns message for unknown command', async () => {
    const reg = new CommandRegistry();
    const fakeCtx = {} as CommandContext;
    const res = await reg.execute(fakeCtx, 'nope', []);
    assert.ok((res.message || '').includes('未知命令'));
  });
});
