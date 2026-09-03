// src/model/ScnetClient.ts
// Scnet provider client factory.
// scnet is OpenAI-compatible at:
//   baseUrl: https://api.scnet.cn/api/llm/v1
//   models: GET /models
//   completions: POST /chat/completions
//
// This is a thin specialized factory over the generic openai-compatible client.

import { createOpenAICompatClient, OpenAICompatClient, OpenAICompatConfig } from './openai-compatible.js';

export interface ScnetClientConfig {
  apiKey: string;
  /** Optional override for baseUrl (for testing or future mirrors) */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Create a scnet OpenAI-compatible client.
 * Throws only on obviously bad config (missing key).
 * Network failures are thrown from the underlying client methods.
 */
export function createScnetClient(config: ScnetClientConfig): OpenAICompatClient {
  if (!config || !config.apiKey) {
    throw new Error('createScnetClient requires apiKey');
  }

  const baseUrl = config.baseUrl || 'https://api.scnet.cn/api/llm/v1';

  const compatConfig: OpenAICompatConfig = {
    baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  };

  return createOpenAICompatClient(compatConfig);
}
