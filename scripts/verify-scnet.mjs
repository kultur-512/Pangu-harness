// scripts/verify-scnet.mjs
// Pure-Node verification for ANY configured OpenAI-compatible provider
// (default: scnet，历史别名兼容). Config-driven——no provider-specific code path.
// - Loads config from .panshalach.json (project) or falls back to env vars
//   (PANSHA_<PROV>_API_KEY / SCNET_API_KEY / SCNET_KEY)
// - Calls listModels (or list with context)
// - Performs one lightweight complete
// - Prints results; exits non-zero on hard failure
//
// Usage:
//   node scripts/verify-scnet.mjs [providerName]   # default: scnet
//
// 密钥解析优先级与运行时一致：文件 apiKey > env（PANSHA_<PROV>_API_KEY，scnet 兼容 SCNET_*）。

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const root = process.cwd();
const providerName = String(process.argv[2] || 'scnet').trim();
const envSuffix = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function loadProjectConfig() {
  const projPath = pathResolve(root, '.panshalach.json');
  if (!existsSync(projPath)) return null;
  try {
    return JSON.parse(readFileSync(projPath, 'utf-8'));
  } catch {
    return null;
  }
}

async function main() {
  const proj = loadProjectConfig() || {};
  const providers = proj.providers || {};
  const provCfg = providers[providerName] || {};

  const apiKey =
    provCfg.apiKey ||
    process.env[`PANSHA_${envSuffix}_API_KEY`] ||
    (providerName === 'scnet' ? (process.env.SCNET_API_KEY || process.env.SCNET_KEY) : undefined) ||
    '';

  const baseUrl =
    process.env[`PANSHA_${envSuffix}_BASE_URL`] ||
    provCfg.baseUrl ||
    (providerName === 'scnet' ? 'https://api.scnet.cn/api/llm/v1' : '');

  const defaultModel = proj.model || (Array.isArray(provCfg.models) && provCfg.models[0]) || 'default';

  if (!apiKey || !baseUrl) {
    console.error(`No usable config for provider '${providerName}'.`);
    console.error(`Provide baseUrl+apiKey via .panshalach.json providers.${providerName},`);
    console.error(`or env PANSHA_${envSuffix}_BASE_URL + PANSHA_${envSuffix}_API_KEY.`);
    process.exit(2);
  }

  // Load modules from dist
  const compatModUrl = pathToFileURL(pathResolve(root, 'dist/model/openai-compatible.js')).href;
  const provModUrl = pathToFileURL(pathResolve(root, 'dist/model/ProviderRegistry.js')).href;

  const [{ createOpenAICompatClient }, { ProviderRegistry }] = await Promise.all([
    import(compatModUrl),
    import(provModUrl),
  ]);

  console.error(`=== Provider Verify: ${providerName} ===`);
  console.error('baseUrl     :', baseUrl);
  console.error('defaultModel:', defaultModel);
  console.error('key present :', apiKey ? 'yes (length ' + apiKey.length + ')' : 'no');

  // 1) Direct client smoke (list + one complete)
  let directModels = null;
  try {
    const direct = createOpenAICompatClient({ apiKey, baseUrl });
    console.error('\n[direct] calling listModels...');
    directModels = await direct.listModels();
    console.error('[direct] models count:', directModels ? directModels.length : 0);
    if (directModels && directModels.length) {
      console.error('[direct] first few:', directModels.slice(0, 5).join(', '));
    }

    const modelToUse = directModels && directModels.length ? directModels[0] : defaultModel;
    console.error('[direct] calling complete with model:', modelToUse);

    const prompt = '请用一句话自我介绍。';
    const out = await direct.complete(prompt, { model: modelToUse, maxTokens: 64, temperature: 0.7 });
    console.error('[direct] complete result (truncated):');
    console.error(String(typeof out === 'string' ? out : JSON.stringify(out)).slice(0, 300));
  } catch (e) {
    console.error('[direct] error:', e?.status || '', e?.message || e);
    if (e?.body) console.error('[direct] body:', String(e.body).slice(0, 300));
  }

  // 2) Via ProviderRegistry (more realistic path)
  try {
    const registry = new ProviderRegistry({
      providers: {
        [providerName]: {
          type: 'openai-compatible',
          baseUrl,
          apiKey,
          models: Array.isArray(provCfg.models) ? provCfg.models : [],
          modelContexts: provCfg.modelContexts || {},
        },
      },
      model: defaultModel,
    });

    console.error(`\n[registry] isProviderConfigured("${providerName}"):`, registry.isProviderConfigured(providerName));

    console.error(`[registry] listModels("${providerName}")...`);
    const regModels = await registry.listModels(providerName);
    console.error('[registry] models count:', regModels ? regModels.length : 0);
    if (regModels && regModels.length) {
      console.error('[registry] first few:', regModels.slice(0, 5).join(', '));
    }

    console.error(`[registry] listModelsWithContext("${providerName}")...`);
    const withCtx = await registry.listModelsWithContext(providerName);
    if (withCtx && withCtx.length) {
      console.error('[registry] with context (first 3):');
      for (const m of withCtx.slice(0, 3)) {
        console.error('  -', m.id, 'ctx~', m.contextLength || 256000);
      }
    }

    console.error(`[registry] createClient("${providerName}")...`);
    const client = await registry.createClient(providerName);
    if (!client) {
      console.error('[registry] createClient returned null (no key or misconfig?)');
    } else {
      const m = regModels && regModels[0] ? regModels[0] : defaultModel;
      console.error('[registry] complete with model:', m);
      const out2 = await client.complete('用中文说一句问候。', { model: m, maxTokens: 32 });
      console.error('[registry] result (truncated):', String(typeof out2 === 'string' ? out2 : JSON.stringify(out2)).slice(0, 200));
    }
  } catch (e) {
    console.error('[registry] error:', e?.message || e);
  }

  console.error(`\n=== Provider Verify Done: ${providerName} ===`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
