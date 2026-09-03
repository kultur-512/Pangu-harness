// src/cli/repl/commands/RewindCommand.ts
// P3-3.6: /rewind — turn-granular rollback over file-history checkpoints.
//
//   /rewind              → list the last 5 turn groups
//   /rewind <N|last>     → preview diff summary + confirm (y/n)
//   /rewind <N|last> --dry-run → preview only, zero side effects
//
// /undo keeps its single-checkpoint semantics untouched.

import type { Command, CommandContext, CommandResult } from '../types.js';

const command: Command = {
  name: 'rewind',
  description: '按回合回放变更（/rewind 列表；/rewind <N|last> [--dry-run] 回放到该回合结束态；bash 副作用排除）',
  category: 'session',
  usage: '/rewind [N|last] [--dry-run]',
  execute: async (ctx: CommandContext, args: string[]): Promise<CommandResult> => {
    const { listByTurn, previewRewindToTurn } = await import('../../../tools/fileHistory.js');
    const turns: Array<{ id: string; timestamp: number; userInput?: string }> =
      ctx.session.turns.map((t: any) => ({ id: t.id, timestamp: t.timestamp, userInput: t.userInput }));
    const ws = ctx.session.workspace || process.cwd();

    const dryRun = args.includes('--dry-run');
    const targetArg = args.find((a) => !a.startsWith('--')) || '';

    // ---- list mode ----
    if (!targetArg) {
      const groups = listByTurn(ws, turns).filter((g) => g.turnId !== null).slice(-5).reverse();
      if (groups.length === 0) {
        ctx.renderer.warn('暂无可回放的回合变更（file-history 为空）');
        return { message: 'none' };
      }
      ctx.renderer.writeLine(ctx.renderer.color('按回合的变更（新 → 旧）：', 'bold'));
      groups.forEach((g, i) => {
        const ts = g.turnTs ? new Date(g.turnTs).toLocaleTimeString() : '-';
        ctx.renderer.writeLine(`  ${i + 1}. [${ts}] ${g.turnLabel} · ${g.filesChanged.length} 文件 · ${g.checkpoints.length} checkpoint`);
        for (const f of g.filesChanged.slice(0, 4)) ctx.renderer.writeLine(ctx.renderer.color(`      · ${f}`, 'gray'));
      });
      ctx.renderer.writeLine(ctx.renderer.color('回放：/rewind <序号|last> [--dry-run]', 'gray'));
      return { message: 'ok' };
    }

    // ---- preview / apply mode ----
    const groups = listByTurn(ws, turns).filter((g) => g.turnId !== null);
    if (groups.length === 0) {
      ctx.renderer.warn('暂无可回放的回合变更');
      return { message: 'none' };
    }
    const target = targetArg === 'last'
      ? groups[groups.length - 1]
      : (/^\d+$/.test(targetArg)
          ? [...groups].reverse()[parseInt(targetArg, 10) - 1]
          : groups.find((g) => g.turnId === targetArg));

    if (!target || !target.turnTs) {
      ctx.renderer.warn(`未找到目标回合: ${targetArg}`);
      return { message: 'not found' };
    }

    const preview = previewRewindToTurn(ws, target.turnTs, [...turns]);
    if (!preview.ok) {
      ctx.renderer.warn(preview.message);
      return { message: 'nothing to rewind' };
    }

    ctx.renderer.writeLine(ctx.renderer.color(`回放到「${target.turnLabel}」结束态：`, 'bold'));
    const diffLines = preview.diff || [];
    for (const h of diffLines.slice(0, 40)) {
      ctx.renderer.writeLine(ctx.renderer.color(
        `${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`,
        h.type === 'add' ? 'green' : h.type === 'del' ? 'red' : 'gray'
      ));
    }
    if (diffLines.length > 40) ctx.renderer.writeLine(ctx.renderer.color(`… ${diffLines.length - 40} 行省略 …`, 'gray'));

    if (dryRun) {
      ctx.renderer.writeLine(ctx.renderer.color('（--dry-run：以上为预览，未执行任何写盘）', 'cyan'));
      return { message: 'dry-run', data: preview };
    }

    // confirm (via the existing InputReader — same input loop contract)
    let answer = 'n';
    try {
      answer = (await ctx.input.read('确认回放? (y/n) > ')).trim().toLowerCase();
    } catch {
      answer = 'n';
    }
    if (answer !== 'y') {
      ctx.renderer.warn('已取消。');
      return { message: 'cancelled' };
    }

    // apply — preview was side-effect free; performing re-checkpoints first
    const { rewindToTurn } = await import('../../../tools/fileHistory.js');
    const result = rewindToTurn(ws, target.turnTs, turns);
    if (result.ok) {
      ctx.renderer.success(result.message);
      try {
        const { appendRewindAudit } = await import('../rolloutStore.js');
        appendRewindAudit(ctx.session.id, target.turnTs);
      } catch {}
    } else {
      ctx.renderer.warn(result.message);
    }
    return { message: result.message, data: result };
  },
};

export default command;
