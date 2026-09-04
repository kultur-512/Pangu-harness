// src/cli/repl/Completer.ts
// Simple prefix-based completer for ZIS + real filesystem path completion for @ tokens
// 模糊兜底 — 精确前缀最优先；无前缀命中时
// prefix-matches, fuzzyFilter ranks commands (e.g. `/tl` → `/tier`).

import type { CommandRegistry } from './CommandRegistry.js';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, sep } from 'node:path';
import { fuzzyFilter } from './FuzzyMatcher.js';

export class Completer {
  constructor(
    private registry: CommandRegistry,
    private getWorkspace: () => string = () => process.cwd()
  ) {}

  complete(line: string): [string[], string] {
    const trimmed = line;

    // Slash command completion
    if (trimmed.startsWith('/')) {
      const prefix = trimmed.slice(1);
      const cmds = this.registry.list();
      const matches = cmds
        .filter(c => c.name.startsWith(prefix) || (c.aliases || []).some((a: string) => a.startsWith(prefix)))
        .map(c => '/' + c.name);

      if (matches.length > 0) {
        return [matches, '/' + prefix];
      }

      // 对 name + aliases 做模糊兜底
      const fuzzy = fuzzyFilter(prefix, cmds.map((c: any) => ({
        name: c.name,
        aliases: (c.aliases || []) as string[],
        description: (c.description || '') as string,
      })));
      if (fuzzy.length > 0) {
        return [fuzzy.map(f => '/' + f.name), '/' + prefix];
      }
      return [[], '/' + prefix];
    }

    // @path or path-like completion (relative to workspace)
    // Detect last token that looks like a path
    const lastTokenMatch = trimmed.match(/([^\s]*)$/);
    const last = lastTokenMatch ? lastTokenMatch[1] : '';
    if (this.looksLikePath(last)) {
      const ws = this.getWorkspace();
      const results = this.completePath(ws, last);
      if (results.length > 0) {
        // Replace only the last token
        const before = trimmed.slice(0, trimmed.length - last.length);
        // Return suggestions with the prefix they complete against
        return [results.map(r => before + r), last];
      }
    }

    // Default: suggest common task starters
    const suggestions = ['run ', 'simulate ', 'review '];
    const matches = suggestions.filter(s => s.startsWith(trimmed.toLowerCase()));
    return [matches, trimmed];
  }

  private looksLikePath(token: string): boolean {
    if (!token) return false;
    if (token.startsWith('@')) return true;
    if (token.includes('/') || token.includes('\\') || token.startsWith('.') || token.includes('.')) return true;
    return false;
  }

  private completePath(workspace: string, token: string): string[] {
    // token may be "@src/foo" or "./src/foo" or "src/foo" or "package"
    let searchRoot = workspace;
    let prefix = token;

    if (prefix.startsWith('@')) {
      prefix = prefix.slice(1); // drop @
    }

    // Determine directory to list and the filter prefix
    let dirToList = searchRoot;
    let filter = '';

    if (prefix.includes('/') || prefix.includes('\\')) {
      const lastSlash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
      const dirPart = prefix.slice(0, lastSlash + 1);
      filter = prefix.slice(lastSlash + 1);
      dirToList = join(searchRoot, dirPart);
    } else {
      filter = prefix;
      dirToList = searchRoot;
    }

    if (!existsSync(dirToList)) return [];

    let entries: string[] = [];
    try {
      entries = readdirSync(dirToList);
    } catch {
      return [];
    }

    const out: string[] = [];
    for (const e of entries) {
      if (!filter || e.toLowerCase().startsWith(filter.toLowerCase())) {
        let fullRel = join(dirToList, e);
        // make it relative to workspace for display
        let display = fullRel.startsWith(searchRoot)
          ? fullRel.slice(searchRoot.length).replace(/^[/\\]/, '')
          : e;

        try {
          const st = statSync(fullRel);
          if (st.isDirectory()) display += '/';
        } catch {}

        // Restore @ if original token had it
        const hadAt = token.startsWith('@');
        const suggestion = hadAt ? '@' + display : display;
        out.push(suggestion);
      }
    }

    // Sort directories first then files (rough)
    out.sort((a, b) => {
      const ad = a.endsWith('/');
      const bd = b.endsWith('/');
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
      return a.localeCompare(b);
    });

    return out.slice(0, 20); // cap
  }
}
