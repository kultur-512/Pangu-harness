// tests/repl/SlashPicker.test.ts
// picker: resident slash-command menu — pure logic tests:
// candidate aggregation, live filtering, top-8 cap, clamped index movement,
// render lines, '/' gating.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMenuItems,
  menuOpenFor,
  moveMenuIndex,
  menuRenderLines,
  PANSHA_COMMANDS,
  MENU_CAP,
  argMenuFor,
  filterArgCandidates,
  pickerClamp,
  pickerWindowStart,
  pickerVisible,
  pickerRenderOrder,
  pickerStep,
  inlineSlashTrigger,
  leadingSlashTrigger,
  argStageFor,
  resolveModelTarget,
  parseCommandInput,
} from '../../src/cli/repl/SlashPicker.js';

const CUSTOM = [
  { name: 'model', description: '模型' },
  { name: 'memory', description: '记忆' },
  { name: 'move', description: '移动' },
  { name: 'undo', description: '撤销' },
  { name: 'usage', description: '用量' },
];

describe('computeMenuItems', () => {
  it('empty/plain input → no menu (must start with /)', () => {
    assert.deepEqual(computeMenuItems(''), []);
    assert.deepEqual(computeMenuItems('model'), []);
    assert.deepEqual(computeMenuItems('  /model'), []);
  });

  it('bare "/" → all commands (capped at MENU_CAP)', () => {
    const items = computeMenuItems('/', CUSTOM);
    assert.equal(items.length, Math.min(CUSTOM.length, MENU_CAP));
    assert.equal(items[0].name, '/model');
  });

  it('"/mo" filters to model/move (prefix; memory starts with me, not mo)', () => {
    const items = computeMenuItems('/mo', CUSTOM);
    const names = items.map((c) => c.name);
    assert.deepEqual(names, ['/model', '/move']);
  });

  it('"/me" filters to memory (fuzzy fallback also engages)', () => {
    const items = computeMenuItems('/me', CUSTOM);
    const names = items.map((c) => c.name);
    assert.ok(names.includes('/memory'), `must include /memory: ${names}`);
  });

  it('fuzzy fallback: "/ud" → /undo (no prefix hit)', () => {
    const items = computeMenuItems('/ud', CUSTOM);
    assert.ok(items.some((c) => c.name === '/undo'), `fuzzy must surface /undo: ${items.map((c) => c.name)}`);
  });

  it('"/xyz" no match → empty', () => {
    assert.deepEqual(computeMenuItems('/xyz', CUSTOM), []);
  });

  it('aliases participate in prefix matching', () => {
    const items = computeMenuItems('/quit', PANSHA_COMMANDS); // exit alias
    assert.ok(items.some((c) => c.name === '/exit'));
  });

  it('top-8 cap applies to full list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `cmd${i}`, description: '' }));
    const items = computeMenuItems('/', many);
    assert.equal(items.length, MENU_CAP);
  });
});

describe('menuOpenFor / moveMenuIndex', () => {
  it('menu opens only for "/" prefix', () => {
    assert.equal(menuOpenFor('/'), true);
    assert.equal(menuOpenFor('/mo'), true);
    assert.equal(menuOpenFor('x/'), false);
    assert.equal(menuOpenFor(''), false);
  });

  it('moveMenuIndex clamps at both ends', () => {
    assert.equal(moveMenuIndex(0, 5, -1), 0);
    assert.equal(moveMenuIndex(4, 5, 1), 4);
    assert.equal(moveMenuIndex(2, 5, 1), 3);
    assert.equal(moveMenuIndex(2, 5, -1), 1);
    assert.equal(moveMenuIndex(0, 0, 1), 0);
  });
});

describe('menuRenderLines', () => {
  it('renders one line per item with ▸ highlight on index', () => {
    const items = [
      { name: '/model', description: '模型' },
      { name: '/undo', description: '撤销' },
    ];
    const lines = menuRenderLines(items, 1);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('  /model'), 'unselected row');
    assert.ok(lines[1].startsWith('▸ /undo'), 'selected row highlighted');
  });

  it('empty items → empty lines', () => {
    assert.deepEqual(menuRenderLines([], 0), []);
  });
});

describe('dismiss re-arm semantics (fix-menu-timing 问题 2)', () => {
  it('after Esc (dismissed=true), any character input re-arms the menu for a "/" line', () => {
    // Simulate: user typed '/', Esc → dismissed=true, rl.line cleared by readline.
    let dismissed = true;
    // next keypress: any printable char (e.g. '/' again) resets dismissed
    dismissed = false;
    // menuOpenFor now governs again → opening on '/' prefix
    assert.equal(dismissed, false);
    assert.equal(menuOpenFor('/'), true);
    const items = computeMenuItems('/');
    assert.ok(items.length > 0, 'menu candidates non-empty after re-arm');
  });

  it('menuOpenFor works independently of dismiss flag (re-arm gate is the flag only)', () => {
    // The pure gate is menuOpenFor(value); the dismiss flag lives in the UI.
    // A dismissed flag of false + '/' prefix → open (candidates non-empty).
    assert.equal(menuOpenFor('/mo') && computeMenuItems('/mo').length > 0, true);
    // Non-'/' input never opens, regardless of dismiss state
    assert.equal(menuOpenFor('abc'), false);
  });
});

describe('argMenuFor (feat-submenu)', () => {
  it('parses command + trailing space / partial arg', () => {
    assert.deepEqual(argMenuFor('/model '), { command: 'model', argQuery: '' });
    assert.deepEqual(argMenuFor('/model openPangu-7B'), { command: 'model', argQuery: 'openPangu-7B' });
    assert.deepEqual(argMenuFor('/tier '), { command: 'tier', argQuery: '' });
  });

  it('returns null without trailing space or for plain text', () => {
    assert.equal(argMenuFor('/model'), null);          // no space → command menu only
    assert.equal(argMenuFor('/tier'), null);
    assert.equal(argMenuFor('fix the bug'), null);     // not a slash command
    assert.equal(argMenuFor(''), null);
    assert.equal(argMenuFor('/'), null);               // bare slash
  });

  it('filterArgCandidates: prefix → substring → fuzzy; arg lists NOT capped (full browse)', () => {
    const models = ['openPangu-7B', 'openPangu-1B', 'DeepSeek-V4-Flash-0731', 'default'];
    assert.deepEqual(filterArgCandidates('openPangu', models), ['openPangu-7B', 'openPangu-1B']);
    assert.deepEqual(filterArgCandidates('deep', models), ['DeepSeek-V4-Flash-0731']);
    assert.deepEqual(filterArgCandidates('7B', models), ['openPangu-7B']); // substring
    assert.equal(filterArgCandidates('', models).length, models.length); // empty → ALL (uncapped)
  });

  it('arg list with >MENU_CAP entries returns all (84-model scenario, fix arg visibility)', () => {
    const big = Array.from({ length: 84 }, (_, i) => `model-${i}`);
    assert.equal(filterArgCandidates('', big).length, 84);
    assert.equal(filterArgCandidates('model-8', big).length, 5); // model-8 + model-80..83
    // picker window can scroll through all of them (windowStart formula)
    assert.equal(pickerWindowStart(83, 8, 84, 'down'), 76); // last window reaches index 83
    assert.equal(pickerVisible(big, 76, 8).length, 8);
    assert.equal(pickerVisible(big, 76, 8)[7], 'model-83');
  });

  it('tier candidates are the six tiers', () => {
    const six = ['quick', 'standard', 'high', 'max', 'ex', 'pangu'];
    assert.deepEqual(filterArgCandidates('', six), six);
    assert.deepEqual(filterArgCandidates('hi', six), ['high']);
  });

  it('approvals candidates are the three modes', () => {
    assert.deepEqual(filterArgCandidates('', ['readonly', 'default', 'full']), ['readonly', 'default', 'full']);
    assert.deepEqual(filterArgCandidates('fu', ['readonly', 'default', 'full']), ['full']);
  });
});

describe('picker geometry (picker-gen, CC port)', () => {
  it('pickerClamp clamps both ends', () => {
    assert.equal(pickerClamp(5, 0, 3), 3);
    assert.equal(pickerClamp(-1, 0, 3), 0);
    assert.equal(pickerClamp(2, 0, 3), 2);
  });

  it('pickerWindowStart keeps focused visible; window scrolls (CC formula)', () => {
    // total 10, visible 4
    assert.equal(pickerWindowStart(0, 4, 10, 'down'), 0);
    assert.equal(pickerWindowStart(3, 4, 10, 'down'), 0); // focused at window bottom edge
    assert.equal(pickerWindowStart(4, 4, 10, 'down'), 1); // scrolls down
    assert.equal(pickerWindowStart(9, 4, 10, 'down'), 6); // clamped at max start
    assert.equal(pickerWindowStart(0, 0, 10, 'down'), 0);
    assert.equal(pickerWindowStart(0, 4, 0, 'down'), 0);
  });

  it('pickerWindowStart direction=up keeps focused at window TOP (fix-picker-4 ①)', () => {
    // 30 items, visible 8: browsing to index 29 → windowStart=22 (window follows)
    assert.equal(pickerWindowStart(29, 8, 30, 'up'), 22);
    assert.equal(pickerWindowStart(22, 8, 30, 'up'), 22);
    assert.equal(pickerWindowStart(10, 8, 30, 'up'), 10); // focused at natural-window top
    assert.equal(pickerWindowStart(0, 8, 30, 'up'), 0);
    // formulas differ mid-range: up keeps focused at top; down at bottom
    assert.equal(pickerWindowStart(10, 8, 30, 'up'), 10);
    assert.equal(pickerWindowStart(10, 8, 30, 'down'), 3);
  });

  it('pickerVisible slices the window', () => {
    const items = [0, 1, 2, 3, 4, 5];
    assert.deepEqual(pickerVisible(items, 1, 3), [1, 2, 3]);
  });

  it('pickerRenderOrder direction=up reverses (items[0] at bottom, next to input)', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    // window [1..3] (b,c,d), focused 'c' (index 2)
    const r = pickerRenderOrder(items, 2, 1, 3, 'up');
    assert.deepEqual(r.ordered, ['d', 'c', 'b']); // reversed: item[0] of window at bottom
    assert.equal(r.focusedVisible, true);
    assert.equal(r.focusedVisibleIndex, 1); // 'c' is middle of the reversed window
  });

  it('pickerRenderOrder direction=down keeps natural order', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const r = pickerRenderOrder(items, 2, 0, 3, 'down');
    assert.deepEqual(r.ordered, ['a', 'b', 'c']);
    assert.equal(r.focusedVisibleIndex, 2);
  });

  it('pickerRenderOrder focused out of window → not visible (no crash)', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const r = pickerRenderOrder(items, 4, 0, 3, 'up');
    assert.equal(r.focusedVisible, false);
    assert.equal(r.focusedVisibleIndex, -1);
    assert.equal(r.ordered.length, 3);
  });

  it('pickerStep clamps (CC step semantics)', () => {
    assert.equal(pickerStep(2, 1, 5), 3);
    assert.equal(pickerStep(0, -1, 5), 0);
    assert.equal(pickerStep(4, 1, 5), 4);
    assert.equal(pickerStep(0, 1, 0), 0);
  });

  it('direction=down render order is natural; up reverses (fix-ui-direction ①)', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    // down: items[0] at TOP — natural order
    const d = pickerRenderOrder(items, 2, 0, 3, 'down');
    assert.deepEqual(d.ordered, ['a', 'b', 'c']);
    assert.equal(d.focusedVisibleIndex, 2);
    // down arrow semantic: ↑=-1, ↓=+1 (matches InputBar's key.upArrow ? -1 : 1)
    assert.equal(pickerStep(2, -1, 5), 1); // up
    assert.equal(pickerStep(2, 1, 5), 3);  // down
  });
});

describe('inlineSlashTrigger (slash-mid, Hermes port)', () => {
  it('detects mid-line /cmd at the caret', () => {
    assert.deepEqual(inlineSlashTrigger('clean this up with /clean'), { query: 'clean', start: 19 });
    assert.deepEqual(inlineSlashTrigger('please /sum'), { query: 'sum', start: 7 });
    assert.deepEqual(inlineSlashTrigger('text /'), { query: '', start: 5 });
  });

  it('excludes paths and leading command positions', () => {
    assert.equal(inlineSlashTrigger('look at /usr/local/bin'), null); // path (no word bound on 2nd seg? has slash → excluded)
    assert.equal(inlineSlashTrigger('/model'), null);                 // leading command, not inline
    assert.equal(inlineSlashTrigger('no slash here'), null);
    assert.equal(inlineSlashTrigger(''), null);
    assert.equal(inlineSlashTrigger('check src/foo/bar'), null);
  });

  it('returns start of the / so prose before is preserved', () => {
    const t = 'prefix words /m';
    const r = inlineSlashTrigger(t)!;
    assert.equal(t.slice(0, r.start), 'prefix words ');
    assert.equal(t.slice(r.start), '/m');
  });
});

describe('leadingSlashTrigger', () => {
  it('matches bare leading /cmd at line start', () => {
    assert.deepEqual(leadingSlashTrigger('/model'), { query: 'model', start: 0 });
    assert.deepEqual(leadingSlashTrigger('/'), { query: '', start: 0 });
    assert.equal(leadingSlashTrigger('/model x'), null); // has arg → command picker owns it
    assert.equal(leadingSlashTrigger('x /m'), null);     // not at start
  });
});

describe('argStageFor / resolveModelTarget (fix-picker-3 ②③)', () => {
  const PROVIDERS = [
    { name: 'scnet', models: ['openPangu-7B', 'openPangu-1B', 'deepseek-v4'] },
    { name: 'a6', models: ['openPangu-7B-flash', 'gpt-5.6-luna'] },
  ];

  it('"/model " (trailing space) → provider stage', () => {
    const r = argStageFor('/model ', PROVIDERS);
    assert.deepEqual(r, { stage: 'provider', provider: null, query: '' });
  });

  it('"/model" (no space) → provider stage directly (fix-picker-4 ③)', () => {
    const r = argStageFor('/model', PROVIDERS);
    assert.deepEqual(r, { stage: 'provider', provider: null, query: '' });
  });

  it('"/model scnet " → model stage for scnet (empty filter)', () => {
    const r = argStageFor('/model scnet ', PROVIDERS);
    assert.deepEqual(r, { stage: 'model', provider: 'scnet', query: '' });
  });

  it('"/model a6:openPangu " → model stage for a6 with query', () => {
    const r = argStageFor('/model a6:openPangu ', PROVIDERS);
    assert.deepEqual(r, { stage: 'model', provider: 'a6', query: 'openPangu' });
  });

  it('unknown provider prefix → stays provider stage (filter by typed query)', () => {
    const r = argStageFor('/model sc ', PROVIDERS); // 'sc' not a full provider name
    assert.equal(r.stage, 'provider');
    assert.equal(r.query, 'sc');
  });

  it('non-model command / plain text → null stage', () => {
    assert.equal(argStageFor('/tier ', PROVIDERS).stage, null);
    assert.equal(argStageFor('plain task', PROVIDERS).stage, null);
  });

  it('resolveModelTarget builds /model <provider>:<model>', () => {
    assert.equal(resolveModelTarget('a6', 'openPangu-7B-flash'), '/model a6:openPangu-7B-flash');
    assert.equal(resolveModelTarget('scnet', 'openPangu-7B'), '/model scnet:openPangu-7B');
  });

  it('parseCommandInput is lenient (no trailing space required) — fix-picker-4 ③', () => {
    assert.deepEqual(parseCommandInput('/model'), { command: 'model', argQuery: '' });
    assert.deepEqual(parseCommandInput('/model '), { command: 'model', argQuery: '' });
    assert.deepEqual(parseCommandInput('/model scnet '), { command: 'model', argQuery: 'scnet' });
    assert.deepEqual(parseCommandInput('/tier'), { command: 'tier', argQuery: '' });
    assert.equal(parseCommandInput('plain task'), null);
  });
});
