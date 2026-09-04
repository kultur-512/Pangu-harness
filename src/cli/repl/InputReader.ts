// src/cli/repl/InputReader.ts
// Basic readline wrapper for REPL input.
// Supports history, completer (Tab), multiline accumulation, and key events.
// 基于 TerminalCapabilities 的按键与多行行为门控

import * as readline from 'node:readline';
import type { InputReader } from './types.js';
import { getTerminalCapabilities } from './TerminalCapabilities.js';
import { computeMenuItems, menuOpenFor, moveMenuIndex, menuRenderLines } from './SlashPicker.js';

export type CompleterFn = (line: string) => [string[], string];

export class InputReaderImpl implements InputReader {
  private rl: readline.Interface;
  private listeners: { line: ((l: string) => void)[]; keypress: ((k: any) => void)[] } = {
    line: [],
    keypress: [],
  };
  public history: string[] = [];

  private multilineActive = false;
  private multilineLines: string[] = [];
  private multilinePrompt = '  ... ';
  private pendingReadResolver: ((s: string) => void) | null = null;

  // picker-③: resident slash menu state (line mode)
  private menuOpen = false;
  private menuIndex = 0;
  private menuItems: Array<{ name: string; description: string }> = [];
  private menuDismissed = false;
  private completer: CompleterFn | null = null;

  constructor(completer?: CompleterFn) {
    this.completer = completer ?? null;
    const options: readline.ReadLineOptions = {
      input: process.stdin,
      output: process.stdout,
      historySize: 1000,
      removeHistoryDuplicates: true,
    };

    if (completer) {
      options.completer = (line: string, callback: (err: any, result: [string[], string]) => void) => {
        try {
          const res = completer(line);
          callback(null, res);
        } catch (e) {
          callback(e, [[], line]);
        }
      };
    }

    this.rl = readline.createInterface(options);

    // Forward line events (handle multiline accumulation here)
    this.rl.on('line', (line: string) => {
      if (this.multilineActive) {
        if (line.trim() === '') {
          const full = this.multilineLines.join('\n');
          this.multilineActive = false;
          this.multilineLines = [];
          for (const fn of this.listeners.line) fn(full);
          return;
        }
        this.multilineLines.push(line);
        this.rl.setPrompt(this.multilinePrompt);
        this.rl.prompt(true);
        return;
      }

      if (line.trim()) {
        this.history.push(line);
        if (this.history.length > 1000) this.history.shift();
      }
      for (const fn of this.listeners.line) fn(line);
    });

    // 仅在能力允许时启用 keypress 事件
    // (avoids garbage on old Windows cmd / ISE where raw mode is fragile).
    // picker-③: non-TTY / caps.keypress=false → NO menu (Tab completer stays).
    const caps = getTerminalCapabilities();
    if (caps.keypress && process.stdin && process.stdin.isTTY) {
      (readline as any).emitKeypressEvents(process.stdin);
      process.stdin.on('keypress', (str: string, key: any) => {
        const consumed = this.handleMenuKeypress(str, key);
        if (consumed) return; // menu handled this key; suppress other listeners
        for (const fn of this.listeners.keypress) fn(key);
      });
    }
  }

  // ---- picker-③: resident slash menu (line mode) ----
  private currentLine(): string {
    try { return String((this.rl as any).line ?? ''); } catch { return ''; }
  }

  private refreshMenuFromLine(): void {
    const line = this.currentLine();
    this.menuDismissed = line !== '/' && !line.startsWith('/') ? false : this.menuDismissed;
    if (menuOpenFor(line) && !this.menuDismissed) {
      this.menuItems = computeMenuItems(line);
      this.menuOpen = this.menuItems.length > 0;
      if (this.menuIndex >= this.menuItems.length) this.menuIndex = Math.max(0, this.menuItems.length - 1);
    } else {
      this.menuOpen = false;
      this.menuItems = [];
    }
  }

  private redrawMenu(): void {
    const out = process.stdout;
    try {
      readline.clearLine(out, 1);
      readline.cursorTo(out, 0);
      const lines = menuRenderLines(this.menuItems, this.menuIndex);
      for (const l of lines) {
        out.write(l + '\n');
      }
      // restore the input line below the menu
      const line = this.currentLine();
      readline.cursorTo(out, 0);
      out.write((this.rl as any).getPrompt?.() ?? '');
      out.write(line);
      const cursor = Math.min((this.rl as any).cursor ?? line.length, line.length);
      readline.cursorTo(out, cursor + String((this.rl as any).getPrompt?.() ?? '').length);
    } catch {}
  }

  private handleMenuKeypress(str: string, key: any): boolean {
    const line = this.currentLine();
    // Re-evaluate menu state on every keystroke (typing/backspace changes it)
    if (!key.ctrl && !key.meta && key.name !== 'up' && key.name !== 'down' && key.name !== 'return' && key.name !== 'escape') {
      this.refreshMenuFromLine();
    }

    if (this.menuOpen) {
      if (key.name === 'up' || key.name === 'down') {
        this.menuIndex = moveMenuIndex(this.menuIndex, this.menuItems.length, key.name === 'up' ? -1 : 1);
        this.redrawMenu();
        return true;
      }
      if (key.name === 'return') {
        const idx = Math.min(this.menuIndex, Math.max(0, this.menuItems.length - 1));
        if (this.menuItems.length > 0 && this.menuItems[idx]) {
          const sel = this.menuItems[idx].name;
          this.menuOpen = false; this.menuItems = []; this.menuDismissed = false; this.menuIndex = 0;
          // replace the line + submit through the normal 'line' path
          try {
            (this.rl as any).line = sel;
            (this.rl as any).cursor = sel.length;
            readline.clearLine(process.stdout, 1);
            readline.cursorTo(process.stdout, 0);
          } catch {}
          // clear menu lines drawn above, then emit 'line' (routes via the
          // existing line handler: history push + listeners)
          this.rl.emit('line', sel);
          return true;
        }
      }
      if (key.name === 'escape') {
        this.menuDismissed = true;
        this.menuOpen = false;
        // B10: capture the menu height BEFORE clearing — the loop below used
        // this.menuItems.length AFTER it was emptied, so it only cleared 1
        // line and left the rendered menu rows on screen.
        const menuHeight = this.menuItems.length;
        this.menuItems = [];
        // clear menu lines, leave only the input line
        try {
          for (let i = 0; i < menuHeight + 1; i++) {
            readline.clearLine(process.stdout, 1);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write('\n');
          }
          readline.cursorTo(process.stdout, 0);
          readline.clearLine(process.stdout, 1);
          const p = (this.rl as any).getPrompt?.() ?? '';
          process.stdout.write(p + this.currentLine());
          readline.cursorTo(process.stdout, p.length + Math.min((this.rl as any).cursor ?? 0, this.currentLine().length));
        } catch {}
        return true;
      }
    } else if (menuOpenFor(line) && key.name === 'escape' && this.menuDismissed) {
      // already dismissed: single Esc clears input? keep current behavior
      return false;
    }

    // Re-arm menu after dismiss when typing a new char after '/'
    if (this.menuDismissed && str && !key.ctrl && !key.meta && line.startsWith('/')) {
      this.menuDismissed = false;
    }
    return false;
  }

  async read(prompt = '  ▸ '): Promise<string> {
    return new Promise((resolve) => {
      // If we are in multiline, we don't use question; the 'line' handler will resolve via listener
      // For normal single-line, use question.
      if (this.multilineActive) {
        // Should not normally reach here; multiline is event driven
        this.rl.setPrompt(this.multilinePrompt);
        this.rl.prompt(true);
        // resolve will happen via 'line' listener path above
        // To keep API simple, we resolve on next non-multiline line (edge case)
        const once = (l: string) => {
          this.offLine(once);
          resolve(l);
        };
        this.on('line', once);
        return;
      }

      this.rl.setPrompt(prompt);
      this.rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  }

  // Helper to remove a specific line listener (simple impl)
  private offLine(fn: (l: string) => void) {
    this.listeners.line = this.listeners.line.filter(f => f !== fn);
  }

  pause(): void {
    this.rl.pause();
  }

  resume(): void {
    this.rl.resume();
  }

  close(): void {
    this.rl.close();
  }

  on(event: 'line', listener: (line: string) => void): void;
  on(event: 'keypress', listener: (key: any) => void): void;
  on(event: string, listener: any): void {
    if (event === 'line') this.listeners.line.push(listener);
    if (event === 'keypress') this.listeners.keypress.push(listener);
  }

  // Multiline controls
  enterMultiline(): void {
    this.multilineActive = true;
    this.multilineLines = [];
    this.rl.setPrompt(this.multilinePrompt);
    this.rl.prompt(true);
  }

  exitMultiline(): void {
    this.multilineActive = false;
    this.multilineLines = [];
  }

  isMultiline(): boolean {
    return this.multilineActive;
  }
}

export function createInputReader(completer?: CompleterFn): InputReader {
  return new InputReaderImpl(completer);
}

