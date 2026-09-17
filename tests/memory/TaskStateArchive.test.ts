// tests/memory/TaskStateArchive.test.ts
// taskState.ts 拆分存储（活跃 + 历史归档）验收：
//   - archive() 把陈旧任务（updatedAt 早于 ARCHIVE_OLDER_THAN_DAYS 天）移入归档文件；
//   - 活跃数超 MAX_ACTIVE_TASKS → 最旧（LRU）移入归档，活跃文件保持有界；
//   - 归档文件路径 = 主文件路径 + '.archive.json'（同目录、路径可推导）；
//   - get() 活跃 miss 时回退查归档（被归档任务可查）；
//   - getOrCreate 对仅存归档的任务重建活跃；update 对归档任务抛 not found；
//   - compact() 别名与 archive() 等价；create() 始终写活跃、不碰归档。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStateStore, MAX_ACTIVE_TASKS, ARCHIVE_OLDER_THAN_DAYS } from '../../src/memory/taskState.js';
import type { TaskState } from '../../src/cli/repl/types.js';

const DAY = 24 * 60 * 60 * 1000;

let ws = '';
function makeWs(): string {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-task-archive-'));
  return ws;
}
function statePath(): string {
  return path.join(ws, '.panshalach-task-state.json');
}
function archiveFile(): string {
  return statePath() + '.archive.json';
}
function mkState(id: string, updatedAt: number, createdAt = updatedAt): TaskState {
  return {
    taskId: id,
    originalRequirement: `req-${id}`,
    decisions: [], openQuestions: [], milestones: [], verified: [], risks: [],
    version: 1, createdAt, updatedAt,
  };
}

afterEach(() => {
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

describe('TaskState 拆分存储：archive() 陈旧归档（时间阈值）', () => {
  it('updatedAt 超过 ARCHIVE_OLDER_THAN_DAYS 天 → 移入归档；活跃文件变小；get 回退可查', () => {
    makeWs();
    const now = Date.now();
    const store = new TaskStateStore(ws);
    store.create('old', '旧任务需求', now - (ARCHIVE_OLDER_THAN_DAYS + 1) * DAY);
    store.create('fresh', '新任务需求', now);

    const res = store.archive(now);
    assert.equal(res.archived, 1);
    assert.equal(res.remaining, 1);

    // 活跃文件变小：只含 fresh
    assert.deepEqual(Object.keys(store.load().tasks), ['fresh']);
    // 归档文件存在且含 old
    assert.ok(fs.existsSync(archiveFile()), '归档文件 = 主文件 + .archive.json');
    const archived = JSON.parse(fs.readFileSync(archiveFile(), 'utf-8'));
    assert.ok(archived.tasks.old, '归档文件含被归档任务');
    assert.equal(archived.tasks.old.originalRequirement, '旧任务需求');
    assert.equal(archived.tasks.fresh, undefined, '新鲜任务不归档');
    // 被归档任务可查（get 回退归档）
    const t = store.get('old');
    assert.ok(t);
    assert.equal(t!.originalRequirement, '旧任务需求');
    // 归档任务只读：update 抛 not found
    assert.throws(() => store.update('old', (s) => s), /not found/);
  });

  it('阈值边界：恰好 7 天保留，7 天 + 1ms 归档', () => {
    makeWs();
    const now = Date.now();
    const store = new TaskStateStore(ws);
    store.create('edge-fresh', '恰好 7 天', now - ARCHIVE_OLDER_THAN_DAYS * DAY);
    store.create('edge-old', '7 天多 1ms', now - ARCHIVE_OLDER_THAN_DAYS * DAY - 1);

    const res = store.archive(now);
    assert.equal(res.archived, 1, '只归档超过阈值者');
    assert.ok(store.load().tasks['edge-fresh'], '恰好 7 天 → 保留');
    assert.equal(store.load().tasks['edge-old'], undefined, '7 天 + 1ms → 归档');
  });

  it('无陈旧无超限 → archive 返回 0 且不建归档文件', () => {
    makeWs();
    const store = new TaskStateStore(ws);
    store.create('t1', '需求1');
    const res = store.archive();
    assert.deepEqual(res, { archived: 0, remaining: 1 });
    assert.equal(fs.existsSync(archiveFile()), false, '无归档内容不写归档文件');
  });
});

describe('TaskState 拆分存储：archive() 超限 LRU', () => {
  it('活跃数超 MAX_ACTIVE_TASKS → 最旧（updatedAt 升序）移入归档，活跃保持有界', () => {
    makeWs();
    const now = Date.now();
    // 直接构造主文件：MAX_ACTIVE_TASKS + 10 条、updatedAt 逐条递减（t0 最新）
    const tasks: Record<string, TaskState> = {};
    for (let i = 0; i < MAX_ACTIVE_TASKS + 10; i++) {
      tasks[`t${i}`] = mkState(`t${i}`, now - i * 1000);
    }
    fs.writeFileSync(statePath(), JSON.stringify({ schemaVersion: 1, lastUpdated: now, tasks }), 'utf-8');

    const store = new TaskStateStore(ws);
    const res = store.archive(now);
    assert.equal(res.archived, 10, '超限 10 条归档');
    assert.equal(res.remaining, MAX_ACTIVE_TASKS, '活跃收缩到上限');

    const active = store.load().tasks;
    assert.equal(Object.keys(active).length, MAX_ACTIVE_TASKS);
    assert.ok(active.t0 && active[`t${MAX_ACTIVE_TASKS - 1}`], '最新 200 条保留');
    assert.equal(active[`t${MAX_ACTIVE_TASKS}`], undefined, '第 201 条起移出活跃');

    const archived = JSON.parse(fs.readFileSync(archiveFile(), 'utf-8'));
    assert.ok(archived.tasks[`t${MAX_ACTIVE_TASKS}`], '最旧的进归档');
    assert.ok(archived.tasks[`t${MAX_ACTIVE_TASKS + 9}`], '最旧的 10 条全进归档');
    assert.equal(archived.tasks.t0, undefined, '最新的不进归档');

    // get 回退查归档：被归档任务可查
    assert.ok(store.get(`t${MAX_ACTIVE_TASKS}`));
    assert.ok(store.get('t0'));
    // 新实例重读一致（归档落盘）
    const store2 = new TaskStateStore(ws);
    assert.equal(Object.keys(store2.load().tasks).length, MAX_ACTIVE_TASKS);
    assert.ok(store2.get(`t${MAX_ACTIVE_TASKS}`), '新实例 get 回退归档可查');
  });

  it('陈旧 + 超限叠加：先陈旧后 LRU，统计准确', () => {
    makeWs();
    const now = Date.now();
    const tasks: Record<string, TaskState> = {};
    // 2 条陈旧（超过阈值）+ MAX_ACTIVE_TASKS + 5 条新鲜 → 陈旧 2 + LRU 5 归档
    tasks['stale-a'] = mkState('stale-a', now - (ARCHIVE_OLDER_THAN_DAYS + 2) * DAY);
    tasks['stale-b'] = mkState('stale-b', now - (ARCHIVE_OLDER_THAN_DAYS + 1) * DAY);
    for (let i = 0; i < MAX_ACTIVE_TASKS + 5; i++) {
      tasks[`f${i}`] = mkState(`f${i}`, now - i * 1000);
    }
    fs.writeFileSync(statePath(), JSON.stringify({ schemaVersion: 1, lastUpdated: now, tasks }), 'utf-8');

    const store = new TaskStateStore(ws);
    const res = store.archive(now);
    assert.equal(res.archived, 7, '2 陈旧 + 5 超限');
    assert.equal(res.remaining, MAX_ACTIVE_TASKS);
    assert.equal(store.load().tasks['stale-a'], undefined);
    assert.equal(store.load().tasks['stale-b'], undefined);
    assert.equal(store.get('stale-a')!.originalRequirement, 'req-stale-a', '陈旧任务归档后可查');
  });
});

describe('TaskState 拆分存储：compact() 别名 + getOrCreate 语义', () => {
  it('compact() 与 archive() 等价', () => {
    makeWs();
    const now = Date.now();
    const store = new TaskStateStore(ws);
    store.create('old', '旧', now - (ARCHIVE_OLDER_THAN_DAYS + 1) * DAY);
    store.create('fresh', '新', now);
    const res = store.compact(now);
    assert.deepEqual(res, { archived: 1, remaining: 1 });
    assert.ok(store.get('old'), 'compact 归档后可查');
  });

  it('getOrCreate 对仅存归档的任务重建活跃（历史留在归档）', () => {
    makeWs();
    const now = Date.now();
    const store = new TaskStateStore(ws);
    store.create('t1', '原始需求', now - (ARCHIVE_OLDER_THAN_DAYS + 1) * DAY);
    store.archive(now);
    // 归档后可查（get 回退）
    assert.ok(store.get('t1'));
    // getOrCreate 不把归档当活跃 → 重建新活跃任务
    const recreated = store.getOrCreate('t1', '原始需求', now);
    assert.ok(recreated);
    assert.ok(store.load().tasks.t1, '重建后活跃表有 t1');
    // 历史仍在归档
    const archived = JSON.parse(fs.readFileSync(archiveFile(), 'utf-8'));
    assert.ok(archived.tasks.t1, '历史归档保留');
    // 重建后 update 可用（活跃任务可写）
    const updated = store.update('t1', (s) => ({ ...s, nextStep: '继续' }));
    assert.equal(updated.nextStep, '继续');
  });

  it('create 始终写活跃；归档文件不受 create 影响', () => {
    makeWs();
    const now = Date.now();
    const store = new TaskStateStore(ws);
    store.create('a1', 'A', now - (ARCHIVE_OLDER_THAN_DAYS + 1) * DAY);
    store.archive(now);
    const archivedBefore = JSON.parse(fs.readFileSync(archiveFile(), 'utf-8'));
    store.create('b2', 'B', now);
    const archivedAfter = JSON.parse(fs.readFileSync(archiveFile(), 'utf-8'));
    assert.deepEqual(Object.keys(archivedAfter.tasks), Object.keys(archivedBefore.tasks), 'create 不碰归档');
    assert.ok(store.load().tasks.b2, 'create 写活跃');
  });
});
