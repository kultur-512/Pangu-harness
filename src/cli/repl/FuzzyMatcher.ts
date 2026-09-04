// src/cli/repl/FuzzyMatcher.ts
// 零依赖的 slash 命令模糊匹配。
//
// Score (0..1, higher = better):
//   prefix hit            → 1.0 (exact prefix of the candidate)
//   substring hit         → 0.8 - offset penalty (earlier = better)
//   subsequence match     → 0.4..0.7 based on contiguity + coverage
//   alias match           → same rules, slightly discounted (×0.95)
// Ties resolve stably by input order. Top 8 returned via fuzzyFilter.

export interface FuzzyCandidate {
  name: string;
  aliases?: string[];
  description?: string;
}

/** Longest-common-subsequence length (small inputs only — slash commands). */
function lcsLength(a: string, b: string): number {
  const w = b.length + 1;
  const table = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j]
        ? table[(i + 1) * w + (j + 1)] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
    }
  }
  return table[0];
}

/** Score `query` against one candidate string. 0 = no match. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = String(query || '').toLowerCase().trim();
  const c = String(candidate || '').toLowerCase().trim();
  if (!q) return 1; // empty query matches everything (ranked by order)
  if (!c) return 0;

  // Exact / prefix
  if (c === q) return 1;
  if (c.startsWith(q)) return 0.98;

  // Substring: earlier is better
  const idx = c.indexOf(q);
  if (idx !== -1) {
    return Math.max(0.6, 0.8 - idx * 0.01);
  }

  // Subsequence (in order, not necessarily contiguous)
  const lcs = lcsLength(q, c);

  // Half-length tolerance: allows abbreviation-ish queries like `/tl` → tier
  // (t…l across the word with one interior miss). Sits BELOW the subsequence
  // tier so real subsequences always outrank it. A first-char alignment bonus
  // breaks ties toward candidates starting like the query (tier over help).
  if (lcs >= Math.ceil(q.length / 2)) {
    return 0.35 + (c[0] === q[0] ? 0.05 : 0);
  }
  if (lcs < q.length) return 0; // not every query char present in order

  // Contiguity bonus: longest run of directly consecutive matches
  let run = 0;
  let bestRun = 0;
  let i = 0;
  for (let j = 0; j < c.length && i < q.length; j++) {
    if (q[i] === c[j]) {
      i++;
      run++;
      if (run > bestRun) bestRun = run;
    } else {
      run = 0;
    }
  }
  const coverage = lcs / c.length;
  const contiguity = bestRun / q.length;
  const score = 0.4 + coverage * 0.2 + contiguity * 0.1;
  return Math.min(0.59, score); // subsequence must stay below substring tier
}

/** Filter + rank candidates. Exact-prefix beats substring beats subsequence. */
export function fuzzyFilter(query: string, items: FuzzyCandidate[]): FuzzyCandidate[] {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return items.slice(); // empty query: everything, registration order (no top-8 cap)
  const scored: Array<{ item: FuzzyCandidate; score: number; matched: string }> = [];

  for (const item of items) {
    const names = [item.name, ...(item.aliases || [])];
    let best = 0;
    let bestIsAlias = false;
    for (let n = 0; n < names.length; n++) {
      const s = fuzzyScore(q, names[n]);
      const discounted = n > 0 ? s * 0.95 : s;
      if (discounted > best) {
        best = discounted;
        bestIsAlias = n > 0;
      }
    }
    // Description keywords give a weak tail signal (substring only).
    if (best === 0 && item.description && q.length >= 2) {
      const d = item.description.toLowerCase();
      if (d.includes(q)) best = 0.3;
    }
    if (best > 0) {
      scored.push({ item, score: bestIsAlias ? best * 0.97 : best, matched: item.name });
    }
  }

  // Stable sort: score desc, then original order.
  const ranked = scored
    .map((s, order) => ({ ...s, order }))
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .slice(0, 8);

  return ranked.map((r) => r.item);
}

// ==================== description-aware search (fuzzy-desc) ====================
// Ported from Hermes ui-tui src/app/slash/fuzzyScore.ts (itself a grok-cli
// port): candidates score in tiers — exact on id/label/alias (0), prefix (1),
// substring (2) — and the DESCRIPTION text is tokenized and matched at a +3
// offset (exact word 3, word prefix 4, word substring 5). Typing `/summary`
// surfaces a command whose description mentions summaries even though no
// command name starts with it. LOWER score wins; Infinity = no match.
// An empty query returns items untouched (browsing keeps caller order).

export interface SlashScoreItem {
  id: string;
  label?: string;
  aliases?: string[];
  description?: string;
}

/** Lowercase + alphanumeric word tokens (first entry is the full text). */
export function tokenizeSearchText(value: string): string[] {
  const normalized = String(value ?? '').toLowerCase();
  return [normalized, ...normalized.split(/[^a-z0-9]+/).filter(Boolean)];
}

/** Trim, drop leading slashes, lowercase — `/Model ` and `model` score alike. */
export function normalizeSlashSearchQuery(query: string): string {
  return String(query ?? '').trim().replace(/^\/+/, '').toLowerCase();
}

/** Index cache: tokenized fields per item, keyed by item object identity. */
const slashTokenCache = new WeakMap<object, { command: string[]; description: string[] }>();

function cachedTokens(item: SlashScoreItem): { command: string[]; description: string[] } {
  let c = slashTokenCache.get(item as object);
  if (!c) {
    c = {
      command: [item.id, item.label ?? '', ...(item.aliases ?? [])].filter(Boolean).flatMap(tokenizeSearchText),
      description: tokenizeSearchText(item.description ?? ''),
    };
    slashTokenCache.set(item as object, c);
  }
  return c;
}

function scoreFields(fields: string[], query: string, offset: number): number {
  for (const f of fields) {
    if (f === query || `/${f}` === query) return offset;
  }
  for (const f of fields) {
    if (f.startsWith(query) || `/${f}`.startsWith(query)) return offset + 1;
  }
  for (const f of fields) {
    if (f.includes(query)) return offset + 2;
  }
  return Number.POSITIVE_INFINITY;
}

/** Score one item against a normalized query. Lower is better; Infinity = no match. */
export function scoreSlashMenuItem(item: SlashScoreItem, query: string): number {
  const { command, description } = cachedTokens(item);
  return Math.min(scoreFields(command, query, 0), scoreFields(description, query, 3));
}

/** Filter + stable-sort items by score (then original order). */
export function rankSlashCandidates<T>(items: T[], query: string, toScoreItem: (item: T) => SlashScoreItem): T[] {
  const normalized = normalizeSlashSearchQuery(query);
  if (!normalized) return items.slice();
  return items
    .map((item, index) => ({ index, item, score: scoreSlashMenuItem(toScoreItem(item), normalized) }))
    .filter((e) => e.score !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((e) => e.item);
}
