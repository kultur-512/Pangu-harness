// src/model/errorClassify.ts
// M2-5 错误分类器（docs/panshalach/PLAN-0.8-FOUNDATION.md §3 M2-5）。
//
// classifyApiError(e) → 'rate_limit'|'server'|'timeout'|'context_overflow'
//                        |'auth'|'billing'|'network'|'unknown'
//
// 用途：
// 1. withRetry 接入：auth/billing/context_overflow 类 retryable=false 快速失败
//    （不再白吃 5 次退避）；timeout/rate_limit/server/network 类维持重试。
// 2. VerifyCritiqueLoop 捕获 context_overflow → 强制 compact 后重试本步（≤1 次）。
//
// 判定输入是 openai-compatible 客户端抛出的错误对象（status/body/network/
// timeout 等字段），无 status 时退回 body/message 模式匹配。纯函数、零依赖。

export type ApiErrorClass =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'context_overflow'
  | 'auth'
  | 'billing'
  | 'network'
  | 'unknown';

/** context_overflow 状态白名单（多网关方言：400/413/422）。 */
const OVERFLOW_STATUS = new Set([400, 413, 422]);

/** context_overflow 正文模式白名单（多网关方言：OpenAI/Anthropic/本地网关/国产网关）。 */
const OVERFLOW_PATTERNS: RegExp[] = [
  /context length/i, // "maximum context length exceeded"
  /maximum context/i,
  /too many tokens/i,
  /token limit/i, // "token limit exceeded" / "hit the token limit"
  /prompt (?:is )?too long/i,
  /input (?:is )?too long/i,
  /context.{0,12}(?:window|size).{0,12}exceed/i,
  /超出.{0,8}(?:上下文|长度|令牌|token)/i,
  /上下文.{0,8}(?:超|过长|上限|溢出)/i,
  /token.{0,8}(?:超|过长|上限)/i,
];

/** billing 正文模式（429 与 4xx 下优先于 rate_limit）。 */
const BILLING_PATTERNS: RegExp[] = [
  /insufficient (?:balance|quota|credits|funds)/i,
  /out of credits/i,
  /billing/i,
  /quota exceeded/i,
  /payment required/i,
  /余额不足/i,
  /欠费/i,
];

const SERVER_STATUS_MIN = 500;

export function classifyApiError(e: any): ApiErrorClass {
  if (!e || typeof e !== 'object') return 'unknown';

  // 客户端层已显式标注的类（如 err.timeout）优先。
  if (e.apiErrorClass && typeof e.apiErrorClass === 'string') {
    const known: ApiErrorClass[] = [
      'rate_limit', 'server', 'timeout', 'context_overflow',
      'auth', 'billing', 'network', 'unknown',
    ];
    if ((known as string[]).includes(e.apiErrorClass)) return e.apiErrorClass as ApiErrorClass;
  }

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const body = String(e?.body ?? e?.responseBody ?? e?.message ?? '');

  // 用户主动中止（TASK_ABORTED / ABORTED 码）不属于任何 API 错误类——
  // 判 unknown 且不可重试（isRetryableErr 对此无任何可重试标记）。
  if (e?.code === 'ABORTED' && /TASK_ABORTED|aborted/i.test(String(e?.message ?? ''))) {
    return 'unknown';
  }

  // auth：401/403（或正文含显式鉴权失败字样）
  if (status === 401 || status === 403) return 'auth';
  if (!status && /invalid (?:api )?key|unauthorized|authentication (?:failed|error)|api.?key.{0,16}(?:invalid|wrong)/i.test(body)) {
    return 'auth';
  }

  // context_overflow 优先于 billing/rate_limit：正文同时含余额与超窗字样时，
  // 超窗是可恢复路径（强制 compact 重试），余额类应快速失败——可操作者优先。
  if (status !== undefined && OVERFLOW_STATUS.has(status)
    && OVERFLOW_PATTERNS.some((re) => re.test(body))) {
    return 'context_overflow';
  }

  // billing：402 显式；429/4xx + 余额/配额正文（优先级高于 rate_limit）
  if (status === 402) return 'billing';
  if (status !== undefined && status >= 400 && status < 500 && BILLING_PATTERNS.some((re) => re.test(body))) {
    return 'billing';
  }

  // rate_limit：429（不含 billing 正文）
  if (status === 429) return 'rate_limit';
  if (/rate.?limit|too many requests/i.test(body)) return 'rate_limit';

  // server：5xx（含网关自定义码 522/524/529）
  if (status !== undefined && status >= SERVER_STATUS_MIN) return 'server';

  // timeout：客户端层标注，或裸 AbortError（无 ABORTED 码、非用户中止）
  if (e.timeout === true) return 'timeout';
  if (e?.name === 'AbortError' && e?.code !== 'ABORTED') return 'timeout';

  // network：传输类（客户端标注 / fetch failed / TypeError 传输消息）
  if (e.network === true) return 'network';
  if (/fetch failed|terminated|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|network error/i.test(body)) return 'network';
  if (e?.name === 'TypeError' && /fetch|network|terminated/i.test(body)) return 'network';

  return 'unknown';
}

/** 该错误类是否值得在客户端层指数退避重试。 */
export function isRetryableErrorClass(cls: ApiErrorClass): boolean {
  switch (cls) {
    case 'auth':
    case 'billing':
    case 'context_overflow': // 重试由 loop 的强制 compact 路径接管（压缩后才有意义）
      return false;
    case 'rate_limit':
    case 'server':
    case 'timeout':
    case 'network':
      return true;
    case 'unknown':
    default:
      // 未知类不在此裁决——交由既有字段规则（retryable/emptyResponse/status）决定
      return true;
  }
}
