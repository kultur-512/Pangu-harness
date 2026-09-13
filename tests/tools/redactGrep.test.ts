// tests/tools/redactGrep.test.ts
// P2: redact.ts 模式扩展（Authorization 全值 / AKIA / ghp_ / PEM 私钥块）
// + grep 输出行接 redactSecrets 的集成回归。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../../src/utils/redact.js';
import { grep } from '../../src/tools/grep.js';
import type { ToolContext } from '../../src/tools/types.js';

describe('redactSecrets pattern coverage (P2 extensions)', () => {
  it('Authorization Bearer/Basic: the FULL value is redacted (no space truncation)', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig trailing-part-leak');
    assert.ok(!out.includes('eyJhbGci'), 'Bearer token leaked');
    assert.ok(!out.includes('trailing-part-leak'), 'value truncated at the space — the rest leaked');
    assert.ok(out.includes('Authorization:'), 'field name kept for readability');

    const basic = redactSecrets('authorization: Basic dXNlcjpwYXNzd29yZA==');
    assert.ok(!basic.includes('dXNlcjpwYXNzd29yZA=='), 'Basic value leaked');
  });

  it('AWS access key id (AKIA + 16 chars) fully redacted even bare', () => {
    const out = redactSecrets('AKIAIOSFODNN7EXAMPLE');
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key id leaked');
    assert.ok(out.includes('REDACTED'));
  });

  it('GitHub token (ghp_ + 20+ chars) fully redacted even bare', () => {
    const out = redactSecrets('ghp_1234567890abcdefghijklmnop');
    assert.ok(!out.includes('ghp_1234567890abcdefghijklmnop'), 'GitHub token leaked');
    assert.ok(out.includes('REDACTED'));
  });

  it('PEM private key block is replaced by [REDACTED] as a whole (whole-text mode)', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA12345secretbody',
      'morebase64bodylines',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`config:\n${pem}\nend`);
    assert.ok(!out.includes('MIIEpAIBAAKCAQEA12345secretbody'), 'private key body leaked');
    assert.ok(out.includes('[REDACTED]'), 'block must be replaced by [REDACTED]');
  });

  it('unpaired BEGIN/END PRIVATE KEY markers are neutralized per line', () => {
    const out = redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----');
    assert.ok(!out.includes('OPENSSH'), `marker line leaked: ${out}`);
    assert.ok(out.includes('[REDACTED]'));
  });

  it('lookalikes are not over-redacted', () => {
    assert.equal(redactSecrets('gho_short is not a token'), 'gho_short is not a token');
    assert.equal(redactSecrets('id AKIA1234 end'), 'id AKIA1234 end');
    assert.equal(redactSecrets('const authorizationRequired = true;'), 'const authorizationRequired = true;');
  });
});

describe('grep output redaction integration', () => {
  let root: string;
  let ctx: ToolContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-grep-redact-'));
    fs.writeFileSync(path.join(root, 'cfg.txt'), 'Authorization: Bearer sup3rs3crettokenvalue123\n');
    ctx = { workspaceRoot: root, approvalMode: 'readonly' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('grep output lines pass through redactSecrets', async () => {
    const r = await grep({ pattern: 'Authorization' }, ctx);
    assert.ok(r.ok);
    assert.ok(r.output.includes('cfg.txt:1:'), 'hit line present');
    assert.ok(!r.output.includes('sup3rs3crettokenvalue123'), 'grep must not leak the secret value');
    assert.ok(r.output.includes('REDACTED') || r.output.includes('[REDACTED]'), 'redaction marker expected');
  });
});
