// tests/repl/e2e.test.ts
// Minimal E2E-style tests for ZIS REPL per blueprint v1.1
// These are integration-style checks that exercise the public surface without full TTY.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Repl } from '../../src/cli/repl/Repl.js';
import { Session } from '../../src/cli/repl/Session.js';

describe('ZIS REPL E2E smoke', () => {
  it('runOneShot("/help") produces command list output', async () => {
    const session = new Session();
    const repl = new Repl({ session });

    // Capture stdout
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk: any) => {
      captured += String(chunk);
      return true;
    };

    try {
      await repl.runOneShot(['help']);
    } finally {
      process.stdout.write = origWrite;
      // M2.0 hang fix: release the readline handle so node --test exits cleanly
      try { (repl as any).input?.close?.(); } catch {}
    }

    assert.ok(captured.includes('可用命令'), 'help should list commands');
    assert.ok(captured.includes('/tier'), 'help should mention tier command');
    assert.ok(captured.includes('/exit'), 'help should mention exit');
  });

  it('runOneShot("/status") shows current tier and workspace', async () => {
    const session = new Session({ tier: 'standard', workspace: '/tmp/test-ws' });
    const repl = new Repl({ session });

    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk: any) => { captured += String(chunk); return true; };

    try {
      await repl.runOneShot(['status']);
    } finally {
      process.stdout.write = origWrite;
      // M2.0 hang fix: release the readline handle so node --test exits cleanly
      try { (repl as any).input?.close?.(); } catch {}
    }

    assert.ok(captured.includes('standard') || captured.includes('STANDARD'), 'status should show tier');
    assert.ok(captured.includes('/tmp/test-ws') || captured.includes('test-ws'), 'status should show workspace');
  });

  it('runOneShot with unknown command returns message (no crash)', async () => {
    const session = new Session();
    const repl = new Repl({ session });

    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk: any) => { captured += String(chunk); return true; };

    try {
      await repl.runOneShot(['no-such-cmd-xyz']);
    } finally {
      process.stdout.write = origWrite;
      // M2.0 hang fix: release the readline handle so node --test exits cleanly
      try { (repl as any).input?.close?.(); } catch {}
    }

    assert.ok(captured.includes('未知命令') || captured.length > 0, 'should handle unknown command gracefully');
  });

  it('old CLI simulate path still works via runOneShot (compatibility)', async () => {
    // This exercises the one-shot path that old "pangu simulate ..." would hit.
    const session = new Session({ tier: 'quick' });
    const repl = new Repl({ session });

    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk: any) => { captured += String(chunk); return true; };

    try {
      // We don't actually want to run a heavy task here; just ensure it doesn't explode on parsing.
      // Use simulate which is lighter.
      await repl.runOneShot(['simulate', 'a tiny task']);
    } finally {
      process.stdout.write = origWrite;
      // M2.0 hang fix: release the readline handle so node --test exits cleanly
      try { (repl as any).input?.close?.(); } catch {}
    }

    // At minimum it should have printed something (info or simulate header)
    assert.ok(captured.length > 0, 'simulate one-shot should produce output');
  });
});
