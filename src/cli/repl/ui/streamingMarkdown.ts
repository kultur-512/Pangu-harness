// src/cli/repl/ui/streamingMarkdown.ts
// incremental markdown for in-flight assistant text (Hermes-style
// frozen-blocks approach, adapted to Panshalach's lightweight Markdown.tsx).
//
// Why: re-rendering the full text through the markdown parser on every delta
// is O(total) x deltas. Instead we freeze settled top-level blocks (split on
// blank lines outside code fences) into an append-only array — each is parsed
// exactly once (React.memo-friendly immutable content) — and only the
// in-flight remainder renders per delta.
//
// Correctness model (the subtle part):
// - feedStreamDelta() takes APPENDED text (the new suffix only).
// - `lineBuf` holds ONLY the partial trailing line whose terminating '\n' has
//   not arrived yet. A '\n' arriving in a later delta terminates THAT line
//   instead of being mistaken for an empty line (a naive single-buffer design
//   settles spurious blocks across chunk boundaries).
// - `blockBuf` accumulates complete lines of the in-flight block.
// - A blank line outside a fence settles blockBuf into blocks[].
// - State only advances; callers reset by constructing a fresh state.

export interface StreamScanState {
  /** Settled top-level blocks, in order. Append-only. */
  blocks: string[];
  /** Complete lines of the in-flight block (each kept with its '\n'). */
  blockBuf: string;
  /** Partial trailing line whose '\n' has not arrived yet. */
  lineBuf: string;
  /** Inside an unclosed ``` fence at the scan position. */
  fenceOpen: boolean;
  /** Total characters ever fed (informational). */
  consumed: number;
}

export function createStreamScanState(): StreamScanState {
  return { blocks: [], blockBuf: '', lineBuf: '', fenceOpen: false, consumed: 0 };
}

/**
 * Append newly arrived text (the DELTA, not the full transcript) into the
 * scan state.
 */
export function feedStreamDelta(state: StreamScanState, deltaText: string): void {
  if (!deltaText) return;

  state.consumed += deltaText.length;

  // Reassemble: partial line from before + new bytes, then split COMPLETE lines.
  let work = state.lineBuf + deltaText;
  state.lineBuf = '';

  let nl: number;
  while ((nl = work.indexOf('\n')) !== -1) {
    const line = work.slice(0, nl);
    work = work.slice(nl + 1);

    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (state.fenceOpen) {
        // Closing fence belongs to the block, then the block settles.
        state.fenceOpen = false;
        state.blockBuf += line + '\n';
        if (state.blockBuf.trim().length > 0) {
          state.blocks.push(state.blockBuf);
        }
        state.blockBuf = '';
        continue;
      }
      // Opening fence joins the current in-flight block.
      state.fenceOpen = true;
      state.blockBuf += line + '\n';
      continue;
    }

    if (!state.fenceOpen && trimmed === '') {
      // Blank line outside a fence settles the in-flight block.
      if (state.blockBuf.trim().length > 0) {
        state.blocks.push(state.blockBuf);
      }
      state.blockBuf = '';
      continue;
    }

    state.blockBuf += line + '\n';
  }

  // Whatever remains (no trailing '\n') is the new partial line.
  state.lineBuf = work;
}

/** Compose the current visual payload: settled blocks + in-flight remainder. */
export function getStreamParts(state: StreamScanState): { blocks: string[]; tail: string } {
  return { blocks: state.blocks.slice(), tail: state.blockBuf + state.lineBuf };
}
