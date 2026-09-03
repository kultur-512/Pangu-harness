// tests/repl/rolloutBranch.test.ts
// P3-3.5: branch semantics — read-only fork, verbatim replay, branch-of-branch
// resolution to the top-most origin, torn-line tolerance carried over.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  appendMeta, appendTurn, appendApprovalChange,
  forkRollout, isBranch, listBranches,
  resumeSession, listRecent, deleteRollout,
} from '../../src/cli/repl/rolloutStore.js';
import { Session } from '../../src/cli/repl/Session.js';
import type { Turn } from '../../src/cli/repl/types.js';

const ids: string[] = [];
function track(id: string) { ids.push(id); return id; }

function mkTurn(i: number, task: string): Turn {
  return {
    id: 't' + i, timestamp: Date.now() + i, userInput: task, userInputType: 'task',
    tier: 'high', durationMs: 10, result: { success: true, summary: `score=${90 - i}` },
  };
}

function fileHash(id: string): string {
  const p = join(homedir(), '.zorge', 'rollouts', `${id}.jsonl`);
  return crypto.createHash('sha1').update(fs.readFileSync(p, 'utf-8')).digest('hex');
}

describe('rollout branching (P3-3.5)', () => {
  afterEach(() => { for (const id of ids.splice(0)) deleteRollout(id); });

  it('forkRollout: origin file hash unchanged; branch replays origin events', () => {
    const origin = track(new Session({ workspace: '/tmp/br-x' }).id);
    appendMeta(new Session({ id: origin, workspace: '/tmp/br-x' } as any));
    appendTurn(origin, mkTurn(1, 'task one'));
    appendTurn(origin, mkTurn(2, 'task two'));
    appendApprovalChange(new Session({ id: origin } as any));

    const hashBefore = fileHash(origin);

    const branchId = track(`${origin}--branch-test`);
    forkRollout(origin, branchId);

    // Origin untouched (read-only fork)
    assert.equal(fileHash(origin), hashBefore, 'origin jsonl must be byte-identical');

    // Branch replayed the same events
    const s = new Session();
    s.id = branchId;
    const applied = resumeSession(s, branchId);
    assert.equal(applied, 2, 'branch must replay origin turns');
    assert.equal(s.turns[1].userInput, 'task two');
  });

  it('isBranch returns the origin; non-branch returns null', () => {
    const origin = track(new Session().id);
    appendMeta(new Session({ id: origin } as any));
    const branchId = track(`${origin}--branch-b1`);
    forkRollout(origin, branchId);

    assert.equal(isBranch(branchId), origin);
    assert.equal(isBranch(origin), null);
    assert.equal(isBranch('does-not-exist-xyz'), null);
  });

  it('branch-of-branch resolves to the TOP-MOST origin', () => {
    const origin = track(new Session().id);
    appendMeta(new Session({ id: origin } as any));
    const b1 = track(`${origin}--branch-l1`);
    forkRollout(origin, b1);
    const b2 = track(`${b1}--branch-l2`);
    forkRollout(b1, b2);

    assert.equal(isBranch(b1), origin);
    assert.equal(isBranch(b2), origin, 'must resolve through the chain to the top-most origin');
    assert.deepEqual(listBranches(origin).sort(), [b1, b2].sort());
  });

  it('listBranches only lists branches of the given session', () => {
    const a = track(new Session().id);
    const b = track(new Session().id);
    appendMeta(new Session({ id: a } as any));
    appendMeta(new Session({ id: b } as any));
    const ab = track(`${a}--branch-x`);
    forkRollout(a, ab);

    assert.deepEqual(listBranches(a), [ab]);
    assert.deepEqual(listBranches(b), []);
  });

  it('new turns append to the branch only (origin untouched)', () => {
    const origin = track(new Session().id);
    appendMeta(new Session({ id: origin } as any));
    appendTurn(origin, mkTurn(1, 'origin turn'));
    const hashBefore = fileHash(origin);

    const branchId = track(`${origin}--branch-go`);
    forkRollout(origin, branchId);
    appendTurn(branchId, mkTurn(2, 'branch-only turn'));

    assert.equal(fileHash(origin), hashBefore, 'origin must stay untouched');
    const s = new Session();
    s.id = branchId;
    resumeSession(s, branchId);
    assert.equal(s.turns.length, 2);
    assert.equal(s.turns[1].userInput, 'branch-only turn');
  });

  it('torn lines in origin are tolerated on fork replay', () => {
    const origin = track(new Session().id);
    appendMeta(new Session({ id: origin } as any));
    appendTurn(origin, mkTurn(1, 'good turn'));
    // inject a torn line
    const p = join(homedir(), '.zorge', 'rollouts', `${origin}.jsonl`);
    fs.appendFileSync(p, '{"type":"turn","ts":1,"turn":{"id":"bro');

    const branchId = track(`${origin}--branch-t`);
    forkRollout(origin, branchId);
    const s = new Session();
    s.id = branchId;
    assert.equal(resumeSession(s, branchId), 1, 'only intact events replay');
  });

  it('listRecent marks branches with branchOf', () => {
    const origin = track(new Session().id);
    appendMeta(new Session({ id: origin } as any));
    const branchId = track(`${origin}--branch-m`);
    forkRollout(origin, branchId);
    const entry = listRecent(20).find((x) => x.id === branchId);
    assert.ok(entry);
    assert.equal(entry!.branchOf, origin);
  });
});
