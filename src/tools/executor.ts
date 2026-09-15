// src/tools/executor.ts
// 工具执行内核。
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

// ---- T2 参数名别名归一（openPangu 配合度修复）----
// 探查实证：文本协议下模型看不到参数名 → 参数幻觉频发（`filepath`→EMPTY_PATH、
// grep `command`→requires pattern）——解析成功但执行必败。别名在执行内核入口
// 按工具收敛：executor.execute 与 engineAdapter.runCall（门禁/敏感路径/RBW
// checkpoint 之前）都过 normalizeToolParams，保证下游看到同一套规范键。
const TOOL_PARAM_ALIASES: Record<string, Record<string, string>> = {
  read_file: { filepath: 'file_path', filename: 'file_path' },
  write_file: { filepath: 'file_path', filename: 'file_path' },
  edit_file: { filepath: 'file_path', filename: 'file_path' },
  glob: { query: 'pattern', command: 'pattern' },
  grep: { query: 'pattern', command: 'pattern' },
};

/**
 * 把已知的参数名别名收敛到各工具实现读取的规范键。
 * - 非破坏性：别名键保留（工具实现内的 `?? path` 兜底链不受影响）；
 * - 规范键优先：canonical 已存在时别名值被忽略；
 * - 未知工具 / 无别名表 → 原样返回。
 */
export function normalizeToolParams(toolName: string, params: Record<string, string>): Record<string, string> {
  const aliases = TOOL_PARAM_ALIASES[normalizeToolName(toolName)];
  if (!aliases || !params) return params;
  let out: Record<string, string> | undefined;
  for (const [aliasKey, canonicalKey] of Object.entries(aliases)) {
    if (params[aliasKey] !== undefined && params[canonicalKey] === undefined) {
      if (!out) out = { ...params };
      out[canonicalKey] = params[aliasKey];
    }
  }
  return out ?? params;
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

/** MCP 工具注册（命名空间 mcp_<server>_<tool>）。 */
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

  // MCP 工具 — 命名空间 `mcp_<server>_<tool>`；冲突时内建优先
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
      // T2：参数名别名收敛（filepath→file_path、grep/glob 的 command/query→pattern）
      const canonicalParams = normalizeToolParams(toolName, params);
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
        const res = await withTimeout(Promise.resolve().then(() => entry.impl(canonicalParams, ctx)), entry.timeoutMs, ctx.signal);
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
