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

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number; // default 120000
  /** 附加请求头（网关场景），与默认 Authorization 合并 */
  headers?: Record<string, string>;
}

/** streaming chunk type (mirrors cli/repl/types ModelStreamChunk to avoid import cycle) */
export interface ModelStreamChunk {
  type: 'text' | 'thinking' | 'toolCalls';
  text?: string;
  /** 仅 type:'toolCalls'：SSE delta.tool_calls 增量拼接出的完整调用（P1.1） */
  toolCalls?: unknown[];
}

/**
 * 结构化输出（镜像 cli/repl/types ModelClientOutput，避免 import cycle）。
 * complete() 在网关返回原生 message.tool_calls 时返回该对象（P1.1），
 * VerifyCritiqueLoop 的 preParsedToolCalls 通道直接消费，无需再走文本解析。
 */
export interface OpenAICompatOutput {
  content?: string;
  raw?: string;
  toolCalls?: unknown[];
  detectedFormat?: string;
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

export interface OpenAICompatClient {
  listModels(): Promise<string[]>;
  /** 网关返回原生 tool_calls 时返回结构化对象（detectedFormat:'openai-json'），否则返回文本 */
  complete(prompt: string, opts?: CompleteOptions): Promise<string | OpenAICompatOutput>;
  streamChat?(prompt: string, opts?: CompleteOptions): AsyncIterable<ModelStreamChunk>;
}

export interface CompleteOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/** 把 doComplete 的结果转成 streamChat 回退 chunk 序列（toolCalls 对象不被吞掉） */
function chunksFromCompleteOutput(out: string | OpenAICompatOutput): ModelStreamChunk[] {
  if (typeof out === 'string') return [{ type: 'text', text: out }];
  const chunks: ModelStreamChunk[] = [];
  if (Array.isArray(out.toolCalls) && out.toolCalls.length > 0) {
    chunks.push({ type: 'toolCalls', toolCalls: out.toolCalls });
  }
  if (typeof out.content === 'string' && out.content) {
    chunks.push({ type: 'text', text: out.content });
  }
  if (chunks.length === 0) chunks.push({ type: 'text', text: '' });
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

  /** Shared non-streaming completion (used by complete() and as streamChat fallback). */
  async function doComplete(prompt: string, opts: CompleteOptions = {}): Promise<string | OpenAICompatOutput> {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('complete requires a non-empty prompt string');
    }

    const model = opts.model || 'default';
    const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.7;
    const max_tokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : undefined;

    const body: any = {
      model,
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature,
      // fix-a6-422: EXPLICIT non-stream. Some gateways (a6api) default to
      // stream semantics and 422/behave erratically per-model when the flag
      // is ambiguous; declaring stream:false makes them return clean JSON.
      stream: false,
    };
    if (max_tokens !== undefined) {
      body.max_tokens = max_tokens;
    }

    const url = joinUrl(baseUrl, '/chat/completions');
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    }, timeoutMs);

    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch {}
      const err: any = new Error(`complete failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = bodyText;
      throw err;
    }

    let bodyText = '';
    try { bodyText = await res.text(); } catch {}
    let json: any = null;
    if (bodyText) { try { json = JSON.parse(bodyText); } catch { /* not JSON */ } }
    if (!json) {
      // Some mocks/tests expose json() without a usable text body.
      try { json = await res.json(); } catch {}
    }

    // Standard OpenAI response shape
    const message = json?.choices?.[0]?.message;
    const content = message?.content;

    // P1.1: 原生 function calling 通道——tool_calls 非空时返回结构化对象，
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
        };
      }
    }

    if (typeof content === 'string') {
      return content;
    }
    // Some providers put it under delta or raw
    if (typeof json?.choices?.[0]?.text === 'string') {
      return json.choices[0].text;
    }
    // fix-a6-routing: some gateways (e.g. a6api) return an SSE stream even for
    // a NON-streaming request — parse `data:` lines and concat delta.content.
    if (!json && bodyText.includes('data:')) {
      const parts: string[] = [];
      for (const line of bodyText.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') break;
        try {
          const ev = JSON.parse(payload);
          const d = ev?.choices?.[0]?.delta;
          if (typeof d?.content === 'string') parts.push(d.content);
          else if (typeof ev?.choices?.[0]?.text === 'string') parts.push(ev.choices[0].text);
        } catch {}
      }
      if (parts.length > 0) return parts.join('');
    }
    // Fallback to stringified if nothing matches (better than silent empty)
    if (json) {
      try { return JSON.stringify(json); } catch { return ''; }
    }
    return bodyText.length > 0 ? bodyText : '';
  }

  return {
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

      const json: any = await res.json().catch(() => ({}));
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
      return doComplete(prompt, opts);
    },

    /**
     * token-level streaming via SSE (stream:true).
     * Yields {type:'thinking'} for delta.reasoning_content (OpenAI-compatible style)
     * and {type:'text'} for delta.content. Falls back to a single text chunk
     * built from complete() when the endpoint does not support streaming.
     */
    async *streamChat(prompt: string, opts: CompleteOptions = {}): AsyncIterable<ModelStreamChunk> {
      if (!prompt || typeof prompt !== 'string') {
        throw new Error('streamChat requires a non-empty prompt string');
      }

      const model = opts.model || 'default';
      const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.7;
      const max_tokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : undefined;

      const body: any = {
        model,
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature,
        stream: true,
      };
      if (max_tokens !== undefined) {
        body.max_tokens = max_tokens;
      }

      const url = joinUrl(baseUrl, '/chat/completions');
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(body),
        }, timeoutMs);
      } catch (e) {
        // Transport-level failure → fall back to non-streaming so callers keep working
        for (const c of chunksFromCompleteOutput(await doComplete(prompt, opts))) yield c;
        return;
      }

      if (!res.ok || !(res as any).body) {
        // Non-OK → fall back to complete() which surfaces a rich error
        for (const c of chunksFromCompleteOutput(await doComplete(prompt, opts))) yield c;
        return;
      }

      const reader = (res as any).body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawAny = false;
      // P1.1: SSE delta.tool_calls 增量拼接（按 index 聚合 id/name/arguments 分片）
      const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();

      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);

          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;

          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') {
            // P1.1: 不能直接 return——必须先走循环后的 delta.tool_calls 拼装
            break outer;
          }

          let json: any;
          try { json = JSON.parse(dataStr); } catch { continue; }

          const delta = json?.choices?.[0]?.delta;
          if (!delta) continue;

          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            sawAny = true;
            yield { type: 'thinking', text: reasoning } as ModelStreamChunk;
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            sawAny = true;
            yield { type: 'text', text: delta.content } as ModelStreamChunk;
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
              if (typeof d?.function?.name === 'string') acc.name += d.function.name;
              if (typeof d?.function?.arguments === 'string') acc.args += d.function.arguments;
            }
          }
        }
      }

      // P1.1: 流式结束——拼好的 toolCalls 作为独立 chunk 交给上层
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

      // Endpoint accepted stream:true but sent nothing parseable — fall back once.
      if (!sawAny) {
        for (const c of chunksFromCompleteOutput(await doComplete(prompt, opts))) yield c;
      }
    },
  };
}
