// src/model/openai-compatible.ts
// Generic OpenAI-compatible client using Node global fetch (zero deps).
// Implements listModels and complete for providers like scnet.
//
// Contract:
// - baseUrl should be the prefix up to /v1 (e.g. https://api.scnet.cn/api/llm/v1)
// - listModels calls GET {baseUrl}/models
// - complete calls POST {baseUrl}/chat/completions
//
// All failures are thrown with useful info; callers decide how to surface.

import { classifyApiError } from './errorClassify.js';

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number; // default 120000
  /**
   * 流式通道整体 deadline（毫秒，从请求开始计；headers + 全部 SSE chunk）。
   * 默认 10 分钟——SSE 中途停滞此前会永远卡在 reader.read()（包D 修复）。
   */
  streamDeadlineMs?: number;
  /** 附加请求头（网关场景），与默认 Authorization 合并 */
  headers?: Record<string, string>;
}

/** streaming chunk type (mirrors cli/repl/types ModelStreamChunk to avoid import cycle) */
export interface ModelStreamChunk {
  type: 'text' | 'thinking' | 'toolCalls';
  text?: string;
  /** 仅 type:'toolCalls'：SSE delta.tool_calls 增量拼接出的完整调用 */
  toolCalls?: unknown[];
  /**
   * finish_reason 透传（'length' = max_tokens 截断）。
   * streamChat 在含 finish_reason 的尾 delta 上标记；回退路径由
   * chunksFromCompleteOutput 从 doComplete 的 truncated 对象转写。
   */
  finishReason?: string;
}

/**
 * 结构化输出（镜像 cli/repl/types ModelClientOutput，避免 import cycle）。
 * complete() 在网关返回原生 message.tool_calls 时返回该对象，
 * VerifyCritiqueLoop 的 preParsedToolCalls 通道直接消费，无需再走文本解析。
 */
export interface OpenAICompatOutput {
  content?: string;
  raw?: string;
  toolCalls?: unknown[];
  detectedFormat?: string;
  /** finish_reason==='length'（max_tokens 截断）→ true，loop 禁判 answered。 */
  truncated?: boolean;
}

/** 内部 ToolCall 形状（镜像 src/types/toolCall.ts ToolCall，避免 import cycle） */
export interface OpenAICompatToolCall {
  toolName: string;
  params: Array<{ name: string; value: string }>;
  rawBlock: string;
  format?: string;
}

/** OpenAI 原生 tool_call → 内部 ToolCall（function.arguments JSON → params 键值对） */
export function convertOpenAIToolCalls(rawToolCalls: unknown[]): OpenAICompatToolCall[] {
  const out: OpenAICompatToolCall[] = [];
  if (!Array.isArray(rawToolCalls)) return out;
  for (const tc of rawToolCalls) {
    const t: any = tc;
    const name = t?.function?.name;
    if (typeof name !== 'string' || !name) continue;
    let params: Array<{ name: string; value: string }> = [];
    const args = t?.function?.arguments;
    if (typeof args === 'string' && args.trim()) {
      try {
        const parsed = JSON.parse(args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          params = Object.entries(parsed).map(([k, v]) => ({
            name: k,
            value: typeof v === 'string' ? v : JSON.stringify(v),
          }));
        } else {
          params = [{ name: 'args', value: JSON.stringify(parsed) }];
        }
      } catch {
        params = [{ name: 'args', value: args }];
      }
    } else if (args && typeof args === 'object') {
      params = Object.entries(args as Record<string, unknown>).map(([k, v]) => ({
        name: k,
        value: typeof v === 'string' ? v : JSON.stringify(v),
      }));
    }
    out.push({
      toolName: name,
      params,
      rawBlock: JSON.stringify(t),
      format: 'openai-json',
    });
  }
  return out;
}

/**
 * 0.8 P1（M1-PROTOCOL）消息数组通道的原子消息
 * （镜像 src/cli/repl/types.ts ChatMessage，避免 import cycle；两处同步维护）。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role==='tool' 时：对应的工具调用 id（原生 FC 网关） */
  toolCallId?: string;
  /** 工具名（文本协议网关的降级标注） */
  name?: string;
  /**
   * 0.8 P1：assistant 消息携带的原生 tool_calls 数组（原样透传进请求体，
   * 用于多轮工具调用的会话续接）。仅在原生 FC 网关模式有意义。
   */
  toolCalls?: unknown[];
}

/**
 * 0.8 P1：ChatMessage[] → 请求体 wire 形状。
 * - system/user/assistant：{role, content} 原样映射（顺序即数组顺序，system 首位由调用方保证）；
 * - assistant 携带 toolCalls 时透传原生 tool_calls 数组（多轮工具调用续接）；
 * - role==='tool' 按网关能力二选一：nativeTools（opts.tools 存在，原生 FC 模式）
 *   → { role:'tool', tool_call_id }；否则文本降级 → role:'user' + `【工具 <name> 结果】` 标注。
 */
export function toWireMessages(messages: ChatMessage[], nativeTools: boolean): any[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      if (nativeTools) {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      const label = m.name ? `【工具 ${m.name} 结果】\n` : '';
      return { role: 'user', content: label + m.content };
    }
    const out: any = { role: m.role, content: m.content };
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls;
    }
    return out;
  });
}

export interface OpenAICompatClient {
  listModels(): Promise<string[]>;
  /** 网关返回原生 tool_calls 时返回结构化对象（detectedFormat:'openai-json'），否则返回文本 */
  complete(prompt: string, opts?: CompleteOptions): Promise<string | OpenAICompatOutput>;
  /** streamChat 回退专用（0.7.4 B4）：withRetry + emptyResponse 语义的非流式回退。 */
  completeLikeFallback(prompt: string, opts?: CompleteOptions): Promise<string | OpenAICompatOutput>;
  /** 0.8 P1：messages 数组通道（tool 结果按 opts.tools 存在与否选原生 tool 或文本降级）。 */
  chat(messages: ChatMessage[], opts?: CompleteOptions): Promise<string | OpenAICompatOutput>;
  streamChat?(prompt: string, opts?: CompleteOptions): AsyncIterable<ModelStreamChunk>;
  /** 0.8 P1：messages 流式通道（SSE 读循环与 streamChat 同构，仅请求体不同）。 */
  streamChatMessages(messages: ChatMessage[], opts?: CompleteOptions): AsyncIterable<ModelStreamChunk>;
}

export interface CompleteOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 原生 function calling（P1.1 请求侧）：OpenAI function schema 列表。 */
  tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  /** 0.7：外部中止信号（合并进 fetch/SSE 读流）。 */
  signal?: AbortSignal;
  /**
   * M2-4 真实 usage 计量：响应解析出 usage 时回调
   * （{prompt_tokens, completion_tokens}，缺省字段为 undefined）。
   * 网关普遍返回 json.usage；流式下 usage 通常在最后一个含 data 的
   * chunk 或 [DONE] 前的 usage chunk，找不到则本回调不触发（上层回落估算）。
   */
  onUsage?: (u: { prompt?: number; completion?: number }) => void;
  [key: string]: unknown;
}

/**
 * M2-4：从响应 json 提取 usage（prompt_tokens/completion_tokens）。
 * 无 usage 或字段非数字 → null（total_tokens 不参与回调，仅做解析参考）。
 */
export function extractUsage(json: any): { prompt?: number; completion?: number } | null {
  const usage = json?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const out: { prompt?: number; completion?: number } = {};
  if (typeof usage.prompt_tokens === 'number') out.prompt = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completion = usage.completion_tokens;
  return (out.prompt !== undefined || out.completion !== undefined) ? out : null;
}

function reportUsage(opts: CompleteOptions | undefined, u: { prompt?: number; completion?: number } | null): void {
  if (!u || typeof opts?.onUsage !== 'function') return;
  try { opts.onUsage(u); } catch { /* usage 回调是计量旁路，绝不打断主流程 */ }
}

function normalizeBaseUrl(baseUrl: string): string {
  if (!baseUrl) return '';
  // Remove trailing slashes
  let b = baseUrl.replace(/\/+$/, '');
  return b;
}

function joinUrl(base: string, path: string): string {
  const b = normalizeBaseUrl(base);
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

// ==================== 重试与空响应处理 ====================
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 522, 524, 529]);
// 远程网关抖动窗口常超 3 次退避周期——重试上限取 5 次。
const MAX_RETRIES = 5;

/** Retry-After 长等待阈值：超过它服务端明确要求"很久后再来"，不再常规 5 连发。 */
const LONG_RETRY_AFTER_MS = 30_000;

function parseRetryAfter(res: Response): number | null {
  // 包D 修复：返回服务端原始毫秒（此前钳到 30s 后照常最多 5 连发——
  // Retry-After: 3600 也被 5 连锤 6 次）。>30s 的处理在 withRetry 的一次性补试标志。
  try {
    const h = res.headers?.get?.('retry-after');
    if (!h) return null;
    const sec = Number(h);
    if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
    const at = Date.parse(h);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  } catch {}
  return null;
}

function isRetryableErr(e: any): boolean {
  // 显式不可重试标记优先（如 body 读取超时：响应头已到、body 半途挂死——
  // 重试收益低且可能重复计费/重复生成，快速失败）。
  if (e && e.retryable === false) return false;
  // M2-5：分类器接入——auth/billing/context_overflow 类快速失败（不再白吃
  // 5 次退避）；context_overflow 的重试交由 loop 的强制 compact 路径接管。
  const cls = classifyApiError(e);
  if (cls === 'auth' || cls === 'billing' || cls === 'context_overflow') return false;
  // 超时是瞬态故障 → 可重试（客户端层 timeout 错误不带 status/network 标记）
  if (cls === 'timeout') return true;
  // 补传输类错误——undici 层故障常表现为 TypeError（"terminated"）或
  // message 含 "fetch failed" 的网络错误，此前一律不重试。
  // TypeError 必须带传输类 message 才重试：裸 name 匹配会把解析层的
  // 编程性 TypeError 也当网络故障重试 5 次，掩盖真实缺陷。
  const msg = String(e?.message || '');
  const transportLike = /terminated|fetch failed|network/i.test(msg);
  return !!(e && (e.retryable === true || e.emptyResponse === true ||
    (typeof e.status === 'number' && RETRYABLE_STATUS.has(e.status)) || e.network === true ||
    /fetch failed/i.test(msg) || (e?.name === 'TypeError' && transportLike)));
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 流式通道整体 deadline 默认值（从请求开始计，覆盖 headers + 全部 SSE chunk）。 */
const STREAM_TOTAL_DEADLINE_MS = 10 * 60_000;

/**
 * 包D 修复：给慢 body 读取（res.text()/res.json()/reader.read()）加超时护栏。
 * fetchWithTimeout 的 timer 在响应头返回即清——此后 res.text() 可无限挂起。
 * 超时错误带 timeout=true + retryable=false：头已到的 body 挂死重试收益低
 * 且可能重复生成，快速失败（isRetryableErr 对 retryable===false 直接短路）。
 */
function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: any = null;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err: any = new Error(`${label} timeout: 响应体超过 ${timeoutMs}ms 未读取完成（网关半挂起）`);
      err.timeout = true;
      err.retryable = false;
      reject(err);
    }, Math.max(1, timeoutMs));
  });
  return Promise.race([p, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 429/5xx/网络错误/空响应的指数退避重试；Retry-After 头优先；耗尽后抛出最后错误。 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  // 包D 修复：Retry-After > 30s 的错误用一次性标志——最多补试 1 次（总 2 请求），
  // 跳过常规 MAX_RETRIES 循环（服务端明确要求一小时后再来时连锤 6 次无意义）。
  let longWaitProbed = false;
  for (;;) {
    try {
      return await fn();
    } catch (e: any) {
      if (attempt >= MAX_RETRIES || !isRetryableErr(e)) throw e;
      const retryAfterMs = typeof e?.retryAfterMs === 'number' ? e.retryAfterMs : null;
      if (retryAfterMs !== null && retryAfterMs > LONG_RETRY_AFTER_MS) {
        if (longWaitProbed) throw e;
        longWaitProbed = true;
      }
      // ≤30s：按服务端要求等待；>30s：整段等待会阻塞调用方数分钟——
      // 只按普通退避做那一次快速补试。
      const base = (retryAfterMs !== null && retryAfterMs <= LONG_RETRY_AFTER_MS)
        ? retryAfterMs
        : Math.min(8_000, 500 * Math.pow(2, attempt));
      const jittered = Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% jitter
      await sleepMs(jittered);
      attempt++;
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(id);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

/**
 * 包D 修复：SSE delta.tool_calls 的 function.name 幂等拼接。
 * 分片方言（OpenAI 官方）每 chunk 发 name 的一个切片 → 真分片用 +=；
 * llama.cpp/vLLM/MindIE 方言每 chunk 重发完整 name → 直接 += 会拼成
 * write_filewrite_file。规则：
 * - acc 空 → 直接赋值；
 * - delta === acc，或 acc 是 delta 的真前缀（delta 更长，整名重发后补全）→ 取 delta；
 * - delta 是 acc 的真前缀（重复首片）→ 保持 acc；
 * - 其余（真分片）→ +=。
 */
function mergeStreamToolName(acc: string, delta: string): string {
  if (!acc) return delta;
  if (delta === acc) return acc;
  if (delta.length > acc.length && delta.startsWith(acc)) return delta;
  if (delta.length > 0 && delta.length < acc.length && acc.startsWith(delta)) return acc;
  return acc + delta;
}

/** 把 doComplete 的结果转成 streamChat 回退 chunk 序列（toolCalls/truncated 不被吞掉） */function chunksFromCompleteOutput(out: string | OpenAICompatOutput): ModelStreamChunk[] {
  const finishReason = (out as OpenAICompatOutput)?.truncated ? 'length' : undefined;
  const withFr = (c: ModelStreamChunk): ModelStreamChunk => (finishReason ? { ...c, finishReason } : c);
  if (typeof out === 'string') return [withFr({ type: 'text', text: out })];
  const chunks: ModelStreamChunk[] = [];
  if (Array.isArray(out.toolCalls) && out.toolCalls.length > 0) {
    chunks.push(withFr({ type: 'toolCalls', toolCalls: out.toolCalls }));
  }
  if (typeof out.content === 'string' && out.content) {
    chunks.push(withFr({ type: 'text', text: out.content }));
  }
  if (chunks.length === 0) chunks.push(withFr({ type: 'text', text: '' }));
  return chunks;
}

export function createOpenAICompatClient(config: OpenAICompatConfig): OpenAICompatClient {
  if (!config || !config.baseUrl || !config.apiKey) {
    throw new Error('OpenAICompatClient requires baseUrl and apiKey');
  }

  const baseUrl = config.baseUrl;
  const apiKey = config.apiKey;
  const timeoutMs = config.timeoutMs ?? 120_000;

  const authHeaders: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      if (typeof k === 'string' && k && typeof v === 'string') authHeaders[k] = v;
    }
  }

  /**
   * Shared non-streaming completion engine (0.8 P1 重构：接受 messages 数组).
   * complete() 是它的单 user 消息包装；chat() 直传消息数组——两者共享
   * withRetry/finish_reason/usage/EMPTY_RESPONSE 全部逻辑（零行为变更）。
   */
  async function doComplete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string | OpenAICompatOutput> {
    const model = opts.model || 'default';
    const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.7;
    const max_tokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : undefined;
    // 原生 FC 模式判定：tools 存在 → tool 结果走 role:'tool' + tool_call_id；否则文本降级。
    const nativeTools = Array.isArray(opts.tools) && opts.tools.length > 0;

    const body: any = {
      model,
      messages: toWireMessages(messages, nativeTools),
      temperature,
      // EXPLICIT non-stream. Some gateways (a6api) default to
      // stream semantics and 422/behave erratically per-model when the flag
      // is ambiguous; declaring stream:false makes them return clean JSON.
      stream: false,
    };
    if (max_tokens !== undefined) {
      body.max_tokens = max_tokens;
    }
    // P1.1 请求侧：tools 非空时透传 OpenAI function calling schema，
    // 网关/模型据此在响应里返回结构化 tool_calls（响应侧转换已就绪）。
    if (nativeTools) {
      body.tools = opts.tools!.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      }));
      body.tool_choice = 'auto';
    }

    const url = joinUrl(baseUrl, '/chat/completions');
    const res = await withRetry(() => fetchWithTimeout(url, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    }, timeoutMs, opts.signal).catch((e: any) => {
      if (e?.name === 'AbortError') {
        // M2-5：区分用户主动中止（外部 signal / 显式 ABORTED 码）与内部超时。
        // 超时是瞬态故障 → 可重试且终态归 'error'（不再伪装成用户中断）。
        if (e?.code === 'ABORTED' || (opts.signal && opts.signal.aborted)) {
          const err: any = new Error('TASK_ABORTED');
          err.code = 'ABORTED';
          throw err;
        }
        const err: any = new Error(`complete timeout: 请求超过 ${timeoutMs}ms 未完成`);
        err.timeout = true;
        throw err;
      }
      const err: any = new Error(`complete network error: ${e?.message || e}`);
      err.network = true;
      throw err;
    }));

    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await raceWithTimeout(res.text(), timeoutMs, 'complete error body'); } catch {}
      const err: any = new Error(`complete failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = bodyText;
      if (RETRYABLE_STATUS.has(res.status)) {
        err.retryable = true;
        err.retryAfterMs = parseRetryAfter(res) ?? undefined;
      }
      throw err;
    }

    // 包D 修复：body 读取此前无超时——头返回后 res.text() 可无限挂起。
    // 超时错误（timeout=true, retryable=false）直接浮出，不吞。
    let bodyText = '';
    try {
      bodyText = await raceWithTimeout(res.text(), timeoutMs, 'complete body');
    } catch (e: any) {
      if (e?.timeout === true) throw e;
      // 其余读取异常维持旧语义（吞掉，走下方 json() 兜底）
    }
    let json: any = null;
    if (bodyText) { try { json = JSON.parse(bodyText); } catch { /* not JSON */ } }
    if (!json) {
      // Some mocks/tests expose json() without a usable text body.
      try { json = await res.json(); } catch {}
    }

    // Standard OpenAI response shape
    const message = json?.choices?.[0]?.message;
    const content = message?.content;

    // M2-4：解析 json.usage 并回调（网关普遍返回；无则 null，上层回落估算）。
    reportUsage(opts, extractUsage(json));
    // finish_reason==='length' → 响应被 max_tokens 截断。残缺内容
    // （尤其残缺 tool_calls/半句答复）静默通过会引发弱模型空转——标记 truncated
    // 让 VerifyCritiqueLoop 禁判 answered 并注入精简提示。
    const truncated = json?.choices?.[0]?.finish_reason === 'length';

    // 原生 function calling 通道——tool_calls 非空时返回结构化对象，
    // 上层 VerifyCritiqueLoop.preParsedToolCalls 直接消费（绕过文本解析）。
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      const toolCalls = convertOpenAIToolCalls(message.tool_calls);
      if (toolCalls.length > 0) {
        let rawStr: string;
        try { rawStr = typeof bodyText === 'string' && bodyText ? bodyText : JSON.stringify(json); } catch { rawStr = ''; }
        return {
          content: typeof content === 'string' ? content : '',
          raw: rawStr,
          toolCalls,
          detectedFormat: 'openai-json',
          ...(truncated ? { truncated: true } : {}),
        };
      }
    }

    if (typeof content === 'string' && content.length > 0) {
      return truncated ? { content, truncated: true } : content;
    }
    // reasoning 模型（openPangu-Embedded 实测）：content 为空但 reasoning_content
    // 承载全部输出——采用之，否则会落入 EMPTY_RESPONSE 重试。
    const reasoning = message?.reasoning_content ?? json?.choices?.[0]?.delta?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      return truncated ? { content: reasoning, truncated: true } : reasoning;
    }
    // Some providers put it under delta or raw
    if (typeof json?.choices?.[0]?.text === 'string') {
      const text = json.choices[0].text;
      return truncated ? { content: text, truncated: true } : text;
    }
    // Some gateways (e.g. a6api) return an SSE stream even for
    // a NON-streaming request — parse `data:` lines and concat delta.content.
    if (!json && bodyText.includes('data:')) {
      const parts: string[] = [];
      let sseUsage: { prompt?: number; completion?: number } | null = null;
      for (const line of bodyText.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') break;
        try {
          const ev = JSON.parse(payload);
          const u = extractUsage(ev); // usage 通常挂在最后一个 data chunk 上
          if (u) sseUsage = u;
          const d = ev?.choices?.[0]?.delta;
          if (typeof d?.content === 'string') parts.push(d.content);
          else if (typeof ev?.choices?.[0]?.text === 'string') parts.push(ev.choices[0].text);
        } catch {}
      }
      if (parts.length > 0) {
        reportUsage(opts, sseUsage);
        return parts.join('');
      }
    }
    // 包D 修复：可识别的响应形状（有 choices）但提取失败 → 返回带明确标记的
    // 空回复占位（此前 JSON.stringify(json) 把原始响应当模型话语灌上下文）；
    // 其余（真正空响应/无 choices）标记为可重试 EMPTY_RESPONSE，重试耗尽才返回空——
    // 消灭"空响应静默返回空串 → 模型空转烧步数"。
    if (json && Array.isArray(json.choices)) {
      const fr = json.choices[0]?.finish_reason;
      return `[模型返回空回复 finish_reason=${typeof fr === 'string' ? fr : 'unknown'}]`;
    }
    const emptyErr: any = new Error(
      'EMPTY_RESPONSE: 端点返回 200 但无有效内容。若使用 diffusion/embedding 类模型，'
      + 'LM Studio 对其 chat/completions 返回空体——请加载标准自回归对话模型'
    );
    emptyErr.emptyResponse = true;
    throw emptyErr;
  }

  /**
   * complete/chat/流式回退共用的 withRetry + emptyResponse 语义包装（0.8 P1 重构后单点）。
   * 空响应重试耗尽 → 返回空（调用方按 NO_TOOL_CALLS 处理），不挂起。
   */
  async function chatCompleteWithRetry(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string | OpenAICompatOutput> {
    try {
      return await withRetry(() => doComplete(messages, opts));
    } catch (e: any) {
      if (e && e.emptyResponse === true) {
        return '';
      }
      throw e;
    }
  }

  return {
    /** streamChat 回退专用：与 complete() 同语义的非流式回退。 */
    async completeLikeFallback(prompt: string, opts: CompleteOptions = {}): Promise<string | OpenAICompatOutput> {
      return chatCompleteWithRetry([{ role: 'user', content: prompt }], opts);
    },

    async listModels(): Promise<string[]> {
      const url = joinUrl(baseUrl, '/models');
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      }, timeoutMs);
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch {}
        const err: any = new Error(`listModels failed: ${res.status} ${res.statusText}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }

      const json: any = await raceWithTimeout(res.json(), timeoutMs, 'listModels body').catch(() => ({}));
      const data = Array.isArray(json?.data) ? json.data : [];
      const ids: string[] = [];
      for (const item of data) {
        if (item && typeof item.id === 'string' && item.id) {
          ids.push(item.id);
        }
      }
      return ids;
    },

    async complete(prompt: string, opts: CompleteOptions = {}): Promise<string | OpenAICompatOutput> {
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('complete requires a non-empty prompt string');
      }
      return chatCompleteWithRetry([{ role: 'user', content: prompt }], opts);
    },

    /**
     * 0.8 P1（M1-PROTOCOL）消息数组通道：messages 原样进请求体
     * （system 首位约定由调用方保证；tool 结果按 opts.tools 存在与否
     * 选原生 role:'tool'+tool_call_id 或文本降级标注）。
     * 与 complete() 共享 withRetry/finish_reason/usage/EMPTY_RESPONSE 全部逻辑。
     */
    async chat(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string | OpenAICompatOutput> {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('chat requires a non-empty messages array');
      }
      return chatCompleteWithRetry(messages, opts);
    },

    /**
     * 0.8 P1（M1-PROTOCOL）messages 流式通道：SSE 读循环/回退与 streamChat 同构，
     * 仅请求体不同。tool 结果映射与 chat() 一致（opts.tools 存在 → role:'tool' +
     * tool_call_id；否则文本降级 `【工具 <name> 结果】`）。
     */
    async *streamChatMessages(messages: ChatMessage[], opts: CompleteOptions = {}): AsyncIterable<ModelStreamChunk> {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('streamChatMessages requires a non-empty messages array');
      }

      const model = opts.model || 'default';
      const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.7;
      const max_tokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : undefined;
      const nativeTools = Array.isArray(opts.tools) && opts.tools.length > 0;

      const body: any = {
        model,
        messages: toWireMessages(messages, nativeTools),
        temperature,
        stream: true,
      };
      if (max_tokens !== undefined) {
        body.max_tokens = max_tokens;
      }
      // P1.1 请求侧：stream 路径同样透传 tools（delta.tool_calls 拼装已就绪）。
      if (nativeTools) {
        body.tools = opts.tools!.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description ?? '',
            parameters: t.parameters ?? { type: 'object', properties: {} },
          },
        }));
        body.tool_choice = 'auto';
      }

      const url = joinUrl(baseUrl, '/chat/completions');
      // 包D 修复：整体 deadline（从请求开始计，含连接阶段）——SSE 中途停滞
      // 此前会永远卡在 reader.read()（默认 10 分钟，测试可经 config 注入）。
      const streamDeadlineAt = Date.now() + (config.streamDeadlineMs ?? STREAM_TOTAL_DEADLINE_MS);
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(body),
        }, timeoutMs, opts.signal);
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          if (e?.code === 'ABORTED' || (opts.signal && opts.signal.aborted)) {
            const err: any = new Error('TASK_ABORTED');
            err.code = 'ABORTED';
            throw err;
          }
          // 内部超时（瞬态）→ 与其余传输类错误同语义：回退非流式（withRetry 会重试）。
          for (const c of chunksFromCompleteOutput(await chatCompleteWithRetry(messages, opts))) yield c;
          return;
        }
        // Transport-level failure → fall back to non-streaming so callers keep working.
        // 0.7.4：与 complete() 同语义——withRetry 包裹 + emptyResponse 耗尽转空串，
        // 消灭"三连发裸调用穿透 → chaser 误判 aborted"（LM Studio diffusion 实测）。
        for (const c of chunksFromCompleteOutput(await chatCompleteWithRetry(messages, opts))) yield c;
        return;
      }

      if (!res.ok || !(res as any).body) {
        // Non-OK → fall back to complete() which surfaces a rich error
        for (const c of chunksFromCompleteOutput(await chatCompleteWithRetry(messages, opts))) yield c;
        return;
      }

      const reader = (res as any).body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawAny = false;
      // 尾 delta 的 finish_reason（'length' = max_tokens 截断）
      let streamFinishReason: string | undefined;
      // M2-4：流式 usage 计量——usage 通常在最后一个含 data 的 chunk
      // 或 [DONE] 前的 usage chunk 上，取最后一次出现的值，流结束后统一回调。
      let streamUsage: { prompt?: number; completion?: number } | null = null;
      // SSE delta.tool_calls 增量拼接（按 index 聚合 id/name/arguments 分片）
      const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();

      // 单行消费：返回该行产出的 chunk 与是否 [DONE]（抽出以便流结束后 flush 残余行）
      const consumeLine = (line: string): { chunks: ModelStreamChunk[]; done: boolean } => {
        if (!line || line.startsWith(':')) return { chunks: [], done: false };
        if (!line.startsWith('data:')) return { chunks: [], done: false };
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') return { chunks: [], done: true };

        const out: ModelStreamChunk[] = [];
        let json: any;
        try { json = JSON.parse(dataStr); } catch { return { chunks: out, done: false }; }

        // usage chunk（choices 常为空数组）——先于 choices 检查捕获
        const u = extractUsage(json);
        if (u) streamUsage = u;

        const delta = json?.choices?.[0]?.delta;
        if (!delta && typeof json?.choices?.[0]?.finish_reason !== 'string') return { chunks: out, done: false };
        // finish_reason 通常出现在最后一个（delta 为空的）chunk 上
        if (typeof json?.choices?.[0]?.finish_reason === 'string') {
          streamFinishReason = json.choices[0].finish_reason;
        }
        if (!delta) return { chunks: out, done: false };

        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          sawAny = true;
          out.push({ type: 'thinking', text: reasoning } as ModelStreamChunk);
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          sawAny = true;
          out.push({ type: 'text', text: delta.content } as ModelStreamChunk);
        }

        const tcDelta = delta.tool_calls;
        if (Array.isArray(tcDelta)) {
          for (const d of tcDelta) {
            const i = typeof d?.index === 'number' ? d.index : 0;
            let acc = toolCallAcc.get(i);
            if (!acc) {
              acc = { name: '', args: '' };
              toolCallAcc.set(i, acc);
            }
            if (typeof d?.id === 'string' && d.id) acc.id = d.id;
            if (typeof d?.function?.name === 'string') acc.name = mergeStreamToolName(acc.name, d.function.name);
            if (typeof d?.function?.arguments === 'string') acc.args += d.function.arguments;
          }
        }
        return { chunks: out, done: false };
      };

      outer: while (true) {
        if (opts.signal?.aborted) {
          const err: any = new Error('TASK_ABORTED');
          err.code = 'ABORTED';
          throw err;
        }
        const readP = raceWithTimeout<{ value: any; done: boolean }>(
          reader.read(),
          streamDeadlineAt - Date.now(),
          'stream body',
        );
        // 生成器被调用方中途放弃后 deadline 仍会触发——抑制孤儿 unhandled rejection
        readP.catch(() => {});
        const { value, done } = await readP.catch(async (e: any) => {
          // deadline 到期：取消底层流后把超时浮出（不是用户 abort——保留 TASK_ABORTED 语义）
          try { await reader.cancel(); } catch {}
          throw e;
        });
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);

          const r = consumeLine(line);
          for (const c of r.chunks) yield c;
          if (r.done) {
            // 不能直接 return——必须先走循环后的 delta.tool_calls 拼装
            break outer;
          }
        }
      }

      // 包D 修复：流结束（reader done / [DONE]）后 flush buffer 残余行——
      // 逐行处理依赖 indexOf('\n')，流以无尾随换行的末行结束时它此前被
      // 静默丢弃（usage 丢失 / sawAny 误判触发非流式重发双请求）。
      const tailLine = buffer.trim();
      buffer = '';
      if (tailLine) {
        const r = consumeLine(tailLine);
        for (const c of r.chunks) yield c;
      }

      // 流式结束——拼好的 toolCalls 作为独立 chunk 交给上层
      // （chaser wrapper 聚合后以结构化对象返回给 VerifyCritiqueLoop）
      if (toolCallAcc.size > 0) {
        const assembled = [...toolCallAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.args } }));
        const toolCalls = convertOpenAIToolCalls(assembled);
        if (toolCalls.length > 0) {
          sawAny = true;
          yield { type: 'toolCalls', toolCalls } as ModelStreamChunk;
        }
      }

      // 截断标记随尾 chunk 透传（chaser wrapper 聚合进返回对象）
      if (streamFinishReason === 'length') {
        sawAny = true;
        yield { type: 'text', text: '', finishReason: 'length' } as ModelStreamChunk;
      }

      // M2-4：流式 usage 统一在流结束后回调一次（找不到则 null，上层回落估算）
      reportUsage(opts, streamUsage);

      // Endpoint accepted stream:true but sent nothing parseable — fall back once.
      if (!sawAny) {
        // 已上报过 SSE usage 时不再透传 onUsage（防同一次调用双计）
        const fallbackOpts = streamUsage ? { ...opts, onUsage: undefined } : opts;
        for (const c of chunksFromCompleteOutput(await chatCompleteWithRetry(messages, fallbackOpts))) yield c;
      }
    },

    /**
     * token-level streaming via SSE (stream:true).
     * Yields {type:'thinking'} for delta.reasoning_content (OpenAI-compatible style)
     * and {type:'text'} for delta.content. Falls back to a single text chunk
     * built from complete() when the endpoint does not support streaming.
     * 0.8 P1：单 user 消息包装（streamChatMessages 引擎的 thin wrapper，行为不变）。
     */
    async *streamChat(prompt: string, opts: CompleteOptions = {}): AsyncIterable<ModelStreamChunk> {
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('streamChat requires a non-empty prompt string');
      }
      yield* this.streamChatMessages([{ role: 'user', content: prompt }], opts);
    },
  };
}
