// scripts/verify-scnet.mjs
// Pure-Node verification for scnet (OpenAI-compatible) integration.
// - Loads config from .zorge.json (project) or falls back to env vars
// - Calls listModels (or list with context)
// - Performs one lightweight complete
// - Prints results; exits non-zero on hard failure
//
// Usage:
//   node scripts/verify-scnet.mjs
//   # or with explicit key:
//   SCNET_API_KEY=sk-tp-... node scripts/verify-scnet.mjs

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const root = process.cwd();

function loadProjectConfig() {
  const projPath = pathResolve(root, '.zorge.json');
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
  const scnetCfg = providers.scnet || {};

  const apiKey =
    scnetCfg.apiKey ||
    process.env.SCNET_API_KEY ||
    process.env.SCNET_KEY ||
    '';

  const baseUrl = scnetCfg.baseUrl || 'https://api.scnet.cn/api/llm/v1';
  const defaultModel = proj.model || (Array.isArray(scnetCfg.models) && scnetCfg.models[0]) || 'default';

  if (!apiKey) {
    console.error('No scnet apiKey found.');
    console.error('Provide it via .zorge.json providers.scnet.apiKey or SCNET_API_KEY env.');
    process.exit(2);
  }

  // Load modules from dist
  const provModUrl = pathToFileURL(pathResolve(root, 'dist/model/ProviderRegistry.js')).href;
  const scnetModUrl = pathToFileURL(pathResolve(root, 'dist/model/ScnetClient.js')).href;

  const [{ ProviderRegistry }, { createScnetClient }] = await Promise.all([
    import(provModUrl),
    import(scnetModUrl),
  ]);

  console.error('=== Scnet Verify ===');
  console.error('baseUrl     :', baseUrl);
  console.error('defaultModel:', defaultModel);
  console.error('key present :', apiKey ? 'yes (length ' + apiKey.length + ')' : 'no');

  // 1) Direct scnet client smoke (list + one complete)
  let directModels = null;
  try {
    const direct = createScnetClient({ apiKey, baseUrl });
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
    console.error(String(out).slice(0, 300));
  } catch (e) {
    console.error('[direct] error:', e?.status || '', e?.message || e);
    if (e?.body) console.error('[direct] body:', String(e.body).slice(0, 300));
  }

  // 2) Via ProviderRegistry (more realistic path)
  try {
    const registry = new ProviderRegistry({
      providers: {
        scnet: {
          type: 'openai-compatible',
          baseUrl,
          apiKey,
          models: Array.isArray(scnetCfg.models) ? scnetCfg.models : [],
          modelContexts: scnetCfg.modelContexts || {},
        },
      },
      model: defaultModel,
    });

    console.error('\n[registry] isProviderConfigured("scnet"):', registry.isProviderConfigured('scnet'));

    console.error('[registry] listModels("scnet")...');
    const regModels = await registry.listModels('scnet');
    console.error('[registry] models count:', regModels ? regModels.length : 0);
    if (regModels && regModels.length) {
      console.error('[registry] first few:', regModels.slice(0, 5).join(', '));
    }

    console.error('[registry] listModelsWithContext("scnet")...');
    const withCtx = await registry.listModelsWithContext('scnet');
    if (withCtx && withCtx.length) {
      console.error('[registry] with context (first 3):');
      for (const m of withCtx.slice(0, 3)) {
        console.error('  -', m.id, 'ctx~', m.contextLength || 256000);
      }
    }

    console.error('[registry] createClient("scnet")...');
    const client = await registry.createClient('scnet');
    if (!client) {
      console.error('[registry] createClient returned null (no key or misconfig?)');
    } else {
      const m = regModels && regModels[0] ? regModels[0] : defaultModel;
      console.error('[registry] complete with model:', m);
      const out2 = await client.complete('用中文说一句问候。', { model: m, maxTokens: 32 });
      console.error('[registry] result (truncated):', String(out2).slice(0, 200));
    }
  } catch (e) {
    console.error('[registry] error:', e?.message || e);
  }

  console.error('\n=== Scnet Verify Done ===');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
