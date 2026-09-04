// src/cli/repl/SessionStore.ts
// Persistence for Session (blueprint v1.1)
// Stores sessions under ~/.panshalach/sessions/<id>.json

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionFile, SessionSummary } from './types.js';
import { Session } from './Session.js';

const DEFAULT_DIR = join(homedir(), '.panshalach', 'sessions');

export class SessionStore {
  private dir: string;
  private ensured = false;

  constructor(dir?: string) {
    this.dir = dir || DEFAULT_DIR;
    // Do NOT mkdir here. Defer to first use to avoid side-effects at import/construction time
    // and to be robust in sandboxed or permission-restricted environments.
  }

  private ensureDir(): void {
    if (this.ensured) return;
    if (!existsSync(this.dir)) {
      try {
        mkdirSync(this.dir, { recursive: true });
      } catch {
        // Best effort; subsequent save/load will handle missing dir gracefully
      }
    }
    this.ensured = true;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  save(session: Session): void {
    this.ensureDir();
    const file: SessionFile = session.toFile();
    writeFileSync(this.pathFor(file.id), JSON.stringify(file, null, 2), 'utf-8');
  }

  load(id: string): Session | null {
    const p = this.pathFor(id);
    if (!existsSync(p)) return null;
    try {
      const data = readFileSync(p, 'utf-8');
      const file: SessionFile = JSON.parse(data);
      return Session.fromFile(file);
    } catch {
      return null;
    }
  }

  list(): SessionSummary[] {
    this.ensureDir();
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'));
    const summaries: SessionSummary[] = [];
    for (const f of files) {
      try {
        const data = readFileSync(join(this.dir, f), 'utf-8');
        const sf: SessionFile = JSON.parse(data);
        summaries.push({
          id: sf.id,
          name: sf.name,
          createdAt: sf.createdAt,
          updatedAt: sf.updatedAt,
          tier: sf.tier,
          workspace: sf.workspace,
          turnCount: sf.turns.length,
        });
      } catch {}
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    this.ensureDir();
    const p = this.pathFor(id);
    if (existsSync(p)) unlinkSync(p);
  }

  getDir(): string {
    return this.dir;
  }
}
