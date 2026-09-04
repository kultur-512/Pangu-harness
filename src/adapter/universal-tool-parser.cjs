// src/adapter/universal-tool-parser.cjs
// Universal Tool Call Parser
// Supports:
// 1. XML structured style: <> <ToolName> <param>value</param> </ToolName> </>
// 2. Standard OpenAI: tool_calls array with function.name + arguments JSON

function parseUniversalToolCalls(rawResponse) {
  if (!rawResponse) return [];

  const calls = [];

  // === Strategy 1: Try standard OpenAI tool_calls format (most models) ===
  // This usually comes in the parsed JSON, but since we get raw text here, we look for it in text too.
  try {
    // If the relay returns proper tool_calls in the message, it would be in the full response.
    // But since our complete() returns only content, we also try to detect in the raw string.
    const toolCallMatch = /"tool_calls"\s*:\s*(\[[\s\S]*?\])/;
    const match = rawResponse.match(toolCallMatch);
    if (match) {
      const toolCallsJson = JSON.parse(match[1]);
      for (const tc of toolCallsJson) {
        if (tc.function) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          calls.push({
            toolName: tc.function.name,
            params: Object.entries(args).map(([k, v]) => ({ name: k, value: String(v) })),
            format: 'openai'
          });
        }
      }
      if (calls.length > 0) return calls;
    }
  } catch (e) {
    // ignore
  }

  // === Strategy 2: XML structured <> style (our current main target) ===
  const ROOT_OPEN = '<>';
  const ROOT_CLOSE = '</>';
  let search = rawResponse;

  while (true) {
    const o = search.indexOf(ROOT_OPEN);
    if (o === -1) break;
    const c = search.indexOf(ROOT_CLOSE, o);
    if (c === -1) break;

    const block = search.slice(o, c + ROOT_CLOSE.length);
    search = search.slice(c + ROOT_CLOSE.length);

    const inner = block.slice(ROOT_OPEN.length, -ROOT_CLOSE.length).trim();
    if (!inner) continue;

    const toolMatch = /^<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
    if (!toolMatch) continue;

    const toolName = toolMatch[1];

    const params = [];
    const paramRe = /<([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = paramRe.exec(inner)) !== null) {
      params.push({ name: m[1], value: m[2].trim() });
    }

    if (params.length === 0) {
      const toolOpen = `<${toolName}>`;
      const toolClose = `</${toolName}>`;
      const s = inner.indexOf(toolOpen);
      const e = inner.lastIndexOf(toolClose);
      if (s !== -1 && e > s) {
        const body = inner.slice(s + toolOpen.length, e).trim();
        if (body) params.push({ name: 'content', value: body });
      }
    }

    calls.push({
      toolName,
      params,
      format: 'xml-strict'
    });
  }

  // Strategy 2 did not produce results. Try loose plain-text style.
  // Strategy 3: Loose plain-text style seen on some relays
  // Observed examples:
  //   Read(file_path="C:\\...\\calculator.js")
  //   Write(file_path="src/calculator.js", content="export function add...")
  //   Bash(command="npm test")
  {
    const looseRe = /\b(Read|Write|Edit|Bash|read_file|write_file|bash)\s*\(([^)]*)\)/gi;
    let lm;
    while ((lm = looseRe.exec(rawResponse)) !== null) {
      const toolName = lm[1];
      const inside = lm[2] || '';
      const params = [];
      const kvRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,)]+))/g;
      let km;
      while ((km = kvRe.exec(inside)) !== null) {
        const key = km[1];
        let val = (km[2] ?? km[3] ?? km[4] ?? '').trim();
        val = val.replace(/^["'\s]+|["'\s]+$/g, '');
        params.push({ name: key, value: val });
      }
      if (params.length === 0) {
        const single = inside.trim().replace(/^["']|["']$/g, '');
        if (single) {
          const defaultKey = (toolName.toLowerCase() === 'bash') ? 'command' : 'content';
          params.push({ name: defaultKey, value: single });
        }
      }
      if (params.length > 0 || toolName) {
        calls.push({
          toolName,
          params,
          format: 'loose-plain'
        });
      }
    }
  }

  return calls;
}

module.exports = { parseUniversalToolCalls };
