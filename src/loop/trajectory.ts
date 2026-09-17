// src/loop/trajectory.ts
// 轨迹类型（0.7 从 TestTimeOrchestrator 迁出——该编排器已归档，
// runMultiple 恒单次后 count/sort/预算裁剪全为死路径）。
//
// Trajectory 是"一条 rollout"的轨迹：steps 为逐步轨迹，success/stopReason
// 是回合结局（见 src/cli/repl/types.ts TurnStopReason）。continueCount 已
// 随判官机制摘除（2026-09-05 0.7）。

import type { TurnStopReason } from '../cli/repl/types.js';

export interface TrajectoryStep {
  stepNumber: number;
  thought: string;
  plan: string;
  action: any;
  result: string;
  critique?: string;
  detectedFormat?: string;
  /** 工程纪律合规信号 */
  didRealVerification?: boolean;
  readBeforeWriteViolation?: boolean;
  terminalNoCheck?: boolean;
  automationNoEffectCheck?: boolean;
  /** 面向用户的正文步（空转 answered / chat 直答）——answerText 带出依据 */
  userFacing?: boolean;
}

export interface Trajectory {
  id: string;
  steps: TrajectoryStep[];
  finalPatch?: string;
  /** 成败由验证信号判定（loop：存在 PASS/ALL_TESTS_PASSED 步；answered 亦计入成功） */
  success?: boolean;
  /** 回合停止原因（单层终止语义） */
  stopReason?: TurnStopReason;
  /**
   * aborted 时本步已流出的模型正文（部分结果）。
   * 宿主（sseInteractive/Repl）据此落带 partialText 的 aborted turn。
   */
  partialText?: string;
  /** 单 rollout 全部失败时保留的最后错误（空批保护） */
  lastError?: string;
  /** 是否高纪律/验证密集目标 */
  isStrongTarget?: boolean;
  benchmarkType?: string;
  taskStyle?: string;
  estimatedUsedTokens?: number;
}

/** 空批保护：全部 rollout 失败时的合成失败轨迹（绝不返回 undefined）。 */
export function syntheticFailureTrajectory(lastError?: string): Trajectory {
  return {
    id: 'rollout-all-failed',
    steps: [],
    success: false,
    stopReason: isAbortLikeError(lastError) ? 'aborted' : 'error',
    lastError,
  };
}

/**
 * 异常类别判定：只有"用户/信号主动中止"才算 aborted；
 * 其余一切异常（EMPTY_RESPONSE、网络、5xx、解析）归入 'error'——
 * 模型故障不得被伪装成用户中断（"已中断·现场已保留"只为真中断保留）。
 */
export function isAbortLikeError(errMsg?: string): boolean {
  const msg = String(errMsg ?? '');
  return msg.includes('TASK_ABORTED') || /AbortError/i.test(msg) || /aborted before dispatch/i.test(msg);
}

// ── R3: Turn.result 结构化字段提取 ──

/** 文件写入工具名集合 */
const FILE_WRITE_TOOLS = new Set(['write_file', 'writeFile', 'edit_file', 'editFile']);

/** 验证命令模式（用于识别 bash 验证调用） */
const VERIFY_CMD_PATTERNS = [
  /\b(npx\s+tsc\b[^\n]*)/,
  /\b(npm\s+(test|run\s+test)\b[^\n]*)/,
  /\b(npx\s+tsx\b[^\n]*)/,
  /\b(node\s+\S*\.?(test|spec)\.\S*[^\n]*)/,
  /\b(pytest\b[^\n]*)/,
  /\b(cargo\s+test\b[^\n]*)/,
  /\b(go\s+test\b[^\n]*)/,
  /\b(make\s+test\b[^\n]*)/,
  /\b(npx\s+vitest\b[^\n]*)/,
  /\b(npx\s+jest\b[^\n]*)/,
  /\b(bash\s+\S*verify\S*[^\n]*)/,
];

/**
 * 从 trajectory 步骤中提取变更文件集。
 * 覆盖：write_file/edit_file 的 filePath 参数 + bash 重定向路径（> / >>）。
 */
export function extractChangedFiles(steps: TrajectoryStep[]): string[] {
  const files = new Set<string>();

  for (const step of steps) {
    const action = step.action;
    if (!action) continue;

    // 当前格式：ToolCall { toolName, params[] }
    const toolName = action.toolName || action.name || '';
    const params = action.params || action.args || [];

    if (FILE_WRITE_TOOLS.has(toolName)) {
      // filePath 参数（write_file / edit_file）
      for (const p of params) {
        if (p.name === 'filePath' || p.name === 'file_path' || p.name === 'path') {
          const v = String(p.value || '').trim();
          if (v) files.add(v);
        }
      }
    }

    if (toolName === 'bash' || toolName === 'execute_command') {
      // bash 重定向提取：> path, >> path, 2> path, &> path
      const cmd = params.find((p: any) => p.name === 'command' || p.name === 'cmd');
      if (cmd) {
        const cmdStr = String(cmd.value || '');
        const redirects = cmdStr.matchAll(/(?:[12]?&?>>?|>>?>)\s*(\S+)/g);
        for (const m of redirects) {
          const p = m[1].replace(/["']/g, '').trim();
          if (p && !p.startsWith('/dev/') && !p.startsWith('&')) {
            files.add(p);
          }
        }
      }
    }
  }

  return [...files];
}

/**
 * 从 trajectory 步骤中提取验证命令。
 * 识别 bash 调用中的测试/编译/验证命令。
 */
export function extractVerifyCommands(steps: TrajectoryStep[]): string[] {
  const commands = new Set<string>();

  for (const step of steps) {
    const action = step.action;
    if (!action) continue;

    const toolName = action.toolName || action.name || '';
    if (toolName !== 'bash' && toolName !== 'execute_command') continue;

    const params = action.params || action.args || [];
    const cmd = params.find((p: any) => p.name === 'command' || p.name === 'cmd');
    if (!cmd) continue;

    const cmdStr = String(cmd.value || '').trim();
    for (const pat of VERIFY_CMD_PATTERNS) {
      const m = cmdStr.match(pat);
      if (m) {
        commands.add(m[1].trim());
        break;
      }
    }
  }

  return [...commands];
}

/**
 * 从 stopReason 映射到 TurnOutcome 枚举。
 * 未知值回落 'completed'（保守）。
 */
export function mapOutcome(stopReason?: string): import('../cli/repl/types.js').TurnOutcome {
  const valid = new Set(['completed', 'answered', 'max-steps', 'consecutive-failures', 'aborted', 'no-verification', 'error']);
  if (stopReason && valid.has(stopReason)) {
    return stopReason as import('../cli/repl/types.js').TurnOutcome;
  }
  return 'completed';
}
