// src/adapter/ToolCallFormatDetector.ts
// 工具调用格式探测层：带置信度打分。
// Strategy: Try OpenAI JSON first (high confidence threshold), then XML structured strict, then loose plain.
// Never modifies the original StrictStructuredToolAdapter or UniversalToolCallAdapter.

import type { ToolCall } from '../types/toolCall.js';
import { StrictStructuredToolAdapter } from './StrictStructuredToolAdapter.js';
import { UniversalToolCallAdapter } from './UniversalToolCallAdapter.js';

export type DetectedFormat = 'openai-json' | 'xml-strict' | 'loose-plain' | 'unknown';

export interface FormatProbeResult {
  format: DetectedFormat;
  confidence: number;          // 0-1
  toolCalls: ToolCall[];
  remainingText: string;
  warnings: string[];
  parseTimeMs: number;
  fallbackUsed: boolean;       // v2: 自动降级时为 true
  attempts: Array<{
    format: DetectedFormat;
    success: boolean;
    reason?: string;
  }>;
}

const extremeAdapter = new StrictStructuredToolAdapter();
const universalAdapter = new UniversalToolCallAdapter();

function safeJsonParse(text: string): any | null {
  try {
    // Try to extract the largest JSON object/array from the text
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let start = -1;
    let end = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      // naive last matching }
      const last = text.lastIndexOf('}');
      if (last > start) end = last + 1;
    } else if (firstBracket !== -1) {
      start = firstBracket;
      const last = text.lastIndexOf(']');
      if (last > start) end = last + 1;
    }

    if (start === -1 || end === -1) return null;

    const candidate = text.slice(start, end);
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function isOpenAiToolCallShape(obj: any): boolean {
  if (!obj) return false;

  // Common shapes:
  // 1. { tool_calls: [{ id, type: 'function', function: { name, arguments } }, ...] }
  // 2. [ { type: 'function', function: { name, arguments } } ]
  if (Array.isArray(obj.tool_calls)) {
    return obj.tool_calls.some((tc: any) =>
      tc &&
      (tc.type === 'function' || tc.function) &&
      (tc.function?.name || tc.name)
    );
  }

  if (Array.isArray(obj)) {
    return obj.some((tc: any) =>
      tc &&
      (tc.type === 'function' || tc.function) &&
      (tc.function?.name || tc.name)
    );
  }

  // Single function call style
  if (obj.function && obj.function.name) return true;
  if (obj.name && typeof obj.arguments === 'string') return true;

  return false;
}

function normalizeOpenAiToToolCalls(obj: any): ToolCall[] {
  const out: ToolCall[] = [];

  const candidates = Array.isArray(obj?.tool_calls) ? obj.tool_calls :
                     Array.isArray(obj) ? obj : [obj];

  for (const c of candidates) {
    if (!c) continue;

    let name = '';
    let args: any = {};

    if (c.function) {
      name = c.function.name || '';
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = {}; }
    } else if (c.name) {
      name = c.name;
      try { args = typeof c.arguments === 'string' ? JSON.parse(c.arguments) : (c.arguments || {}); } catch { args = c.arguments || {}; }
    }

    if (name) {
      out.push({
        toolName: name,
        params: Object.entries(args).map(([k, v]) => ({ name: k, value: String(v) })),
      } as any);
    }
  }

  return out;
}

export class ToolCallFormatDetector {
  static probeAndParse(
    content: string,
    options: { strictStructured?: boolean } = {}
  ): FormatProbeResult {
    const start = Date.now();
    const attempts: FormatProbeResult['attempts'] = [];
    const warnings: string[] = [];

    let best: { format: DetectedFormat; confidence: number; toolCalls: ToolCall[]; remaining: string } = {
      format: 'unknown',
      confidence: 0,
      toolCalls: [],
      remaining: content,
    };

    const { strictStructured = false } = options;

    // Attempt 1: OpenAI JSON (unless strictStructured)
    // Rule A (generalized): a zero-call attempt is recorded but NEVER becomes
    // a candidate — no calls means no format.
    if (!strictStructured) {
      const parsed = safeJsonParse(content);
      if (parsed && isOpenAiToolCallShape(parsed)) {
        const calls = normalizeOpenAiToToolCalls(parsed);
        attempts.push({ format: 'openai-json', success: true });

        if (calls.length > 0 && 0.95 > best.confidence) {
          best = {
            format: 'openai-json',
            confidence: 0.95,
            toolCalls: calls,
            remaining: content.replace(JSON.stringify(parsed), '').trim(),
          };
        }
      } else if (parsed !== null) {
        attempts.push({ format: 'openai-json', success: false, reason: 'no tool_calls shape' });
      } else {
        attempts.push({ format: 'openai-json', success: false, reason: 'json parse failed or no json found' });
      }
    }

    // Attempt 2: XML strict
    // Rule A: only calls.length > 0 may update best (zero-call attempts are
    // recorded in attempts and never become candidates).
    try {
      const res = extremeAdapter.parse(content);
      const calls = res.toolCalls || [];

      attempts.push({ format: 'xml-strict', success: calls.length > 0 });

      if (calls.length > 0 && 0.9 > best.confidence) {
        best = {
          format: 'xml-strict',
          confidence: 0.9,
          toolCalls: calls,
          remaining: res.remainingText || '',
        };
      }
    } catch (e: any) {
      attempts.push({ format: 'xml-strict', success: false, reason: e?.message || 'parse error' });
    }

    // Attempt 3: loose plain (lowest priority)
    // Rule A: same zero-call guard as Attempt 2.
    try {
      const res = universalAdapter.parse(content);
      const calls = res.toolCalls || [];

      attempts.push({ format: 'loose-plain', success: calls.length > 0 });

      if (calls.length > 0 && 0.6 > best.confidence) {
        best = {
          format: 'loose-plain',
          confidence: 0.6,
          toolCalls: calls,
          remaining: res.remainingText || '',
        };
      }
    } catch (e: any) {
      attempts.push({ format: 'loose-plain', success: false, reason: e?.message || 'parse error' });
    }

    // 自动兜底链
    // Rule C: trigger when we have NO calls at all OR confidence is still low.
    let fallbackUsed = false;
    if (best.toolCalls.length === 0 || best.confidence < 0.5) {
      try {
        const res = universalAdapter.parse(content);
        const calls = res.toolCalls || [];
        // Give the fallback a minimum floor if it actually produced something
        const conf = calls.length > 0 ? Math.max(best.confidence, 0.5) : 0.3;

        attempts.push({ format: 'loose-plain', success: calls.length > 0, reason: 'auto-fallback' });

        if (calls.length > 0 || conf > best.confidence) {
          best = {
            format: calls.length > 0 ? 'loose-plain' : best.format,
            confidence: conf,
            toolCalls: calls.length > 0 ? calls : best.toolCalls,
            remaining: res.remainingText || best.remaining,
          };
          fallbackUsed = true;
        }
      } catch (e: any) {
        attempts.push({ format: 'loose-plain', success: false, reason: 'auto-fallback failed: ' + (e?.message || '') });
      }
    }

    // Final selection
    const chosen = best;

    // Rule B (final invariant): no calls → no format. Whatever candidate
    // slipped through with zero toolCalls is forced back to unknown/0.
    if (chosen.toolCalls.length === 0) {
      chosen.format = 'unknown';
      chosen.confidence = 0;
    }

    if (chosen.format === 'unknown' && chosen.toolCalls.length === 0) {
      warnings.push('No tool call format detected with sufficient confidence');
    }

    const parseTimeMs = Date.now() - start;

    return {
      format: chosen.format,
      confidence: chosen.confidence,
      toolCalls: chosen.toolCalls,
      remainingText: chosen.remaining,
      warnings,
      parseTimeMs,
      fallbackUsed,
      attempts,
    };
  }
}
