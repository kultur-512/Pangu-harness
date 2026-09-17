// src/tools/fileHistory.ts
// file-history checkpoints — every real write/edit snapshots the target
// BEFORE mutation so /undo can restore it (Claude Code /rewind semantics,
// workspace-scoped, bash side-effects excluded by design).
//
// Layout under ~/.panshalach/file-history/:
//   index-<wsHash>.jsonl          → append-only checkpoint index
//   files/<wsHash>/<id>__<base>   → backup content ("__ABSENT__" marker file
//                                    records a create; undo deletes the file)
//
// Smoke safety (0.8): mock is explicit opt-in only (PANSHA_SMOKE=1); real
// executions — interactive or not — reach this module AFTER the approval
// three-tier gate + pathGuard + sensitive-path checks. /undo remains the
// explicit user command path.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createHash, randomBytes } from 'crypto';
import { computeLineDiff } from './diff.js';
import { isSensitiveRelPath } from './sensitivePaths.js';
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
  // realpath 化：经符号链接/联接进入的工作区路径必须与真实路径得到同一
  // 哈希，否则 symlink 路径写入的历史在真实路径下不可见（反之亦然）。
  let p = path.resolve(workspaceRoot);
  try { p = fs.realpathSync(p); } catch {}
  return createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 12);
}

function historyRoot(): string {
  return path.join(os.homedir(), '.panshalach', 'file-history');
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

/** 最近 n 个检查点（ctrl+t 面板），新在前。 */
export function recentCheckpoints(workspaceRoot: string, n = 5): CheckpointEntry[] {
  return readIndex(workspaceRoot).slice(-n).reverse();
}

// ==================== turn-level rewind ====================

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
 *
 * P2 健壮性：逐文件容错 — 单文件还原失败不中断其余文件，最终在 message
 * 中汇总成功/失败（`failed` 数组携带失败 rel 清单）。
 */
export function rewindToTurn(
  workspaceRoot: string,
  targetTurnTs: number,
  turns: Array<{ id: string; timestamp: number; userInput?: string }>
): { ok: boolean; message: string; changed: string[]; failed: string[]; diff?: DiffHunk[] } {
  const preview = previewRewindToTurn(workspaceRoot, targetTurnTs, turns);
  if (!preview.ok) {
    return { ok: false, message: preview.message, changed: preview.changed, failed: [] };
  }

  // Apply phase — mutates only now; each file is re-checkpointed first so
  // the rewind is itself reversible. Per-file try/catch: one broken backup
  // (e.g. deleted/corrupt) must not leave the rest half-rolled-back.
  let restored = 0;
  let deleted = 0;
  const failed: string[] = [];
  for (const [abs, cp] of preview._plan) {
    try {
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
    } catch {
      failed.push(cp.rel);
    }
  }

  const parts: string[] = [];
  if (restored) parts.push(`还原 ${restored} 个文件`);
  if (deleted) parts.push(`删除 ${deleted} 个（创建回退）`);
  let message = parts.length > 0
    ? `已回放到回合结束态：${parts.join('，')}`
    : '无需变更（目标态与当前一致）';
  if (failed.length > 0) message += `；失败 ${failed.length} 个：${failed.join('、')}`;

  return { ok: true, message, changed: preview.changed, failed, diff: preview.diff };
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
    // P2: 备份不可读（被删/损坏）时预览按空文本处理，不炸——真正的失败
    // 留给 rewindToTurn 的逐文件容错去汇总（预览炸了会连累整个回放）。
    let restoredText = '';
    if (cp.prevExists) {
      try { restoredText = fs.readFileSync(cp.backupPath!, 'utf-8'); } catch { restoredText = ''; }
    }
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
  // M2-6: /undo must not restore sensitive paths (write-gate bypass defense).
  if (isSensitiveRelPath(entry.rel)) {
    return { ok: false, message: `✗ SENSITIVE_PATH: ${entry.rel} 位于敏感路径清单，禁止撤销还原` };
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
  try {
    fs.writeFileSync(tmp, restoredText, 'utf-8');
    fs.renameSync(tmp, entry.abs);
  } catch (e) {
    // P2: 失败路径清理残留 .tmp-undo-*（不留半还原垃圾），原错误继续抛出
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }

  const diff = computeLineDiff(currentText, restoredText);
  return {
    ok: true,
    message: `已还原：${entry.rel}（+${diff.filter((d) => d.type === 'add').length}/−${diff.filter((d) => d.type === 'del').length}）`,
    rel: entry.rel,
    diff,
  };
}

/**
 * Resolve to the realpath of the deepest EXISTING ancestor of `p` (for fresh
 * creates `p` itself does not exist yet — its parent chain still resolves
 * through any symlink/junction, which is exactly the escape we must see).
 */
function realpathBestEffort(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest) : real;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p); // nothing resolvable → lexical fallback
    rest.unshift(path.basename(cur));
    cur = parent;
  }
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
  // P1 (realpath 逃逸): 纯词法包含检查可被工作区内的 symlink/junction 绕过
  // （`<ws>/link/secret.txt` 词法在内、真实在外）。realpath 化后必须仍落在
  // 工作区 realpath 内，否则跳过 checkpoint 并抛出明确错误——绝不把工作区
  // 外的内容拷进历史目录。
  const realAbs = realpathBestEffort(abs);
  let realWs = wsAbs;
  try { realWs = fs.realpathSync(wsAbs); } catch {}
  const relFromWs = path.relative(realWs, realAbs);
  if (relFromWs.startsWith('..') || path.isAbsolute(relFromWs)) {
    throw new Error(`✗ CHECKPOINT_DENIED: ${rel} 经符号链接解析后位于工作区之外（${realAbs}），已跳过快照`);
  }
  checkpointFile(abs, workspaceRoot);
}

/** Test helper: wipe history for a workspace. */
export function clearHistoryForWorkspace(workspaceRoot: string): void {
  for (const p of [indexPath(workspaceRoot), backupDir(workspaceRoot)]) {
    // P2: 备份目录是目录 → 必须 recursive（裸 rmSync 对非空目录必抛且被吞，
    // 目录永远删不掉）。
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}
