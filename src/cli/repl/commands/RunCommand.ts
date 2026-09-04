// src/cli/repl/commands/RunCommand.ts
import type { Command, CommandContext, CommandResult, ModelProvider } from '../types.js';
import { PromptBuilder } from '../PromptBuilder.js';
import { TierRegistry } from '../../../tiers/TierConfig.js';
import { expandAtPaths } from '../types.js';

const command: Command = {
  name: 'run',
  aliases: ['r'],
  description: '执行任务',
  category: 'task',
  usage: 'run "任务描述" 或直接输入任务描述（支持 @path 展开）',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    let task = args.join(' ').replace(/^["']|["']$/g, '');
    if (!task) {
      return { message: '用法: run "你的任务描述"' };
    }

    // @path 展开（path.resolve + workspace 前缀检查）
    const { result: pathRes, cleaned } = expandAtPaths(task, ctx.session.workspace || process.cwd());
    if (pathRes.rejected.length > 0) {
      ctx.renderer.warn('@path 拒绝（越界或无法解析）: ' + pathRes.rejected.join(', '));
    }
    if (pathRes.expanded.length > 0) {
      ctx.renderer.writeLine(ctx.renderer.color(`@path 已展开: ${pathRes.expanded.length} 项`, 'gray'));
    }
    const finalTask = (cleaned && cleaned.trim()) ? cleaned : task;

    // Resolve a usable client via provider; never pass null to PanshalachChaser
    const provider: ModelProvider | undefined = ctx.provider || ctx.session.provider;
    const client = provider?.createClient(ctx.session.model) ?? provider?.createDefaultClient();
    if (!client) {
      ctx.renderer.error('未配置可用的模型客户端。使用 /model <name> 或检查配置。');
      const models = provider?.listModels?.() ?? [];
      if (models.length) ctx.renderer.info('可用模型: ' + models.join(', '));
      return { message: '未提供模型，任务未执行。' };
    }

    const { PanshalachChaser } = await import('../../../PanshalachChaser.js');
    const chaser = new PanshalachChaser(client, ctx.session.tier);

    // Build rich prompt (tier contract + memory cards + recent context)
    const tierConfig = TierRegistry.get(ctx.session.tier);
    const pb = new PromptBuilder(ctx.session, tierConfig);
    const enriched = await pb.buildForTask(finalTask);

    ctx.renderer.info(`开始执行: ${finalTask}`);
    if (ctx.session.turns.length > 0) {
      ctx.renderer.writeLine(ctx.renderer.color(`(上下文: 最近 ${Math.min(3, ctx.session.turns.length)} 轮 + 档位规则已注入)`, 'gray'));
    }

    // Push to ink bridge if present (rich UI)
    const inkBridge = (ctx as any).inkBridge || (ctx.repl && ctx.repl.inkBridge);
    if (inkBridge) {
      try {
        inkBridge.pushFeed?.({ type: 'text', text: `开始执行: ${finalTask}`, level: 'info' });
        if (ctx.session.turns.length > 0) {
          inkBridge.pushFeed?.({
            type: 'text',
            text: `(上下文: 最近 ${Math.min(3, ctx.session.turns.length)} 轮 + 档位规则已注入)`,
            level: 'info',
          });
        }
      } catch {}
    }

    const start = Date.now();
    try {
      const result = await chaser.solveIssue(enriched, ctx.session.workspace, {
        tier: ctx.session.tier as any,
        yes: true,
        memoryPreInjected: true,
        onStep: (event: any) => {
          if (event.type === 'step') {
            ctx.renderer.writeLine(`[Step ${event.stepNumber}] ${event.thinking || event.plan || ''}`);
          }
          if (event.type === 'critique') {
            ctx.renderer.writeLine(ctx.renderer.color('Critique: ' + event.critique, 'yellow'));
          }

          // Forward to ink bridge for rich UI
          const b = inkBridge;
          if (b) {
            if (event.type === 'step' && typeof b.pushStep === 'function') b.pushStep(event);
            else if (event.type === 'critique' && typeof b.pushCritique === 'function') b.pushCritique(event);
            else b.pushFeed?.(event);
          }
        },
      });

      const duration = Date.now() - start;
      ctx.renderer.success(`完成 (${duration}ms) 得分: ${result.score}`);

      ctx.session.addTurn({
        id: Date.now().toString(36),
        timestamp: Date.now(),
        userInput: finalTask,
        userInputType: 'task',
        tier: ctx.session.tier,
        durationMs: duration,
        result: {
          success: result.success,
          summary: `score=${result.score}`,
          budgetReport: result.budgetReport,
        },
      });

      return { data: result };
    } catch (err: any) {
      ctx.renderer.error('任务失败: ' + (err?.message || err));
      return { message: '执行出错' };
    }
  },
};

export default command;
