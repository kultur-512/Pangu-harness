// src/cli/repl/TerminalCapabilities.ts
// P2-E: Centralized, pure, testable terminal capability detection.
// Used by InputReader and OutputRenderer for graceful degradation on
// old Windows cmd, PowerShell ISE, non-TTY, etc.
//
// No new runtime deps. All detection is synchronous and must be <1ms.

import type { TerminalEnv } from '../../utils/ansi.js';
import {
  isColorSupported,
  isWindows,
  isPowerShellIse,
  isOldWindowsCmd,
} from '../../utils/ansi.js';

export interface TerminalCapabilities {
  /** ANSI color / styled output supported */
  color: boolean;
  /** Raw keypress events (arrows, ctrl, etc.) are reliable */
  keypress: boolean;
  /** Multiline editing / accumulation works well */
  multiline: boolean;
  /** In-place progress bar (carriage return + redraw) is advisable */
  progress: boolean;
  /** ANSI cursor control (hide/show, clear) is safe */
  ansiCursor: boolean;
}

/**
 * Detect capabilities for a given (or current) environment.
 * Pure when TerminalEnv is provided; falls back to process when omitted.
 * This function is intentionally cheap (<1ms) and has no internal caching
 * so that runtime mutations of process.stdout.isTTY (in tests) are visible.
 */
export function detectTerminalCapabilities(e?: TerminalEnv): TerminalCapabilities {
  const tty = !!(e && typeof e.isTTY === 'boolean'
    ? e.isTTY
    : (typeof process !== 'undefined' && process.stdout && process.stdout.isTTY && process.stdin && process.stdin.isTTY));

  const color = isColorSupported(e);

  const win = isWindows(e);
  const ise = isPowerShellIse(e);
  const oldCmd = isOldWindowsCmd(e);

  // Keypress: disable on ISE and classic old cmd (poor raw mode support)
  const keypress = tty && !(ise || (win && oldCmd));

  // Multiline: disable on ISE and on classic old cmd (fragile console)
  const multiline = tty && !ise && !(win && oldCmd);

  // Progress bar: requires TTY + reasonable cursor/color behavior.
  // On old Windows cmd we avoid even if TTY (conservative).
  const progress = tty && (color || !win) && !ise && !(win && oldCmd);

  // Cursor control: avoid on ISE and old cmd
  const ansiCursor = tty && !ise && !(win && oldCmd);

  return { color, keypress, multiline, progress, ansiCursor };
}

/**
 * Runtime helper: always detects fresh (no memoization).
 * Tests can mutate process.stdout.isTTY and immediately observe effect.
 */
export function getTerminalCapabilities(): TerminalCapabilities {
  return detectTerminalCapabilities();
}

/** No-op kept for API compatibility if any external code calls reset. */
export function resetTerminalCapabilitiesCache(): void {
  // Intentionally empty: detect is cheap and we do not cache at this layer.
}
