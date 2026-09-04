// src/cli/repl/ModeRing.ts
// 权限模式环（模式循环切换）。
// Order: plan → default → auto-accept → full → plan (shift+tab).
//
// plan  : reads free; writes/bash denied at the adapter pre-check; PromptBuilder
//         injects the <plan_mode> hard constraint. Exit = cycle away (no
//         ExitPlanMode confirmation card — documented CC difference).
// default: M2 semantics (writes confirm, bash allowlist free).
// auto-accept / full : writes run without confirmation; danger stays flagged.
//         (Panshalach does not implement a bypass-permissions tier above this —
//          documented CC difference.)

export type UiMode = 'plan' | 'default' | 'auto-accept' | 'full';

export const UI_MODE_ORDER: UiMode[] = ['plan', 'default', 'auto-accept', 'full'];

/** The approval-layer mode each UI mode maps to (plan keeps readonly floor). */
export function uiModeToApprovalMode(m: UiMode): 'readonly' | 'default' | 'full' {
  switch (m) {
    case 'plan': return 'readonly';
    case 'auto-accept': return 'full';
    case 'full': return 'full';
    default: return 'default';
  }
}

export class ModeRing {
  private index = 0;

  constructor(
    initial: UiMode = 'default',
    private onChange?: (m: UiMode) => void
  ) {
    this.index = Math.max(0, UI_MODE_ORDER.indexOf(initial));
  }

  get current(): UiMode {
    return UI_MODE_ORDER[this.index];
  }

  set(m: UiMode): void {
    const i = UI_MODE_ORDER.indexOf(m);
    if (i === -1) return;
    if (this.index !== i) {
      this.index = i;
      this.onChange?.(m);
    }
  }

  /** shift+tab: advance the ring and notify. */
  cycle(): UiMode {
    this.index = (this.index + 1) % UI_MODE_ORDER.length;
    const m = UI_MODE_ORDER[this.index];
    this.onChange?.(m);
    return m;
  }

  /** Cycle FROM a given mode (stateless helper for tests / commands). */
  static nextAfter(m: UiMode): UiMode {
    const i = UI_MODE_ORDER.indexOf(m);
    return UI_MODE_ORDER[(i + 1) % UI_MODE_ORDER.length];
  }
}
