// src/cli/repl/ModelProvider.ts
// P3: ModelProvider abstraction (per ModelProvider blueprint)
// - Never throw on unavailable model; return null
// - Default "default" model can be backed by an optional fallbackComplete
// - Supports registration of named factories
// - Now also supports "scnet" (and "scnet:xxx") via ProviderRegistry + openai-compatible client

import type { ModelClient, ModelProvider, CompleteOptions, ModelClientOutput } from './types.js';
import { ConfigManager } from './ConfigManager.js';
import { ProviderRegistry } from '../../model/ProviderRegistry.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

export type FallbackComplete = (prompt: string, opts?: CompleteOptions) => Promise<string | ModelClientOutput>;

export class DefaultModelProvider implements ModelProvider {
  readonly defaultModel: string;

  private registry = new Map<string, () => ModelClient | null>();
  private fallbackComplete?: FallbackComplete;

  // Cached provider registry for scnet etc. (lazy)
  private _providerRegistry: ProviderRegistry | null = null;
  // M2.5: when the caller passed an explicit providersConfig, it is
  // AUTHORITATIVE — getProviderRegistry must never silently replace it with
  // a config discovered from the filesystem (isolation for tests/embedders).
  private _configIsAuthoritative = false;

  // In-memory cache of remote models fetched via /model list (for immediate availability after list)
  private remoteModelsCache = new Map<string, string[]>();
  private remoteContextsCache = new Map<string, Record<string, number>>();

  /**
   * Adopt a freshly fetched remote model list for a provider (e.g. after /model list).
   * This makes the models immediately available for isModelAvailable / createClient in the current session
   * without requiring a restart (the list is also persisted to .panshalach.json by the caller).
   */
  adoptRemoteModels(providerName: string, models: string[], contexts?: Record<string, number>): void {
    if (!providerName || !Array.isArray(models)) return;
    this.remoteModelsCache.set(providerName, models.slice());
    if (contexts && typeof contexts === 'object') {
      this.remoteContextsCache.set(providerName, { ...contexts });
    }
  }

  constructor(opts?: {
    defaultModel?: string;
    fallbackComplete?: FallbackComplete;
    // Optionally pass providers config directly (for tests or advanced use)
    providersConfig?: { providers?: any; model?: string };
  }) {
    this.defaultModel = (opts?.defaultModel && String(opts.defaultModel).trim()) || 'default';
    this.fallbackComplete = opts?.fallbackComplete;

    // Seed the "default" entry
    this.registry.set('default', () => {
      const fb = this.fallbackComplete;
      if (fb) {
        return {
          async complete(prompt: string, opts?: CompleteOptions) {
            return fb(prompt, opts);
          },
        } as ModelClient;
      }
      return null;
    });

    // If caller provided providersConfig at construction, prepare the registry eagerly
    if (opts?.providersConfig) {
      this._providerRegistry = new ProviderRegistry(opts.providersConfig);
      this._configIsAuthoritative = true;
    }
  }

  private getProviderRegistry(): ProviderRegistry | null {
    // M2.5: explicit config wins — no filesystem discovery, no rebuild.
    if (this._configIsAuthoritative) {
      return this._providerRegistry;
    }
    // If we already have a registry that has scnet configured, keep using it (good path).
    if (this._providerRegistry) {
      try {
        if (this._providerRegistry.isProviderConfigured('scnet')) {
          return this._providerRegistry;
        }
      } catch {}
      // fallthrough to try rebuild
    }

    try {
      // Try to find the project root that actually contains .panshalach.json.
      // This fixes the common case where the REPL session.workspace is the project,
      // but process.cwd() at launch time was different (e.g. ran "pangu" from elsewhere).
      const rootsToTry = this._collectCandidateRoots();

      for (const root of rootsToTry) {
        const cm = new ConfigManager(root);
        const all = cm.getAll();

        let providers: any = (all.providers && typeof all.providers === 'object') ? { ...all.providers } : {};

        // Also support env var injection
        const envKey = process.env.SCNET_API_KEY || process.env.SCNET_KEY;
        if (envKey && !providers.scnet) {
          providers.scnet = {
            type: 'openai-compatible',
            baseUrl: 'https://api.scnet.cn/api/llm/v1',
            apiKey: envKey,
          };
        }

        // ULTRA ROBUST: if still no scnet key (e.g. BOM, parse oddity in this root's .panshalach.json),
        // try to extract the key directly from the file bytes for this root.
        if (!providers.scnet || !providers.scnet.apiKey) {
          const extracted = this._extractScnetKeyFromFile(root);
          if (extracted && extracted.apiKey) {
            providers.scnet = {
              type: 'openai-compatible',
              baseUrl: extracted.baseUrl || 'https://api.scnet.cn/api/llm/v1',
              apiKey: extracted.apiKey,
            };
          }
        }

        if (providers && Object.keys(providers).length > 0) {
          const newReg = new ProviderRegistry({
            providers,
            model: all.model,
          });

          if (newReg.isProviderConfigured('scnet') || Object.keys(providers).length > 0) {
            this._providerRegistry = newReg;

            const scnet = providers.scnet;
            if (scnet) {
              if (Array.isArray(scnet.models) && scnet.models.length > 0) {
                this.remoteModelsCache.set('scnet', scnet.models.slice());
              }
              if (scnet.modelContexts && typeof scnet.modelContexts === 'object') {
                this.remoteContextsCache.set('scnet', { ...scnet.modelContexts });
              }
            }

            // If we found a working scnet, great. Otherwise keep searching a bit.
            if (newReg.isProviderConfigured('scnet')) {
              return this._providerRegistry;
            }
          }
        }
      }
    } catch {}

    // Last resort
    return this._providerRegistry;
  }

  /**
   * Ultra-robust extraction of scnet apiKey directly from .panshalach.json bytes.
   * Survives BOM, parse errors, etc. Used as last-chance in getProviderRegistry.
   */
  private _extractScnetKeyFromFile(root: string): { apiKey: string; baseUrl?: string } | null {
    try {
      const p = join(root, '.panshalach.json');
      if (!existsSync(p)) return null;
      let buf = readFileSync(p);
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        buf = buf.slice(3);
      }
      const txt = buf.toString('utf-8');

      // Try clean JSON first
      try {
        const j = JSON.parse(txt.trim());
        const sc = j && j.providers && j.providers.scnet;
        if (sc && typeof sc.apiKey === 'string' && sc.apiKey) {
          return { apiKey: sc.apiKey, baseUrl: sc.baseUrl };
        }
      } catch {}

      // Regex fallback for sk-tp- style keys (and any long key)
      const m = txt.match(/"apiKey"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) {
        const k = m[1];
        // only accept plausible keys (contains sk- or is long)
        if (k.includes('sk-') || k.length > 20) {
          return { apiKey: k };
        }
      }
    } catch {}
    return null;
  }
  private _collectCandidateRoots(): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();

    const add = (p: string) => {
      if (!p) return;
      const norm = p.replace(/[\\/]+$/, '');
      if (!seen.has(norm)) {
        seen.add(norm);
        roots.push(norm);
      }
    };

    // 1. Current process cwd
    add(process.cwd());

    // 2. Walk upward from cwd looking for .panshalach.json (project root discovery)
    // (B12: was require('path') — dead code under "type":"module"; use the
    //  ESM import instead so upward discovery actually works.)
    try {
      let dir = process.cwd();
      for (let i = 0; i < 6; i++) {
        const parent = dirname(dir);
        if (parent === dir) break;
        add(parent);
        dir = parent;
      }
    } catch {}

    // 3. Also try the directory of the main module (helps when launched via bin)
    try {
      const mainPath = process.argv[1] || '';
      if (mainPath) add(dirname(mainPath));
    } catch {}

    return roots;
  }

  /**
   * Register (or override) a named model factory.
   * Factory must return ModelClient | null (never throw).
   */
  register(name: string, factory: () => ModelClient | null): void {
    if (!name || typeof name !== 'string') return;
    this.registry.set(name, factory);
  }

  listModels(): string[] {
    const others = Array.from(this.registry.keys()).filter(k => k !== 'default');
    let pr = this.getProviderRegistry();
    let hasScnet = !!(pr && pr.isProviderConfigured('scnet'));

    // If we don't see scnet yet, try a one-time hot reload (user may have created .panshalach.json
    // or set SCNET_API_KEY after starting this Panshalach process).
    if (!hasScnet) {
      this.invalidateProviderCache();
      pr = this.getProviderRegistry();
      hasScnet = !!(pr && pr.isProviderConfigured('scnet'));
    }

    const base = ['default', ...others];
    if (hasScnet) {
      if (!base.includes('scnet')) base.push('scnet');
      if (!base.includes('glm')) base.push('glm');
    }
    // fix-a6-routing: expose every configured provider name in the model list
    try {
      const pr2 = this.getProviderRegistry();
      const any = pr2 as any;
      // fix-model-abc (Bug A): the real method is listProviderNames()
      if (pr2 && typeof any.listProviderNames === 'function') {
        for (const p of any.listProviderNames() || []) {
          if (!base.includes(p)) base.push(p);
        }
      } else if (pr2 && (any as any).config?.providers) {
        for (const p of Object.keys((any as any).config.providers)) {
          if (!base.includes(p)) base.push(p);
        }
      }
    } catch {}
    return base;
  }

  isModelAvailable(name: string): boolean {
    if (!name) return false;

    const lower = name.toLowerCase();

    // GLM shorthand on scnet: only bare "glm" or "glm5"
    if (lower === 'glm' || lower === 'glm5') {
      let pr = this.getProviderRegistry();
      if (!pr || !pr.isProviderConfigured('scnet')) {
        // Hot-reload: user may have just created .panshalach.json or set env var in this running process
        this.invalidateProviderCache();
        pr = this.getProviderRegistry();
      }
      return !!(pr && pr.isProviderConfigured('scnet'));
    }

    // Direct registered factory (e.g. 'default' or manually registered)
    const factory = this.registry.get(name);
    if (factory) {
      const c = factory();
      return !!c && typeof (c as any).complete === 'function';
    }

    // scnet:xxx form or plain 'scnet' entry
    if (name === 'scnet' || name.startsWith('scnet:')) {
      let pr = this.getProviderRegistry();
      if (!pr || !pr.isProviderConfigured('scnet')) {
        this.invalidateProviderCache();
        pr = this.getProviderRegistry();
      }
      return !!(pr && pr.isProviderConfigured('scnet'));
    }

    // Bare model name - check if scnet is configured
    let pr = this.getProviderRegistry();
    if (pr && pr.isProviderConfigured('scnet')) {
      const cached = this.remoteModelsCache.get('scnet');
      if (cached && cached.length > 0) {
        return cached.includes(name);
      }
      return true;
    }

    return false;
  }

  createClient(name: string): ModelClient | null {
    if (!name) return null;

    // 1. Exact registered factory (e.g. 'default', manually registered 'maoyulin' etc.)
    const factory = this.registry.get(name);
    if (factory) {
      const client = factory();
      if (client && typeof (client as any).complete === 'function') {
        return client;
      }
      // fix: 'default' without a fallback must NOT short-circuit — fall
      // through to provider routing (scnet/a6) so a fresh session's
      // model='default' resolves against configured providers.
      if (name !== 'default') return null;
    }

    // 2. Bare GLM shorthand on scnet: "glm" or "glm5" (magic auto-pick)
    const lower = name.toLowerCase();
    if (lower === 'glm' || lower === 'glm5') {
      let pr = this.getProviderRegistry();
      if (!pr || !pr.isProviderConfigured('scnet')) {
        // Try to pick up a config that the user just created or env var they just set
        this.invalidateProviderCache();
        pr = this.getProviderRegistry();
      }
      if (pr && pr.isProviderConfigured('scnet')) {
        const targetModel = this._pickBestGLMModel();
        return this._createScnetClient(targetModel);
      }
    }

    // 3. scnet prefix form: "scnet" or "scnet:some-model"
    if (name === 'scnet' || name.startsWith('scnet:')) {
      const modelPart = name.startsWith('scnet:') ? name.slice(6) : undefined;
      return this._createScnetClient(modelPart);
    }

    // 3b. Generic provider:model prefix (fix-a6-routing) — any configured
    // provider works, e.g. "a6:glm-5.3-flash". Additive; scnet semantics above
    // are untouched.
    if (name.includes(':')) {
      const sep = name.indexOf(':');
      const providerName = name.slice(0, sep);
      const modelPart = name.slice(sep + 1) || undefined;
      const pr = this.getProviderRegistry();
      if (pr && pr.isProviderConfigured(providerName)) {
        try {
          return pr.createClientSync(providerName, modelPart);
        } catch {
          return null;
        }
      }
    }

    // 4. If scnet provider is configured, treat bare name as a scnet model name
    const pr = this.getProviderRegistry();
    if (pr && pr.isProviderConfigured('scnet')) {
      return this._createScnetClient(name);
    }

    return null;
  }

  createDefaultClient(): ModelClient | null {
    // Prefer explicit defaultModel if registered and resolvable
    if (this.defaultModel && this.defaultModel !== 'default') {
      const c = this.createClient(this.defaultModel);
      if (c) return c;
    }
    // Fall back to the canonical "default" entry
    const c = this.createClient('default');
    if (c) return c;

    // Last resort: if a fallbackComplete exists directly
    const fb2 = this.fallbackComplete;
    if (fb2) {
      return {
        async complete(prompt: string, opts?: CompleteOptions) {
          return fb2(prompt, opts);
        },
      } as ModelClient;
    }

    // Finally, if scnet is configured, try to create a scnet default client
    const pr = this.getProviderRegistry();
    if (pr && pr.isProviderConfigured('scnet')) {
      return this._createScnetClient(undefined);
    }

    return null;
  }

  /**
   * Get the context window length (in tokens) for a model name.
   * Priority:
   * 1. In-memory cache from a recent /model list (remoteContextsCache)
   * 2. Persisted in .panshalach.json providers.<prov>.modelContexts
   * 3. 256000 (256K) default
   *
   * GLM shorthand ("glm", "glm-5", etc.) is resolved to the effective concrete model first.
   */
  getModelContextLength(name: string): number {
    if (!name) return 256000;

    const effective = this.getEffectiveModel(name);

    // 1. Check remote cache first (most fresh after /model list)
    const cachedCtx = this.remoteContextsCache.get('scnet');
    if (cachedCtx && typeof cachedCtx[effective] === 'number') {
      return cachedCtx[effective];
    }

    // 2. Check persisted config (use effective name)
    try {
      const cm = new ConfigManager(process.cwd());
      const all = cm.getAll();
      const scnet = all.providers?.scnet;
      if (scnet?.modelContexts && typeof scnet.modelContexts[effective] === 'number') {
        return scnet.modelContexts[effective];
      }
    } catch {}

    // 3. Default
    return 256000;
  }

  /**
   * List actual models from a remote provider (e.g. "scnet").
   * Returns the list of model IDs (strings). Falls back to null if not available.
   */
  async listProviderModels(providerName: string): Promise<string[] | null> {
    const pr = this.getProviderRegistry();
    if (!pr) return null;
    if (!pr.isProviderConfigured(providerName)) return null;
    try {
      const models = await pr.listModels(providerName);
      return models;
    } catch {
      return null;
    }
  }

  /**
   * List models with context length information.
   * Returns array of { id, contextLength }. contextLength defaults to 256000 if unknown.
   */
  async listProviderModelsWithContext(providerName: string): Promise<Array<{ id: string; contextLength: number }> | null> {
    const pr = this.getProviderRegistry();
    if (!pr) return null;
    if (!pr.isProviderConfigured(providerName)) return null;
    try {
      const infos = await pr.listModelsWithContext(providerName);
      if (!infos) return null;
      return infos.map(i => ({ id: i.id, contextLength: i.contextLength ?? 256000 }));
    } catch {
      return null;
    }
  }

  private _createScnetClient(modelName?: string): ModelClient | null {
    const pr = this.getProviderRegistry();
    if (!pr) return null;

    // Use sync version to satisfy ModelProvider.createClient signature (sync)
    try {
      return pr.createClientSync('scnet', modelName);
    } catch {
      return null;
    }
  }

  /**
   * Force re-evaluation of providers from disk + env on next access.
   * Useful after the user creates .panshalach.json or sets SCNET_API_KEY while REPL is running.
   */
  invalidateProviderCache(): void {
    this._providerRegistry = null;
    this.remoteModelsCache.clear();
    this.remoteContextsCache.clear();
  }

  /**
   * Force a scnet configuration into this provider instance.
   * Used by /model commands to inject a config discovered from the actual session workspace
   * when the provider was created before the .panshalach.json existed.
   */
  forceScnetConfig(scnetCfg: any): void {
    if (!scnetCfg || !scnetCfg.apiKey) return;
    this._providerRegistry = new ProviderRegistry({
      providers: { scnet: scnetCfg },
    });
    this.remoteModelsCache.delete('scnet');
    this.remoteContextsCache.delete('scnet');
  }

  /**
   * For shorthands like "glm" / "glm5", return the concrete model id that will actually be sent to the backend.
   * For normal names (including explicit "GLM-5.1", "GLM-5") returns the input name as-is.
   */
  getEffectiveModel(name: string): string {
    if (!name) return name;
    const lower = name.toLowerCase();
    if (lower === 'glm' || lower === 'glm5') {
      return this._pickBestGLMModel();
    }
    return name;
  }

  /**
   * Pick the best GLM model available for scnet.
   * Based on live testing with scnet:
   * - GLM-5.1 and GLM-5 usually succeed with Token Plan.
   * - GLM-5.2-Base / *-Base variants often return 403 "does not support Token Plan".
   * Strategy:
   * 1. If we have fetched models (via /model list), pick best from cache.
   * 2. If no cache yet, default to GLM-5.1 (verified working).
   */
  private _pickBestGLMModel(): string {
    const cached = this.remoteModelsCache.get('scnet') || [];

    // If we have remote list, use it
    if (cached.length > 0) {
      const preferredOrder = ['GLM-5.1', 'GLM-5', 'GLM-5.2'];
      for (const name of preferredOrder) {
        if (cached.includes(name)) return name;
      }
      const glmNonBase = cached.filter(m => /^glm/i.test(m) && !/base/i.test(m));
      if (glmNonBase.length > 0) return glmNonBase[0];
      const glmAny = cached.filter(m => /^glm/i.test(m));
      if (glmAny.length > 0) return glmAny[0];
    }

    // No cache (or no GLM in cache): use a model known to work with current scnet Token Plan
    // Live test confirmed GLM-5.1 works.
    return 'GLM-5.1';
  }
}

// Convenience creator
export function createDefaultModelProvider(opts?: {
  defaultModel?: string;
  fallbackComplete?: FallbackComplete;
  providersConfig?: { providers?: any; model?: string };
}): ModelProvider {
  return new DefaultModelProvider(opts);
}

// ==================== Shared singleton (P0-fix: provider 兜底必达) ====================
// Problem this solves: runAgentTask() used to construct a FRESH provider per
// call, losing the REPL's hot state (/model switches, adoptRemoteModels caches,
// forceScnetConfig injections) and sometimes missing .panshalach.json root discovery.
// A process-wide shared instance keeps every consumer on the same provider.

let __sharedProvider: DefaultModelProvider | null = null;

/**
 * Get (or lazily create) the process-wide shared model provider.
 * All long-lived consumers (REPL, embedded runner, serve) should use this so
 * configuration discovered once stays available everywhere.
 */
export function getSharedModelProvider(opts?: {
  defaultModel?: string;
  fallbackComplete?: FallbackComplete;
  providersConfig?: { providers?: any; model?: string };
}): DefaultModelProvider {
  if (!__sharedProvider) {
    __sharedProvider = new DefaultModelProvider(opts);
  }
  return __sharedProvider;
}

/** Replace the shared provider instance (used when a caller has a fully-configured one). */
export function setSharedModelProvider(p: DefaultModelProvider): void {
  __sharedProvider = p;
}

/**
 * Resolve a usable ModelClient with layered fallback + one hot-reload retry:
 * 1. explicit client factory result (caller-provided provider)
 * 2. shared provider: createClient(model) → createDefaultClient()
 * 3. one invalidateProviderCache() + retry (picks up newly created .panshalach.json / env keys)
 * Throws only when truly nothing is available (caller surfaces a clear error).
 */
export async function resolveSharedClient(
  model: string | undefined,
  explicit?: ModelProvider
): Promise<{ client: ModelClient; provider: ModelProvider }> {
  const attempt = (prov: ModelProvider): ModelClient | null => {
    try {
      return (
        (model ? prov.createClient(model) : null) ||
        prov.createDefaultClient() ||
        null
      );
    } catch {
      return null;
    }
  };

  // 1. Explicit provider wins when it can resolve
  if (explicit) {
    const c = attempt(explicit);
    if (c) return { client: c, provider: explicit };
  }

  // 2. Shared provider
  const shared = getSharedModelProvider();
  let c = attempt(shared);
  if (c) return { client: c, provider: shared };

  // 3. One hot reload retry (config file created after process start, env var set, etc.)
  try { shared.invalidateProviderCache(); } catch {}
  c = attempt(shared);
  if (c) return { client: c, provider: shared };

  throw new Error(
    'No model client available. Configure .panshalach.json providers (scnet/a6/...), or set PANSHA_MODEL=<provider:model>, or pass a ModelProvider.'
  );
}
