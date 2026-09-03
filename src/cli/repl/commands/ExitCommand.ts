// src/cli/repl/commands/ExitCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'exit',
  aliases: ['quit', 'q'],
  description: '退出 REPL',
  category: 'system',
  usage: '/exit',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    return { exit: true, message: '正在退出...' };
  },
};

export default command;
