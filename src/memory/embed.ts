/**
 * embed.ts — Panshalach 记忆检索相似度底座（P4 · v0 草案）
 *
 * 诚实口径：v0 的 LocalNGramHashProvider 是「字符 2-gram + FNV-1a 哈希 + 4096 桶
 * + L2 归一化余弦」的词面扩展（lexical n-gram hash），衡量的是字面相似度，不是
 * 真正的语义 embedding。真 embedding 经 PANSHA_EMBEDDING=remote 可插拔
 * （RemoteEmbeddingProvider，OpenAI 兼容 /embeddings），缺配置/异常自动降级
 * 回词面 n-gram，绝不崩主流程。
 *
 * 状态：U1 起草（2026-09-04 周五前置日）；9/14 接口契约 PR 前需 Leader 拍板签名。
 * 作者：zhaotianang（Main-B / W4）
 *
 * 兼容性：与 memory v3 (bf5f4a7) 无冲突；本模块不读 RefinedMemoryStore，
 *         RefinedMemoryStore.loadFiltered 在 U2 集成时调用本模块。
 */

// ===== 1. 类型定义 =====

/** 稠密向量（v0 = 4096 维 L2 归一化后的非负稀疏计数）*/
export type DenseVector = number[];

/** 余弦相似度结果 ∈ [-1, 1]（v0 因向量非负，实际 ∈ [0, 1]）*/
export type CosineScore = number;

// ===== 2. 接口 =====

/**
 * EmbeddingProvider —— 语义向量提供方抽象
 *
 * v0 默认实现：LocalNGramHashProvider（零依赖、本地、确定性）
 * 后续可替换：昇腾 MindIE embedding / 国产向量库 / 远端 API 等
 */
export interface EmbeddingProvider {
  /** 提供方名称（'local-ngram' / 'remote-xxx'），用于缓存键与日志 */
  readonly name: string;

  /** 向量维度（v0 默认 4096）*/
  readonly dim: number;

  /** 把一段文本压成固定维度的稠密向量。v0 默认同步，预留 Promise 包装 */
  embed(text: string): DenseVector | Promise<DenseVector>;

  /** 批量 embed（可选；v0 默认实现可同步循环）。节省 N 次调用开销 */
  embedBatch?(texts: string[]): DenseVector[] | Promise<DenseVector[]>;
}

// ===== 3. 余弦相似度工具 =====

/**
 * 把任意标量"规整"为有限实数（undefined / null / NaN / Infinity → 0）
 * 这是 cosineSimilarity 的内部辅助：保证结果有限 + 不抛错 + 注释承诺的"视作 0"
 */
function sanitizeScalar(x: unknown): number {
  if (typeof x !== 'number') return 0;
  return Number.isFinite(x) ? x : 0;
}

/**
 * 余弦相似度：cos(θ) = (a · b) / (||a|| · ||b||)
 *
 * 输入：两个同维度向量
 * 输出：[-1, 1] 的相似度
 *
 * 边界：
 * - 任一向量为零向量 → 返回 0（避免除零）
 * - 维度不一致 → 抛 Error（开发期捕获）
 * - 任一向量含 undefined/NaN → 视作 0
 */
export function cosineSimilarity(a: DenseVector, b: DenseVector): CosineScore {
  if (a.length !== b.length) {
    throw new Error(
      `[cosineSimilarity] dimension mismatch: a=${a.length}, b=${b.length}`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    // undefined / null / NaN / Infinity 都视作 0（保证结果有限 + 不抛错）
    const ai = sanitizeScalar(a[i]);
    const bi = sanitizeScalar(b[i]);
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0 || !Number.isFinite(denom)) return 0;

  const result = dot / denom;
  return Number.isFinite(result) ? result : 0;
}

// ===== 4. LocalNGramHashProvider 默认实现 =====

/** 默认桶数（字符 2-gram 哈希空间）*/
export const DEFAULT_BUCKETS = 4096;

/**
 * LocalNGramHashProvider —— 字符 2-gram + FNV-1a 哈希 + L2 归一化
 *
 * 诚实口径：这是「词面扩展（lexical n-gram hash）」，不是语义 embedding——它衡量
 * 的是字符 2-gram 的字面重叠，不含语义理解。"语义底座"之名沿用历史，能力边界是
 * 词面相似度。真语义 embedding 见 RemoteEmbeddingProvider（PANSHA_EMBEDDING=remote）。
 *
 * 算法：
 *   1. 把文本前后各 pad 一格空格，滑窗切成 2 字符 grams
 *   2. 每个 gram 用 32-bit FNV-1a 哈希取模 buckets 得到桶号
 *   3. 桶计数 +1，得到 buckets 维稀疏计数向量
 *   4. L2 归一化（除以 ||v||）
 *
 * 性质：
 *   - 同文本 embed() 幂等（确定性，无随机）
 *   - 零网络、零依赖、零成本
 *   - 中文 / 代码 / 英文混合可用
 *   - 召回精度不如真 embedding，但作为 v0 默认已可用
 *
 * 例：
 *   const p = new LocalNGramHashProvider();   // dim = 4096
 *   const v = p.embed('openPangu 网络超时'); // 4096 维 L2-normalized
 */
export class LocalNGramHashProvider implements EmbeddingProvider {
  readonly name = 'local-ngram';
  readonly dim: number;

  constructor(buckets: number = DEFAULT_BUCKETS) {
    if (!Number.isInteger(buckets) || buckets <= 0 || buckets > 65536) {
      throw new Error(
        `[LocalNGramHashProvider] buckets must be int in (0, 65536], got ${buckets}`,
      );
    }
    this.dim = buckets;
  }

  embed(text: string): DenseVector {
    const v = new Array<number>(this.dim).fill(0);
    if (!text) return v;

    // 字符 2-gram 滑窗（含 padding：开头/结尾各加一格空格）
    const padded = ` ${text} `;
    for (let i = 0; i < padded.length - 1; i++) {
      const gram = padded.substring(i, i + 2);
      const bucket = this.hash(gram);
      v[bucket] = (v[bucket] ?? 0) + 1;
    }

    // L2 归一化
    return this.l2Normalize(v);
  }

  embedBatch(texts: string[]): DenseVector[] {
    return texts.map((t) => this.embed(t));
  }

  /** 32-bit FNV-1a 哈希（无依赖、稳定、字符串友好）*/
  private hash(s: string): number {
    let h = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // FNV prime *= 16777619
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % this.dim;
  }

  /** L2 归一化（in-place 拷贝，不修改入参）*/
  private l2Normalize(v: DenseVector): DenseVector {
    let norm = 0;
    for (let i = 0; i < v.length; i++) {
      norm += (v[i] ?? 0) ** 2;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return v.slice();
    return v.map((x) => (x ?? 0) / norm);
  }
}

// ===== 4b. RemoteEmbeddingProvider（真语义 embedding · env 开关 · 可插拔骨架） =====

/** 真 embedding 的 env 配置键。 */
export const REMOTE_EMBED_ENV = {
  BASE_URL: 'PANSHA_EMBED_BASE_URL',
  API_KEY: 'PANSHA_EMBED_API_KEY',
  MODEL: 'PANSHA_EMBED_MODEL',
} as const;

/** PANSHA_EMBEDDING 取 'remote' 时启用真 embedding（否则词面 n-gram）。 */
export const EMBEDDING_MODE_ENV = 'PANSHA_EMBEDDING';

/**
 * RemoteEmbeddingProvider —— OpenAI 兼容 /embeddings 真语义 embedding 骨架
 *
 * 构造时从 env 读配置：PANSHA_EMBED_BASE_URL / PANSHA_EMBED_API_KEY /
 * PANSHA_EMBED_MODEL。真正的远端调用是异步的（fetch），而当前检索路径
 * RefinedMemoryStore.computeSemanticScores → toSyncVector 是同步的，无法消费
 * Promise。因此：
 *   - embed()（同步契约）内部持有 LocalNGramHashProvider 作同步兜底，返回词面
 *     n-gram 向量（同步、确定、不抛错）——PANSHA_EMBEDDING=remote 时同步路径
 *     仍能拿到词面扩展，不再降级纯词面；
 *   - 真远程 /embeddings 调用实现在 embedAsync()（async），待将来异步检索路径
 *     落地后由 embed()/embedBatch() 委托，本期先留骨架 + 文档说明。
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'remote';
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  /** 同步兜底：词面 n-gram（同 LocalNGramHashProvider，dim 一致）。 */
  private readonly fallback: LocalNGramHashProvider;

  constructor(buckets: number = DEFAULT_BUCKETS) {
    const env = typeof process !== 'undefined' ? process.env : {};
    this.baseUrl = env[REMOTE_EMBED_ENV.BASE_URL]?.trim();
    this.apiKey = env[REMOTE_EMBED_ENV.API_KEY]?.trim();
    this.model = env[REMOTE_EMBED_ENV.MODEL]?.trim();
    this.fallback = new LocalNGramHashProvider(buckets);
  }

  /** 向量维度与同步兜底 provider 一致（n-gram 桶数）；真远程维度见 embedAsync 返回值。 */
  get dim(): number {
    return this.fallback.dim;
  }

  /** 配置是否齐全（baseUrl + apiKey + model 三者都在）。 */
  get configured(): boolean {
    return !!(this.baseUrl && this.apiKey && this.model);
  }

  /**
   * 同步 embed：内部持有 LocalNGramHashProvider 兜底，同步、确定、不抛错。
   * 返回词面 n-gram 扩展向量；真远程 /embeddings 走 embedAsync()（async）。
   */
  embed(text: string): DenseVector {
    return this.fallback.embed(text);
  }

  /**
   * OpenAI 兼容 /embeddings 真调用（async）。POST { model, input } → data[0].embedding。
   * 本期只作可插拔骨架存在，尚未被同步检索路径消费（见 embed() 的 TODO）。
   */
  async embedAsync(text: string): Promise<DenseVector> {
    if (!this.configured) {
      throw new Error(
        `[RemoteEmbeddingProvider] missing env: ${REMOTE_EMBED_ENV.BASE_URL}, ` +
        `${REMOTE_EMBED_ENV.API_KEY}, ${REMOTE_EMBED_ENV.MODEL}`,
      );
    }
    const url = `${this.baseUrl!.replace(/\/+$/, '')}/embeddings`;
    const res: Response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`[RemoteEmbeddingProvider] /embeddings ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const emb = json?.data?.[0]?.embedding;
    if (!Array.isArray(emb)) {
      throw new Error('[RemoteEmbeddingProvider] unexpected /embeddings response: missing data[0].embedding');
    }
    return emb;
  }
}

// ===== 5. 缓存层（U2 落地）—— 占位接口 =====

/**
 * EmbeddingCache —— 持久化缓存抽象
 *
 * 落盘：.panshalach-embed-cache.json（U2 才会实装 FileEmbeddingCache）
 * 键：sha1(text) 或 text 自身（小文本可直接用）
 * 值：DenseVector
 *
 * 状态：U2 才会实装；此处仅占位接口
 */
export interface EmbeddingCache {
  get(text: string): DenseVector | undefined;
  set(text: string, vec: DenseVector): void;
  has(text: string): boolean;
  size(): number;
  clear?(): void;
}

// ===== 6. 工厂 =====

/** 默认 provider 工厂（v0 直接返回 LocalNGramHashProvider，词面 n-gram）。 */
export function createDefaultProvider(buckets?: number): EmbeddingProvider {
  return new LocalNGramHashProvider(buckets);
}

/**
 * 可插拔 provider 工厂：PANSHA_EMBEDDING=remote 且 env 配置齐全 → RemoteEmbeddingProvider
 * （其同步 embed() 内持 LocalNGramHashProvider 词面兜底，真远程走 embedAsync()）；否则一律
 * 返回词面 n-gram（LocalNGramHashProvider）。PANSHA_EMBEDDING=remote 但缺配置时也
 * 回退 n-gram，绝不因缺配置崩溃主流程。
 */
export function createConfiguredProvider(buckets?: number): EmbeddingProvider {
  const env = typeof process !== 'undefined' ? process.env : {};
  if (env[EMBEDDING_MODE_ENV]?.trim() === 'remote') {
    const remote = new RemoteEmbeddingProvider(buckets);
    if (remote.configured) return remote;
  }
  return new LocalNGramHashProvider(buckets);
}

// ===== 7. 进程级向量缓存 + 增量批量接口（B4 · 2026-09-13 混合检索配套） =====

import { createHash } from 'node:crypto';

/** 可嵌入卡最小形状（RefinedMemoryStore 的候选卡投影）。 */
export interface EmbeddableCard {
  id: string;
  summary: string;
}

interface CardVectorEntry {
  /** sha1(summary)——摘要变才重嵌 */
  hash: string;
  vec: DenseVector;
}

/** 进程级向量缓存：key = cardId。跨回合复用（嵌入 200 卡重算仅 ~10ms，
 *  但增量命中后接近 0）；纯内存不写盘。
 *  【6】FIFO 帽（2026-09-13 迭代包）：此前无上限——长跑会话卡 id 无限增长
 *  （每张新卡 set 一条永不淘汰）。size ≥ 1024 时按插入序删最旧 key。 */
const cardVectorCache = new Map<string, CardVectorEntry>();
export const CARD_VECTOR_CACHE_CAP = 1024;

const sha1Hex = (s: string): string => createHash('sha1').update(s).digest('hex');

function toSyncVector(v: DenseVector | Promise<DenseVector>): DenseVector {
  // v0 provider 全部同步。Promise 形态（未来远端 provider）无法被同步混合排序
  // 消费——此处显式抛错，由调用方（RefinedMemoryStore 混合排序）的 try/catch
  // 降级到纯词面排序兜底。
  if (v && typeof (v as Promise<DenseVector>).then === 'function') {
    throw new Error('[embed] async provider is not supported by the synchronous hybrid ranking path');
  }
  return v as DenseVector;
}

/**
 * 增量批量嵌入（B4）：key=cardId，hash=sha1(summary)，hash 变才重嵌。
 * 返回 Map<cardId, 向量>（与入参卡一一对应，未知/缺 id 的卡跳过）。
 */
export function embedCards(
  cards: readonly EmbeddableCard[],
  provider: EmbeddingProvider = createDefaultProvider(),
): Map<string, DenseVector> {
  const out = new Map<string, DenseVector>();
  for (const c of cards ?? []) {
    const id = String(c?.id ?? '');
    if (!id) continue;
    const text = String(c?.summary ?? '');
    const hash = sha1Hex(text);
    const hit = cardVectorCache.get(id);
    if (hit && hit.hash === hash) {
      out.set(id, hit.vec);
      continue;
    }
    const vec = toSyncVector(provider.embed(text));
    // 【6】FIFO 帽：满员先按插入序删最旧 key 再入槽（对已存在 key 的 set 不改变
    // 插入序、也不增条目，故只在"新 key + 满员"时淘汰）。
    if (!cardVectorCache.has(id) && cardVectorCache.size >= CARD_VECTOR_CACHE_CAP) {
      const oldest = cardVectorCache.keys().next().value;
      if (oldest !== undefined) cardVectorCache.delete(oldest);
    }
    cardVectorCache.set(id, { hash, vec });
    out.set(id, vec);
  }
  return out;
}

/** 查询向量（即时嵌入，不入卡缓存——查询文本几乎不重复）。 */
export function embedQuery(text: string, provider: EmbeddingProvider = createDefaultProvider()): DenseVector {
  return toSyncVector(provider.embed(String(text ?? '')));
}

/** 当前缓存条目数（测试/调试可见性）。 */
export function embedCacheSize(): number {
  return cardVectorCache.size;
}

/** 清空向量缓存（测试隔离用）。 */
export function resetEmbedCacheForTest(): void {
  cardVectorCache.clear();
}