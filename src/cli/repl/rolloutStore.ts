// src/cli/repl/rolloutStore.ts
// append-only session rollouts (crash-resilient resume).
//
// Layout: ~/.panshalach/rollouts/<sessionId>.jsonl
// Event kinds:
//   { type: 'meta',    id, tier, workspace, model, approvalMode, allowlist }
//   { type: 'turn',    turn: Turn }
//   { type: 'approval', approvalMode, allowlist }
//   { type: 'rewind',  target }                                    — 审计（replay 暂不消费）
//   { type: 'agent',   event: AgentEvent }                         — 业务语义事件（契约 v2）
//   { type: 'compact', syntheticTurn, coveredTurnIds, tokens }     — 压缩标记（契约 v3，replay 消费）
//   { type: 'context', snapshot: ContextSnapshotPayload }          — 注入审计（契约 v3）
//
// Resume strategy: replay events into a Session; fall back to
// SessionStore.load(id) when the jsonl is missing/corrupt.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { inferTurnRole, type Session } from './Session.js';
import type { Turn, AgentEvent } from './types.js';

/** 接口契约 v3：ContextSnapshot 事件载荷——逐任务注入审计（"模型当时看见了什么"的唯一证据源）。 */
export interface ContextSnapshotPayload {
  taskId?: string;
  model?: string;
  memoryCardCount?: number;
  overflowCount?: number;
  injectedCardIds?: string[];
  promptChars?: number;
  promptHash?: string;
  [k: string]: unknown;
}

export type RolloutEvent =
  | { type: 'meta'; ts: number; id: string; tier: string; workspace: string; model: string; approvalMode?: string; allowlist?: string[]; branchOf?: string }
  | { type: 'turn'; ts: number; turn: Turn }
  | { type: 'approval'; ts: number; approvalMode: string; allowlist: string[] }
  | { type: 'rewind'; ts: number; target: string | number }
  // 接口契约 v2 (U1)：业务语义事件（AgentEvent）以 append-only 方式进入同一
  // 事件流，MemoryEventStore（src/memory/events.ts，W3）在此之上做 topic/kind 查询。
  | { type: 'agent'; ts: number; event: AgentEvent }
  // 接口契约 v3：压缩标记（自足化——内嵌完整 synthetic turn，replay 无需模型重建）
  | { type: 'compact'; ts: number; syntheticTurn: Turn; coveredTurnIds: string[]; beforeTokens?: number; afterTokens?: number }
  | { type: 'context'; ts: number; snapshot: ContextSnapshotPayload };

// C5（ROADMAP-NEXT §3.2）：审计状态戳。同会话此前发生过 append 写失败时，其后
// 成功落盘的事件会携带 auditStatus: 'write-failed:N'（N=累计失败次数），使
// "零事件"与"没注入/写失败"可区分。老文件无此字段 → 读路径照常解析（向后兼容）。
export type AuditedRolloutEvent = RolloutEvent & { auditStatus?: string };

function rolloutsDir(): string {
  return path.join(os.homedir(), '.panshalach', 'rollouts');
}

function fileFor(sessionId: string): string {
  return path.join(rolloutsDir(), `${sessionId}.jsonl`);
}

function ensureDir(): void {
  fs.mkdirSync(rolloutsDir(), { recursive: true });
}

// ==================== C5：append 审计状态（会话级内存标志） ====================
// appendEvent 从前完全吞异常 → rollout 里"零事件"无法区分"没发生"还是"发生了
// 但写失败"。现在失败会计入会话级计数（'write-failed:N'），并可通过
// auditStatusOf() 查询；此后的成功写入会在事件上落 auditStatus 字段。
const auditWriteFailures = new Map<string, number>();

/** 会话级 append 审计状态：'ok' | 'write-failed:N'（N=累计写失败次数）。 */
export function auditStatusOf(sessionId: string): string {
  const n = auditWriteFailures.get(sessionId) ?? 0;
  return n === 0 ? 'ok' : `write-failed:${n}`;
}

/** 重置会话审计状态（测试 / id 复用时用）。 */
export function resetAuditStatus(sessionId: string): void {
  auditWriteFailures.delete(sessionId);
}

/** Append one event (creates the file lazily). Never throws; returns whether
 *  the event actually reached the disk. C2 依赖该返回值做"先写盘后改内存"。 */
export function appendEvent(sessionId: string, event: RolloutEvent): boolean {
  try {
    const failures = auditWriteFailures.get(sessionId) ?? 0;
    // C5：此前发生过写失败 → 本条成功落盘的事件带上审计戳
    const payload: AuditedRolloutEvent = failures > 0
      ? { ...event, auditStatus: `write-failed:${failures}` }
      : event;
    ensureDir();
    fs.appendFileSync(fileFor(sessionId), JSON.stringify(payload) + '\n', 'utf-8');
    return true;
  } catch {
    auditWriteFailures.set(sessionId, (auditWriteFailures.get(sessionId) ?? 0) + 1);
    // best-effort audit trail; never break the interactive flow —
    // 但失败不再完全不可见：auditStatusOf() 可查询（C5）。
    return false;
  }
}

export function appendMeta(session: Session): void {
  appendEvent(session.id, {
    type: 'meta', ts: Date.now(), id: session.id, tier: String(session.tier),
    workspace: session.workspace, model: session.model,
    approvalMode: session.approvalMode,
    allowlist: [...session.sessionApprovalAllowlist],
  });
}

export function appendTurn(sessionId: string, turn: Turn): void {
  // M2-7：rollout 是 turn 权威源——序列化前补角色标注（幂等，显式 role 优先；
  // addTurn 已标注时无副作用）。旧版读新 JSONL 忽略未知字段，无碍。
  turn.role ??= inferTurnRole(turn);
  appendEvent(sessionId, { type: 'turn', ts: Date.now(), turn });
}

export function appendApprovalChange(session: Session): void {
  appendEvent(session.id, {
    type: 'approval', ts: Date.now(),
    approvalMode: session.approvalMode,
    allowlist: [...session.sessionApprovalAllowlist],
  });
}

/** 接口契约 v2 (U1)：追加一条业务语义事件（事实层，append-only，不参与 session replay）。 */
export function appendAgentEvent(sessionId: string, event: AgentEvent): void {
  appendEvent(sessionId, { type: 'agent', ts: Date.now(), event });
}

/** 接口契约 v3：压缩标记——内嵌完整 synthetic turn，replayInto 消费后 resume 无需模型即可重建压缩态。
 *  C2：返回是否真实写盘成功——compactService 先写盘后改内存依赖它。 */
export function appendCompactMarker(
  sessionId: string,
  syntheticTurn: Turn,
  coveredTurnIds: string[],
  beforeTokens?: number,
  afterTokens?: number
): boolean {
  // M2-7：压缩合成轮是助手侧历史摘要 → 序列化前补 'assistant'（幂等，显式优先）。
  // 调用方（compactService）随后把同一对象写入 session.turns，故内存态同步携带。
  syntheticTurn.role ??= 'assistant';
  return appendEvent(sessionId, {
    type: 'compact', ts: Date.now(),
    syntheticTurn, coveredTurnIds: [...coveredTurnIds],
    beforeTokens, afterTokens,
  });
}

/** 接口契约 v3：逐任务 ContextSnapshot（注入审计账本）。 */
export function appendContextSnapshot(sessionId: string, snapshot: ContextSnapshotPayload): void {
  appendEvent(sessionId, { type: 'context', ts: Date.now(), snapshot });
}

/** 读取某 session 的全部 ContextSnapshot（评测/审计用；有界）。 */
export function readContextSnapshots(sessionId: string): ContextSnapshotPayload[] {
  const out: ContextSnapshotPayload[] = [];
  for (const ev of readEvents(sessionId)) {
    if (ev.type === 'context' && ev.snapshot) {
      out.push(ev.snapshot);
      if (out.length >= MAX_DERIVED_EVENTS) break;
    }
  }
  return out;
}

/** 有界读取：派生查询（事件/快照）最多返回的条数（防全量重放拖垮交互路径；resume 不受限）。 */
const MAX_DERIVED_EVENTS = 5000;

/** 尾部反向扫描的单块字节数（256KiB——从文件尾向前凑满 MAX_DERIVED_EVENTS 条）。 */
const TAIL_SCAN_CHUNK_BYTES = 256 * 1024;

/**
 * 读取某 session 的全部业务语义事件（损坏行跳过；有界）。
 *
 * 包C 缺陷9（头重脚轻）：旧实现从头顺序读满 MAX_DERIVED_EVENTS 即 break——
 * 超 5000 条后最新事件永不可见。现从文件尾部按块反向扫描凑满上限再正序化，
 * 最新事件恒可见；块的半行（行首在更早块）以原始字节结转拼接后再解码，
 * 多字节 UTF-8 字符跨块不损坏。
 */
export function readAgentEvents(sessionId: string): AgentEvent[] {
  const p = fileFor(sessionId);
  let size = 0;
  try { size = fs.statSync(p).size; } catch { return []; }
  let fd: number;
  try { fd = fs.openSync(p, 'r'); } catch { return []; }
  // 按块反向扫描；每块解出升序事件组，组间按"更早块插到前面"重组为整体升序。
  const groups: AgentEvent[][] = []; // groups[0] = 最旧块 … 组内各自升序
  let total = 0;
  let carry: Buffer = Buffer.alloc(0); // 后块残留的半行原始字节（行首在更早块）
  let end = size;
  try {
    while (end > 0 && total < MAX_DERIVED_EVENTS) {
      const start = Math.max(0, end - TAIL_SCAN_CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      const full = Buffer.concat([chunk, carry]);
      let processable = full;
      if (start > 0) {
        const firstNl = full.indexOf(0x0a); // 0x0a = '\n'
        if (firstNl === -1) {
          carry = full; // 整块无换行 → 全是半行，继续向前结转
          processable = Buffer.alloc(0);
        } else {
          carry = full.subarray(0, firstNl);
          processable = full.subarray(firstNl + 1);
        }
      } else {
        carry = Buffer.alloc(0); // 已到文件头，全部为完整行
      }
      const evs: AgentEvent[] = [];
      for (const line of processable.toString('utf-8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const ev = JSON.parse(s) as RolloutEvent;
          if (ev.type === 'agent' && (ev as any).event) evs.push((ev as any).event);
        } catch { /* skip torn/corrupt line */ }
      }
      if (evs.length > 0) {
        groups.unshift(evs); // 更早（更旧）的块插到前面 → groups 整体保持升序
        total += evs.length;
      }
      end = start;
    }
  } catch {
    // 读取中途失败：已凑齐的部分照常返回（宽松解析纪律）
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  let flat = groups.flat();
  if (flat.length > MAX_DERIVED_EVENTS) flat = flat.slice(flat.length - MAX_DERIVED_EVENTS);
  return flat;
}

function readEvents(sessionId: string): RolloutEvent[] {
  const p = fileFor(sessionId);
  if (!fs.existsSync(p)) return [];
  const out: RolloutEvent[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip torn/corrupt line */ }
  }
  return out;
}

export interface RolloutSummary {
  id: string;
  file: string;
  mtimeMs: number;
  turnCount: number;
  firstUserInput?: string;
  tier?: string;
  workspace?: string;
  /** set when this rollout is a branch of another session */
  branchOf?: string;
}

/** 有界扫描：单文件最多解析的行数（防超长 rollout 拖垮 /resume 列表；超出部分计数近似）。 */
const LIST_SCAN_MAX_LINES = 5000;

/** Most recent rollouts, newest first (scans the whole dir; n is small). */
export function listRecent(n = 10): RolloutSummary[] {
  const dir = rolloutsDir();
  if (!fs.existsSync(dir)) return [];
  const out: RolloutSummary[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const file = path.join(dir, f);
    let mtimeMs = 0;
    let turnCount = 0;
    let firstUserInput: string | undefined;
    let tier: string | undefined;
    let workspace: string | undefined;
    let branchOf: string | undefined;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      const scan = lines.length > LIST_SCAN_MAX_LINES ? lines.slice(0, LIST_SCAN_MAX_LINES) : lines;
      for (const raw of scan) {
        const s = raw.trim();
        if (!s) continue;
        try {
          const ev = JSON.parse(s);
          if (ev.type === 'turn') {
            turnCount++;
            if (!firstUserInput && ev.turn?.userInput) firstUserInput = String(ev.turn.userInput).slice(0, 80);
          } else if (ev.type === 'meta') {
            tier = ev.tier; workspace = ev.workspace;
            if (ev.branchOf) branchOf = ev.branchOf;
          }
        } catch {}
      }
    } catch { continue; }
    if (!firstUserInput) firstUserInput = turnCount > 0 ? '(turns present)' : '(no turns yet)';
    out.push({ id: f.replace(/\.jsonl$/, ''), file, mtimeMs, turnCount, firstUserInput, tier, workspace, branchOf });
  }
  out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.turnCount - a.turnCount));
  return out.slice(0, n);
}

/** Replay a rollout file into the session (turns + approval state + compact markers). */
export function replayInto(session: Session, events: RolloutEvent[]): number {
  let applied = 0;
  for (const ev of events) {
    if (ev.type === 'turn' && ev.turn) {
      session.addTurn(ev.turn);
      applied++;
    } else if (ev.type === 'approval') {
      session.approvalMode = (ev.approvalMode as any) || session.approvalMode;
      session.sessionApprovalAllowlist = new Set(ev.allowlist || []);
    } else if (ev.type === 'compact' && ev.syntheticTurn) {
      // 接口契约 v3：resume 端消费压缩标记——与在线 applyCompactResult 同一语义：
      // 覆盖账本内的轮次以 synthetic turn 替换，其余（含标记后新增轮）保留。
      // M2-7：旧 compact 标记无 role → 回放时按现状补 'assistant'（迁移）；新标记原样。
      if (ev.syntheticTurn.role === undefined) ev.syntheticTurn.role = 'assistant';
      const covered = new Set(ev.coveredTurnIds || []);
      session.turns = [ev.syntheticTurn, ...session.turns.filter(t => !covered.has(t.id))];
    }
  }
  return applied;
}

/** Load a rollout into the session; returns turn count applied (0 if none). */
export function resumeSession(session: Session, sessionId: string): number {
  const events = readEvents(sessionId);
  if (events.length === 0) return 0;
  for (const ev of events) {
    if (ev.type === 'meta') {
      if (ev.tier) session.tier = ev.tier as any;
      if (ev.workspace) session.workspace = ev.workspace;
      if (ev.model) session.model = ev.model;
    } else if (ev.type === 'approval') {
      session.approvalMode = (ev.approvalMode as any) || session.approvalMode;
      session.sessionApprovalAllowlist = new Set(ev.allowlist || []);
    }
  }
  return replayInto(session, events);
}

/** Test helper. */
export function deleteRollout(sessionId: string): void {
  try { fs.rmSync(fileFor(sessionId), { force: true }); } catch {}
}

// ==================== session branching ====================
// A branch is a READ-ONLY fork of the origin's jsonl event stream: the origin
// file is never touched. The branch file starts with a meta event carrying
// `branchOf: <originId>`, followed by a verbatim replay of the origin events.
// Branches may branch again — `isBranch` resolves to the TOP-MOST origin.

export const BRANCH_SEPARATOR = '--branch-';

/** Append a raw pre-serialized event line (used by forkRollout for verbatim replay). */
function appendRawLine(sessionId: string, line: string): void {
  try {
    ensureDir();
    fs.appendFileSync(fileFor(sessionId), line.endsWith('\n') ? line : line + '\n', 'utf-8');
  } catch {}
}

/**
 * Create a branch: replay ALL origin events verbatim into `<branchId>.jsonl`,
 * prefixed by a branch-pointer meta. The origin file is opened read-only and
 * never modified.
 */
export function forkRollout(originId: string, branchId: string): void {
  const originFile = fileFor(originId);
  if (!fs.existsSync(originFile)) {
    throw new Error(`origin rollout not found: ${originId}`);
  }
  // Compute origin hash BEFORE writing anything (read-only verification helper)
  const originLines = fs.readFileSync(originFile, 'utf-8').split('\n');

  ensureDir();

  // Branch pointer meta first
  const branchMeta = JSON.stringify({
    type: 'meta', ts: Date.now(), id: branchId,
    tier: '', workspace: '', model: '', branchOf: originId,
  });

  const lines: string[] = [branchMeta];
  for (const raw of originLines) {
    const s = raw.trim();
    if (!s) continue;
    lines.push(s); // verbatim replay (corrupt lines are preserved as-is;
    //                 readEvents' tolerant parser will skip them on replay)
  }

  fs.writeFileSync(fileFor(branchId), lines.join('\n') + '\n', 'utf-8');
}

/**
 * If `<sessionId>.jsonl` is a branch, return its TOP-MOST origin id
 * (follows branch-of-branch chains). Non-branch files return null.
 */
export function isBranch(sessionId: string): string | null {
  const events = readEvents(sessionId);
  const meta = events.find((e) => e.type === 'meta') as any;
  const direct = meta?.branchOf;
  if (!direct || typeof direct !== 'string') return null;
  // Walk the chain to the top-most origin (cycle-guarded)
  const seen = new Set<string>([sessionId]);
  let cur = direct;
  while (true) {
    if (seen.has(cur)) return cur; // cycle: stop at current pointer
    seen.add(cur);
    const evs = readEvents(cur);
    const m = evs.find((e) => e.type === 'meta') as any;
    const next = m?.branchOf;
    if (!next || typeof next !== 'string') return cur;
    cur = next;
  }
}

/** All branch ids whose (top-most) origin is `sessionId`. */
export function listBranches(sessionId: string): string[] {
  const dir = rolloutsDir();
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const id = f.replace(/\.jsonl$/, '');
    const origin = isBranch(id);
    if (origin === sessionId) out.push(id);
  }
  return out;
}

/** Branch ids whose DIRECT parent is `sessionId` (branch-of-branch aware). */
export function directBranches(sessionId: string): string[] {
  const dir = rolloutsDir();
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const id = f.replace(/\.jsonl$/, '');
    const events = readEvents(id);
    const meta = events.find((e) => e.type === 'meta') as any;
    if (meta?.branchOf === sessionId) out.push(id);
  }
  return out.sort();
}

/** session tree — origin + recursive branch nodes (edges = branchOf). */
export interface SessionTreeNode {
  id: string;
  children: SessionTreeNode[];
}
export function listSessionTree(sessionId: string): SessionTreeNode {
  const seen = new Set<string>();
  const walk = (id: string, depth: number): SessionTreeNode => {
    const node: SessionTreeNode = { id, children: [] };
    if (depth > 32 || seen.has(id)) return node; // cycle guard
    seen.add(id);
    for (const child of directBranches(id)) {
      node.children.push(walk(child, depth + 1));
    }
    return node;
  };
  return walk(sessionId, 0);
}

/** Render the tree as indented lines (for /tree output). */
export function renderSessionTree(node: SessionTreeNode, currentId?: string): string[] {
  const lines: string[] = [];
  const walk = (n: SessionTreeNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const marker = n.children.length > 0 ? '└─' : '·';
    const cur = n.id === currentId ? ' ◀' : '';
    lines.push(`${indent}${depth === 0 ? '●' : marker} ${n.id}${cur}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(node, 0);
  return lines;
}

/** Append a rewind audit event. */
export function appendRewindAudit(sessionId: string, target: string | number): void {
  appendEvent(sessionId, { type: 'rewind', ts: Date.now(), target } as any);
}
