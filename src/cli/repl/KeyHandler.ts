// src/cli/repl/KeyHandler.ts
// Basic key handling for ZIS REPL (Ctrl+C, Ctrl+D, Esc+Enter, Tab)

import type { InputReader } from './types.js';

export class KeyHandler {
  private multilineMode = false;
  private onCancel: (() => void) | null = null;
  private onSubmitMultiline: (() => void) | null = null;
  private onTab: (() => void) | null = null;
  private onInterrupt: (() => void) | null = null;

  constructor(private input: InputReader) {
    this.input.on('keypress', (key: any) => {
      if (!key) return;

      // B6: Esc arming must not STICK — the old code left multilineMode=true
      // until the next Enter, so ANY later Enter submitted the multiline
      // buffer. Reset on any non-Esc, non-Enter keypress (and on a second Esc).
      if (this.multilineMode && key.name !== 'return' && key.name !== 'escape') {
        this.multilineMode = false;
      }

      // Ctrl+C
      if (key.ctrl && key.name === 'c') {
        if (this.onInterrupt) {
          this.onInterrupt();
          return; // handled by REPL task abort
        }
        if (this.multilineMode && this.onCancel) {
          this.onCancel();
        } else {
          // Let the main loop handle exit or task abort
          process.emit('SIGINT' as any);
        }
      }

      // Ctrl+D
      if (key.ctrl && key.name === 'd') {
        process.emit('SIGINT' as any);
      }

      // Esc + Enter for multiline submit (simple heuristic).
      // B6: a second Esc also disarms (instead of re-arming).
      if (key.name === 'escape') {
        this.multilineMode = !this.multilineMode;
      }
      if (key.name === 'return' && this.multilineMode && this.onSubmitMultiline) {
        this.onSubmitMultiline();
        this.multilineMode = false;
      }

      // Tab (some terminals send it as keypress too)
      if (key.name === 'tab' && this.onTab) {
        this.onTab();
      }
    });
  }

  setMultilineHandlers(onCancel: () => void, onSubmit: () => void) {
    this.onCancel = onCancel;
    this.onSubmitMultiline = onSubmit;
  }

  setTabHandler(fn: () => void) {
    this.onTab = fn;
  }

  setMultilineMode(active: boolean) {
    this.multilineMode = active;
  }

  setInterruptHandler(fn: () => void) {
    this.onInterrupt = fn;
  }
}
