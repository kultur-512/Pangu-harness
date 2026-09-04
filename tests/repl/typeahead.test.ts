// tests/repl/typeahead.test.ts
// cc-typeahead: unified suggestion engine — commands, providers/models,
// files, history; ghost text; preserved selection; arrow moves; Tab accept.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSuggestions,
  ghostTextFor,
  getPreservedSelection,
  moveSelection,
  acceptSuggestion,
  doubleEscState,
} from '../../src/cli/repl/typeahead.js';
import { PANSHA_COMMANDS } from '../../src/cli/repl/SlashPicker.js';

const PROVIDERS = [
  { name: 'scnet', models: ['openPangu-7B', 'openPangu-1B', 'deepseek-v4'] },
  { name: 'a6', models: ['openPangu-7B-flash', 'gpt-5.6-luna'] },
];

const CTX = { providers: PROVIDERS, files: ['src/a.ts', 'src/deep/b.ts', 'docs/readme.md'] };

describe('generateSuggestions', () => {
  it('/ → command suggestions (description-aware)', () => {
    const s = generateSuggestions('/', 1, CTX);
    assert.ok(s.length > 0);
    assert.ok(s.every((x) => x.type === 'command'));
    assert.ok(s[0].displayText.startsWith('/'));
    // /rollout → 'agents' via description keyword ('子代理 rollout 树')
    const su = generateSuggestions('/rollout', 8, { providers: [], files: [] });
    assert.ok(su.some((x) => x.displayText === '/agents'), `description-aware must surface /agents: ${su.map((x) => x.displayText)}`);
  });

  it('/mo → model provider suggestions; /model scnet → model suggestions', () => {
    const prov = generateSuggestions('/model ', 7, CTX);
    assert.ok(prov.some((x) => x.type === 'provider' && x.displayText === 'scnet'));
    assert.ok(prov.some((x) => x.type === 'provider' && x.displayText === 'a6'));

    const models = generateSuggestions('/model scnet ', 13, CTX);
    assert.ok(models.every((x) => x.type === 'model'));
    assert.ok(models.some((x) => x.displayText === 'openPangu-7B'));
    assert.ok(models[0].replacement.startsWith('/model scnet:'), 'model replacement is provider:model');
  });

  it('/model a6: → model suggestions for a6 with query', () => {
    const s = generateSuggestions('/model a6:openPangu', 13, CTX);
    assert.ok(s.every((x) => x.type === 'model' && x.metadata?.provider === 'a6'));
    assert.ok(s.some((x) => x.displayText === 'openPangu-7B-flash'));
  });

  it('@ or path → file/directory suggestions from injected list', () => {
    const s = generateSuggestions('read @src/', 9, CTX);
    assert.ok(s.some((x) => x.type === 'file' && x.displayText.includes('src/a.ts')));
    assert.ok(s.every((x) => x.id.startsWith('file:')));
  });

  it('plain text → history suggestions', () => {
    const s = generateSuggestions('fix', 3, { providers: [], history: ['fix the bug', 'fix the typo', 'unrelated'] });
    assert.deepEqual(s.map((x) => x.displayText), ['fix the bug', 'fix the typo']);
  });
});

describe('ghostTextFor', () => {
  it("/mo → 'del' (remainder of /model)", () => {
    const s = generateSuggestions('/mo', 3, { providers: [], files: [] });
    assert.equal(ghostTextFor('/mo', s), 'del');
  });

  it('no suggestions / explicit space → no ghost', () => {
    assert.equal(ghostTextFor('zzz', []), '');
    assert.equal(ghostTextFor('/model ', generateSuggestions('/model ', 7, CTX)), '');
  });
});

describe('getPreservedSelection / moveSelection / acceptSuggestion', () => {
  it('keeps selection by id across set changes', () => {
    const s1 = generateSuggestions('/mo', 3, { providers: [], files: [] });
    const sel0 = getPreservedSelection(s1, null);
    const id0 = s1[sel0].id;
    const s2 = generateSuggestions('/mod', 4, { providers: [], files: [] });
    assert.equal(s2[getPreservedSelection(s2, id0)].id, id0);
  });

  it('moveSelection clamps', () => {
    assert.equal(moveSelection(0, -1, 5), 0);
    assert.equal(moveSelection(4, 1, 5), 4);
    assert.equal(moveSelection(2, 1, 5), 3);
  });

  it('acceptSuggestion returns the replacement', () => {
    const s = generateSuggestions('/model ', 7, CTX).find((x) => x.displayText === 'a6')!;
    assert.equal(acceptSuggestion('/model ', s), '/model a6 ');
  });
});

describe('doubleEscState (T-29)', () => {
  it('first Esc → not double, records time', () => {
    const r = doubleEscState(1000, 0);
    assert.equal(r.isDouble, false);
    assert.equal(r.nextLastEsc, 1000);
  });

  it('second Esc within 300ms → double (clears)', () => {
    const r = doubleEscState(1100, 1000);
    assert.equal(r.isDouble, true);
    assert.equal(r.nextLastEsc, 0);
  });

  it('Esc after 300ms → not double (fresh timer)', () => {
    const r = doubleEscState(1500, 1000);
    assert.equal(r.isDouble, false);
    assert.equal(r.nextLastEsc, 1500);
  });

  it('works regardless of suggestionsDismissed (decoupled)', () => {
    // 300ms 内第二次：无条件 isDouble——不依赖 dismissed 标志
    const r1 = doubleEscState(2000, 0);
    const r2 = doubleEscState(2200, r1.nextLastEsc);
    assert.equal(r2.isDouble, true);
  });
});
