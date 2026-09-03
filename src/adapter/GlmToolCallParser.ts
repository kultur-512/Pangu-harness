import { ParseOptions, ParseResult, ToolCall, ToolCallParam } from '../types/toolCall.js';

/**
 * GLM-5.3 Tool Call Parser
 *
 * Expected format (observed in real GLM-5.3 output):
 *
 * <>
 *   <Bash>
 *     <command>ls -la /path/to/dir/</command>
 *   </Bash>
 * </>
 *
 * Characteristics:
 * - Root container: <> ... </>
 * - Tool name is the first child tag name (e.g. Bash, Read, Write, ...)
 * - Parameters are child tags under the tool tag: <paramName>value</paramName>
 * - Multiple tool blocks may appear.
 * - Mixed with normal text (thinking).
 */

const ROOT_OPEN = '<>';
const ROOT_CLOSE = '</>';
const TOOL_TAG_REGEX = /<([A-Za-z_][A-Za-z0-9_-]*)>/g;

export class GlmToolCallParser {
  /**
   * Parse a full model response (or accumulated content) for GLM-5.3 style tool calls.
   */
  parse(content: string, options: ParseOptions = {}): ParseResult {
    const warnings: string[] = [];
    const toolCalls: ToolCall[] = [];

    if (!content.includes(ROOT_OPEN) || !content.includes(ROOT_CLOSE)) {
      return {
        toolCalls: [],
        remainingText: content.trim(),
        warnings: content.trim() ? [] : [],
      };
    }

    // Split by root blocks
    const blocks = this.extractRootBlocks(content);

    let remainingParts: string[] = [];
    let lastIndex = 0;

    for (const block of blocks) {
      // Capture text before this block
      const blockStart = content.indexOf(block, lastIndex);
      if (blockStart > lastIndex) {
        remainingParts.push(content.slice(lastIndex, blockStart));
      }
      lastIndex = blockStart + block.length;

      const parsed = this.parseSingleRootBlock(block, options, warnings);
      if (parsed) {
        toolCalls.push(parsed);
      }
    }

    // Remaining text after last block
    if (lastIndex < content.length) {
      remainingParts.push(content.slice(lastIndex));
    }

    return {
      toolCalls,
      remainingText: remainingParts.join('').trim(),
      warnings,
    };
  }

  /**
   * Extract all top-level <>...</> blocks (non-nested for now).
   */
  private extractRootBlocks(content: string): string[] {
    const blocks: string[] = [];
    let searchStart = 0;

    while (true) {
      const openIdx = content.indexOf(ROOT_OPEN, searchStart);
      if (openIdx === -1) break;

      const closeIdx = content.indexOf(ROOT_CLOSE, openIdx + ROOT_OPEN.length);
      if (closeIdx === -1) {
        // Unclosed root — take until end as a block for best-effort parsing
        blocks.push(content.slice(openIdx));
        break;
      }

      const block = content.slice(openIdx, closeIdx + ROOT_CLOSE.length);
      blocks.push(block);
      searchStart = closeIdx + ROOT_CLOSE.length;
    }

    return blocks;
  }

  private parseSingleRootBlock(
    block: string,
    options: ParseOptions,
    warnings: string[]
  ): ToolCall | null {
    // Remove the root wrappers
    const inner = block
      .slice(ROOT_OPEN.length, block.length - ROOT_CLOSE.length)
      .trim();

    if (!inner) {
      warnings.push('Empty root tool call block');
      return null;
    }

    // Find the first opening tag which should be the tool name
    const firstTagMatch = /^<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(inner);
    if (!firstTagMatch) {
      warnings.push('Could not determine tool name from block: ' + inner.slice(0, 60));
      if (options.strict) {
        throw new Error('Invalid GLM tool call block: no tool name tag');
      }
      return null;
    }

    const toolName = firstTagMatch[1];

    // Extract the content inside the tool tag
    const toolOpen = `<${toolName}>`;
    const toolClose = `</${toolName}>`;

    const toolStart = inner.indexOf(toolOpen);
    const toolEnd = inner.lastIndexOf(toolClose);

    let paramsSection = inner;
    if (toolStart !== -1 && toolEnd !== -1 && toolEnd > toolStart) {
      paramsSection = inner.slice(toolStart + toolOpen.length, toolEnd).trim();
    } else {
      // Try to be lenient: if tool tags not perfectly balanced, use inner without first tag
      warnings.push(`Tool tag imbalance for ${toolName}, using best-effort param extraction`);
    }

    const params = this.extractParams(paramsSection, options, warnings);

    return {
      toolName,
      params,
      rawBlock: block,
    };
  }

  private extractParams(
    section: string,
    options: ParseOptions,
    warnings: string[]
  ): ToolCallParam[] {
    const params: ToolCallParam[] = [];
    const maxDepth = options.maxDepth ?? 3;

    // We look for patterns like <paramName>...</paramName>
    // This is a simple non-greedy match; handles basic nesting of same tag? (rare for params)
    const paramRegex = /<([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/\1>/g;

    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = paramRegex.exec(section)) !== null) {
      count++;
      if (count > 100) {
        warnings.push('Too many parameter tags, possible malformed block');
        break;
      }

      const name = match[1];
      let value = match[2];

      // Basic unescape for XML entities that commonly appear
      value = this.unescapeXml(value);

      // If value itself contains another level of param tags, we currently flatten to string.
      // For GLM-5.3 coding use cases this is usually sufficient.
      params.push({ name, value: value.trim() });
    }

    if (params.length === 0 && section.trim().length > 0) {
      // Fallback: try to treat the whole section as a single unnamed 'content' param?
      // We intentionally do NOT do this by default — better to warn.
      warnings.push('No named parameters found inside tool block, raw content: ' + section.slice(0, 80));
    }

    return params;
  }

  private unescapeXml(str: string): string {
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
}
