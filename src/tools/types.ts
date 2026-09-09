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
    /**
     * M2-3 internal: the FULL pre-cap output, stashed by applyOutputCap when
     * `output` exceeds TOOL_OUTPUT_CAP. Never displayed; engineAdapter persists
     * it to scratch and substitutes a head/tail preview. Not serialized anywhere.
     */
    fullOutput?: string;
    /** M2-3 internal: relative workspace path where the full output was persisted. */
    persistedOutput?: string;
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

/** Apply the unified 20k output cap. Mutates a copy, returns it.
 *  M2-3: when truncating, the FULL pre-cap output is preserved in
 *  `meta.fullOutput` (never shown); engineAdapter persists it to scratch and
 *  substitutes a head/tail preview for the model. If a tool already attached a
 *  longer `meta.fullOutput` (e.g. bash's in-tool 20k display cap), keep that. */
export function applyOutputCap(res: ToolResult): ToolResult {
  if (res.output && res.output.length > TOOL_OUTPUT_CAP) {
    const existingFull = typeof res.meta?.fullOutput === 'string' ? res.meta.fullOutput : undefined;
    const full = existingFull && existingFull.length >= res.output.length ? existingFull : res.output;
    return {
      ...res,
      output: res.output.slice(0, TOOL_OUTPUT_CAP) + `\n…[truncated at ${TOOL_OUTPUT_CAP} chars]`,
      truncated: true,
      meta: { ...res.meta, fullOutput: full },
    };
  }
  return res;
}
