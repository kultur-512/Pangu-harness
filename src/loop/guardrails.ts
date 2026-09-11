// src/loop/guardrails.ts
// M2-2 卡死检测硬闸（docs/panshalach/PLAN-0.8-FOUNDATION.md §3 M2-2）
// 移植 hermes agent/tool_guardrails.py 的 ToolCallGuardrailController，三道硬闸：
//   1. exactFailureBlockAfter=5  —— 同工具+同参数（JSON 序列化签名）失败 5 次
//      → before_call 阻断，注入"该调用已连续失败 N 次，请改变方法或 end_turn"。
//   2. sameToolFailureHaltAfter=8 —— 同工具失败 8 次（参数可变，专治换参数重试
//      永不收敛）→ 强制终局 stopReason='consecutive-failures'（复用现有终态）。
//   3. noProgressBlockAfter=5    —— 幂等工具（read_file/glob/grep）同参数同结果
//      重复 5 次（无进展空转）→ 同上阻断。
//   4. readonlyDenyBlockAfter=2  —— 同工具 DENIED_READONLY 连续 ≥2 次 → 阻断并
//      注入强指引（end_turn 报告 + /approvals default）。readonly 语义确定、重试
//      无意义，阈值比一般失败更早止损（0.8.1 UX 收敛，真机 MiniMax-M3 实测驱动）。
// 与现有 maxConsecutiveFailures 并行（互不替代）：前者按步信号粗计数，
// 本闸按"同参数同工具"签名细计数，阻断发生在 before_call（执行前），而非事后掐。

import type { ToolCall } from '../types/toolCall.js';

/** before_call 判定：blocked=false 放行；blocked=true 时本步不执行工具。 */
export interface GuardrailDecision {
  blocked: boolean;
  /** 阻断原因（作为工具结果文本回灌 history，模型可见）。 */
  reason?: string;
  /** halt 级：强制终局（loop 直接置 done + stopReason='consecutive-failures'）。 */
  halt?: boolean;
}

export interface ToolCallGuardrailOptions {
  exactFailureBlockAfter?: number;
  sameToolFailureHaltAfter?: number;
  noProgressBlockAfter?: number;
  /** 只读拒绝快速通道阈值：同工具 DENIED_READONLY 连续 N 次 → 阻断（缺省 2）。 */
  readonlyDenyBlockAfter?: number;
  /** 幂等工具结果比较的预览截断长度（取结果前 N 字符）。 */
  progressPreviewLength?: number;
  /** 幂等工具名白名单（小写化匹配）。 */
  idempotentTools?: string[];
}

const DEFAULT_IDEMPOTENT_TOOLS = ['read_file', 'glob', 'grep'];

/**
 * 同工具+同参数的唯一签名：JSON 序列化（参数按 name 排序——参数顺序无关）。
 * 序列化串直接作 Map 键（确定性、无碰撞），不引入哈希依赖。
 */
export function toolCallSignature(call: ToolCall): string {
  const sorted = [...(call.params ?? [])]
    .map((p) => [p.name, String(p.value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${call.toolName ?? ''}\u0000${JSON.stringify(sorted)}`;
}

/** 失败降级推断（调用方未显式传 failed 时用）：结果串含 FAIL/ERROR 即失败。 */
function looksLikeFailure(result: string): boolean {
  return result.includes('FAIL') || result.includes('ERROR');
}

export class ToolCallGuardrailController {
  private readonly exactFailureBlockAfter: number;
  private readonly sameToolFailureHaltAfter: number;
  private readonly noProgressBlockAfter: number;
  private readonly readonlyDenyBlockAfter: number;
  private readonly progressPreviewLength: number;
  private readonly idempotentTools: Set<string>;

  /** 签名 → 该签名失败次数（该签名成功时归零——"连续"按无成功间隔计）。 */
  private exactFailures = new Map<string, number>();
  /** 工具名 → 该工具失败次数（该工具成功时归零）。 */
  private toolFailures = new Map<string, number>();
  /** 签名 → { preview, count }：幂等工具同结果重复计数。 */
  private noProgress = new Map<string, { preview: string; count: number }>();
  /** 工具名 → 连续 DENIED_READONLY 次数（成功 / 非只读拒绝即归零）。 */
  private readonlyDenials = new Map<string, number>();

  constructor(options: ToolCallGuardrailOptions = {}) {
    this.exactFailureBlockAfter = options.exactFailureBlockAfter ?? 5;
    this.sameToolFailureHaltAfter = options.sameToolFailureHaltAfter ?? 8;
    this.noProgressBlockAfter = options.noProgressBlockAfter ?? 5;
    this.readonlyDenyBlockAfter = options.readonlyDenyBlockAfter ?? 2;
    this.progressPreviewLength = options.progressPreviewLength ?? 200;
    this.idempotentTools = new Set(
      (options.idempotentTools ?? DEFAULT_IDEMPOTENT_TOOLS).map((t) => t.toLowerCase())
    );
  }

  /**
   * 执行前检查本步全部调用。返回首个阻断判定；未阻断返回 { blocked: false }。
   * 闸门优先级：halt（强制终局，最重）> readonlyDeny（只读拒绝快速通道，语义
   * 确定最早止损）> exact（同参数重复失败）> noProgress（无进展）。
   */
  beforeCall(calls: ToolCall[]): GuardrailDecision {
    for (const call of calls) {
      const halt = this.checkHalt(call);
      if (halt) return halt;
    }
    for (const call of calls) {
      const ro = this.checkReadonlyDenial(call);
      if (ro) return ro;
    }
    for (const call of calls) {
      const exact = this.checkExact(call);
      if (exact) return exact;
    }
    for (const call of calls) {
      const noProgress = this.checkNoProgress(call);
      if (noProgress) return noProgress;
    }
    return { blocked: false };
  }

  /**
   * 喂执行结果（execute 之后逐 call 调用）。
   * @param failed 可选显式失败标记：loop 传入其分段信号语义（classifySignal）的
   *   判定，避免只读输出正文偶含 FAIL/ERROR 字样被误计；缺省按结果串降级推断。
   */
  recordResult(call: ToolCall, result: string, failed?: boolean): void {
    const name = String(call.toolName ?? '').trim();
    const key = toolCallSignature(call);
    const isFailure = failed ?? looksLikeFailure(result);

    if (isFailure) {
      this.exactFailures.set(key, (this.exactFailures.get(key) ?? 0) + 1);
      this.toolFailures.set(name, (this.toolFailures.get(name) ?? 0) + 1);
    } else {
      // 成功即打破连败：该签名 / 该工具计数归零。
      this.exactFailures.delete(key);
      this.toolFailures.delete(name);
      // 只读拒绝快速通道：该工具执行成功（如用户已 /approvals default 放行）→ 归零。
      this.readonlyDenials.delete(name);
    }

    // 幂等无进展跟踪：同签名同结果（截断预览）重复计数；结果变化即重置。
    if (this.idempotentTools.has(name.toLowerCase())) {
      const preview = String(result ?? '').slice(0, this.progressPreviewLength);
      const prev = this.noProgress.get(key);
      if (prev && prev.preview === preview) {
        prev.count += 1;
      } else {
        this.noProgress.set(key, { preview, count: 1 });
      }
    }
  }

  /**
   * 只读拒绝快速通道（0.8.1 UX）：execute 返回 DENIED_READONLY 结果时按工具逐
   * call 调用。reason 含 DENIED_READONLY → 连续计数 +1；否则（拒绝性质变化）
   * 该工具计数归零。达阈值后 beforeCall 直接阻断——readonly 语义确定，同参数
   * 重试无意义，比一般失败硬闸（5/8）更早止损。
   */
  recordDenied(tool: string, reason: string): void {
    const name = String(tool ?? '').trim();
    if (!name) return;
    if (String(reason ?? '').includes('DENIED_READONLY')) {
      this.readonlyDenials.set(name, (this.readonlyDenials.get(name) ?? 0) + 1);
    } else {
      this.readonlyDenials.delete(name);
    }
  }

  private checkHalt(call: ToolCall): GuardrailDecision | undefined {
    const name = String(call.toolName ?? '').trim();
    const count = this.toolFailures.get(name) ?? 0;
    if (count >= this.sameToolFailureHaltAfter) {
      return {
        blocked: true,
        halt: true,
        reason:
          `TOOL_ERROR: GUARDRAIL_HALT\n` +
          `同工具 ${name} 已失败 ${count} 次，强制结束本轮（consecutive-failures）。`,
      };
    }
    return undefined;
  }

  private checkReadonlyDenial(call: ToolCall): GuardrailDecision | undefined {
    const name = String(call.toolName ?? '').trim();
    const count = this.readonlyDenials.get(name) ?? 0;
    if (count >= this.readonlyDenyBlockAfter) {
      return {
        blocked: true,
        reason:
          `TOOL_ERROR: GUARDRAIL_READONLY_DENIED\n` +
          `当前为只读档位，写操作无法执行。请立即 end_turn 并向用户报告：` +
          `需要用户执行 /approvals default 切换档位后重试（${name} 已连续被只读拒绝 ${count} 次）。`,
      };
    }
    return undefined;
  }

  private checkExact(call: ToolCall): GuardrailDecision | undefined {
    const name = String(call.toolName ?? '').trim();
    const key = toolCallSignature(call);
    const count = this.exactFailures.get(key) ?? 0;
    if (count >= this.exactFailureBlockAfter) {
      return {
        blocked: true,
        reason:
          `TOOL_ERROR: GUARDRAIL_EXACT_FAILURE\n` +
          `该调用已连续失败 ${count} 次，请改变方法或 end_turn（${name}）。`,
      };
    }
    return undefined;
  }

  private checkNoProgress(call: ToolCall): GuardrailDecision | undefined {
    const name = String(call.toolName ?? '').trim().toLowerCase();
    if (!this.idempotentTools.has(name)) return undefined;
    const key = toolCallSignature(call);
    const entry = this.noProgress.get(key);
    if (entry && entry.count >= this.noProgressBlockAfter) {
      return {
        blocked: true,
        reason:
          `TOOL_ERROR: GUARDRAIL_NO_PROGRESS\n` +
          `该调用已重复 ${entry.count} 次且结果完全相同（无进展），请改变方法或 end_turn（${name}）。`,
      };
    }
    return undefined;
  }
}
