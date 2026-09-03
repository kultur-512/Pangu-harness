// src/cli/repl/commands/HelpCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'help',
  aliases: ['?', 'h'],
  description: '显示帮助信息',
  category: 'system',
  usage: '/help [command]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const registry = ctx.registry;
    const all = registry.list();

    if (args[0]) {
      const target = registry.get(args[0]);
      if (target) {
        ctx.renderer.writeLine(ctx.renderer.color(`/${target.name}`, 'bold') + (target.aliases ? ` (${target.aliases.map((a: string) => '/' + a).join(', ')})` : ''));
        ctx.renderer.writeLine(target.description);
        if (target.usage) ctx.renderer.writeLine('用法: ' + target.usage);
        return {};
      }
      return { message: `未找到命令: ${args[0]}` };
    }

    ctx.renderer.writeLine(ctx.renderer.color('可用命令:', 'bold'));
    const byCat: Record<string, any[]> = {};
    for (const c of all) {
      (byCat[c.category] ||= []).push(c);
    }
    for (const cat of Object.keys(byCat)) {
      ctx.renderer.writeLine(ctx.renderer.color(`[${cat}]`, 'cyan'));
      for (const c of byCat[cat]) {
        ctx.renderer.writeLine(`  /${c.name.padEnd(12)} ${c.description}`);
      }
    }
    ctx.renderer.writeLine('\n输入 /help <命令> 查看详细用法');
    return {};
  },
};

export default command;
