// src/tools/fileHistory.ts
// M2.1: file-history checkpoints — every real write/edit snapshots the target
// BEFORE mutation so /undo can restore it (Claude Code /rewind semantics,
// workspace-scoped, bash side-effects excluded by design).
//
// Layout under ~/.zorge/file-history/:
//   index-<wsHash>.jsonl          → append-only checkpoint index
//   files/<wsHash>/<id>__<base>   → backup content ("__ABSENT__" marker file
//                                    records a create; undo deletes the file)
//
// Smoke safety: this module is only invoked from the engine adapter AFTER the
// isSmokeEnvironment gate (non-TTY/CI never reaches it) or from an explicit
// user command (/undo) — never from tests with fake TTYs.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createHash, randomBytes } from 'crypto';
import { computeLineDiff } from './diff.js';
import type { DiffHunk } from './types.js';

export interface CheckpointEntry {
  id: string;
  ts: number;
  rel: string;              // workspace-relative posix path
  abs: string;
  prevExists: boolean;
  backupPath: string | null; // null when prevExists === false
}

export interface UndoResult {
  ok: boolean;
  message: string;
  rel?: string;
  diff?: DiffHunk[];
}

function wsHash(workspaceRoot: string): string {
  return createHash('sha1').update(path.resolve(workspaceRoot).toLowerCase()).digest('hex').slice(0, 12);
}

function historyRoot(): string {
  return path.join(os.homedir(), '.zorge', 'file-history');
}

function indexPath(workspaceRoot: string): string {
  return path.join(historyRoot(), `index-${wsHash(workspaceRoot)}.jsonl`);
}

function backupDir(workspaceRoot: string): string {
  return path.join(historyRoot(), 'files', wsHash(workspaceRoot));
}

function toRel(abs: string, workspaceRoot: string): string {
  const rel = path.relative(path.resolve(workspaceRoot), abs).split(path.sep).join('/');
  return rel;
}

function readIndex(workspaceRoot: string): CheckpointEntry[] {
  const p = indexPath(workspaceRoot);
  if (!fs.existsSync(p)) return [];
  const out: CheckpointEntry[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

function appendIndex(workspaceRoot: string, entry: CheckpointEntry): void {
  const dir = historyRoot();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(indexPath(workspaceRoot), JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Snapshot the current content of `abs` (if it exists) before a mutation.
 * Returns the checkpoint id. Non-existent files produce a prevExists=false
 * entry so /undo of a fresh creation deletes the file again.
 */
export function checkpointFile(abs: string, workspaceRoot: string): string {
  return checkpointFileAt(abs, workspaceRoot, Date.now());
}

/**
 * checkpointFile with an explicit timestamp (deterministic tests / rewind tooling).
 */
export function checkpointFileAt(abs: string, workspaceRoot: string, ts: number): string {
  const rel = toRel(abs, workspaceRoot);
  const id = `${ts.toString(36)}-${randomBytes(3).toString('hex')}`;
  const prevExists = fs.existsSync(abs) && fs.statSync(abs).isFile();

  let backupPath: string | null = null;
  if (prevExists) {
    const dir = backupDir(workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    backupPath = path.join(dir, `${id}__${path.basename(abs)}`);
    fs.copyFileSync(abs, backupPath);
  } else {
    const dir = backupDir(workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    backupPath = path.join(dir, `${id}__${path.basename(abs)}`);
    fs.writeFileSync(backupPath, '__ABSENT__\n', 'utf-8');
  }

  appendIndex(workspaceRoot, { id, ts, rel, abs: path.resolve(abs), prevExists, backupPath });
  return id;
}

/** Latest checkpoint overall, or the latest for one specific rel path. */
export function latestCheckpoint(workspaceRoot: string, rel?: string): CheckpointEntry | null {
  const all = readIndex(workspaceRoot);
  const list = rel
    ? all.filter((e) => e.rel === toRel(path.resolve(workspaceRoot, rel), workspaceRoot))
    : all;
  if (list.length === 0) return null;
  return list[list.length - 1];
}

/** P4-4.8 (ctrl+t panel): the n most recent checkpoints, newest first. */
export function recentCheckpoints(workspaceRoot: string, n = 5): CheckpointEntry[] {
  return readIndex(workspaceRoot).slice(-n).reverse();
}

// ==================== P3-3.6: turn-level rewind ====================

export interface TurnCheckpointGroup {
  turnId: string | null;        // null = 杂项
  turnLabel: string;            // 回合摘要（该轮用户输入前 40 字，或 '杂项操作'）
  turnTs: number | null;
  checkpoints: CheckpointEntry[];
  filesChanged: string[];       // 去重
}

/**
 * Group checkpoints by the session turn they belong to. A checkpoint belongs
 * to the LAST turn whose timestamp <= checkpoint.ts (turn.timestamp is the
 * round START); checkpoints older than every turn land in the 杂项 group.
 * Groups come back oldest → newest, 杂项 last.
 */
export function listByTurn(workspaceRoot: string, turns: Array<{ id: string; timestamp: number; userInput?: string }>): TurnCheckpointGroup[] {
  const all = readIndex(workspaceRoot).slice().sort((a, b) => a.ts - b.ts);
  if (all.length === 0) return [];

  const sortedTurns = turns.slice().sort((a, b) => a.timestamp - b.timestamp);
  const groupOf = new Map<string, TurnCheckpointGroup>();
  const order: string[] = [];

  const groupFor = (key: string, label: string, ts: number | null): TurnCheckpointGroup => {
    let g = groupOf.get(key);
    if (!g) {
      g = { turnId: ts === null ? null : key, turnLabel: label, turnTs: ts, checkpoints: [], filesChanged: [] };
      groupOf.set(key, g);
      order.push(key);
    }
    return g;
  };

  for (const cp of all) {
    // find the last turn that started at or before the checkpoint
    let owner: { id: string; timestamp: number; userInput?: string } | null = null;
    for (const t of sortedTurns) {
      if (t.timestamp <= cp.ts) owner = t;
      else break;
    }
    if (owner) {
      const g = groupFor(owner.id, (owner.userInput || '').replace(/\s+/g, ' ').slice(0, 40) || '(empty)', owner.timestamp);
      g.checkpoints.push(cp);
      if (!g.filesChanged.includes(cp.rel)) g.filesChanged.push(cp.rel);
    } else {
      const g = groupFor('__misc__', '杂项操作', null);
      g.checkpoints.push(cp);
      if (!g.filesChanged.includes(cp.rel)) g.filesChanged.push(cp.rel);
    }
  }

  return order.map((k) => groupOf.get(k)!);
}

/**
 * Rewind to the state at the END of `targetTurnTs`: apply the BEFORE-version
 * of every checkpoint belonging to that turn and all earlier turns. For each
 * file the LAST checkpoint in the collected set wins (old → new application).
 * A create-type final checkpoint (prevExists=false) means the file did not
 * exist before this window → delete it. bash side-effects are excluded by
 * design (only write/edit checkpoints are tracked).
 */
export function rewindToTurn(
  workspaceRoot: string,
  targetTurnTs: number,
  turns: Array<{ id: string; timestamp: number; userInput?: string }>
): { ok: boolean; message: string; changed: string[]; diff?: DiffHunk[] } {
  const preview = previewRewindToTurn(workspaceRoot, targetTurnTs, turns);
  if (!preview.ok) return preview;

  // Apply phase — mutates only now; each file is re-checkpointed first so
  // the rewind is itself reversible.
  let restored = 0;
  let deleted = 0;
  for (const [abs, cp] of preview._plan) {
    const currentExists = fs.existsSync(abs);
    if (currentExists) checkpointFile(abs, workspaceRoot);

    if (cp.prevExists) {
      const restoredText = fs.readFileSync(cp.backupPath!, 'utf-8');
      const tmp = abs + `.tmp-rewind-${Date.now().toString(36)}`;
      fs.writeFileSync(tmp, restoredText, 'utf-8');
      fs.renameSync(tmp, abs);
      restored++;
    } else if (currentExists) {
      fs.rmSync(abs, { force: true });
      deleted++;
    }
  }

  const parts: string[] = [];
  if (restored) parts.push(`还原 ${restored} 个文件`);
  if (deleted) parts.push(`删除 ${deleted} 个（创建回退）`);
  const message = parts.length > 0
    ? `已回放到回合结束态：${parts.join('，')}`
    : '无需变更（目标态与当前一致）';

  return { ok: true, message, changed: preview.changed, diff: preview.diff };
}

/**
 * Compute what rewinding to the end of `targetTurnTs` would change, WITHOUT
 * touching the filesystem (zero side effects — the --dry-run path).
 */
export function previewRewindToTurn(
  workspaceRoot: string,
  targetTurnTs: number,
  turns: Array<{ id: string; timestamp: number; userInput?: string }>
): { ok: boolean; message: string; changed: string[]; diff?: DiffHunk[]; _plan: Array<[string, CheckpointEntry]> } {
  const groups = listByTurn(workspaceRoot, turns);
  if (groups.length === 0) {
    return { ok: false, message: '没有可回放的变更（file-history 为空）', changed: [], _plan: [] };
  }

  // Collect checkpoints of the target turn + all earlier turns
  const collected: CheckpointEntry[] = [];
  let found = false;
  for (const g of groups) {
    if (g.turnTs !== null && g.turnTs <= targetTurnTs) {
      collected.push(...g.checkpoints);
      if (g.turnTs === targetTurnTs) found = true;
    }
  }
  // 杂项 group checkpoints (turnTs null) — include those that predate target
  const misc = groups.find((g) => g.turnId === null);
  if (misc) {
    for (const cp of misc.checkpoints) {
      if (cp.ts <= targetTurnTs) collected.push(cp);
    }
  }
  if (!found && !misc) {
    return { ok: false, message: `未找到时间戳 ${targetTurnTs} 对应的回合组`, changed: [], _plan: [] };
  }

  collected.sort((a, b) => a.ts - b.ts);

  // Per-file: apply the LAST checkpoint's before-state
  const finalByAbs = new Map<string, CheckpointEntry>();
  for (const cp of collected) finalByAbs.set(cp.abs, cp);

  const changed: string[] = [];
  const diffs: DiffHunk[] = [];
  const plan: Array<[string, CheckpointEntry]> = [];

  for (const [abs, cp] of finalByAbs) {
    const currentExists = fs.existsSync(abs);
    const currentText = currentExists ? fs.readFileSync(abs, 'utf-8') : '';
    const restoredText = cp.prevExists ? fs.readFileSync(cp.backupPath!, 'utf-8') : '';
    plan.push([abs, cp]);
    changed.push(cp.rel);
    diffs.push(...computeLineDiff(currentText, restoredText));
  }

  return {
    ok: true,
    message: `预览：${finalByAbs.size} 个文件将变更`,
    changed,
    diff: diffs,
    _plan: plan,
  };
}

/**
 * Undo the latest checkpoint: restore the previous content (or delete a
 * freshly-created file). The CURRENT state is checkpointed first so undo is
 * itself reversible. Returns a diff between current and restored content.
 */
export function undoLatest(workspaceRoot: string, rel?: string): UndoResult {
  const entry = latestCheckpoint(workspaceRoot, rel);
  if (!entry) {
    return { ok: false, message: '没有可撤销的写操作（file-history 为空）' };
  }

  const currentExists = fs.existsSync(entry.abs);
  const currentText = currentExists ? fs.readFileSync(entry.abs, 'utf-8') : '';

  // Reversibility: snapshot current state before restoring
  if (currentExists) {
    checkpointFile(entry.abs, workspaceRoot);
  }

  if (!entry.prevExists) {
    // The checkpointed op CREATED the file → undo deletes it
    if (currentExists) fs.rmSync(entry.abs, { force: true });
    return {
      ok: true,
      message: `已撤销创建：${entry.rel}（文件已删除）`,
      rel: entry.rel,
      diff: computeLineDiff(currentText, ''),
    };
  }

  const restoredText = fs.readFileSync(entry.backupPath!, 'utf-8');
  const tmp = entry.abs + `.tmp-undo-${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, restoredText, 'utf-8');
  fs.renameSync(tmp, entry.abs);

  const diff = computeLineDiff(currentText, restoredText);
  return {
    ok: true,
    message: `已还原：${entry.rel}（+${diff.filter((d) => d.type === 'add').length}/−${diff.filter((d) => d.type === 'del').length}）`,
    rel: entry.rel,
    diff,
  };
}

/** Called by the engine adapter before an approved write/edit mutation. */
export function checkpointBeforeMutation(
  tool: string,
  params: Record<string, string>,
  workspaceRoot: string
): void {
  const rel = params.file_path ?? params.path ?? '';
  if (!rel) return;
  const abs = path.resolve(workspaceRoot, rel);
  const wsAbs = path.resolve(workspaceRoot);
  const norm = abs.toLowerCase();
  const rootNorm = wsAbs.toLowerCase();
  if (!(norm === rootNorm || norm.startsWith(rootNorm + path.sep))) return; // pathGuard will reject later
  if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) return; // let the tool error out
  checkpointFile(abs, workspaceRoot);
}

/** Test helper: wipe history for a workspace. */
export function clearHistoryForWorkspace(workspaceRoot: string): void {
  const hash = wsHash(workspaceRoot);
  for (const p of [indexPath(workspaceRoot), path.join(backupDir(workspaceRoot))]) {
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  void hash;
}
