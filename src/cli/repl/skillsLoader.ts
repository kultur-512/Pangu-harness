// src/cli/repl/skillsLoader.ts
// P5-5.1: skills directory convention — user-level ~/.zorge/skills/<name>/SKILL.md
// plus project-level <workspace>/.zorge/skills/<name>/SKILL.md (project wins on
// same-name collisions). Loaded once per task build and injected into the
// prompt when the task matches a skill's triggers/description.
//
// Security: skill directory names are restricted to [a-z0-9-] to prevent path
// traversal; unparseable frontmatter → skill skipped with a warning (never a
// crash). Pure logic — testable under SMOKE with no TTY.

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  source: 'user' | 'project';
  path: string;
}

export const SKILL_NAME_RE = /^[a-z0-9-]+$/;
export const MAX_SKILL_CHARS = 2000;
export const MAX_MATCHED_SKILLS = 3;

/** Parse a SKILL.md into { meta, content }. Returns null on failure. */
export function parseSkillMarkdown(raw: string): { name?: string; description?: string; triggers: string[]; content: string } | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  if (!lines[0]?.trim().startsWith('---')) return null;

  let i = 1;
  const meta: Record<string, string> = {};
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---') break;
    if (t.startsWith('---')) break;
    const m = t.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  if (i >= lines.length) return null; // unclosed frontmatter

  const content = lines.slice(i + 1).join('\n').trim();

  let triggers: string[] = [];
  const t = meta.triggers || '';
  if (t) {
    // [a, b, c] or "a, b, c"
    const inner = t.replace(/^\[|\]$/g, '');
    triggers = inner.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  }

  return {
    name: meta.name || undefined,
    description: meta.description || '',
    triggers,
    content,
  };
}

/** Read + parse one skill directory. Returns null on any failure (warn by caller). */
function loadSkillFromDir(dir: string, name: string, source: 'user' | 'project'): Skill | null {
  if (!SKILL_NAME_RE.test(name)) return null;
  const mdPath = path.join(dir, name, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(mdPath, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseSkillMarkdown(raw);
  if (!parsed) return null;
  return {
    name: parsed.name || name,
    description: parsed.description || '',
    triggers: parsed.triggers,
    content: parsed.content,
    source,
    path: mdPath,
  };
}

function listSkillDirs(root: string): string[] {
  if (!root || !fs.existsSync(root)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((e) => SKILL_NAME_RE.test(e));
}

/**
 * Scan user + project skill directories. Project wins on same-name collision.
 * Returns [] when no skills exist (never throws).
 */
export function loadSkills(workspaceRoot: string): Skill[] {
  // Test hook: ZORGE_SKILLS_USER overrides the user-level root (pure FS logic).
  const userRoot = process.env.ZORGE_SKILLS_USER || path.join(os.homedir(), '.zorge', 'skills');
  const projectRoot = path.join(workspaceRoot || '', '.zorge', 'skills');

  const byName = new Map<string, Skill>();

  // user first, project overrides
  for (const name of listSkillDirs(userRoot)) {
    const s = loadSkillFromDir(userRoot, name, 'user');
    if (s) byName.set(s.name, s);
  }
  for (const name of listSkillDirs(projectRoot)) {
    const s = loadSkillFromDir(projectRoot, name, 'project');
    if (s) byName.set(s.name, s);
  }

  return Array.from(byName.values());
}

/**
 * Match skills against a task: hit when the task contains ANY trigger
 * (case-insensitive) or, lacking triggers, a description keyword. Capped at
 * MAX_MATCHED_SKILLS, content truncated to MAX_SKILL_CHARS.
 */
export function matchSkills(skills: Skill[], task: string): Skill[] {
  const t = String(task || '').toLowerCase();
  const hits: Skill[] = [];
  for (const s of skills) {
    let matched = false;
    for (const tr of s.triggers) {
      if (tr && t.includes(tr.toLowerCase())) {
        matched = true;
        break;
      }
    }
    if (!matched && s.triggers.length === 0 && s.description) {
      // Lenient CJK-friendly keyword match: any 2-char window of the
      // description (whitespace/punct stripped) that appears in the task.
      const compact = s.description.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      let win = '';
      for (const ch of compact) {
        win = (win + ch).slice(-2);
        if (win.length === 2 && t.includes(win)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) hits.push(s);
    if (hits.length >= MAX_MATCHED_SKILLS) break;
  }
  return hits;
}

/** Truncate a skill body for injection (≤ MAX_SKILL_CHARS, with ellipsis). */
export function truncateSkillContent(content: string): string {
  if (!content) return '';
  return content.length > MAX_SKILL_CHARS ? content.slice(0, MAX_SKILL_CHARS) + '…' : content;
}
