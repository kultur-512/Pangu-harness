// src/memory/events.ts
// MemoryEventStore —— 事件查询层（ROADMAP-NEXT R4 · 王佐 U1-U3）
//
// 定位：只做「查询」，不做「写入/存储」。
//   写入 = rolloutStore.appendAgentEvent（事实源唯一入口，df7a119 已落）；
//   本文件在其上提供 kind/topic/session/taskId 维度的有界查询，
//   供楼上（TaskState 折叠、记忆系统、/task CLI）取数，禁止绕过底座自行读文件。
//
// 原则（与事件账本一致）：
//   - 只读：不修改任何 AgentEvent；
//   - 有界：派生查询最多返回 MAX_DERIVED_EVENTS（与 rolloutStore 同一上限）；
//   - 宽松解析：损坏行跳过（读不到就当不存在），永不在查询路径上抛异常。

import type { AgentEvent, AgentEventKind } from '../cli/repl/types.js';
import { readAgentEvents } from '../cli/repl/rolloutStore.js';

/** 派生查询上限：防全量重放拖垮交互路径（与 rolloutStore.MAX_DERIVED_EVENTS 对齐） */
export const MAX_QUERY_EVENTS = 5000;

/** 事件查询条件：全部可选，省略即不过滤（并集语义取交集）。 */
export interface EventQuery {
  sessionId?: string;
  taskId?: string;
  kind?: AgentEventKind | AgentEventKind[];
  topic?: string;                 // 子串匹配（不区分大小写）
  sinceTs?: number;               // 只取 ts >= sinceTs
  untilTs?: number;               // 只取 ts <= untilTs
  limit?: number;                 // 返回条数上限（不传 = MAX_QUERY_EVENTS）
}

/** 按 topic 分组的聚合计数（大小写不敏感、子串保留组）。 */
export interface TopicStat {
  topic: string;
  count: number;
  lastTs: number;
}

/** 会话内 taskId 摘要（供"本任务发生过什么"的审计视图）。 */
export interface TaskSummary {
  taskId: string;
  count: number;
  kinds: AgentEventKind[];
  firstTs: number;
  lastTs: number;
}

export class MemoryEventStore {
  constructor(private readonly sessionId: string) {}

  /**
   * 按条件查询事件（只读、有界、宽松）。
   * 读不到/全部损坏时返回 []，永不上抛。
   */
  query(q: EventQuery = {}): AgentEvent[] {
    let events: AgentEvent[];
    try {
      events = readAgentEvents(this.sessionId);
    } catch {
      return [];
    }

    const taskId = q.taskId;
    const kindList = q.kind ? (Array.isArray(q.kind) ? q.kind : [q.kind]) : undefined;
    const topic = q.topic?.trim().toLowerCase();

    const hit = events.filter((e) => {
      if (taskId !== undefined && e.taskId !== taskId) return false;
      if (kindList && !kindList.includes(e.kind)) return false;
      if (topic && !e.topic.toLowerCase().includes(topic)) return false;
      if (q.sinceTs !== undefined && e.ts < q.sinceTs) return false;
      if (q.untilTs !== undefined && e.ts > q.untilTs) return false;
      return true;
    });

    // 按 ts 升序（稳定、可审计顺序）；limit 生效前先给排序一个确定的上界
    hit.sort((a, b) => a.ts - b.ts);
    const limit = q.limit !== undefined && q.limit > 0 ? q.limit : MAX_QUERY_EVENTS;
    return hit.slice(0, limit);
  }

  /** 取事件列表尾部（最新 N 条，升序返回）。 */
  latest(n = 10): AgentEvent[] {
    const limit = n > 0 ? n : MAX_QUERY_EVENTS;
    const all = this.query({});
    return all.slice(Math.max(0, all.length - limit));
  }

  /** 某 kind 的事件计数（会话内）。 */
  countByKind(kind: AgentEventKind): number {
    return this.query({ kind }).length;
  }

  /** 当前"活" taskId 集（按最后事件时间排序，倒序；taskId 为空的事件不计）。 */
  activeTaskIds(): string[] {
    const byTask = new Map<string, number>();
    for (const e of this.query({})) {
      if (e.taskId) byTask.set(e.taskId, Math.max(byTask.get(e.taskId) ?? 0, e.ts));
    }
    return [...byTask.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  /** 按 topic 分组统计（含 lastTs，供时间过滤与审计）。 */
  topicStats(): TopicStat[] {
    const map = new Map<string, TopicStat>();
    for (const e of this.query({})) {
      const t = e.topic.trim();
      if (!t) continue;
      const s = map.get(t);
      if (s) {
        s.count++;
        s.lastTs = Math.max(s.lastTs, e.ts);
      } else {
        map.set(t, { topic: t, count: 1, lastTs: e.ts });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  }

  /** 本会话内每个 taskId 的摘要（无 taskId 的事件归入 "__untracked"）。 */
  taskSummaries(): TaskSummary[] {
    const byTask = new Map<string, TaskSummary>();
    for (const e of this.query({})) {
      const id = e.taskId ?? '__untracked';
      const s = byTask.get(id);
      if (s) {
        s.count++;
        s.kinds.push(e.kind);
        s.firstTs = Math.min(s.firstTs, e.ts);
        s.lastTs = Math.max(s.lastTs, e.ts);
      } else {
        byTask.set(id, { taskId: id, count: 1, kinds: [e.kind], firstTs: e.ts, lastTs: e.ts });
      }
    }
    const out = [...byTask.values()];
    for (const s of out) s.kinds = [...new Set(s.kinds)]; // 去重保序
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }
}
