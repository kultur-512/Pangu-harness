// src/cli/repl/tokenEstimate.ts
// 共享 token 估算 / 模型窗口解析工具。
//
// 为什么独立成模块：压缩触发（compactService 0.85 阈值）、loop 裁剪预算
// （VerifyCritiqueLoop 70% 预算线）、REPL 计量（TurnController TopBar）三处
// 都在做"字符 → token"换算与窗口解析，此前各持一份 chars/4 启发式且互不同源。
// 本模块是唯一权威实现：
//   - estTokens：CJK-aware（ascii ≈ 4 字符/token，CJK ≈ 1.5 字符/token）
//   - resolveWindowTokens：env 覆盖 > provider 真值 > 32768 保守值
// 两侧若分叉（例如 env 只在一侧生效），UI 压缩阈值与 loop 裁剪预算会不一致。

/** 遗留 256000 哨兵（ProviderRegistry 对未知模型窗口的占位值）。 */
export const CONTEXT_LENGTH_SENTINEL = 256000;

/** 未知窗口的保守回落值。 */
export const DEFAULT_WINDOW_TOKENS = 32768;

/** 确定性 token 估算 — ceil(asciiLen/4 + cjkLen×1.5)。纯函数。 */
export function estTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else ascii++;
  }
  return Math.ceil(ascii / 4 + cjk * 1.5);
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
