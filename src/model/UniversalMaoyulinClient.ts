// src/model/UniversalMaoyulinClient.ts
// Universal client for Maoyulin-style OpenAI-compatible relays.
//
// IMPORTANT (per user instruction):
// - NO automatic rate limiting / throttling is performed inside this client.
// - The only restriction is: the AI agent must NOT perform unsolicited high-frequency
//   probing / liveness testing / batch model comparisons against the user's relay.
// - All normal usage (including rapid legitimate calls if the user initiates them) is allowed.
// - Rate limiting, if desired, must be applied by the caller / orchestration layer explicitly.

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { UniversalToolCallAdapter, UniversalParseResult, ToolCallFormat } from '../adapter/UniversalToolCallAdapter.js';
import { ToolCall } from '../types/toolCall.js';

export interface UniversalClientOptions {
  apiKey: string;
  baseUrl?: string;                 // default: https://api.maoyulin.xyz
  defaultModel?: string;            // default: glm-5.2
  /** If true, force strict GLM <> only parsing */
  strictGlmOnly?: boolean;
}

export interface UniversalCompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  detectedFormat?: ToolCallFormat;
  model: string;
  raw: string;                      // original text content returned by relay
}

export interface UniversalCompletionOptions {
  model?: string;                   // override per call
  temperature?: number;
  max_tokens?: number;
  /** Force tolerant parsing for this call */
  tolerant?: boolean;
}

export class UniversalMaoyulinClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly strictGlmOnly: boolean;

  private readonly adapter = new UniversalToolCallAdapter();

  constructor(options: UniversalClientOptions) {
    if (!options.apiKey) {
      throw new Error('UniversalMaoyulinClient requires apiKey');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.maoyulin.xyz';
    this.defaultModel = options.defaultModel || 'glm-5.2';
    this.strictGlmOnly = !!options.strictGlmOnly;
  }

  /**
   * Main completion method.
   * No rate limiting is applied here.
   */
  async complete(prompt: string, opts: UniversalCompletionOptions = {}): Promise<UniversalCompletionResponse> {
    const model = opts.model || this.defaultModel;

    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature ?? 0.6,
      max_tokens: opts.max_tokens ?? 4096,
      stream: false,
    };

    const url = new URL('/v1/chat/completions', this.baseUrl);

    const rawContent = await this.doRequest(url, body);

    const parseRes: UniversalParseResult = this.adapter.parse(rawContent, {
      strictGlmOnly: this.strictGlmOnly,
      tolerant: opts.tolerant ?? true,
    });

    return {
      content: rawContent,
      toolCalls: parseRes.toolCalls,
      detectedFormat: parseRes.detectedFormat,
      model,
      raw: rawContent,
    };
  }

  /**
   * Lower-level request. Separated for testability.
   */
  private doRequest(url: URL, body: any): Promise<string> {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      };

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = JSON.parse(data);
                const content = json.choices?.[0]?.message?.content || '';
                resolve(content);
              } catch (e) {
                reject(new Error(`Failed to parse response: ${data}`));
              }
            } else {
              reject(new Error(`Maoyulin API error ${res.statusCode}: ${data}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * P1.1: token-level streaming (SSE, stream:true).
   * Yields {type:'thinking'} for delta.reasoning_content and {type:'text'}
   * for delta.content. Falls back to a single complete() chunk when the relay
   * rejects streaming or sends nothing parseable.
   */
  async *streamChat(prompt: string, opts: UniversalCompletionOptions = {}): AsyncGenerator<
    { type: 'text' | 'thinking'; text: string },
    void,
    unknown
  > {
    const model = opts.model || this.defaultModel;

    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature ?? 0.6,
      max_tokens: opts.max_tokens ?? 4096,
      stream: true,
    };

    const url = new URL('/v1/chat/completions', this.baseUrl);

    let sawAny = false;
    try {
      for await (const chunk of this.doStreamRequest(url, body)) {
        sawAny = true;
        yield chunk;
      }
    } catch {
      // Relay rejected streaming (or transport error) → single-shot fallback
    }

    if (!sawAny) {
      const res = await this.complete(prompt, { ...opts, model });
      if (res && res.content) {
        yield { type: 'text', text: res.content };
      }
    }
  }

  /**
   * Lower-level SSE request for streamChat(). Separated for testability.
   * Single 'response' listener validates status, then we iterate the stream.
   */
  private async *doStreamRequest(
    url: URL,
    body: any
  ): AsyncGenerator<{ type: 'text' | 'thinking'; text: string }, void, unknown> {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    // Attach listeners first, then send — safe ordering (listeners are on the
    // req object before any network event can fire).
    const resPromise = new Promise<http.IncomingMessage>((resolve, reject) => {
      req.once('response', (r) => {
        if (!r.statusCode || r.statusCode < 200 || r.statusCode >= 300) {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => reject(new Error(`Maoyulin API error ${r.statusCode}: ${data.slice(0, 300)}`)));
          return;
        }
        resolve(r);
      });
      req.once('error', reject);
    });
    req.end(JSON.stringify(body));

    let res: http.IncomingMessage;
    try {
      res = await resPromise;
    } catch (e) {
      try { req.destroy(); } catch {}
      throw e;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for await (const value of res) {
        buffer += decoder.decode(value as Buffer, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);

          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;

          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') return;

          let json: any;
          try { json = JSON.parse(dataStr); } catch { continue; }

          const delta = json?.choices?.[0]?.delta;
          if (!delta) continue;

          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            yield { type: 'thinking', text: reasoning };
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: 'text', text: delta.content };
          }
        }
      }
    } finally {
      try { req.destroy(); } catch {}
    }
  }

  /**
   * Expose a way to get format hint for the current/last model.
   */
  getFormatHint(detected?: ToolCallFormat, model?: string): string {
    return this.adapter.generateFormatHint(detected, model);
  }
}

