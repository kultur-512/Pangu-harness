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
      // 0.8.2 容错切分（真机 1B 实录）：弱模型常漏写 `</>`（块 1 只写
      // </read_file> 就直接开块 2 的 `<>`）——indexOf(ROOT_CLOSE) 会把两个
      // 工具块粘成一个，第二个调用被整块吞掉（多工具步只执行第一个的根因）。
      // 块内若再出现 ROOT_OPEN，则以它为界强制闭合前块。
      const o2 = search.indexOf(ROOT_OPEN, o + ROOT_OPEN.length);
      let block: string;
      if (o2 !== -1 && (c === -1 || o2 < c)) {
        block = search.slice(o, o2);
        search = search.slice(o2);
        warnings.push('ROOT_OPEN_FORCED_CLOSE');
      } else if (c !== -1) {
        block = search.slice(o, c + ROOT_CLOSE.length);
        search = search.slice(c + ROOT_CLOSE.length);
      } else {
        // 尾块残缺（`<>` 已开、全文再无任何闭合）——此前直接 break 把最后
        // 一块整块丢掉；仅当剩余部分像工具块（含 <ToolName> 字样）才
        // best-effort 收块，纯散文里的孤立 `<>` 仍保持丢弃。
        const rest = search.slice(o);
        if (!/<[A-Za-z_][A-Za-z0-9_-]*>/.test(rest.slice(ROOT_OPEN.length))) break;
        block = rest;
        search = '';
        warnings.push('UNCLOSED_TAIL_BLOCK');
      }

      // 包D 修复：容错切分/尾块残缺分支的 block 不以 `</>` 结尾——此前对
      // 两个分支共用 slice(ROOT_OPEN.length, -ROOT_CLOSE.length)，把容错块
      // 末尾 3 个真实字符咬掉（最后一个参数如 <content>x</content> 被咬成
      // <content>x</cont → 参数静默丢失）。只有块真以 `</>` 收尾才砍尾部。
      const inner = (block.endsWith(ROOT_CLOSE)
        ? block.slice(ROOT_OPEN.length, block.length - ROOT_CLOSE.length)
        : block.slice(ROOT_OPEN.length)
      ).trim();
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
      const closedRanges: Array<[number, number]> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        closedRanges.push([m.index, m.index + m[0].length]);
        params.push({ name: m[1], value: this.unescape(m[2]).trim() });
      }

      // 包D 修复（残缺闭合标签 best-effort）：弱模型连参数闭合标签都写残
      // （`<content>x</cont`）时，上面的正则要求完整闭合会静默丢参——对
      // 已开未闭的标签把值 best-effort 取到 body 末尾（剥掉尾部残缺的闭合
      // 前缀），并跳过已被完整配对消费的区间，避免重复提取。
      const openRe = /<([A-Za-z_][A-Za-z0-9_-]*)>/g;
      let om: RegExpExecArray | null;
      while ((om = openRe.exec(body)) !== null) {
        if (om[1] === toolName) continue; // 工具自身的开标签不是参数
        if (closedRanges.some(([s, e]) => om!.index >= s && om!.index < e)) continue;
        const valStart = om.index + om[0].length;
        const val = this.unescape(
          body.slice(valStart).replace(/<\/(?:[A-Za-z_][A-Za-z0-9_-]*)?$/, '').trim()
        ).trim();
        if (val) params.push({ name: om[1], value: val });
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
