// src/cli/repl/Session.ts
// In-memory Session representation (blueprint v1.1)

import type { Tier } from '../../tiers/TierConfig.js';
import type { SessionFile, Turn, SessionSummary, ModelProvider } from './types.js';
import { randomUUID } from 'node:crypto';

export type SessionApprovalMode = 'readonly' | 'default' | 'full';

export class Session {
  public id: string;
  public name?: string;
  public createdAt: number;
  public updatedAt: number;
  public tier: Tier;
  public workspace: string;
  public model: string;
  public provider?: ModelProvider; // P3: injected provider for model resolution
  // M1-2.4: approval state (readonly is the safe default, day one)
  public approvalMode: SessionApprovalMode;
  public sessionApprovalAllowlist: Set<string>;
  // P4-4.7: plan-mode derived state (approvalMode floors to readonly while set)
  public planMode: boolean = false;
  public turns: Turn[] = [];
  public stats = { totalTurns: 0, totalTokens: 0, totalDurationMs: 0 };

  constructor(init?: Partial<SessionFile> & { provider?: ModelProvider }) {
    this.id = init?.id ?? randomUUID();
    this.name = init?.name;
    this.createdAt = init?.createdAt ?? Date.now();
    this.updatedAt = init?.updatedAt ?? Date.now();
    this.tier = (init?.tier ?? 'high') as Tier;
    this.workspace = init?.workspace ?? process.cwd();
    this.model = init?.model ?? 'default';
    this.provider = (init as any)?.provider;
    this.approvalMode = ((init as any)?.approvalMode ?? 'readonly') as SessionApprovalMode;
    this.sessionApprovalAllowlist = new Set<string>((init as any)?.sessionApprovalAllowlist ?? []);
    this.turns = init?.turns ?? [];
    this.stats = init?.stats ?? { totalTurns: 0, totalTokens: 0, totalDurationMs: 0 };
  }

  addTurn(turn: Turn): void {
    this.turns.push(turn);
    this.updatedAt = Date.now();
    this.stats.totalTurns += 1;
    if (turn.result?.budgetReport) {
      this.stats.totalTokens += turn.result.budgetReport.estimatedUsedTokens || 0;
    }
    if (turn.durationMs) {
      this.stats.totalDurationMs += turn.durationMs;
    }
  }

  updateTier(tier: Tier): void {
    this.tier = tier;
    this.updatedAt = Date.now();
  }

  updateWorkspace(path: string): void {
    this.workspace = path;
    this.updatedAt = Date.now();
  }

  updateModel(model: string): void {
    this.model = model;
    this.updatedAt = Date.now();
  }

  // M1-2.4: approval helpers
  updateApprovalMode(mode: SessionApprovalMode): void {
    this.approvalMode = mode;
    this.updatedAt = Date.now();
  }

  allowToolForSession(tool: string): void {
    this.sessionApprovalAllowlist.add(String(tool || '').toLowerCase());
    this.updatedAt = Date.now();
  }

  // P4-4.7: plan-mode helpers
  setPlanMode(on: boolean): void {
    this.planMode = on;
    // plan floors the approval mode to readonly for defense in depth;
    // leaving plan restores whatever the ring maps to (caller sets it).
    if (on) this.approvalMode = 'readonly';
    this.updatedAt = Date.now();
  }

  clearApprovalAllowlist(): void {
    this.sessionApprovalAllowlist.clear();
    this.updatedAt = Date.now();
  }

  toFile(): SessionFile {
    return {
      schemaVersion: 1,
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      tier: this.tier,
      workspace: this.workspace,
      model: this.model,
      approvalMode: this.approvalMode,
      sessionApprovalAllowlist: [...this.sessionApprovalAllowlist],
      turns: this.turns,
      stats: { ...this.stats },
    };
  }

  static fromFile(file: SessionFile): Session {
    return new Session(file);
  }

  getSummary(): SessionSummary {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      tier: this.tier,
      workspace: this.workspace,
      turnCount: this.turns.length,
    };
  }
}
