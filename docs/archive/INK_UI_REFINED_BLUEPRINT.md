# Zorge Ink UI — Refined Construction Blueprint (Path B)

**Approved Direction**: Bottom bar + rich feed first (Markdown/code blocks in scope for this phase).  
**Non-negotiable**: Existing zero-dependency line-mode REPL must remain fully functional via silent runtime downgrade.

---

## 1. Dependency Stance (Reviewer Opinion)

**Decision**: Accept `ink@5 + react@18` via `optionalDependencies`.

**Rationale & Rules**:
- Matches the existing pattern for chalk/ora/prompts.
- `npm install` failures (sandbox, permission, etc.) must **never** break install or build.
- Runtime contract (enforced in code):
  ```ts
  // Only in startInkUI.ts
  try {
    const ink = await import('ink');
    const React = await import('react');
    // + TTY + capabilities check
  } catch {
    return null; // SILENT fallback — no log, no warning
  }
  ```
- Ink mode is only activated when:
  - Dynamic imports succeed
  - `process.stdout.isTTY && process.stdin.isTTY`
  - `TerminalCapabilities.multiline` (or equivalent rich TTY)
- Consequence: In CI, tests, old Windows cmd, PowerShell ISE, non-TTY → 100% classic behavior.

**Package.json change** (already applied):
```json
"optionalDependencies": {
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2",
  "ink": "^5.0.0",
  "react": "^18.3.0"
}
```

---

## 2. Architecture Principles (Refined)

1. **Zero coupling from core**: `ZorgeChaser`, `VerifyCritiqueLoop`, `RunCommand`, etc. never import from `ui/`.
2. **Single source of truth**: `UiState` (React reducer).
3. **One-way bridge**: Engine → `UiBridge` → dispatch → `UiState`.
4. **Input ownership**:
   - Ink active → `InputBar` owns input (no readline created).
   - Line mode → existing `InputReader`.
5. **Output duality**:
   - `OutputRenderer` always writes to stdout (for logs/headless).
   - When ink active, it also forwards to `bridge.pushFeed({type:'text', ...})`.
6. **Graceful degradation is the default path** for smoke tests.

---

## 3. Data Contracts (Additive)

Add to `src/cli/repl/types.ts`:

```ts
export type FeedItem =
  | { id: string; type: 'text'; text: string; level?: 'info'|'warn'|'error'|'success' }
  | { id: string; type: 'phase'; phase: 'explore'|'rollout'|'judge'|'done' }
  | { id: string; type: 'step'; stepNumber: number; thinking?: string; plan?: string; toolCalls?: any[] }
  | { id: string; type: 'critique'; stepNumber: number; critique: string }
  | { id: string; type: 'tool';
      tool: string; target?: string; argsSummary?: string;
      result?: string; status: 'running'|'ok'|'fail' }
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

## 4. File Structure (Exact)

```
src/cli/repl/ui/
  startInkUI.ts          // detection + render or null (critical downgrade gate)
  bridge.ts              // UiBridge implementation + event wiring from Repl
  ZorgeApp.tsx           // root with useReducer<UiState>
  TopBar.tsx             // tier color + model + workspace + budget bar
  Feed.tsx               // scroll area (windowed)
  FeedItem.tsx           // dispatcher
  ToolCard.tsx           // ⚙ Bash / 📄 Read / ✏️ Write / etc + fold result
  ThoughtBlock.tsx       // 💭 collapsed thinking
  InputBar.tsx           // bottom bar (multi-line via useInput or ink-text-input)
  ConfirmBar.tsx         // y/N overlay for high-tier writes
  Markdown.tsx           // this phase: # headers, ``` blocks, **bold** (color only)
  types.ts               // local UI types (re-export main contracts)
```

---

## 5. Integration Points (Minimal & Safe)

### Repl.ts (main control point)
- In/near `start()`:
  ```ts
  const inkOk = await tryStartInkUI(this.session, this.renderer, this);
  if (inkOk) return; // ink owns loop
  // existing while(this.running) line loop remains untouched
  ```
- `executeTask` and command paths must accept an optional bridge and forward `onStep`.

### OutputRenderer.ts
- Add:
  ```ts
  private feedSink?: (item: any) => void;
  setFeedSink(s?: (item: any) => void) { this.feedSink = s; }
  ```
- In `writeLine` / `info` / `warn` / `success` / `error` / `stream`:
  - If sink exists → also emit as `{type: 'text'}`
  - Always keep stdout path.

### InputReader.ts
- Do not instantiate readline when ink mode is selected upstream.
- Decision lives in Repl before constructing readers.

### RunCommand.ts + Repl.executeTask
- `onStep` callback must also call `bridge?.pushFeed(...)` when bridge is present.

### types.ts
- Only additive exports (FeedItem, UiState, UiBridge, StepCallback already exists).

---

## 6. Phased Plan (U1–U6) with Gates

**Universal Gate (every phase)**:
- `npm run build` (tsc) → 0
- `node verify-zorge-cleanup.mjs` → PASS
- `node scripts/test-repl-smoke.mjs` → all green (non-TTY forces line mode)

### U1 — Foundation & Downgrade
- `package.json` updated
- `startInkUI.ts` (dynamic import + TTY + caps check → null)
- `bridge.ts` skeleton
- `ZorgeApp.tsx` + `TopBar.tsx` + `Feed.tsx` + `InputBar.tsx` (empty boxes)
- Wire attempt in Repl.ts

**Exit criteria**: TTY shows skeleton; non-TTY/smoke completely unaffected.

### U2 — TopBar + InputBar (Bottom bar functional)
- TopBar: tier (colored), model, workspace, budget stub
- InputBar: input + Enter submit + basic history
- Submit wired to existing command/task execution

**Exit criteria**: `/help`, `/tier`, `/model`, direct tasks work from bottom bar.

### U3 — Feed + onStep Streaming
- Bridge receives `onStep` from Repl/RunCommand
- Feed renders steps, critique, phases
- Auto-scroll + Ctrl+C abort returns to InputBar

### U4 — ToolCard + ThoughtBlock + ConfirmBar
- Tool cards with icon + summary + status + fold
- `💭` collapsed thinking
- `ConfirmBar` for write operations in high tiers

### U5 — Markdown + Live Budget
- `Markdown.tsx` (headers, code fences, bold via color)
- `softLimit`/`degradation` update budget bar live

### U6 — Polish + Full Regression
- Resize handling
- ↑/↓ history in InputBar
- All 16 commands verified in both modes
- Final gates + docs

---

## 7. Immediate Next Steps (Recommended Order)

1. Create `src/cli/repl/ui/` directory.
2. Add contracts to `src/cli/repl/types.ts`.
3. Implement `startInkUI.ts` (the downgrade gate is the most important file).
4. Implement `bridge.ts`.
5. Implement minimal `ZorgeApp.tsx` + `TopBar.tsx` + `Feed.tsx` + `InputBar.tsx`.
6. Wire early attempt in `Repl.ts`.
7. Add `setFeedSink` to `OutputRenderer`.
8. Run full gates.

---

## 8. Risks & Mitigations (Short)

| Risk                        | Mitigation |
|----------------------------|------------|
| ink install fails in sandbox | optionalDep + try/catch → line mode (mandatory) |
| High-frequency feed lag    | Batch updates (16ms) + only render last N items |
| Input/output mode conflict | Ink mode never creates readline |
| Smoke regression           | Smoke always runs non-TTY |
| Confirm UX complexity      | ConfirmBar is simple overlay; suspend normal input |

---

**Summary for execution**:
- We are deliberately trading "zero dependencies" for a real bottom-bar experience.
- We protect the original discipline with `optionalDependencies` + **mandatory silent runtime downgrade**.
- Core logic stays completely unaware of ink.
- Bottom bar + streaming feed + tool cards + basic Markdown are the scope for this cycle.

Ready to start coding U1? I can begin with `startInkUI.ts` + contracts + skeleton components.
