// src/cli/repl/ui/InputBar.tsx
// Bottom input bar for ink mode — cc-typeahead unified suggestion engine.
// - typing shows a SuggestionBar DIRECTLY ABOVE the input (commands / providers
//   / models / history single source), no popup
// - Tab accepts the selected suggestion; ↑/↓ switch suggestions (or history
//   when no suggestions); Enter submits; Esc clears suggestions
// - ghost text previews the best suggestion remainder inline (gray)
// - Ctrl+Z / Ctrl+Y undo/redo via debounce-merged input buffer
// - P4-4.2: typing stays live during a run; Enter routes to queue/steer

import { PANSHA_COMMANDS } from '../SlashPicker.js';
import type { ProviderOption, SlashCommand } from '../SlashPicker.js';
import { generateSuggestions, ghostTextFor, getPreservedSelection, moveSelection, acceptSuggestion, doubleEscState } from '../typeahead.js';
import { SuggestionBar } from './SuggestionBar.js';
import { InputBuffer } from './useInputBuffer.js';

export function InputBar(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  running?: boolean;
  history?: string[];
  queueCount?: number;
  queueTasks?: number;
  queueSteers?: number;
  providerOptions?: () => Promise<{ providers: ProviderOption[] }>;
  /**
   * B5: single-owner Esc semantics. The InputBar owns Esc (close suggestions;
   * double-Esc within 300ms also clears the input + queue via this callback).
   * PanshaApp must NOT handle Esc anymore (it used to race this handler).
   */
  onDoubleEsc?: () => void;
}) {
  const R: any = (globalThis as any).__PANSHA_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
    useState: (i: any) => [i, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };

  const ink: any = (globalThis as any).__PANSHA_INK__ || {};
  const { Box, Text, useInput } = ink;

  const { value, onChange, onSubmit, running, history = [], queueCount = 0, queueTasks = 0, queueSteers = 0, providerOptions, onDoubleEsc } = props;

  const [historyIndex, setHistoryIndex] = (R.useState ? R.useState(-1) : [ -1, () => {} ]) as [number, (n: number) => void];
  const [selectedId, setSelectedId] = (R.useState ? R.useState(null) : [null, () => {}]) as [string | null, (s: string | null) => void];
  const [suggestionsDismissed, setSuggestionsDismissed] = (R.useState ? R.useState(false) : [false, () => {}]) as [boolean, (b: boolean) => void];
  const [providers, setProviders] = (R.useState ? R.useState([]) : [[], () => {}]) as [ProviderOption[], (p: ProviderOption[]) => void];
  const [buffer] = (R.useState ? R.useState(() => new InputBuffer(400)) : [new InputBuffer(400), () => {}]) as [InputBuffer, (b: InputBuffer) => void];

  // B5: double-Esc (300ms) timer — owned HERE (InputBar knows the suggestions
  // state; PanshaApp must not race it with a second Esc handler).
  const lastEscRef = R.useRef ? R.useRef(0) : { current: 0 };

  // load providers once (local read after startup prefetch — milliseconds)
  if (typeof providerOptions === 'function' && providers.length === 0) {
    providerOptions().then((r) => { if (r && Array.isArray(r.providers)) setProviders(r.providers); }).catch(() => {});
  }

  // ---- cc-typeahead: single-source suggestions（历史不直显——↑/↓ 翻页）----
  const v = value || '';
  const suggestions = suggestionsDismissed
    ? []
    : generateSuggestions(v, v.length, { commands: PANSHA_COMMANDS, providers, files: [] });
  const selectedIndex = getPreservedSelection(suggestions, selectedId);
  const selected = suggestions[selectedIndex] || null;
  const ghost = ghostTextFor(v, suggestions);

  const submitLine = (line: string) => {
    onSubmit(line);
    if (setHistoryIndex) setHistoryIndex(-1);
    if (setSelectedId) setSelectedId(null);
  };

  // fix-rich-input: render-synced latest-handler ref (ink re-subscribes after
  // commit; this removes all effect-timing dependence).
  const handleKey = (input: string, key: any) => {
    if (key.ctrl && (input === 'z' || input === 'Z')) {
      const restored = buffer.undo(v);
      if (restored !== null) onChange(restored);
      return;
    }
    if (key.ctrl && (input === 'y' || input === 'Y')) {
      const restored = buffer.redo(v);
      if (restored !== null) onChange(restored);
      return;
    }

    // T-29（回归·P1）: 双 Esc 计时与 suggestionsDismissed 解耦——任何 Esc 都更新
    // 计时，300ms 内第二次无条件触发清空（B5 的 else-if 分支在"建议条已关闭"
    // 场景下第二次 Esc 永远进不来，双 Esc 清空失效）。
    if (key.escape) {
      const { isDouble, nextLastEsc } = doubleEscState(Date.now(), lastEscRef.current);
      lastEscRef.current = nextLastEsc;
      setSuggestionsDismissed(true);
      if (isDouble) {
        if (onChange) onChange('');
        if (onDoubleEsc) onDoubleEsc();
      }
      return;
    }

    if (suggestions.length > 0) {
      // B5: plain Tab accepts the suggestion; shift+tab is NOT ours — it
      // cycles the mode ring in PanshaApp (was double-handled before).
      if (key.tab && !key.shift) {
        if (selected) {
          const repl = acceptSuggestion(v, selected);
          onChange(repl);
          buffer.push(v, repl);
          if (setSelectedId) setSelectedId(null);
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        // move by delta from the CURRENT selection; preserve id on next render
        const newIdx = moveSelection(selectedIndex, key.upArrow ? -1 : 1, suggestions.length);
        setSelectedId(suggestions[newIdx]?.id ?? null);
        return;
      }
      if (key.return) {
        if (selected) {
          if (selected.type === 'command') { submitLine(selected.displayText); return; }
          if (selected.type === 'provider') {
            onChange(selected.replacement); // '/model a6 ' → model suggestions
            if (setSelectedId) setSelectedId(null);
            return;
          }
          if (selected.type === 'model') {
            submitLine(selected.replacement); // '/model a6:openPangu-7B'
            return;
          }
          if (selected.type === 'file' || selected.type === 'directory') {
            submitLine(selected.replacement);
            return;
          }
        }
        // fall through to normal submit
      }
    }
    if (suggestionsDismissed && input && !key.ctrl && !key.meta) {
      setSuggestionsDismissed(false); // typing re-arms suggestions
    }

    if (key.return) {
      const trimmed = (value || '').trim();
      if (trimmed) {
        onSubmit(trimmed);
        buffer.push(value || '', trimmed);
        if (setHistoryIndex) setHistoryIndex(-1);
      }
      return;
    }

    if (key.upArrow) {
      if (history.length > 0) {
        const newIdx = Math.min(history.length - 1, (historyIndex < 0 ? history.length : historyIndex) - 1);
        if (newIdx >= 0) {
          onChange(history[newIdx] || '');
          if (setHistoryIndex) setHistoryIndex(newIdx);
        }
      }
      return;
    }

    if (key.downArrow) {
      if (history.length > 0) {
        const newIdx = historyIndex + 1;
        if (newIdx < history.length) {
          onChange(history[newIdx] || '');
          if (setHistoryIndex) setHistoryIndex(newIdx);
        } else {
          onChange('');
          if (setHistoryIndex) setHistoryIndex(-1);
        }
      }
      return;
    }

    if (key.backspace || key.delete) {
      onChange((value || '').slice(0, -1));
      if (setHistoryIndex) setHistoryIndex(-1);
      if (setSelectedId) setSelectedId(null);
      return;
    }

    if (key.ctrl && (input === 'j' || input === 'J')) {
      onChange((value || '') + '\n');
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const next = (value || '') + input;
      onChange(next);
      buffer.push(value || '', next);
      if (setHistoryIndex) setHistoryIndex(-1);
      if (setSelectedId) setSelectedId(null);
    }
  };

  const latestRef = R.useRef ? R.useRef(handleKey) : { current: handleKey };
  latestRef.current = handleKey;
  if (R.useEffect) {
    R.useEffect(() => { latestRef.current = handleKey; });
  }
  if (useInput) {
    useInput((input: string, key: any) => { latestRef.current(input, key); });
  }

  const display = (value || '').replace(/\n/g, '↵');
  const badge =
    queueCount > 0 && running
      ? ` queued ×${queueCount}` + (queueSteers > 0 ? `（steer ${queueSteers}）` : '')
      : '';

  const inputRow = R.createElement(
    Box,
    { borderStyle: 'single', paddingX: 1 },
    R.createElement(Text, { color: running ? 'gray' : 'cyan' }, running ? 'running ' : '▸ '),
    R.createElement(Text, {}, display || ''),
    ghost ? R.createElement(Text, { color: 'gray' }, ghost) : null,
    badge ? R.createElement(Text, { color: 'magenta' }, badge) : null
  );

  if (Box && Text) {
    const children: any[] = [];
    children.push(R.createElement(SuggestionBar, { suggestions, selectedIndex }));
    children.push(inputRow);
    return R.createElement(Box, { flexDirection: 'column' }, ...children);
  }

  return (running ? 'running ' : '▸ ') + display + (ghost ? ' ' + ghost : '') + badge;
}
