// src/cli/repl/OutputRenderer.ts
// Output rendering with chalk fallback to hand-written ANSI.
// Follows the exact interface in types.ts
// progressBar (single active, 20-char █/░ + %)
// TerminalCapabilities for color/keypress/multiline/progress/ansiCursor

import type { OutputRenderer, ColorName, SpinnerHandle } from './types.js';
import * as ansi from '../../utils/ansi.js';
import { getTerminalCapabilities } from './TerminalCapabilities.js';
import { stringWidth } from './stringWidth.js';

// Local interface augmentation
declare module './types.js' {
  interface OutputRenderer {
    progressBar(current: number, total: number, label?: string): ProgressBarHandle;
  }
}

export interface ProgressBarHandle {
  update(usedRatio: number): void;
  done(message?: string): void;
  fail(message?: string): void;
}

class StubProgressBar implements ProgressBarHandle {
  update(_usedRatio: number): void {}
  done(_message?: string): void {}
  fail(_message?: string): void {}
}

class ActiveProgressBar implements ProgressBarHandle {
  private active = true;
  private lastLen = 0;
  constructor(private label?: string, private onFinish?: () => void) {}

  private render(pct: number) {
    const width = 20;
    const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const pctStr = `${Math.floor(pct * 100)}%`;
    let line = `[${bar}] ${pctStr}`;
    if (this.label) line += ` · ${this.label}`;
    const pad = Math.max(0, this.lastLen - line.length);
    process.stdout.write('\r' + line + ' '.repeat(pad) + '\r');
    this.lastLen = line.length;
  }

  update(usedRatio: number): void {
    if (!this.active) return;
    const pct = Math.min(1, Math.max(0, usedRatio));
    this.render(pct);
  }

  private finish(finalMessage?: string) {
    if (!this.active) return;
    this.active = false;
    process.stdout.write('\r' + ' '.repeat(Math.max(60, this.lastLen + 2)) + '\r');
    if (finalMessage) {
      process.stdout.write(finalMessage + '\n');
    }
    if (this.onFinish) this.onFinish();
  }

  done(message?: string): void {
    this.finish(message);
  }

  fail(message?: string): void {
    this.finish(message);
  }

  forceClear(): void {
    if (!this.active) return;
    this.active = false;
    process.stdout.write('\r' + ' '.repeat(Math.max(60, this.lastLen + 2)) + '\r');
    if (this.onFinish) this.onFinish();
  }
}

// Chalk (optional)
let chalk: any = null;
try {
  // @ts-ignore - optional at compile time
  chalk = await import('chalk').then((m: any) => m.default || m);
} catch {
  chalk = null;
}

function shouldUseColor(): boolean {
  const caps = getTerminalCapabilities();
  return caps.color;
}

function c(text: string, name: ColorName): string {
  if (!shouldUseColor()) {
    return text;
  }
  if (chalk) {
    const map: any = {
      red: chalk.red,
      green: chalk.green,
      yellow: chalk.yellow,
      blue: chalk.blue,
      magenta: chalk.magenta,
      cyan: chalk.cyan,
      white: chalk.white,
      gray: chalk.gray,
      bold: chalk.bold,
      reset: (t: string) => t,
    };
    return (map[name] || ((t: string) => t))(text);
  }
  const map: any = {
    red: ansi.red,
    green: ansi.green,
    yellow: ansi.yellow,
    blue: ansi.blue,
    magenta: ansi.magenta,
    cyan: ansi.cyan,
    gray: ansi.gray,
    bold: ansi.bold,
    reset: () => ansi.reset(),
  };
  return (map[name] || ((t: string) => t))(text);
}

class SimpleSpinner implements SpinnerHandle {
  private textValue: string;
  constructor(text: string) {
    this.textValue = text;
    const caps = getTerminalCapabilities();
    if (caps.ansiCursor) {
      process.stdout.write(c('⠋ ' + text + '\r', 'cyan'));
    } else if (process.stdout && process.stdout.isTTY) {
      // Limited TTY but no cursor control: fall back to plain
      process.stdout.write('... ' + text + '\r');
    } else {
      console.log('... ' + text);
    }
  }
  text(newText: string) {
    this.textValue = newText;
    const caps = getTerminalCapabilities();
    if (caps.ansiCursor) {
      process.stdout.write('\r' + c('⠋ ' + newText, 'cyan') + '   \r');
    } else if (process.stdout && process.stdout.isTTY) {
      process.stdout.write('\r... ' + newText + '   \r');
    }
  }
  stop() {
    const caps = getTerminalCapabilities();
    if (caps.ansiCursor) {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    } else if (process.stdout && process.stdout.isTTY) {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }
  }
}

export class OutputRendererImpl implements OutputRenderer {
  // single active progress bar (event-driven, no timers)
  private currentProgress: ActiveProgressBar | null = null;

  write(text: string): void {
    process.stdout.write(text);
    this.pushToFeedIfAny(text);
  }

  writeLine(text: string): void {
    process.stdout.write(text + '\n');
    this.pushToFeedIfAny(text + '\n');
  }

  color(text: string, color: ColorName): string {
    return c(text, color);
  }

  startSpinner(text: string): SpinnerHandle {
    return new SimpleSpinner(text);
  }

  table(headers: string[], rows: string[][]): void {
    // P3-1（批次 B）：列宽/补空格按显示宽度（CJK=2 列）计算，替换裸 .length/padEnd
    const all = [headers, ...rows];
    const widths = headers.map((_, i) =>
      Math.max(...all.map(r => stringWidth(r[i] || '')))
    );
    const line = (row: string[]) =>
      row.map((cell, i) => {
        const c = cell || '';
        const pad = Math.max(0, widths[i] - stringWidth(c));
        return c + ' '.repeat(pad);
      }).join('  ');
    const headerLine = c(line(headers), 'bold');
    this.writeLine(headerLine);
    this.writeLine('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)));
    for (const r of rows) this.writeLine(line(r));
  }

  codeBlock(content: string, lang = ''): void {
    this.writeLine(c('```' + lang, 'gray'));
    this.writeLine(content);
    this.writeLine(c('```', 'gray'));
  }

  error(msg: string): void {
    const line = c('✗ ' + msg, 'red');
    this.writeLine(line);
    this.pushToFeedIfAny('✗ ' + msg, 'error');
  }

  warn(msg: string): void {
    const line = c('⚠ ' + msg, 'yellow');
    this.writeLine(line);
    this.pushToFeedIfAny('⚠ ' + msg, 'warn');
  }

  success(msg: string): void {
    const line = c('✓ ' + msg, 'green');
    this.writeLine(line);
    this.pushToFeedIfAny('✓ ' + msg, 'success');
  }

  info(msg: string): void {
    const line = c('• ' + msg, 'cyan');
    this.writeLine(line);
    this.pushToFeedIfAny('• ' + msg, 'info');
  }

  clearScreen(): void {
    const caps = getTerminalCapabilities();
    if (caps.ansiCursor) {
      ansi.clearScreen();
    }
  }

  stream(text: string): void {
    process.stdout.write(text);
    this.pushToFeedIfAny(text);
  }

  // P2-B + progress bar gated by TTY + capabilities.progress
  // @deprecated (fix-p2): no caller remains in the codebase — the rich UI
  // uses TopBar budget bars and the line mode uses the gerund spinner. Kept
  // for API compatibility; consider removing in a future major bump.
  progressBar(current: number, total: number, label?: string): ProgressBarHandle {
    const caps = getTerminalCapabilities();
    if (!caps.progress) {
      return new StubProgressBar();
    }
    // Replace any existing active bar (single active rule)
    if (this.currentProgress) {
      this.currentProgress.forceClear();
      this.currentProgress = null;
    }
    const handle = new ActiveProgressBar(label, () => {
      if (this.currentProgress === handle) this.currentProgress = null;
    });
    this.currentProgress = handle;
    const seed = (typeof current === 'number' && typeof total === 'number' && total > 0)
      ? current / total
      : 0;
    handle.update(seed);
    return handle;
  }

  // Ink UI integration: optional feed sink for routing classic writes into the rich feed
  private feedSink?: (item: any) => void;

  setFeedSink(sink?: (item: any) => void): void {
    this.feedSink = sink;
  }

  private pushToFeedIfAny(text: string, level?: 'info' | 'warn' | 'error' | 'success'): void {
    if (this.feedSink) {
      try {
        this.feedSink({ type: 'text', text, level });
      } catch {}
    }
  }
}

export function createOutputRenderer(): OutputRenderer {
  return new OutputRendererImpl();
}
