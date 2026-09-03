// src/cli/repl/ui/useInputBuffer.ts
// cc-typeahead (C): input buffer with debounce-merged entries + undo/redo.
// Each entry records the text state BEFORE a change batch (prevText), so
// Ctrl+Z reverts a whole word/paste batch, not every character.

export class InputBuffer {
  private undoStack: string[] = []; // prevText states, oldest first
  private redoStack: string[] = [];
  private lastPush = 0;

  constructor(private debounceMs = 400) {}

  /**
   * Record a transition prevText → nextText. Transitions within debounceMs of
   * the last one MERGE into the same batch (only the FIRST transition's
   * prevText is recorded). A transition outside the window starts a new batch.
   */
  push(prevText: string, _nextText: string): void {
    const now = Date.now();
    if (now - this.lastPush > this.debounceMs) {
      this.undoStack.push(prevText);
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    this.lastPush = now;
    this.redoStack = []; // new input invalidates redo
  }

  /** Revert to the previous committed state. Returns the restored text or null. */
  undo(currentText: string): string | null {
    if (this.undoStack.length === 0) return null;
    const prev = this.undoStack[this.undoStack.length - 1];
    this.undoStack.pop();
    this.redoStack.push(currentText);
    return prev;
  }

  /** Re-apply the last undone transition. */
  redo(currentText: string): string | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack[this.redoStack.length - 1];
    this.redoStack.pop();
    this.undoStack.push(currentText);
    return next;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastPush = 0;
  }
}
