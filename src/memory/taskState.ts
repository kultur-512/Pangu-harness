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

import { existsSync, readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { atomicWriteFileSync } from '../utils/atomicFile.js';
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
    // 包C 缺陷5：env（PANSHA_TASK_STATE_FILE，runAgentTask.ts / PromptBuilder.ts
    // 原样透传）传绝对路径时直接采用——旧实现一律 join(workspaceRoot, ...)，
    // 绝对路径被拼成 `<ws>\P:\...` 垃圾路径 → existsSync false → 静默空台账。
    // 对齐 RefinedMemoryStore 同款解析（优先级：显式参数 > env > 默认文件名）。
    const fromEnv = typeof process !== 'undefined' ? process.env?.PANSHA_TASK_STATE_FILE?.trim() : undefined;
    const resolved = customFilename ?? fromEnv ?? DEFAULT_FILENAME;
    this.filePath = isAbsolute(resolved) ? resolved : join(workspaceRoot, resolved);
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

  /** 非原子提交（遗留入口，当前无调用方；保留以备调试直写）——同样走共享原子写。 */
  private commit(file: TaskStateFile): void {
    this.cache = file;
    atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2));
  }

  /**
   * 原子提交（tmp → rename）：避免写盘中途崩溃留下半个文件（R5 落地合同）。
   * 包C 缺陷4：实现委托共享 src/utils/atomicFile.ts（同目录 tmp + 带进程号
   * tmp 名 + renameSync + 失败清理）；rename 失败仍抛本层错误信息（行为不变）。
   */
  private commitAtomic(file: TaskStateFile): void {
    this.cache = file;
    try {
      atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2));
    } catch {
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

  /** 读取已有台账；不存在时创建并返回（供 CLI/评测入口使用）。 */
  getOrCreate(taskId: string, originalRequirement: string, now = Date.now()): TaskState {
    return this.get(taskId) ?? this.create(taskId, originalRequirement, now);
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

  // ==================== 显式记录原语（9/14 接口对齐：TaskState.record*） ====================
  // 全部走 update()（同一乐观锁 + originalRequirement 锚定纪律），调用方无需自己拼数组。
  // 定位：这些是「语义原语」——由真实业务节点（任务落定/CLI 用户声明）显式调用，
  // 不允许从自然语言轨迹里猜（与禁止 NLP 抽取同一条纪律）。

  /** 记一条决策。 */
  recordDecision(taskId: string, what: string, why?: string, refs?: string[]): TaskState {
    const ts = Date.now();
    return this.update(taskId, (s) => ({ ...s, decisions: [...s.decisions, { ts, what, why, refs }] }));
  }

  /** 记一条风险（失败路径的主要落点）。 */
  recordRisk(taskId: string, risk: string, mitigation?: string): TaskState {
    const ts = Date.now();
    return this.update(taskId, (s) => ({ ...s, risks: [...s.risks, { ts, risk, mitigation }] }));
  }

  /** 记一条未决问题（默认 open）。 */
  recordOpenQuestion(taskId: string, question: string): TaskState {
    const ts = Date.now();
    return this.update(taskId, (s) => ({
      ...s,
      openQuestions: [...s.openQuestions, { ts, question, status: 'open' as const }],
    }));
  }

  /** 记一条里程碑。 */
  recordMilestone(taskId: string, title: string, done = false, evidence?: string): TaskState {
    const ts = Date.now();
    return this.update(taskId, (s) => ({ ...s, milestones: [...s.milestones, { ts, title, done, evidence }] }));
  }

  /** 记一条已验证事实（任务级验证结论，区别于记忆卡层的 markVerified）。 */
  recordVerified(taskId: string, what: string, how?: string, command?: string, evidenceEventIds?: string[]): TaskState {
    const ts = Date.now();
    return this.update(taskId, (s) => ({
      ...s,
      verified: [...s.verified, { ts, what, how, command, evidenceEventIds }],
    }));
  }

  /** 更新下一步（传空串 = 清空；避免误导性地保留过期 nextStep）。 */
  setNextStep(taskId: string, nextStep: string): TaskState {
    const trimmed = nextStep.trim();
    return this.update(taskId, (s) => ({ ...s, nextStep: trimmed || undefined }));
  }

  /** 更新当前目标（originalRequirement 不动——锚只认 create）。 */
  setCurrentGoal(taskId: string, currentGoal: string): TaskState {
    const trimmed = currentGoal.trim();
    return this.update(taskId, (s) => ({ ...s, currentGoal: trimmed || undefined }));
  }
}
