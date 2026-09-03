// src/model/maoyulin-client.cjs
// Real client for Maoyulin GLM relay (OpenAI-compatible)
// For GLM-5.2 / GLM series via https://api.maoyulin.xyz

const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_BASE_URL = 'https://api.maoyulin.xyz';
const DEFAULT_MODEL = 'glm-5.2';   // user specifically mentioned glm-5.2

/**
 * Creates a model client compatible with ZorgeChaser (and legacy Glm53SweProChaser alias)
 * @param {Object} options
 * @param {string} options.apiKey
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 */
function createMaoyulinClient(options = {}) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
  } = options;

  if (!apiKey) {
    throw new Error('Maoyulin client requires apiKey');
  }

  const apiUrl = new URL('/v1/chat/completions', baseUrl).toString();

  return {
    async complete(prompt, options = {}) {
      const body = {
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 4096,
        stream: false,
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };

      return new Promise((resolve, reject) => {
        const urlObj = new URL(apiUrl);

        const req = https.request(
          {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers,
          },
          (res) => {
            let data = '';

            res.on('data', (chunk) => {
              data += chunk;
            });

            res.on('end', () => {
              if (res.statusCode !== 200) {
                return reject(new Error(`Maoyulin API error ${res.statusCode}: ${data}`));
              }

              try {
                const json = JSON.parse(data);
                const content = json.choices?.[0]?.message?.content || '';
                resolve(content);
              } catch (e) {
                reject(new Error(`Failed to parse response: ${data}`));
              }
            });
          }
        );

        req.on('error', (err) => {
          reject(err);
        });

        req.write(JSON.stringify(body));
        req.end();
      });
    },
  };
}

module.exports = { createMaoyulinClient };
