// src/cli/repl/ui/streamingAssistant.tsx
// P1.4: live in-flight zone between Feed and InputBar.
//
// - 💭 live thinking tail (dim, bounded, plain text — cheapest per delta)
// - streaming assistant message rendered INCREMENTALLY via the frozen-blocks
//   scanner (streamingMarkdown.ts): settled top-level blocks go through
//   MarkdownBlock exactly once (stable content → memo-friendly), only the
//   live tail renders as bounded plain text + blinking cursor
// - disappears when the turn settles (bridge resets stream state)
// - M1-2.0.2: static ESM imports (ui/ tree is ink-gated by startInkUI)

import { createStreamScanState, feedStreamDelta, getStreamParts, StreamScanState } from './streamingMarkdown.js';
import { MarkdownBlock } from './Markdown.js';
// Perf contract: per-delta cost is O(new chars) for scanning + O(tail) for
// rendering. Settled blocks are never re-parsed.

const BOUND_CHARS = 4000;

function boundTail(text: string): string {
  if (!text) return '';
  const t = text.replace(/\n{3,}/g, '\n\n');
  return t.length > BOUND_CHARS ? '…' + t.slice(-BOUND_CHARS) : t;
}

export function StreamingAssistant(props: {
  thinking: string;
  message: string;
  visible: boolean;
}) {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
    useRef: (_i: any) => ({ current: _i }),
  };
  const ink: any = (globalThis as any).__ZORGE_INK__ || {};
  const { Box, Text } = ink;

  const { thinking, message, visible } = props;

  // --- Incremental scan of the message stream (delta-append API) ---
  const ref = R.useRef ? R.useRef(null) : { current: null };

  // Reset detection: a new message segment arrives when the accumulated length
  // shrinks (bridge cleared the buffer) or we've never scanned.
  let scan: { state: StreamScanState; lastLen: number } | null = ref.current;
  if (!scan || message.length < scan.lastLen) {
    scan = ref.current = { state: createStreamScanState(), lastLen: 0 };
  }
  if (message.length > scan.lastLen) {
    feedStreamDelta(scan.state, message.slice(scan.lastLen));
    scan.lastLen = message.length;
  }
  const parts = getStreamParts(scan.state);

  const hasThinking = !!thinking && visible;
  const hasMessage = !!(parts.blocks.length || parts.tail) && visible;
  if (!hasThinking && !hasMessage) return null;

  const children: any[] = [];

  if (hasThinking) {
    children.push(
      R.createElement(Text, { key: 'th', color: 'magenta', dimColor: true }, `💭 ${boundTail(thinking)}`)
    );
  }

  if (hasMessage && Box) {
    const MB: any = MarkdownBlock;
    const msgChildren: any[] = [];

    // Settled blocks — parsed once each (content strings are immutable here)
    parts.blocks.forEach((b, i) => {
      msgChildren.push(
        MB
          ? R.createElement(MB, { key: 'b' + i, content: b })
          : R.createElement(Text, { key: 'b' + i }, b)
      );
    });

    // Live tail — plain bounded text + cursor (no re-parse per delta)
    if (parts.tail) {
      msgChildren.push(R.createElement(Text, { key: 'tail' }, boundTail(parts.tail.replace(/\n$/, ''))));
    }
    msgChildren.push(R.createElement(Text, { key: 'cur', color: 'cyan' }, '▍'));

    children.push(R.createElement(Box, { key: 'msg', flexDirection: 'column' }, ...msgChildren));
  } else if (hasMessage) {
    // Non-ink fallback: plain joined text
    children.push(R.createElement(Text, { key: 'msgplain' }, boundTail(message)));
  }

  if (Box) {
    return R.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      ...children
    );
  }
  return '';
}
