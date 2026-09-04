// 结构化 Extreme Tool Call Types + Trajectory Signals
// 扩展支持：SWE / Terminal-Bench 3.0 / AutomationBench

export interface ToolCallParam {
  name: string;
  value: string;
}

/**
 * 工具大类（用于验证路由、纪律规则判断、打分等）
 * - file: 读写文件类（SWE 常用）
 * - terminal: 终端命令执行（Terminal-Bench 3.0 核心）
 * - automation: 业务自动化 / API / 工作流（AutomationBench）
 * - test: 运行测试 / 验证
 * - other: 其他
 */
export type ToolCategory =
  | 'file'
  | 'terminal'
  | 'automation'
  | 'test'
  | 'other';

export interface ToolCall {
  toolName: string;
  params: ToolCallParam[];
  rawBlock: string;
  /** Attached by parsers for debugging */
  diagnostics?: any;
  format?: string; // from universal parser
  /** 工具分类（可选，由解析器或上层推断） */
  category?: ToolCategory;
}

/** 工具执行结果（验证引擎输出） */
export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  exitCode?: number;
  /** 结构化状态（Terminal-Bench / AutomationBench 常用） */
  stateSnapshot?: Record<string, any>;
  meta?: Record<string, any>;
}

/** 根据工具名推断分类（用于验证路由、纪律规则、打分） */
export function inferToolCategory(toolName: string): ToolCategory {
  const n = (toolName || '').toLowerCase();

  // Terminal / shell style
  const terminalNames = [
    'bash', 'runcommand', 'run_command', 'exec', 'shell', 'sh', 'cmd',
    'ls', 'cd', 'cat', 'mkdir', 'rm', 'touch', 'mv', 'cp', 'chmod', 'chown',
    'ps', 'kill', 'curl', 'wget', 'ping', 'netstat', 'ss', 'df', 'du',
    'checkstate', 'getstate', 'stat'
  ];
  if (terminalNames.some(t => n === t || n.includes(t))) return 'terminal';

  // Automation / workflow / api
  const automationNames = [
    'callapi', 'executeworkflow', 'transformdata', 'checkstatus', 'verifyeffect',
    'send', 'create', 'update', 'delete', 'post', 'get', 'patch', 'put',
    'trigger', 'action', 'webhook', 'notify', 'email', 'slack', 'record'
  ];
  if (automationNames.some(t => n === t || n.includes(t))) return 'automation';

  // File operations (SWE style)
  const fileNames = [
    'read', 'write', 'edit', 'read_file', 'write_file', 'edit_file',
    'glob', 'grep', 'search', 'list', 'find'
  ];
  if (fileNames.some(t => n === t || n.includes(t))) return 'file';

  // Test / verification
  const testNames = ['test', 'runtest', 'run_test', 'pytest', 'jest', 'mocha', 'vitest'];
  if (testNames.some(t => n === t || n.includes(t))) return 'test';

  return 'other';
}

export interface ParseResult {
  toolCalls: ToolCall[];
  remainingText: string;
  warnings: string[];
}

export interface ParseOptions {
  strict?: boolean;
  maxDepth?: number;
}

/** Files that were successfully read during a trajectory (for Read-Before-Write enforcement) */
export interface TrajectoryContext {
  filesRead: Set<string>;
  filesWritten: Set<string>;
  verificationAttempts: number;
}

