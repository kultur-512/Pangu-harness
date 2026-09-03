// tests/repl/InputQueue.test.ts
// P4-4.2/4.3: pure queue logic — FIFO, mixed counts, drain/consume clearing,
// `!` prefix parsing (incl. `!steer` + bare `!`), injection block format.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InputQueue,
  classifyRunningInput,
  formatSteerInjection,
} from '../../src/cli/repl/InputQueue.js';

describe('InputQueue', () => {
  it('tasks drain in FIFO order and clear afterwards', () => {
    const q = new InputQueue();
    q.enqueueTask('first');
    q.enqueueTask('second');
    assert.equal(q.taskCount, 2);
    assert.deepEqual(q.drainTasks(), ['first', 'second']);
    assert.equal(q.size, 0);
    assert.deepEqual(q.drainTasks(), []);
  });

  it('steers peek without consuming; consume clears', () => {
    const q = new InputQueue();
    q.enqueueSteer('别用 recursive');
    q.enqueueSteer('顺便修测试');
    assert.deepEqual(q.peekSteers(), ['别用 recursive', '顺便修测试']);
    assert.equal(q.steerCount, 2);
    assert.deepEqual(q.consumeSteers(), ['别用 recursive', '顺便修测试']);
    assert.equal(q.steerCount, 0);
    assert.deepEqual(q.peekSteers(), []);
  });

  it('mixed counts: tasks and steers are independent', () => {
    const q = new InputQueue();
    q.enqueueTask('a');
    q.enqueueSteer('s1');
    q.enqueueTask('b');
    q.enqueueSteer('s2');
    assert.equal(q.size, 4);
    assert.equal(q.taskCount, 2);
    assert.equal(q.steerCount, 2);
    assert.deepEqual(q.drainTasks(), ['a', 'b']);
    assert.equal(q.size, 2);
    q.consumeSteers();
    assert.equal(q.size, 0);
  });

  it('clear() wipes tasks AND steers (double-Esc)', () => {
    const q = new InputQueue();
    q.enqueueTask('t');
    q.enqueueSteer('s');
    q.clear();
    assert.equal(q.size, 0);
    assert.deepEqual(q.drainTasks(), []);
    assert.deepEqual(q.consumeSteers(), []);
  });

  // B3 (review defect): after an abort the queued TASKS must remain for the
  // user to rerun deliberately — the drain loop only runs when NOT aborted.
  // The queue itself must keep tasks until a deliberate drain/clear; this is
  // the data-side contract that lastAborted guards at the loop level.
  it('abort keeps queued tasks available (B3: no auto-drain, no wipe)', () => {
    const q = new InputQueue();
    q.enqueueTask('task A');
    q.enqueueTask('task B');
    // simulate the aborted-turn contract: the drain loop is skipped, so the
    // queue still holds both tasks for the user to rerun
    assert.equal(q.taskCount, 2, 'abort must not auto-execute queued tasks');
    assert.deepEqual(q.peekSteers(), []);
    // user deliberately reruns them one by one
    assert.deepEqual(q.drainTasks(), ['task A', 'task B']);
  });

  it('ignores empty/whitespace submissions', () => {
    const q = new InputQueue();
    q.enqueueTask('   ');
    q.enqueueSteer('');
    assert.equal(q.size, 0);
  });
});

describe('classifyRunningInput', () => {
  it('slash commands pass through as command', () => {
    assert.deepEqual(classifyRunningInput('/tier max'), { kind: 'command', payload: '/tier max' });
  });

  it('bare !xxx → steer with marker stripped', () => {
    assert.deepEqual(classifyRunningInput('!别用 recursive 方案'), {
      kind: 'steer',
      payload: '别用 recursive 方案',
    });
  });

  it('!steer xxx → steer with explicit prefix stripped', () => {
    assert.deepEqual(classifyRunningInput('!steer 先跑测试'), { kind: 'steer', payload: '先跑测试' });
    assert.deepEqual(classifyRunningInput('!STEER upper'), { kind: 'steer', payload: 'upper' });
  });

  it('plain text → queued task', () => {
    assert.deepEqual(classifyRunningInput('顺便把测试也修了'), {
      kind: 'task',
      payload: '顺便把测试也修了',
    });
  });

  it('steer marker with no body → empty payload (caller drops)', () => {
    assert.equal(classifyRunningInput('!').payload, '');
    assert.equal(classifyRunningInput('!steer').payload, '');
  });
});

describe('formatSteerInjection', () => {
  it('empty steers → empty string', () => {
    assert.equal(formatSteerInjection([]), '');
  });

  it('multi-line block format matches the contract', () => {
    const block = formatSteerInjection(['别用 recursive 方案', '顺便把测试也修了']);
    assert.ok(block.includes('【用户插话（运行中收到，必须在本轮考虑）】'));
    assert.ok(block.includes('- 别用 recursive 方案'));
    assert.ok(block.includes('- 顺便把测试也修了'));
    assert.ok(block.startsWith('\n\n'));
  });

  it('single steer produces a single bullet', () => {
    const block = formatSteerInjection(['only one']);
    assert.equal((block.match(/^- /gm) || []).length, 1);
  });
});
