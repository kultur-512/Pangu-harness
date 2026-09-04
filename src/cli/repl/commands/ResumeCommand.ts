// src/cli/repl/commands/ResumeCommand.ts
// P3-3.5: /resume — list recent rollouts (branches tagged [branch of <origin>]);
// `/resume <id|N>` prints the switch hint (interactive switch happens by
// exiting and running `pangu --resume <id>` — one process per session, CC-style).

import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'resume',
  description: '列出可恢复的会话与分支（[branch] 标记）；/resume <id|序号> 显示切换方式',
  category: 'session',
  usage: '/resume [id|序号]',
  execute: async (ctx: CommandContext, args: string[]): Promise<CommandResult> => {
    const { listRecent, isBranch } = await import('../rolloutStore.js');
    const list = listRecent(10);

    if (list.length === 0) {
      ctx.renderer.warn('暂无可恢复的会话（跑一次任务后自动生成 rollout）');
      return { message: 'none' };
    }

    const pick = (args[0] || '').trim();
    ctx.renderer.writeLine(ctx.renderer.color('可恢复的会话（新到旧）：', 'bold'));
    list.forEach((r, i) => {
      const origin = isBranch(r.id);
      const tag = origin ? ` [branch of ${origin}]` : '';
      ctx.renderer.writeLine(
        `  ${i + 1}. ${r.id}${tag} · ${r.turnCount} 轮 · ${r.firstUserInput ?? ''}`
      );
    });
    ctx.renderer.writeLine(ctx.renderer.color('切换方式：退出后运行 pangu --resume <id>（或 pangu --branch <name> 从当前 fork）', 'gray'));

    if (pick) {
      const byNum = /^\d+$/.test(pick) ? list[parseInt(pick, 10) - 1] : list.find((x) => x.id.startsWith(pick));
      if (byNum) {
        ctx.renderer.success(`切换目标已确认：退出后运行 pangu --resume ${byNum.id}`);
      } else {
        ctx.renderer.warn(`未找到匹配的会话: ${pick}`);
      }
    }
    return { message: 'ok' };
  },
};

export default command;
