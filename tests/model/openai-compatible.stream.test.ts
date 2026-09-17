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

  // ── 包D 修复：llama.cpp/vLLM/MindIE 方言每个 chunk 重发完整 name ──
  // 此前 acc.name += d.function.name 把整名重发拼成 write_filewrite_file。

  it('方言整名重发 3 次 → name 幂等不重复（包D修复）', async () => {
    const { port, close } = await startSseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 3 个 chunk 的 delta.function.name 都是完整工具名（整名重发方言）
      const nameChunk = (args: string) => JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'write_file', arguments: args } }] } }],
      });
      res.write(`data: ${nameChunk('')}\n\n`);
      res.write(`data: ${nameChunk('')}\n\n`);
      res.write(`data: ${nameChunk('{"file_path":"a.ts"}')}\n\n`);
      res.end(`data: [DONE]\n\n`);
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: any[] = [];
    for await (const c of client.streamChat!('q')) chunks.push(c as any);

    const tc = chunks.filter(c => c.type === 'toolCalls')[0]?.toolCalls?.[0];
    assert.ok(tc, 'toolCalls chunk 必须产出');
    assert.equal(tc.toolName, 'write_file', `整名重发 3 次必须幂等，got: ${tc.toolName}`);
    assert.deepEqual(tc.params, [{ name: 'file_path', value: 'a.ts' }]);
  });

  it('方言 name 首片重复后再真分片 → 拼接正确（包D修复）', async () => {
    const { port, close } = await startSseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (name: string, args: string) => JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: args } }] } }],
      });
      res.write(`data: ${chunk('wri', '')}\n\n`);
      res.write(`data: ${chunk('wri', '')}\n\n`);   // 重复首片（前缀重复方言）
      res.write(`data: ${chunk('te_file', '{"file_path":"b.ts"}')}\n\n`); // 真分片
      res.end(`data: [DONE]\n\n`);
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: any[] = [];
    for await (const c of client.streamChat!('q')) chunks.push(c as any);

    const tc = chunks.filter(c => c.type === 'toolCalls')[0]?.toolCalls?.[0];
    assert.ok(tc, 'toolCalls chunk 必须产出');
    assert.equal(tc.toolName, 'write_file', `got: ${tc.toolName}`);
    assert.deepEqual(tc.params, [{ name: 'file_path', value: 'b.ts' }]);
  });

  // ── 包D 修复：SSE 尾行无换行被丢——逐行处理依赖 indexOf('\n')，流以
  // 无尾随换行的 data: {...} / data: [DONE] 结束时最后一行静默丢失
  // （usage 丢失 / sawAny 误判触发非流式重发双请求）──

  it('SSE 尾行（usage chunk）无换行 → usage 仍回调、不触发非流式重发（包D修复）', async () => {
    let requests = 0;
    let usageSeen: { prompt?: number; completion?: number } | null = null;
    const { port, close } = await startSseServer((req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`);
      // 末行（usage chunk）无 \n、无 [DONE]
      res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}`);
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const texts: string[] = [];
    for await (const c of client.streamChat!('q', { onUsage: (u) => { usageSeen = u; } })) {
      if (c.type === 'text') texts.push(c.text);
    }
    assert.equal(texts.join(''), '你好');
    assert.deepEqual(usageSeen, { prompt: 7, completion: 3 }, '尾行 usage 不得因缺尾随换行被丢');
    assert.equal(requests, 1, '不得触发非流式重发');
  });

  it('SSE 尾行（唯一正文）无换行 → 正文不丢、sawAny 不误判（包D修复）', async () => {
    let requests = 0;
    const { port, close } = await startSseServer((req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 唯一的正文 chunk 在末行且无换行——旧实现整行丢弃 → sawAny=false → 回退重发
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '尾行正文' } }] })}`);
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const texts: string[] = [];
    for await (const c of client.streamChat!('q')) {
      if (c.type === 'text') texts.push(c.text);
    }
    assert.equal(texts.join(''), '尾行正文', '末行正文必须经 flush 产出');
    assert.equal(requests, 1, `sawAny 不得误判触发非流式重发，got ${requests} 次请求`);
  });

  it('SSE 末行 data: [DONE] 无换行 → 正常结束不挂起（守卫）', async () => {
    const { port, close } = await startSseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`);
      res.end(`data: [DONE]`);
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const texts: string[] = [];
    for await (const c of client.streamChat!('q')) {
      if (c.type === 'text') texts.push(c.text);
    }
    assert.equal(texts.join(''), 'a');
  });

  // ── 0.7.4 任务 B4：streamChat 回退走 withRetry + emptyResponse 转空串 ──

  it('0.7.4 B4: fallback doComplete is wrapped in withRetry (≥2 requests on transient failure)', async () => {
    // 第一次流式请求返回 400 → 回退路径；回退后第一次 complete 返回 500（可重试），
    // 第二次返回 200 有效 body。裸调用时代码在这里会直接抛 complete failed: 500。
    let streamRequests = 0;
    let completeRequests = 0;
    const { port, close } = await startSseServer((req, res) => {
      let body = '';
      req.on('data', (c: any) => { body += String(c); });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (parsed.stream === true) {
          streamRequests++;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'stream unsupported' }));
          return;
        }
        completeRequests++;
        if (completeRequests === 1) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('transient');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '回退重试成功' } }] }));
      });
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: any[] = [];
    for await (const c of client.streamChat!('q')) chunks.push(c as any);
    assert.equal(completeRequests, 2, '回退 doComplete 必须经 withRetry 重试');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, 'text');
    assert.equal(chunks[0].text, '回退重试成功');
  });

  it('0.7.4 B4: fallback EMPTY_RESPONSE exhausted → yields empty text chunk (no throw-through)', async () => {
    // LM Studio diffusion 实测形状：200 + 非 completions body（无 choices）。
    // 回退路径 EMPTY_RESPONSE 重试耗尽 → 转空串（与 complete 同语义），不再穿透。
    let requests = 0;
    const { port, close } = await startSseServer((req, res) => {
      let body = '';
      req.on('data', (c: any) => { body += String(c); });
      req.on('end', () => {
        requests++;
        const parsed = JSON.parse(body || '{}');
        if (parsed.stream === true) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'no stream' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('Unexpected endpoint or method. Returning 200 anyway.');
      });
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: any[] = [];
    for await (const c of client.streamChat!('q')) chunks.push(c as any);
    assert.ok(requests >= 7, `1 次流式 + ≥6 次 withRetry（EMPTY_RESPONSE 可重试），got ${requests}`);
    assert.equal(chunks.length, 1, '重试耗尽返回单个空 text chunk');
    assert.equal(chunks[0].type, 'text');
    assert.equal(chunks[0].text, '', 'emptyResponse 耗尽转空串，不抛穿透');
  });
});
