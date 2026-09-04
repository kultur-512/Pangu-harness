// src/adapter/UniversalToolCallAdapter.ts
// Universal Tool Call Adapter for the Panshalach Memory-Augmented Agent Framework
//
// Design principles:
// - XML structured format strictness in high-rigor mode
// - Other models via same relay must also work reasonably
// - Support formats actually observed on relays:
//     1. Strict XML structured: <> <ToolName> <p>v</p> </ToolName> </>
//     2. Loose plain: Read(file_path="..."), Write(file_path=..., content=...)
//     3. invoke tool XXX with param is value
//     4. OpenAI tool_calls (if relay ever returns them in content)
// - Always return the canonical ToolCall[] shape used by the framework
// - Provide format detection + hints so the loop can coach the model

import { ToolCall, ToolCallParam, ParseResult, ParseOptions, inferToolCategory } from '../types/toolCall.js';

export type ToolCallFormat =
  | 'xml-strict'
  | 'loose-plain'
  | 'openai-tool_calls'
  | 'unknown';

export interface UniversalParseResult extends ParseResult {
  detectedFormat?: ToolCallFormat;
  diagnostics?: {
    attempts: string[];
    warnings: string[];
  };
}

export interface UniversalParseOptions extends ParseOptions {
  /** Parser/format strictness: only accept strict XML structured <> blocks. Legacy flag.
   *  When combined with high-rigor/strong mode at higher layers, this yields strict format enforcement.
   *  Not the same as the agent's high-level "strong mode" (heavy verification + iron laws).
   */
  strictStructured?: boolean;
  /** Be extra tolerant (good for weak/other models) */
  tolerant?: boolean;
}

export class UniversalToolCallAdapter {
  private static readonly ROOT_OPEN = '<>';
  private static readonly ROOT_CLOSE = '</>';

  /**
   * Primary parse entry point.
   */
  parse(content: string, options: UniversalParseOptions = {}): UniversalParseResult {
    const warnings: string[] = [];
    const attempts: string[] = [];
    let detectedFormat: ToolCallFormat = 'unknown';

    if (!content || typeof content !== 'string') {
      return { toolCalls: [], remainingText: '', warnings: ['EMPTY_INPUT'] };
    }

    const trimmed = content.trim();

    // Strategy 1: Strict XML (best for high-rigor mode)
    attempts.push('xml-strict');
    if (trimmed.includes(UniversalToolCallAdapter.ROOT_OPEN)) {
      const strictCalls = this.parseStrictXmlStructured(trimmed, options, warnings);
      if (strictCalls.length > 0) {
        return {
          toolCalls: strictCalls,
          remainingText: this.extractRemaining(trimmed, strictCalls),
          warnings,
          detectedFormat: 'xml-strict',
          diagnostics: { attempts, warnings: [...warnings] },
        };
      }
    }

    if (options.strictStructured) {
      return {
        toolCalls: [],
        remainingText: trimmed,
        warnings: [...warnings, 'STRICT_XML_ONLY_NO_MATCH'],
        detectedFormat: 'xml-strict',
        diagnostics: { attempts, warnings: [...warnings] },
      };
    }

    // Strategy 2: OpenAI tool_calls JSON in text
    attempts.push('openai-tool_calls');
    const openai = this.parseOpenAiToolCalls(trimmed, warnings);
    if (openai.length > 0) {
      return {
        toolCalls: openai,
        remainingText: trimmed,
        warnings,
        detectedFormat: 'openai-tool_calls',
        diagnostics: { attempts, warnings: [...warnings] },
      };
    }

    // Strategy 3: Loose plain-text (models that do not emit strict XML)
    attempts.push('loose-plain');
    const loose = this.parseLoosePlainText(trimmed, warnings, !!options.tolerant);
    if (loose.length > 0) {
      return {
        toolCalls: loose,
        remainingText: trimmed,
        warnings,
        detectedFormat: 'loose-plain',
        diagnostics: { attempts, warnings: [...warnings] },
      };
    }

    return {
      toolCalls: [],
      remainingText: trimmed,
      warnings: [...warnings, 'NO_TOOL_CALLS_DETECTED'],
      detectedFormat: 'unknown',
      diagnostics: { attempts, warnings: [...warnings] },
    };
  }

  private parseStrictXmlStructured(content: string, options: UniversalParseOptions, warnings: string[]): ToolCall[] {
    const calls: ToolCall[] = [];
    const ROOT_OPEN = UniversalToolCallAdapter.ROOT_OPEN;
    const ROOT_CLOSE = UniversalToolCallAdapter.ROOT_CLOSE;

    let search = content;
    while (true) {
      const o = search.indexOf(ROOT_OPEN);
      if (o === -1) break;
      const c = search.indexOf(ROOT_CLOSE, o);
      if (c === -1) break;

      const block = search.slice(o, c + ROOT_CLOSE.length);
      search = search.slice(c + ROOT_CLOSE.length);

      const inner = block.slice(ROOT_OPEN.length, -ROOT_CLOSE.length).trim();
      if (!inner) continue;

      let toolMatch = /^<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
      if (!toolMatch) toolMatch = /<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
      if (!toolMatch) {
        warnings.push('NO_TOOL_NAME_IN_XML_BLOCK');
        continue;
      }

      const toolName = toolMatch[1];
      const toolOpen = `<${toolName}>`;
      const toolClose = `</${toolName}>`;

      let body = inner;
      const s = inner.indexOf(toolOpen);
      const e = inner.lastIndexOf(toolClose);
      if (s !== -1 && e > s) {
        body = inner.slice(s + toolOpen.length, e).trim();
      } else {
        warnings.push(`TOOL_TAG_IMBALANCE:${toolName}`);
      }

      const params: ToolCallParam[] = [];
      const re = /<([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/\1>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        params.push({ name: m[1], value: this.unescape(m[2]).trim() });
      }

      if (params.length === 0 && body.length > 0) {
        warnings.push(`NO_NAMED_PARAMS:${toolName}`);
        if (options.strict !== true) {
          params.push({ name: 'content', value: body.trim() });
        }
      }

      if (params.length > 0 || options.tolerant) {
        const call: ToolCall = { toolName, params, rawBlock: block };
        call.category = inferToolCategory(toolName);
        calls.push(call);
      }
    }
    return calls;
  }

  private parseOpenAiToolCalls(content: string, warnings: string[]): ToolCall[] {
    const calls: ToolCall[] = [];
    try {
      const match = /"tool_calls"\s*:\s*(\[[\s\S]*?\])/m.exec(content);
      if (!match) return calls;
      const arr = JSON.parse(match[1]);
      if (!Array.isArray(arr)) return calls;

      for (const tc of arr) {
        if (tc?.function?.name) {
          let args: any = {};
          try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = { raw: tc.function.arguments }; }
          const params: ToolCallParam[] = Object.entries(args).map(([k, v]) => ({
            name: k,
            value: typeof v === 'string' ? v : JSON.stringify(v),
          }));
          calls.push({ toolName: tc.function.name, params, rawBlock: JSON.stringify(tc) });
        }
      }
    } catch {
      warnings.push('OPENAI_TOOL_CALLS_PARSE_FAILED');
    }
    return calls;
  }

  private parseLoosePlainText(content: string, warnings: string[], tolerant: boolean): ToolCall[] {
    const calls: ToolCall[] = [];

    // Pattern A: ToolName(key="val", key2='val2')
    const fnRe = /\b(Read|Write|Edit|Bash|read_file|write_file|bash|Ls|Glob|Grep|Search)\s*\(([^)]*)\)/gi;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(content)) !== null) {
      const toolName = m[1];
      const inside = m[2] || '';
      const params = this.parseKv(inside);
      if (params.length > 0 || tolerant) {
        const call: ToolCall = { toolName, params, rawBlock: m[0] };
        call.category = inferToolCategory(toolName);
        calls.push(call);
      }
    }

    // Pattern B: invoke tool Foo with bar is xxx  baz is yyy
    const invokeRe = /invoke\s+tool\s+([A-Za-z_][A-Za-z0-9_-]*)\s+with([\s\S]*?)(?=\n\n|\ninvoke tool|\n<|$)/gi;
    while ((m = invokeRe.exec(content)) !== null) {
      const toolName = m[1];
      const inside = m[2] || '';
      const params: ToolCallParam[] = [];
      const kvRe = /([A-Za-z_][A-Za-z0-9_-]*)\s+is\s+([\s\S]*?)(?=\s+[A-Za-z_][A-Za-z0-9_-]+\s+is\s+|$)/g;
      let km: RegExpExecArray | null;
      while ((km = kvRe.exec(inside)) !== null) {
        params.push({
          name: km[1],
          value: km[2].trim().replace(/^["']|["']$/g, ''),
        });
      }
      if (params.length > 0 || tolerant) {
        const call: ToolCall = { toolName, params, rawBlock: m[0] };
        call.category = inferToolCategory(toolName);
        calls.push(call);
      }
    }

    return calls;
  }

  private parseKv(inside: string): ToolCallParam[] {
    const params: ToolCallParam[] = [];
    const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,)]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inside)) !== null) {
      const key = m[1];
      let val = (m[2] ?? m[3] ?? m[4] ?? '').trim();
      val = val.replace(/^["'\s]+|["'\s]+$/g, '');
      params.push({ name: key, value: val });
    }
    if (params.length === 0) {
      const s = inside.trim().replace(/^["']|["']$/g, '');
      if (s) params.push({ name: 'content', value: s });
    }
    return params;
  }

  private unescape(str: string): string {
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  private extractRemaining(content: string, calls: ToolCall[]): string {
    let r = content;
    for (const c of calls) {
      if (c.rawBlock) r = r.replace(c.rawBlock, '');
    }
    return r.trim();
  }

  /**
   * Coaching hint based on detected format or target model family.
   */
  generateFormatHint(detected: ToolCallFormat | undefined, model?: string): string {
    const m = (model || '').toLowerCase();
    if (detected === 'xml-strict' || m.includes('xml')) {
      return `请严格使用标准结构化 XML 格式：\n<>\n  <ToolName>\n    <paramName>value</paramName>\n  </ToolName>\n</>`;
    }
    return `请使用以下格式之一：\n` +
           `Read(file_path="src/xx.js")\n` +
           `Write(file_path="src/xx.js", content="完整代码...")\n` +
           `Bash(command="npm test")\n` +
           `或 invoke tool Read with file_path is src/xx.js`;
  }
}
