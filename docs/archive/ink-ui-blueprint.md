# Zorge Ink UI Integration Blueprint (Path B)

**Decision**: Introduce `ink@5 + react@18` via `optionalDependencies` for a real Claude Code-style bottom bar + rich feed.
**Discipline preservation**: Runtime downgrade to existing line-mode REPL is mandatory and must be silent and complete.

## 1. Dependency Stance (Approved)

- `ink` and `react` go into `optionalDependencies` (same tier as chalk/ora/prompts).
- `npm install` failure (sandbox, EPERM, etc.) must not block installation or build.
- At runtime:
  - Try `import('ink')` + `import('react')`.
  - Only enable ink mode if:
    - import succeeded
    - `process.stdout.isTTY && process.stdin.isTTY`
    - `TerminalCapabilities.multiline` (or equivalent TTY richness)
  - Otherwise: **completely silent fallback** to current line-mode REPL. No warnings about "ink not available".

Cost: ~10-12 extra packages, +2-4MB installed size. Acceptable for the UX gain.

## 2. Architecture Principles

- Core engine (ZorgeChaser, VerifyCritiqueLoop, etc.) **must never import or know about ink**.
- All UI state lives in one place (`UiState`).
- Events from engine (`onStep`, command results, softLimit, etc.) are translated by a thin **bridge** into UI actions.
- Input in ink mode is owned by `InputBar` (ink-text-input). The old `InputReader`/`readline` is not created in ink mode.
- OutputRenderer in ink mode becomes a thin adapter that calls `bridge.pushFeed(...)`.
- When ink mode is active, the classic line loop in `Repl.start()` is **not entered**.

## 3. Key Contracts

### FeedItem (what appears in the scroll area)

```ts
export type FeedItem =
  | { id: string; type: 'text';      text: string; level?: 'info'|'warn'|'error'|'success' }
  | { id: string; type: 'phase';     phase: 'explore'|'rollout'|'judge'|'done' }
  | { id: string; type: 'step';      stepNumber: number; thinking?: string; plan?: string; toolCalls?: any[] }
  | { id: string; type: 'critique';  stepNumber: number; critique: string }
  | { id: string; type: 'tool';      tool: string; target?: string; argsSummary?: string; result?: string; status: 'running'|'ok'|'fail' }
  | { id: string; type: 'thought';   short: string; full?: string }   // 💭 collapsed thinking
  | { id: string; type: 'markdown';  content: string }                // future richer blocks
  | { id: string; type: 'budget';    usedRatio: number };
```

### UiState (single source of truth)

```ts
export interface UiState {
  top: {
    tier: string;
    model: string;
    workspace: string;
    budgetRatio: number;   // 0..1
  };
  feed: FeedItem[];
  input: {
    value: string;
    history: string[];
    completions: string[];
    multiline: boolean;
  };
  confirm?: {
    message: string;
    onResolve: (yes: boolean) => void;
  };
  running: boolean;
}
```

### Bridge (one-way from engine → UI, plus input actions)

```ts
export interface UiBridge {
  pushFeed(item: Omit<FeedItem, 'id'>): void;
  setTop(partial: Partial<UiState['top']>): void;
  setRunning(running: boolean): void;
  setConfirm(confirm: UiState['confirm'] | undefined): void;

  // Called by InputBar
  submitInput(text: string): void;
  updateInput(value: string): void;
}
```

The bridge is implemented with a small event emitter or direct dispatch into a React reducer inside `ZorgeApp`.

## 4. File Layout (src/cli/repl/ui/)

```
ui/
  startInkUI.ts          // detection + render or return null
  bridge.ts              // UiBridge implementation + event wiring
  ZorgeApp.tsx           // root (useReducer for UiState)
  TopBar.tsx
  Feed.tsx
  FeedItem.tsx
  ToolCard.tsx
  ThoughtBlock.tsx
  InputBar.tsx           // uses ink-text-input or raw useInput + state
  ConfirmBar.tsx
  Markdown.tsx           // lightweight (headers, ``` blocks, bold) using chalk colors
  types.ts               // local UI-only types (re-exported from ../types if needed)
```

All React components must use `React.createElement` (no JSX transform assumed for this phase, or we set "jsx": "react-jsx" only for .tsx under ui/ if we want to be pragmatic).

## 5. Integration Points

### Repl.ts
- In `start()` (or a new `startInteractive()`), first call:
  ```ts
  const inkStarted = await tryStartInkUI(this.session, this.renderer, this);
  if (inkStarted) return;   // ink owns the event loop
  ```
- If ink returns false/null, fall through to existing `while (this.running)` line loop.
- `executeTask` and `onStep` callbacks must be able to push to the bridge when ink is active (via a property on Repl or a shared bridge instance).

### OutputRenderer
- Add an internal "delegate" mode:
  ```ts
  setFeedSink(sink: (item: any) => void): void;
  ```
- When ink mode is active, `writeLine`, `info`, `warn`, `success`, `error`, `stream` etc. are routed through the sink (as 'text' items) instead of (or in addition to) stdout.
- Classic behavior is preserved when no sink is attached.

### InputReader
- In ink mode we should **not** create the readline interface at all (it fights with ink's raw mode).
- `Repl` should decide at the very beginning:
  - If ink will be used → do not instantiate classic InputReader.
  - Else → create classic one.
- This keeps the two paths cleanly separated.

### types.ts
- Add the `FeedItem`, `UiState`, `UiBridge`, `StepCallback` (already exists) exports.
- Keep them additive only.

## 6. Phased Delivery (U1–U6)

**U1 – Foundation & Downgrade**
- Add ink + react to optionalDependencies.
- Implement `startInkUI.ts`:
  - Dynamic import of ink + react.
  - TTY + capability check.
  - If any check fails → return false (line mode continues).
- Empty `ZorgeApp` that renders TopBar + Feed + InputBar placeholders.
- Gate: `npm run build`, smoke test (non-TTY) still fully green.

**U2 – TopBar + InputBar (bottom bar works)**
- TopBar shows tier (colored), model, workspace, simple budget bar.
- InputBar accepts input, supports basic history, Enter submits.
- Wire submit → existing command/task execution path.
- `/help`, `/tier`, `/model`, direct task input all work from bottom bar.

**U3 – Feed + onStep streaming**
- Bridge receives `onStep` events from Repl/RunCommand/ZorgeChaser.
- Feed renders step lines, critique, phase banners.
- Auto-scroll to bottom.
- Ctrl+C during task must abort and return control to InputBar.

**U4 – ToolCard + ThoughtBlock + ConfirmBar**
- Tool calls render as cards with icon + summary + status.
- Results fold/unfold.
- `💭` thinking lines are collapsed.
- Write operations trigger `ConfirmBar` (y/N) before execution (for high tiers).

**U5 – Markdown + Budget live update**
- `Markdown.tsx`: very small parser for `#`, ```` `, **bold**.
- `softLimit` / `degradation` events update the top budget bar live.

**U6 – Polish + Full Regression**
- Resize handling.
- History navigation in InputBar (↑/↓).
- All 16 commands work in both modes.
- Smoke + verify + tsc all green.
- Document "how to force line mode" (env var or non-TTY).

Every phase must keep the line-mode smoke path 100% green.

## 7. Risks & Mitigations

- ink install fails in some sandboxes → optionalDep + runtime try/catch → line mode.
- High-frequency feed updates cause lag → batch updates (16ms) + windowed rendering (only last N visible items).
- Input/Output fighting for stdin/stdout → ink mode never creates readline; classic mode never tries to render ink components.
- Confirm flow complexity → ConfirmBar is a simple modal overlay; while shown, normal input is suspended.
- Breaking existing OutputRenderer contract → we only add a sink path; existing methods keep their stdout behavior when no sink.

## 8. Immediate Next Code Steps (after this blueprint)

1. Create `src/cli/repl/ui/` directory.
2. Add UI types to `src/cli/repl/types.ts`.
3. Implement `bridge.ts` (simple in-memory dispatcher + UiState reducer logic).
4. Implement `startInkUI.ts` with detection + fallback.
5. Create minimal `ZorgeApp.tsx`, `TopBar.tsx`, `Feed.tsx`, `InputBar.tsx` using `React.createElement`.
6. Wire Repl.ts to attempt ink first.
7. Make OutputRenderer support a feed sink.
8. Run gates.

This keeps the "any environment must still work" invariant while delivering a dramatically better interactive experience when the environment supports it.
