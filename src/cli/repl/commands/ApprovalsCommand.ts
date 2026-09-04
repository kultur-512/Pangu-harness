// src/cli/repl/commands/ApprovalsCommand.ts
// /approvals — 查看/切换审批模式，清空会话允许清单。
// No args        → show current mode + allowlist
// readonly|default|full → switch mode (persisted with the session)
// clear          → clear the session allow-always list

import type { Command, CommandContext, CommandResult } from '../types.js';

const MODES = ['readonly', 'default', 'full'] as const;

const command: Command = {
  name: 'approvals',
  description: '查看/切换审批模式（readonly|default|full）或 clear 清空本会话放行清单',
  category: 'config',
  usage: '/approvals [readonly|default|full|clear]',
  execute: async (ctx: CommandContext, args: string[]): Promise<CommandResult> => {
    const arg = (args[0] || '').trim().toLowerCase();

    if (!arg) {
      const list = [...ctx.session.sessionApprovalAllowlist];
      ctx.renderer.writeLine(`审批模式: ${ctx.session.approvalMode}`);
      ctx.renderer.writeLine(`本会话放行清单 (${list.length}): ${list.length ? list.join(', ') : '(空)'}`);
      ctx.renderer.writeLine('用法: /approvals readonly|default|full|clear');
      ctx.renderer.writeLine('说明: readonly=只读白名单外全拒；default=写类与白名单外 bash 需确认；full=全放行（danger 仅红标）');
      return { message: 'ok' };
    }

    if (arg === 'clear') {
      ctx.session.clearApprovalAllowlist();
      ctx.renderer.success('本会话放行清单已清空。');
      return { message: 'cleared' };
    }

    if ((MODES as readonly string[]).includes(arg)) {
      ctx.session.updateApprovalMode(arg as any);
      ctx.renderer.success(`审批模式已切换为 ${arg}。`);
      return { message: arg };
    }

    ctx.renderer.error(`未知参数: ${arg}。用法: /approvals [readonly|default|full|clear]`);
    return { message: 'bad usage' };
  },
};

export default command;
