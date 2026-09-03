// tests/repl/AgentTree.test.ts
// P5-5.3: upsert idempotence, snapshot stable order, status transitions,
// serial-vs-parallel rendering, empty tree.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentTree } from '../../src/cli/repl/AgentTree.js';

describe('AgentTree', () => {
  it('upsert is idempotent and never regresses stepCount/status', () => {
    const t = new AgentTree();
    t.upsert({ id: 'r0', parent: null, status: 'running', stepCount: 1, durationMs: 100 });
    t.upsert({ id: 'r0', parent: null, status: 'running', stepCount: 5, durationMs: 400 });
    t.upsert({ id: 'r0', parent: null, status: 'done', stepCount: 2, durationMs: 900 });
    const n = t.get('r0')!;
    assert.equal(n.stepCount, 5, 'stepCount must never regress');
    assert.equal(n.status, 'done');
    assert.equal(n.durationMs, 900);
  });

  it('status transitions pending→running→done/failed only upgrade', () => {
    const t = new AgentTree();
    t.upsert({ id: 'r', parent: null, status: 'pending', stepCount: 0, durationMs: 0 });
    t.upsert({ id: 'r', parent: null, status: 'done', stepCount: 1, durationMs: 10 }); // done > pending
    assert.equal(t.get('r')!.status, 'done');
    // a stale 'running' upsert after done must NOT downgrade
    t.upsert({ id: 'r', parent: null, status: 'running', stepCount: 1, durationMs: 10 });
    assert.equal(t.get('r')!.status, 'done', 'no downgrade after done');
  });

  it('snapshot is stable (insertion order for parentless nodes)', () => {
    const t = new AgentTree();
    t.upsert({ id: 'r0', parent: null, status: 'done', stepCount: 3, durationMs: 10 });
    t.upsert({ id: 'r1', parent: null, status: 'running', stepCount: 1, durationMs: 5 });
    t.upsert({ id: 'r2', parent: null, status: 'pending', stepCount: 0, durationMs: 0 });
    const snap = t.snapshot();
    assert.deepEqual(snap.map((n) => n.id), ['r0', 'r1', 'r2']);
    // repeated snapshot keeps the same order
    assert.deepEqual(t.snapshot().map((n) => n.id), ['r0', 'r1', 'r2']);
  });

  it('snapshot orders parents before children', () => {
    const t = new AgentTree();
    t.upsert({ id: 'child2', parent: 'root', status: 'done', stepCount: 1, durationMs: 1 });
    t.upsert({ id: 'root', parent: null, status: 'done', stepCount: 2, durationMs: 2 });
    t.upsert({ id: 'child1', parent: 'root', status: 'running', stepCount: 1, durationMs: 1 });
    const snap = t.snapshot();
    const rootIdx = snap.findIndex((n) => n.id === 'root');
    const c1Idx = snap.findIndex((n) => n.id === 'child1');
    const c2Idx = snap.findIndex((n) => n.id === 'child2');
    assert.ok(rootIdx < c1Idx && rootIdx < c2Idx, 'parent must come before children');
    assert.ok(c2Idx < c1Idx, 'sibling insertion order preserved (child2 upserted first)');
  });

  it('markAll transitions running→done', () => {
    const t = new AgentTree();
    t.upsert({ id: 'r0', parent: null, status: 'done', stepCount: 3, durationMs: 10 });
    t.upsert({ id: 'r1', parent: null, status: 'running', stepCount: 1, durationMs: 5 });
    t.markAll('running', 'done');
    assert.equal(t.get('r1')!.status, 'done');
    assert.equal(t.get('r0')!.status, 'done');
  });

  it('empty tree: size 0, snapshot [], get null', () => {
    const t = new AgentTree();
    assert.equal(t.size, 0);
    assert.deepEqual(t.snapshot(), []);
    assert.equal(t.get('x'), null);
  });

  it('serial rendering summary math (honesty: current engine is serial)', () => {
    const t = new AgentTree();
    t.upsert({ id: 'rollout-0', parent: null, status: 'done', stepCount: 4, durationMs: 1000 });
    t.upsert({ id: 'rollout-1', parent: null, status: 'running', stepCount: 2, durationMs: 400 });
    t.upsert({ id: 'rollout-2', parent: null, status: 'pending', stepCount: 0, durationMs: 0 });
    const snap = t.snapshot();
    const done = snap.filter((n) => n.status === 'done').length;
    const running = snap.filter((n) => n.status === 'running').length;
    const pending = snap.filter((n) => n.status === 'pending').length;
    const total = snap.reduce((a, n) => a + n.durationMs, 0);
    assert.equal(done, 1);
    assert.equal(running, 1);
    assert.equal(pending, 1);
    assert.equal(total, 1400);
  });

  it('addEdge dedups and requires both endpoints (P2-T19)', () => {
    const t = new AgentTree();
    t.upsert({ id: 'a', parent: null, status: 'done', stepCount: 1, durationMs: 1 });
    t.upsert({ id: 'b', parent: null, status: 'done', stepCount: 1, durationMs: 1 });
    t.upsert({ id: 'c', parent: null, status: 'done', stepCount: 1, durationMs: 1 });
    t.addEdge({ from: 'a', to: 'b', kind: 'dep' });
    t.addEdge({ from: 'a', to: 'b', kind: 'dep' }); // dup → ignored
    t.addEdge({ from: 'a', to: 'ghost', kind: 'dep' }); // missing endpoint → ignored
    assert.equal(t.edges().length, 1);
    assert.equal(t.edges()[0].kind, 'dep');
  });

  it('route follows kind edges transitively (P2-T19)', () => {
    const t = new AgentTree();
    for (const id of ['a', 'b', 'c', 'd']) t.upsert({ id, parent: null, status: 'pending', stepCount: 0, durationMs: 0 });
    t.addEdge({ from: 'a', to: 'b', kind: 'rollback' });
    t.addEdge({ from: 'b', to: 'c', kind: 'rollback' });
    t.addEdge({ from: 'a', to: 'd', kind: 'dep' }); // different kind → not in rollback route
    assert.deepEqual(t.route('a', 'rollback').sort(), ['b', 'c']);
    assert.deepEqual(t.route('a', 'dep'), ['d']);
    assert.deepEqual(t.route('c', 'rollback'), []);
  });

  it('parallel tree: multiple running nodes coexist (D-parallel)', () => {
    const t = new AgentTree();
    t.upsert({ id: 'rollout-0', parent: null, status: 'running', stepCount: 2, durationMs: 500 });
    t.upsert({ id: 'rollout-1', parent: null, status: 'running', stepCount: 1, durationMs: 300 });
    t.upsert({ id: 'rollout-2', parent: null, status: 'running', stepCount: 0, durationMs: 100 });
    const snap = t.snapshot();
    assert.equal(snap.filter((n) => n.status === 'running').length, 3, 'parallel run: 3 running nodes coexist');
    t.markAll('running', 'done');
    assert.equal(t.snapshot().filter((n) => n.status === 'done').length, 3);
  });
});
