// src/server/agentServer.ts
// Minimal HTTP + SSE server to expose Panshalach agent runs to a frontend.
// Optional and non-intrusive: the default CLI now consumes runAgentTask()
// directly in-process; this server exists for remote/browser clients and
// the explicit `serve` command.

import http from 'http';
import { createSse, SseConnection } from './sse.js';
import { runAgentTask } from './runAgentTask.js';
import type { RunRequest, RunResult } from './runAgentTask.js';
import type { ModelProvider } from '../cli/repl/types.js';

export type { RunRequest, RunResult };

/**
 * S4: pure authorization decision for /api/run.
 * - With a token configured: request must carry `Authorization: Bearer <token>`.
 * - Without a token: only localhost remote addresses are allowed (defense
 *   against accidental exposure when --host is opened to the network).
 * Exported for direct unit testing.
 */
export function isAuthorizedRequest(
  remoteAddress: string | undefined,
  authHeader: string | undefined,
  serveToken: string | undefined
): boolean {
  const token = serveToken || process.env.ZORGE_SERVE_TOKEN || '';
  const addr = (remoteAddress || '').replace(/^::ffff:/, '');
  if (token) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader || '');
    return !!m && m[1] === token;
  }
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost';
}

export interface AgentServerOptions {
  port?: number;
  host?: string;
  provider?: ModelProvider;
  defaultTier?: string;
  defaultWorkspace?: string;
  quiet?: boolean;            // when true, suppress ALL console output
  /**
   * S4: optional bearer token for /api/run. When set, every request must carry
   * `Authorization: Bearer <token>`; otherwise it is rejected with 401.
   * No token configured → localhost-only safety net: requests from any host
   * other than 127.0.0.1/::1 are rejected (defense against accidental
   * exposure when --host is opened to the network).
   */
  serveToken?: string;
  /**
   * S4: allowed CORS origin(s). Defaults to localhost-only origins; pass '*'
   * explicitly to allow any (not recommended without a token).
   */
  corsOrigins?: string | string[];
}

type ActiveRun = {
  id: string;
  sse: SseConnection;
  abort: () => void;
};

let runCounter = 0;

export function createAgentServer(opts: AgentServerOptions = {}) {
  const port = opts.port ?? 3456;
  const host = opts.host ?? '127.0.0.1';
  const isQuiet = !!opts.quiet;
  const serveToken = opts.serveToken || process.env.ZORGE_SERVE_TOKEN || '';
  const corsOrigins = opts.corsOrigins ?? ['http://127.0.0.1', 'http://localhost'];

  const corsList: string[] = Array.isArray(corsOrigins)
    ? corsOrigins
    : [corsOrigins];
  const corsAny = corsList.includes('*');

  // Absolute silence contract for embedded default CLI:
  // When quiet===true, this module MUST NEVER output anything to console,
  // including on listen, errors inside the server, or request handling.
  const log = isQuiet ? (() => {}) : console.log;
  const logErr = isQuiet ? (() => {}) : console.error;

  function isLocalhost(addr: string | undefined): boolean {
    return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === 'localhost');
  }

  /** S4: resolve the origin allowed for this request ('' = none). */
  function allowedOrigin(req: http.IncomingMessage): string {
    if (corsAny) return '*';
    const origin = req.headers.origin;
    if (!origin) return '';
    if (corsList.includes(origin)) return origin;
    // Origin of the form http://host:port — compare host part against the
    // localhost origins we default to.
    try {
      const o = new URL(origin);
      if (isLocalhost(o.hostname)) return origin;
    } catch {}
    return '';
  }

  /** S4: reject when a token is required but missing/wrong, or non-local. */
  function authorize(req: http.IncomingMessage): boolean {
    return isAuthorizedRequest(
      req.socket.remoteAddress,
      req.headers.authorization,
      serveToken
    );
  }

  const server = http.createServer(async (req, res) => {
    const origin = allowedOrigin(req);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Vary', 'Origin');
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (corsAny) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health (no auth — liveness probes)
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'zorge-agent' }));
      return;
    }

    // POST /api/run  -> direct SSE stream for the run
    if (req.method === 'POST' && (url.pathname === '/api/run' || url.pathname === '/run')) {
      // S4: gate the run endpoint (health stays open).
      if (!authorize(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'unauthorized',
          message: serveToken ? 'missing or invalid Bearer token' : 'requests allowed from localhost only',
        }));
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let payload: RunRequest;
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }

        if (!payload.task || typeof payload.task !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'task_required' }));
          return;
        }

        // Create SSE connection on this response
        const sse = createSse(res, { heartbeatMs: 15000 });

        const runId = `run_${Date.now()}_${++runCounter}`;
        sse.send('start', { runId, task: payload.task });

        const abortController = new AbortController();

        // Wire abort if client disconnects
        req.on('close', () => {
          abortController.abort();
        });

        try {
          const result = await runAgentTask(payload, {
            provider: opts.provider,
            onEvent: (event) => {
              // Forward every internal event as SSE
              sse.send(event.type || 'event', event);
            },
            signal: abortController.signal,
          });

          sse.send('done', {
            runId,
            success: result.success,
            score: result.score,
            durationMs: result.durationMs,
          });

          // Give the client a moment to receive the final event, then close
          setTimeout(() => sse.close(), 50);
        } catch (err: any) {
          sse.send('error', { message: err?.message || String(err) });
          sse.close();
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  // Absolute silence in quiet mode: route server errors through guarded log wrappers.
  server.on('error', (err: any) => {
    logErr('[zorge-agent-server] error:', err && err.message ? err.message : err);
  });

  function listen(): Promise<number> {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;

        // Absolute silence when quiet (embedded as default CLI transport).
        // Use the pre-bound wrappers (log/logErr) so even if someone adds logs later,
        // quiet path stays completely silent.
        if (!opts.quiet) {
          log(`[panshalach] SSE agent server listening on http://${host}:${actualPort}`);
          log(`  POST /api/run   -> stream events via SSE`);
        }
        resolve(actualPort);
      });
    });
  }

  function close() {
    server.close();
  }

  return { server, listen, close, port, host };
}
