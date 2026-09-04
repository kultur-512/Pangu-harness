// src/cli/repl/projectInstructions.ts
// /init closed loop (learn P0-2): the /init command writes .panshalach/AGENTS.md
// (directory page + verification commands). This module reads it BACK so the
// PromptBuilder can inject the project's concrete verification commands into
// the task prompt — the model no longer has to guess how to verify.
//
// Extraction rule: take the "## Verification commands" section verbatim
// (checklist lines), cap it at a bounded size. Missing/malformed → null.

import fs from 'node:fs';
import path from 'node:path';

const MAX_BLOCK_CHARS = 1200;
const MAX_LINES = 40;

export function agentsPath(workspace: string | undefined): string {
  return path.join(workspace || process.cwd(), '.panshalach', 'AGENTS.md');
}

export function readProjectVerificationBlock(workspace: string | undefined): string | null {
  const p = agentsPath(workspace);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  let sawChecklist = false;

  for (const line of lines) {
    const t = line.trim();
    if (/^##\s+Verification commands/i.test(t)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(t)) {
      break; // next section ends the block
    }
    if (!inSection) continue;

    // Keep the checklist body (and any plain command lines).
    if (/^\s*[-*]\s+/.test(t) || /^\s*(?:npm|npx|yarn|pnpm|bun|node|python|pytest|go|cargo|make|tsc|vitest|jest)\b/i.test(t)) {
      if (out.length < MAX_LINES) {
        out.push(t.replace(/^\s*[-*]\s+/, ''));
        if (/\[ \]|\[x\]/i.test(t)) sawChecklist = true;
      }
    }
  }

  if (out.length === 0) return null;

  let block = out.join('\n');
  if (block.length > MAX_BLOCK_CHARS) {
    block = block.slice(0, MAX_BLOCK_CHARS) + '\n…（已截断，详见 .panshalach/AGENTS.md）';
  }
  // Tell the model these are the project's OWN verification commands.
  const header = sawChecklist
    ? '（以下为项目清单项，完成后勾选 [x] 并把真实输出作为证据）'
    : '';
  return header ? `${header}\n${block}` : block;
}
