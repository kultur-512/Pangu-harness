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
import { normalizeToolName } from '../tools/executor.js';

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

/** T3 C13/属性式识别用核心工具清单（normalizeToolName 归一后对照；
 *  MCP/扩展工具不在此列——首标签不命中清单时保持原解析行为，不误伤）。 */
const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash',
]);

/** T6：NO_NAMED_PARAMS 兜底参数名按工具映射（旧实现硬编码 content——bash 的裸
 *  命令体落到 content 后执行必败）。未知工具保持 content。 */
const FALLBACK_PARAM_BY_TOOL: Record<string, string> = {
  bash: 'command',
  read_file: 'file_path',
  glob: 'pattern',
  grep: 'pattern',
  edit_file: 'old_string',
  write_file: 'content',
};

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

    // T3 C06 全角归一：弱模型会输出全角尖括号（＜＞＜/＞）——入参含全角时
    // 替换为半角再走原逻辑（仅在确有全角时做替换，零开销热路径）。
    if (content.includes('＜') || content.includes('＞')) {
      content = content.replace(/＜/g, '<').replace(/＞/g, '>');
      warnings.push('FULLWIDTH_ANGLE_NORMALIZED');
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

    // Strategy 4 (T3 C08/C09): 属性式标签 <tool_name param="value"> ——弱模型把
    // 参数写成属性（如 <read_file path="a.txt">），此前 100% 丢失。只在其余
    // 策略一无所获时尝试，且工具名必须命中核心清单（归一化后）——散文里的
    // <a href="..."> 等 HTML 形态零误伤。
    attempts.push('attribute-tag');
    const attrCalls = this.parseAttributeTagCalls(trimmed, warnings);
    if (attrCalls.length > 0) {
      return {
        toolCalls: attrCalls,
        remainingText: this.extractRemaining(trimmed, attrCalls),
        warnings,
        detectedFormat: 'xml-strict',
        diagnostics: { attempts, warnings: [...warnings] },
      };
    }

    // review 建议落地（rootless 兜底，三重防误报）：弱模型常丢 `<>` 外壳直接以
    // `<read_file>` 开头输出（实测任务4/5 各丢 2 步调用意图）。仅当——
    // (a) 其余策略零产出、(b) trimmed 以核心工具开标签**开头**（散文中段提及
    // 工具名不误伤）、(c) 工具名命中核心清单——才补壳按 XML 解析。
    const trimmedStart = trimmed.trimStart();
    const rootlessMatch = /^<([A-Za-z_][A-Za-z0-9_-]*)>\s*[\s\S]*$/.exec(trimmedStart);
    if (rootlessMatch && CORE_TOOL_NAMES.has(normalizeToolName(rootlessMatch[1]))) {
      const wrapped = `<>${trimmedStart}</>`;
      const retry = this.parse(wrapped, options);
      if (retry.toolCalls.length > 0) {
        return {
          toolCalls: retry.toolCalls,
          remainingText: this.extractRemaining(trimmedStart, retry.toolCalls),
          warnings: [...warnings, 'ROOTLESS_TOOL_BLOCK_RESCUED', ...retry.warnings],
          detectedFormat: 'xml-strict',
          diagnostics: { attempts: [...attempts, 'rootless-rescue'], warnings: [...warnings] },
        };
      }
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

      // T3 C13 首标签错配修补：弱模型会把 <plan>/<thinking> 等推理标签写进
      // 工具块（如 <plan>…</plan><read_file>…</read_file>）——旧逻辑把 plan
      // 当工具名，真调用被整块吞掉。首标签（归一化后）不在核心工具清单时，
      // 在 inner 内继续扫描下一个已知工具标签作为工具名；找不到才保持旧行为。
      let toolMatch = /^<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
      if (!toolMatch) toolMatch = /<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
      let toolName = toolMatch ? toolMatch[1] : '';
      if (toolName && !CORE_TOOL_NAMES.has(normalizeToolName(toolName))) {
        const rescued = this.findNextKnownToolTag(inner);
        if (rescued) {
          warnings.push(`FIRST_TAG_NOT_A_TOOL:${toolName}->${rescued}`);
          toolName = rescued;
        }
      }
      if (!toolName) {
        warnings.push('NO_TOOL_NAME_IN_XML_BLOCK');
        continue;
      }

      const toolOpen = `<${toolName}>`;
      const toolClose = `</${toolName}>`;

      // T3 C19 双调用合并修补：同一块内同名工具开标签出现 >1 次 = 两次调用被
      // 粘进一个块（旧逻辑参数互相覆盖，第二个调用静默丢失）。按开标签拆组，
      // 每组独立提参、独立成 call；同名标签收集 >1 记 DUPLICATE_PARAM 诊断。
      const groups: string[] = [];
      if (inner.indexOf(toolOpen) !== -1) {
        const parts = inner.split(toolOpen);
        parts.shift(); // 丢弃首个开标签之前的前缀（散文/推理标签）
        for (const part of parts) {
          const closeIdx = part.indexOf(toolClose);
          groups.push((closeIdx !== -1 ? part.slice(0, closeIdx) : part).trim());
        }
        if (groups.length > 1) {
          warnings.push(`DUPLICATE_PARAM:${toolName}x${groups.length}`);
        }
      } else {
        // 开标签带属性或写法变体（如 <bash >）——保持旧的整块 body 提取。
        let body = inner;
        const s = inner.indexOf(toolOpen);
        const e = inner.lastIndexOf(toolClose);
        if (s !== -1 && e > s) {
          body = inner.slice(s + toolOpen.length, e).trim();
        } else {
          warnings.push(`TOOL_TAG_IMBALANCE:${toolName}`);
        }
        groups.push(body);
      }

      for (const body of groups) {
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

        // T3 C19：同名参数收集 >1 → DUPLICATE_PARAM 告警并拆为多 call
        // （每对开闭标签一个 call——旧逻辑同一参数互相覆盖，先到者静默丢失）。
        const dupCounts = new Map<string, number>();
        for (const p of params) dupCounts.set(p.name, (dupCounts.get(p.name) ?? 0) + 1);
        const dupNames = [...dupCounts.entries()].filter(([, cnt]) => cnt > 1).map(([n]) => n);

        let paramGroups: ToolCallParam[][];
        if (dupNames.length > 0) {
          warnings.push(`DUPLICATE_PARAM:${dupNames.join(',')}`);
          const maxCount = Math.max(...dupNames.map((n) => dupCounts.get(n)!));
          paramGroups = Array.from({ length: maxCount }, () => [] as ToolCallParam[]);
          const seen = new Map<string, number>();
          for (const p of params) {
            if ((dupCounts.get(p.name) ?? 0) > 1) {
              const k = seen.get(p.name) ?? 0;
              seen.set(p.name, k + 1);
              if (k < maxCount) paramGroups[k].push(p);
            } else {
              // 非重复参数随首个 call 走（保持信息不丢）
              paramGroups[0].push(p);
            }
          }
        } else {
          paramGroups = [params];
        }

        // T6：NO_NAMED_PARAMS 兜底参数名按工具映射（bash→command、
        // read_file→file_path、glob/grep→pattern、edit_file→old_string、
        // write_file→content）；未知工具保持 content。
        if (params.length === 0 && body.length > 0) {
          warnings.push(`NO_NAMED_PARAMS:${toolName}`);
          if (options.strict !== true) {
            const fallbackParam = FALLBACK_PARAM_BY_TOOL[normalizeToolName(toolName)] ?? 'content';
            paramGroups = [[{ name: fallbackParam, value: body.trim() }]];
          }
        }

        for (const group of paramGroups) {
          if (group.length > 0 || options.tolerant) {
            const call: ToolCall = { toolName, params: group, rawBlock: block };
            call.category = inferToolCategory(toolName);
            calls.push(call);
          }
        }
      }
    }
    return calls;
  }

  /** T3 C13：在 inner 内扫描下一个已知工具标签名（跳过参数标签——只有核心
   *  工具名才命中）。找不到返回 undefined（保持旧行为）。 */
  private findNextKnownToolTag(inner: string): string | undefined {
    // review 必须返工-1：救援只认"首标签闭合之后的兄弟工具块"。嵌在未闭合
    // 推理标签内部的工具文本（<plan>先运行 <bash>rm -rf build</bash> 清理
    // </plan>）是对动作的"描述"，救出来就成了"执行"——安全边界回退（探针
    // 实证会产出真实 rm -rf 调用）。因此：先定位首标签的闭合，只在其后扫描。
    const first = /<([A-Za-z_][A-Za-z0-9_-]*)/.exec(inner);
    if (!first) return undefined;
    const closeIdx = inner.indexOf(`</${first[1]}>`, first.index);
    const scanFrom = closeIdx === -1 ? inner.length : closeIdx + first[1].length + 3;
    const re = /<([A-Za-z_][A-Za-z0-9_-]*)/g;
    re.lastIndex = scanFrom;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner)) !== null) {
      if (CORE_TOOL_NAMES.has(normalizeToolName(m[1]))) return m[1];
    }
    return undefined;
  }

  /** T3 C08/C09：属性式标签扫描 `<tool param="value">`（工具名须命中核心清单；
   *  只在其余策略零产出时调用）。 */
  private parseAttributeTagCalls(content: string, warnings: string[]): ToolCall[] {
    const calls: ToolCall[] = [];
    const re = /<([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"\s*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const [, rawName, paramName, rawValue] = m;
      if (!CORE_TOOL_NAMES.has(normalizeToolName(rawName))) continue;
      const call: ToolCall = {
        toolName: rawName,
        params: [{ name: paramName, value: this.unescape(rawValue).trim() }],
        rawBlock: m[0],
      };
      call.category = inferToolCategory(rawName);
      calls.push(call);
      warnings.push(`ATTRIBUTE_PARAM:${rawName}.${paramName}`);
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
