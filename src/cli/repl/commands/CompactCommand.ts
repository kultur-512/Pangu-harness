// src/cli/repl/commands/CompactCommand.ts
// /compact — summarize old turns, keep recent ones, print token drop.

import type { Command, CommandContext, CommandResult } from '../types.js';
import { compactSession, estimateSessionTokens } from '../compactService.js';

const command: Command = {
  name: 'compact',
  description: '压缩会话历史（摘要替代旧轮次，保留最近 6 轮）并显示上下文估算下降',
  category: 'session',
  usage: '/compact',
  execute: async (ctx: CommandContext, _args: string[]): Promise<CommandResult> => {
    const provider = ctx.provider || ctx.session.provider;
    const client = provider?.createClient(ctx.session.model) ?? provider?.createDefaultClient() ?? null;
    const r = await compactSession(ctx.session, client);

    if (!r.ok) {
      ctx.renderer.warn(r.message);
      return { message: 'nothing to compact' };
    }
    ctx.renderer.success(r.message);
    const preview = r.summary.length > 400 ? r.summary.slice(0, 400) + '…' : r.summary;
    ctx.renderer.writeLine(ctx.renderer.color('摘要预览:', 'gray'));
    ctx.renderer.writeLine(preview);
    void estimateSessionTokens;
    return { message: r.message, data: r };
  },
};

export default command;
