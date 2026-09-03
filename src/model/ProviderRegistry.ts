// src/model/ProviderRegistry.ts
// ProviderRegistry: manages multiple providers from config.
// For now focused on "scnet" (OpenAI-compatible).
// Returns P3-compatible ModelClient (has complete method).
// Never throws on unavailable; returns null for createClient when not configured or fails.

import type { ModelClient, CompleteOptions, ModelClientOutput, ProviderConfig } from '../cli/repl/types.js';
import { createScnetClient } from './ScnetClient.js';
import { createOpenAICompatClient, OpenAICompatClient } from './openai-compatible.js';

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

  constructor(config: ProviderRegistryConfig = {}) {
    this.config = config || {};
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
      const client = this._createRawCompatClient(prov);
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
      const fullModels = await this._fetchRawModels(prov);
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

    const rawClient: OpenAICompatClient | null = this._createRawCompatClient(prov);
    if (!rawClient) return null;

    let effectiveModel = modelName;
    if (!effectiveModel) {
      effectiveModel = this.config.model;
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

  private _createRawCompatClient(prov: ProviderConfig): OpenAICompatClient | null {
    if (!prov || !prov.baseUrl) return null;
    const apiKey = prov.apiKey || '';
    if (!apiKey) {
      // No key -> cannot create usable client
      return null;
    }
    try {
      return createOpenAICompatClient({
        baseUrl: prov.baseUrl,
        apiKey,
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
  private async _fetchRawModels(prov: ProviderConfig): Promise<any[] | null> {
    if (!prov || !prov.baseUrl || !prov.apiKey) return null;

    const base = prov.baseUrl.replace(/\/+$/, '');
    const url = base + '/models';

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${prov.apiKey}`,
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
