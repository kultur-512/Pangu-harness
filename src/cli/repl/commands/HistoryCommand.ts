// src/cli/repl/commands/HistoryCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'history',
  description: '查看本会话命令历史',
  category: 'system',
  usage: '/history',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const turns = ctx.session.turns;
    if (turns.length === 0) {
      ctx.renderer.writeLine('当前会话还没有历史记录');
      return {};
    }
    ctx.renderer.writeLine(ctx.renderer.color('最近执行记录:', 'bold'));
    turns.slice(-10).forEach((t: any, i: number) => {
      const time = new Date(t.timestamp).toLocaleTimeString();
      ctx.renderer.writeLine(`  [${time}] ${t.userInputType} | ${t.userInput.slice(0, 60)}${t.userInput.length > 60 ? '...' : ''}`);
    });
    return {};
  },
};

export default command;
