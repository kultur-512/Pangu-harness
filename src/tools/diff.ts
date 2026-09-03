// src/tools/diff.ts
// M1-2.3: zero-dependency line diff (LCS on trimmed middle, structured hunks).
// - CRLF normalized to \n on split (output keeps \n)
// - new file → all 'add'; deleted file → all 'del'
// - contextLines (default 3) of 'ctx' around change runs
// - guard rail: if the changed middle exceeds the DP budget after
//   prefix/suffix trimming, fall back to a coarse replace-block diff
//   (correctness first, minimal-memory second).

import type { DiffHunk } from './types.js';

const DP_BUDGET = 1500; // per-side line cap for the O(n*m) LCS table

function splitLines(text: string): string[] {
  if (text === '') return [];
  const norm = text.replace(/\r\n/g, '\n');
  const lines = norm.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsMatrix(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j]
        ? table[(i + 1) * w + (j + 1)] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
    }
  }
  return table;
}

interface RawOp { type: 'ctx' | 'add' | 'del'; text: string }

function diffOps(a: string[], b: string[]): RawOp[] {
  // Trim common prefix/suffix so the DP table stays small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const ops: RawOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'ctx', text: a[i] });

  if (midA.length === 0 && midB.length === 0) {
    // identical middle (can happen with trailing-only differences)
  } else if (midA.length > DP_BUDGET || midB.length > DP_BUDGET) {
    // Coarse fallback: full replace of the middle
    for (const l of midA) ops.push({ type: 'del', text: l });
    for (const l of midB) ops.push({ type: 'add', text: l });
  } else if (midA.length === 0) {
    for (const l of midB) ops.push({ type: 'add', text: l });
  } else if (midB.length === 0) {
    for (const l of midA) ops.push({ type: 'del', text: l });
  } else {
    const table = lcsMatrix(midA, midB);
    const w = midB.length + 1;
    let i = 0, j = 0;
    const back: RawOp[] = [];
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        back.push({ type: 'ctx', text: midA[i] });
        i++; j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
        back.push({ type: 'del', text: midA[i] });
        i++;
      } else {
        back.push({ type: 'add', text: midB[j] });
        j++;
      }
    }
    while (i < midA.length) { back.push({ type: 'del', text: midA[i++] }); }
    while (j < midB.length) { back.push({ type: 'add', text: midB[j++] }); }
    ops.push(...back);
  }

  for (let k = endA; k < a.length; k++) ops.push({ type: 'ctx', text: a[k] });
  return ops;
}

/** Collapse runs of ctx lines into contextLines windows around changes. */
function foldContext(ops: RawOp[], contextLines: number): DiffHunk[] {
  if (contextLines < 0) contextLines = 0;

  // Mark which ctx ops are near a change (within contextLines).
  const keep = new Array<boolean>(ops.length).fill(false);
  let lastChange = -Infinity;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'ctx') {
      for (let k = Math.max(0, i - contextLines); k <= Math.min(ops.length - 1, i + contextLines); k++) {
        keep[k] = true;
      }
      lastChange = i;
    }
  }

  const out: DiffHunk[] = [];
  let skipping = false;
  let skipped = 0;

  const flushSkip = () => {
    // dogfood-T1: at contextLines=0 the caller asked for ZERO context —
    // skipped runs emit NOTHING (a fold marker is context noise there).
    if (skipping) {
      if (contextLines !== 0) {
        out.push({ type: 'ctx', text: `… ${skipped} 行省略 …` });
      }
      skipping = false;
      skipped = 0;
    }
  };

  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'ctx' || keep[i]) {
      flushSkip();
      out.push({ type: ops[i].type, text: ops[i].text });
    } else {
      skipping = true;
      skipped++;
    }
  }
  flushSkip();
  return out;
}

/**
 * Structured line diff between old and new text.
 * Rendering (+/− coloring, folding) is the caller's (ToolCard's) job.
 *
 * dogfood-T7: optional `maxHunks` (default 5) caps the hunk count. The cap
 * counts CHANGE hunks (add/del) only — context lines never consume the budget.
 * When exceeded, the MIDDLE changes collapse into a single ctx marker while
 * head and tail changes stay visible. A full-file replace (no context at all,
 * e.g. the coarse DP-budget fallback) is EXEMPT: collapsing 5995 changed lines
 * into a marker would destroy the information the caller needs.
 */
export function computeLineDiff(oldText: string, newText: string, contextLines = 3, maxHunks = 5): DiffHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return b.map((l) => ({ type: 'add' as const, text: l }));   // new file
  if (b.length === 0) return a.map((l) => ({ type: 'del' as const, text: l }));   // deleted file

  const hunks = foldContext(diffOps(a, b), contextLines);
  if (maxHunks <= 0) return hunks;

  const changes = hunks.filter((h) => h.type !== 'ctx');
  if (changes.length <= maxHunks) return hunks;
  // Full-file replace (e.g. coarse fallback): no ctx at all → never cap.
  if (hunks.every((h) => h.type !== 'ctx')) return hunks;

  // Collapse the middle changes, keep head + tail (ctx around them stays)
  const head = Math.ceil(maxHunks / 2);
  const tail = maxHunks - head;
  let seen = 0;
  let headEndIdx = -1;
  let tailStartIdx = -1;
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i].type !== 'ctx') {
      seen++;
      if (seen === head) headEndIdx = i;
      if (seen === changes.length - tail + 1) { tailStartIdx = i; break; }
    }
  }
  const omitted = changes.length - head - tail;
  const middleStart = Math.min(headEndIdx + 1, tailStartIdx);
  return [
    ...hunks.slice(0, middleStart),
    { type: 'ctx' as const, text: `… ${omitted} hunks omitted …` },
    ...hunks.slice(tailStartIdx),
  ];
}
