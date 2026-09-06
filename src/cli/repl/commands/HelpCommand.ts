// src/cli/repl/commands/HelpCommand.ts
import type { Command, ColorName, CommandContext, CommandResult } from '../types.js';

// P2-3（批次 B）：分组渲染抽取为纯函数 — classic（registry）/ line（sseInteractive）
// / 统一派发器三处共用同一份视图，保证输出一致。
export interface HelpLine {
  text: string;
  style?: ColorName;
}

export interface HelpView {
  lines: HelpLine[];
  /** /help <未知命令> 时的未找到消息（走 result.message 通道）。 */
  message?: string;
}

/** 由命令列表构建分组帮助视图（不直接写终端，便于三处复用与测试）。 */
export function buildHelpView(all: Command[], args: string[] = []): HelpView {
  if (args[0]) {
    const q = String(args[0]).replace(/^\//, '');
    const target = all.find((c) => c.name === q || (c.aliases || []).includes(q));
    if (target) {
      const lines: HelpLine[] = [
        {
          text: `/${target.name}` + (target.aliases ? ` (${target.aliases.map((a: string) => '/' + a).join(', ')})` : ''),
          style: 'bold',
        },
        { text: target.description },
      ];
      if (target.usage) lines.push({ text: '用法: ' + target.usage });
      return { lines };
    }
    return { lines: [], message: `未找到命令: ${args[0]}` };
  }

  const lines: HelpLine[] = [{ text: '可用命令:', style: 'bold' }];
  const byCat: Record<string, Command[]> = {};
  for (const c of all) {
    (byCat[c.category] ||= []).push(c);
  }
  for (const cat of Object.keys(byCat)) {
    lines.push({ text: `[${cat}]`, style: 'cyan' });
    for (const c of byCat[cat]) {
      lines.push({ text: `  /${c.name.padEnd(12)} ${c.description}` });
    }
  }
  lines.push({ text: '' });
  lines.push({ text: '输入 /help <命令> 查看详细用法' });
  return { lines };
}

const command: Command = {
  name: 'help',
  aliases: ['?', 'h'],
  description: '显示帮助信息',
  category: 'system',
  usage: '/help [command]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const view = buildHelpView(ctx.registry.list(), args);
    if (view.message) return { message: view.message };
    for (const l of view.lines) {
      ctx.renderer.writeLine(l.style ? ctx.renderer.color(l.text, l.style) : l.text);
    }
    return {};
  },
};

export default command;
