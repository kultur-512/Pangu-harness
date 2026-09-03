// src/cli/repl/commands/MemoryCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'memory',
  description: '记忆管理（list/clear/export/import）',
  category: 'session',
  usage: 'memory [list|clear|export|import] ...',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const workspace = ctx.session?.workspace || process.cwd();

    // P1-D: 无参数时进入子模式菜单
    if (!args || args.length === 0) {
      ctx.renderer.writeLine('Zorge Memory Manager');
      ctx.renderer.writeLine('▸ list / clear / refine / export / import / back');

      // eslint-disable-next-line no-constant-condition
      while (true) {
        let line = '';
        try {
          // 使用 REPL 提供的 InputReader
          line = await ctx.input.read('memory> ');
        } catch {
          // 输入流结束或中断
          break;
        }

        const trimmed = (line || '').trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        const sub = parts[0].toLowerCase();

        if (['back', 'exit', 'q', 'quit'].includes(sub)) {
          ctx.renderer.writeLine('退出 memory 子模式。');
          break;
        }

        try {
          const { runMemoryCommand } = await import('../../MemoryCommand.js');
          const result = await runMemoryCommand(parts, workspace);
          if (result) ctx.renderer.writeLine(result);
        } catch (err: any) {
          ctx.renderer.error('Memory 子模式错误: ' + (err?.message || err));
        }
      }

      return {};
    }

    // 有参数：兼容旧用法（直接执行）
    const { runMemoryCommand } = await import('../../MemoryCommand.js');
    try {
      const result = await runMemoryCommand(args, workspace);
      ctx.renderer.writeLine(result);
      return {};
    } catch (err: any) {
      ctx.renderer.error('Memory 命令失败: ' + (err?.message || err));
      return {};
    }
  },
};

export default command;
