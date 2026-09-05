// src/memory/taskState.ts
// TaskState 持久化层（ROADMAP-NEXT §3 R5 · 王佐 U2-U4）
//
// 定位：任务"控制面"台账的存取——谁做 /task 状态展示、谁折叠事件，都来这取数。
//   类型合同已定稿 src/cli/repl/types.ts（Leader df7a119）；本文件只实现"存取"。
//
// 落地合同（ROADMAP-NEXT §3.1 R5）：
//   - originalRequirement 首次写入后**不可漂移**（一旦存在即拒绝修改）；
//   - 并发/重复更新走 **version 乐观锁**（带期望版本更新，防覆盖）；
//   - 变更后可 **rebuildFromEvents**（从事件流重放重建台账——账本可审计）；
//   - 写盘路径与 RefinedMemoryStore 同惯例：workspace 相对 + 内存 cache。
//
// 注：/task CLI 是赵天昂 R5 的另一半（依赖本文件）；这里不涉及命令层。
//
// JSON 布局（对齐团队 `~/.panshalach/task_state.json` 概念，语义一致）：
//   { schemaVersion, tasks: Record<taskId, TaskState> }

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import type { TaskState, AgentEvent } from '../cli/repl/types.js';

/** 单文件默认名（多个 workspace 用不同文件） */
export const DEFAULT_FILENAME = '.panshalach-task-state.json';
/** 布局版本：schemaVersion=1 → v2 时可做字段迁移 */
export const TASK_STATE_SCHEMA_VERSION = 1;

export interface TaskStateFile {
  schemaVersion: number;
  lastUpdated: number;
  tasks: Record<string, TaskState>;
}

/** 单例默认路径（跨会话共享一份任务台账）——与记忆存储约定一致 */
export const DEFAULT_STORE_PATH = '.panshalach-task-state.json';

/** 从用户侧约束映射到原语结构的事件种类 */
export const STATE_KINDS = ['decision', 'requirement', 'constraint', 'progress', 'verified', 'failure'] as const;

/** 可折叠进台账的事件种类 */
export type StateEventKind = (typeof STATE_KINDS)[number];

function emptyTask(taskId: string, now: number): TaskState {
  return {
    taskId,
    originalRequirement: '',
    decisions: [],
    openQuestions: [],
    milestones: [],
    verified: [],
    risks: [],
    foldedEventIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function defaultFile(taskId: string, now: number): TaskStateFile {
  return {
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    lastUpdated: now,
    tasks: { [taskId]: emptyTask(taskId, now) },
  };
}

/** 有界最大可折叠事件数（对齐事件层上限，防失控全量重放） */
export const REBUILD_MAX_EVENTS = 5000;

/** 把"任务事件"折叠成语义原语（decision→decisions[]，requirement/constraint 不动
 *  originalRequirement、开题记入 milestones[0]，progress→milestone done，verified→verified[]，
 *  failure→risks[]）。事件记账于 evidenceEventIds/refs。 */
export function foldEvent(s: TaskState, e: AgentEvent, now: number): TaskState {
  const t = { ...s, updatedAt: now };
  const refs = e.refs ? [...e.refs] : [];
  switch (e.kind) {
    case 'decision':
      t.decisions = [...s.decisions, { ts: e.ts, what: e.summary, refs }];
      break;
    case 'progress':
      if (t.milestones.length === 0) {
        t.milestones = [{ ts: e.ts, title: e.topic || e.summary, done: true, evidence: e.summary }];
      } else {
        const m = { ...t.milestones[t.milestones.length - 1], done: true, evidence: e.summary };
        t.milestones = [...t.milestones.slice(0, -1), m];
      }
      break;
    case 'verified':
      t.verified = [...s.verified, { ts: e.ts, what: e.summary, evidenceEventIds: [e.id] }];
      break;
    case 'failure':
      t.risks = [...s.risks, { ts: e.ts, risk: e.summary }];
      break;
    default:
      break;
  }
  return t;
}

/** 事件流重放 → 台账（可选初始状态；无原始需求时用 topic 锚定）。幂等：按 id 去重。 */
export function rebuildFromEvents(taskId: string, events: AgentEvent[], now = Date.now()): TaskState {
  let s = emptyTask(taskId, now);
  const seen = new Set<string>();
  const relevant = events
    .filter((e) => e.taskId === taskId && (STATE_KINDS as readonly string[]).includes(e.kind) && !seen.has(e.id))
    .sort((a, b) => a.ts - b.ts);
  for (const e of relevant) {
    seen.add(e.id);
    if (e.kind === 'requirement') {
      s = { ...s, originalRequirement: e.summary, updatedAt: now };
    } else if (e.kind === 'constraint') {
      s = { ...s, currentGoal: e.summary, updatedAt: now };
    } else {
      s = foldEvent(s, e, now);
    }
  }
  return s;
}

export class TaskStateStore {
  private filePath: string;
  private cache: TaskStateFile | null = null;

  constructor(workspaceRoot: string, customFilename?: string) {
    this.filePath = join(workspaceRoot, customFilename ?? DEFAULT_FILENAME);
  }

  /** 返回单例默认路径的 absolute（task_state.json——跨会话共享的任务台账） */
  get path(): string {
    return this.filePath;
  }

  load(): TaskStateFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { schemaVersion: TASK_STATE_SCHEMA_VERSION, lastUpdated: 0, tasks: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as TaskStateFile;
      this.cache = parsed;
      return parsed;
    } catch {
      this.cache = { schemaVersion: TASK_STATE_SCHEMA_VERSION, lastUpdated: 0, tasks: {} };
      return this.cache;
    }
  }

  private commit(file: TaskStateFile): void {
    this.cache = file;
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
  }

  /**
   * 原子提交（tmp → rename）：避免写盘中途崩溃留下半个文件（R5 落地合同）。
   * rename 在同一目录内是原子的；tmp 名带进程号防并发写串扰。
   */
  private commitAtomic(file: TaskStateFile): void {
    this.cache = file;
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
    try {
      renameSync(tmp, this.filePath);
    } catch {
      rmSync(tmp, { force: true });
      throw new Error(`task state write failed: ${this.filePath}`);
    }
  }

  /** 读单任务台账；不存在时返回 null（不自动创建，避免空文件刷盘） */
  get(taskId: string): TaskState | null {
    return this.load().tasks[taskId] ?? null;
  }

  /** 创建（带原子重命名）：originalRequirement 必须非空；taskId 冲突即抛。 */
  create(taskId: string, originalRequirement: string, now = Date.now()): TaskState {
    const file = this.load();
    if (file.tasks[taskId]) throw new Error(`task already exists: ${taskId}`);
    const s = emptyTask(taskId, now);
    s.originalRequirement = originalRequirement.trim();
    if (!s.originalRequirement) throw new Error('originalRequirement must not be empty');
    const next: TaskStateFile = {
      schemaVersion: file.schemaVersion || TASK_STATE_SCHEMA_VERSION,
      lastUpdated: now,
      tasks: { ...file.tasks, [taskId]: s },
    };
    this.commitAtomic(next);
    return s;
  }

  /** 带期望版本的整卡更新（乐观锁）：version 不符即抛；originalRequirement 被改即抛。 */
  update(taskId: string, updater: (s: TaskState) => TaskState, expectedVersion?: number): TaskState {
    const file = this.load();
    const cur = file.tasks[taskId];
    if (!cur) throw new Error(`task not found: ${taskId}`);
    if (expectedVersion !== undefined && cur.version !== expectedVersion) {
      throw new Error(`version conflict: expected ${expectedVersion}, got ${cur.version}`);
    }
    const nextState = updater(cur);
    if (nextState.originalRequirement !== cur.originalRequirement) {
      throw new Error('originalRequirement is immutable once set');
    }
    const bumped: TaskState = { ...nextState, version: cur.version + 1, updatedAt: Date.now() };
    const nextFile: TaskStateFile = {
      ...file,
      lastUpdated: Date.now(),
      tasks: { ...file.tasks, [taskId]: bumped },
    };
    this.commitAtomic(nextFile);
    return bumped;
  }

  /** 折叠一批事件进已有台账（幂等：按 id 去重）；返回新台账。
   *  幂等记账用 foldedEventIds（不污染业务 refs——refs 留给事件自身的引用语义）。 */
  applyEvents(taskId: string, events: AgentEvent[], expectedVersion?: number): TaskState {
    const file = this.load();
    const cur = file.tasks[taskId];
    if (!cur) throw new Error(`task not found: ${taskId}`);
    if (expectedVersion !== undefined && cur.version !== expectedVersion) {
      throw new Error(`version conflict: expected ${expectedVersion}, got ${cur.version}`);
    }
    const seen = new Set(cur.foldedEventIds ?? []);
    const relevant = events.filter((e) => e.taskId === taskId && (STATE_KINDS as readonly string[]).includes(e.kind));
    let s = cur;
    for (const e of relevant) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.kind === 'requirement') {
        if (!s.originalRequirement) s = { ...s, originalRequirement: e.summary, updatedAt: Date.now() };
      } else if (e.kind === 'constraint') {
        s = { ...s, currentGoal: e.summary, updatedAt: Date.now() };
      } else {
        s = foldEvent(s, e, Date.now());
      }
    }
    if (s === cur) return cur; // 无新增（version 不 bump，避免空转）
    const bumped: TaskState = { ...s, foldedEventIds: [...seen], version: cur.version + 1, updatedAt: Date.now() };
    const nextFile: TaskStateFile = { ...file, lastUpdated: Date.now(), tasks: { ...file.tasks, [taskId]: bumped } };
    this.commitAtomic(nextFile);
    return bumped;
  }
}
