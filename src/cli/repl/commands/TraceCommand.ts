// src/cli/repl/commands/TraceCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'trace',
  description: '查看某条轨迹详情',
  category: 'session',
  usage: '/trace <id>',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const id = args[0];
    if (!id) return { message: '用法: /trace <turn-id>' };
    const turn = ctx.session.turns.find((t: any) => t.id === id);
    if (!turn) return { message: `未找到 turn: ${id}` };
    ctx.renderer.writeLine(JSON.stringify(turn, null, 2));
    return {};
  },
};

export default command;
