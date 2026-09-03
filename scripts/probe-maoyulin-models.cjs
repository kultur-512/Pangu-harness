// probe-maoyulin-models.cjs
// Query the Maoyulin relay for supported /v1/models to see which model ids are actually available.
const https = require('node:https');

const MAOYULIN_KEY = process.env.MAOYULIN_KEY || '';
const MAOYULIN_BASE = process.env.MAOYULIN_BASE || 'https://api.maoyulin.xyz';

const url = `${MAOYULIN_BASE}/v1/models`;

const headers = {
  'Authorization': `Bearer ${MAOYULIN_KEY}`,
};

https.request(url, { method: 'GET', headers }, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const json = JSON.parse(data);
      const models = (json.data || json.models || []).map(m => m.id || m.name || JSON.stringify(m));
      console.log('Available models count:', models.length);
      models.forEach((m, i) => console.log(`${(i+1).toString().padStart(3)}  ${m}`));
      if (models.length === 0) {
        console.log('Raw response (truncated):', data.slice(0, 2000));
      }
    } catch (e) {
      console.log('Parse error. Raw:');
      console.log(data.slice(0, 3000));
    }
  });
}).on('error', e => console.error('Request error:', e.message)).end();

