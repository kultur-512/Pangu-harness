// src/cli/repl/commands/TierCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';
import { TierRegistry } from '../../../tiers/TierConfig.js';

const command: Command = {
  name: 'tier',
  description: '查看或切换当前档位',
  category: 'state',
  usage: '/tier [quick|standard|high|max|ex|zorge]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!args[0]) {
      ctx.renderer.writeLine(`当前档位: ${ctx.session.tier}`);
      ctx.renderer.writeLine('可用档位: quick | standard | high | max | ex | zorge');
      return {};
    }
    const newTier = args[0].toLowerCase() as any;
    if (!TierRegistry.isTier(newTier)) {
      return { message: `无效档位: ${args[0]}` };
    }
    ctx.session.updateTier(newTier);
    ctx.renderer.success(`档位已切换到: ${newTier}`);
    return {};
  },
};

export default command;
