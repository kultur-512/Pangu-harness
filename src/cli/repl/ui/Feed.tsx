// src/cli/repl/ui/Feed.tsx
// Scrolling feed area with UX polish:
// - Empty state with clear affordance ("Ready. Type a command or task...")
// - Windowed recent items only (no layout bloat)
// - Consecutive duplicate phase lines are collapsed (P0.4 noise reduction)
// - `transcript` prop (P0.1): when true, thoughts render full text (ctrl+o)
// - M1-2.0.2: static ESM import for FeedItem (ui/ tree is ink-gated by startInkUI)

import type { FeedItem } from '../types.js';
import { FeedItem as FeedItemComponent } from './FeedItem.js';

const FEED_WINDOW = 80;

export function Feed(props: { items: FeedItem[]; height?: number; transcript?: boolean }) {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__ZORGE_INK__ || {};
  const { Box, Text } = ink;

  const { items = [], transcript, height } = props;

  // Collapse consecutive identical phase markers before windowing
  const collapsed: FeedItem[] = [];
  for (const it of items) {
    const prev = collapsed[collapsed.length - 1];
    if (
      prev && (prev as any).type === 'phase' && (it as any).type === 'phase' &&
      (prev as any).phase === (it as any).phase
    ) {
      continue;
    }
    collapsed.push(it);
  }

  // fix-ui-direction (②): window adapts to the provided terminal-derived
  // height (falls back to the fixed 80 when not provided).
  const windowSize = height && height > 0 ? height : FEED_WINDOW;
  const windowed = collapsed.slice(-windowSize);

  const FeedItemComp: any = FeedItemComponent;

  const children = windowed.length > 0
    ? windowed.map((it, idx) => {
        const key = (it as any).id || idx;
        return R.createElement(FeedItemComp, { key, item: it, transcript });
      })
    : [
        R.createElement(
          Text,
          { dimColor: true, key: 'empty' },
          'Ready. Enter a command (/help) or describe a task to run.'
        )
      ];

  if (Box) {
    return R.createElement(
      Box,
      { flexGrow: 1, flexDirection: 'column', overflow: 'hidden', paddingX: 1 },
      ...children
    );
  }
  return windowed.length > 0
    ? windowed.map((it: any) => renderPlain(it)).join('\n')
    : 'Ready. Enter a command (/help) or describe a task.';
}

function renderPlain(it: any): string {
  if (it.type === 'text') return it.text;
  if (it.type === 'step') return `[Step ${it.stepNumber}] ${it.thinking || it.plan || ''}`;
  if (it.type === 'critique') return `Critique: ${it.critique}`;
  if (it.type === 'phase') return `── ${it.phase} ──`;
  if (it.type === 'tool') return `⚙ ${it.tool} ${it.target || ''} [${it.status}]`;
  if (it.type === 'thought') return `💭 ${it.short || ''}`;
  if (it.type === 'budget') return `[budget ${(it.usedRatio * 100).toFixed(0)}%]`;
  if (it.type === 'markdown') return it.content;
  return JSON.stringify(it);
}
