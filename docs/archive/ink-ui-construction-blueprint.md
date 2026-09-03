# Zorge Ink UI — Detailed Construction Blueprint (Path B, Bottom Bar First)

**Status**: Approved direction.  
**Core invariant**: Zero-dependency line-mode REPL must remain 100% functional. Ink is strictly optional and runtime-detected.

---

## 1. Dependency Decision (Confirmed)

```json
"optionalDependencies": {
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2",
  "ink": "^5.0.0",
  "react": "^18.3.0"
}
```

**Rules**:
- `npm install` may skip ink/react → no error.
- At runtime in `startInkUI.ts`:
  ```ts
  let ink: any, React: any;
  try {
    ink = (await import('ink')).default ?? (await import('ink'));
    React = (await import('react')).default ?? (await import('react'));
  } catch { return null; } // silent fallback
  ```
- Only enter ink mode when:
  - imports succeeded
  - `process.stdout.isTTY && process.stdin.isTTY`
  - `getTerminalCapabilities().multiline` (or equivalent)
- Otherwise: **completely silent** return to existing line-mode code path. No "ink not available" messages.

---

## 2. Architecture (Strict Separation)

**Golden Rule**: `ZorgeChaser`, `VerifyCritiqueLoop`, `RunCommand`, etc. must **never** import anything from `ui/`.

Data flow:
```
Engine (onStep, result, budget events)
        ↓ (via bridge only)
UiBridge.pushFeed(...) / setTop(...) / setConfirm(...)
        ↓
ZorgeApp (useReducer<UiState>)
        ↓
TopBar + Feed + InputBar + ConfirmBar
```

Input in ink mode is owned by `InputBar` → `bridge.submitInput()` → existing command/task execution.

---

## 3. Core Contracts (Additive Only)

Add to `src/cli/repl/types.ts`:

```ts
export type FeedItem =
  | { id: string; type: 'text'; text: string; level?: 'info'|'warn'|'error'|'success' }
  | { id: string; type: 'phase'; phase: string }
  | { id: string; type: 'step'; stepNumber: number; thinking?: string; plan?: string; toolCalls?: any[] }
  | { id: string; type: 'critique'; stepNumber: number; critique: string }
  | { id: string; type: 'tool'; tool: string; target?: string; argsSummary?: string; result?: string; status: 'running'|'ok'|'fail' }
  | { id: string; type: 'thought'; short: string; full?: string }
  | { id: string; type: 'budget'; usedRatio: number };

export interface UiState {
  top: { tier: string; model: string; workspace: string; budgetRatio: number };
  feed: FeedItem[];
  input: { value: string; history: string[]; multiline: boolean };
  confirm?: { message: string; onResolve: (yes: boolean) => void };
  running: boolean;
}

export interface UiBridge {
  pushFeed(item: Omit<FeedItem, 'id'>): void;
  setTop(p: Partial<UiState['top']>): void;
  setRunning(r: boolean): void;
  setConfirm(c?: UiState['confirm']): void;
  submitInput(text: string): void;
  updateInput(v: string): void;
}
```

---

## 4. File Plan (src/cli/repl/ui/)

```
ui/
  startInkUI.ts          // detection + render or null
  bridge.ts              // creates UiBridge + wires to Repl
  ZorgeApp.tsx
  TopBar.tsx
  Feed.tsx
  FeedItem.tsx
  ToolCard.tsx
  ThoughtBlock.tsx
  InputBar.tsx
  ConfirmBar.tsx
  Markdown.tsx           // this phase: headers + ``` + **bold**
  types.ts               // re-exports + small UI-only types
```

All components use `React.createElement` (or enable jsx for ui/ subtree only).

---

## 5. Integration Points (Minimal Touch)

### Repl.ts
- Early in `start()` (or new `startInteractive`):
  ```ts
  const started = await tryStartInkUI(session, renderer, this);
  if (started) return;
  ```
- Keep the entire existing `while (this.running)` loop for line mode.
- When ink is active, `executeTask` must be able to push to a bridge (pass bridge or expose a method).

### OutputRenderer.ts
- Add:
  ```ts
  private feedSink?: (item: any) => void;
  setFeedSink(sink?: (item: any) => void) { this.feedSink = sink; }
  ```
- In `writeLine`, `info`, `warn`, `success`, `error`, `stream`:
  - If `feedSink` exists → also call it (as `{type:'text'}`).
  - Always keep original stdout behavior (for headless / logs).

### InputReader.ts
- Do **not** create readline when ink mode is chosen.
- Decision is made in Repl before constructing InputReader.

### RunCommand.ts + Repl.executeTask
- `onStep` callbacks must forward to bridge when present (add a small adapter).

---

## 6. Phased Plan (Strict Gates)

**Gate for every phase**:
- `npm run build` (tsc) exit 0
- `node verify-zorge-cleanup.mjs` → PASS
- `node scripts/test-repl-smoke.mjs` → all green (this runs in non-TTY → forces line-mode path)

### U1 — Skeleton + Downgrade (Foundation)
Deliverables:
- `package.json` updated (done)
- `src/cli/repl/ui/startInkUI.ts`
- `src/cli/repl/ui/types.ts`
- `src/cli/repl/ui/ZorgeApp.tsx` (empty three boxes)
- `src/cli/repl/ui/bridge.ts` (no-op)
- Wire in Repl.ts (attempt first)

Acceptance:
- TTY with ink → shows empty layout
- No ink / non-TTY → zero change, smoke green

### U2 — TopBar + InputBar (Bottom bar works)
Deliverables:
- `TopBar.tsx` (tier color, model, workspace, budget stub)
- `InputBar.tsx` (basic input + Enter submit + history)
- Bridge submit path connected to existing command execution

Acceptance:
- `/help`, `/tier`, `/model`, plain task input all work from bottom bar
- Top bar updates on `/tier`

### U3 — Feed + Streaming
Deliverables:
- `Feed.tsx` + `FeedItem.tsx`
- Wire `onStep` from RunCommand / Repl.executeTask → `bridge.pushFeed`
- Auto scroll

Acceptance:
- `run "..."` produces live step/critique lines in feed
- Ctrl+C aborts and returns to InputBar

### U4 — ToolCard + Thought + Confirm
Deliverables:
- `ToolCard.tsx` (icon + summary + status + fold result)
- `ThoughtBlock.tsx`
- `ConfirmBar.tsx` + integrate with high-tier write confirmation

Acceptance:
- Tool calls show nice cards
- Write in high tier shows y/N inline
- Thinking collapsed

### U5 — Markdown + Live Budget
Deliverables:
- `Markdown.tsx` (minimal: `#`, ```` `, ** ** using colors)
- Budget bar driven by `softLimit` events

### U6 — Polish + Full Regression
- Resize
- ↑/↓ history in InputBar
- All 16 commands verified in both modes
- Final gates

---

## 7. Immediate Next Actions (Recommended Order)

1. Create directory `src/cli/repl/ui/`
2. Add the new types to `src/cli/repl/types.ts`
3. Implement `startInkUI.ts` (detection + fallback)
4. Implement minimal `bridge.ts`
5. Implement `ZorgeApp.tsx` + `TopBar.tsx` + `Feed.tsx` + `InputBar.tsx` skeletons
6. Wire attempt in `Repl.ts`
7. Add `setFeedSink` to `OutputRenderer`
8. Run gates

Would you like me to start coding **U1** right now (create the files + basic detection + empty layout)?

---

## 8. Risk Summary (Short)

| Risk                        | Mitigation                              |
|----------------------------|-----------------------------------------|
| ink install fails          | optionalDep + runtime try/catch → line mode |
| High-frequency updates lag | Batch + windowed render (last N items)  |
| Input fighting stdin       | Ink mode never creates readline         |
| Smoke regression           | Smoke always runs non-TTY → line path   |
| Confirm complexity         | ConfirmBar is simple overlay            |

This blueprint preserves the original discipline while delivering the desired Claude Code-like experience when the environment allows it.
