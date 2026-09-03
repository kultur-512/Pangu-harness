// src/cli/repl/commands/SimulateCommand.ts
import type { Command, CommandContext, CommandResult, ModelProvider } from '../types.js';
import { PromptBuilder } from '../PromptBuilder.js';
import { TierRegistry } from '../../../tiers/TierConfig.js';
import { expandAtPaths } from '../types.js';

const command: Command = {
  name: 'simulate',
  aliases: ['s'],
  description: '模拟执行任务（不做真实修改）',
  category: 'task',
  usage: 'simulate "任务描述"（支持 @path 展开）',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    let task = args.join(' ').replace(/^["']|["']$/g, '');
    if (!task) return { message: '用法: simulate "你的任务描述"' };

    // P2-A: @path 展开（path.resolve + workspace 前缀检查）
    const { result: pathRes, cleaned } = expandAtPaths(task, ctx.session.workspace || process.cwd());
    if (pathRes.rejected.length > 0) {
      ctx.renderer.warn('@path 拒绝（越界或无法解析）: ' + pathRes.rejected.join(', '));
    }
    if (pathRes.expanded.length > 0) {
      ctx.renderer.writeLine(ctx.renderer.color(`@path 已展开: ${pathRes.expanded.length} 项`, 'gray'));
    }
    const finalTask = (cleaned && cleaned.trim()) ? cleaned : task;

    // P3: Resolve a usable client via provider; never pass null to ZorgeChaser
    const provider: ModelProvider | undefined = ctx.provider || ctx.session.provider;
    const client = provider?.createClient(ctx.session.model) ?? provider?.createDefaultClient();
    if (!client) {
      ctx.renderer.error('未配置可用的模型客户端。');
      const models = provider?.listModels?.() ?? [];
      if (models.length) ctx.renderer.info('可用: ' + models.join(', '));
      return { message: '未提供模型，模拟未执行。' };
    }

    const { ZorgeChaser } = await import('../../../ZorgeChaser.js');
    const chaser = new ZorgeChaser(client, ctx.session.tier);

    // Use the same rich prompt builder as run (tier contract + memory cards)
    const tierConfig = TierRegistry.get(ctx.session.tier);
    const pb = new PromptBuilder(ctx.session, tierConfig);
    const enriched = await pb.buildForTask(finalTask);

    ctx.renderer.info(`[SIMULATE] ${finalTask}`);
    if (ctx.session.turns.length > 0) {
      ctx.renderer.writeLine(ctx.renderer.color(`(上下文: 最近 ${Math.min(3, ctx.session.turns.length)} 轮 + 档位规则已注入)`, 'gray'));
    }

    try {
      const result = await chaser.solveIssue(enriched, ctx.session.workspace, {
        tier: ctx.session.tier as any,
        yes: true,
        dryRun: true,
        memoryPreInjected: true,
      });
      ctx.renderer.success(`模拟完成，预估得分: ${result.score}`);
      return { data: result };
    } catch (err: any) {
      ctx.renderer.error('模拟失败: ' + (err?.message || err));
      return {};
    }
  },
};

export default command;
