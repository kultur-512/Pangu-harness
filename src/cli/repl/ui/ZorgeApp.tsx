// src/cli/repl/ui/ZorgeApp.tsx
// Root layout for ink mode (Path B) - polished per UX guidelines.
// Three zones: TopBar (fixed), Feed (flexGrow, scroll window), Input/Confirm (docked bottom).
// Respects: high contrast, clear states (running/confirm), keyboard primary, no layout shift on updates.
//
// M1-2.0.2: static ESM imports for sub-components (this ui/ tree is only
// dynamically loaded by startInkUI when ink is available, so top-level
// imports here cannot pollute the non-TTY downgrade path).

import { TopBar } from './TopBar.js';
import { Feed } from './Feed.js';
import { InputBar } from './InputBar.js';
import { ConfirmBar } from './ConfirmBar.js';
import { StreamingAssistant } from './streamingAssistant.js';

export function ZorgeApp(props: {
  bridge: any;
  initialSession?: { tier?: string; model?: string; workspace?: string };
}) {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
    useReducer: (reducer: any, initial: any) => [initial, () => {}],
    useEffect: (_fn: any, _deps?: any) => {},
    useState: (i: any) => [i, () => {}],
  };

  const ink: any = (globalThis as any).__ZORGE_INK__ || {};

  const { createElement, useReducer, useEffect, useState } = R;

  const { bridge, initialSession } = props;

  // fix-ui-direction (②): adaptive feed height — fill the terminal between the
  // fixed TopBar and the docked InputBar; re-measure on terminal resize.
  const [feedHeight, setFeedHeight] = (useState ? useState(20) : [20, () => {}]) as [number, (n: number) => void];
  useEffect(() => {
    const measure = () => {
      try {
        const rows = (process.stdout as any).rows ?? 24;
        // TopBar (1) + InputBar (2) + ConfirmBar margin + safety margin
        setFeedHeight(Math.max(4, rows - 5));
      } catch {}
    };
    measure();
    if (typeof process !== 'undefined' && process.stdout && typeof (process.stdout as any).on === 'function') {
      (process.stdout as any).on('resize', measure);
      return () => { try { (process.stdout as any).off('resize', measure); } catch {} };
    }
    return undefined;
  }, []);

  // P0.1: transcript mode (ctrl+o) — expands every thought to its full text,
  // Claude Code style ("in the conversation and in the transcript view").
  const [transcriptMode, setTranscriptMode] = R.useState
    ? R.useState(false)
    : [false, (_v: any) => {}];

  // P4-4.7: mode ring plumbing — shift+tab cycles; badge flows via setTop.
  const [modeBadge, setModeBadge] = R.useState ? R.useState('') : ['', (_v: any) => {}];

  // Global key handling (hooks must be unconditional in render).
  // B5: Esc is NOT handled here anymore — the InputBar owns it (single-owner
  // double-Esc semantics). This hook handles ctrl+o / shift+tab / ctrl+t only.
  if (typeof ink.useInput === 'function') {
    ink.useInput((input: string, key: any) => {
      // ctrl+o (P0.1): transcript mode toggle
      if (key && key.ctrl && (input === 'o' || input === 'O')) {
        setTranscriptMode((v: boolean) => !v);
        return;
      }
      // shift+tab (P4-4.7): cycle plan → default → auto-accept → full
      if (key && key.tab && key.shift) {
        if (bridge && typeof bridge.cycleMode === 'function') {
          const m = bridge.cycleMode();
          setModeBadge(m === 'plan' ? 'PLAN' : m === 'auto-accept' ? 'AUTO' : m === 'full' ? 'FULL' : '');
        }
        return;
      }
      // ctrl+t (P4-4.8): light status panel (queue + steers + checkpoints)
      if (key && key.ctrl && (input === 't' || input === 'T')) {
        if (bridge && typeof bridge.requestStatusPanel === 'function') {
          try { bridge.requestStatusPanel(); } catch {}
        }
        return;
      }
    });
  }

  const initialState = {
    top: {
      tier: initialSession?.tier || 'high',
      model: initialSession?.model || 'default',
      workspace: initialSession?.workspace || (typeof process !== 'undefined' ? process.cwd() : ''),
      budgetRatio: 0,
      ctxRatio: 0,
    },
    feed: [] as any[],
    input: { value: '', history: [] as string[], multiline: false },
    confirm: undefined as any,
    running: false,
    phase: '' as string,
    streamThinking: '',
    streamMessage: '',
    queue: { total: 0, tasks: 0, steers: 0 },
  };

  function reducer(state: any, action: any) {
    switch (action.type) {
      case 'PUSH_FEED':
        return { ...state, feed: [...state.feed, action.item] };
      case 'SET_TOP':
        return { ...state, top: { ...state.top, ...action.partial } };
      case 'SET_RUNNING':
        return { ...state, running: action.running };
      case 'SET_CONFIRM':
        return { ...state, confirm: action.confirm };
      case 'UPDATE_INPUT':
        return { ...state, input: { ...state.input, value: action.value } };
      case 'SET_PHASE':
        return { ...state, phase: action.phase || '' };
      case 'SET_HISTORY':
        return { ...state, input: { ...state.input, history: action.history || [] } };
      case 'APPEND_STREAM':
        if (action.kind === 'thinking') {
          return { ...state, streamThinking: state.streamThinking + action.text };
        }
        return { ...state, streamMessage: state.streamMessage + action.text };
      case 'RESET_STREAM':
        if (action.kind === 'thinking') {
          return { ...state, streamThinking: '' };
        }
        if (action.kind === 'message') {
          return { ...state, streamMessage: '' };
        }
        return { ...state, streamThinking: '', streamMessage: '' };
      // M2.0: real approval confirm state (serializable request only; the
      // resolver lives in bridge.currentConfirm)
      case 'SET_CONFIRM_STATE':
        return { ...state, confirm: action.confirm };
      // P4-4.2: queued-messages badge
      case 'SET_QUEUE_COUNT':
        return { ...state, queue: { total: action.total || 0, tasks: action.tasks || 0, steers: action.steers || 0 } };
      default:
        return state;
    }
  }

  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (bridge && typeof bridge.__registerDispatch === 'function') {
      bridge.__registerDispatch(dispatch);
    }
    return () => {
      if (bridge && typeof bridge.__unregisterDispatch === 'function') {
        bridge.__unregisterDispatch();
      }
    };
  }, [bridge]);

  // Submit from InputBar
  const handleSubmit = (text: string) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    const newHistory = [...(state.input.history || []), trimmed].slice(-50);
    dispatch({ type: 'UPDATE_INPUT', value: '' });
    dispatch({ type: 'SET_HISTORY', history: newHistory });
    if (bridge && typeof bridge.submitInput === 'function') {
      bridge.submitInput(trimmed);
    }
  };

  const handleChange = (v: string) => {
    dispatch({ type: 'UPDATE_INPUT', value: v });
    if (bridge && typeof bridge.updateInput === 'function') {
      bridge.updateInput(v);
    }
  };

  // Compose sub-components (static ESM imports per M1-2.0.2)
  const TopBarComp: any = TopBar;
  const FeedComp: any = Feed;
  const InputBarComp: any = InputBar;
  const ConfirmBarComp: any = ConfirmBar;
  const StreamingAssistantComp: any = StreamingAssistant;

  const topNode = createElement(TopBarComp, {
    tier: state.top.tier,
    model: state.top.model,
    workspace: state.top.workspace,
    budgetRatio: state.top.budgetRatio,
    ctxRatio: state.top.ctxRatio,
    phase: state.phase,
    running: state.running,
    modeBadge,
  });

  const feedNode = createElement(FeedComp, { items: state.feed, transcript: transcriptMode, height: feedHeight });

  // P1.4: live streaming zone (visible only while a turn is running and has content)
  const streamNode = StreamingAssistantComp
    ? createElement(StreamingAssistantComp, {
        thinking: state.streamThinking,
        message: state.streamMessage,
        visible: !!state.running,
      })
    : null;

  // M2.0: real approval ConfirmBar — state.confirm is the serializable request;
  // decisions flow through bridge.resolveConfirm which resolves the engine's
  // awaiting promise. InputBar is hidden while a decision is pending.
  const inputNode = state.confirm
    ? createElement(ConfirmBarComp, {
        request: state.confirm,
        onDecision: (decision: 'y' | 'n' | 'a') => {
          if (bridge && typeof bridge.resolveConfirm === 'function') {
            bridge.resolveConfirm(decision);
          } else {
            dispatch({ type: 'SET_CONFIRM_STATE', confirm: undefined });
          }
        },
      })
    : createElement(InputBarComp, {
        value: state.input.value,
        onChange: handleChange,
        onSubmit: handleSubmit,
        running: state.running,
        history: state.input.history,
        queueCount: state.queue.total,
        queueTasks: state.queue.tasks,
        queueSteers: state.queue.steers,
        providerOptions: bridge && typeof bridge.providerOptions === 'function' ? bridge.providerOptions : undefined,
        // B5: double-Esc (clear input + wipe queue) is owned by the InputBar;
        // it reports here so the app can also clear its own input state.
        onDoubleEsc: () => {
          dispatch({ type: 'UPDATE_INPUT', value: '' });
          if (bridge && typeof bridge.clearQueue === 'function') {
            try { bridge.clearQueue(); } catch {}
          }
          if (bridge && typeof bridge.pushFeed === 'function') {
            bridge.pushFeed({ type: 'text', text: '（双 Esc：输入与队列已清空）', level: 'info' });
          }
        },
      });

  // Root: column, full height. Feed grows, input/confirm docks at bottom.
  // This prevents layout shift when feed grows and keeps bottom bar "always visible".
  return createElement(
    ink.Box || 'div',
    { flexDirection: 'column', height: '100%', overflow: 'hidden' },
    topNode,
    feedNode,
    streamNode,
    inputNode
  );
}
