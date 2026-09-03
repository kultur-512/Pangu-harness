// src/server/sse.ts
// Minimal SSE (Server-Sent Events) helpers using Node built-ins.
// No external dependencies. Designed for streaming agent events.

import type { ServerResponse } from 'http';

export interface SseOptions {
  heartbeatMs?: number; // default 15000
}

export class SseConnection {
  private res: ServerResponse;
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(res: ServerResponse, opts: SseOptions = {}) {
    this.res = res;

    // Standard SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Flush headers immediately (important for some proxies)
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }

    // Send a comment to open the stream in some clients
    this.writeRaw(': connected\n\n');

    // Heartbeat to keep connections alive through proxies
    const hb = opts.heartbeatMs ?? 15000;
    this.heartbeatTimer = setInterval(() => {
      if (!this.closed) {
        this.writeRaw(': hb\n\n');
      }
    }, hb);

    // Handle client disconnect
    res.on('close', () => this.dispose());
    res.on('error', () => this.dispose());
  }

  /**
   * Send a named event with JSON data.
   * Example:
   *   send('step', { stepNumber: 1, thinking: '...' })
   */
  send(event: string, data: unknown): void {
    if (this.closed) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.writeRaw(`event: ${event}\n`);
    this.writeRaw(`data: ${payload}\n\n`);
  }

  /**
   * Send a raw comment or data line. Use sparingly.
   */
  writeRaw(str: string): void {
    if (this.closed) return;
    try {
      this.res.write(str);
    } catch {
      this.dispose();
    }
  }

  /**
   * Send a final event and close the connection.
   */
  close(finalEvent?: string, finalData?: unknown): void {
    if (this.closed) return;
    if (finalEvent) {
      this.send(finalEvent, finalData ?? {});
    }
    this.dispose();
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      this.res.end();
    } catch {}
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Convenience: create an SSE connection from an http.ServerResponse.
 */
export function createSse(res: ServerResponse, opts?: SseOptions): SseConnection {
  return new SseConnection(res, opts);
}
