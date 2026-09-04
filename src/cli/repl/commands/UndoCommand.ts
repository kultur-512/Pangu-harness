// src/cli/repl/commands/UndoCommand.ts
// /undo — restore the last real write via the file-history checkpoint.
// Optional arg: a workspace-relative path to undo only that file.

import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'undo',
  description: '撤销最近一次真实写盘（file-history 还原，显示 diff）；/undo <path> 只还原该文件',
  category: 'session',
  usage: '/undo [path]',
  execute: async (ctx: CommandContext, args: string[]): Promise<CommandResult> => {
    const rel = (args[0] || '').trim() || undefined;
    const { undoLatest } = await import('../../../tools/fileHistory.js');
    const r = undoLatest(ctx.session.workspace || process.cwd(), rel);

    if (!r.ok) {
      ctx.renderer.warn(r.message);
      return { message: 'nothing to undo' };
    }

    ctx.renderer.success(r.message);
    if (r.diff && r.diff.length > 0) {
      for (const h of r.diff.slice(0, 40)) {
        ctx.renderer.writeLine(ctx.renderer.color(
          `${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`,
          h.type === 'add' ? 'green' : h.type === 'del' ? 'red' : 'gray'
        ));
      }
      if (r.diff.length > 40) {
        ctx.renderer.writeLine(ctx.renderer.color(`… ${r.diff.length - 40} 行省略 …`, 'gray'));
      }
    }
    return { message: r.message, data: { rel: r.rel, diff: r.diff } };
  },
};

export default command;
