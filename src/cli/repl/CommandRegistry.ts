// src/cli/repl/CommandRegistry.ts
// Simple command registry following the Command interface in types.ts

import type { Command, CommandContext, CommandResult } from './types.js';

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(cmd: Command): void {
    if (!cmd.name) throw new Error('Command must have a name');
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  list(): Command[] {
    const seen = new Set<string>();
    const result: Command[] = [];
    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result;
  }

  async execute(ctx: CommandContext, name: string, args: string[]): Promise<CommandResult> {
    const cmd = this.get(name);
    if (!cmd) {
      return {
        message: `未知命令: /${name}\n输入 /help 查看可用命令`,
      };
    }
    try {
      return await cmd.execute(ctx, args);
    } catch (err: any) {
      return {
        message: `命令执行出错: ${err?.message || err}`,
      };
    }
  }
}
