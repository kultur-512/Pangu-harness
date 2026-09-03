// tests/repl/ReplSetSession.test.ts
// B4 (review defect): /session load used to be a no-op — it mutated
// ctx.session, but buildContext() reads Repl.session on every command.
// Repl.setSession now swaps the session the Repl actually runs on.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repl } from '../../src/cli/repl/Repl.js';
import { Session } from '../../src/cli/repl/Session.js';

describe('B4 Repl.setSession (session swap takes effect)', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    dirs = [];
  });

  it('setSession replaces the session subsequent commands run against', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-b4-'));
    dirs.push(d);

    const s1 = new Session({ tier: 'quick', workspace: path.join(d, 'ws1') });
    const s2 = new Session({ tier: 'max', workspace: path.join(d, 'ws2') });
    const repl = new Repl({ session: s1 });

    try {
      assert.equal((repl as any).session.tier, 'quick');
      (repl as any).setSession(s2);
      assert.equal((repl as any).session.tier, 'max', 'setSession must swap the live session');
      assert.equal((repl as any).session.workspace, path.join(d, 'ws2'));

      // buildContext() (used by every command) must now see the new session.
      const ctx = (repl as any).buildContext();
      assert.equal(ctx.session.tier, 'max', 'command context must reflect the swapped session');
    } finally {
      // M2.0 hang discipline: release the readline handle so node --test exits.
      try { (repl as any).input?.close?.(); } catch {}
    }
  });

  it('setSession persists the outgoing session before swapping', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zorge-b4b-'));
    dirs.push(d);

    const s1 = new Session({ tier: 'high', workspace: d, name: 'outgoing' });
    const repl = new Repl({ session: s1 });
    const savedDir = ((repl as any).store as any).getDir();

    try {
      (repl as any).setSession(new Session({ tier: 'standard', workspace: d }));
      // The outgoing session was saved to the store dir.
      const files = fs.existsSync(savedDir) ? fs.readdirSync(savedDir) : [];
      assert.ok(files.length >= 1, 'outgoing session must be persisted before swap');
    } finally {
      // M2.0 hang discipline: release the readline handle so node --test exits.
      try { (repl as any).input?.close?.(); } catch {}
    }
  });
});
