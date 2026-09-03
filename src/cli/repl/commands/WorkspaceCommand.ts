// src/cli/repl/commands/WorkspaceCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';
import { resolve } from 'path';

const command: Command = {
  name: 'workspace',
  aliases: ['ws'],
  description: '查看或切换工作区',
  category: 'state',
  usage: '/workspace [path]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!args[0]) {
      ctx.renderer.writeLine(`当前工作区: ${ctx.session.workspace}`);
      return {};
    }
    const newPath = resolve(args[0]);
    ctx.session.updateWorkspace(newPath);
    ctx.renderer.success(`工作区已切换到: ${newPath}`);
    return {};
  },
};

export default command;
