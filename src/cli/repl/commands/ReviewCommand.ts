// src/cli/repl/commands/ReviewCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'review',
  description: '只读审查当前变更（白名单测试）',
  category: 'task',
  usage: 'review [files...]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const { Reviewer } = await import('../../../review/Reviewer.js');
    const diffSpec = args.join(',');
    const reviewer = new Reviewer(null, ctx.session.tier as any);
    try {
      const report = await reviewer.review(diffSpec, ctx.session.workspace);
      ctx.renderer.writeLine(JSON.stringify(report, null, 2));
      return { data: report };
    } catch (err: any) {
      ctx.renderer.error('Review 失败: ' + (err?.message || err));
      return {};
    }
  },
};

export default command;
