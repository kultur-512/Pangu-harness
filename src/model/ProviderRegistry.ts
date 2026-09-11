// src/model/ProviderRegistry.ts
// ProviderRegistry: manages multiple providers from config.
// For now focused on "scnet" (OpenAI-compatible).
// Returns P3-compatible ModelClient (has complete method).
// Never throws on unavailable; returns null for createClient when not configured or fails.

import type { ModelClient, CompleteOptions, ModelClientOutput, ProviderConfig } from '../cli/repl/types.js';
import { createOpenAICompatClient, OpenAICompatClient } from './openai-compatible.js';
import { execFileSync } from 'node:child_process';

export interface ProviderRegistryConfig {
  providers?: Record<string, ProviderConfig>;
  model?: string; // default model name across providers
}

export interface ModelInfo {
  id: string;
  contextLength?: number;
}

export class ProviderRegistry {
  private config: ProviderRegistryConfig;
  /** apiKeyCmd 解析结果缓存（providerName → key）。成功才缓存；registry 重建时随之失效。 */
  private _apiKeyCmdCache = new Map<string, string>();

  constructor(config: ProviderRegistryConfig = {}) {
    this.config = config || {};
  }

  /**
   * 解析 provider 密钥。优先级：显式 apiKey > apiKeyCmd（stdout 首行，成功后缓存）。
   * 借鉴 claude-code apiKeyHelper：密钥不落配置文件。
   * 失败给明确报错（不静默回退空密钥），但 createClientSync 路径下表现为 null client。
   */
  private _resolveApiKey(prov: ProviderConfig, providerName: string): string {
    if (prov.apiKey && String(prov.apiKey).trim()) return String(prov.apiKey).trim();
    const cmd = prov.apiKeyCmd;
    if (!cmd || typeof cmd !== 'string') return '';
    const cached = this._apiKeyCmdCache.get(providerName);
    if (cached) return cached;
    try {
      const out = execFileSync(cmd, {
        shell: true,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // 只取 stdout 首行（与 claude-code apiKeyHelper 语义一致：脚本只应输出密钥本身）
      const key = String(out ?? '').split(/\r?\n/)[0]?.trim() || '';
      if (!key) {
        console.error(`[panshalach] apiKeyCmd for provider '${providerName}' produced empty output`);
        return '';
      }
      this._apiKeyCmdCache.set(providerName, key);
      return key;
    } catch (e) {
      console.error(`[panshalach] apiKeyCmd failed for provider '${providerName}': ${(e as Error).message}`);
      return '';
    }
  }

  listProviderNames(): string[] {
    const providers = this.config.providers || {};
    return Object.keys(providers);
  }

  isProviderConfigured(name: string): boolean {
    if (!name) return false;
    const p = (this.config.providers || {})[name];
    return !!p && (p.type === 'openai-compatible') && !!p.baseUrl;
  }

  /**
   * List models for a provider.
   * - If provider config has `models` (non-empty), return them.
   * - Otherwise try to fetch live from /models.
   * Returns null on failure / not configured.
   */
  async listModels(providerName: string): Promise<string[] | null> {
    const prov = this._getProvider(providerName);
    if (!prov) return null;

    if (Array.isArray(prov.models) && prov.models.length > 0) {
      return prov.models.slice();
    }

    try {
      const client = this._createRawCompatClient(prov, providerName);
      if (!client) return null;
      const ids = await client.listModels();
      return ids;
    } catch {
      return null;
    }
  }

  /**
   * List models with context length info.
   * Tries to fetch live /models and extract context.
   * Falls back to config modelContexts if present.
   * Unknown context -> 256000 (256K)
   */
  async listModelsWithContext(providerName: string): Promise<ModelInfo[] | null> {
    const prov = this._getProvider(providerName);
    if (!prov) return null;

    const cachedContexts = prov.modelContexts || {};

    // If we have cached models and contexts, we can synthesize
    if (Array.isArray(prov.models) && prov.models.length > 0) {
      return prov.models.map(id => ({
        id,
        contextLength: cachedContexts[id] ?? 256000,
      }));
    }

    // Try live fetch using a raw compat client that can give richer data
    try {
      const fullModels = await this._fetchRawModels(prov, providerName);
      if (!fullModels || fullModels.length === 0) {
        // fallback to plain ids if available
        const ids = await this.listModels(providerName);
        if (!ids) return null;
        return ids.map(id => ({ id, contextLength: cachedContexts[id] ?? 256000 }));
      }

      const result: ModelInfo[] = [];
      for (const m of fullModels) {
        const id = m?.id;
        if (!id || typeof id !== 'string') continue;

        // Try common fields for context window
        let ctx: number | undefined =
          pickNumber(m, ['context_window', 'max_context_tokens', 'max_tokens', 'context_length', 'max_input_tokens', 'n_ctx']);

        if (ctx === undefined && cachedContexts[id]) {
          ctx = cachedContexts[id];
        }
        if (ctx === undefined) {
          ctx = 256000;
        }

        result.push({ id, contextLength: ctx });
      }

      return result.length > 0 ? result : null;
    } catch {
      // last resort: plain list
      const ids = await this.listModels(providerName);
      if (!ids) return null;
      return ids.map(id => ({ id, contextLength: cachedContexts[id] ?? 256000 }));
    }
  }

  /**
   * Create a ModelClient for the given provider + optional model (sync version).
   * Use this for hot paths where we don't want to await for client creation.
   * Returns null if not configured.
   */
  createClientSync(providerName: string, modelName?: string): ModelClient | null {
    const prov = this._getProvider(providerName);
    if (!prov) return null;

    const rawClient: OpenAICompatClient | null = this._createRawCompatClient(prov, providerName);
    if (!rawClient) return null;

    let effectiveModel = modelName;
    if (!effectiveModel) {
      effectiveModel = this.config.model;
      // 修复（2026-09-05 实测）：config.model 可能是 "provider:model" 路由串——
      // 原样发给网关会 400（LM Studio 实测）。此处剥离 provider 前缀。
      if (effectiveModel && effectiveModel.includes(':')) {
        effectiveModel = effectiveModel.slice(effectiveModel.indexOf(':') + 1) || undefined;
      }
      if (!effectiveModel && Array.isArray(prov.models) && prov.models.length > 0) {
        effectiveModel = prov.models[0];
      }
      if (!effectiveModel) effectiveModel = 'default';
    }

    const boundModel = effectiveModel;

    const modelClient: ModelClient = {
      async complete(prompt: string, opts: CompleteOptions = {}) {
        const merged: CompleteOptions = {
          ...opts,
          model: boundModel,
        };
        const text = await rawClient.complete(prompt, merged as any);
        return text;
      },
      // 对抗清单 T-22（2026-09-05）：透传 streamChat——此前 registry 客户端只有
      // complete，chaser 流式包装永远回退非流式（生产恒非流式）。
      ...(rawClient.streamChat ? {
        streamChat: ((prompt: string, opts: CompleteOptions = {}) =>
          rawClient.streamChat!(prompt, { ...opts, model: boundModel } as any)) as ModelClient['streamChat'],
      } : {}),
      // 0.8 M1-PROTOCOL：透传 messages 双通道——registry 客户端缺这两个方法时
      // chaser/loop 的 messages 模式会静默回退文本路径（消息通道形同虚设）。
      ...(rawClient.chat ? {
        chat: ((messages: any[], opts: CompleteOptions = {}) =>
          rawClient.chat!(messages, { ...opts, model: boundModel } as any)) as ModelClient['chat'],
      } : {}),
      ...(rawClient.streamChatMessages ? {
        streamChatMessages: ((messages: any[], opts: CompleteOptions = {}) =>
          rawClient.streamChatMessages!(messages, { ...opts, model: boundModel } as any)) as ModelClient['streamChatMessages'],
      } : {}),
    };

    return modelClient;
  }

  /**
   * Async createClient kept for compatibility / future (currently delegates to sync).
   */
  async createClient(providerName: string, modelName?: string): Promise<ModelClient | null> {
    return this.createClientSync(providerName, modelName);
  }

  // --- internal helpers ---

  private _getProvider(name: string): ProviderConfig | null {
    if (!name) return null;
    const providers = this.config.providers || {};
    const p = providers[name];
    if (!p || p.type !== 'openai-compatible' || !p.baseUrl) return null;
    return p;
  }

  private _createRawCompatClient(prov: ProviderConfig, providerName = ''): OpenAICompatClient | null {
    if (!prov || !prov.baseUrl) return null;
    const apiKey = this._resolveApiKey(prov, providerName);
    if (!apiKey) {
      // No key -> cannot create usable client
      return null;
    }
    try {
      return createOpenAICompatClient({
        baseUrl: prov.baseUrl,
        apiKey,
        headers: prov.headers,
        timeoutMs: 120_000,
      });
    } catch {
      return null;
    }
  }

  /**
   * Fetch raw model objects from /models for context extraction.
   * We use a lightweight direct fetch here to get full objects.
   */
  private async _fetchRawModels(prov: ProviderConfig, providerName = ''): Promise<any[] | null> {
    if (!prov || !prov.baseUrl) return null;
    const apiKey = this._resolveApiKey(prov, providerName);
    if (!apiKey) return null;

    const base = prov.baseUrl.replace(/\/+$/, '');
    const url = base + '/models';

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (!res.ok) return null;

      const json: any = await res.json().catch(() => ({}));
      const data = Array.isArray(json?.data) ? json.data : [];
      return data;
    } catch {
      return null;
    }
  }
}

function pickNumber(obj: any, keys: string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}
