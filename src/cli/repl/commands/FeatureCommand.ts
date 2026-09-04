// src/cli/repl/commands/FeatureCommand.ts
// /feature — feature_list.json state management.
//   /feature list               → active + all features
//   /feature add <标题>          → add + make active (one active at a time)
//   /feature done <id> <证据>    → mark done (evidence REQUIRED)
//   /feature next <id> [下一步]   → set active + next step

import type { Command, CommandContext, CommandResult } from '../types.js';
import { loadFeatures, activeFeature, addFeature, markFeatureDone, setFeatureNext } from '../FeatureTracker.js';

const command: Command = {
  name: 'feature',
  description: '特性追踪（feature_list.json）：list/add/done/next（done 需证据，一次一个 active）',
  category: 'state',
  usage: '/feature list|add <标题>|done <id> <证据>|next <id> [下一步]',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const ws = ctx.session.workspace || process.cwd();
    const sub = (args[0] || 'list').toLowerCase();

    if (sub === 'list' || sub === 'ls') {
      const items = loadFeatures(ws);
      const active = activeFeature(items);
      if (items.length === 0) {
        ctx.renderer.info('特性列表为空（/feature add <标题> 开始）');
        return {};
      }
      ctx.renderer.writeLine(ctx.renderer.color('特性列表（feature_list.json）:', 'bold'));
      for (const f of items) {
        const mark = f.status === 'in-progress' ? '▶' : f.status === 'done' ? '✓' : f.status === 'blocked' ? '✗' : '·';
        const activeTag = f.status === 'in-progress' ? ' [ACTIVE]' : '';
        ctx.renderer.writeLine(`  ${mark} ${f.id} ${f.title} [${f.status}]${activeTag}${f.nextStep ? ' · next: ' + f.nextStep : ''}${f.evidence ? ' · ✓ ' + f.evidence : ''}`);
      }
      if (active) ctx.renderer.writeLine(ctx.renderer.color(`当前 active: ${active.id} ${active.title}`, 'cyan'));
      return {};
    }

    if (sub === 'add') {
      const title = args.slice(1).join(' ').trim();
      if (!title) {
        ctx.renderer.warn('用法: /feature add <标题>');
        return {};
      }
      const item = addFeature(ws, title);
      if (item) ctx.renderer.success(`已添加并激活: ${item.id} ${item.title}（一次一个 active，原 active 已降为 planned）`);
      else ctx.renderer.error('写入 feature_list.json 失败');
      return {};
    }

    if (sub === 'done') {
      const id = args[1] || '';
      const evidence = args.slice(2).join(' ').trim();
      const err = markFeatureDone(ws, id, evidence);
      if (err) ctx.renderer.warn(err);
      else ctx.renderer.success(`已标记 done: ${id}（evidence: ${evidence}）`);
      return {};
    }

    if (sub === 'next') {
      const id = args[1] || '';
      const nextStep = args.slice(2).join(' ').trim();
      const err = setFeatureNext(ws, id, nextStep);
      if (err) ctx.renderer.warn(err);
      else ctx.renderer.success(`已设为 active: ${id}${nextStep ? ' · next: ' + nextStep : ''}`);
      return {};
    }

    ctx.renderer.warn('用法: /feature list|add <标题>|done <id> <证据>|next <id> [下一步]');
    return {};
  },
};

export default command;
