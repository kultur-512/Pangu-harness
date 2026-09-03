# Zorge Ink UI — Final Refined Construction Blueprint (Path B)

**Decision**: Proceed with `ink@5 + react@18` for a real bottom-bar + card-stream experience (Claude Code style).  
**Hard rule**: The existing line-mode REPL must remain fully functional in every environment via silent runtime downgrade.

---

## 1. Dependency Trade-off Review (as requested)

**Recommendation**: Accept the change, but strictly under the "optional + downgrade" discipline.

**Approved shape** (already applied to package.json):

```json
"optionalDependencies": {
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2",
  "ink": "^5.0.0",
  "react": "^18.3.0"
}
```

**Enforcement rules** (must be in code):
- Never import ink/react at top level.
- Only dynamic `import('ink')` / `import('react')` inside `startInkUI.ts`.
- If import fails or TTY/caps check fails → return `null` with **zero console output**.
- Line-mode path must continue to work identically (smoke tests run in non-TTY → automatic protection).

**Cost**: ~10-12 extra packages, +2~4MB installed. Acceptable for the UX.

**Red line**: If ink cannot be used, user must not notice any degradation in the classic experience.

---

## 2. Architecture (Strict Separation)

```
Engine (ZorgeChaser / Loop / RunCommand)
        ↓ only via onStep + results
UiBridge (one thin adapter)
        ↓
ZorgeApp (useReducer<UiState>)
        ├── TopBar
        ├── Feed (scroll)
        │   └── FeedItem / ToolCard / ThoughtBlock / Markdown
        └── InputBar (+ ConfirmBar overlay)
```

**Key invariants**:
- Core never imports from `ui/`.
- When ink mode is active, `Repl` does **not** enter the classic `while (this.running)` loop.
- `OutputRenderer` keeps stdout behavior + optional feed sink.
- Input in ink mode is fully owned by `InputBar`.

---

## 3. State Model (Single Source of Truth)

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
```

---

## 4. File Structure (Exact)

```
src/cli/repl/ui/
  startInkUI.ts          // THE critical downgrade gate
  bridge.ts
  ZorgeApp.tsx
  TopBar.tsx
  Feed.tsx
  FeedItem.tsx
  ToolCard.tsx
  ThoughtBlock.tsx
  InputBar.tsx
  ConfirmBar.tsx
  Markdown.tsx           // this phase: #, ```, **bold** (color only)
  types.ts
```

---

## 5. Integration Touch Points (Minimal)

| File                    | Change |
|-------------------------|--------|
| `src/cli/repl/Repl.ts`  | Early attempt `await tryStartInkUI(...)`; if true, return without entering line loop |
| `src/cli/repl/OutputRenderer.ts` | Add `setFeedSink()` + forward `writeLine/info/warn/...` as text items when sink present |
| `src/cli/repl/InputReader.ts` | Do not create readline if ink mode was chosen upstream |
| `src/cli/repl/types.ts` | Add FeedItem / UiState / UiBridge (additive) |
| `RunCommand.ts` + `Repl.executeTask` | Forward onStep to bridge when available |
| `package.json`          | Already updated with ink + react in optionalDependencies |

---

## 6. Interaction Details (This Phase Scope)

- **Bottom bar always visible** at the bottom.
- **Multi-line input**: Enter submits, Shift+Enter or Ctrl+J inserts newline (or use ink-text-input).
- **Streaming**: Every `onStep` (step/critique/phase) becomes a FeedItem immediately.
- **Tool cards**: Icon + short args + status (`running` / `✓` green / `✗` red). Result foldable.
- **Thinking**: `💭 short...` (space to expand full).
- **Confirm**: For high-tier writes, `ConfirmBar` overlays the input area: `确认 Write src/x.ts? [y/N]`.
- **Markdown**: Headers, fenced code blocks (basic syntax color via chalk), **bold**.
- **Budget**: Top bar progress driven by `softLimit` events.

---

## 7. Phased Delivery (U1–U6) + Gates

**Gate for every phase**:
- `npm run build` exit 0
- `verify-zorge-cleanup` PASS
- `scripts/test-repl-smoke.mjs` PASS (non-TTY → line mode path)

**U1** — Downgrade + Skeleton  
`startInkUI.ts`, basic layout, bridge stub, early wire in Repl.  
Exit: TTY shows boxes; non-TTY/smoke identical to before.

**U2** — TopBar + InputBar  
Top status + bottom input that can submit commands/tasks.  
Exit: /help /tier /model + plain tasks work from bottom bar.

**U3** — Feed + Streaming  
onStep → live Feed. Auto-scroll. Ctrl+C aborts cleanly.

**U4** — ToolCard + Thought + Confirm  
Rich cards, collapsed thinking, inline y/N for writes.

**U5** — Markdown + Live Budget  
`Markdown.tsx` + budget bar updated from softLimit.

**U6** — Polish + Full Regression  
Resize, history, all 16 commands in both modes, final gates.

---

## 8. Risks & Mitigations

- Ink install fails → optionalDep + runtime try/catch (mandatory).
- Flood of updates → batch every 16ms + render only tail window.
- Resize fights → listen to `useStdout` and recompute Feed height.
- Confirm vs normal input → ConfirmBar suspends normal InputBar while shown.
- Smoke regression → smoke always runs non-TTY, so it can never hit ink code.

---

## 9. Immediate Next Actions

1. Create `src/cli/repl/ui/` directory.
2. Add the new types to `src/cli/repl/types.ts`.
3. Implement `startInkUI.ts` (the downgrade gate is the most important single file).
4. Implement `bridge.ts`.
5. Create skeleton `ZorgeApp.tsx` + `TopBar.tsx` + `Feed.tsx` + `InputBar.tsx`.
6. Wire the early attempt in `Repl.ts`.
7. Add `setFeedSink` support to `OutputRenderer`.
8. Run all gates.

---

**One-sentence summary** (as you requested):

引入 ink 换取真正的 Claude Code 级底栏 + 卡片流 + Markdown 渲染；代价是打破零依赖，但用 **optionalDependencies + 运行时降级**保住"任何环境都能用"的纪律等价物；核心逻辑与 UI 零耦合，16 命令与回退路径全程保绿。

---

Ready to start **U1** implementation now? I can begin with `startInkUI.ts` + type definitions + the minimal skeleton components.
