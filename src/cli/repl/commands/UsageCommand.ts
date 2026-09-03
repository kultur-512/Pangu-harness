// src/cli/repl/commands/UsageCommand.ts
// M2.4: /usage — local usage + cost estimate panel.

import type { Command, CommandContext, CommandResult } from '../types.js';
import { collectUsage, loadPricesFromConfig } from '../usageService.js';

const command: Command = {
  name: 'usage',
  description: '查看本会话用量与本地成本估算（tokens / 上下文 / 最近预算报告）',
  category: 'state',
  usage: '/usage',
  execute: async (ctx: CommandContext, _args: string[]): Promise<CommandResult> => {
    const prices = await loadPricesFromConfig(ctx.session.workspace || process.cwd());
    const r = collectUsage(ctx.session, prices);
    for (const line of r.lines) ctx.renderer.writeLine(line);
    return { message: 'ok', data: r };
  },
};

export default command;
