// src/tools/types.ts
// M1-2.1: tool execution contracts (real-execution core).
// Engine-facing pieces stay string/JSON-serializable; nothing here imports ui/ or server/.

export interface DiffHunk {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

export interface ToolResult {
  ok: boolean;
  /** Already-truncated display text (may include line numbers / match lines). */
  output: string;
  durationMs: number;
  exitCode?: number;
  /**
   * Machine-readable failure class:
   * 'PATH_ESCAPED' | 'TIMEOUT' | 'DENIED_READONLY' | 'DENIED_BY_USER'
   * | 'RBW_VIOLATION' | 'UNKNOWN_TOOL' | 'INVALID_PARAMS' | 'INVALID_REGEX'
   * | 'BINARY_FILE' | 'FILE_TOO_LARGE' | 'IO' | 'OUTPUT_TRUNCATED' | 'ABORTED'
   */
  error?: string;
  truncated?: boolean;
  meta?: {
    diff?: DiffHunk[];
    danger?: boolean;
    lines?: number;
    nextOffset?: number;
    [k: string]: unknown;
  };
}

export interface ToolContext {
  workspaceRoot: string;
  approvalMode: 'readonly' | 'default' | 'full';
  signal?: AbortSignal;
}

export type ToolImpl = (params: Record<string, string>, ctx: ToolContext) => Promise<ToolResult>;

/** Shared output cap for every tool (per M1 instruction). */
export const TOOL_OUTPUT_CAP = 20_000;
/** File-tool hard timeout (per M1 instruction). */
export const FILE_TOOL_TIMEOUT_MS = 5_000;

/** Apply the unified 20k output cap. Mutates a copy, returns it. */
export function applyOutputCap(res: ToolResult): ToolResult {
  if (res.output && res.output.length > TOOL_OUTPUT_CAP) {
    return {
      ...res,
      output: res.output.slice(0, TOOL_OUTPUT_CAP) + `\n…[truncated at ${TOOL_OUTPUT_CAP} chars]`,
      truncated: true,
    };
  }
  return res;
}
