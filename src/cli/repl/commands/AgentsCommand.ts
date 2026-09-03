// src/cli/repl/commands/AgentsCommand.ts
// P5-5.3: /agents — sub-agent rollout tree (serial progress list per the
// current engine; never fakes parallelism).
//
//   /agents            → tree view + summary
//   /agents <id>       → single rollout detail (steps / duration / last phase)

import type { Command, CommandContext, CommandResult } from '../types.js';
import { AgentTree, type AgentNode } from '../AgentTree.js';

function treeLines(nodes: AgentNode[]): string[] {
  const lines: string[] = [];
  for (const n of nodes) {
    const indent = n.parent ? '  ' : '';
    const mark = n.parent ? '└─ ' : '├─ ';
    const glyph = n.status === 'running' ? '▶' : n.status === 'done' ? '✓' : n.status === 'failed' ? '✗' : '·';
    const dur = n.durationMs >= 1000 ? `${(n.durationMs / 1000).toFixed(1)}s` : `${n.durationMs}ms`;
    lines.push(`${indent}${mark}${glyph} ${n.id} · ${n.status} · ${n.stepCount} 步 · ${dur}${n.lastPhase ? ` · ${n.lastPhase}` : ''}`);
  }
  return lines;
}

const command: Command = {
  name: 'agents',
  description: '子代理 rollout 树（串行进度；/agents <id> 详情）',
  category: 'session',
  usage: '/agents [id]',
  execute: async (ctx: CommandContext, args: string[]): Promise<CommandResult> => {
    const tree: AgentTree = (ctx.repl as any)?.agentTree ?? (ctx as any).agentTree;
    if (!tree || !(tree instanceof AgentTree)) {
      ctx.renderer.warn('（当前会话无 agent 树 —— 交互层未接线 AgentTree）');
      return { message: 'no tree' };
    }
    const nodes = tree.snapshot();

    if (args[0]) {
      const n = tree.get(args[0]);
      if (!n) {
        ctx.renderer.warn(`未找到 rollout: ${args[0]}`);
        return { message: 'not found' };
      }
      ctx.renderer.writeLine(ctx.renderer.color(`rollout ${n.id}（${n.status}）`, 'bold'));
      ctx.renderer.writeLine(`  步数: ${n.stepCount}`);
      ctx.renderer.writeLine(`  耗时: ${(n.durationMs / 1000).toFixed(1)}s`);
      ctx.renderer.writeLine(`  最近阶段: ${n.lastPhase ?? '-'}`);
      return { message: 'ok' };
    }

    if (nodes.length === 0) {
      ctx.renderer.warn('尚无 rollout 数据（跑一个任务后出现）');
      return { message: 'empty' };
    }

    const done = nodes.filter((n) => n.status === 'done').length;
    const running = nodes.filter((n) => n.status === 'running').length;
    const failed = nodes.filter((n) => n.status === 'failed').length;
    const pending = nodes.filter((n) => n.status === 'pending').length;
    const totalMs = nodes.reduce((a, n) => a + n.durationMs, 0);

    ctx.renderer.writeLine(ctx.renderer.color(
      `${nodes.length} rollouts · ${done} done · ${running} running · ${pending} pending · ${failed} failed · 总耗时 ${(totalMs / 1000).toFixed(1)}s`,
      'bold'
    ));
    for (const line of treeLines(nodes)) {
      ctx.renderer.writeLine(line);
    }
    ctx.renderer.writeLine(ctx.renderer.color(
      '（high+ 档并行 rollout：Promise.allSettled + 写互斥 + 预算聚合；quick/standard 串行）', 'gray'
    ));
    return { message: 'ok' };
  },
};

export default command;
