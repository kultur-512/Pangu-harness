// Panshalach 提炼后持久化存储
// 功能：提炼 / 加载 / 过滤 / 容量控制 / 衰减 / .gitignore 默认加入

import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'fs';
import { join, isAbsolute } from 'path';
import { createHash } from 'crypto';
import { RefinedMemoryCard, RefinedMemoryFile, MEMORY_LIMITS, LESSON_TEMPLATES } from './RefinedMemoryCard.js';
import type { MemoryCategory } from './RefinedMemoryCard.js';
import { FailureCategory } from './FailureMemory.js';
import { Trajectory } from '../loop/trajectory.js';
import { Tier, TierRegistry } from '../tiers/TierConfig.js';
import { normalizeRelPath } from './trajectoryFiles.js';
import { atomicWriteFileSync } from '../utils/atomicFile.js';

// ==================== 持久化文件校验（包C 缺陷3/10 共用） ====================

/**
 * 单卡形状校验：id / summary 必须是非空字符串。
 * load() 与 import() 共用——旧实现对 parsed.cards 直接 cast，cards 非数组时
 * 下游 .map 抛 TypeError 被上层 catch 吞 → 静默零注入/静默清库。
 */
export function isValidMemoryCardShape(c: unknown): boolean {
  return !!c && typeof c === 'object' &&
    typeof (c as any).id === 'string' && (c as any).id.length > 0 &&
    typeof (c as any).summary === 'string';
}

/** 持久化文件整体校验：cards 必须是数组且逐卡形状合格（meta 宽松——save 会重建）。 */
export function isValidMemoryFile(parsed: unknown): parsed is RefinedMemoryFile {
  return !!parsed && typeof parsed === 'object' &&
    Array.isArray((parsed as any).cards) &&
    (parsed as any).cards.every(isValidMemoryCardShape);
}

/**
 * 进程级注入账本（cardId → 最近注入时间 + 累计次数）——包C 缺陷8：
 * 从实例级升级，短命实例（runAgentTask 每步 new 即弃）的记账不再丢。
 * 仍纯内存、不写盘（契约 v3：markInjected 仅记账）。
 */
const injectionLedger = new Map<string, { at: number; count: number }>();

/** 清空注入账本（测试隔离用）。 */
export function resetInjectionLedgerForTest(): void {
  injectionLedger.clear();
}

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
  /**
   * 本次任务写入的文件路径（由调用方用共享提取器 extractWrittenFilePaths
   * 从轨迹提取后传入——store 内不再自行解析轨迹形状，单一实现防漂移）。
   * 用于产卡 referencedFiles → 引用过滤 + markVerified 交集判定的前提。
   */
  writtenFiles?: string[];
  /** 原始任务文本（首条 userInput；成功卡 summary 携带任务信息 + keywords 提取用） */
  taskText?: string;
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
    // env 为绝对路径时直接采用（join 会把它拼成 `<ws>/P:\...` 垃圾路径 →
    // existsSync false → 静默 0 卡——真机 smoke 实证，评测脚本全用绝对路径）。
    const fromEnv = typeof process !== 'undefined' ? process.env?.PANSHA_MEMORY_FILE?.trim() : undefined;
    const resolved = customFilename ?? fromEnv ?? MEMORY_LIMITS.DEFAULT_FILENAME;
    this.filePath = isAbsolute(resolved) ? resolved : join(workspaceRoot, resolved);
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

    // 本次写入的文件路径（用于 referencedFiles）——由调用方从轨迹提取后传入
    // （共享提取器 extractWrittenFilePaths，见 trajectoryFiles.ts）。
    const writtenFiles = Array.from(new Set((input.writtenFiles ?? []).map(f => this.normPath(f)).filter(Boolean)));

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
      // S 级缺陷修复：违反 RBW（轨迹含 readBeforeWriteViolation）的任务即使
      // completed 也不产成功卡——"先写后读"的通过不配当"已验证可行的做法"
      // （失败教训卡的产出逻辑不受影响，见上方 failureSignals）。
      const rbwViolation = (input.trajectory?.steps ?? []).some(s => s?.readBeforeWriteViolation);
      if (positive && !rbwViolation) {
        const card = this.createPositiveCard(input.taskStyle, input.applicableTiers, now, fb || '一次通过且真实验证通过', writtenFiles, input.taskText);
        newCards.push(card);
      }
    }

    return newCards;
  }

  /**
   * 生成 Positive（success）卡片
   * 摘要："已验证可行的做法：..."（建设性、可复用）
   * S 级缺陷修复：通用成功卡零信息——summary 携带任务前 60 字 + 写入文件
   * 列表（无任务文本时回退 evidence），keywords 从任务文本与写入文件名提取
   * （≤4 个 token）。同一任务重复成功 → 同摘要同 id → count 照常 +1。
   */
  private createPositiveCard(
    taskStyle: string,
    applicableTiers: string[] | undefined,
    now: number,
    evidence: string,
    writtenFiles: string[] = [],
    taskText?: string
  ): RefinedMemoryCard {
    const taskHead = String(taskText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    // 文件列表最多展示 5 个，超出以"等N个"收尾（防 summary 膨胀）
    const shown = writtenFiles.slice(0, 5);
    const fileList = shown.length
      ? shown.join('、') + (writtenFiles.length > shown.length ? ` 等${writtenFiles.length}个` : '')
      : '';
    const tail = fileList ? `（写：${fileList}）` : '';
    const summary = taskHead
      ? `已验证可行的做法：${taskHead}${tail}`
      : `已验证可行的做法：${evidence}${tail}`;
    const keywords = this.extractCardKeywords(taskText ?? '', writtenFiles);
    const newRefs = writtenFiles;
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
      ...(keywords.length ? { keywords } as any : {}),
    };
    return card;
  }

  /**
   * 从任务文本与写入文件名提取关键字（≤4 个 token，去重、小写）：
   * 文件名主干（去扩展名的 basename）优先——与 referencedFiles 同源、对
   * "这个文件怎么又改坏了"类复检最相关；任务文本取 ASCII 词（len≥2）。
   */
  private extractCardKeywords(taskText: string, writtenFiles: string[]): string[] {
    const tokens: string[] = [];
    const push = (t: string): void => {
      const k = String(t ?? '').trim().toLowerCase();
      if (k.length >= 2 && !tokens.includes(k)) tokens.push(k);
    };
    for (const f of writtenFiles) {
      const base = String(f).replace(/\\/g, '/').split('/').pop() ?? '';
      const stem = base.replace(/\.[^.]+$/, '');
      if (stem) push(stem);
    }
    for (const m of taskText.matchAll(/[A-Za-z0-9_\-]{2,}/g)) push(m[0]);
    return tokens.slice(0, 4);
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

    // 写入（包C 缺陷4：原子写——tmp + rename，崩溃不留半截文件）
    atomicWriteFileSync(this.filePath, serialized);
    this.cache = file;
    this.invalidateProjection(); // save() 写入 → 重建

    // 确保 .gitignore 包含
    this.ensureGitIgnore();

    return { written: capped.length, capped: cards.length - capped.length, path: this.filePath };
  }

  /**
   * 加载
   * 包C 缺陷3：load 后校验 Array.isArray(parsed.cards) + 逐卡 id/summary；
   * 不合格 → quarantine（原文件改名 <原名>.corrupt-<时间戳> 留证）+ 从空库
   * 启动 + console.error 一条告警。旧实现 JSON.parse 后直接 cast：cards 非数组
   * 时下游 .map 抛 TypeError 被上层 catch 吞 → 静默零注入；撕裂 JSON → catch
   * 后返回空库缓存 → 下次 save 静默清库。
   */
  load(): RefinedMemoryFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { meta: { version: '1.0.0', lastUpdated: 0, totalCards: 0 }, cards: [] };
      return this.cache;
    }
    let parsed: RefinedMemoryFile;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      parsed = JSON.parse(raw) as RefinedMemoryFile;
    } catch {
      return this.quarantineCorruptFile('JSON 解析失败（撕裂/损坏）');
    }
    if (!isValidMemoryFile(parsed)) {
      return this.quarantineCorruptFile('结构校验失败（cards 非数组或卡片缺 id/summary）');
    }
    this.cache = parsed;
    return parsed;
  }

  /**
   * 损坏隔离（quarantine）：原文件改名 `<原名>.corrupt-<时间戳>` 留证供人工恢复，
   * 从空库启动。改名失败也要给出可见告警（绝不静默吞）。
   */
  private quarantineCorruptFile(reason: string): RefinedMemoryFile {
    try {
      const stamped = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync(this.filePath, stamped);
      console.error(
        `[memory] 记忆文件损坏已隔离：${this.filePath} → ${stamped}（${reason}）。` +
        `已从空库启动；原文件保留在 .corrupt-* 可人工恢复。`
      );
    } catch (qerr: any) {
      console.error(`[memory] 记忆文件损坏且隔离失败：${this.filePath}（${reason}）：${qerr?.message || qerr}`);
    }
    const empty: RefinedMemoryFile = { meta: { version: '1.0.0', lastUpdated: 0, totalCards: 0 }, cards: [] };
    this.cache = empty;
    return empty;
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

    // 排序 = 0.7×effectiveWeight + 0.3×relevance；同分先按 count 再按
    // lastSeen **倒序**（G3 最小版：新旧事实并存时让较新者排前——旧排序
    // 同分回退稳定插入序 = 时间正序 = 旧事实恒在前，1B 取第一张即错）。
    filtered.sort((a, b) => {
      const ea = (a as any)._effective ?? 0;
      const eb = (b as any)._effective ?? 0;
      const ra = (a as any)._relevance ?? 0;
      const rb = (b as any)._relevance ?? 0;
      const sa = 0.7 * ea + 0.3 * ra;
      const sb = 0.7 * eb + 0.3 * rb;
      return sb - sa || (b as any).count - (a as any).count || (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
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
   * - 仅记录内存账本（进程级 injectionLedger），不写盘、不改 count/lastUsedAt；
   * - 事件（memory_injected）由调用方经 rollout 'context'/'agent' 事件落盘；
   * - 有意不影响衰减：count 驱动维持现状（refine/merge/refineCompactSignals），
   *   避免"注入≠使用"的自激励循环（对抗评审 A1/攻击1.1 的结论）。
   * 包C 缺陷8：账本从实例级升级为进程级（模块级 Map）——runAgentTask 每步
   * `new RefinedMemoryStore(...)` 的短命实例旧账本记账即弃（只写不读）；
   * /memory stats 的一次性 CLI 实例也永远查不到。进程级共享后同进程任意实例
   * 记账可查（仍不写盘，契约不变）。
   */
  markInjected(cardIds: string[], now = Date.now()): { injected: number; cardIds: string[] } {
    for (const id of cardIds) {
      if (!id) continue;
      const prev = injectionLedger.get(id);
      injectionLedger.set(id, { at: now, count: (prev?.count ?? 0) + 1 });
    }
    return { injected: cardIds.filter(Boolean).length, cardIds: cardIds.filter(Boolean) };
  }

  /** 查询注入账本：最近注入时间（/memory stats 与 ContextSnapshot 事件可用）。 */
  injectedAtOf(cardId: string): number | undefined {
    return injectionLedger.get(cardId)?.at;
  }

  /** 查询注入账本：累计注入次数（进程级，包C 缺陷7 stats 视图用）。 */
  injectedCountOf(cardId: string): number | undefined {
    return injectionLedger.get(cardId)?.count;
  }

  /**
   * markVerified（接口契约 v3 · 二态之二）：机器判定的"真实使用"。
   * 判定来源由调用方提供（确定性规则：任务内工具写入/验证文件集 ∩ 卡.referencedFiles ≠ ∅），
   * 本方法只负责效果：lastUsedAt=now + count+1 + 单次写盘 + 投影失效。
   * 这是衰减语义中唯一把"卡被真实复用"转为保鲜的通道。
   *
   * opts.excludeCreatedAfter：防"创建即自验证"——firstSeen ≥ 该时间戳（即本任务
   * 时间窗内新建）的卡被跳过，不计数。任务开始时间由调用方传入；否则本轮产的新卡
   * 若恰好命中注入集会自己给自己 +1（count 充值半衰期的帮凶）。
   */
  markVerified(
    cardIds: string[],
    now = Date.now(),
    opts?: { excludeCreatedAfter?: number }
  ): { updated: number; path: string } {
    if (cardIds.length === 0) return { updated: 0, path: this.filePath };
    const file = this.load();
    let updated = 0;
    for (const c of file.cards) {
      if (cardIds.includes(c.id)) {
        if (opts?.excludeCreatedAfter !== undefined &&
            (c.firstSeen ?? c.lastSeen ?? 0) >= opts.excludeCreatedAfter) {
          continue; // 本任务时间窗内新建的卡：创建 ≠ 复用，不 markVerified
        }
        (c as any).lastUsedAt = now;
        c.count = (c.count ?? 0) + 1;
        updated++;
      }
    }
    if (updated === 0) return { updated: 0, path: this.filePath };
    // 注意：不能走 save()——mergeAndCap 会把传入卡与已有卡按 count 累加（同一批
    // 对象 → 翻倍）。markVerified 是原位刷新，直写持久化。
    file.meta.lastUpdated = now;
    atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2));
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
    atomicWriteFileSync(this.filePath, JSON.stringify(existing, null, 2));
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
   * 包C 缺陷10：旧实现把 parsed.cards 原样写盘（非数组/畸形卡直接污染持久化层，
   * 下游 .map 抛 TypeError）。现校验：形状（复用 load 的 isValidMemoryFile）+
   * 大小上限（沿用 save 的 200KiB）；不合格 throw（CLI 捕获后显示导入失败），
   * 盘上文件保持不变。
   */
  import(jsonString: string, merge = true): { imported: number; total: number } {
    let parsed: RefinedMemoryFile;
    try {
      parsed = JSON.parse(jsonString) as RefinedMemoryFile;
    } catch {
      return { imported: 0, total: 0 };
    }
    if (!isValidMemoryFile(parsed)) {
      throw new Error('✗ 导入被拒绝：文件结构不合格（cards 必须是数组，且每张卡含字符串 id/summary）');
    }
    const sizeBytes = Buffer.byteLength(jsonString, 'utf-8');
    if (sizeBytes > MEMORY_LIMITS.MAX_FILE_SIZE_BYTES) {
      const sizeKiB = (sizeBytes / 1024).toFixed(1);
      const capKiB = Math.round(MEMORY_LIMITS.MAX_FILE_SIZE_BYTES / 1024);
      throw new Error(`✗ 导入被拒绝：文件 ${sizeKiB}KiB 超过上限 ${capKiB}KiB（MEMORY_LIMITS.MAX_FILE_SIZE_BYTES）`);
    }

    if (merge) {
      this.save(parsed.cards);
    } else {
      const file: RefinedMemoryFile = {
        meta: { version: parsed.meta?.version ?? '1.0.0', lastUpdated: Date.now(), totalCards: parsed.cards.length },
        cards: parsed.cards,
      };
      atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2));
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
   *   pin 卡冻结（decayWeight 恒 1.0，无衰减）；count≥2 半衰期 ×count（常用升权），
   *   乘数封顶 ×3——S 级缺陷修复：refine 可无限充值的通用卡 count 5+ 曾把半衰期
   *   推到 900 天（永生霸榜），封顶后半衰期上限 = 基础 ×3。
   */
  private calculateEffectiveWeight(card: RefinedMemoryCard, now: number): number {
    // pin 卡冻结衰减
    if ((card as any).pinned) return 1.0;
    const mc = (card.memoryCategory || 'general') as MemoryCategory;
    const last = Math.max(card.lastSeen ?? now, (card as any).lastUsedAt ?? 0); // 修复：?? 短路曾让复发卡的 lastSeen 刷新不可见
    const ageInDays = (now - last) / (24 * 60 * 60 * 1000);
    // count≥2 → 半衰期 ×count（常用卡衰减更慢）；封顶 ×3（防 count 充值永生）
    const halfLifeBase = this.getHalfLifeForCategory(mc);
    const countMultiplier = Math.min(Math.max(1, card.count ?? 1), 3);
    const halfLife = halfLifeBase * countMultiplier;
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
      atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2));
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
      atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2));
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
    // 包C 缺陷11：停用词表改 ≥2 字词表——旧单字集合与 w.length>=2 过滤矛盾
    // （词元恒 ≥2 字，单字词永远匹配不上，恒不过滤的死逻辑）。
    const stopWords = new Set([
      // 中文双字虚词（tokenize 以空白切词，中文需成词才可停用）
      '这个', '那个', '我们', '你们', '他们', '自己', '什么', '一个', '没有',
      '还是', '只是', '都是', '也是', '就是', '不是', '可以', '以及', '或者',
      '但是', '所以', '如果', '对于', '之后', '然后',
      // 英文高频虚词（≥2 字符，可被 length>=2 过滤命中）
      'the', 'and', 'for', 'with', 'this', 'that', 'was', 'were', 'are',
      'you', 'your', 'our', 'not', 'but', 'its', 'from',
    ]);
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
        // 包C 缺陷11：legacy 卡数值字段缺失 → ?? 0 / 回退链，防 Math.min/求和
        // 产 NaN（合并卡出生即 near-death：effectiveWeight=NaN 永不过注入线）。
        weight: Math.max(...g.map(c => c.weight ?? 0)),
        taskStyle: 'all',
        count: g.reduce((a, c) => a + (c.count ?? 0), 0),
        lastSeen: now,
        firstSeen: g.reduce((min, c) => Math.min(min, c.firstSeen ?? c.lastSeen ?? now), now),
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
      atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2));
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
    // 包C 缺陷1（2026-09-13）：分桶改按 kind 治理。旧实现按 category 分桶各留
    // MAX_PER_CATEGORY=10，而 success / preference(/remember) / merged / chat-fact
    // 卡全部 category:'OTHER' → 三类挤一个 10 张桶，第 11 张起静默截断最旧；
    // chat-fact 的 80 帽（chatFactMemory MAX_TOTAL_CARDS）与全局 200 帽不可达。
    // 新语义：
    //   - 每 kind 一桶，桶帽 MEMORY_LIMITS.MAX_PER_KIND
    //     （failure 40 / success 10 / preference 80——chat-fact 卡 kind 即
    //      'preference'，其 80 帽以该桶承载；未知 kind 回退 MAX_PER_CATEGORY）；
    //   - failure 桶内每 category 再细分 MAX_PER_KIND_PER_CATEGORY=10、类总 40；
    //   - 无 kind 旧卡归 'failure'（对齐 loadFiltered 的归一化）；
    //   - 桶内排序沿用现有：lastSeen 倒序 + weight 降序；
    //   - 全局 MAX_TOTAL_CARDS=200 不变。
    const byKind = new Map<string, RefinedMemoryCard[]>();
    for (const c of cards) {
      const kind = (c as any).kind ?? 'failure';
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind)!.push(c);
    }
    const capOf = (kind: string): number => MEMORY_LIMITS.MAX_PER_KIND[kind] ?? MEMORY_LIMITS.MAX_PER_CATEGORY;
    const recencyDesc = (a: RefinedMemoryCard, b: RefinedMemoryCard): number =>
      (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || (b.weight ?? 0) - (a.weight ?? 0);
    // 审查 CONCERN-7（2026-09-13）：pinned 卡（/memory remember --pin 的用户显式
    // 意图）免容量淘汰——preference 桶由 chat-fact 与手工偏好共享，chat 洪流每轮
    // 刷新 lastSeen，按近期优先淘汰必然把 pinned 偏好挤出。规则：pinned 全保，
    // 非 pinned 竞争剩余名额（pinned 可超帽——用户显式意图高于容量治理）。
    const isPinned = (c: RefinedMemoryCard): boolean => (c as any).pinned === true;
    const keepWithPinned = (arr: RefinedMemoryCard[], cap: number): RefinedMemoryCard[] => {
      const pinned = arr.filter(isPinned);
      const rest = arr.filter((c) => !isPinned(c));
      return [...pinned, ...rest.slice(0, Math.max(0, cap - pinned.length))];
    };

    const limited: RefinedMemoryCard[] = [];
    for (const [kind, arr] of byKind) {
      arr.sort(recencyDesc);
      const cap = capOf(kind);
      if (kind === 'failure') {
        // failure 类内每 category 10 张、类总 40
        const byCategory = new Map<string, RefinedMemoryCard[]>();
        for (const c of arr) {
          const cat = c.category || 'OTHER';
          if (!byCategory.has(cat)) byCategory.set(cat, []);
          byCategory.get(cat)!.push(c);
        }
        const kept: RefinedMemoryCard[] = [];
        for (const [, catArr] of byCategory) {
          catArr.sort(recencyDesc);
          kept.push(...keepWithPinned(catArr, MEMORY_LIMITS.MAX_PER_KIND_PER_CATEGORY));
        }
        kept.sort(recencyDesc);
        limited.push(...keepWithPinned(kept, cap));
      } else {
        arr.sort(recencyDesc);
        limited.push(...keepWithPinned(arr, cap));
      }
    }
    // 全局硬上限（pinned 同样免淘汰）
    if (limited.length > MEMORY_LIMITS.MAX_TOTAL_CARDS) {
      const pinned = limited.filter(isPinned);
      const rest = limited.filter((c) => !isPinned(c));
      rest.sort((a, b) => (b.weight ?? 0) * (b.count ?? 0) - (a.weight ?? 0) * (a.count ?? 0));
      return [...pinned, ...rest.slice(0, Math.max(0, MEMORY_LIMITS.MAX_TOTAL_CARDS - pinned.length))];
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

  // 写集提取器已收敛到共享模块 src/memory/trajectoryFiles.ts（extractWrittenFilePaths
  // ——含 bash 重定向/tee/引号/盘符），refine 的 writtenFiles 由调用方提取后传入。
  // 旧 extractWrittenFilesFromTrajectory 只认旧轨迹形状 {name/tool,args}，对真实
  // {toolName, params:[{name,value}]} 恒提取空 → referencedFiles 断链，已删除。

  private normPath(p: string): string {
    return normalizeRelPath(p);
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
