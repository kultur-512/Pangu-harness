// tests/model/openai-compatible.stream.test.ts
// P1.1: streamChat contract — SSE parsing (reasoning_content + content), [DONE],
// and non-streaming fallback when the endpoint rejects stream requests.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { createOpenAICompatClient } from '../../src/model/openai-compatible.js';

function startSseServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

describe('openai-compatible streamChat', () => {
  const closers: Array<() => void> = [];
  after(() => { for (const c of closers) { try { c(); } catch {} } });

  it('yields thinking then text deltas from SSE stream', async () => {
    const { port, close } = await startSseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { choices: [{ delta: { reasoning_content: '先想' } }] },
        { choices: [{ delta: { reasoning_content: '一步' } }] },
        { choices: [{ delta: { content: '答' } }] },
        { choices: [{ delta: { content: '案是42' } }] },
        '[DONE]',
      ];
      for (const ev of events) {
        const payload = typeof ev === 'string' ? ev : JSON.stringify(ev);
        res.write(`data: ${payload}\n\n`);
      }
      res.end();
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: Array<{ type: string; text: string }> = [];
    for await (const c of client.streamChat!('q')) {
      chunks.push(c as any);
    }

    // Sanity: concatenated content equals the full answer
    const text = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    assert.equal(text, '答案是42');
    const think = chunks.filter(c => c.type === 'thinking').map(c => c.text).join('');
    assert.equal(think, '先想一步');
    // Ordering: all thinking chunks come before any text chunk
    const firstTextIdx = chunks.findIndex(c => c.type === 'text');
    const lastThinkIdx = chunks.map(c => c.type).lastIndexOf('thinking');
    assert.ok(lastThinkIdx < firstTextIdx || firstTextIdx === -1, 'thinking must precede text');
  });

  it('falls back to a single text chunk when streaming is rejected (non-OK)', async () => {
    let firstRequest = true;
    const { port, close } = await startSseServer((req, res) => {
      if (firstRequest) {
        firstRequest = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stream unsupported' }));
        return;
      }
      // Non-streaming complete() path
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        // fix-a6-422: explicit stream:false (fallback is non-streaming by
        // contract; the flag must be explicit so stream-defaulting gateways
        // don't 422 or return SSE to a plain call).
        assert.equal(parsed.stream, false, 'non-streaming call must declare stream:false');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '完整回答' } }] }));
      });
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: Array<{ type: string; text: string }> = [];
    for await (const c of client.streamChat!('q')) {
      chunks.push(c as any);
    }

    assert.deepEqual(chunks, [{ type: 'text', text: '完整回答' }]);
  });

  it('handles chunked transport where one network chunk carries multiple SSE lines', async () => {
    const { port, close } = await startSseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Two SSE events flushed in ONE write (single TCP chunk)
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'b' } }] })}\n\n`
      );
      res.end(`data: [DONE]\n\n`);
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const texts: string[] = [];
    for await (const c of client.streamChat!('q')) {
      if (c.type === 'text') texts.push(c.text);
    }
    assert.equal(texts.join(''), 'ab');
  });

  it('non-streaming complete() parses SSE body when the gateway always streams (fix-a6-routing)', async () => {
    // a6api returns an SSE stream even for a plain (non-stream) request; the
    // non-streaming complete() path must parse the `data:` body and concat
    // delta.content instead of returning '{}' .
    const { port, close } = await startSseServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        assert.equal(parsed.stream, false, 'non-streaming call must declare stream:false');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: '想' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`);
        res.end(`data: [DONE]\n\n`);
      });
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const out = await client.complete('q');
    assert.equal(out, '你好', `SSE body must be parsed by complete(), got: ${JSON.stringify(out)}`);
  });

  it('assembles delta.tool_calls increments into a toolCalls chunk (P1.1)', async () => {
    const { port, close } = await startSseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'wri', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'te_file', arguments: '{"fi' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: 'le":"a.ts"}' } }] } }] },
        { choices: [{ delta: { content: '正在写入' } }] },
        '[DONE]',
      ];
      for (const ev of events) {
        res.write(`data: ${typeof ev === 'string' ? ev : JSON.stringify(ev)}\n\n`);
      }
      res.end();
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: any[] = [];
    for await (const c of client.streamChat!('q')) chunks.push(c as any);

    const tcChunks = chunks.filter(c => c.type === 'toolCalls');
    assert.equal(tcChunks.length, 1, 'exactly one toolCalls chunk at stream end');
    const tc = tcChunks[0].toolCalls[0];
    assert.equal(tc.toolName, 'write_file');
    assert.deepEqual(tc.params, [{ name: 'file', value: 'a.ts' }]);
    const text = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    assert.equal(text, '正在写入');
  });
});
