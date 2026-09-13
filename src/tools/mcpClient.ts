// src/tools/mcpClient.ts
// minimal MCP (Model Context Protocol) stdio client — hand-written
// JSON-RPC 2.0 over a spawned child process. Zero dependencies.
//
// Protocol (per MCP spec subset):
//   initialize → initialized notification → tools/list → tools/call
// Each request is a single JSON line with an incrementing id; responses are
// matched by id; notifications (no id) are ignored. 30s request timeout
// (unref'd + cleared). close() kills the child and MUST be called on session
// exit (M2.0 hang discipline). A crashed server surfaces MCP_SERVER_DOWN.

import { spawn, ChildProcess } from 'child_process';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private stderrTail = '';
  private initialized = false;
  private closing = false;

  /** Test hook: inject a fake child (SMOKE-safe, no real spawn). */
  private spawnImpl: (() => ChildProcess) | null = null;

  constructor(private cfg: McpServerConfig) {}

  setSpawnImpl(fn: () => ChildProcess): void {
    this.spawnImpl = fn;
  }

  get isAlive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Spawn + JSON-RPC handshake (initialize + initialized). */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.child = this.spawnImpl
      ? this.spawnImpl()
      : spawn(this.cfg.command, this.cfg.args ?? [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(this.cfg.env ?? {}) },
          windowsHide: true,
        });

    this.child.stdout?.setEncoding('utf-8');
    this.child.stdout?.on('data', (d: string) => this.onData(d));
    this.child.stderr?.on('data', (d: Buffer | string) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-4000);
    });
    this.child.on('error', () => {
      this.rejectAll(new Error('MCP_SERVER_DOWN: failed to spawn server process'));
    });
    this.child.on('exit', (code) => {
      if (!this.closing) {
        this.rejectAll(new Error(`MCP_SERVER_DOWN: server exited (code ${code})`));
      }
    });

    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'panshalach', version: '0.5.0' },
    });
    void init; // server may return capabilities; we don't require any
    this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) await this.initialize();
    const res = (await this.request('tools/list', {})) as any;
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools.map((t: any) => ({
      name: String(t.name || ''),
      description: String(t.description || ''),
      inputSchema: (t.inputSchema ?? {}) as object,
    }));
  }

  async callTool(name: string, args: object): Promise<{ ok: boolean; output: string; error?: string }> {
    try {
      if (!this.initialized) await this.initialize();
      const res = (await this.request('tools/call', { name, arguments: args })) as any;
      const content = Array.isArray(res?.content) ? res.content : [];
      const texts: string[] = [];
      for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
        else if (c?.type) texts.push(`[${c.type} content omitted]`);
      }
      const isError = !!res?.isError;
      const output = texts.join('\n') || '(no output)';
      return { ok: !isError, output, error: isError ? 'MCP_TOOL_ERROR' : undefined };
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes('MCP_SERVER_DOWN')) {
        return { ok: false, output: '', error: 'MCP_SERVER_DOWN' };
      }
      return { ok: false, output: '', error: `MCP_CALL_FAILED: ${msg}` };
    }
  }

  /**
   * Kill the child (WHOLE process tree) and settle everything (session exit).
   * P2: 对齐 bash.ts 的树杀——MCP server 常会再拉起孙进程，只杀直接子进程
   * 会留下孤儿。Windows taskkill /T /F；POSIX kill(-pid) 进程组击杀。
   */
  async close(): Promise<void> {
    this.closing = true;
    this.rejectAll(new Error('MCP_CLOSED'));
    if (this.child) {
      const pid = this.child.pid;
      try {
        if (pid) {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          } else {
            try { process.kill(-pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
          }
        } else {
          this.child.kill();
        }
      } catch {
        try { this.child.kill(); } catch {}
      }
      this.child = null;
    }
    this.initialized = false;
  }

  private onData(d: string): void {
    this.buffer += d;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || 'MCP_RPC_ERROR'));
            else p.resolve(msg.result);
          }
        }
        // notifications (no id) ignored
      } catch {
        // malformed line from server — ignore, don't crash
      }
    }
  }

  private sendNotification(method: string, params: unknown): void {
    this.writeLine({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.isAlive) {
      return Promise.reject(new Error('MCP_SERVER_DOWN: server process is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP_TIMEOUT: ${method} took > ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeLine(obj: object): void {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
