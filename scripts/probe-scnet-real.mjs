import { ProviderRegistry } from "../dist/model/ProviderRegistry.js";

const key = "sk-tp-Mzg5LTIxNzUzMzg5Njc1LTE3ODY5NTE2MTczMTA=";
const base = "https://api.scnet.cn/api/llm/v1";

const reg = new ProviderRegistry({
  providers: {
    scnet: {
      type: "openai-compatible",
      baseUrl: base,
      apiKey: key
    }
  }
});

(async () => {
  console.log("=== Real Scnet Probe ===");
  const models = await reg.listModels("scnet");
  console.log("Models count:", models ? models.length : 0);
  if (!models || models.length === 0) {
    console.log("No models");
    return;
  }
  console.log("First 15:", models.slice(0,15).join(", "));

  const toTry = models.slice(0, 15);
  for (const m of toTry) {
    try {
      const client = await reg.createClient("scnet", m);
      if (!client) {
        console.log(m + " -> no client");
        continue;
      }
      const out = await client.complete("请用一个中文词回答：你好", { maxTokens: 8, temperature: 0.2 });
      console.log(m + " -> SUCCESS: " + String(out).trim().slice(0, 60));
      console.log("Working model found:", m);
      return;
    } catch (e) {
      const msg = (e && (e.message || e.status)) ? (e.status || "") + " " + String(e.message || e).slice(0,50) : String(e);
      console.log(m + " -> FAIL: " + msg);
    }
  }
  console.log("No model in the first 15 worked with this key/plan for completion.");
})();
