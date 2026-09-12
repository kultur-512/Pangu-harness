// src/cli/repl/commands/RunCommand.ts
import type { Command, CommandContext, CommandResult, ModelProvider } from '../types.js';
import { expandAtPaths } from '../types.js';
import { extractChangedFiles, extractVerifyCommands, mapOutcome } from '../../../loop/trajectory.js';

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

    // Resolve a usable client via provider; never pass null to runAgentTask
    const provider: ModelProvider | undefined = ctx.provider || ctx.session.provider;
    const client = provider?.createClient(ctx.session.model) ?? provider?.createDefaultClient();
    if (!client) {
      ctx.renderer.error('未配置可用的模型客户端。使用 /model <name> 或检查配置。');
      const models = provider?.listModels?.() ?? [];
      if (models.length) ctx.renderer.info('可用模型: ' + models.join(', '));
      return { message: '未提供模型，任务未执行。' };
    }

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
    // R6 评测观测：捕获 memory.finalized 事件（completed 时 finalizeTaskMemory 发出，
    // 带 verifiedCardIds/refined 明细），任务结束后与 result.injectedCardIds 合成审计行。
    let memFinalized: any = null;
    try {
      // U2/U3: route through runAgentTask so the one-shot / classic path also
      // gets TaskState integration (requirement event, verified/failure event,
      // TaskStateStore fold).  Previously this path called chaser.solveIssue()
      // directly and bypassed the control plane entirely.
      const { runAgentTask } = await import('../../../server/runAgentTask.js');

      const result = await runAgentTask(
        {
          task: finalTask,
          tier: ctx.session.tier,
          workspace: ctx.session.workspace,
          model: ctx.session.model,
          session: ctx.session,
        },
        {
          provider,
          signal: ctx.signal,
          approvalMode: ctx.session.approvalMode,
          sessionAllowlist: ctx.session.sessionApprovalAllowlist,
          approvalBridge: ctx.approvalBridge,
          onEvent: (event: any) => {
            if (event.type === 'step') {
              ctx.renderer.writeLine(`[Step ${event.stepNumber}] ${event.thinking || event.plan || ''}`);
            }
            if (event.type === 'critique') {
              ctx.renderer.writeLine(ctx.renderer.color('Critique: ' + event.critique, 'yellow'));
            }
            if (event.type === 'memory.finalized') {
              memFinalized = event;
            }

            // Forward to ink bridge for rich UI
            const b = inkBridge;
            if (b) {
              if (event.type === 'step' && typeof b.pushStep === 'function') b.pushStep(event);
              else if (event.type === 'critique' && typeof b.pushCritique === 'function') b.pushCritique(event);
              else b.pushFeed?.(event);
            }
          },
        }
      );

      const duration = Date.now() - start;
      // 四态文案：completed→已通过验证；answered→已回复；error→执行失败；其余→未通过验证
      const stopReason = result.stopReason;
      const summary = stopReason === 'completed' ? '已通过验证'
        : stopReason === 'answered' ? '已回复'
        : stopReason === 'error' ? '任务执行失败'
        : result.success ? '已通过验证' : '未通过验证';
      // turn 落盘（headless/one-shot 路径此前完全不落 turn——resume 链断裂根因）
      try {
        const { appendTurn } = await import('../rolloutStore.js');
        appendTurn(ctx.session.id, {
          id: `mtx-${Date.now().toString(36)}`,
          timestamp: Date.now(),
          userInput: finalTask,
          userInputType: 'task',
          tier: ctx.session.tier,
          result: {
            success: result.success,
            summary,
            stopReason,
            ...(result.answerText ? { answerText: String(result.answerText).slice(0, 400) } : {}),
            ...(result.partialText ? { partialText: String(result.partialText).slice(0, 400) } : {}),
          },
          role: 'user',
        } as any);
      } catch {}
      if (stopReason === 'error') {
        const errLine = String(result.error || '').split('\n')[0].slice(0, 120);
        ctx.renderer.error(`完成 (${duration}ms) · ${summary}${errLine ? ' · ' + errLine : ''}`);
      } else {
        ctx.renderer.success(`完成 (${duration}ms) · ${summary}`);
      }

      // R6 评测观测：headless/非交互下输出结构化 memory 审计行（run-eval 的
      // parseMemory 从此读取 injectedCardIds/verifiedCardIds/refined——此前 memory
      // 事件只在进程内流转，eval 全部误报零注入）。交互模式不打印（噪声）。
      if (!process.stdout.isTTY || process.env.PANSHA_HEADLESS === '1') {
        try {
          const audit = {
            injectedCardIds: Array.isArray(result.injectedCardIds) ? result.injectedCardIds : [],
            verifiedCardIds: Array.isArray(memFinalized?.verifiedCardIds) ? memFinalized.verifiedCardIds : [],
            refined: memFinalized?.refined ?? { added: 0, merged: 0, written: 0, capped: 0 },
          };
          process.stdout.write('memory.finalized: ' + JSON.stringify(audit) + '\n');
        } catch { /* 审计行 best-effort */ }
      }

      // answered 时把模型正文呈现给用户
      // R1（0.8.1）：改读 result.answerText（runAgentTask 从轨迹末步带出的正文）。
      // 旧实现误读 partialText——那是 aborted 专用字段，answered 时恒空 →
      // headless 路径 answered 正文不可见。
      if (stopReason === 'answered') {
        const answerText = result.answerText || '';
        if (answerText) {
          const preview = answerText.length > 600 ? answerText.slice(0, 597) + '…' : answerText;
          ctx.renderer.writeLine(preview);
        }
      }

      ctx.session.addTurn({
        id: Date.now().toString(36),
        timestamp: Date.now(),
        userInput: finalTask,
        userInputType: 'task',
        tier: ctx.session.tier,
        durationMs: duration,
        result: {
          success: result.success,
          summary,
          budgetReport: result.budgetReport,
          stopReason,
          goal: finalTask,
          changedFiles: result.changedFiles ?? [],
          verifyCmd: result.verifyCmd ?? [],
          outcome: mapOutcome(stopReason),
          // R6（0.8.1）：chat 答案落盘（截 400 字符防膨胀）
          ...(result.answerText ? { answerText: result.answerText.slice(0, 400) } : {}),
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