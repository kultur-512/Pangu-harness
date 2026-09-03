// GLM-5.3 Extreme Tool Call Adapter (30-Round Polished Version)
// Production-grade, high-rigor/strict-format hardened tool call parser for GLM-5.x strong mode.
// In strong mode we heavily favor and validate the strict <> XML format while still tolerating some variance for resilience.

import { ToolCall, ToolCallParam, ParseResult, ParseOptions, inferToolCategory } from '../types/toolCall.js';

const ROOT_OPEN = '<>';
const ROOT_CLOSE = '</>';

export interface ParseDiagnostics {
  parseTimeMs: number;
  blocksFound: number;
  blocksParsed: number;
  warnings: string[];
  hadUnclosedRoot: boolean;
  variantsDetected: string[];
}

export interface StreamParseState {
  buffer: string;
  completedCalls: ToolCall[];
  partialBlock: string | null;
  warnings: string[];
  diagnostics: ParseDiagnostics;
}

export class ExtremeGlmToolCallAdapter {
  /**
   * Known root/outer variants we may see from various relays.
   * Used only for diagnostics (not for branching behavior).
   */
  static readonly KNOWN_VARIANTS: string[] = ['<>', '</>', '<tool>', '<tool_call>', 'invoke tool'];
  /**
   * GLM-5.x specific recovery for common malformed outputs.
   * This is critical for high success rate on GLM without punishing the model too hard.
   */
  private tryGlmSpecificRecovery(content: string, options: ParseOptions, warnings: string[]): ToolCall[] {
    const calls: ToolCall[] = [];
    if (!content) return calls;

    // Recovery 1: Direct tool tag without <> root, e.g. <Write> ... </Write>
    const directTool = /<([A-Za-z_][A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = directTool.exec(content)) !== null) {
      const toolName = m[1];
      const body = m[2].trim();

      const params: ToolCallParam[] = [];
      const paramRe = /<([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/\1>/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(body)) !== null) {
        params.push({ name: pm[1], value: this.unescape(pm[2]).trim() });
      }

      if (params.length === 0 && body.length > 0) {
        params.push({ name: 'content', value: body });
      }

      if (params.length > 0 || !options.strict) {
        const call: ToolCall = { toolName, params, rawBlock: m[0] };
        call.category = inferToolCategory(toolName);
        calls.push(call);
        warnings.push(`RECOVERED_DIRECT_TOOL:${toolName}`);
      }
    }

    if (calls.length > 0) return calls;

    // Recovery 2: "invoke tool" style that GLM sometimes emits
    const invokeMatch = /invoke\s+tool\s+([A-Za-z_][A-Za-z0-9_-]+)\s+with([\s\S]*?)(?=\n\n|invoke tool|$)/i.exec(content);
    if (invokeMatch) {
      const toolName = invokeMatch[1];
      const inside = invokeMatch[2] || '';
      const params: ToolCallParam[] = [];
      const kv = /([A-Za-z_][A-Za-z0-9_-]+)\s+is\s+([\s\S]*?)(?=\s+[A-Za-z_][A-Za-z0-9_-]+\s+is\s+|$)/g;
      let km;
      while ((km = kv.exec(inside)) !== null) {
        params.push({ name: km[1], value: km[2].trim().replace(/^["']|["']$/g, '') });
      }
      if (params.length === 0 && inside.trim()) {
        params.push({ name: 'content', value: inside.trim() });
      }
      const call: ToolCall = { toolName, params, rawBlock: invokeMatch[0] };
      call.category = inferToolCategory(toolName);
      calls.push(call);
      warnings.push(`RECOVERED_INVOKE_STYLE:${toolName}`);
      return calls;
    }

    // Recovery 3: Very loose - any <Tag>value</Tag> pairs, treat first tag as tool if possible
    const loosePairs = /<([A-Za-z_][A-Za-z0-9_-]+)>([\s\S]*?)<\/\1>/g;
    const allParams: ToolCallParam[] = [];
    let firstTool: string | null = null;
    let lm;
    while ((lm = loosePairs.exec(content)) !== null) {
      if (!firstTool) firstTool = lm[1];
      allParams.push({ name: lm[1], value: this.unescape(lm[2]).trim() });
    }
    if (firstTool && allParams.length > 0) {
      calls.push({
        toolName: firstTool,
        params: allParams,
        rawBlock: content.slice(0, 300),
      });
      warnings.push(`RECOVERED_LOOSE_XML:${firstTool}`);
    }

    return calls;
  }

  /**
   * Full response parse (non-streaming)
   * In strict mode (default for GLM strong/high-rigor path), we are very strict about <> format.
   * 整个 parse 被 try/catch 保护，任何解析异常都不会杀死 rollout。
   */
  parse(content: string, options: ParseOptions = {}): ParseResult {
    try {
      return this._parseInternal(content, options);
    } catch (err: any) {
      const msg = err?.message || String(err);
      return {
        toolCalls: [],
        remainingText: typeof content === 'string' ? content : '',
        warnings: [`PARSE_EXCEPTION: ${msg.slice(0, 200)}`],
      };
    }
  }

  private _parseInternal(content: string, options: ParseOptions): ParseResult {
    const start = Date.now();
    const warnings: string[] = [];
    const toolCalls: ToolCall[] = [];
    const variantsDetected: string[] = [];

    if (!content || typeof content !== 'string') {
      return { toolCalls: [], remainingText: '', warnings: ['EMPTY_OR_INVALID_INPUT'] };
    }

    const trimmed = content.trim();

    // Fast path: if no root at all, try GLM-specific recovery before giving up
    if (!trimmed.includes(ROOT_OPEN)) {
      const recovered = this.tryGlmSpecificRecovery(trimmed, options, warnings);
      if (recovered.length > 0) {
        return {
          toolCalls: recovered,
          remainingText: '',
          warnings: [...warnings, 'RECOVERED_VIA_GLM_HEURISTICS'],
        };
      }
      return {
        toolCalls: [],
        remainingText: trimmed,
        warnings: [],
      };
    }

    // Detect possible variant usage for diagnostics
    for (const v of ExtremeGlmToolCallAdapter.KNOWN_VARIANTS) {
      if (trimmed.includes(v) && v !== '<>') variantsDetected.push(v);
    }

    const blocks = this.extractRootBlocks(trimmed);
    let last = 0;
    const remainingParts: string[] = [];

    for (const block of blocks) {
      const pos = trimmed.indexOf(block, last);
      if (pos > last) remainingParts.push(trimmed.slice(last, pos));
      last = pos + block.length;

      const parsed = this.parseSingleBlock(block, options, warnings);
      if (parsed) {
        toolCalls.push(parsed);
      }
    }

    if (last < trimmed.length) {
      remainingParts.push(trimmed.slice(last));
    }

    // If we found root but zero successful parses, try aggressive recovery
    if (toolCalls.length === 0 && trimmed.includes(ROOT_OPEN)) {
      const recovered = this.tryGlmSpecificRecovery(trimmed, options, warnings);
      if (recovered.length > 0) {
        toolCalls.push(...recovered);
        warnings.push('RECOVERED_AFTER_ROOT_DETECTION');
      }
    }

    const diagnostics: ParseDiagnostics = {
      parseTimeMs: Date.now() - start,
      blocksFound: blocks.length,
      blocksParsed: toolCalls.length,
      warnings: [...warnings],
      hadUnclosedRoot: trimmed.includes(ROOT_OPEN) && !trimmed.includes(ROOT_CLOSE),
      variantsDetected,
    };

    if (toolCalls.length > 0) {
      (toolCalls[0] as any).diagnostics = diagnostics;
    }

    return {
      toolCalls,
      remainingText: remainingParts.join('').trim(),
      warnings,
    };
  }

  /**
   * Streaming / incremental parse
   */
  parseStreamChunk(state: StreamParseState, chunk: string, options: ParseOptions = {}): StreamParseState {
    const start = Date.now();
    state.buffer += chunk;
    state.warnings = state.warnings || [];

    const blocks = this.extractRootBlocks(state.buffer);

    for (const block of blocks) {
      const parsed = this.parseSingleBlock(block, options, state.warnings);
      if (parsed) {
        state.completedCalls.push(parsed);
      }
      const idx = state.buffer.indexOf(block);
      if (idx !== -1) {
        state.buffer = state.buffer.slice(idx + block.length);
      }
    }

    // Detect unclosed root
    const openIdx = state.buffer.lastIndexOf(ROOT_OPEN);
    if (openIdx !== -1 && !state.buffer.includes(ROOT_CLOSE, openIdx)) {
      state.partialBlock = state.buffer.slice(openIdx);
    } else {
      state.partialBlock = null;
    }

    // Update diagnostics
    if (!state.diagnostics) {
      state.diagnostics = {
        parseTimeMs: 0,
        blocksFound: 0,
        blocksParsed: 0,
        warnings: [],
        hadUnclosedRoot: false,
        variantsDetected: [],
      };
    }
    state.diagnostics.parseTimeMs += Date.now() - start;
    state.diagnostics.blocksFound = blocks.length;
    state.diagnostics.blocksParsed = state.completedCalls.length;
    state.diagnostics.hadUnclosedRoot = state.partialBlock !== null;

    return state;
  }

  private extractRootBlocks(text: string): string[] {
    const blocks: string[] = [];
    let i = 0;
    while (true) {
      const o = text.indexOf(ROOT_OPEN, i);
      if (o === -1) break;
      const c = text.indexOf(ROOT_CLOSE, o);
      if (c === -1) {
        break; // leave for streaming or next chunk
      }
      blocks.push(text.slice(o, c + ROOT_CLOSE.length));
      i = c + ROOT_CLOSE.length;
    }
    return blocks;
  }

  private parseSingleBlock(block: string, options: ParseOptions, warnings: string[]): ToolCall | null {
    const inner = block.slice(ROOT_OPEN.length, block.length - ROOT_CLOSE.length).trim();
    if (!inner) {
      warnings.push('EMPTY_ROOT_BLOCK');
      return null;
    }

    // Try to find tool name - support both <> style and potential <Tool> directly
    let toolNameMatch = /^<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
    if (!toolNameMatch) {
      // Fallback: look for first opening tag anywhere
      toolNameMatch = /<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
    }

    if (!toolNameMatch) {
      warnings.push('NO_TOOL_NAME_TAG');
      if (options.strict) throw new Error('Invalid GLM tool call: no tool name tag found');
      return null;
    }

    const toolName = toolNameMatch[1];
    const openTag = `<${toolName}>`;
    const closeTag = `</${toolName}>`;

    let body = inner;
    const s = inner.indexOf(openTag);
    const e = inner.lastIndexOf(closeTag);
    if (s !== -1 && e > s) {
      body = inner.slice(s + openTag.length, e).trim();
    } else {
      warnings.push(`TOOL_TAG_IMBALANCE:${toolName}`);
    }

    const params: ToolCallParam[] = [];
    const re = /<([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/\1>/g;
    let mm: RegExpExecArray | null;

    while ((mm = re.exec(body)) !== null) {
      let value = mm[2];
      value = this.unescape(value);
      params.push({ name: mm[1], value: value.trim() });
    }

    if (params.length === 0 && body.length > 0) {
      warnings.push(`NO_NAMED_PARAMS:${toolName}`);
      // As a last resort for some GLM outputs, treat entire body as "content"
      if (options.strict !== true) {
        params.push({ name: 'content', value: body.trim() });
      }
    }

    const call: ToolCall = {
      toolName,
      params,
      rawBlock: block,
    };

    return call;
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

  /**
   * Generate high-quality repair hint specifically tuned for GLM-5.x failure modes.
   * This is one of the most important pieces for maintaining high success rate on GLM.
   */
  generateRepairHint(warnings: string[], lastRawOutput: string): string {
    const hints: string[] = [];

    const hasNoTool = warnings.some(w =>
      w.includes('NO_TOOL_NAME_TAG') || w.includes('NO_TOOL') || w.includes('RECOVERED')
    );
    const hasImbalance = warnings.some(w => w.includes('TOOL_TAG_IMBALANCE'));
    const hasNoParams = warnings.some(w => w.includes('NO_NAMED_PARAMS') || w.includes('NO_PARAMS'));
    const hadRecovery = warnings.some(w => w.includes('RECOVERED'));

    if (hasNoTool || lastRawOutput.includes('<>') === false) {
      hints.push(
        '必须严格使用 GLM-5.x 标准格式（最重要）：\n' +
        '<>\n' +
        '  <ToolName>\n' +
        '    <file_path>src/xxx.js</file_path>\n' +
        '    <content>完整代码内容</content>\n' +
        '  </ToolName>\n' +
        '</>\n' +
        '注意：根必须是 <> 和 </> ，工具名要用单独标签包裹参数。'
      );
    }

    if (hasImbalance) {
      hints.push('每个工具调用必须正确闭合，例如 </Write>、</Read>、</Bash>。不要遗漏结束标签。');
    }

    if (hasNoParams) {
      hints.push(
        '参数必须使用带名字的标签，不能把整个内容直接塞在 <ToolName> 里。\n' +
        '正确示例： <command>ls -l</command> 、 <file_path>src/a.js</file_path>'
      );
    }

    // Special case: model output raw tags instead of values (very common GLM bug)
    if (lastRawOutput.includes('<file_path>') && lastRawOutput.includes('</file_path>') &&
        !lastRawOutput.match(/<file_path>[^<]+<\/file_path>/)) {
      hints.push('参数值要直接写在标签之间，不要再嵌套标签。例如 <file_path>src/calculator.js</file_path>');
    }

    if (hadRecovery) {
      hints.push('上一次输出格式不标准，系统尝试恢复但可能不完整。请严格按照标准 <> 格式重新输出。');
    }

    if (hints.length === 0) {
      hints.push('请严格按照 GLM-5.x 的 <> 格式输出工具调用，不要添加多余解释。');
    }

    return [
      '【GLM-5.x 格式错误修复指令】',
      ...hints,
      '只输出正确的工具调用块，不要解释。'
    ].join('\n');
  }

  /**
   * Create fresh stream state
   */
  createStreamState(): StreamParseState {
    return {
      buffer: '',
      completedCalls: [],
      partialBlock: null,
      warnings: [],
      diagnostics: {
        parseTimeMs: 0,
        blocksFound: 0,
        blocksParsed: 0,
        warnings: [],
        hadUnclosedRoot: false,
        variantsDetected: [],
      },
    };
  }
}

