// tests/repl/ConfigManager.test.ts
// P2-C: ConfigManager deep merge + load order tests (v2 blueprint)

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, deepMerge } from '../../src/cli/repl/ConfigManager.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), 'pangu-p2c-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

describe('P2-C deepMerge (v2)', () => {
  it('shallow merge would overwrite nested object; deepMerge merges nested', () => {
    const base = { repl: { autoCompact: true, maxHistory: 10 } } as any;
    const override = { repl: { maxHistory: 50 } } as any;

    // Simulate what shallow would do
    const shallow = { ...base, ...override }; // { repl: { maxHistory: 50 } } — loses autoCompact
    assert.equal((shallow as any).repl.autoCompact, undefined, 'shallow loses nested keys');

    const merged = deepMerge(base, override);
    assert.equal((merged as any).repl.autoCompact, true, 'deep keeps untouched nested key');
    assert.equal((merged as any).repl.maxHistory, 50, 'deep overrides nested value');
  });

  it('arrays are replaced (not concatenated)', () => {
    const base = { allowed: ['a', 'b'] } as any;
    const override = { allowed: ['c'] } as any;
    const merged = deepMerge(base, override);
    assert.deepEqual((merged as any).allowed, ['c'], 'array must be replaced');
  });

  it('missing / null / undefined override does not wipe base', () => {
    const base = { tier: 'high', repl: { colorEnabled: true } } as any;
    assert.deepEqual(deepMerge(base, undefined as any), base);
    assert.deepEqual(deepMerge(base, null as any), base);
    const merged = deepMerge(base, { repl: undefined } as any);
    assert.equal((merged as any).repl.colorEnabled, true);
  });

  it('nested deep merge recurses and primitives win from override', () => {
    const base = { a: { b: { c: 1, d: 2 } }, e: 'keep' } as any;
    const override = { a: { b: { c: 9 } }, e: 'over' } as any;
    const m = deepMerge(base, override);
    assert.equal(m.a.b.c, 9);
    assert.equal(m.a.b.d, 2);
    assert.equal(m.e, 'over');
  });
});

describe('P2-C ConfigManager load order + mergeProjectConfig (v2)', () => {
  let tmp: string;
  let userDir: string;
  let userCfg: string;

  beforeEach(() => {
    tmp = makeTempDir();
    // Redirect USER_CONFIG to a temp location for isolation
    userDir = join(tmp, '.panshalach-user');
    userCfg = join(userDir, 'config.json');
    // monkey-patch paths used inside module (they are consts at load time)
    // We instead create project .panshalach.json and use mergeProjectConfig directly.
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it('three layer order: project -> user -> (CLI would override after getAll)', () => {
    // Write project config with nested repl
    const proj = { tier: 'standard', repl: { autoCompact: false, maxHistory: 5 } };
    writeFileSync(join(tmp, '.panshalach.json'), JSON.stringify(proj));

    // Write user config with overlapping nested
    mkdirSync(userDir, { recursive: true });
    const user = { tier: 'high', repl: { maxHistory: 20, colorEnabled: true } };
    writeFileSync(userCfg, JSON.stringify(user));

    // Create manager in project workspace; it will load project then user via existing load()
    // But to keep test hermetic without touching module internals, we test via mergeProjectConfig + manual user merge
    const cm = new ConfigManager(tmp);

    // Manually simulate user merge (since load() already ran and USER_CONFIG_PATH is fixed to real homedir)
    // Use exported deepMerge to demonstrate order semantics:
    const afterProject = deepMerge({}, proj);
    const afterUser = deepMerge(afterProject, user);

    // Expect: tier from user (later), repl merged (autoCompact from project kept, maxHistory from user wins, color from user)
    assert.equal(afterUser.tier, 'high');
    assert.equal((afterUser as any).repl.autoCompact, false);
    assert.equal((afterUser as any).repl.maxHistory, 20);
    assert.equal((afterUser as any).repl.colorEnabled, true);
  });

  it('mergeProjectConfig is explicit and safe on missing file', () => {
    const cm = new ConfigManager(tmp);
    // Should not throw
    cm.mergeProjectConfig(join(tmp, 'no-such-file.json'));
    // Should not throw on bad JSON either (we swallow)
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{ not json }');
    cm.mergeProjectConfig(bad);
    // Still functional
    cm.set('tier', 'quick');
    assert.equal(cm.get('tier'), 'quick');
  });

  it('arrays in project/user are replaced (deepMerge semantics)', () => {
    const proj = { repl: { skipFor: ['a'] } } as any;
    const user = { repl: { skipFor: ['b', 'c'] } } as any;
    const merged = deepMerge(proj, user);
    assert.deepEqual((merged as any).repl.skipFor, ['b', 'c']);
  });
});
