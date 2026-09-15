// src/cli/repl/Session.ts
// In-memory Session representation (blueprint v1.1)

import { TierRegistry } from '../../tiers/TierConfig.js';
import type { Tier } from '../../tiers/TierConfig.js';
import type { SessionFile, Turn, SessionSummary, ModelProvider } from './types.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SessionApprovalMode = 'readonly' | 'default' | 'full';

/**
 * 读取项目配置 `.panshalach.json` 的 approvalAllowlist（'a' 决策
 * 的持久化形态，写入端在 engineAdapter）。best-effort：文件缺失/损坏/字段非法
 * 一律返回 []，绝不阻塞会话启动。
 */
function loadProjectApprovalAllowlist(workspace: string): string[] {
  try {
    const p = join(workspace || process.cwd(), '.panshalach.json');
    if (!existsSync(p)) return [];
    let text = readFileSync(p, 'utf-8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const j = JSON.parse(text.trim());
    const list = j?.approvalAllowlist;
    return Array.isArray(list) ? list.filter((x: unknown) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

/**
 * M2-7：turn 角色推断（迁移标注的唯一权威规则）——
 * task/multiline 类入口是用户指令 → 'user'；其余（command 类：压缩合成轮等）
 * 是助手侧产物 → 'assistant'。仅当 role 缺失时使用（显式 role 优先）。
 */
export function inferTurnRole(turn: Turn): 'user' | 'assistant' {
  return turn.userInputType === 'task' || turn.userInputType === 'multiline' ? 'user' : 'assistant';
}

export class Session {
  public id: string;
  public name?: string;
  public createdAt: number;
  public updatedAt: number;
  public tier: Tier;
  public workspace: string;
  public model: string;
  public currentTaskId?: string;
  public provider?: ModelProvider; // injected provider for model resolution
  // approval state (readonly is the safe default, day one)
  public approvalMode: SessionApprovalMode;
  public sessionApprovalAllowlist: Set<string>;
  // plan-mode derived state (approvalMode floors to readonly while set)
  public planMode: boolean = false;
  public turns: Turn[] = [];
  public stats = { totalTurns: 0, totalTokens: 0, totalDurationMs: 0 };

  constructor(init?: Partial<SessionFile> & { provider?: ModelProvider }) {
    this.id = init?.id ?? randomUUID();
    this.name = init?.name;
    this.createdAt = init?.createdAt ?? Date.now();
    this.updatedAt = init?.updatedAt ?? Date.now();
    this.tier = TierRegistry.normalize(init?.tier);
    this.workspace = init?.workspace ?? process.cwd();
    this.model = init?.model ?? 'default';
    this.currentTaskId = (init as any)?.currentTaskId;
    this.provider = (init as any)?.provider;
    this.approvalMode = ((init as any)?.approvalMode ?? 'readonly') as SessionApprovalMode;
    // 会话启动时把项目配置持久化的 'a' 决策并入放行清单
    //（显式传入的 init.sessionApprovalAllowlist 优先保留，两者取并集）。
    this.sessionApprovalAllowlist = new Set<string>([
      ...((init as any)?.sessionApprovalAllowlist ?? []),
      ...loadProjectApprovalAllowlist(this.workspace),
    ]);
    this.turns = init?.turns ?? [];
    // M2-7：会话文件/init 组装点迁移标注——旧数据无 role 时按现状推断（显式 role 优先）。
    for (const t of this.turns) t.role ??= inferTurnRole(t);
    this.stats = init?.stats ?? { totalTurns: 0, totalTokens: 0, totalDurationMs: 0 };
  }

  addTurn(turn: Turn): void {
    // M2-7：turn 构造标注——所有 addTurn 调用方（TurnController/Repl/RunCommand/replay）
    // 经此迁移：task/multiline → 'user'，command（压缩合成轮等）→ 'assistant'。
    // 原对象就地标注（幂等），使 TurnController 随后 appendTurn 的同一对象携带 role。
    turn.role ??= inferTurnRole(turn);
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

  // approval helpers
  updateApprovalMode(mode: SessionApprovalMode): void {
    this.approvalMode = mode;
    this.updatedAt = Date.now();
  }

  allowToolForSession(tool: string): void {
    this.sessionApprovalAllowlist.add(String(tool || '').toLowerCase());
    this.updatedAt = Date.now();
  }

  // plan-mode helpers
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
      currentTaskId: this.currentTaskId,
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
