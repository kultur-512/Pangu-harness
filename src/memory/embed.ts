/**
 * embed.ts — Panshalach 语义检索底座（P4 · v0 草案）
 *
 * 目标：在零外部依赖前提下，给记忆卡注入路径提供"语义相似度"打分能力。
 * 设计：v0 用 LocalNGramHashProvider（字符 2-gram + 4096 哈希桶 + 余弦），
 *       预留 EmbeddingProvider 接口给后续国产 embedding 可插拔。
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
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ===== 4. LocalNGramHashProvider 默认实现 =====

/** 默认桶数（字符 2-gram 哈希空间）*/
export const DEFAULT_BUCKETS = 4096;

/**
 * LocalNGramHashProvider —— 字符 2-gram 哈希 + L2 归一化
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
 *   - 召回精度不如真 embedding，但作为 v0 已可用
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

/** 默认 provider 工厂（v0 直接返回 LocalNGramHashProvider）*/
export function createDefaultProvider(buckets?: number): EmbeddingProvider {
  return new LocalNGramHashProvider(buckets);
}