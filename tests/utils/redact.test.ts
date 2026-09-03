// tests/utils/redact.test.ts
// S3 (security): redactSecrets / redactAnchorLines must strip sk- prefixed
// keys (any length, quoted or bare), Bearer tokens, and apiKey/secret/password
// pairs — without damaging ordinary text or line structure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactAnchorLines, REDACTED } from '../../src/utils/redact.js';

describe('redactSecrets', () => {
  it('redacts sk- prefixed keys (quoted JSON form)', () => {
    const out = redactSecrets('"apiKey": "sk-tp-Mzg5LTIxNzUzMzg5Njc1LTE3ODY5NTE2MTczMTA="');
    assert.ok(!out.includes('sk-tp-Mzg5'), 'sk- key leaked');
    assert.ok(out.includes(REDACTED), 'expected redaction marker');
  });

  it('redacts sk- prefixed keys (bare form, no quotes)', () => {
    const out = redactSecrets('key=sk-abcdefghijklmnopqrstuvwxyz1234567890');
    assert.ok(!out.includes('sk-abcdefghijklmnop'), 'bare sk- key leaked');
    assert.ok(out.includes(REDACTED));
  });

  it('redacts short sk- keys (>= 8 alnum chars)', () => {
    const out = redactSecrets('token sk-12345678 rest');
    assert.ok(!out.includes('sk-12345678'), 'short sk- key leaked');
    assert.ok(out.includes(REDACTED));
  });

  it('redacts apiKey/secret/password key-value pairs keeping the field name', () => {
    for (const sample of [
      'apiKey: sk-abcdef1234567890',
      'api_key = "some-secret-value"',
      'secret: hunter2',
      'password= p@ssw0rd123',
      'token: abcdef1234567890',
    ]) {
      const out = redactSecrets(sample);
      assert.ok(!/hunter2|p@ssw0rd|some-secret|abcdef1234567890/.test(out), `value leaked: ${sample}`);
      assert.ok(out.includes(REDACTED), `no redaction for: ${sample}`);
    }
  });

  it('redacts Bearer tokens', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');
    assert.ok(!out.includes('eyJhbGci'), 'Bearer token leaked');
    assert.ok(out.includes(REDACTED));
  });

  it('leaves ordinary text untouched', () => {
    const sample = 'export function add(a, b) { return a + b; } // sum comment';
    assert.equal(redactSecrets(sample), sample);
  });

  it('does not redact sk- followed by fewer than 8 alnum chars (not a key)', () => {
    // e.g. a variable named "sk-" or "skin"/"skip" words must survive.
    assert.equal(redactSecrets('const x = "skin";'), 'const x = "skin";');
    assert.equal(redactSecrets('skip to the end'), 'skip to the end');
  });

  it('handles empty / non-string gracefully', () => {
    assert.equal(redactSecrets(''), '');
    assert.equal(redactSecrets(undefined as any), undefined);
  });
});

describe('redactAnchorLines', () => {
  it('redacts per line and caps at maxLines', () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`line ${i} apiKey: sk-secret${i}12345678`);
    const out = redactAnchorLines(lines.join('\n'), 80);
    assert.ok(!out.includes('sk-secret'), 'anchor sk- key leaked');
    assert.equal(out.split('\n').length, 80, 'anchor lines must be capped');
    assert.ok(out.split('\n').every((l) => l.includes(REDACTED)));
  });
});
