// src/tools/executor.ts
// M1-2.1: tool execution kernel.
// - name normalization + alias table (case-insensitive)
// - unified 20k output cap
// - 5s hard timeout for file tools
// - unknown tool → UNKNOWN_TOOL with available-tool list
// - extraTools: later batches (bash in 2.2, write/edit in 2.3) register here

import { readFile } from './readFile.js';
import { glob } from './glob.js';
import { grep } from './grep.js';
import { applyOutputCap, FILE_TOOL_TIMEOUT_MS, type ToolContext, type ToolImpl, type ToolResult } from './types.js';

export const TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  read_file: 'read_file',
  readfile: 'read_file',
  view: 'read_file',
  cat: 'read_file',
  glob: 'glob',
  ls: 'glob',
  grep: 'grep',
  search: 'grep',
  bash: 'bash',
  run_command: 'bash',
  shell: 'bash',
  write: 'write_file',
  write_file: 'write_file',
  writefile: 'write_file',
  edit: 'edit_file',
  edit_file: 'edit_file',
  editfile: 'edit_file',
  str_replace: 'edit_file',
};

export function normalizeToolName(name: string): string {
  const key = String(name || '').trim().toLowerCase();
  return TOOL_ALIASES[key] || key;
}

function withTimeout(p: Promise<ToolResult>, ms: number, signal?: AbortSignal): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, output: `✗ tool timed out after ${ms}ms`, durationMs: ms, error: 'TIMEOUT' });
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: '✗ aborted', durationMs: 0, error: 'ABORTED' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (res) => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, output: `✗ ${err?.message || err}`, durationMs: ms, error: 'IO' });
      }
    );
  });
}

export interface ToolExecutor {
  execute(toolName: string, params: Record<string, string>): Promise<ToolResult>;
  /** Normalized names of the tools this executor can run. */
  availableTools(): string[];
}

/** P5-5.2: an MCP-backed tool registration (namespaced mcp_<server>_<tool>). */
export interface McpRegisteredTool {
  server: string;
  name: string;                 // namespaced full name
  description: string;
  call(args: Record<string, unknown>): Promise<{ ok: boolean; output: string; error?: string }>;
}

export function createToolExecutor(
  ctx: ToolContext,
  extraTools: Record<string, ToolImpl> = {},
  mcpTools: McpRegisteredTool[] = []
): ToolExecutor {
  const registry = new Map<string, { impl: ToolImpl; timeoutMs: number }>();

  // Built-in file tools (5s timeout per M1 instruction)
  registry.set('read_file', { impl: readFile, timeoutMs: FILE_TOOL_TIMEOUT_MS });
  registry.set('glob', { impl: glob, timeoutMs: FILE_TOOL_TIMEOUT_MS });
  registry.set('grep', { impl: grep, timeoutMs: FILE_TOOL_TIMEOUT_MS });

  // Extension hook for later batches (bash / write_file / edit_file)
  for (const [name, impl] of Object.entries(extraTools)) {
    const norm = normalizeToolName(name);
    const timeoutMs = norm === 'bash' ? 600_000 : FILE_TOOL_TIMEOUT_MS;
    registry.set(norm, { impl, timeoutMs });
  }

  // P5-5.2: MCP tools — namespaced `mcp_<server>_<tool>`; built-ins win on clash
  for (const mt of mcpTools) {
    if (registry.has(mt.name)) continue; // built-in priority
    const impl: ToolImpl = async (params) => {
      const start = Date.now();
      // params values are strings (tool call contract); keep them as-is for MCP
      const r = await mt.call({ ...params });
      return {
        ok: r.ok,
        output: r.output || (r.error ? `✗ ${r.error}` : '(no output)'),
        durationMs: Date.now() - start,
        error: r.error,
      };
    };
    registry.set(mt.name, { impl, timeoutMs: 120_000 }); // MCP calls may be slow
  }

  return {
    async execute(toolName: string, params: Record<string, string>): Promise<ToolResult> {
      const norm = normalizeToolName(toolName);
      const entry = registry.get(norm);
      if (!entry) {
        return {
          ok: false,
          output: `✗ UNKNOWN_TOOL: ${toolName}. 可用工具: ${[...registry.keys()].sort().join(', ')}`,
          durationMs: 0,
          error: 'UNKNOWN_TOOL',
        };
      }
      try {
        const res = await withTimeout(Promise.resolve().then(() => entry.impl(params, ctx)), entry.timeoutMs, ctx.signal);
        return applyOutputCap(res);
      } catch (e: any) {
        return applyOutputCap({ ok: false, output: `✗ ${e?.message || e}`, durationMs: 0, error: 'IO' });
      }
    },

    availableTools(): string[] {
      return [...registry.keys()].sort();
    },
  };
}
