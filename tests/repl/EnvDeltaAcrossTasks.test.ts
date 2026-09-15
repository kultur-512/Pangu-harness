// tests/repl/EnvDeltaAcrossTasks.test.ts
// B2-4（记忆审计剩余项）：env-delta 增量注入**跨任务**真正生效。
//
// 缺陷实证：`prevEnvSnapshot` 此前是 `PromptBuilder` 的实例私有字段，而该实例
// 每次任务入口都被重建（`runAgentTask` 每调用 new 一个、`Repl.getPromptBuilder()`
// 每次执行任务 new 一个）→ 基线恒为 null → `buildEnvDelta` 永远走"首次快照"分支
// 只报 cwd，"只注入变更字段"的增量语义从未生效。
//
// 修复：基线挂 `Session`（跨任务存活），有意不落盘（易变现场）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptBuilder } from '../../src/cli/repl/PromptBuilder.js';
import { Session } from '../../src/cli/repl/Session.js';
import { TierRegistry } from '../../src/tiers/TierConfig.js';

const TMP_DIRS: string[] = [];
const tmpWs = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-envdelta-'));
  TMP_DIRS.push(d);
  return d;
};

afterEach(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  TMP_DIRS.length = 0;
});

/** 每次任务都新建 PromptBuilder —— 复刻生产调用点的实例化方式。 */
function freshBuilder(session: Session): PromptBuilder {
  return new PromptBuilder(session, TierRegistry.get(session.tier));
}

describe('B2-4：env-delta 跨任务增量（基线挂 Session）', () => {
  it('第二次任务（环境未变）不再注入【环境变更】块', async () => {
    const ws = tmpWs();
    const session = new Session({ tier: 'high', workspace: ws });

    const first = await freshBuilder(session).buildForTask('任务一');
    assert.ok(first.includes('【环境变更】'), '首任务建立基线（报 cwd）');

    const second = await freshBuilder(session).buildForTask('任务二');
    assert.ok(!second.includes('【环境变更】'), '环境未变 → 第二次任务零增量注入（此前恒报 cwd）');
  });

  it('跨任务环境真变化 → 只注入变更字段', async () => {
    const ws = tmpWs();
    const session = new Session({ tier: 'high', workspace: ws });

    await freshBuilder(session).buildForTask('任务一');

    // 伪造上次基线：cwd 与真实值不同 → 本次应报 cwd 变更（真值 ws）
    session.prevEnvSnapshot = { cwd: path.join(ws, 'nowhere') };

    const out = await freshBuilder(session).buildForTask('任务二');
    assert.ok(out.includes('【环境变更】'), 'cwd 变化必须注入');
    assert.ok(out.includes(`cwd: ${ws}`), '注入的是**当前**值（非旧值）');
  });

  it('修复的本体：基线写回 session（第二个实例能读到）', async () => {
    const ws = tmpWs();
    const session = new Session({ tier: 'high', workspace: ws });
    assert.equal(session.prevEnvSnapshot, undefined, '初始无基线');

    await freshBuilder(session).buildForTask('任务一');
    assert.ok(session.prevEnvSnapshot, '首个实例必须把基线写回 session（此前写进实例私有字段，随实例丢弃）');
    assert.equal(session.prevEnvSnapshot!.cwd, ws, '基线为真实 cwd');
  });

  it('基线不落盘（SessionFile 无该字段）——toFile 产物不含 prevEnvSnapshot', () => {
    const ws = tmpWs();
    const session = new Session({ tier: 'high', workspace: ws });
    session.prevEnvSnapshot = { cwd: ws, branch: 'x' };
    const file: any = session.toFile();
    assert.equal(file.prevEnvSnapshot, undefined, '易变现场不进会话文件（防跨进程陈旧基线造假 delta）');
  });
});
