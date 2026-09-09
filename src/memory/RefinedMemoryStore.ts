// Panshalach 提炼后持久化存储
// 功能：提炼 / 加载 / 过滤 / 容量控制 / 衰减 / .gitignore 默认加入

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { RefinedMemoryCard, RefinedMemoryFile, MEMORY_LIMITS, LESSON_TEMPLATES } from './RefinedMemoryCard.js';
import type { MemoryCategory } from './RefinedMemoryCard.js';
import { FailureCategory } from './FailureMemory.js';
import { Trajectory } from '../loop/trajectory.js';
import { Tier, TierRegistry } from '../tiers/TierConfig.js';

export interface RefineInput {
  /** 原始轨迹（来自 VerifyCritiqueLoop） */
  trajectory: Trajectory;
  /** 任务风格 */
  taskStyle: string;
  /** 适用档位（推断或显式） */
  applicableTiers?: string[];
  /** 当前时间戳 */
  now?: number;
  // ===== Positive Memory =====
  /** 尝试次数（1 = 一次通过） */
  attemptCount?: number;
  /** 用户反馈文本（正向词触发 success 提炼） */
  userFeedback?: string;
}

/** 正向反馈词（一次通过 + 正向反馈 → success 卡）。
 * 注：CJK 无 \b 词界（'很不错' 内 '不错' 前后均汉字），故中文直接匹配，
 * OK 用 ASCII 边界（申报：指令原 regex 的 \b 对 CJK 无效）。 */
export const POSITIVE_FEEDBACK_RE = /(完美|可以|很好|不错|好的|没问题)|(?<![A-Za-z0-9])OK(?![A-Za-z0-9])/i;
export interface LoadFilter {
  /** 按任务风格过滤 */
  taskStyle?: string;
  /** 按档位过滤 */
  tier?: Tier | string;
  /** 最大返回数量（轻量档可减少） */
  maxCards?: number;
  /** 当前时间戳（用于衰减计算） */
  now?: number;
  /**
   * 当前 workspace 相关文件列表（用于引用过滤）
   * 只加载 referencedFiles 与此列表有交集的记忆；为空则回退全量
   */
  currentWorkspaceFiles?: string[];
  /**
   * 任务高频词 — 卡片 summary 含关键词 relevance +1（相关性排序用）。
   * 排序 = 0.7×effectiveWeight + 0.3×relevance（防高权重旧卡压制相关新卡）。
   */
  keywords?: string[];
  /** preference 保留 1 席位（即使排序靠后） */
  reservePreferenceSeat?: boolean;
}

/** 投影缓存条目（快照冻结） */
export interface MemoryProjection {
  key: string;
  builtAt: number;
  cards: RefinedMemoryCard[];
}

/** 衰减阶梯粗粒度 bucket（30d 对齐 DECAY_HALF_LIFE_DAYS）—
 *  跨 bucket 必然跨某卡的衰减段 → key 变 → 自动重建。 */
function decayStep(now: number): number {
  return Math.floor(now / (MEMORY_LIMITS.DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000));
}

/** filter key 值归一（确定性）— 路径分隔符统一 /、数组排序、空值 '∅'。 */
function normFilterValue(v: unknown): string {
  if (v === undefined || v === null) return '∅';
  if (typeof v === 'string') return v.trim().toLowerCase().replace(/\\/g, '/');
  if (Array.isArray(v)) return '[' + v.map((x) => normFilterValue(x)).sort().join('|') + ']';
  return String(v);
}

function normalizeFilterKey(filter: LoadFilter): string {
  return [
    `style=${normFilterValue(filter.taskStyle)}`,
    `tier=${normFilterValue(filter.tier)}`,
    `max=${normFilterValue(filter.maxCards)}`,
    `now=${normFilterValue(filter.now)}`,
    `ws=${normFilterValue(filter.currentWorkspaceFiles)}`,
    `kw=${normFilterValue(filter.keywords)}`,
    `seat=${normFilterValue(filter.reservePreferenceSeat)}`,
  ].join('&');
}

export class RefinedMemoryStore {
  private workspaceRoot: string;
  private filePath: string;
  private cache: RefinedMemoryFile | null = null;

  // 投影缓存 — 多槽 Map（上限 8，超限删最旧）。
  // 一致性语义：任务内快照冻结（有意）；任务边界/写入 invalidateProjection 重建；
  // 跨衰减阶梯（decayStep 变化）→ key 变化 → 自动重建。
  private projections = new Map<string, MemoryProjection>();

  constructor(workspaceRoot: string, customFilename?: string) {
    this.workspaceRoot = workspaceRoot;
    // 优先级:显式 customFilename > PANSHA_MEMORY_FILE env > 默认文件名
    // (对齐 TaskStateStore 的 PANSHA_TASK_STATE_FILE 模式——R6 评测用 env 注入隔离文件)
    const fromEnv = typeof process !== 'undefined' ? process.env?.PANSHA_MEMORY_FILE?.trim() : undefined;
    const resolved = customFilename ?? fromEnv ?? MEMORY_LIMITS.DEFAULT_FILENAME;
    this.filePath = join(workspaceRoot, resolved);
  }

  /**
   * 提炼：从原始轨迹提炼为教训卡片
   * 核心：从失败信号中生成可持久化的轻量卡片，不保留完整轨迹
   * 新增 Positive Memory — 一次通过（attemptCount===1）且（正向反馈 或
   * score≥85）→ kind:'success' 卡。写盘成功 ≠ 任务成功（触发红线）。
   */
  refine(input: RefineInput): RefinedMemoryCard[] {
    const now = input.now ?? Date.now();
    const newCards: RefinedMemoryCard[] = [];

    // 1) 收集所有失败信号
    const failureSignals = this.extractFailureSignals(input.trajectory);

    // 提取本次写入的文件路径（用于 referencedFiles）
    const writtenFiles = this.extractWrittenFilesFromTrajectory(input.trajectory);

    // 2) 为每个失败信号生成或更新一张卡片
    for (const sig of failureSignals) {
      const card = this.createOrUpdateCard(sig, input.taskStyle, input.applicableTiers, now, writtenFiles);
      newCards.push(card);
    }

    // Positive Memory — 一次通过 + 正向信号 → success 卡
    if (input.attemptCount === 1) {
      const fb = (input.userFeedback || '').trim();
      // 0.7：正向信号 = 用户正向反馈 OR 轨迹真实验证通过（stopReason==='completed'）。
      // 纯问答/闲聊（stopReason==='answered'）不再产生 success 卡——它计入 UI
      // "已回复"但不代表工程验证通过。
      const positive = POSITIVE_FEEDBACK_RE.test(fb) || input.trajectory?.stopReason === 'completed';
      if (positive) {
        const card = this.createPositiveCard(input.taskStyle, input.applicableTiers, now, fb || '一次通过且真实验证通过', writtenFiles);
        newCards.push(card);
      }
    }

    return newCards;
  }

  /**
   * 生成 Positive（success）卡片
   * 摘要："已验证可行的做法：..."（建设性、可复用）
   */
  private createPositiveCard(
    taskStyle: string,
    applicableTiers: string[] | undefined,
    now: number,
    evidence: string,
    writtenFiles: string[] = []
  ): RefinedMemoryCard {
    const summary = `已验证可行的做法：${evidence}`;
    const newRefs = writtenFiles.map(f => this.normPath(f)).filter(Boolean);
    // 修复（#6）：同 id（同摘要）已存在时 count 预解析为 existing+1——配合
    // mergeAndCap 整卡替换语义，重复成功恰好 +1 而非翻倍。
    const existingSameId = this.load().cards.find(c => c.id === this.hashOfSuccessSummary(summary));
    const resolvedCount = existingSameId ? (existingSameId.count ?? 0) + 1 : 1;
    const card: RefinedMemoryCard = {
      id: this.hashId(`success-${summary}`),
      kind: 'success',
      category: 'OTHER',
      memoryCategory: 'implementation',
      summary,
      weight: 1.0,
      taskStyle: (taskStyle as any) || 'all',
      count: resolvedCount,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: applicableTiers ?? [],
      sourceContext: `一次通过（attemptCount=1），${evidence}`,
      decayWeight: 1.0,
      lastUsedAt: now,
      ...(newRefs.length ? { referencedFiles: newRefs } as any : {}),
    };
    return card;
  }

  /**
   * 持久化：写入 .panshalach-memory.json
   */
  save(cards: RefinedMemoryCard[]): { written: number; capped: number; path: string } {
    // 加载现有
    const existing = this.load();
    // 合并（去重 + 容量控制）
    const merged = this.mergeAndCap(existing.cards, cards);
    // 容量裁剪
    const capped = this.applyCapacityLimits(merged);

    const file: RefinedMemoryFile = {
      meta: {
        version: '1.0.0',
        lastUpdated: Date.now(),
        totalCards: capped.length,
      },
      cards: capped,
    };

    // C1（ROADMAP-NEXT §3.2）：MAX_FILE_SIZE_BYTES 声明执行 —— 序列化后超限
    // 直接 reject（throw，与 writeFileSync 的既有错误风格一致），拒绝写半截大文件。
    const serialized = JSON.stringify(file, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > MEMORY_LIMITS.MAX_FILE_SIZE_BYTES) {
      const sizeKiB = (Buffer.byteLength(serialized, 'utf-8') / 1024).toFixed(1);
      const capKiB = Math.round(MEMORY_LIMITS.MAX_FILE_SIZE_BYTES / 1024);
      throw new Error(
        `✗ 记忆文件写入被拒绝：序列化后 ${sizeKiB}KiB 超过上限 ${capKiB}KiB` +
        `（MEMORY_LIMITS.MAX_FILE_SIZE_BYTES）。本次 save 未写盘；` +
        `请先用 /memory clear 或等待衰减清理旧卡后重试。`
      );
    }

    // 写入
    writeFileSync(this.filePath, serialized, 'utf-8');
    this.cache = file;
    this.invalidateProjection(); // save() 写入 → 重建

    // 确保 .gitignore 包含
    this.ensureGitIgnore();

    return { written: capped.length, capped: cards.length - capped.length, path: this.filePath };
  }

  /**
   * 加载
   */
  load(): RefinedMemoryFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { meta: { version: '1.0.0', lastUpdated: 0, totalCards: 0 }, cards: [] };
      return this.cache;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as RefinedMemoryFile;
      this.cache = parsed;
      return parsed;
    } catch {
      this.cache = { meta: { version: '1.0.0', lastUpdated: 0, totalCards: 0 }, cards: [] };
      return this.cache;
    }
  }

  /**
   * 投影缓存加载 — key = filter 归一 + '|step=' + decayStep(now)。
   * 命中 → 返回 builtAt 快照（任务内冻结是有意的会话投影语义）；
   * 未命中 → loadFiltered 后缓存（多槽 ≤8 LRU）。跨衰减阶梯 key 变化 → 自动重建。
   */
  loadFilteredCached(filter: LoadFilter = {}): RefinedMemoryCard[] {
    const now = filter.now ?? Date.now();
    const key = normalizeFilterKey(filter) + '|step=' + decayStep(now);
    const hit = this.projections.get(key);
    if (hit) {
      // LRU touch
      this.projections.delete(key);
      this.projections.set(key, hit);
      return hit.cards;
    }
    const cards = this.loadFiltered(filter);
    if (this.projections.size >= 8) {
      const oldest = this.projections.keys().next().value;
      if (oldest !== undefined) this.projections.delete(oldest);
    }
    this.projections.set(key, { key, builtAt: now, cards });
    return cards;
  }

  /** 清空全部投影槽（写入/提炼/任务边界调用 → 重建反映最新衰减）。 */
  invalidateProjection(): void {
    this.projections.clear();
  }

  /** 当前投影槽数（测试/调试可见性）。 */
  projectionCount(): number {
    return this.projections.size;
  }

  /**
   * 探索阶段自动拉取 — top-N 之外的相关卡（≤5），排除已注入卡。
   * 走投影 Map（独立键：maxCards 未设 → 与 L1 注入键不同槽，不重算 loadFiltered）。
   */
  getOverflowCards(filter: LoadFilter, alreadyInjected: string[]): { pulled: RefinedMemoryCard[]; totalRemaining: number } {
    const all = this.loadFilteredCached({ ...filter, maxCards: undefined, reservePreferenceSeat: false });
    const notInjected = all.filter(c => !alreadyInjected.includes(c.id));
    const pulled = notInjected.slice(0, 5);
    return { pulled, totalRemaining: notInjected.length - pulled.length };
  }

  /**
   * 过滤加载
   * 支持 memoryCategory 分层 + 阶梯衰减
   * 支持 currentWorkspaceFiles 引用过滤（交集匹配）
   */
  loadFiltered(filter: LoadFilter = {}): RefinedMemoryCard[] {
    const file = this.load();
    const now = filter.now ?? Date.now();
    const tierName = filter.tier ? (TierRegistry.isTier(filter.tier as string) ? filter.tier as Tier : undefined) : undefined;

    // 规范化老卡片（无 memoryCategory 时按 kind 补默认）
    const normalized = file.cards.map(c => {
      const mc = (c as any).memoryCategory || 'general';
      const lastUsed = (c as any).lastUsedAt ?? c.lastSeen ?? now;
      const dw = (c as any).decayWeight ?? 1.0;
      const refs: string[] = (c as any).referencedFiles || [];
      const kind = (c as any).kind ?? 'failure'; // 无 kind 默认 failure
      return {
        ...c,
        kind,
        memoryCategory: mc,
        lastUsedAt: lastUsed,
        decayWeight: dw,
        referencedFiles: refs,
      } as RefinedMemoryCard & { referencedFiles?: string[] };
    });

    // Tier 可见性规则（architecture 始终可见）
    const isVisible = (t: Tier | undefined, mc: MemoryCategory): boolean => {
      if (mc === 'architecture') return true;
      if (!t) return true;
      switch (t) {
        case 'quick': return mc === 'failure';
        case 'standard': return mc === 'failure' || mc === 'implementation';
        case 'high': return mc === 'failure' || mc === 'implementation' || mc === 'insight';
        case 'max':
        case 'ex':
        case 'pangu':
          return true;
        default:
          return true;
      }
    };

    // 对抗评审修正（第二轮攻击1c）：归档卡必须退出注入——否则 merge 软删后
    // 原卡与合并卡同时注入，"合并"净增重复内容，中期遗忘机制结构失效。
    const activeCards = normalized.filter(c => (c as any).status !== 'archived');

    let filtered = activeCards.filter(c => {
      // 任务风格
      if (filter.taskStyle && c.taskStyle !== 'all' && c.taskStyle !== filter.taskStyle) {
        return false;
      }
      // 档位可见性（使用 memoryCategory）
      const mc = (c.memoryCategory || 'general') as MemoryCategory;
      if (tierName && !isVisible(tierName, mc)) {
        return false;
      }
      return true;
    });

    // 引用过滤（referencedFiles 与 currentWorkspaceFiles 有交集）
    // 语义：
    // - 先做 tier / style / decay 等常规过滤得到候选集 preReference
    // - 若提供了 currentWorkspaceFiles（非空），计算与 referencedFiles 有交集的子集 refSet
    // - 如果 refSet 非空，则只返回 refSet（只加载“当前涉及路径相关”的记忆）
    // - 如果 refSet 为空，则回退到 preReference（保底，避免“无记忆可用”）
    // - 若未提供 currentWorkspaceFiles，则直接使用常规过滤结果
    const preReference = filtered;
    const wsFiles = filter.currentWorkspaceFiles;
    const hasWsScope = !!(wsFiles && wsFiles.length > 0);
    if (hasWsScope && wsFiles) {
      const wsSet = new Set(wsFiles.map(f => this.normPath(f)));
      const refSet = preReference.filter(c => {
        const refs: string[] = (c as any).referencedFiles || [];
        return refs.some(r => wsSet.has(this.normPath(r)));
      });
      filtered = refSet.length > 0 ? refSet : preReference;
    }

    // 阶梯衰减 + effectiveWeight 计算
    filtered = filtered
      .map(c => {
        const eff = this.calculateEffectiveWeight(c, now);
        return { ...c, _effective: eff } as RefinedMemoryCard & { _effective: number };
      })
      .filter(c => (c as any)._effective >= 0.3);

    // 相关性（任务关键词命中 summary → +1，cap 3）
    const kws = (filter.keywords ?? []).map(k => String(k).toLowerCase()).filter(Boolean);
    if (kws.length > 0) {
      filtered = filtered.map(c => {
        const s = (c.summary || '').toLowerCase();
        let rel = 0;
        for (const k of kws) if (s.includes(k)) rel++;
        return { ...c, _relevance: Math.min(3, rel) } as any;
      });
    }

    // 排序 = 0.7×effectiveWeight + 0.3×relevance（默认降序权重一致）
    filtered.sort((a, b) => {
      const ea = (a as any)._effective ?? 0;
      const eb = (b as any)._effective ?? 0;
      const ra = (a as any)._relevance ?? 0;
      const rb = (b as any)._relevance ?? 0;
      const sa = 0.7 * ea + 0.3 * ra;
      const sb = 0.7 * eb + 0.3 * rb;
      return sb - sa || (b as any).count - (a as any).count;
    });

    if (filter.maxCards && filter.maxCards > 0) {
      // preference 保留 1 席位（排序靠后也保留，其余按 top-N）
      if (filter.reservePreferenceSeat !== false) {
        const pref = filtered.find(c => c.kind === 'preference');
        const rest = filtered.filter(c => c.kind !== 'preference').slice(0, Math.max(1, filter.maxCards - 1));
        const withPref = pref ? [pref, ...rest] : rest;
        filtered = withPref.slice(0, filter.maxCards);
      } else {
        filtered = filtered.slice(0, filter.maxCards);
      }
    }

    // loadFiltered 是纯读 —— 不再把 lastUsedAt/decayWeight 刷成 now。
    // 旧实现让每一次读取都“刷新使用”，使时间衰减永远无法生效（读即使用，
    // 自我挫败），也让外部无法验证衰减分段。使用刷新由 markVerified 承担；
    // markInjected 仅记账（不影响衰减），二者见下方实现（接口契约 v3：二态语义）。

    // 去掉内部 _effective/_relevance 后返回
    return filtered.map(c => {
      const { _effective, _relevance, ...rest } = c as any;
      return rest as RefinedMemoryCard;
    });
  }

  /**
   * markInjected（接口契约 v3 · 二态之一）：注入即记账。
   * - 仅记录内存账本（lastInjectedAt），不写盘、不改 count/lastUsedAt；
   * - 事件（memory_injected）由调用方经 rollout 'context'/'agent' 事件落盘；
   * - 有意不影响衰减：count 驱动维持现状（refine/merge/refineCompactSignals），
   *   避免"注入≠使用"的自激励循环（对抗评审 A1/攻击1.1 的结论）。
   */
  private lastInjectedAt = new Map<string, number>();
  markInjected(cardIds: string[], now = Date.now()): { injected: number; cardIds: string[] } {
    for (const id of cardIds) {
      if (id) this.lastInjectedAt.set(id, now);
    }
    return { injected: cardIds.filter(Boolean).length, cardIds: cardIds.filter(Boolean) };
  }

  /** 查询注入账本（/memory stats 与 ContextSnapshot 事件可用）。 */
  injectedAtOf(cardId: string): number | undefined {
    return this.lastInjectedAt.get(cardId);
  }

  /**
   * markVerified（接口契约 v3 · 二态之二）：机器判定的"真实使用"。
   * 判定来源由调用方提供（确定性规则：任务内工具写入/验证文件集 ∩ 卡.referencedFiles ≠ ∅），
   * 本方法只负责效果：lastUsedAt=now + count+1 + 单次写盘 + 投影失效。
   * 这是衰减语义中唯一把"卡被真实复用"转为保鲜的通道。
   */
  markVerified(cardIds: string[], now = Date.now()): { updated: number; path: string } {
    if (cardIds.length === 0) return { updated: 0, path: this.filePath };
    const file = this.load();
    let updated = 0;
    for (const c of file.cards) {
      if (cardIds.includes(c.id)) {
        (c as any).lastUsedAt = now;
        c.count = (c.count ?? 0) + 1;
        updated++;
      }
    }
    if (updated === 0) return { updated: 0, path: this.filePath };
    // 注意：不能走 save()——mergeAndCap 会把传入卡与已有卡按 count 累加（同一批
    // 对象 → 翻倍）。markVerified 是原位刷新，直写持久化。
    file.meta.lastUpdated = now;
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
    this.cache = file;
    this.invalidateProjection();
    return { updated, path: this.filePath };
  }

  /**
   * public decay math — exposes the 4-segment ladder so callers/tests
   * can verify effective weight without depending on loadFiltered's cutoff.
   */
  effectiveWeightOf(card: RefinedMemoryCard, now: number): number {
    return this.calculateEffectiveWeight(card, now);
  }

  /**
   * 列出所有卡片（用于 memory list 命令）
   */
  list(): RefinedMemoryCard[] {
    return this.load().cards;
  }

  /**
   * 清空（可指定 category）
   */
  clear(category?: FailureCategory): { removed: number } {
    const existing = this.load();
    const before = existing.cards.length;
    if (category) {
      existing.cards = existing.cards.filter(c => c.category !== category);
    } else {
      existing.cards = [];
    }
    const removed = before - existing.cards.length;
    existing.meta.totalCards = existing.cards.length;
    existing.meta.lastUpdated = Date.now();
    writeFileSync(this.filePath, JSON.stringify(existing, null, 2), 'utf-8');
    this.cache = existing;
    this.invalidateProjection(); // clear() 写入
    return { removed };
  }

  /**
   * 导出为可读 JSON
   */
  export(): string {
    return JSON.stringify(this.load(), null, 2);
  }

  /**
   * 导入
   */
  import(jsonString: string, merge = true): { imported: number; total: number } {
    let parsed: RefinedMemoryFile;
    try {
      parsed = JSON.parse(jsonString) as RefinedMemoryFile;
    } catch {
      return { imported: 0, total: 0 };
    }
    if (!parsed.cards) return { imported: 0, total: 0 };

    if (merge) {
      this.save(parsed.cards);
    } else {
      const file: RefinedMemoryFile = {
        meta: { version: parsed.meta?.version ?? '1.0.0', lastUpdated: Date.now(), totalCards: parsed.cards.length },
        cards: parsed.cards,
      };
      writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
      this.cache = file;
      this.invalidateProjection(); // import 写入
    }

    return { imported: parsed.cards.length, total: this.load().cards.length };
  }

  // ---------- 私有方法 ----------

  private extractFailureSignals(trajectory: Trajectory): Array<{
    category: FailureCategory;
    sourceContext: string;
  }> {
    const signals: Array<{ category: FailureCategory; sourceContext: string }> = [];

    for (const step of trajectory.steps) {
      if (step.readBeforeWriteViolation) {
        signals.push({ category: 'READ_BEFORE_WRITE_VIOLATION', sourceContext: `Step ${step.stepNumber}: 文件未先读取` });
      }
      if (step.terminalNoCheck) {
        signals.push({ category: 'TERMINAL_NO_CHECK_AFTER_COMMAND', sourceContext: `Step ${step.stepNumber}: 终端命令后未检查` });
      }
      if (step.automationNoEffectCheck) {
        signals.push({ category: 'AUTOMATION_NO_EFFECT_VERIFICATION', sourceContext: `Step ${step.stepNumber}: 自动化动作未验证效果` });
      }
      if (step.didRealVerification === false && step.action && (step.action as any[]).length > 0) {
        // 仅在没有真实验证时标记
      }
    }

    return signals;
  }

  private createOrUpdateCard(
    signal: { category: FailureCategory; sourceContext: string },
    taskStyle: string,
    applicableTiers: string[] | undefined,
    now: number,
    writtenFiles: string[] = []
  ): RefinedMemoryCard {
    const existing = this.load().cards.find(c => c.category === signal.category);
    const summary = LESSON_TEMPLATES[signal.category] ?? signal.sourceContext;

    // 推断 memoryCategory
    const memCat = this.inferMemoryCategory(signal.category, summary);

    // 规范化 written files
    const newRefs = writtenFiles.map(f => this.normPath(f)).filter(Boolean);

    if (existing) {
      // 修复（对抗清单 #6，2026-09-05）：返回【脱离缓存的克隆】，count 预解析为
      // existing.count+1——绝不在缓存对象上原位累加。旧行为（原位 +1 后 save()
      // 的 mergeAndCap 对同 id 再累加一次）使 count 每轮翻倍（1→2→4），R1 写闭环
      // 接线后必触发。
      const prevRefs: string[] = (existing as any).referencedFiles || [];
      const mergedRefs = Array.from(new Set([...prevRefs.map(this.normPath.bind(this)), ...newRefs]));
      const resolvedMemCat = (!existing.memoryCategory || existing.memoryCategory === 'general') ? memCat : existing.memoryCategory;
      return {
        ...existing,
        count: (existing.count ?? 0) + 1,
        lastSeen: now,
        weight: Math.min(5, (existing.weight ?? 1) + 0.2),
        memoryCategory: resolvedMemCat,
        referencedFiles: mergedRefs,
      } as RefinedMemoryCard;
    }

    // 新建
    return {
      id: this.hashId(`${signal.category}-${summary}`),
      category: signal.category,
      memoryCategory: memCat,
      summary,
      weight: 2,
      taskStyle: (taskStyle as any) || 'all',
      count: 1,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: applicableTiers ?? [],
      sourceContext: signal.sourceContext,
      decayWeight: 1.0,
      lastUsedAt: now,
      // P2-D
      ...(newRefs.length ? { referencedFiles: newRefs } as any : {}),
    } as RefinedMemoryCard;
  }

  /**
   * 根据 FailureCategory + 关键词推断 memoryCategory
   */
  private inferMemoryCategory(category: FailureCategory, summary: string): MemoryCategory {
    const s = (summary || '').toLowerCase();

    // architecture 关键词优先
    if (/(架构|决定|模式|design|architecture|pattern|trade.?off|决策)/.test(s)) {
      return 'architecture';
    }

    // 直接 failure 类别
    const failureCats: FailureCategory[] = [
      'HALLUCINATED_FILE', 'HALLUCINATED_FUNCTION', 'HALLUCINATED_BEHAVIOR',
      'READ_BEFORE_WRITE_VIOLATION', 'NO_VERIFICATION_BEFORE_CLAIM',
      'WEAK_VERIFICATION', 'COMMAND_FAILED', 'STATE_MISMATCH',
      'TERMINAL_NO_CHECK_AFTER_COMMAND', 'AUTOMATION_NO_EFFECT_VERIFICATION'
    ];
    if (failureCats.includes(category)) {
      return 'failure';
    }

    // implementation
    if (/(实现|添加|修复|修改|implement|fix|add|change|refactor|新增)/.test(s)) {
      return 'implementation';
    }

    // insight
    if (/(洞察|发现|发现问题|insight|observe|lesson|发现规律|经验)/.test(s)) {
      return 'insight';
    }

    return 'general';
  }

  /**
   * 按类别返回半衰期（天）
   */
  private getHalfLifeForCategory(mc: MemoryCategory): number {
    switch (mc) {
      case 'failure': return 90;
      case 'implementation': return 180;
      case 'architecture': return 365;
      case 'insight': return 180;
      default: return 90;
    }
  }

  /**
   * 阶梯衰减（4 段分段函数）
   * 验收：超过 2 倍半衰期权重降至 10% 以下
   * 沿用阶梯机制（申报），叠加 kind 基线 —
   *   failure/success 基线 1.0；preference 基线 0.6（修正 3）；
   *   pin 卡冻结（decayWeight 恒 1.0，无衰减）；count≥2 半衰期 ×count（常用升权）。
   */
  private calculateEffectiveWeight(card: RefinedMemoryCard, now: number): number {
    // pin 卡冻结衰减
    if ((card as any).pinned) return 1.0;
    const mc = (card.memoryCategory || 'general') as MemoryCategory;
    const last = Math.max(card.lastSeen ?? now, (card as any).lastUsedAt ?? 0); // 修复：?? 短路曾让复发卡的 lastSeen 刷新不可见
    const ageInDays = (now - last) / (24 * 60 * 60 * 1000);
    // count≥2 → 半衰期 ×count（常用卡衰减更慢）
    const halfLifeBase = this.getHalfLifeForCategory(mc);
    const halfLife = halfLifeBase * Math.max(1, card.count ?? 1);
    const base = (card as any).decayWeight ?? card.weight ?? 1;
    // kind 基线（preference 0.6 — 偏好默认低于事实类）
    const kindBaseline = (card.kind === 'preference' ? 0.6 : 1.0);
    let factor = 1.0;
    if (ageInDays < halfLife * 0.5) factor = 1.0;
    else if (ageInDays < halfLife * 1.0) factor = 0.7;
    else if (ageInDays < halfLife * 2.0) factor = 0.4;
    else factor = 0.1;
    return base * factor * kindBaseline;
  }

  /**
   * /remember — 用户偏好卡
   * kind:'preference'，weight 0.6（默认）；--pin → weight 1.0 + pinned（冻结衰减）
   */
  addRemember(content: string, pin: boolean, now = Date.now()): RefinedMemoryCard {
    const existing = this.load().cards.find(c => c.kind === 'preference' && c.summary === content);
    if (existing) {
      // 修复（#6 同源）：返回脱离缓存的克隆（count+1）——原位累加 + save 的
      // mergeAndCap 会让重复 /remember 同文本时 count 翻倍。
      return {
        ...existing,
        count: (existing.count ?? 0) + 1,
        lastSeen: now,
        lastUsedAt: now,
        pinned: pin ? true : existing.pinned,
        weight: pin ? 1.0 : existing.weight,
      } as RefinedMemoryCard;
    }
    const card: RefinedMemoryCard = {
      id: this.hashId(`preference-${content}`),
      kind: 'preference',
      category: 'OTHER',
      memoryCategory: 'general',
      summary: content,
      weight: pin ? 1.0 : 0.6,
      taskStyle: 'all',
      count: 1,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: [],
      sourceContext: pin ? '用户 pin 偏好（衰减冻结）' : '用户偏好',
      decayWeight: 1.0,
      lastUsedAt: now,
      pinned: pin || undefined,
    };
    return card;
  }

  /** /remember 持久化（合并 + 保存） */
  remember(content: string, pin: boolean): { ok: boolean; card?: RefinedMemoryCard } {
    const card = this.addRemember(content, pin);
    this.save([card]);
    return { ok: true, card };
  }

  /** /forget <id> — 删除卡片 */
  forget(id: string): { removed: boolean } {
    const file = this.load();
    const before = file.cards.length;
    file.cards = file.cards.filter(c => c.id !== id);
    const removed = file.cards.length < before;
    if (removed) {
      file.meta.totalCards = file.cards.length;
      file.meta.lastUpdated = Date.now();
      writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
      this.cache = file;
      this.invalidateProjection(); // forget 写入
    }
    return { removed };
  }

  /**
   * 内容 hash（compact 补漏提炼去重用）— hashId(success-<summary>) 同款
   */
  hashOfSuccessSummary(summary: string): string {
    return this.hashId(`success-${summary}`);
  }

  /**
   * compact 补漏提炼 — 防双重计数
   * - 已存在同 hash 的 success 卡 → count+1 + 刷新（升权），不新增
   * - 未提炼且有信号（score≥85）→ 补提新卡
   * - 直接改写文件卡片数组单次写盘（经 save() 合并会 double-count 同一对象）
   */
  refineCompactSignals(signals: Array<{ summary: string; evidence: string; taskStyle: string; now: number }>): RefinedMemoryCard[] {
    const file = this.load();
    const out: RefinedMemoryCard[] = [];
    let changed = false;
    for (const sig of signals) {
      const id = this.hashOfSuccessSummary(sig.summary);
      const found = file.cards.find(c => c.id === id);
      if (found) {
        found.count += 1;
        found.lastSeen = sig.now;
        found.lastUsedAt = sig.now;
        changed = true;
        out.push({ ...found });
      } else {
        const card = this.createPositiveCard(sig.taskStyle, undefined, sig.now, sig.evidence);
        file.cards.push(card);
        changed = true;
        out.push(card);
      }
    }
    if (changed) {
      file.meta.totalCards = file.cards.length;
      file.meta.lastUpdated = Date.now();
      writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
      this.cache = file;
      this.invalidateProjection(); // refineCompactSignals 写入
    }
    return out;
  }

  /**
   * 确定性同主题合并（LLM 路径后置）。
   * - 候选：status!=='archived' && effectiveWeight ≥ 0.5
   * - 分组：2-gram 公共词元 ≥2 → 同组；每组 ≤6（超 6 拆多组）
   * - 合并：summary 拼接 ≤800；firstSeen = min；weight = max；count = Σ；
   *         decayWeight 按 now 起算（不继承源卡衰减，防 Σcount 霸榜）
   * - 原卡 → archived（软删除）；合并卡 → active；invalidateProjection
   */
  mergeSimilarCards(now = Date.now()): Array<{ group: string[]; mergedId: string; summary: string }> {
    const file = this.load();
    const candidates = file.cards.filter(c => c.status !== 'archived' && this.calculateEffectiveWeight(c, now) >= 0.5);
    if (candidates.length < 2) return [];

    // 2-gram 词元
    const stopWords = new Set('的了是在与和或及对用要可以中之不有没很也都被把将使如因为但而'.split(''));
    const tokenize = (s: string): string[] => {
      const norm = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      const words = norm.split(' ').filter(w => w.length >= 2 && !stopWords.has(w));
      const grams = new Set<string>();
      for (const w of words) {
        if (w.length <= 2) { grams.add(w); continue; }
        for (let i = 0; i < w.length - 1; i++) grams.add(w.slice(i, i + 2));
      }
      return [...grams];
    };

    // 分组：贪心（每组 ≤6）
    const groups: Array<typeof candidates> = [];
    const used = new Set<string>();
    for (const c of candidates) {
      if (used.has(c.id)) continue;
      const cTok = new Set(tokenize(c.summary));
      const group = [c];
      used.add(c.id);
      for (const other of candidates) {
        if (used.has(other.id) || group.length >= 6) continue;
        const oTok = tokenize(other.summary);
        const overlap = oTok.filter(t => cTok.has(t)).length;
        if (overlap >= 2) {
          group.push(other);
          used.add(other.id);
        }
      }
      if (group.length >= 2) groups.push(group);
    }

    const results: Array<{ group: string[]; mergedId: string; summary: string }> = [];
    for (const g of groups) {
      const sourceIds = g.map(c => c.id);
      const summary = g.map(c => c.summary).join(' | ').slice(0, 800);
      const mergedId = this.hashId(`merged-${sourceIds.sort().join('-')}-${now}`);
      const merged: RefinedMemoryCard = {
        id: mergedId,
        kind: g[0].kind ?? 'failure',
        category: 'OTHER',
        memoryCategory: g[0].memoryCategory ?? 'general',
        summary,
        weight: Math.max(...g.map(c => c.weight)),
        taskStyle: 'all',
        count: g.reduce((a, c) => a + c.count, 0),
        lastSeen: now,
        firstSeen: Math.min(...g.map(c => c.firstSeen)),
        applicableTiers: [],
        sourceContext: `合并自 ${sourceIds.join(', ')}`,
        decayWeight: 1.0, // 按 now 起算，不继承源卡衰减
        lastUsedAt: now,
        status: 'active',
        mergedFrom: sourceIds,
      };
      // 原卡软删除
      for (const id of sourceIds) {
        const orig = file.cards.find(c => c.id === id);
        if (orig) orig.status = 'archived';
      }
      file.cards.push(merged);
      results.push({ group: sourceIds, mergedId, summary });
    }
    if (results.length > 0) {
      file.meta.totalCards = file.cards.length;
      file.meta.lastUpdated = now;
      writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
      this.cache = file;
      this.invalidateProjection(); // 合并后缓存重建
    }
    return results;
  }

  private hashId(input: string): string {
    return createHash('sha1').update(input).digest('hex').slice(0, 12);
  }

  private mergeAndCap(existing: RefinedMemoryCard[], newCards: RefinedMemoryCard[]): RefinedMemoryCard[] {
    const map = new Map<string, RefinedMemoryCard>();
    for (const c of existing) map.set(c.id, c);
    for (const c of newCards) {
      // 修复（#6）：同 id 整卡替换——调用方（createOrUpdateCard/addRemember/
      // createPositiveCard）已预解析 count；此处再累加会造成翻倍。
      // 幂等：同一对象重复 save 也只保留一份，不再放大。
      map.set(c.id, c);
    }
    return Array.from(map.values());
  }

  private applyCapacityLimits(cards: RefinedMemoryCard[]): RefinedMemoryCard[] {
    // 按类别分组，每类别保留最新且权重高的
    const byCategory = new Map<string, RefinedMemoryCard[]>();
    for (const c of cards) {
      if (!byCategory.has(c.category)) byCategory.set(c.category, []);
      byCategory.get(c.category)!.push(c);
    }
    const limited: RefinedMemoryCard[] = [];
    for (const [, arr] of byCategory) {
      arr.sort((a, b) => b.lastSeen - a.lastSeen);
      limited.push(...arr.slice(0, MEMORY_LIMITS.MAX_PER_CATEGORY));
    }
    // 全局硬上限
    if (limited.length > MEMORY_LIMITS.MAX_TOTAL_CARDS) {
      limited.sort((a, b) => b.weight * b.count - a.weight * a.count);
      return limited.slice(0, MEMORY_LIMITS.MAX_TOTAL_CARDS);
    }
    return limited;
  }

  private applyDecay(cards: RefinedMemoryCard[], now: number): RefinedMemoryCard[] {
    const halfLifeMs = MEMORY_LIMITS.DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    return cards
      .map(c => {
        const ageMs = now - c.lastSeen;
        const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
        const effectiveWeight = c.weight * decayFactor;
        return { ...c, weight: effectiveWeight };
      })
      .filter(c => c.weight >= MEMORY_LIMITS.MIN_WEIGHT);
  }

  /**
   * 从轨迹的 action/toolCalls 中提取本次写入/编辑的文件路径
   * 支持 Write/Edit/MultiEdit 类 + Bash 重定向（> / >>）
   */
  private extractWrittenFilesFromTrajectory(trajectory: Trajectory): string[] {
    const out = new Set<string>();
    if (!trajectory || !Array.isArray(trajectory.steps)) return [];
    for (const step of trajectory.steps) {
      const actions: any[] = Array.isArray(step.action) ? step.action : (step.action ? [step.action] : []);
      for (const act of actions) {
        if (!act) continue;
        const name = String(act.name || act.tool || act.type || '').toLowerCase();
        const args = act.args || act.parameters || act || {};

        // Write / Edit / MultiEdit family
        if (name.includes('write') || name.includes('edit') || name.includes('multiedit') || name === 'write_file' || name === 'edit_file') {
          const fp = args.file_path || args.path || args.filePath || args.target_file || args.target || args.file;
          if (typeof fp === 'string' && fp) out.add(fp);
        }

        // Bash / terminal redirection
        if (name.includes('bash') || name.includes('terminal') || name.includes('command') || name === 'run') {
          const cmd = String(args.command || args.cmd || args.input || args.script || '');
          if (cmd) {
            // Match > file and >> file, handling simple quotes
            const re = /(?:^|[\s;&|(){}])(?:cat|echo|printf|tee)?[^>]*>>?\s*["']?([^"'\s>;|]+)["']?/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(cmd)) !== null) {
              if (m[1]) out.add(m[1]);
            }
          }
        }
      }
    }
    return Array.from(out);
  }

  private normPath(p: string): string {
    return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
  }

  private ensureGitIgnore(): void {
    const gitignorePath = join(this.workspaceRoot, '.gitignore');
    try {
      let content = '';
      if (existsSync(gitignorePath)) {
        content = readFileSync(gitignorePath, 'utf-8');
      }
      if (!content.includes(MEMORY_LIMITS.GITIGNORE_LINE)) {
        if (content && !content.endsWith('\n')) content += '\n';
        content += `${MEMORY_LIMITS.GITIGNORE_LINE}\n`;
        writeFileSync(gitignorePath, content, 'utf-8');
      }
    } catch {
      // 静默失败：无法写 .gitignore 不影响主流程
    }
  }
}
