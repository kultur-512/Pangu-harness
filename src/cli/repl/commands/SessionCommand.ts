// src/cli/repl/commands/SessionCommand.ts
import type { Command, CommandContext, CommandResult } from '../types.js';
import { SessionStore } from '../SessionStore.js';

let store: SessionStore | null = null;

function getStore(): SessionStore {
  if (!store) store = new SessionStore();
  return store;
}

const command: Command = {
  name: 'session',
  description: '会话管理 (save/load/sessions)',
  category: 'session',
  usage: '/session [save|load|list] [name]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const storeInstance = getStore();
    const sub = args[0] || 'list';

    if (sub === 'save') {
      const name = args[1] || `session-${Date.now()}`;
      ctx.session.name = name;
      storeInstance.save(ctx.session);
      ctx.renderer.success(`会话已保存: ${name}`);
      return {};
    }

    if (sub === 'load') {
      const name = args[1];
      if (!name) return { message: '用法: /session load <name|id>' };
      const all = storeInstance.list();
      const found = all.find(s => s.id === name || s.name === name);
      if (!found) return { message: `未找到会话: ${name}` };
      const loaded = storeInstance.load(found.id);
      if (loaded) {
        // B4: swapping ctx.session alone is a no-op — buildContext() reads
        // Repl.session on every command. Route through Repl.setSession so the
        // swap actually takes effect (classic path); the interactive path
        // (sseInteractive) has its own in-place session and does not use this
        // command.
        const repl = (ctx as any).repl;
        if (repl && typeof repl.setSession === 'function') {
          repl.setSession(loaded);
        } else {
          ctx.session = loaded;
        }
        ctx.renderer.success(`已加载会话: ${found.name || found.id}`);
      }
      return {};
    }

    if (sub === 'list' || sub === 'sessions') {
      const list = storeInstance.list();
      if (list.length === 0) {
        ctx.renderer.writeLine('没有保存的会话');
        return {};
      }
      ctx.renderer.writeLine(ctx.renderer.color('保存的会话:', 'bold'));
      list.forEach(s => {
        ctx.renderer.writeLine(`  ${s.id.slice(0, 8)}  ${s.name || '(无名)'}  ${new Date(s.updatedAt).toLocaleString()}  ${s.tier}`);
      });
      return {};
    }

    return { message: '用法: /session save|load|list' };
  },
};

export default command;
