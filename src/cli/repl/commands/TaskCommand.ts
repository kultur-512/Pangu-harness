// src/cli/repl/commands/TaskCommand.ts
// R5 赵天昂 own 端:`/task` 命令入口(今晚切片:仅 status 子命令落地)。
// 数据源:TaskStateStore.get(taskId),不读 R3、不读 session.turns(王佐 9/7 回复)。
// 明天补:/task risks / /task next(纯读)、/task decide(走 update,不走 applyEvents)。
// 见 [[r5-taskstate-contract]] 的 "decide 走 update,不要走 applyEvents" 纪律。

import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatTaskStatus } from './TaskCommand.format.js';

const command: Command = {
  name: 'task',
  description: '任务台账控制面:status / risks / next / decide',
  category: 'task',
  usage: '/task <status|risks|next|decide> [taskId|"决策内容"]',

  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const sub = (args[0] ?? '').toLowerCase();
    const rest = args.slice(1);

    // 默认 taskId 解析:CLI 参数 > session.currentTaskId。
    // store 走动态 import,与 PromptBuilder.ts:387 同款(避免冷启动 + 循环依赖)。
    const { TaskStateStore } = await import('../../../memory/taskState.js');
    const workspace = ctx.session?.workspace ?? process.cwd();
    const store = new TaskStateStore(workspace);

    if (sub === 'status') {
      const taskId = rest[0] ?? ctx.session?.currentTaskId;
      if (!taskId) {
        ctx.renderer.warn('未指定 taskId 且 session 未绑定当前任务。');
        ctx.renderer.info('用法: /task status [taskId]');
        ctx.renderer.info('提示: 先用 /task orig "<需求>" 创建台账,或显式传入 taskId。');
        return { message: '无可展示的任务' };
      }
      const state = store.get(taskId);
      if (!state) {
        ctx.renderer.warn(`task 台账不存在: ${taskId}`);
        ctx.renderer.info('提示: 用 /task orig "<需求>" 创建台账。');
        return { message: 'task 未找到' };
      }
      const lines = formatTaskStatus(state);
      for (const ln of lines) ctx.renderer.writeLine(ln);
      return { data: state };
    }

    // 其他子命令今晚占位,明天补。保留 usage 让用户知道语法。
    if (sub === 'risks' || sub === 'next' || sub === 'decide') {
      ctx.renderer.info(`子命令 /task ${sub} 明日交付(今晚 /task status 最小版先行)。`);
      ctx.renderer.info('用法: ' + command.usage);
      return { message: '子命令待实现' };
    }

    // 未知子命令 / 空入参:打 usage。
    ctx.renderer.writeLine('用法: ' + command.usage);
    return { message: '未知子命令' };
  },
};

export default command;