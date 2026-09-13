// src/cli/repl/tokenEstimate.ts
// 共享 token 估算 / 模型窗口解析工具。
//
// 为什么独立成模块：压缩触发（compactService 0.85 阈值）、loop 裁剪预算
// （VerifyCritiqueLoop 70% 预算线）、REPL 计量（TurnController TopBar）三处
// 都在做"字符 → token"换算与窗口解析，此前各持一份 chars/4 启发式且互不同源。
// 本模块是唯一权威实现：
//   - estTokens：CJK-aware（CJK ≈ 1.5 token/字符，ascii ≈ 0.25 token/字符）
//   - safeSlice：码点对齐截断（孤立代理项回退一位，不产半个 emoji）
//   - resolveWindowTokens：env 覆盖 > provider 真值 > 32768 保守值
// 两侧若分叉（例如 env 只在一侧生效），UI 压缩阈值与 loop 裁剪预算会不一致。

/** 遗留 256000 哨兵（ProviderRegistry 对未知模型窗口的占位值）。 */
export const CONTEXT_LENGTH_SENTINEL = 256000;

/** 未知窗口的保守回落值。 */
export const DEFAULT_WINDOW_TOKENS = 32768;

/**
 * CJK 判定（统一按 1.5 token/字符）：URO + 扩展A + 中文标点/全角 + 假名 +
 * 谚文 + 兼容表意。旧实现只认 0x4e00-0x9fff，假名/谚文/全角标点被按 ascii
 * 低估 6 倍。
 */
function isCjkCodePoint(code: number): boolean {
  return (code >= 0x3000 && code <= 0x303f)   // 中文标点（。、《》……）
    || (code >= 0x3040 && code <= 0x30ff)   // 假名（平假名/片假名）
    || (code >= 0x3400 && code <= 0x4dbf)   // CJK 扩展 A
    || (code >= 0x4e00 && code <= 0x9fff)   // CJK 统一表意文字（URO）
    || (code >= 0xac00 && code <= 0xd7af)   // 谚文（韩文音节）
    || (code >= 0xf900 && code <= 0xfaff)   // CJK 兼容表意文字
    || (code >= 0xff00 && code <= 0xffef);  // 全角/半角形式（，！／半角片假名）
}

/** 确定性 token 估算 — ceil(asciiLen/4 + cjkLen×1.5)。纯函数。 */
export function estTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)!;
    if (isCjkCodePoint(code)) cjk++;
    else ascii++;
  }
  return Math.ceil(ascii / 4 + cjk * 1.5);
}

/**
 * 码点对齐截断（String.prototype.slice 的安全替身）：start/end 落在代理对
 * （emoji 等 surrogate pair）中间时回退一位，保证产物不含孤立代理项。
 * 语义对齐 slice：支持负索引、end 缺省到串尾、start>=end 返回空串。
 */
export function safeSlice(text: string, start: number, end?: number): string {
  const s = String(text ?? '');
  const len = s.length;
  let a = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let b = end === undefined ? len : (end < 0 ? Math.max(len + end, 0) : Math.min(end, len));
  if (a >= b) return '';
  // start 落在代理对中间（当前码元是低位代理、前一位是高位代理）→ 跳过孤立低位
  if (a > 0 && a < len) {
    const cur = s.charCodeAt(a);
    const prev = s.charCodeAt(a - 1);
    if (cur >= 0xdc00 && cur <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) a += 1;
  }
  if (a >= b) return '';
  // end 落在代理对中间（前一码元是高位代理、当前是低位代理）→ 回退一位丢孤立高位
  if (b < len && b > a) {
    const prev = s.charCodeAt(b - 1);
    const cur = s.charCodeAt(b);
    if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) b -= 1;
  }
  if (a >= b) return '';
  return s.slice(a, b);
}

/**
 * 解析当前模型的上下文窗口（tokens）。
 * 走 provider.getModelContextLength 通道；≤0 或遗留 256000 哨兵视为
 * unknown → 回落 32768 保守值（8K 模型按 256K 预算跑长任务必爆——预算必须挂真值）。
 */
export function resolveWindowTokens(provider: unknown, model: string): number {
  try {
    // PANSHA_CTX_WINDOW 显式覆盖优先（与 sseInteractive UI 侧同一优先级——
    // env 覆盖时两侧若分叉，UI 压缩阈值与 loop 裁剪预算会不一致）。
    const env = Number(process.env.PANSHA_CTX_WINDOW);
    if (Number.isFinite(env) && env > 0) return env;
    const n = Number((provider as any)?.getModelContextLength?.(model));
    if (Number.isFinite(n) && n > 0 && n !== CONTEXT_LENGTH_SENTINEL) return n;
  } catch {}
  return DEFAULT_WINDOW_TOKENS;
}
