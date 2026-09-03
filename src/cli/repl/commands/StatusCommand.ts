// src/cli/repl/commands/StatusCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'status',
  description: '查看当前会话状态',
  category: 'state',
  usage: '/status',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const s = ctx.session;
    ctx.renderer.writeLine(ctx.renderer.color('当前状态', 'bold'));
    ctx.renderer.writeLine(`  档位     : ${s.tier}`);
    ctx.renderer.writeLine(`  工作区   : ${s.workspace}`);
    ctx.renderer.writeLine(`  模型     : ${s.model}`);
    ctx.renderer.writeLine(`  Turn 数  : ${s.turns.length}`);
    ctx.renderer.writeLine(`  总 Token : ${s.stats.totalTokens}`);
    ctx.renderer.writeLine(`  总时长   : ${Math.round(s.stats.totalDurationMs / 1000)}s`);
    return {};
  },
};

export default command;
