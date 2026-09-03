// tests/repl/rolloutStore.test.ts
// M2.2: rollout jsonl — append/replay roundtrip, --resume semantics,
// corrupt-line tolerance, listRecent ordering.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendMeta, appendTurn, appendApprovalChange, resumeSession,
  listRecent, deleteRollout, forkRollout, listSessionTree, renderSessionTree,
} from '../../src/cli/repl/rolloutStore.js';
import { Session } from '../../src/cli/repl/Session.js';
import type { Turn } from '../../src/cli/repl/types.js';

let ids: string[] = [];

function mkTurn(i: number, task: string): Turn {
  return {
    id: 't' + i,
    timestamp: Date.now() + i,
    userInput: task,
    userInputType: 'task',
    tier: 'high',
    durationMs: 100 + i,
    result: { success: true, summary: `score=${90 - i}` },
  };
}

describe('rolloutStore', () => {
  beforeEach(() => { ids = []; });
  afterEach(() => { for (const id of ids) deleteRollout(id); });

  it('meta + turns + approval replay restores a session', () => {
    const s1 = new Session({ workspace: '/tmp/ws-x', tier: 'high' });
    ids.push(s1.id);
    s1.approvalMode = 'default';
    s1.sessionApprovalAllowlist.add('write_file');
    appendMeta(s1);
    appendTurn(s1.id, mkTurn(1, 'first task'));
    appendTurn(s1.id, mkTurn(2, 'second task'));
    appendApprovalChange(s1);

    const s2 = new Session();
    s2.id = s1.id;
    const applied = resumeSession(s2, s1.id);
    assert.equal(applied, 2);
    assert.equal(s2.turns.length, 2);
    assert.equal(s2.turns[0].userInput, 'first task');
    assert.equal(s2.approvalMode, 'default');
    assert.ok(s2.sessionApprovalAllowlist.has('write_file'));
  });

  it('torn/corrupt lines are skipped, rest replays', () => {
    const s1 = new Session({ workspace: '/tmp/ws-y' });
    ids.push(s1.id);
    appendMeta(s1);
    appendTurn(s1.id, mkTurn(1, 'good turn'));
    // Simulate crash mid-write: append a torn line
    const file = path.join(os.homedir(), '.zorge', 'rollouts', `${s1.id}.jsonl`);
    fs.appendFileSync(file, '{"type":"turn","ts":1,"turn":{"id":"bro');

    const s2 = new Session();
    s2.id = s1.id;
    assert.equal(resumeSession(s2, s1.id), 1, 'only the intact turn replays');
  });

  it('listRecent sorts newest first and reports turn counts', () => {
    const a = new Session(); ids.push(a.id);
    const b = new Session(); ids.push(b.id);
    appendMeta(a); appendTurn(a.id, mkTurn(1, 'older session'));
    appendMeta(b); appendTurn(b.id, mkTurn(1, 'newer session')); appendTurn(b.id, mkTurn(2, 'second'));

    const list = listRecent(10);
    const ia = list.findIndex((x) => x.id === a.id);
    const ib = list.findIndex((x) => x.id === b.id);
    assert.ok(ib !== -1 && ia !== -1);
    assert.ok(ib < ia, 'newer file must sort first');
    assert.equal(list[ib].turnCount, 2);
    assert.equal(list[ib].firstUserInput, 'newer session');
  });

  it('--resume last semantics: resumeSession applies the picked id', () => {
    const a = new Session(); ids.push(a.id);
    appendMeta(a); appendTurn(a.id, mkTurn(1, 'picked turn'));
    const s2 = new Session();
    s2.id = a.id;
    resumeSession(s2, a.id);
    assert.equal(s2.turns[0].userInput, 'picked turn');
  });

  it('listSessionTree collects branches + sub-branches (P2-T18)', () => {
    const origin = new Session(); ids.push(origin.id);
    appendMeta(origin);
    const branchA = new Session(); ids.push(branchA.id);
    const branchB = new Session(); ids.push(branchB.id);
    const subA1 = new Session(); ids.push(subA1.id);
    forkRollout(origin.id, branchA.id);
    forkRollout(origin.id, branchB.id);
    forkRollout(branchA.id, subA1.id); // branch-of-branch
    const tree = listSessionTree(origin.id);
    assert.equal(tree.id, origin.id);
    const children = tree.children.map((c) => c.id).sort();
    assert.deepEqual(children, [branchA.id, branchB.id].sort());
    const a = tree.children.find((c) => c.id === branchA.id)!;
    assert.deepEqual(a.children.map((c) => c.id), [subA1.id], 'sub-branch nested under its direct parent');
    const lines = renderSessionTree(tree, origin.id);
    assert.ok(lines.some((l) => l.includes(origin.id)), 'origin rendered');
    assert.ok(lines.some((l) => l.includes(subA1.id)), 'deep branch rendered');
  });
});
