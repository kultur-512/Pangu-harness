// tests/memory/CrossInstanceCache.test.ts
// 【4】load() 实例缓存数据防御（2026-09-13 迭代包）：
// 旧实现 `if (this.cache) return this.cache` 对盘面变化完全失明——长命实例 A
// load 过一次后，实例 B save 写盘的新卡对 A 不可见，A 后续 save 会用陈旧
// 全量快照静默抹掉 B 的卡（唯一能静默丢数据的缺陷）。
// 修复语义：缓存命中前 statSync(路径) 比对 size+mtimeMs，不匹配 → 重读盘并
// 刷新缓存条目；statSync 失败（文件被删）按 miss 处理。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';

let ws = '';
const prevMemFile = process.env.PANSHA_MEMORY_FILE;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-xinst-cache-'));
  delete process.env.PANSHA_MEMORY_FILE; // 隔离：不得被外部 env 重定向
});
afterEach(() => {
  if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
  else process.env.PANSHA_MEMORY_FILE = prevMemFile;
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

function mkCard(id: string, summary: string): any {
  const now = Date.now();
  return {
    id, kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure',
    summary, weight: 2, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
    decayWeight: 1.0, lastUsedAt: now,
  };
}

describe('【4】load() 实例缓存对盘面变化的感知（跨实例数据防御）', () => {
  it('实例 A load 后实例 B save → A 再 load 必须看到 B 的新卡（旧行为静默丢失——红→绿）', () => {
    const a = new RefinedMemoryStore(ws, 'mem.json');
    a.load(); // A 的实例缓存固化（空库）

    const b = new RefinedMemoryStore(ws, 'mem.json');
    b.save([mkCard('from-b', '实例 B 新写的卡')]);

    const again = a.load();
    assert.equal(again.cards.length, 1, 'A 必须看到 B 写盘的新卡（旧实现返回陈旧空缓存）');
    assert.equal(again.cards[0].id, 'from-b');
  });

  it('同字节长度、不同内容的盘面改写（size 不变、mtime 变）→ 仍必须重读盘', () => {
    const a = new RefinedMemoryStore(ws, 'mem.json');
    const b = new RefinedMemoryStore(ws, 'mem.json');
    b.save([mkCard('c1', 'aaaa')]);
    a.load(); // 缓存 = c1

    // 同字节长度改写：id 'c1' → 'c9'（长度不变）→ 只有 mtime 推进——
    // 只比 size 的偷懒防御在此必然漏检，锁定 size+mtimeMs 双条件。
    const p = path.join(ws, 'mem.json');
    const raw = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, raw.replace('"c1"', '"c9"'), 'utf8');

    const again = a.load();
    const ids = again.cards.map((x) => x.id);
    assert.ok(ids.includes('c9'), 'size 未变但 mtime 推进 → 必须重读盘');
    assert.ok(!ids.includes('c1'), '不得返回陈旧缓存内容');
  });

  it('盘上文件被删 → 缓存按 miss 处理（回空库，不返回陈旧卡）', () => {
    const a = new RefinedMemoryStore(ws, 'mem.json');
    a.save([mkCard('c1', '会随文件删除而消失')]);
    assert.equal(a.load().cards.length, 1);

    fs.rmSync(path.join(ws, 'mem.json'), { force: true });
    const again = a.load();
    assert.equal(again.cards.length, 0, '文件被删 → miss → 空库（不服务陈旧缓存）');
  });

  it('本实例 save/markVerified 后缓存仍一致（写入路径回归，不因防御引入双重读）', () => {
    const a = new RefinedMemoryStore(ws, 'mem.json');
    a.save([mkCard('c1', '自己写的卡')]);
    assert.equal(a.load().cards.length, 1, '自身 save 后立即可见');
    a.markVerified(['c1'], Date.now());
    const after = a.load();
    assert.equal(after.cards.length, 1);
    assert.equal(after.cards[0].count, 2, 'markVerified 的 count+1 对本实例可见');
    // 同一实例反复 load 不丢数据（幂等）
    assert.equal(a.load().cards.length, 1);
  });

  it('A 看到 B 的卡后再 save 自己的新卡 → B 的卡不被抹掉（丢数据场景端到端封堵）', () => {
    const a = new RefinedMemoryStore(ws, 'mem.json');
    a.save([mkCard('a-card', 'A 的旧卡')]);
    a.load();

    const b = new RefinedMemoryStore(ws, 'mem.json');
    b.save([mkCard('b-card', 'B 的新卡')]);

    a.save([mkCard('a-card2', 'A 又写一张')]); // A 的 load 缓存已被防御失效 → 从盘合并

    const final = new RefinedMemoryStore(ws, 'mem.json').load();
    const ids = final.cards.map((c) => c.id).sort();
    assert.ok(ids.includes('b-card'), 'B 的卡不得被 A 的 save 静默抹掉');
    assert.ok(ids.includes('a-card') && ids.includes('a-card2'));
  });
});
