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
}

/** P1.1: streaming chunk type (mirrors cli/repl/types ModelStreamChunk to avoid import cycle) */
export interface ModelStreamChunk {
  type: 'text' | 'thinking';
  text: string;
}

export interface OpenAICompatClient {
  listModels(): Promise<string[]>;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
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

export function createOpenAICompatClient(config: OpenAICompatConfig): OpenAICompatClient {
  if (!config || !config.baseUrl || !config.apiKey) {
    throw new Error('OpenAICompatClient requires baseUrl and apiKey');
  }

  const baseUrl = config.baseUrl;
  const apiKey = config.apiKey;
  const timeoutMs = config.timeoutMs ?? 120_000;

  const authHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  /** Shared non-streaming completion (used by complete() and as streamChat fallback). */
  async function doComplete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
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
    const content = json?.choices?.[0]?.message?.content;
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

    async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
      return doComplete(prompt, opts);
    },

    /**
     * P1.1: token-level streaming via SSE (stream:true).
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
        const text = await doComplete(prompt, opts);
        yield { type: 'text', text } as ModelStreamChunk;
        return;
      }

      if (!res.ok || !(res as any).body) {
        // Non-OK → fall back to complete() which surfaces a rich error
        const text = await doComplete(prompt, opts);
        yield { type: 'text', text } as ModelStreamChunk;
        return;
      }

      const reader = (res as any).body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawAny = false;

      while (true) {
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
            return;
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
        }
      }

      // Endpoint accepted stream:true but sent nothing parseable — fall back once.
      if (!sawAny) {
        const text = await doComplete(prompt, opts);
        yield { type: 'text', text } as ModelStreamChunk;
      }
    },
  };
}
