// src/cli/repl/commands/ConfigCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'config',
  description: '查看/修改配置',
  category: 'config',
  usage: '/config [get|set] [key] [value]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (args[0] === 'get' || !args[0]) {
      ctx.renderer.writeLine('当前配置 (简化):');
      ctx.renderer.writeLine(`  tier: ${ctx.session.tier}`);
      ctx.renderer.writeLine(`  workspace: ${ctx.session.workspace}`);
      return {};
    }
    if (args[0] === 'set' && args[1]) {
      if (args[1] === 'tier') {
        ctx.session.updateTier(args[2] as any);
        ctx.renderer.success(`tier 已设为 ${args[2]}`);
      }
      return {};
    }
    return { message: '用法: /config get | /config set tier high' };
  },
};

export default command;
