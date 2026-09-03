// src/cli/repl/ui/FuzzyPicker.tsx
// Generic resident fuzzy picker — port of CC design-system/FuzzyPicker
// architecture onto the `__ZORGE_INK__` runtime (same mechanism as InputBar:
// no import transformation; React.createElement only).
//
// - title + SearchBox + list + Byline (↑/↓ navigate, Enter select, Tab action,
//   Esc cancel)
// - direction='up' (atuin style): items[0] sits right above the input — the
//   resident feel.
// - windowStart = clamp(focusedIndex - visibleCount + 1, 0, total-visibleCount):
//   the focused item scrolls the window instead of overflowing/flickering.
// - The CALLER owns filtering: onQueryChange(query) re-filters and passes new
//   items back. onFocus(item) is for async previews (I/O out of render).
// - visibleCount adapts to terminal height (rows - CHROME_ROWS).
// - Keys: ↑/↓ or ctrl+p/n, Enter, Tab (independent action), Esc cancel.

import {
  pickerClamp,
  pickerWindowStart,
  pickerRenderOrder,
  pickerStep,
} from '../SlashPicker.js';

const DEFAULT_VISIBLE = 8;
const CHROME_ROWS = 10; // pane + title + gaps + searchbox + byline
const MIN_VISIBLE = 2;

export function FuzzyPicker(props: {
  title: string;
  placeholder?: string;
  items: any[];
  getKey: (item: any) => string;
  renderItem: (item: any, isFocused: boolean) => any;
  direction?: 'up' | 'down';
  visibleCount?: number;
  onQueryChange: (query: string) => void;
  onSelect: (item: any) => void;
  onTab?: { action: string; handler: (item: any) => void };
  onFocus?: (item: any | undefined) => void;
  onCancel: () => void;
  emptyMessage?: string | ((query: string) => string);
  matchLabel?: string;
  selectAction?: string;
  // slash-mid: controlled mode — the host (InputBar) owns keys + focus to
  // avoid ink useInput multiplexing conflicts; the picker is pure presentation.
  controlledFocusedIndex?: number;
  disableKeys?: boolean;
  queryText?: string;
}) {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
    useState: (i: any) => [i, () => {}],
    useEffect: () => {},
    useMemo: (f: any) => f(),
  };
  const ink: any = (globalThis as any).__ZORGE_INK__ || {};
  const { Box, Text, useInput } = ink;

  const {
    title,
    placeholder = 'Type to search…',
    items,
    getKey,
    renderItem,
    direction = 'up',
    visibleCount: requestedVisible = DEFAULT_VISIBLE,
    onQueryChange,
    onSelect,
    onTab,
    onFocus,
    onCancel,
    emptyMessage = 'No results',
    matchLabel,
    selectAction = 'select',
    controlledFocusedIndex,
    disableKeys,
    queryText,
  } = props;

  const [focusedIndex, setFocusedIndex] = (R.useState ? R.useState(0) : [0, () => {}]) as [number, (n: number) => void];
  const [query, setQuery] = (R.useState ? R.useState('') : ['', () => {}]) as [string, (s: string) => void];
  const activeIndex = controlledFocusedIndex !== undefined ? controlledFocusedIndex : focusedIndex;
  const displayQuery = queryText !== undefined ? queryText : query;

  // Cap visibleCount so the picker never exceeds terminal height.
  const rows = (typeof process !== 'undefined' && process.stdout && (process.stdout as any).rows) || 24;
  const visibleCount = Math.max(MIN_VISIBLE, Math.min(requestedVisible, rows - CHROME_ROWS - (matchLabel ? 1 : 0)));

  const handleKey = (input: string, key: any) => {
    if (key.ctrl && (input === 'p' || input === 'P')) {
      setFocusedIndex(pickerStep(focusedIndex, direction === 'up' ? 1 : -1, items.length));
      return;
    }
    if (key.ctrl && (input === 'n' || input === 'N')) {
      setFocusedIndex(pickerStep(focusedIndex, direction === 'up' ? -1 : 1, items.length));
      return;
    }
    if (key.upArrow) {
      setFocusedIndex(pickerStep(focusedIndex, direction === 'up' ? 1 : -1, items.length));
      return;
    }
    if (key.downArrow) {
      setFocusedIndex(pickerStep(focusedIndex, direction === 'up' ? -1 : 1, items.length));
      return;
    }
    if (key.return) {
      const selected = items[focusedIndex];
      if (selected) onSelect(selected);
      return;
    }
    if (key.tab) {
      const selected = items[focusedIndex];
      if (!selected) return;
      if (onTab && onTab.handler) onTab.handler(selected);
      else if (selected) onSelect(selected);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    // text input → update query → caller re-filters
    if (input && !key.ctrl && !key.meta) {
      const next = query + input;
      setQuery(next);
      onQueryChange(next);
      setFocusedIndex(0);
    }
    if (key.backspace || key.delete) {
      const next = query.slice(0, -1);
      setQuery(next);
      onQueryChange(next);
      setFocusedIndex(0);
    }
  };

  if (typeof ink.useInput === 'function' && !disableKeys) {
    useInput(handleKey);
  }

  const windowStart = pickerWindowStart(activeIndex, visibleCount, items.length, direction);
  const { ordered, focusedVisibleIndex, focusedVisible } = pickerRenderOrder(
    items, activeIndex, windowStart, visibleCount, direction
  );

  const focused = items[activeIndex];
  if (typeof onFocus === 'function' && focused) {
    // caller hook for async preview — fire-and-forget, I/O stays out of render
    try { onFocus(focused); } catch {}
  }

  const listRows = ordered.map((item) =>
    R.createElement(
      Box,
      Object.assign({ width: '100%', wrap: 'truncate-end' }, getKey ? { key: getKey(item) } : null),
      renderItem(item, focusedVisible && ordered.indexOf(item) === focusedVisibleIndex)
    )
  );

  const byline = R.createElement(
    Text,
    { color: 'gray' },
    '↑/↓ navigate · Enter ' + selectAction + (onTab ? ' · Tab ' + onTab.action : '') + ' · Esc cancel'
  );

  const body = R.createElement(
    Box,
    { flexDirection: 'column', flexGrow: 1, width: '100%' },
    R.createElement(Text, { bold: true, color: 'cyan' }, title),
    R.createElement(Text, { color: 'gray', wrap: 'truncate-end' }, placeholder + ' [' + displayQuery + ']'),
    ordered.length > 0
      ? R.createElement(Box, { flexDirection: 'column', flexGrow: 1, width: '100%' }, ...listRows)
      : R.createElement(Text, { color: 'gray' }, typeof emptyMessage === 'function' ? emptyMessage(displayQuery) : emptyMessage),
    matchLabel ? R.createElement(Text, { color: 'gray' }, matchLabel) : null,
    byline
  );

  return body;
}
