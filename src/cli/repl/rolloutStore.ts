// src/cli/repl/rolloutStore.ts
// M2.2: append-only session rollouts (crash-resilient resume).
//
// Layout: ~/.zorge/rollouts/<sessionId>.jsonl
// Event kinds:
//   { type: 'meta',    id, tier, workspace, model, approvalMode, allowlist }
//   { type: 'turn',    turn: Turn }
//   { type: 'approval', approvalMode, allowlist }
//
// Resume strategy: replay events into a Session; fall back to
// SessionStore.load(id) when the jsonl is missing/corrupt.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Session } from './Session.js';
import type { Turn } from './types.js';

export type RolloutEvent =
  | { type: 'meta'; ts: number; id: string; tier: string; workspace: string; model: string; approvalMode?: string; allowlist?: string[]; branchOf?: string }
  | { type: 'turn'; ts: number; turn: Turn }
  | { type: 'approval'; ts: number; approvalMode: string; allowlist: string[] }
  | { type: 'rewind'; ts: number; target: string | number };

function rolloutsDir(): string {
  return path.join(os.homedir(), '.zorge', 'rollouts');
}

function fileFor(sessionId: string): string {
  return path.join(rolloutsDir(), `${sessionId}.jsonl`);
}

function ensureDir(): void {
  fs.mkdirSync(rolloutsDir(), { recursive: true });
}

/** Append one event (creates the file lazily). Never throws. */
export function appendEvent(sessionId: string, event: RolloutEvent): void {
  try {
    ensureDir();
    fs.appendFileSync(fileFor(sessionId), JSON.stringify(event) + '\n', 'utf-8');
  } catch {
    // best-effort audit trail; never break the interactive flow
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
  appendEvent(sessionId, { type: 'turn', ts: Date.now(), turn });
}

export function appendApprovalChange(session: Session): void {
  appendEvent(session.id, {
    type: 'approval', ts: Date.now(),
    approvalMode: session.approvalMode,
    allowlist: [...session.sessionApprovalAllowlist],
  });
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
  /** P3-3.5: set when this rollout is a branch of another session */
  branchOf?: string;
}

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
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        const s = line.trim();
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

/** Replay a rollout file into the session (turns + approval state). */
export function replayInto(session: Session, events: RolloutEvent[]): number {
  let applied = 0;
  for (const ev of events) {
    if (ev.type === 'turn' && ev.turn) {
      session.addTurn(ev.turn);
      applied++;
    } else if (ev.type === 'approval') {
      session.approvalMode = (ev.approvalMode as any) || session.approvalMode;
      session.sessionApprovalAllowlist = new Set(ev.allowlist || []);
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

// ==================== P3-3.5: session branching ====================
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

/** P2-T18 (Pi): session tree — origin + recursive branch nodes (edges = branchOf). */
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
