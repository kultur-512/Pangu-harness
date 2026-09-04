// Panshalach memory 子命令
// 用法：
//   pangu memory list
//   pangu memory refine --trajectory <file>
//   pangu memory clear [--category X]
//   pangu memory export [file]
//   pangu memory import <file>
//   pangu memory remember [--pin] <内容>    (M1.2)
//   pangu memory forget <id>                (M1.2)

import { RefinedMemoryStore } from '../memory/RefinedMemoryStore.js';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { FailureCategory } from '../memory/FailureMemory.js';

export async function runMemoryCommand(args: string[], workspaceRoot: string): Promise<string> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help') {
    return renderHelp();
  }

  const store = new RefinedMemoryStore(workspaceRoot);

  switch (subcommand) {
    case 'list': {
      const cards = store.list();
      const kind = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : undefined;
      const filtered = kind ? cards.filter(c => c.kind === kind) : cards;
      return renderList(filtered, kind);
    }
    case 'search': {
      // M2.3: /memory search <词> — 关键词检索（不占注入预算，人工按需）
      const q = args.slice(1).join(' ').trim().toLowerCase();
      if (!q) return '用法: memory search <关键词>';
      const hits = store.list().filter(c => (c.summary || '').toLowerCase().includes(q));
      if (hits.length === 0) return `没有匹配 "${q}" 的记忆。`;
      return renderList(hits, `匹配 "${q}"`);
    }
    case 'merge': {
      // M3.3a: /memory merge — 确定性同主题合并（2-gram；原卡 archived 软删）
      const results = store.mergeSimilarCards();
      if (results.length === 0) return '没有可合并的同主题卡（需 ≥2 张 active 且有效权重 ≥0.5）。';
      const lines = [`✓ 合并 ${results.length} 组：`];
      for (const r of results) {
        lines.push(`  [${r.mergedId}] ${r.group.length} 张 → ${r.summary.slice(0, 60)}${r.summary.length > 60 ? '…' : ''}`);
        lines.push(`    来源: ${r.group.join(', ')}（已归档 archived，可回滚）`);
      }
      return lines.join('\n');
    }
    case 'remember': {
      // M1.2: /remember [--pin] <内容>
      const pin = args.includes('--pin');
      const rest = args.slice(1).filter(a => a !== '--pin');
      const content = rest.join(' ').trim();
      if (!content) {
        // 无参 → 列出偏好卡（含 id）
        const prefs = store.list().filter(c => c.kind === 'preference');
        if (prefs.length === 0) return '当前没有偏好卡（/remember <内容> 添加，--pin 冻结衰减）。';
        return prefs.map(c => `  [${c.id}] ${c.summary}${c.pinned ? ' 🔒pin' : ''} (weight ${c.weight})`).join('\n');
      }
      const r = store.remember(content, pin);
      return r.ok ? `✓ 已记住偏好: ${r.card!.summary}（weight ${r.card!.weight}${r.card!.pinned ? '，已 pin 冻结衰减' : ''}）` : '✗ 保存失败';
    }
    case 'forget': {
      // M1.2: /forget <id>
      const id = args[1];
      if (!id) return '用法: memory forget <id>（/memory list --kind preference 查看 id）';
      const r = store.forget(id);
      return r.removed ? `✓ 已删除卡片 ${id}` : `✗ 未找到卡片 ${id}`;
    }
    case 'clear': {
      const catIdx = args.indexOf('--category');
      const cat = catIdx > -1 ? (args[catIdx + 1] as FailureCategory) : undefined;
      const result = store.clear(cat);
      return `✓ 已清理 ${result.removed} 张卡片${cat ? `（类别: ${cat}）` : '（全部）'}。`;
    }
    case 'export': {
      const outFile = args[1];
      const data = store.export();
      if (outFile) {
        const path = resolve(outFile);
        writeFileSync(path, data, 'utf-8');
        return `✓ 已导出到 ${path}`;
      }
      return data;
    }
    case 'import': {
      const inFile = args[1];
      if (!inFile) return '✗ 缺少文件路径';
      const path = resolve(inFile);
      try {
        const data = readFileSync(path, 'utf-8');
        const mergeIdx = args.indexOf('--merge');
        const merge = mergeIdx > -1 ? args[mergeIdx + 1] !== 'false' : true;
        const result = store.import(data, merge);
        return `✓ 已导入 ${result.imported} 张卡片（当前总数: ${result.total}）`;
      } catch (err: any) {
        return `✗ 导入失败: ${err?.message || err}`;
      }
    }
    default:
      return `✗ 未知子命令: ${subcommand}\n\n${renderHelp()}`;
  }
}

function renderHelp(): string {
  return `
Panshalach memory 子命令:

  memory list [--kind failure|success|preference]  列出教训卡片（可按 kind 过滤）
  memory remember [--pin] <内容>                    记住用户偏好（--pin 冻结衰减）
  memory forget <id>                               删除卡片
  memory clear [--category X]                      清空（可指定类别）
  memory export [file]                             导出为 JSON（默认输出到 stdout）
  memory import <file> [--merge false]             从 JSON 导入（默认合并）

存储位置: <workspace>/.panshalach-memory.json
默认加入 .gitignore
`.trim();
}

function renderList(cards: any[], kind?: string): string {
  if (cards.length === 0) {
    return kind ? `当前没有 ${kind} 卡。` : '当前没有教训卡片。';
  }
  const lines: string[] = [];
  lines.push(`共 ${cards.length} 张卡片${kind ? `（kind: ${kind}）` : ''}：\n`);
  for (const c of cards) {
    const lastSeen = new Date(c.lastSeen).toISOString().slice(0, 10);
    const k = c.kind ?? 'failure';
    const kTag = k === 'preference' ? '[偏好]' : k === 'success' ? '[成功]' : '[教训]';
    lines.push(`  ${kTag} [${c.id}] [${c.category}] (weight: ${c.weight.toFixed(1)}, count: ${c.count}, last: ${lastSeen})`);
    lines.push(`    ${c.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}
