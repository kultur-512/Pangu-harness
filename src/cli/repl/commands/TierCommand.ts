// src/cli/repl/commands/TierCommand.ts
// CC 式思考强度滑杆（2026-09-12 真机对标 /effort）：无参 → 打印滑杆块并进入
// 交互选择态（←/→ 调节 · Enter 确认 · Esc 取消，按键消费在 sseInteractive 的
// rl._ttyWrite 层）；带参（名称或编号）→ 即时切换不走选择态。编号与滑杆刻度同序。
import type { Command, CommandContext, CommandResult } from '../types.js';
import { TierRegistry } from '../../../tiers/TierConfig.js';
import { buildEffortSliderBlock } from '../turn/TurnRenderer.js';

const command: Command = {
  name: 'tier',
  description: '查看或切换思考强度（CC 式滑杆，←/→ 调节 Enter 确认）',
  category: 'state',
  usage: '/tier [quick|standard|high|max|ex|pangu|编号]   无参 = 滑杆选择',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const configs = TierRegistry.getAll();
    const tiers = configs.map((c) => c.tier as string);
    const sublabels = configs.map((c) => c.typicalUseCase);

    if (!args[0]) {
      // CC 式滑杆呈现。classic Repl 无 _ttyWrite 按键消费层 → 只展示不进入
      // 交互选择态（选择态由 line 模式 dispatchSlashCommand 内联分支接管）。
      const index = Math.max(0, tiers.indexOf(String(ctx.session.tier || '')));
      for (const line of buildEffortSliderBlock({ tiers, sublabels, index, useColor: true })) {
        ctx.renderer.writeLine(line);
      }
      return {};
    }

    // /tier <名称|编号>：即时切换（编号与滑杆刻度同序）。
    let newTier = args[0].toLowerCase();
    if (/^\d+$/.test(newTier)) {
      const idx = parseInt(newTier, 10);
      if (idx < 1 || idx > tiers.length) {
        return { message: `编号 "${args[0]}" 超出范围（共 ${tiers.length} 档）—— /tier 查看刻度。` };
      }
      newTier = tiers[idx - 1];
    }
    if (!TierRegistry.isTier(newTier)) {
      return { message: `无效档位: ${args[0]}（可用: ${tiers.join(' | ')}）` };
    }
    const normalized = TierRegistry.normalize(newTier);
    ctx.session.updateTier(normalized);
    const sub = sublabels[tiers.indexOf(normalized)] || '';
    ctx.renderer.success(`思考强度已切换: ${normalized}${sub ? ' · ' + sub : ''}`);
    return {};
  },
};

export default command;
