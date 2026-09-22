// src/cli/repl/ui/SuggestionBar.tsx
// cc-typeahead (B): in-line suggestion bar rendered DIRECTLY ABOVE the input
// (not a popup), fixed 1-2 rows, type-colored, selected item highlighted.
// Zero layout when there are no suggestions.

import type { SuggestionItem } from '../typeahead.js';
import { visibleWindowStart } from '../typeahead.js';

const TYPE_COLOR: Record<string, string> = {
  command: 'cyan',
  provider: 'magenta',
  model: 'blue',
  file: 'green',
  directory: 'green',
  path: 'green',
};

const MAX_VISIBLE = 10;

export function SuggestionBar(props: {
  suggestions: SuggestionItem[];
  selectedIndex: number;
}) {
  const R: any = (globalThis as any).__PANSHA_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__PANSHA_INK__ || {};
  const { Box, Text } = ink;

  const { suggestions, selectedIndex } = props;
  if (!suggestions || suggestions.length === 0) return null;

  // 滚动窗口跟随光标（真机缺陷修复：此前固定 slice(0, MAX_VISIBLE)，↓ 移动
  // 选中项出窗后高亮消失、菜单不滚）。
  const start = visibleWindowStart(selectedIndex, suggestions.length, MAX_VISIBLE);
  const visible = suggestions.slice(start, start + MAX_VISIBLE);
  const rows = visible.map((s, i) => {
    const sel = start + i === selectedIndex;
    const color = TYPE_COLOR[s.type] || 'white';
    const marker = sel ? '▸ ' : '  ';
    const desc = s.description ? '  ' + s.description : '';
    return R.createElement(
      Text,
      sel ? { color, inverse: true, key: s.id } : { color, key: s.id },
      marker + s.displayText + desc
    );
  });

  return R.createElement(Box, { flexDirection: 'column', paddingX: 1 }, ...rows);
}
