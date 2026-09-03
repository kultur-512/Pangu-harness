// tests/server/agentServerAuth.test.ts
// S4 (security): /api/run authorization.
// - with a token configured: missing/wrong Bearer → rejected
// - without a token: localhost-only → non-local remote address rejected
// Health stays open; the pure decision fn is exported for direct testing.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAgentServer, isAuthorizedRequest } from '../../src/server/agentServer.js';

type ServerHandle = { close(): void; port: number };

async function startServer(opts: { serveToken?: string; corsOrigins?: string | string[] } = {}): Promise<ServerHandle> {
  const s = createAgentServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    serveToken: opts.serveToken,
    corsOrigins: opts.corsOrigins,
  });
  const port = await s.listen();
  return { close: () => s.close(), port };
}

function postRun(port: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/run',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ task: 'say hi' }));
  });
}

describe('S4 agentServer /api/run authorization', () => {
  const handles: ServerHandle[] = [];
  afterEach(() => { for (const h of handles) h.close(); handles.length = 0; });

  it('rejects with 401 when a token is configured but missing', async () => {
    const h = await startServer({ serveToken: 'topsecret' });
    handles.push(h);
    const r = await postRun(h.port);
    assert.equal(r.status, 401);
    assert.ok(r.body.includes('unauthorized'), 'expected unauthorized payload');
  });

  it('rejects with 401 on a wrong token', async () => {
    const h = await startServer({ serveToken: 'topsecret' });
    handles.push(h);
    const r = await postRun(h.port, { Authorization: 'Bearer wrong-token' });
    assert.equal(r.status, 401);
  });

  it('passes with the correct Bearer token', async () => {
    const h = await startServer({ serveToken: 'topsecret' });
    handles.push(h);
    const r = await postRun(h.port, { Authorization: 'Bearer topsecret' });
    // 200 + SSE start event (engine fails on model resolution afterwards, but
    // the auth gate itself must be open).
    assert.ok(r.status === 200, `expected 200, got ${r.status} body=${r.body.slice(0, 120)}`);
    assert.ok(r.body.includes('event: start'), 'expected SSE start event');
  });

  it('allows localhost callers when no token is configured', async () => {
    const h = await startServer({});
    handles.push(h);
    const r = await postRun(h.port);
    assert.equal(r.status, 200, 'localhost without token must be allowed');
  });
});

describe('S4 isAuthorizedRequest (pure decision fn)', () => {
  it('token configured: requires an exact matching Bearer token', () => {
    assert.equal(isAuthorizedRequest('10.0.0.5', undefined, 'tok'), false, 'no header');
    assert.equal(isAuthorizedRequest('10.0.0.5', 'Bearer wrong', 'tok'), false, 'wrong token');
    assert.equal(isAuthorizedRequest('10.0.0.5', 'Bearer tok', 'tok'), true, 'exact token');
    assert.equal(isAuthorizedRequest('127.0.0.1', 'Bearer tok', 'tok'), true, 'token wins over host');
  });

  it('no token: localhost only (IPv4 / IPv6 / localhost name)', () => {
    assert.equal(isAuthorizedRequest('127.0.0.1', undefined, undefined), true);
    assert.equal(isAuthorizedRequest('::1', undefined, undefined), true);
    assert.equal(isAuthorizedRequest('localhost', undefined, undefined), true);
    assert.equal(isAuthorizedRequest('10.0.0.5', undefined, undefined), false, 'remote host rejected');
    assert.equal(isAuthorizedRequest('::ffff:127.0.0.1', undefined, undefined), true, 'IPv4-mapped localhost');
    assert.equal(isAuthorizedRequest(undefined, undefined, undefined), false, 'unknown remote rejected');
  });
});
