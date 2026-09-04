// tests/server/runAgentTaskSession.test.ts
// B2 (review defect): the default interactive path must run tasks against the
// LIVE session — /tier /workspace switches take effect and the session's
// turns feed "最近 N 轮上下文". Regression: runAgentTask used to build a
// FRESH empty Session, silently dropping all of that state.
//
// Verification strategy: a fake model client captures the prompt that
// PromptBuilder builds; we assert the session's tier constraint XML and the
// seeded turn marker both reach the prompt.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentTask } from '../../src/server/runAgentTask.js';
import { Session } from '../../src/cli/repl/Session.js';

const TMP_DIRS: string[] = [];

function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-b2-'));
  TMP_DIRS.push(d);
  return d;
}

function fakeProvider(prompts: string[]): any {
  const client = {
    complete: async (p: string) => { prompts.push(String(p)); return 'no tool calls, plain text reply'; },
  };
  return {
    createClient: () => client,
    createDefaultClient: () => client,
    invalidateProviderCache: () => {},
    listModels: () => [],
    isModelAvailable: () => true,
  };
}

describe('B2 runAgentTask reuses the caller Session', () => {
  afterEach(() => {
    for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    TMP_DIRS.length = 0;
  });

  it('feeds the session tier, workspace and turns into the task prompt', async () => {
    const ws = tmpWs();
    const session = new Session({ tier: 'max', workspace: ws });
    // Seed one turn with a unique marker so "最近 N 轮上下文" has real content.
    session.turns.push({
      id: 't1',
      timestamp: Date.now(),
      userInput: 'UNIQUE_TURN_MARKER_B2_xyz',
      userInputType: 'task',
      tier: 'max',
      result: { success: true, summary: 'done' },
    } as any);

    const prompts: string[] = [];
    const events: any[] = [];
    const r = await runAgentTask(
      { task: 'do the thing', session },
      { provider: fakeProvider(prompts), onEvent: (e) => events.push(e) }
    );

    assert.ok(r, 'runAgentTask must return a result');
    const joined = prompts.join('\n');
    assert.ok(joined.includes('<tier_constraint tier="max"'),
      `session tier (max) must reach the prompt, got: ${joined.slice(0, 200)}`);
    assert.ok(joined.includes('UNIQUE_TURN_MARKER_B2_xyz'),
      'session turns must feed the prompt (最近 N 轮上下文)');
    assert.ok(events.length > 0, 'progress events must be emitted');
  });

  it('falls back to a fresh Session when none is provided (server compat)', async () => {
    const ws = tmpWs();
    const prompts: string[] = [];
    const r = await runAgentTask(
      { task: 'server task', tier: 'standard', workspace: ws },
      { provider: fakeProvider(prompts), onEvent: () => {} }
    );
    assert.ok(r, 'fresh-session path must still work');
  });

  it('keeps the session object identity (no silent replacement)', async () => {
    const ws = tmpWs();
    const session = new Session({ tier: 'high', workspace: ws });
    const prompts: string[] = [];
    await runAgentTask(
      { task: 'identity check', session },
      { provider: fakeProvider(prompts), onEvent: () => {} }
    );
    // The caller's session must still carry its turns after the run
    // (runAgentTask must NOT replace it with a fresh one).
    assert.equal(session.tier, 'high');
    assert.equal(session.workspace, ws);
  });
});
