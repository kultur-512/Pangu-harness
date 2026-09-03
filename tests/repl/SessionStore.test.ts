// tests/repl/SessionStore.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/cli/repl/SessionStore.js';
import { Session } from '../../src/cli/repl/Session.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SessionStore', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'zorge-test-sessions-'));
    store = new SessionStore(join(tmpRoot, 'sessions'));
  });

  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('save + load roundtrip preserves data', () => {
    const sess = new Session({ tier: 'high', workspace: '/tmp/ws' });
    sess.addTurn({
      id: 't1',
      timestamp: Date.now(),
      userInput: 'fix bug',
      userInputType: 'task',
      tier: 'high',
      durationMs: 123,
      result: { success: true, summary: 'score=90' },
    });

    store.save(sess);
    const loaded = store.load(sess.id);

    assert.ok(loaded, 'should load');
    assert.equal(loaded!.id, sess.id);
    assert.equal(loaded!.tier, 'high');
    assert.equal(loaded!.turns.length, 1);
    assert.equal(loaded!.turns[0].userInput, 'fix bug');
  });

  it('list returns summaries sorted by updatedAt desc', () => {
    const s1 = new Session({ tier: 'quick' });
    const s2 = new Session({ tier: 'max' });

    // make s1 older
    s1.updatedAt = Date.now() - 10000;

    store.save(s1);
    store.save(s2);

    const list = store.list();
    assert.ok(list.length >= 2);
    // most recent first
    assert.ok(list[0].updatedAt >= list[1].updatedAt);
  });

  it('delete removes the file', () => {
    const sess = new Session();
    store.save(sess);
    assert.ok(store.load(sess.id));

    store.delete(sess.id);
    assert.equal(store.load(sess.id), null);
  });

  it('load of corrupted json returns null instead of throwing', () => {
    const sess = new Session();
    store.save(sess);

    // corrupt the file
    const p = join(store.getDir(), `${sess.id}.json`);
    // overwrite with invalid json
    writeFileSync(p, '{ broken json');

    const loaded = store.load(sess.id);
    assert.equal(loaded, null);
  });

  it('directory is created lazily on first save', () => {
    const customDir = join(tmpRoot, 'lazy-sessions');
    const lazyStore = new SessionStore(customDir);

    // dir should not exist yet
    assert.equal(existsSync(customDir), false);

    const s = new Session();
    lazyStore.save(s);

    assert.equal(existsSync(customDir), true);
  });
});
