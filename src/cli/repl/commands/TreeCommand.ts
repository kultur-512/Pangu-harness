// src/cli/repl/commands/TreeCommand.ts
// /tree — session tree navigation.
//   /tree        → render the current session's tree (origin + branch nodes)
//   /tree <id>   → point the user at the node for continuation (equivalent to
//                  resuming that session — /resume <id> or /tree switch)

import type { Command, CommandContext, CommandResult } from '../types.js';
import { listSessionTree, renderSessionTree } from '../rolloutStore.js';

const command: Command = {
  name: 'tree',
  description: '会话树：origin + 分支树（/tree <id> 切节点续写）',
  category: 'state',
  usage: '/tree [<sessionId>]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const { listSessionTree, renderSessionTree } = await import('../rolloutStore.js');
    // B11: Session has `.id`, not `.sessionId` (was a silent (any) hole).
    const current = (ctx.session as any).id || '';
    const target = args[0] || current;
    const tree = listSessionTree(target);
    ctx.renderer.writeLine(ctx.renderer.color('会话树:', 'bold'));
    for (const line of renderSessionTree(tree, current)) {
      ctx.renderer.writeLine('  ' + line);
    }
    if (args[0] && args[0] !== current) {
      ctx.renderer.info(`切到节点 ${args[0]} 续写: /resume ${args[0]}（等效 tree 节点切换）`);
    } else {
      ctx.renderer.info('分支: /rewind 创建；节点续写: /tree <id> 后 /resume <id>');
    }
    return {};
  },
};

export default command;
