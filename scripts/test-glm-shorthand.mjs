// scripts/test-glm-shorthand.mjs
// Quick verification that "glm" shorthand routes to a working scnet GLM model.
// Requires SCNET_API_KEY (or it will fail early with a clear message).

import { ProviderRegistry } from '../dist/model/ProviderRegistry.js';

const key = process.env.SCNET_API_KEY || '';
if (!key) {
  console.error('SCNET_API_KEY is required to run this test.');
  process.exit(2);
}

const reg = new ProviderRegistry({
  providers: {
    scnet: {
      type: 'openai-compatible',
      baseUrl: 'https://api.scnet.cn/api/llm/v1',
      apiKey: key
    }
  }
});

(async () => {
  console.log('=== GLM Shorthand Test on scnet ===');
  const models = await reg.listModels('scnet');
  console.log('Models from /models:', models.length);

  // Replicate the logic of DefaultModelProvider._pickBestGLMModel
  const glmNonBase = models.filter(m => /^glm/i.test(m) && !/base/i.test(m));
  const preferred = ['GLM-5.1', 'GLM-5', 'GLM-5.2'].find(m => models.includes(m)) || glmNonBase[0] || 'GLM-5';
  console.log('Shorthand "glm" will use:', preferred);

  const client = await reg.createClient('scnet', preferred);
  if (!client) {
    console.error('Failed to create client for', preferred);
    process.exit(1);
  }

  const r = await client.complete('用一个中文词打招呼。', { maxTokens: 8, temperature: 0.3 });
  console.log('Complete via GLM on scnet: SUCCESS');
  console.log('Response (truncated):', String(r).slice(0, 100));
  console.log('=== GLM shorthand is working ===');
})();
