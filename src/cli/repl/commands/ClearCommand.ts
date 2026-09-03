// src/cli/repl/commands/ClearCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'clear',
  description: '清屏',
  category: 'system',
  usage: '/clear',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    ctx.renderer.clearScreen();
    return {};
  },
};

export default command;
