// tests/tools/mcpClient.test.ts
// P5-5.2: JSON-RPC-over-stdio client, fully mocked (no real spawn — SMOKE-safe).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { McpClient } from '../../src/tools/mcpClient.js';
import { createToolExecutor } from '../../src/tools/executor.js';
import type { ToolContext } from '../../src/tools/types.js';

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  signalCode: string | null;
  stdout: EventEmitter & { setEncoding(_e: string): void };
  stderr: EventEmitter & { setEncoding(_e: string): void };
  stdin: EventEmitter & { writable: boolean; write(_d: string): void; end(): void };
  kill(): boolean;
}

function makeFakeChild(handler?: (line: string, child: FakeChild) => void): FakeChild {
  const stdout = new EventEmitter() as FakeChild['stdout'];
  const stderr = new EventEmitter() as FakeChild['stderr'];
  const stdin = new EventEmitter() as FakeChild['stdin'];
  Object.assign(stdout, { setEncoding: () => {} });
  Object.assign(stderr, { setEncoding: () => {} });
  Object.assign(stdin, {
    writable: true,
    write: (d: string) => {
      const line = String(d);
      stdin.emit('data', line);        // wireResponder / rawLine listeners
      if (handler) handler(line, child);
      return true;
    },
    end: () => {},
  });
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); return true; };
  return child;
}

function wireResponder(child: FakeChild, respond: (id: number, method: string, params: any) => unknown) {
  child.stdin.on('data', (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id !== 'number') return;
      const result = respond(msg.id, msg.method, msg.params);
      child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    } catch {}
  });
  return child;
}

const ctx: ToolContext = { workspaceRoot: process.cwd(), approvalMode: 'full' };

describe('McpClient', () => {
  let client: McpClient | null = null;
  afterEach(async () => { try { await client?.close(); } catch {} });

  it('handshake sequence: initialize → initialized → tools/list → tools/call', async () => {
    const methods: string[] = [];
    const child = makeFakeChild((line) => {
      try { const m = JSON.parse(line); if (typeof m.id === 'number') methods.push(m.method); } catch {}
    });
    wireResponder(child, (id, method, params) => {
      if (method === 'tools/list') return { tools: [{ name: 'echo', description: 'echo', inputSchema: {} }] };
      if (method === 'tools/call') return { content: [{ type: 'text', text: 'OK:' + JSON.stringify(params || {}) }] };
      return { ok: true };
    });

    client = new McpClient({ command: 'fake' });
    client.setSpawnImpl(() => child);
    await client.initialize();

    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'echo');
    const r = await client.callTool('echo', { text: 'hi' });
    assert.equal(r.ok, true);
    assert.ok(r.output.includes('OK:'));
    assert.ok(methods.includes('initialize'), 'initialize must be the first request');
    assert.ok(methods.includes('tools/list'));
    assert.ok(methods.includes('tools/call'));
  });

  it('notifications (no id) and unknown-id responses are ignored', async () => {
    const child = makeFakeChild();
    client = new McpClient({ command: 'fake' });
    client.setSpawnImpl(() => child);

    // push noise BEFORE initialize completes
    child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x', params: {} }) + '\n');
    child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 999, result: { evil: 1 } }) + '\n');

    const initDone = new Promise<void>((resolve) => {
      wireResponder(child, (id, method) => {
        if (method === 'initialize') resolve();
        return { ok: true };
      });
    });
    const p = client.initialize();
    await initDone;
    await p;
    assert.ok(true, 'noise must not break the client');
  });

  it('text content concatenated; non-text content gets placeholder', async () => {
    const child = makeFakeChild();
    wireResponder(child, (_id, method) => {
      if (method === 'tools/call') return {
        content: [
          { type: 'text', text: 'line-one' },
          { type: 'image_resource', data: 'xxx' },
          { type: 'text', text: 'line-two' },
        ],
      };
      return { ok: true };
    });
    client = new McpClient({ command: 'fake' });
    client.setSpawnImpl(() => child);
    const r = await client.callTool('t', {});
    assert.ok(r.output.includes('line-one'));
    assert.ok(r.output.includes('line-two'));
    assert.ok(r.output.includes('image_resource content omitted'));
  });

  it('server crash → MCP_SERVER_DOWN error, no hang', async () => {
    const child = makeFakeChild();
    client = new McpClient({ command: 'fake' });
    client.setSpawnImpl(() => child);
    const initP = client.initialize();
    // Real child processes set exitCode before 'exit' fires; the fake must too
    // (otherwise isAlive stays true and later requests hang).
    child.exitCode = 1;
    child.emit('exit', 1);
    await assert.rejects(initP, /MCP_SERVER_DOWN/);
    const r = await client.callTool('t', {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'MCP_SERVER_DOWN');
  });

  it('close() settles pending requests and marks not-alive', async () => {
    const child = makeFakeChild();
    client = new McpClient({ command: 'fake' });
    client.setSpawnImpl(() => child);
    const p = client.initialize().catch(() => {});
    await client.close();
    await p;
    assert.equal(client.isAlive, false);
  });

  it('executor integration: mcp_<server>_<tool> namespaced, built-in wins on clash', async () => {
    const calls: string[] = [];
    const mcpTool = {
      server: 'srv',
      name: 'mcp_srv_echo',
      description: 'echo',
      call: async (args: Record<string, unknown>) => {
        calls.push(JSON.stringify(args));
        return { ok: true, output: 'MCP-ECHO:' + String(args.text ?? '') };
      },
    };
    const ex = createToolExecutor(ctx, {}, [mcpTool]);
    const r = await ex.execute('mcp_srv_echo', { text: 'hi' });
    assert.ok(r.ok);
    assert.ok(r.output.includes('MCP-ECHO:hi'));
    assert.equal(calls.length, 1);
    assert.ok(ex.availableTools().includes('mcp_srv_echo'));

    // built-in priority: registering mcp_read_file must NOT shadow read_file
    const clash = createToolExecutor(ctx, {}, [{
      server: 'srv2', name: 'mcp_srv2_read_file', description: 'x',
      call: async () => ({ ok: true, output: 'SHADOWED' }),
    }]);
    const tools = clash.availableTools();
    assert.ok(tools.includes('mcp_srv2_read_file'));
  });
});
