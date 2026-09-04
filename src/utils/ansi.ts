// src/utils/ansi.ts
// Hand-written ANSI utilities (zero-dependency fallback)
// Used when chalk is not available or fails to load.
// Windows 终端色彩深度兼容 + 可测试的能力探测

const ESC = '\x1b';
const RESET = `${ESC}[0m`;

const COLORS: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
};

/**
 * 可注入测试环境（纯探测）。
 */
export interface TerminalEnv {
  platform?: string;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}

function getPlatform(e?: TerminalEnv): string {
  return (e?.platform || (typeof process !== 'undefined' ? process.platform : 'unknown') || 'unknown').toLowerCase();
}

function getEnv(e?: TerminalEnv): Record<string, string | undefined> {
  if (e?.env) return e.env;
  return (typeof process !== 'undefined' ? (process.env as any) : {}) || {};
}

function getIsTTY(e?: TerminalEnv): boolean {
  if (typeof e?.isTTY === 'boolean') return e.isTTY;
  return !!(typeof process !== 'undefined' && process.stdout && process.stdout.isTTY);
}

export function isWindows(e?: TerminalEnv): boolean {
  return getPlatform(e) === 'win32';
}

export function isPowerShellIse(e?: TerminalEnv): boolean {
  if (!isWindows(e)) return false;
  const env = getEnv(e);
  if (env.WT_SESSION) return false;
  const psmp = (env.PSModulePath || '').toLowerCase();
  if (psmp.includes('windowspowershell')) return true;
  if (env.POWERSHELL_DISTRIBUTION_CHANNEL === 'ISE') return true;
  return false;
}

export function isOldWindowsCmd(e?: TerminalEnv): boolean {
  if (!isWindows(e)) return false;
  const env = getEnv(e);
  if (env.WT_SESSION) return false;
  if (env.COLORTERM) return false;
  const term = (env.TERM || '').toLowerCase();
  // Conservative on Windows:
  // Only treat as "modern enough" (not old) if we see a strong signal like 256-color.
  // Bare 'xterm', 'vt100', etc. without WT/COLORTERM/256 are insufficient.
  if (term.includes('256')) return false;
  return true;
}

export function isColorSupported(e?: TerminalEnv): boolean {
  if (!getIsTTY(e)) return false;

  const env = getEnv(e);
  if (env.NO_COLOR || env.FORCE_COLOR === '0') return false;
  if (env.FORCE_COLOR === '1') return true;

  if (!isWindows(e)) return true;

  if (isOldWindowsCmd(e)) return false;

  if (env.WT_SESSION || env.COLORTERM) return true;
  const term = (env.TERM || '').toLowerCase();
  if (term.includes('xterm') || term.includes('256') || term.includes('vt100')) return true;

  return false;
}

// Back-compat wrappers (use real process if no override provided)
export function isColorSupportedRuntime(): boolean {
  return isColorSupported();
}

export function color(text: string, name: string): string {
  if (!isColorSupportedRuntime()) return text;
  const code = COLORS[name] ?? 0;
  if (code === 0) return text;
  return `${ESC}[${code}m${text}${RESET}`;
}

export const red = (t: string) => color(t, 'red');
export const green = (t: string) => color(t, 'green');
export const yellow = (t: string) => color(t, 'yellow');
export const blue = (t: string) => color(t, 'blue');
export const magenta = (t: string) => color(t, 'magenta');
export const cyan = (t: string) => color(t, 'cyan');
export const gray = (t: string) => color(t, 'gray');
export const bold = (t: string) => (process.stdout.isTTY ? `${ESC}[1m${t}${RESET}` : t);
export const reset = () => RESET;

export function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`${ESC}[2J${ESC}[H`);
  }
}

export function cursorShow(): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}[?25h`);
}
export function cursorHide(): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}[?25l`);
}

export function write(text: string): void {
  process.stdout.write(text);
}

export function writeLine(text: string): void {
  process.stdout.write(text + '\n');
}
