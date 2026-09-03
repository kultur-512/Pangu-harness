// src/cli/repl/typeahead.ts
// cc-typeahead: unified typeahead suggestion engine (CC useTypeahead port).
// One source of truth for in-line suggestions while typing — commands,
// providers/models, files/directories and history all flow through
// generateSuggestions. PURE (testable): files come via ctx.files callback so
// the engine never touches the FS itself; everything else is local data.

import { ZORGE_COMMANDS, type ProviderOption, parseCommandInput, argStageFor, filterArgCandidates, type SlashCommand } from './SlashPicker.js';
import { rankSlashCandidates } from './FuzzyMatcher.js';

export type SuggestionType = 'command' | 'file' | 'directory' | 'path' | 'model' | 'provider' | 'history';

export interface SuggestionItem {
  id: string;            // stable id — preserved across suggestion-set changes
  type: SuggestionType;
  displayText: string;
  replacement: string;   // what Tab inserts
  description?: string;
  metadata?: any;        // e.g. { provider, model } for execution
}

export interface TypeaheadContext {
  commands?: SlashCommand[];
  workspace?: string;
  providers: ProviderOption[];
  history?: string[];
  /** File/directory candidates (caller injects; keeps the engine pure). */
  files?: string[];
}

function cmdSuggestion(c: { name: string; description?: string }): SuggestionItem {
  return { id: 'cmd:' + c.name, type: 'command', displayText: '/' + c.name, replacement: '/' + c.name + ' ', description: c.description || '' };
}

/** Build the suggestion set for the current input + cursor. All local/sync. */
export function generateSuggestions(input: string, cursorOffset: number, ctx: TypeaheadContext): SuggestionItem[] {
  const v = String(input ?? '');
  const commands = ctx.commands ?? ZORGE_COMMANDS;
  const providers = ctx.providers ?? [];

  // 1. leading '/' → command or provider/model suggestions (CC direct descent)
  if (v.startsWith('/')) {
    const parsedCmd = parseCommandInput(v);
    if (parsedCmd && parsedCmd.command === 'model') {
      const stage = argStageFor(v, providers);
      if (stage.stage === 'model' && stage.provider) {
        const prov = providers.find((p) => p.name === stage.provider);
        const models = prov?.models ?? [];
        return filterArgCandidates(stage.query, models).map((m) => ({
          id: 'model:' + stage.provider + ':' + m,
          type: 'model' as const,
          displayText: m,
          replacement: `/model ${stage.provider}:${m}`,
          metadata: { provider: stage.provider, model: m },
        }));
      }
      // provider stage (also for bare '/model' — CC direct descent)
      const all: SuggestionItem[] = providers.map((p) => ({
        id: 'provider:' + p.name,
        type: 'provider' as const,
        displayText: p.name,
        replacement: `/model ${p.name} `,
        metadata: { provider: p.name },
      }));
      const filtered = filterArgCandidates(stage.query, providers.map((p) => p.name))
        .filter((n) => !providers.some((p) => p.name === n))
        .map((n) => ({ id: 'provider:' + n, type: 'provider' as const, displayText: n, replacement: `/model ${n} `, metadata: { provider: n } }));
      return all.concat(filtered);
    }
    return rankSlashCandidates(commands, v.slice(1), (c) => ({
      id: c.name, label: c.name, aliases: c.aliases || [], description: c.description || '',
    })).map(cmdSuggestion);
  }

  // 2. '@' or path-like → file/directory suggestions (caller-provided list)
  const at = v.indexOf('@');
  if (at >= 0 || v.startsWith('.') || v.startsWith('/') || /[\\/]$/.test(v)) {
    const files = ctx.files ?? [];
    const base = at >= 0 ? v.slice(at + 1) : v;
    return files
      .filter((f) => f.toLowerCase().includes(base.toLowerCase()))
      .slice(0, 12)
      .map((f) => ({
        id: 'file:' + f,
        type: (f.endsWith('/') ? 'directory' : 'file') as SuggestionType,
        displayText: f,
        replacement: (at >= 0 ? v.slice(0, at + 1) : '') + f,
      }));
  }

  // 3. plain text → history suggestions (best-effort prefix match)
  const hist = (ctx.history ?? []).filter((h) => h.toLowerCase().startsWith(v.toLowerCase()) && h !== v);
  return hist.slice(0, 8).map((h) => ({
    id: 'hist:' + h,
    type: 'history' as const,
    displayText: h,
    replacement: h,
  }));
}

/**
 * CC ghost text: the remainder of the best suggestion after the typed text.
 * For '/mo' with best '/model' → 'del'. Returns '' when no suggestion applies.
 */
export function ghostTextFor(input: string, suggestions: SuggestionItem[]): string {
  const v = String(input ?? '');
  const best = suggestions[0];
  if (!best) return '';
  const repl = best.replacement;
  // command suggestions replace the leading '/…' — ghost = remainder after typed query
  if (best.type === 'command' && v.startsWith('/')) {
    const typed = v.slice(1);
    const name = repl.slice(1).trimEnd();
    if (name.toLowerCase().startsWith(typed.toLowerCase())) return name.slice(typed.length);
    return '';
  }
  if (v.endsWith(' ')) return ''; // explicit space → user is browsing, no ghost
  if (repl.toLowerCase().startsWith(v.toLowerCase())) return repl.slice(v.length);
  return '';
}

/**
 * CC getPreservedSelection: when the suggestion set changes, keep the
 * previously selected item selected by id when possible (0 otherwise).
 */
export function getPreservedSelection(suggestions: SuggestionItem[], prevSelectedId: string | null): number {
  if (!prevSelectedId || suggestions.length === 0) return 0;
  const idx = suggestions.findIndex((s) => s.id === prevSelectedId);
  return idx >= 0 ? idx : 0;
}

/** Move the selection by delta (clamped) — CC arrow semantics. */
export function moveSelection(index: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  const next = index + delta;
  if (next < 0) return 0;
  if (next >= length) return length - 1;
  return next;
}

/** Tab accepts the selected suggestion → replacement for the input. */
export function acceptSuggestion(_input: string, suggestion: SuggestionItem): string {
  return suggestion.replacement;
}

/**
 * T-29: 双 Esc 状态机（与 UI 的 suggestionsDismissed 解耦）——
 * 300ms 内第二次 Esc → isDouble（清空输入/队列）；否则仅记录计时。
 */
export function doubleEscState(now: number, lastEsc: number): { isDouble: boolean; nextLastEsc: number } {
  if (now - lastEsc < 300) return { isDouble: true, nextLastEsc: 0 };
  return { isDouble: false, nextLastEsc: now };
}
