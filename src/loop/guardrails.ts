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
import { normalizeToolName } from '../tools/executor.js';
import { WRITE_TOOLS } from '../tools/approval.js';

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

/**
 * 只读拒绝尾标（engineAdapter 契约）：聚合文本中对每个 gate readonly 拒绝的
 * 调用，在其结果段落【末尾】追加一行 `[TOOL_DENIED_READONLY <toolName>]`。
 * 判定用分段尾锚定（与 VerifyCritiqueLoop.classifySignal 的 segEndsWith 同一
 * 分段方式，'\n---\n' 切段后逐段测尾标）——旧的整段 includes('DENIED_READONLY')
 * 会把读到含该字面量的文件正文（如本仓库守卫源码自身）误计成只读拒绝。
 */
const DENIED_READONLY_TAIL_RE = /(?:^|\n)\[TOOL_DENIED_READONLY\s+\S+\]\s*$/;

function reasonHasReadonlyDenialTail(reason: string): boolean {
  return String(reason ?? '')
    .split('\n---\n')
    .some((seg) => DENIED_READONLY_TAIL_RE.test(seg));
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
      // 只读拒绝快速通道：仅【写工具】执行成功（如用户已 /approvals default
      // 放行）才视为 readonly 根因解除、跨工具总计数归零。read/grep 成功不清
      // 零——否则只读档下"写拒→读成功"交替会永久饿死阈值 2 的快速止损
      // （对抗审查 P1-3，注释原称"写工具成功"但代码不查工具类型）。
      if (WRITE_TOOLS.has(normalizeToolName(name))) {
        this.readonlyDenials.delete('__any_write__');
      }
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
   * call 调用。reason 的分段【尾部】含 `[TOOL_DENIED_READONLY <tool>]` 标记行 →
   * 连续计数 +1；否则（拒绝性质变化）该工具计数归零。达阈值后 beforeCall 直接
   * 阻断——readonly 语义确定，同参数重试无意义，比一般失败硬闸（5/8）更早止损。
   */
  recordDenied(tool: string, reason: string): void {
    const name = String(tool ?? '').trim();
    if (!name) return;
    // 0.8.2 一致性修复（真机 1B 实录）：readonly 拒绝按【跨工具总数】计数——
    // 此前按工具名分桶，write_file 1 次 + edit_file 1 次 = 各 1，阈值 2 永不
    // 触发，模型在只读档位死磕到步数耗尽。readonly 场景任何写类拒绝都是同一
    // 根因（档位），总计数 2 即阻断并指引用户。
    if (reasonHasReadonlyDenialTail(reason)) {
      this.readonlyDenials.set('__any_write__', (this.readonlyDenials.get('__any_write__') ?? 0) + 1);
    } else {
      this.readonlyDenials.delete('__any_write__');
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
    // 0.8.2：跨工具总计数（readonly 场景任何写类拒绝都是同一根因——
    // 真机 1B 实录：write 1 次 + edit 1 次 = 按工具分桶各 1，阈值 2 永不触发，
    // 模型死磕到步数耗尽）。
    const count = this.readonlyDenials.get('__any_write__') ?? 0;
    if (count >= this.readonlyDenyBlockAfter) {
      return {
        blocked: true,
        reason:
          `TOOL_ERROR: GUARDRAIL_READONLY_DENIED\n` +
          `当前为只读档位，任何写操作（write_file/edit_file）都无法执行，` +
          `与具体工具无关（已累计拒绝 ${count} 次）。本任务无法在只读档位完成：` +
          `请立即 end_turn，并向用户说明"需要切换到 default 档位（/approvals default 或 shift+tab）后重新提交任务"。` +
          `不要再次尝试任何写操作。`,
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
