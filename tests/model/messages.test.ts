// tests/model/messages.test.ts
// 0.8 P1（M1-PROTOCOL）模型层 messages 接口：
// - chat(messages, opts) 请求体形状（messages 直传 / system 首位 / assistant tool_calls 透传
//   / tool role + tool_call_id 配对（原生 FC）/ 文本降级标注）
// - streamChatMessages 流式路径与 fallback 路径（请求体为 messages，SSE 读循环与 streamChat 同构）
// - complete(prompt) 与 chat([{role:'user',content:prompt}]) 行为等价（请求体与响应处理一致）
// - tools 透传在 chat 路径存在（body.tools + tool_choice:'auto'）

import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { createOpenAICompatClient, type ChatMessage } from '../../src/model/openai-compatible.js';

const origFetch = (globalThis as any).fetch;

function mockFetch(handler: (url: string, init?: any) => Promise<any>) {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const res = await handler(url, init);
    return {
      ok: res.ok !== false,
      status: res.status ?? 200,
      statusText: res.statusText ?? 'OK',
      async json() { return res.json ?? {}; },
      async text() { return res.text ?? ''; },
    } as any;
  };
}

function restoreFetch() {
  (globalThis as any).fetch = origFetch;
}

function makeClient() {
  return createOpenAICompatClient({ baseUrl: 'https://ex.com/v1', apiKey: 'k' });
}

function startSseServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

describe('openai-compatible chat(messages) 请求体形状', () => {
  afterEach(restoreFetch);

  it('messages 数组原样直传（system 首位约定由调用方保证）', async () => {
    let seen: any;
    mockFetch(async (url, init) => {
      assert.match(url, /chat\/completions/);
      seen = JSON.parse(init.body);
      return { ok: true, json: { choices: [{ message: { content: 'hi!' } }] } };
    });

    const out = await makeClient().chat([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ]);

    assert.deepEqual(seen.messages, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ]);
    assert.equal(seen.stream, false);
    assert.equal(out, 'hi!');
  });

  it('assistant 消息携带 toolCalls → 透传原生 tool_calls 数组', async () => {
    const tcArray = [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"file":"a.ts"}' } }];
    let seen: any;
    mockFetch(async (url, init) => {
      seen = JSON.parse(init.body);
      return { ok: true, json: { choices: [{ message: { content: 'ok' } }] } };
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '', toolCalls: tcArray },
    ];
    await makeClient().chat(messages, { tools: [{ name: 'write_file' }] });

    assert.deepEqual(seen.messages[1], { role: 'assistant', content: '', tool_calls: tcArray });
  });

  it('tool role + 原生 FC（opts.tools 存在）→ role:tool + tool_call_id 配对', async () => {
    let seen: any;
    mockFetch(async (url, init) => {
      seen = JSON.parse(init.body);
      return { ok: true, json: { choices: [{ message: { content: 'ok' } }] } };
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: '写文件' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
      { role: 'tool', content: '写入成功', toolCallId: 'call_1', name: 'write_file' },
    ];
    await makeClient().chat(messages, { tools: [{ name: 'write_file' }] });

    assert.deepEqual(seen.messages[2], { role: 'tool', tool_call_id: 'call_1', content: '写入成功' });
  });

  it('tool role 无 tools（文本协议降级）→ role:user + `【工具 <name> 结果】` 标注', async () => {
    let seen: any;
    mockFetch(async (url, init) => {
      seen = JSON.parse(init.body);
      return { ok: true, json: { choices: [{ message: { content: 'ok' } }] } };
    });

    await makeClient().chat([
      { role: 'user', content: '跑命令' },
      { role: 'tool', content: 'ls 输出', toolCallId: 'call_9', name: 'bash' },
    ]);

    assert.deepEqual(seen.messages[1], { role: 'user', content: '【工具 bash 结果】\nls 输出' });
  });

  it('chat 同样返回结构化输出（响应侧 tool_calls 转换不退化）', async () => {
    mockFetch(async () => ({
      ok: true,
      json: {
        choices: [{
          message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
        }],
      },
    }));
    const out: any = await makeClient().chat([{ role: 'user', content: 'ls' }]);
    assert.equal(typeof out, 'object');
    assert.equal(out.detectedFormat, 'openai-json');
    assert.equal(out.toolCalls[0].toolName, 'bash');
  });
});

describe('openai-compatible streamChatMessages', () => {
  const closers: Array<() => void> = [];
  after(() => { for (const c of closers) { try { c(); } catch {} } });

  it('流式路径：请求体为 messages（stream:true），SSE 读循环产出 text chunk', async () => {
    let capturedBody: any = null;
    const { port, close } = await startSseServer((req, res) => {
      let body = '';
      req.on('data', (c: any) => { body += String(c); });
      req.on('end', () => {
        capturedBody = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '世界' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const chunks: any[] = [];
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ];
    for await (const c of client.streamChatMessages(messages)) chunks.push(c);

    assert.deepEqual(capturedBody.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]);
    assert.equal(capturedBody.stream, true);
    const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('');
    assert.equal(text, '你好世界');
  });

  it('fallback 路径：流式被拒（400）→ 回退非流式，请求体仍为 messages', async () => {
    let capturedFallbackBody: any = null;
    const { port, close } = await startSseServer((req, res) => {
      let body = '';
      req.on('data', (c: any) => { body += String(c); });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (parsed.stream === true) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'stream unsupported' }));
          return;
        }
        capturedFallbackBody = parsed;
        assert.equal(parsed.stream, false, '回退必须显式 stream:false');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '完整回答' } }] }));
      });
    });
    closers.push(close);

    const client = createOpenAICompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    const messages: ChatMessage[] = [{ role: 'user', content: 'q' }];
    const chunks: any[] = [];
    for await (const c of client.streamChatMessages(messages)) chunks.push(c);

    assert.deepEqual(capturedFallbackBody.messages, [{ role: 'user', content: 'q' }]);
    assert.deepEqual(chunks, [{ type: 'text', text: '完整回答' }]);
  });
});

describe('complete(prompt) ≡ chat([{role:user,content:prompt}])', () => {
  afterEach(restoreFetch);

  it('同一 mock fetch 下请求体与响应处理一致', async () => {
    const bodies: any[] = [];
    mockFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: { choices: [{ message: { content: 'same' }, finish_reason: 'stop' }] } };
    });

    const client = makeClient();
    const a = await client.complete('hello');
    const b = await client.chat([{ role: 'user', content: 'hello' }]);

    assert.equal(a, 'same');
    assert.equal(b, 'same');
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1], 'complete 与 chat 的请求体必须逐字段等价');
  });
});

describe('openai-compatible chat tools 透传', () => {
  afterEach(restoreFetch);

  it('opts.tools 存在 → body.tools（function schema）+ tool_choice:auto', async () => {
    let seen: any;
    mockFetch(async (url, init) => {
      seen = JSON.parse(init.body);
      return { ok: true, json: { choices: [{ message: { content: 'ok' } }] } };
    });

    await makeClient().chat([{ role: 'user', content: '读文件' }], {
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    });

    assert.deepEqual(seen.tools, [{
      type: 'function',
      function: {
        name: 'read_file',
        description: '读文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
    assert.equal(seen.tool_choice, 'auto');
  });
});
