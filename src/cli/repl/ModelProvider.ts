// src/cli/repl/ModelProvider.ts
// ModelProvider 抽象
// - Never throw on unavailable model; return null
// - Default "default" model can be backed by an optional fallbackComplete
// - Supports registration of named factories
// - Now also supports "scnet" (and "scnet:xxx") via ProviderRegistry + openai-compatible client
// - Generic "<provider>:<model>" routing works for any configured provider (e.g. a6, openpangu)

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
  // when the caller passed an explicit providersConfig, it is
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

    // If caller provided providersConfig at construction, prepare the registry eagerly.
    // env 注入对显式配置同样生效（env 是配置分层的一部分，不属于文件系统探测）。
    if (opts?.providersConfig) {
      const cfg = {
        ...opts.providersConfig,
        providers: this._applyEnvInjection({ ...(opts.providersConfig.providers || {}) }),
      };
      this._providerRegistry = new ProviderRegistry(cfg);
      this._configIsAuthoritative = true;
      // seed caches for bare-name routing / ctx lookup
      for (const [pname, pcfg] of Object.entries(cfg.providers || {}) as Array<[string, any]>) {
        if (Array.isArray(pcfg?.models) && pcfg.models.length > 0) {
          this.remoteModelsCache.set(pname, pcfg.models.slice());
        }
        if (pcfg?.modelContexts && typeof pcfg.modelContexts === 'object') {
          this.remoteContextsCache.set(pname, { ...pcfg.modelContexts });
        }
      }
    }
  }

  private getProviderRegistry(): ProviderRegistry | null {
    // explicit config wins — no filesystem discovery, no rebuild.
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

        // P1.2: env 注入泛化——PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL 三件套，
        // SCNET_API_KEY/SCNET_KEY 保留为 scnet 历史别名（行为不变）。
        providers = this._applyEnvInjection(providers);

        // ULTRA ROBUST: if a configured provider still has no key (e.g. BOM / parse
        // oddity in this root's .panshalach.json), try to extract the key directly
        // from the file bytes for this root. Scans ALL providers (P1.2).
        const keyless = Object.entries(providers).filter(([, v]: any) => v && !v.apiKey);
        if (keyless.length > 0) {
          const extracted = this._extractProviderKeyFromFile(root);
          if (extracted && extracted.apiKey) {
            const cur = (providers[extracted.provider] && typeof providers[extracted.provider] === 'object')
              ? { ...providers[extracted.provider] }
              : { type: 'openai-compatible', baseUrl: extracted.baseUrl };
            if (!cur.baseUrl && extracted.baseUrl) cur.baseUrl = extracted.baseUrl;
            cur.apiKey = extracted.apiKey;
            providers[extracted.provider] = cur;
          }
        }

        if (providers && Object.keys(providers).length > 0) {
          const newReg = new ProviderRegistry({
            providers,
            model: all.model,
          });

          if (Object.keys(providers).length > 0) {
            this._providerRegistry = newReg;

            // cache configured model lists/contexts for every provider (bare-name routing + ctx lookup)
            for (const [pname, pcfg] of Object.entries(providers) as Array<[string, any]>) {
              if (Array.isArray(pcfg?.models) && pcfg.models.length > 0) {
                this.remoteModelsCache.set(pname, pcfg.models.slice());
              }
              if (pcfg?.modelContexts && typeof pcfg.modelContexts === 'object') {
                this.remoteContextsCache.set(pname, { ...pcfg.modelContexts });
              }
            }

            // Found at least one usable provider (baseUrl + key) → done
            const usable = Object.values(providers).some((v: any) => v?.baseUrl && v?.apiKey);
            if (usable) {
              return this._providerRegistry;
            }
          }
        }
      }
    } catch {}

    // Last resort
    return this._providerRegistry;
  }

  /** provider 名 → env 变量中缀（大写，非字母数字折叠为 _） */
  private static _envSuffix(name: string): string {
    return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  }

  /**
   * P1.2 env 三件套注入（泛化，行为不变）：
   * - `PANSHA_<PROV>_API_KEY` / `_BASE_URL` / `_MODEL`（<PROV> 为 provider 名大写）；
   * - env key 优先于文件 apiKey（密钥不进配置文件的部署方式）；
   * - `SCNET_API_KEY`/`SCNET_KEY` 保留为 scnet 历史别名（含默认 baseUrl 兼容）；
   * - 非文件内新 provider 必须提供 `_BASE_URL`（无 baseUrl 的条目不注入，避免死配置）。
   */
  private _applyEnvInjection(providers: Record<string, any>): Record<string, any> {
    const out = (providers && typeof providers === 'object') ? { ...providers } : {};
    const names = new Set<string>(Object.keys(out).filter(Boolean));

    // discover env-only providers: PANSHA_<U>_API_KEY
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^PANSHA_([A-Z0-9]+)_API_KEY$/);
      if (m) {
        const provName = m[1].toLowerCase();
        // env 中缀还原为 provider 名：仅接受字母数字（_ 折叠场景罕见，按小写名匹配文件）
        names.add(provName);
      }
    }
    if (process.env.SCNET_API_KEY || process.env.SCNET_KEY) names.add('scnet');

    for (const name of names) {
      const u = DefaultModelProvider._envSuffix(name);
      const envKey = process.env[`PANSHA_${u}_API_KEY`]
        || (name === 'scnet' ? (process.env.SCNET_API_KEY || process.env.SCNET_KEY) : undefined);
      const envBaseUrl = process.env[`PANSHA_${u}_BASE_URL`];
      const envModel = process.env[`PANSHA_${u}_MODEL`];
      if (!envKey && !envBaseUrl && !envModel) continue;

      const existing = out[name];
      const cur = (existing && typeof existing === 'object') ? { ...existing } : { type: 'openai-compatible' };

      if (envBaseUrl) cur.baseUrl = envBaseUrl;
      if (!cur.baseUrl && envKey && name === 'scnet') {
        cur.baseUrl = 'https://api.scnet.cn/api/llm/v1'; // 历史别名兼容，行为不变
      }
      if (envKey) cur.apiKey = envKey;
      if (envModel) {
        const old = Array.isArray(existing?.models) ? existing.models : [];
        cur.models = [...new Set([envModel, ...old])];
      }

      if (existing || (cur.baseUrl && cur.apiKey)) {
        out[name] = cur;
      }
    }
    return out;
  }

  /**
   * Ultra-robust extraction of a provider apiKey directly from .panshalach.json bytes.
   * Survives BOM, parse errors, etc. Scans ALL configured providers (P1.2 泛化),
   * preferring scnet when present (历史别名兼容).
   */
  private _extractProviderKeyFromFile(root: string): { provider: string; apiKey: string; baseUrl?: string } | null {
    try {
      const p = join(root, '.panshalach.json');
      if (!existsSync(p)) return null;
      let buf = readFileSync(p);
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        buf = buf.slice(3);
      }
      const txt = buf.toString('utf-8');

      // Try clean JSON first: scan every providers.*.apiKey
      try {
        const j = JSON.parse(txt.trim());
        const provs = j && j.providers && typeof j.providers === 'object' ? j.providers : null;
        if (provs) {
          const names = Object.keys(provs).sort((a, b) => (a === 'scnet' ? -1 : b === 'scnet' ? 1 : 0));
          for (const name of names) {
            const pc = provs[name];
            if (pc && typeof pc.apiKey === 'string' && pc.apiKey) {
              return { provider: name, apiKey: pc.apiKey, baseUrl: pc.baseUrl };
            }
          }
        }
      } catch {}

      // Regex fallback for sk- style keys (and any long key) — attribute to scnet
      // when the file mentions a scnet block, otherwise to the first provider block.
      const m = txt.match(/"apiKey"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) {
        const k = m[1];
        // only accept plausible keys (contains sk- or is long)
        if (k.includes('sk-') || k.length > 20) {
          const provMatch = txt.match(/"(scnet|[a-z0-9_-]+)"\s*:\s*\{[^{}]*"apiKey"/i);
          return { provider: provMatch ? provMatch[1] : 'scnet', apiKey: k };
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

  /** 是否至少有一个可用 provider（baseUrl + key 解析通过） */
  private _hasAnyProvider(pr: ProviderRegistry | null): boolean {
    if (!pr) return false;
    try {
      return (pr.listProviderNames() || []).some((p) => pr.isProviderConfigured(p));
    } catch {
      return false;
    }
  }

  listModels(): string[] {
    const others = Array.from(this.registry.keys()).filter(k => k !== 'default');
    let pr = this.getProviderRegistry();
    let hasAny = this._hasAnyProvider(pr);

    // If we don't see any provider yet, try a one-time hot reload (user may have created
    // .panshalach.json or set PANSHA_<PROV>_* / SCNET_API_KEY after starting this process).
    if (!hasAny) {
      this.invalidateProviderCache();
      pr = this.getProviderRegistry();
      hasAny = this._hasAnyProvider(pr);
    }

    const base = ['default', ...others];
    if (pr) {
      try {
        const any = pr as any;
        // fix-model-abc (Bug A): the real method is listProviderNames()
        if (typeof any.listProviderNames === 'function') {
          for (const p of any.listProviderNames() || []) {
            if (pr.isProviderConfigured(p) && !base.includes(p)) base.push(p);
          }
        } else if (any.config?.providers) {
          for (const p of Object.keys(any.config.providers)) {
            if (!base.includes(p)) base.push(p);
          }
        }
      } catch {}
    }
    return base;
  }

  isModelAvailable(name: string): boolean {
    if (!name) return false;

    // Direct registered factory (e.g. 'default' or manually registered)
    const factory = this.registry.get(name);
    if (factory) {
      const c = factory();
      return !!c && typeof (c as any).complete === 'function';
    }

    // scnet:xxx form or plain 'scnet' entry (历史别名兼容)
    if (name === 'scnet' || name.startsWith('scnet:')) {
      let pr = this.getProviderRegistry();
      if (!pr || !pr.isProviderConfigured('scnet')) {
        this.invalidateProviderCache();
        pr = this.getProviderRegistry();
      }
      return !!(pr && pr.isProviderConfigured('scnet'));
    }

    // provider:model 形式 → 检查对应 provider 是否已配置
    if (name.includes(':')) {
      const provName = name.slice(0, name.indexOf(':'));
      const pr = this.getProviderRegistry();
      return !!(pr && pr.isProviderConfigured(provName));
    }

    // Bare model name - check every configured provider's cached model list
    const pr = this.getProviderRegistry();
    if (pr && this._hasAnyProvider(pr)) {
      for (const [provName, cached] of this.remoteModelsCache) {
        if (Array.isArray(cached) && cached.includes(name)) return true;
      }
      // provider 明确声明了模型清单但不含该名字 → 不可用；无清单则乐观可用
      const declared = [...this.remoteModelsCache.values()].filter((v) => Array.isArray(v) && v.length > 0);
      if (declared.length > 0) return false;
      return true;
    }

    return false;
  }

  createClient(name: string): ModelClient | null {
    if (!name) return null;

    // 1. Exact registered factory (e.g. 'default' or manually registered names)
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

    // 2. scnet prefix form: "scnet" or "scnet:some-model"
    if (name === 'scnet' || name.startsWith('scnet:')) {
      const modelPart = name.startsWith('scnet:') ? name.slice(6) : undefined;
      return this._createProviderClient('scnet', modelPart); // 历史别名兼容
    }

    // 2b. Generic provider:model prefix (fix-a6-routing) — any configured
    // provider works, e.g. "a6:some-model". Additive; scnet semantics above
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

    // 3. Bare name → route to whichever configured provider declares/cached it
    //    (P1.2 泛化；scnet 保留为兜底别名)
    const pr = this.getProviderRegistry();
    if (pr) {
      for (const [provName, cached] of this.remoteModelsCache) {
        if (Array.isArray(cached) && cached.includes(name) && pr.isProviderConfigured(provName)) {
          try {
            return pr.createClientSync(provName, name);
          } catch {
            return null;
          }
        }
      }
      // 历史别名兼容：scnet 配置存在时，裸名仍走 scnet
      if (pr.isProviderConfigured('scnet')) {
        return this._createProviderClient('scnet', name);
      }
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
      return this._createProviderClient('scnet', undefined);
    }

    return null;
  }

  /**
   * Get the context window length (in tokens) for a model name.
   * Priority:
   * 1. In-memory cache from a recent /model list (remoteContextsCache, ALL providers)
   * 2. Persisted in .panshalach.json providers.<prov>.modelContexts (ALL providers)
   * 3. 256000 (256K) default
   */
  getModelContextLength(name: string): number {
    if (!name) return 256000;

    const effective = this.getEffectiveModel(name);

    // 1. Check remote caches first (most fresh after /model list) — 跨 provider 遍历
    for (const cachedCtx of this.remoteContextsCache.values()) {
      if (cachedCtx && typeof cachedCtx[effective] === 'number') {
        return cachedCtx[effective];
      }
    }

    // 2. Check persisted config (use effective name) — 跨 provider 遍历
    try {
      const cm = new ConfigManager(process.cwd());
      const all = cm.getAll();
      const provs = all.providers && typeof all.providers === 'object' ? all.providers : {};
      for (const pc of Object.values(provs) as Array<any>) {
        if (pc?.modelContexts && typeof pc.modelContexts[effective] === 'number') {
          return pc.modelContexts[effective];
        }
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

  /** 通用 provider 客户端构造（P1.2 收敛；scnet 走同一入口，无特化路径）。 */
  private _createProviderClient(providerName: string, modelName?: string): ModelClient | null {
    const pr = this.getProviderRegistry();
    if (!pr) return null;

    // Use sync version to satisfy ModelProvider.createClient signature (sync)
    try {
      return pr.createClientSync(providerName, modelName);
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
   * For names that carry a "<provider>:" prefix, return the concrete model id
   * that will actually be sent to the backend (the part after the prefix).
   * For plain "scnet" (provider alias without a model) resolves to the provider's
   * first available model when the remote list is cached, otherwise the input
   * name is returned as-is. All other names pass through unchanged.
   */
  getEffectiveModel(name: string): string {
    if (!name) return name;

    const sep = name.indexOf(':');
    if (sep >= 0) {
      const providerName = name.slice(0, sep);
      const modelPart = name.slice(sep + 1);
      if (modelPart) return modelPart;
      // "<provider>:" with no model — resolve a concrete model from the cache if present
      return this._pickBestProviderModel(providerName);
    }
    // Provider alias given as a bare name: resolve a concrete model when cached
    const pr = this.getProviderRegistry();
    if (pr) {
      try {
        if (pr.isProviderConfigured(name)) return this._pickBestProviderModel(name);
      } catch {}
    }
    if (name === 'scnet') {
      return this._pickBestProviderModel('scnet'); // 历史别名兼容
    }
    return name;
  }

  /**
   * Pick the first usable model of a provider (best effort when the caller
   * refers to the provider by its bare name, e.g. "scnet" without a model id).
   * Strategy:
   * 1. If we have a fetched model list (via /model list), pick the first entry.
   * 2. If no cache yet, return the input provider name and let the
   *    openai-compatible client / backend resolve the effective default.
   */
  private _pickBestProviderModel(providerName: string): string {
    const cached = this.remoteModelsCache.get(providerName) || [];
    if (cached.length > 0) return cached[0];
    return providerName;
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

// ==================== 共享单例（provider 兜底必达） ====================
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
