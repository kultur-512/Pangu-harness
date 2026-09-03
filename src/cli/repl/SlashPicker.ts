// src/cli/repl/SlashPicker.ts
// Resident slash-command picker (Claude-Code style) — PURE LOGIC core.
// Shared by the rich (ink) menu and the line-mode (readline) menu.
//
// - typing '/' opens a resident menu above the input; more typing filters it
//   live (prefix → fuzzy, reusing FuzzyMatcher); up/down moves a clamped
//   highlight; Enter executes the selection; Esc closes the menu.
// - All state transitions are pure functions here (unit-testable without a TTY).

import { fuzzyFilter } from './FuzzyMatcher.js';

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description?: string;
}

/**
 * Canonical command list for the picker menu. Covers BOTH the sseInteractive
 * dispatcher commands and the classic Repl registry commands (superset), so
 * the menu is honest in both modes.
 */
export const ZORGE_COMMANDS: SlashCommand[] = [
  { name: 'help', description: '显示帮助' },
  { name: 'tier', description: '查看或切换档位' },
  { name: 'model', description: '查看/切换模型；/model list 拉远程列表' },
  { name: 'approvals', description: '审批模式（readonly/default/full）' },
  { name: 'undo', description: '撤销最近写盘' },
  { name: 'rewind', description: '按回合回放变更' },
  { name: 'compact', description: '压缩会话历史' },
  { name: 'usage', description: '用量与成本' },
  { name: 'resume', description: '列出/切换会话' },
  { name: 'agents', description: '子代理 rollout 树' },
  { name: 'status', description: '会话状态' },
  { name: 'memory', description: '记忆卡' },
  { name: 'review', description: 'Review 白名单测试' },
  { name: 'config', description: '配置' },
  { name: 'init', description: '初始化' },
  { name: 'history', description: '历史' },
  { name: 'trace', description: '轨迹' },
  { name: 'session', description: '会话管理' },
  { name: 'workspace', description: '工作区' },
  { name: 'clear', description: '清屏' },
  { name: 'exit', aliases: ['quit', 'q'], description: '退出' },
];

export const MENU_CAP = 8;

export interface MenuCandidate {
  name: string;        // '/model'
  description: string;
}

/**
 * Compute the resident menu candidates for the current input value.
 * Only activates when value starts with '/'; prefix matches win, fuzzy
 * fallback; aliases participate; capped at MENU_CAP (P4-4.1 parity).
 */
export function computeMenuItems(value: string, commands: SlashCommand[] = ZORGE_COMMANDS): MenuCandidate[] {
  const v = String(value ?? '');
  if (!v.startsWith('/')) return [];
  const query = v.slice(1);

  // prefix matches (name + aliases) — exact-prefix priority like Completer
  const prefixed = commands
    .filter((c) => c.name.startsWith(query) || (c.aliases || []).some((a) => a.startsWith(query)))
    .map((c) => ({ name: '/' + c.name, description: c.description || '' }));

  if (prefixed.length > 0) {
    return prefixed.slice(0, MENU_CAP);
  }

  const fuzzy = fuzzyFilter(query, commands.map((c) => ({
    name: c.name,
    aliases: c.aliases || [],
    description: c.description || '',
  })));
  if (fuzzy.length > 0) {
    return fuzzy.slice(0, MENU_CAP).map((c) => ({ name: '/' + c.name, description: c.description || '' }));
  }

  return [];
}

/** Whether the resident menu should be open for the current value. */
export function menuOpenFor(value: string): boolean {
  return String(value ?? '').startsWith('/');
}

/**
 * Move the highlight index, CLAMPED to [0, length-1] (夹紧, per spec).
 * Returns the same index when length is 0.
 */
export function moveMenuIndex(index: number, length: number, dir: 1 | -1): number {
  if (length <= 0) return 0;
  const next = index + dir;
  if (next < 0) return 0;
  if (next >= length) return length - 1;
  return next;
}

/**
 * Pure render helper: the lines to draw for the menu (used by line-mode
 * redraw and by tests). Highlighted item gets an inverse marker '▸'.
 */
export function menuRenderLines(items: MenuCandidate[], index: number): string[] {
  if (items.length === 0) return [];
  const width = Math.max(...items.map((c) => c.name.length));
  return items.map((c, i) => {
    const pad = c.name.padEnd(width);
    const desc = c.description ? `  ${c.description}` : '';
    return i === index ? `▸ ${pad}${desc}` : `  ${pad}${desc}`;
  });
}

// ==================== parameter sub-menu (feat-submenu) ====================

/**
 * Parse a command+argument pattern for the ARGUMENT sub-menu.
 *   '/model'        → null (no trailing space yet — still command menu)
 *   '/model '       → { command:'model', argQuery:'' }
 *   '/model glm-5'  → { command:'model', argQuery:'glm-5' }
 * Returns null when the value is not of the form '/cmd ' (command + space +
 * optional arg) — i.e. plain tasks or a bare command without trailing space.
 */
export function argMenuFor(value: string): { command: string; argQuery: string } | null {
  const v = String(value ?? '');
  if (!v.startsWith('/')) return null;
  // must contain a space AFTER the command (trailing space triggers sub-menu)
  const m = v.match(/^\/([A-Za-z0-9_-]+)(?: (.*))?$/);
  if (!m) return null;
  if (m[2] === undefined) return null; // no trailing space → command menu only
  return { command: m[1], argQuery: (m[2] ?? '').trim() };
}

/**
 * Filter arg candidates by the (case-insensitive) query — prefix match, then
 * substring, then fuzzy (reuse FuzzyMatcher).
 *
 * NOT capped at MENU_CAP: argument lists (e.g. /model's 84 models) must be
 * fully browsable — the FuzzyPicker window scrolls through all items
 * (windowStart/visibleCount). Only the fuzzy fallback stays top-8 (it's a
 * search, not a browse). The COMMAND menu keeps its top-8 (computeMenuItems).
 */
export function filterArgCandidates(query: string, candidates: string[]): string[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return candidates.slice();
  const prefix = candidates.filter((c) => c.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix;
  const sub = candidates.filter((c) => c.toLowerCase().includes(q));
  if (sub.length > 0) return sub;
  return fuzzyFilter(q, candidates.map((c) => ({ name: c, aliases: [], description: '' })))
    .map((c) => c.name)
    .slice(0, MENU_CAP);
}

// ==================== generic picker geometry (picker-gen, CC port) ====================
// Pure helpers mirroring CC design-system/FuzzyPicker's window scrolling.

/** Clamp helper (CC ink geometry clamp). */
export function pickerClamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * CC windowStart: focused item stays visible, window scrolls so it's near the
 * bottom of the visible slice (prevents overflow flicker on every arrow key).
 *
 * fix-picker-4 (①): direction matters —
 *   'down' (CC original): windowStart = focusedIndex - visibleCount + 1
 *          (focused sits at the BOTTOM of the window)
 *   'up'   (atuin, reversed render): windowStart = focusedIndex
 *          (focused sits at the TOP of the natural window, which after the
 *           reversal lands at the BOTTOM — next to the input).
 */
export function pickerWindowStart(
  focusedIndex: number,
  visibleCount: number,
  total: number,
  direction: 'up' | 'down' = 'down'
): number {
  if (total <= 0 || visibleCount <= 0) return 0;
  const maxStart = Math.max(0, total - visibleCount);
  if (direction === 'up') return pickerClamp(focusedIndex, 0, maxStart);
  return pickerClamp(focusedIndex - visibleCount + 1, 0, maxStart);
}

/** Visible slice for the window. */
export function pickerVisible<T>(items: T[], windowStart: number, visibleCount: number): T[] {
  return items.slice(windowStart, windowStart + visibleCount);
}

/**
 * Render order for the visible window. direction='up' (atuin style): items[0]
 * sits at the BOTTOM (closest to the input), so the visible window is rendered
 * reversed. Returns [orderedItems, focusedVisibleIndex, focusedIsVisible].
 */
export function pickerRenderOrder<T>(
  items: T[],
  focusedIndex: number,
  windowStart: number,
  visibleCount: number,
  direction: 'up' | 'down'
): { ordered: T[]; focusedVisibleIndex: number; focusedVisible: boolean } {
  if (items.length === 0) return { ordered: [], focusedVisibleIndex: -1, focusedVisible: false };
  const visible = pickerVisible(items, windowStart, visibleCount);
  const focusedVisible = focusedIndex >= windowStart && focusedIndex < windowStart + visibleCount;
  const focusedInSlice = focusedVisible ? focusedIndex - windowStart : -1;
  if (direction === 'up') {
    // reversed: items[0] at bottom; focused maps to (visible.length-1-focusedInSlice)
    const ordered = [...visible].reverse();
    const fvi = focusedInSlice >= 0 ? visible.length - 1 - focusedInSlice : -1;
    return { ordered, focusedVisibleIndex: fvi, focusedVisible };
  }
  return { ordered: visible, focusedVisibleIndex: focusedInSlice, focusedVisible };
}

/** Step focusedIndex by delta (clamped) — CC step() semantics. */
export function pickerStep(focusedIndex: number, delta: 1 | -1, total: number): number {
  return pickerClamp(focusedIndex + delta, 0, Math.max(0, total - 1));
}

// ==================== mid-line slash trigger (slash-mid, Hermes port) ====================
// Ported from Hermes ui-tui src/domain/slash.ts inlineSlashTrigger.
//
// A `/` means two different things depending on where it sits:
//  - At position 0 it's a COMMAND invocation (^anchored dispatch).
//  - After whitespace it's an inline SKILL/command reference dropped into
//    prose ("clean this up with /clean"). The token ends at the caret.
// Requiring a single bare segment (no second `/`) keeps real paths out:
// `look at /usr/local/bin` and `check src/foo/bar` never match.

const INLINE_SLASH_RE = /\s\/([a-zA-Z][\w-]*)?$/;

/**
 * Locate an inline `/cmd` reference at the END of `text`, or null. `start` is
 * the index of the `/`, so a completion replaces the typed token and leaves
 * the prose in front untouched.
 */
export function inlineSlashTrigger(text: string): { query: string; start: number } | null {
  const t = String(text ?? '');
  const match = INLINE_SLASH_RE.exec(t);
  if (!match) return null;
  const query = match[1] ?? '';
  return { query, start: t.length - query.length - 1 };
}

/** Leading-command trigger: returns the bare command query for `/xxx` at 0. */
export function leadingSlashTrigger(text: string): { query: string; start: number } | null {
  const t = String(text ?? '');
  const m = t.match(/^\/([A-Za-z][\w-]*)?$/);
  if (!m) return null;
  return { query: m[1] ?? '', start: 0 };
}

// ==================== /model two-stage picker (fix-picker-3 ②③) ====================
// Hermes modelPicker stage parity: `/model ` → provider list (stage 1); select
// provider → that provider's model list (stage 2); Enter executes
// `/model <provider>:<model>`.

export interface ProviderOption {
  name: string;
  models: string[];
}

export type ArgStage = 'provider' | 'model' | null;

/**
 * Lenient command+arg parse (fix-picker-4 ③): '/model' (NO trailing space) is
 * still a command candidate — the picker can descend to its arg stage without
 * waiting for a space. Used by the rich picker; argMenuFor (strict trailing
 * space) stays for line-mode/other consumers.
 */
export function parseCommandInput(value: string): { command: string; argQuery: string } | null {
  const v = String(value ?? '');
  const m = v.match(/^\/([A-Za-z0-9_-]+)(?: (.*))?$/);
  if (!m) return null;
  return { command: m[1], argQuery: (m[2] ?? '').trim() };
}

/**
 * Derive the argument-picker stage for a `/model ...` value.
 *   '/model'         → { stage:'provider', provider:null, query:'' }   (③ direct)
 *   '/model '        → { stage:'provider', provider:null, query:'' }
 *   '/model scnet '  → { stage:'model', provider:'scnet', query:'' }
 *   '/model a6:glm-5 ' → { stage:'model', provider:'a6', query:'glm-5' }
 *   '/model xyz' (unknown provider) → { stage:'provider', query:'xyz' }
 */
export function argStageFor(
  value: string,
  providers: ProviderOption[]
): { stage: ArgStage; provider: string | null; query: string } {
  const parsed = parseCommandInput(value);
  if (!parsed || parsed.command !== 'model') return { stage: null, provider: null, query: '' };
  let q = parsed.argQuery;
  // provider:query or provider-name prefix?
  const colon = q.indexOf(':');
  if (colon >= 0) {
    const prov = q.slice(0, colon);
    if (providers.some((p) => p.name === prov)) {
      return { stage: 'model', provider: prov, query: q.slice(colon + 1) };
    }
  }
  const known = providers.find((p) => p.name === q);
  if (known) {
    // '/model scnet ' → model stage for scnet (empty filter)
    return { stage: 'model', provider: q, query: '' };
  }
  return { stage: 'provider', provider: null, query: q };
}

/** Build the executed target line: `/model <provider>:<model>`. */
export function resolveModelTarget(provider: string, model: string): string {
  return `/model ${provider}:${model}`;
}
