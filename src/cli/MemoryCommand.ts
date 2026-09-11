// Panshalach memory 子命令
// 用法：
//   pangu memory list
//   pangu memory refine --trajectory <file>
//   pangu memory clear [--category X]
//   pangu memory export [file]
//   pangu memory import <file>
//   pangu memory remember [--pin] <内容>    (
//   pangu memory forget <id>                (
//   pangu memory events [--session <id>] [--kind <k>] [--task <id>] [--topic <t>] [--limit N]

import { RefinedMemoryStore } from '../memory/RefinedMemoryStore.js';
import { MemoryEventStore } from '../memory/events.js';
import { listRecent } from './repl/rolloutStore.js';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { FailureCategory } from '../memory/FailureMemory.js';
import type { AgentEventKind } from './repl/types.js';

/** 取一个展示用时间串（异常时间戳不抛）。 */
function fmtTs(ts: number): string {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return String(ts);
  }
}

/** 从 args 里读 `--flag value`（缺值返回 undefined）。 */
function readFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : undefined;
}

/**
 * `/memory events` —— R4 事件账本的查询视图（只读）。
 * sessionId 缺省时回退到最近一个 rollout 会话（无会话则给出指引）。
 */
function renderEvents(args: string[], workspaceRoot: string): string {
  const sessionId = readFlag(args, '--session') ?? process.env.PANSHA_SESSION_ID?.trim();
  let sid = sessionId;

  if (!sid) {
    const recent = listRecent(1);
    if (recent.length === 0) {
      return '当前没有可查的事件会话（rollouts 目录为空）。用 --session <id> 指定会话。';
    }
    sid = recent[0].id;
  }

  const store = new MemoryEventStore(sid!);
  const kind = readFlag(args, '--kind') as AgentEventKind | undefined;
  const taskId = readFlag(args, '--task');
  const topic = readFlag(args, '--topic');
  const limitRaw = readFlag(args, '--limit');
  const limit = limitRaw ? Number(limitRaw) : 20;

  // `--stats`：聚合视图（topic 分布 + 任务摘要），不列明细
  if (args.includes('--stats')) {
    const topics = store.topicStats();
    const tasks = store.taskSummaries();
    if (topics.length === 0 && tasks.length === 0) {
      return `会话 ${sid} 暂无业务事件。`;
    }
    const lines: string[] = [`会话 ${sid} 事件统计：\n`];
    if (topics.length > 0) {
      lines.push('按 topic：');
      for (const t of topics.slice(0, 20)) {
        lines.push(`  ${t.count.toString().padStart(4)}  ${t.topic}  (last: ${fmtTs(t.lastTs)})`);
      }
    }
    if (tasks.length > 0) {
      lines.push('', '按任务：');
      for (const t of tasks.slice(0, 20)) {
        lines.push(`  ${t.taskId}  ${t.count} 条  [${t.kinds.join(', ')}]`);
      }
    }
    return lines.join('\n');
  }

  const events = store.query({ kind, taskId, topic, limit: Number.isFinite(limit) && limit > 0 ? limit : 20 });
  if (events.length === 0) {
    const filterDesc = [kind && `kind=${kind}`, taskId && `task=${taskId}`, topic && `topic=${topic}`]
      .filter(Boolean)
      .join(' ');
    return `会话 ${sid} 没有匹配的事件${filterDesc ? `（${filterDesc}）` : ''}。`;
  }

  const lines: string[] = [`会话 ${sid} 事件（${events.length} 条${kind ? `，kind=${kind}` : ''}）：\n`];
  for (const e of events) {
    const tid = e.taskId ? ` task=${e.taskId}` : '';
    lines.push(`  [${fmtTs(e.ts)}] ${e.kind}${tid}  ${e.topic ? `(${e.topic}) ` : ''}${e.summary}`);
  }
  if (events.length >= (Number.isFinite(limit) && limit > 0 ? limit : 20)) {
    lines.push('', `（已截断至 ${events.length} 条；用 --limit N 调整）`);
  }
  return lines.join('\n');
}

export async function runMemoryCommand(args: string[], workspaceRoot: string): Promise<string> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help') {
    return renderHelp();
  }

  // R4 事件查询：不依赖 RefinedMemoryStore，先分流
  if (subcommand === 'events') {
    return renderEvents(args, workspaceRoot);
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
      // /memory search <词> — 关键词检索（不占注入预算，人工按需）
      const q = args.slice(1).join(' ').trim().toLowerCase();
      if (!q) return '用法: memory search <关键词>';
      const hits = store.list().filter(c => (c.summary || '').toLowerCase().includes(q));
      if (hits.length === 0) return `没有匹配 "${q}" 的记忆。`;
      return renderList(hits, `匹配 "${q}"`);
    }
    case 'merge': {
      // /memory merge — 确定性同主题合并（2-gram；原卡 archived 软删）
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
      // /remember [--pin] <内容>
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
      // /forget <id>
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
  memory events [--session <id>] [--kind <k>]      查询业务事件账本（R4；缺省取最近会话）
                [--task <id>] [--topic <t>] [--limit N] [--stats]

存储位置: <workspace>/.panshalach-memory.json
事件账本: ~/.panshalach/rollouts/<sessionId>.jsonl（业务事件随任务执行写入）
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
