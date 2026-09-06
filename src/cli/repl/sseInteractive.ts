// src/cli/repl/sseInteractive.ts
// Default interactive CLI for plain `pangu` (no args).
//
// Transport (P0.2): the default path consumes runAgentTask() DIRECTLY in-process.
// No loopback HTTP, no port. The HTTP+SSE server remains available explicitly
// via the `serve` command for remote/browser clients.
//
// UI strategy (Hermes-like):
// - Try the rich Ink UI (fixed top bar + scrolling Feed + ToolCard + Markdown).
//   When active, it owns the terminal and receives events through the bridge.
// - Otherwise fall back to a clean structured line terminal driven by the same
//   event stream ("通道升级"), with prompt restore + Ctrl+C abort.
// - Non-TTY silently downgrades to the classic REPL (smoke tests stay green).

import readline from 'readline';
import { readFileSync } from 'node:fs';
import { createOutputRenderer } from './OutputRenderer.js';
import { createCliApprovalBridge, isApprovalActive, cancelActiveApproval, setApprovalActivityListener } from '../../tools/approval.js';
import { Session } from './Session.js';
import * as rollout from './rolloutStore.js';
import { InputQueue, classifyRunningInput, formatSteerInjection } from './InputQueue.js';
import { ModeRing } from './ModeRing.js';
import { AgentTree } from './AgentTree.js';
import { stringWidth, padByWidth } from './stringWidth.js';
import { fuzzyFilter, fuzzyScore } from './FuzzyMatcher.js';
import { buildHelpView } from './commands/HelpCommand.js';
import type { ModelProvider } from './types.js';
import { extractChangedFiles, extractVerifyCommands, mapOutcome } from '../../loop/trajectory.js';

// ---- line 模式渲染纯助手（模块级，便于测试） ----
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED = '\x1b[31m';
const ANSI_ITALIC = '\x1b[3m';
const ANSI_RESET = '\x1b[0m';

/** 终端宽度（列）。非 TTY / 测试环境默认 80。 */
function termWidth(): number {
  return (process.stdout as any).columns || 80;
}

/** 按显示宽度截断（CJK=2 列），截断处补 …（省略号计入预算，总宽不超 maxWidth）。 */
export function truncateByWidth(text: string, maxWidth: number): string {
  const s = String(text ?? '');
  if (maxWidth <= 0) return '';
  if (stringWidth(s) <= maxWidth) return s;
  const budget = Math.max(0, maxWidth - 1); // 为省略号预留 1 列
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 按显示宽度贪心折行（verbose thinking 全文模式用）。 */
export function wrapByWidth(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  let cur = '';
  let curW = 0;
  for (const ch of String(text ?? '')) {
    const cw = Math.max(1, stringWidth(ch));
    if (curW + cw > maxWidth && cur.length > 0) {
      out.push(cur);
      cur = '';
      curW = 0;
    }
    cur += ch;
    curW += cw;
  }
  if (cur.length > 0) out.push(cur);
  return out.length > 0 ? out : [''];
}

/** 耗时格式化：<1s → Nms，否则 X.Ys。 */
export function fmtMs(ms?: number): string {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** 首个非空行（按显示宽度截断）。 */
function firstLine(text: string, max: number): string {
  for (const l of String(text ?? '').split('\n')) {
    const t = l.trim();
    if (t) return truncateByWidth(t, max);
  }
  return '';
}

/** 工具参数摘要（工具卡片头行）：bash→command 截 160；文件类→path；grep/glob→pattern；其余取前两个键值。 */
export function summarizeToolParams(tool: string, params: any): string {
  const p = (params && typeof params === 'object') ? params : {};
  const flat = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const t = String(tool || '').trim().toLowerCase();
  if (t === 'bash') return truncateByWidth(flat(p.command ?? p.cmd ?? ''), 160);
  if (t === 'write_file' || t === 'edit_file' || t === 'read_file') {
    const fp = flat(p.file_path ?? p.path ?? '');
    if (t === 'write_file') {
      const content = String(p.content ?? '');
      return content ? `${fp}（${content.split('\n').length} 行）` : fp;
    }
    return fp;
  }
  if (t === 'grep' || t === 'glob') return flat(p.pattern ?? p.query ?? '');
  const keys = Object.keys(p).slice(0, 2);
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${truncateByWidth(flat(p[k]), 60)}`).join(' ');
}

/** pre→post 间隔超 3s 时 gerund 行的进行时动词。 */
function doingVerb(tool: string): string {
  const t = String(tool || '').trim().toLowerCase();
  if (t === 'write_file') return 'Writing';
  if (t === 'edit_file') return 'Editing';
  if (t === 'read_file') return 'Reading';
  if (t === 'bash') return 'Running';
  return 'Executing';
}

const TOOL_ERROR_GLOSS: Record<string, string> = {
  DENIED_BY_USER: '用户拒绝',
  DENIED_READONLY: '只读模式拒绝',
  PLAN_MODE: '计划模式禁止执行',
  PATH_ESCAPED: '路径越界',
  TIMEOUT: '超时',
  RBW_VIOLATION: '未读先写',
  UNKNOWN_TOOL: '未知工具',
  INVALID_PARAMS: '参数无效',
  INVALID_REGEX: '正则无效',
  BINARY_FILE: '二进制文件',
  FILE_TOO_LARGE: '文件过大',
  IO: 'IO 错误',
  OUTPUT_TRUNCATED: '输出截断',
  ABORTED: '已中止',
};

/**
 * 工具结果行（CC 式动词句：动词+加粗数字+单位+dim 后缀）。
 * data 来自 tools/post-execute 事件（tool/ok/durationMs/error/outputPreview/lines/diff），
 * preParams 为该工具 tools/pre-execute 记住的参数。
 */
export function toolResultLine(data: any, preParams: any): string {
  const b = (s: string | number) => `${ANSI_BOLD}${s}\x1b[22m`;
  const dim = (s: string | number) => `${ANSI_DIM}${s}\x1b[22m`;
  const tool = String(data?.tool || '');
  const ms = fmtMs(data?.durationMs);
  const params = (preParams && typeof preParams === 'object') ? preParams : {};
  const p = (k: string) => String(params?.[k] ?? '');
  const path = p('file_path') || p('path') || p('file') || '';
  const out = String(data?.outputPreview || '');

  if (!data?.ok) {
    const errRaw = String(data?.error || '');
    const human = TOOL_ERROR_GLOSS[errRaw] || errRaw || '执行失败';
    const reason = firstLine(out, 120);
    return `${ANSI_RED}✗ ${human}${reason ? ' · ' + reason : ''}${ANSI_RESET} ${dim('· ' + ms)}`;
  }

  const lines = Number(data?.lines) || 0;
  if (tool === 'write_file') {
    const n = lines || (p('content') ? p('content').split('\n').length : 0);
    return `Wrote ${b(n)} lines to ${path || '(未知路径)'} ${dim('· ' + ms)}`;
  }
  if (tool === 'read_file') {
    if (lines > 0) return `Read ${b(lines)} lines ${dim('· ' + ms)}`;
    return `Read ${path || '(未知路径)'} ${dim('· ' + ms)}`;
  }
  if (tool === 'edit_file') {
    const diff = Array.isArray(data?.diff) ? data.diff : null;
    if (diff && diff.length > 0) {
      let added = 0;
      let removed = 0;
      for (const h of diff) {
        const n = String(h?.text ?? '').split('\n').filter((l: string) => l.length > 0).length || 1;
        if (h?.type === 'add') added += n;
        else if (h?.type === 'del') removed += n;
      }
      return `Added ${b(added)}, removed ${b(removed)} ${dim('· ' + ms)}`;
    }
    return `Edited ${path || '(未知路径)'} ${dim('· ' + ms)}`;
  }
  // bash / grep / glob / mcp_* / 其它
  if ((tool === 'grep' || tool === 'glob') && out) {
    const found = out.split('\n').filter((l) => l.trim()).length;
    return `Found ${b(found)} ${dim('· ' + ms)}`;
  }
  const first = firstLine(out, 120);
  if (first) return `${first} ${dim('· ' + ms)}`;
  if (tool === 'bash') return `Ran ${dim('· ' + ms)}`;
  return `Done ${dim('· ' + ms)}`;
}

/** 「下一步」按 stopReason 分支。 */
export function nextStepHint(stopReason?: string): string {
  const sr = String(stopReason || '');
  if (sr === 'completed') return '继续下一个任务 · /memory 查看沉淀';
  if (sr === 'answered') return '继续追问或下达新任务';
  if (sr === 'aborted') return '已中断 · 现场已保留 · 重新描述任务可继续';
  if (sr === 'error') return '任务执行失败 · 检查模型端点是否为对话模型（diffusion/embedding 不受支持）· 或重试';
  if (sr === 'max-steps') return '步数达上限 · 可拆小任务重试';
  return '模型未完成验证 · 可补充要求重试 · /undo 回退变更';
}

// ==================== 纯助手（引导级 + 质感级） ====================
// 模块级、无 IO、无 timer — 便于单测；line 段只做接线。

let cachedPkgVersion: string | null = null;
/** package.json version（运行时读，dist 与 src 距项目根都是两层；读不到兜底 0.7.0）。 */
export function pkgVersion(): string {
  if (cachedPkgVersion) return cachedPkgVersion;
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'));
    cachedPkgVersion = String(parsed?.version || '0.7.0');
  } catch {
    cachedPkgVersion = '0.7.0';
  }
  return cachedPkgVersion;
}

/** 模型名剥掉 `provider:` 前缀（`openpangu:xxx` → `xxx`；无前缀原样）。 */
export function stripModelProviderPrefix(model: string): string {
  const s = String(model || '').trim();
  const i = s.indexOf(':');
  return i === -1 ? s : s.slice(i + 1);
}

/** 启动横幅：粗体名 + dim 元信息两行（颜色由调用方套，这里只管内容与截断）。 */
export function buildBanner(opts: {
  model: string;
  tier: string;
  mode: string;
  workspace: string;
  version?: string;
  width?: number;
}): string[] {
  const width = Math.max(20, Number(opts.width) || 80);
  const metaBase = `  模型 ${stripModelProviderPrefix(opts.model)} · 档位 ${opts.tier} · 模式 ${opts.mode} · `;
  const cwdBudget = Math.max(1, width - stringWidth(metaBase));
  const cwd = truncateByWidth(String(opts.workspace || ''), cwdBudget);
  return [
    `烛龙 Zhulong v${opts.version ?? pkgVersion()}`,
    metaBase + cwd,
    '  /help 全部命令 · Ctrl+C 中断任务/二次退出',
  ];
}

/** line 模式实际支持的命令（Tab 补全 + 未知命令建议的数据源；顺序 = 常用度）。 */
export const LINE_COMMANDS: ReadonlyArray<{ name: string; aliases?: string[] }> = [
  { name: 'help', aliases: ['?', 'h'] },
  { name: 'mode' },
  { name: 'model' },
  { name: 'memory' },
  { name: 'usage' },
  { name: 'undo' },
  { name: 'compact' },
  { name: 'resume' },
  { name: 'status' },
  { name: 'tier' },
  { name: 'edit', aliases: ['e'] },
  { name: 'clear' },
  { name: 'verbose' },
  { name: 'approvals' },
  { name: 'agents' },
  { name: 'tree' },
  { name: 'feature' },
  { name: 'init' },
  { name: 'rewind' },
  { name: 'exit', aliases: ['quit', 'q'] },
];

/**
 * line 模式 readline completer（同步适配：只补全 `/` 开头的命令名，
 * 精确前缀优先，模糊兜底走 FuzzyMatcher；顺序即 LINE_COMMANDS 常用度）。
 */
export function completeLineCommand(line: string): [string[], string] {
  const raw = String(line ?? '');
  if (!raw.startsWith('/') || /\s/.test(raw.slice(1))) return [[], raw];
  const prefix = raw.slice(1).toLowerCase();
  const exact = LINE_COMMANDS.filter(
    (c) => c.name.startsWith(prefix) || (c.aliases || []).some((a) => a.startsWith(prefix))
  ).map((c) => '/' + c.name);
  if (exact.length > 0) return [[...new Set(exact)], raw];
  const fuzzy = fuzzyFilter(prefix, LINE_COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases as string[] })));
  if (fuzzy.length > 0) return [fuzzy.map((f) => '/' + f.name), raw];
  return [[], raw];
}

/** 未知命令 → 最近命令建议（含别名得分；低于子序列档 0.35 视为无建议）。 */
export function suggestCommand(input: string): string | null {
  const q = String(input || '').replace(/^\//, '').toLowerCase().trim();
  if (!q) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const c of LINE_COMMANDS) {
    const names = [c.name, ...(c.aliases || [])];
    let s = 0;
    for (let i = 0; i < names.length; i++) {
      const sc = fuzzyScore(q, names[i]) * (i > 0 ? 0.95 : 1);
      if (sc > s) s = sc;
    }
    if (s > bestScore) {
      bestScore = s;
      best = c.name;
    }
  }
  return bestScore >= 0.35 ? best : null;
}

/** `?` 快捷帮助面板（常用 8 条 + dim 尾行指向 /help；颜色由调用方套）。 */
export function buildQuickHelpLines(totalCommands: number): string[] {
  const entry = (label: string, desc: string) => `  ${padByWidth(label, 10)}  ${desc}`;
  return [
    '快捷帮助',
    entry('直接输入', '任务描述即开始，如：修复 README 里的错别字'),
    entry('/mode', '切换 plan/default/auto-accept（shift+tab 同效）'),
    entry('/model', '查看或切换模型'),
    entry('/memory', '查看沉淀的记忆'),
    entry('/usage', '本会话 token 用量'),
    entry('/undo', '撤销最近一次写盘'),
    entry('/compact', '立即压缩上下文'),
    entry('/resume', '列出可恢复的会话'),
    entry('/exit', '退出（Ctrl+C 执行中=中断 · 空闲连按两次=退出）'),
    `/help 查看全部 ${totalCommands} 条命令`,
  ];
}

/** 模式徽标行（dim 由调用方套；full 同 auto-accept 的 ⏵⏵ 符号）。 */
export function modeBadgeLine(mode: string): string {
  const m = String(mode || '');
  const glyph = m === 'plan' ? '⏸' : m === 'default' ? '⏵' : '⏵⏵';
  return `${glyph} ${m} · shift+tab 切换`;
}

/** /mode 切换回执的一句后果说明。 */
export const MODE_CONSEQUENCE: Record<string, string> = {
  plan: '只读计划模式，写操作与 bash 会被拒绝',
  default: '写操作需确认',
  'auto-accept': '写操作自动接受（危险操作仍标红）',
  full: '全部放行（危险操作仍标红）',
};

/** 切换回执整行。 */
export function modeSwitchReceipt(mode: string): string {
  return `已切换: ${mode} · ${MODE_CONSEQUENCE[String(mode)] || ''}`.replace(/ · $/, '');
}

/** phase 值本地化（渲染层映射，不改事件值；未知值原样透传）。 */
export function localizePhase(phase: string): string {
  const map: Record<string, string> = { explore: '侦察', rollout: '执行', judge: '评判', done: '收尾' };
  return map[String(phase || '')] || String(phase || '');
}

/** rollout 状态本地化（/agents 展示用）。 */
export function localizeRolloutStatus(status: string): string {
  const map: Record<string, string> = { running: '进行中', done: '完成', failed: '失败', pending: '等待' };
  return map[String(status || '')] || String(status || '');
}

/**
 * 情境 tip 节流 — 每类触发点一次性（key 去重）+ 每会话全局上限（默认 2 条）。
 */
export function createTipGate(max = 2) {
  let shown = 0;
  const seen = new Set<string>();
  return {
    canShow(key: string): boolean {
      return shown < max && !seen.has(key);
    },
    markShown(key: string): void {
      if (!seen.has(key)) {
        seen.add(key);
        if (shown < max) shown += 1;
      }
    },
    get shownCount(): number {
      return shown;
    },
  };
}

/** 启动 tip 条件 — 新会话（无历史轮、非 resume）且掷中 50% 概率。 */
export function shouldShowStartupTip(turns: number, resumed: boolean, rand: number): boolean {
  return turns === 0 && !resumed && rand < 0.5;
}

export interface SseInteractiveOptions {
  provider?: ModelProvider;
  defaultTier?: string;
  defaultWorkspace?: string;
  /** resume an existing session instead of starting fresh */
  session?: Session;
}

export async function startSseInteractive(opts: SseInteractiveOptions = {}): Promise<void> {
  // ---- line 模式输出纪律 + 流式状态 ----
  // inlineLine：当前"活行"的占用者（gerund 标签 / thinking 单行滚动）。
  // 任何正式输出前必须先 \r\x1b[K 清行（防 gerund 运行标签残留污染正式输出的单一纪律点）。
  const lineUi: {
    inlineLine: null | 'gerund' | 'thinking';
    messageStreaming: boolean;
    streamedAnswerChars: number;
    verbose: boolean;
    thinkingStart: number;
    thinkingBuf: string;
    thinkingPrinted: boolean;
    taskStartedAt: number;
    taskEndedAt: number;
    ghostIgnored: boolean;
    stepCount: number;
    lastSigintAt: number;
    idleCtrlCAt: number;
    toolStack: Array<{ tool: string; params: Record<string, string> }>;
    pendingTool: { tool: string; summary: string; doing: string; at: number } | null;
  } = {
    inlineLine: null,
    messageStreaming: false,
    streamedAnswerChars: 0,
    verbose: process.env.PANSHA_VERBOSE === '1',
    thinkingStart: 0,
    thinkingBuf: '',
    thinkingPrinted: false,
    taskStartedAt: 0,
    taskEndedAt: 0,
    ghostIgnored: false,
    stepCount: 0,
    lastSigintAt: 0,
    idleCtrlCAt: 0,
    toolStack: [],
    pendingTool: null,
  };

  function clearInlineLine() {
    if (lineUi.inlineLine) {
      try { process.stdout.write('\r\x1b[K'); } catch {}
      lineUi.inlineLine = null;
    }
  }

  // renderer 包装器 — 所有正式输出（writeLine/success/warn/…）前先清活行。
  // gerund/thinking 的原地重绘不经过这里（直接 stdout + 记 inlineLine），
  // 因此清行纪律只有这一个入口。
  const rawRenderer = createOutputRenderer();
  const CLEAR_ON_WRITE = new Set(['writeLine', 'write', 'stream', 'success', 'warn', 'error', 'info', 'table', 'codeBlock']);
  const renderer = new Proxy(rawRenderer, {
    get(target: any, prop: string | symbol) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (CLEAR_ON_WRITE.has(String(prop))) {
        return (...args: any[]) => { clearInlineLine(); return v.apply(target, args); };
      }
      return v.bind(target);
    },
  }) as ReturnType<typeof createOutputRenderer>;

  // Check basic TTY capability. If not TTY, fall back to classic immediately.
  const isInteractiveTty =
    process.stdout.isTTY &&
    process.stdin.isTTY;

  if (!isInteractiveTty) {
    // Silent downgrade: use the classic REPL path.
    // Carry a restored session (--resume) through the downgrade — the
    // classic fallback must not lose the resume state.
    const { startClassicRepl } = await import('./classicRepl.js');
    return startClassicRepl(opts.session ? { session: opts.session } : {});
  }

  // one shared session for rich + line paths (approval mode/allowlist
  // flow from here into the engine adapter; resume seeds it).
  const { applyConfigModel } = await import('./modelSeed.js');
  const session: Session = applyConfigModel(
    opts.session ?? new Session({ workspace: opts.defaultWorkspace, tier: (opts.defaultTier as any) || 'high' }),
    opts.session?.workspace || opts.defaultWorkspace
  ) as Session;
  if (!opts.session) {
    try { rollout.appendMeta(session); } catch {}
  }
  // resumed sessions already carry __resumed marker from repl.ts
  const resumedInfo = (session as any).__resumed as { from: string; turns: number } | undefined;

  // MCP stdio servers from .panshalach.json mcpServers (append-only config).
  // Clients spawn lazily at first task; closed on process exit (hang discipline).
  const mcpClients = new Map<string, any>();
  let mcpToolsReady: any[] = [];
  let mcpInitDone = false;

  async function initMcpServers(): Promise<void> {
    if (mcpInitDone) return;
    mcpInitDone = true;
    try {
      const { ConfigManager } = await import('./ConfigManager.js');
      const cfg: any = (new ConfigManager(session.workspace || process.cwd())).getAll?.() ?? {};
      const servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> =
        (cfg as any).mcpServers || {};
      const { McpClient } = await import('../../tools/mcpClient.js');
      for (const [name, s] of Object.entries(servers)) {
        if (!s?.command) continue;
        try {
          const client = new McpClient({ command: s.command, args: s.args || [], env: s.env });
          await client.initialize();
          const tools = await client.listTools();
          mcpClients.set(name, client);
          for (const t of tools) {
            mcpToolsReady.push({
              server: name,
              name: `mcp_${name}_${t.name}`,
              description: t.description || '',
              call: (args: Record<string, unknown>) => client.callTool(t.name, args),
            });
          }
        } catch {
          // failed server → skip (tools simply unavailable), never crash startup
        }
      }
    } catch {
      // config missing / unreadable → no MCP
    }
  }

  process.once('exit', () => {
    for (const c of mcpClients.values()) { try { c.close(); } catch {} }
  });

  // 上下文窗口挂真值——不再用 const 常量
  // `PANSHA_CTX_WINDOW||128000` 与所连模型零耦合；改为每个任务边界调
  // provider.getModelContextLength(session.model) 重取（CTX_WINDOW_TOKENS 去
  // const 化）。≤0 或遗留 256000 哨兵视为 unknown → 32768 保守值（只多压缩，
  // 不会让 8K 模型爆窗）。PANSHA_CTX_WINDOW 环境变量保留为显式覆盖。
  let ctxWindowTokens = 32768;
  function resolveCtxWindowTokens(): number {
    const env = Number(process.env.PANSHA_CTX_WINDOW || 0);
    if (Number.isFinite(env) && env > 0) return env;
    try {
      const p = (opts.provider ?? (session as any).provider) as any;
      const n = Number(p?.getModelContextLength?.(session.model));
      if (Number.isFinite(n) && n > 0 && n !== 256000) return n;
    } catch {}
    return 32768;
  }
  let ctxUsedChars = 0;
  function bumpCtx(text: any) {
    if (typeof text === 'string') ctxUsedChars += text.length;
  }

  // Holders for line-mode prompt restore (populated only in the !rich line fallback path).
  // The unified runTaskViaSse (defined below) references these in its !bridge finally to restore the prompt.
  let lineRl: readline.Interface | null = null;
  let lineSetPrompt: () => void = () => {};

  // 待定命令建议 / 模式徽标待打印 / 情境 tip 节流。
  // pendingSuggestion 只在 line 空闲态由「未知命令」分支置位；回车确认执行，
  // Esc / 任何其他输入取消。
  let pendingSuggestion: string | null = null;
  let modeBadgePending = true; // 启动时输出一次，此后仅模式变化后再输出
  const sessionTipGate = createTipGate(2);

  // For /edit: remember last meaningful surfaced content (result text, big markdown/thought)
  // so user can pull it back into the input area to edit/resubmit or refine.
  let lastOutput = '';
  function recordOutput(text: string) {
    if (text && text.trim()) lastOutput = text.trim();
  }
  function getLastOutput() { return lastOutput; }

  // Abort flag for the current task (used by runTaskViaSse + SIGINT in line mode)
  let currentAbort: AbortController | null = null;
  const isRunning = () => currentAbort !== null;

  // queued messages + steering inbox
  const queue = new InputQueue();
  let lastInjectedSteers: string[] = [];
  let lastAborted = false;
  // in-flight background compaction (cancelled on session exit)
  let bgCompact: { isReady(): boolean; result(): any; cancel(): void } | null = null;
  process.once('exit', () => { if (bgCompact) { try { bgCompact.cancel(); } catch {} } });

  // sub-agent rollout tree (fed by onEvent step/critique rolloutId).
  // Engine runs rollouts SERIALLY → honest serial progress list.
  const agentTree = new AgentTree();
  let treeTaskStart = 0;
  function updateQueueCount() {
    if (typeof (bridgeRef as any).current?.setQueueCount === 'function') {
      try { bridgeRef.current.setQueueCount(queue.size, queue.taskCount, queue.steerCount); } catch {}
    }
  }

  // mode ring — shift+tab cycles; plan floors approval to readonly,
  // leaving plan restores the ring-mapped approval mode.
  // 切换回执为 `已切换: <模式> · <后果>`；徽标行置 pending，
  // 下一次空闲提示符上方输出一次（避免刷屏）。
  const modeRing = new ModeRing('default', (m) => {
    if (m === 'plan') {
      session.setPlanMode(true);
    } else {
      session.planMode = false;
      session.approvalMode = m === 'auto-accept' ? 'full' : m === 'full' ? 'full' : 'default';
    }
    try { rollout.appendApprovalChange(session); } catch {}
    modeBadgePending = true;
    emitFeed(modeSwitchReceipt(m), 'info');
  });
  function pushRichModeBadge(m: string) {
    if (typeof (bridgeRef as any).current?.setTop === 'function') {
      try { bridgeRef.current.setTop({ modeBadge: m === 'plan' ? 'PLAN' : m === 'auto-accept' ? 'AUTO' : m === 'full' ? 'FULL' : '' }); } catch {}
    }
  }
  function cycleMode(): string {
    const m = modeRing.cycle();
    pushRichModeBadge(m);
    return m;
  }
  function setMode(m: any) {
    // 旧实现 set(m) 后又 cycleMode() —— cycle 会把模式再推进一格，
    // `/mode plan` 实际落在 default。set 只需同步 rich 徽标，不再 cycle。
    modeRing.set(m);
    pushRichModeBadge(String(m));
  }
  function emitFeed(text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') {
    if (typeof (bridgeRef as any).current?.pushFeed === 'function') {
      try { bridgeRef.current.pushFeed({ type: 'text', text, level }); } catch {}
    } else {
      renderer.writeLine(renderer.color(text, level === 'warn' ? 'yellow' : level === 'error' ? 'red' : 'gray'));
    }
  }

  // unified synchronous compaction — client resolution, success/
  // failure feedback and TopBar meter reset live HERE (was duplicated at
  // /compact and the critical sync-fallback).
  async function runSyncCompact(reasonPrefix = ''): Promise<any> {
    const { compactSession, estimateSessionTokens } = await import('./compactService.js');
    const { resolveSharedClient } = await import('../../cli/repl/ModelProvider.js');
    const rich = !!bridge; // same semantics as runTaskViaSse's useRich
    let client: any = null;
    try { client = (await resolveSharedClient(session.model, opts.provider as any)).client; } catch {}
    const r = await compactSession(session, client);
    if (r.ok) {
      ctxUsedChars = estimateSessionTokens(session) * 4;
      const msg = reasonPrefix + r.message;
      if (rich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: reasonPrefix ? 'warn' : 'success' });
      else if (reasonPrefix) renderer.warn(msg);
      else renderer.success(msg);
      if (rich && typeof bridge.setTop === 'function') {
        const nr = Math.min(1, (ctxUsedChars / 4) / ctxWindowTokens);
        try { bridge.setTop({ ctxRatio: nr }); } catch {}
      }
    } else {
      if (rich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: r.message, level: 'warn' });
      else renderer.warn(r.message);
    }
    return r;
  }

  /**
   * route a user line according to running state.
   * - idle:   normal task flow
   * - running: '/' → immediate local command; '!' → steer; else → queued task
   */
  async function handleUserLine(text: string, bridge?: any) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    if (!isRunning()) {
      await runTaskViaSse(trimmed, bridge);
      return;
    }

    const routed = classifyRunningInput(trimmed);
    if (routed.kind === 'command') {
      // slash commands execute immediately, never queued
      await runTaskViaSse(routed.payload, bridge);
      return;
    }
    if (routed.kind === 'steer') {
      if (!routed.payload) return;
      queue.enqueueSteer(routed.payload);
      emitFeed(`steered ×${queue.steerCount}（下一轮注入）：${routed.payload}`, 'info');
    } else {
      queue.enqueueTask(routed.payload);
      emitFeed(`queued ×${queue.taskCount}：${routed.payload}`, 'info');
    }
    updateQueueCount();
  }

  // 与 classic（Repl.ts）完全同序的 26 命令注册表 —
  // /help 的分组渲染、/resume 的委托执行都以它为数据源，三处输出一致。
  let sharedRegistry: any = null;
  async function getSharedRegistry(): Promise<any> {
    if (sharedRegistry) return sharedRegistry;
    const { CommandRegistry } = await import('./CommandRegistry.js');
    const reg = new CommandRegistry();
    const mods = await Promise.all([
      import('./commands/HelpCommand.js'),
      import('./commands/ExitCommand.js'),
      import('./commands/ClearCommand.js'),
      import('./commands/StatusCommand.js'),
      import('./commands/TierCommand.js'),
      import('./commands/WorkspaceCommand.js'),
      import('./commands/ModelCommand.js'),
      import('./commands/HistoryCommand.js'),
      import('./commands/RunCommand.js'),
      import('./commands/SimulateCommand.js'),
      import('./commands/ReviewCommand.js'),
      import('./commands/MemoryCommand.js'),
      import('./commands/TraceCommand.js'),
      import('./commands/ConfigCommand.js'),
      import('./commands/SessionCommand.js'),
      import('./commands/InitCommand.js'),
      import('./commands/ServeCommand.js'),
      import('./commands/ApprovalsCommand.js'),
      import('./commands/UndoCommand.js'),
      import('./commands/CompactCommand.js'),
      import('./commands/UsageCommand.js'),
      import('./commands/ResumeCommand.js'),
      import('./commands/RewindCommand.js'),
      import('./commands/AgentsCommand.js'),
      import('./commands/FeatureCommand.js'),
      import('./commands/TreeCommand.js'),
    ]);
    for (const m of mods) reg.register((m as any).default);
    sharedRegistry = reg;
    return reg;
  }

  async function runTaskViaSse(task: string, bridge?: any) {
    if (!task || !task.trim()) return;

    const trimmed = task.trim();
    const useRich = !!bridge;

    // Unified /edit (P1): pull last significant output back into input for edit/resubmit.
    if (trimmed === '/edit' || trimmed === '/e') {
      const prev = getLastOutput();
      if (!prev) {
        if (!useRich) renderer.warn('暂无上次输出可编辑');
        else if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: '暂无上次输出可编辑', level: 'warn' });
        return;
      }
      if (useRich) {
        try {
          if (typeof bridge.updateInput === 'function') bridge.updateInput(prev);
          if (typeof bridge.pushFeed === 'function') {
            bridge.pushFeed({ type: 'text', text: '(已载入上次输出到输入区，可编辑后提交)', level: 'info' });
          }
        } catch {}
      } else {
        // Line mode prefill
        try {
          if (lineRl) {
            (lineRl as any).line = prev;
            (lineRl as any).cursor = prev.length;
            if (typeof (lineRl as any)._refreshLine === 'function') (lineRl as any)._refreshLine();
            renderer.writeLine(renderer.color('(已载入上次输出，可编辑后回车提交)', 'gray'));
          } else {
            renderer.writeLine('--- 上次输出 ---');
            renderer.writeLine(prev);
          }
        } catch {
          renderer.writeLine('--- 上次输出 ---');
          renderer.writeLine(prev);
        }
      }
      return;
    }

    // local commands shared by rich + line paths
    // (/undo now; /approvals + /usage + /compact land with their batches)
    if (trimmed.startsWith('/')) {
      const sp = trimmed.indexOf(' ');
      const cmd = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
      const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim();

      const emit = (text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
        if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level });
        else if (level === 'warn') renderer.warn(text);
        else if (level === 'error') renderer.error(text);
        else if (level === 'success') renderer.success(text);
        else renderer.writeLine(text);
      };

      if (cmd === '/agents') {
        // sub-agent rollout tree (serial progress list — honest)
        const nodes = agentTree.snapshot();
        const feedOrLine = (text: string, color?: 'bold' | 'gray') => {
          if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level: 'info' });
          else renderer.writeLine(color ? renderer.color(text, color) : text);
        };
        if (arg) {
          const n = agentTree.get(arg.trim());
          if (!n) { feedOrLine(`未找到 rollout: ${arg}`); return; }
          feedOrLine(`rollout ${n.id}（${localizeRolloutStatus(n.status)}）`, 'bold');
          feedOrLine(`  步数: ${n.stepCount} · 耗时: ${(n.durationMs / 1000).toFixed(1)}s · 最近阶段: ${n.lastPhase ?? '-'}`);
          return;
        }
        if (nodes.length === 0) { feedOrLine('尚无 rollout 数据（跑一个任务后出现）'); return; }
        const done = nodes.filter((n) => n.status === 'done').length;
        const running = nodes.filter((n) => n.status === 'running').length;
        const failed = nodes.filter((n) => n.status === 'failed').length;
        const pending = nodes.filter((n) => n.status === 'pending').length;
        const totalMs = nodes.reduce((a, n) => a + n.durationMs, 0);
        // 统计行中文化
        feedOrLine(`共 ${nodes.length} rollouts · 完成 ${done} · 进行中 ${running} · 等待 ${pending} · 失败 ${failed} · 总耗时 ${(totalMs / 1000).toFixed(1)}s`, 'bold');
        for (const n of nodes) {
          const glyph = n.status === 'running' ? '▶' : n.status === 'done' ? '✓' : n.status === 'failed' ? '✗' : '·';
          const dur = n.durationMs >= 1000 ? `${(n.durationMs / 1000).toFixed(1)}s` : `${n.durationMs}ms`;
          feedOrLine(`  ${glyph} ${n.id} · ${localizeRolloutStatus(n.status)} · ${n.stepCount} 步 · ${dur}${n.lastPhase ? ` · ${n.lastPhase}` : ''}`);
        }
        // graph edges (dep/rollback/approval) annotated
        try {
          const edges = agentTree.edges();
          if (edges.length > 0) {
            feedOrLine('边:', 'gray');
            for (const e of edges) feedOrLine(`  ${e.from} --[${e.kind}]--> ${e.to}`, 'gray');
          }
        } catch {}
        // 文案清漂：删除"并行 rollout"表述——引擎恒单 rollout
        // 串行执行（Promise.allSettled 多 rollout 编排已随判官机制摘除），
        // 文案必须与运行时一致。
        feedOrLine('（当前为单 rollout 串行执行；rollout 列表记录任务内步骤进度）', 'gray');
        return;
      }

      if (cmd === '/rewind') {
        // turn-level rewind lives in the classic command set
        // (registered RewindCommand); rich-mode panel wiring is deferred.
        // line 模式不静默 no-op——提示真实可用路径并按已处理返回
        //（false 会把命令当任务发给引擎）。
        emit('rewind 目前在经典模式可用：先 /classic 进入，或使用 /undo 回退最近变更', 'info');
        return true;
      }

      if (cmd === '/mode') {
        // hidden alias for keyboard-less environments (also the
        // testable entry point of ModeRing).
        const a = arg.toLowerCase();
        if (['plan', 'default', 'auto-accept', 'full'].includes(a)) {
          setMode(a);
        } else {
          cycleMode();
        }
        return;
      }

      if (cmd === '/verbose') {
        // thinking 展示开关（内存标志；PANSHA_VERBOSE=1 初始为开）
        lineUi.verbose = !lineUi.verbose;
        emit(`思考显示: ${lineUi.verbose ? '全文多行（verbose）' : '单行滚动（默认）'}`, 'info');
        return;
      }

      if (cmd === '/undo') {
        const { undoLatest } = await import('../../tools/fileHistory.js');
        const r = undoLatest(session.workspace || process.cwd(), arg || undefined);
        emit(r.message, r.ok ? 'success' : 'warn');
        if (r.ok && r.diff && r.diff.length > 0) {
          for (const h of r.diff.slice(0, 40)) {
            const line = `${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`;
            emit(line, h.type === 'add' ? 'success' : h.type === 'del' ? 'error' : 'info');
          }
          if (r.diff.length > 40) emit(`… ${r.diff.length - 40} 行省略 …`, 'info');
        }
        return;
      }

      if (cmd === '/approvals') {
        const a = arg.toLowerCase();
        if (a === 'clear') {
          session.clearApprovalAllowlist();
          emit('本会话放行清单已清空。', 'success');
        } else if (['readonly', 'default', 'full'].includes(a)) {
          session.updateApprovalMode(a as any);
          emit(`审批模式已切换为 ${a}。`, 'success');
        } else {
          emit(`审批模式: ${session.approvalMode}；放行清单: ${[...session.sessionApprovalAllowlist].join(', ') || '(空)'}`, 'info');
          emit('用法: /approvals readonly|default|full|clear', 'info');
        }
        try { rollout.appendApprovalChange(session); } catch {}
        return;
      }

      if (cmd === '/usage') {
        const { collectUsage, loadPricesFromConfig } = await import('./usageService.js');
        const prices = await loadPricesFromConfig(session.workspace || process.cwd());
        const r = collectUsage(session, prices);
        for (const line of r.lines) emit(line, 'info');
        return;
      }

      if (cmd === '/compact') {
        // unified via runSyncCompact (client resolve + feedback + meter)
        const r = await runSyncCompact();
        if (r.ok) {
          const preview = r.summary.length > 300 ? r.summary.slice(0, 300) + '…' : r.summary;
          emit('摘要预览: ' + preview, 'info');
        }
        return;
      }

      if (cmd === '/model') {
        // /model must be handled LOCALLY, not fall through
        // to the engine as a coding task (that produced the confusing
        // "No model client available" error).
        const sub = arg.trim();
        if (!sub || sub === 'list' || sub === 'ls') {
          emit(`当前模型: ${session.model}`, 'info');
          try {
            const { createDefaultModelProvider } = await import('../../cli/repl/ModelProvider.js');
            const p = opts.provider as any ?? createDefaultModelProvider();
            const names = (typeof p.listModels === 'function' ? p.listModels() : []).join(', ');
            emit(`已注册/可用入口: ${names}`, 'info');
            if (sub === 'list' || sub === 'ls') {
              // remote model list for the CURRENT provider (best-effort)
              const { resolveSharedClient } = await import('../../cli/repl/ModelProvider.js');
              try {
                const { provider: pr } = await resolveSharedClient(session.model, opts.provider as any);
                const remote = await pr.listProviderModels?.(session.model.includes(':') ? session.model.split(':')[0] : 'scnet');
                if (remote && remote.length) emit(`远程模型(${session.model.split(':')[0] || 'scnet'}): ${remote.slice(0, 30).join(', ')}`, 'info');
              } catch {}
            }
          } catch {}
          return;
        }
        // /model <name> → switch session.model (validated on next task)
        session.model = sub;
        // 切换模型后旧模型的上下文计量失效——
        // ctxUsedChars 清零 + 窗口立即重取（下次任务边界也会再取一次兜底）。
        ctxUsedChars = 0;
        ctxWindowTokens = resolveCtxWindowTokens();
        emit(`模型已切换: ${sub}（下次任务生效）`, 'success');
        return;
      }

      // rich mode slash commands MUST resolve
      // locally — /help /status /clear /tier and any unknown slash command are
      // handled here; a slash-prefixed line is NEVER submitted to the engine
      // as a coding task (iron rule).
      if (cmd === '/help' || cmd === '/h') {
        // 三处（classic/line/派发器）统一走 HelpCommand 分组渲染
        const reg = await getSharedRegistry();
        const view = buildHelpView(reg.list(), arg ? [arg.split(/\s+/)[0]] : []);
        for (const l of view.lines) emit(useRich ? l.text : (l.style ? renderer.color(l.text, l.style) : l.text), 'info');
        if (view.message) emit(view.message, 'warn');
        return;
      }
      if (cmd === '/memory') {
        // 快捷帮助收录了 /memory — line 模式给非交互直通
        //（默认 list；无参数时 classic 的交互子菜单依赖 ctx.input，line 没有）
        const { runMemoryCommand } = await import('../MemoryCommand.js');
        try {
          const result = await runMemoryCommand(arg ? arg.split(/\s+/) : ['list'], session.workspace || process.cwd());
          emit(result || '(无输出)', 'info');
        } catch (e: any) {
          emit('Memory 命令失败: ' + (e?.message || e), 'error');
        }
        return;
      }
      if (cmd === '/resume') {
        // 委托注册表里的 ResumeCommand（只依赖 renderer）
        const reg = await getSharedRegistry();
        const rctx: any = {
          session,
          registry: reg,
          renderer: useRich ? { writeLine: (t: string) => emit(t, 'info'), color: (t: string) => t, warn: (t: string) => emit(t, 'warn'), error: (t: string) => emit(t, 'error'), success: (t: string) => emit(t, 'success'), info: (t: string) => emit(t, 'info') } : renderer,
          input: null,
          repl: null,
          provider: (session as any).provider,
          // sseInteractive 的 CommandContext 注册点——
          // 注入与当前路径一致的现成审批桥 + 在途任务的 abort signal，使经此
          // 派发的 registry 命令与主任务路径共享审批/中断语义。
          approvalBridge: useRich
            ? (req: { tool: string; description: string; danger: boolean }) => (bridgeRef.current.setConfirm(req) as Promise<string>)
            : createCliApprovalBridge(),
          signal: currentAbort?.signal,
        };
        const res = await reg.execute(rctx, 'resume', arg ? arg.split(/\s+/) : []);
        if (res?.message && res.message !== 'ok' && res.message !== 'none') emit(res.message, 'info');
        return;
      }
      if (cmd === '/clear') {
        if (useRich && typeof bridge.clearScreen === 'function') { try { bridge.clearScreen(); } catch {} }
        else renderer.clearScreen();
        return;
      }
      if (cmd === '/tier' || cmd === '/t') {
        const t = arg.trim().toLowerCase();
        const TIERS = ['quick', 'standard', 'high', 'max', 'ex', 'pangu'];
        if (t && TIERS.includes(t)) {
          session.tier = t as any;
          emit(`档位已切换: ${t}（下次任务生效）`, 'success');
        } else {
          emit(`当前档位: ${session.tier}；可用: ${TIERS.join(', ')}`, 'info');
        }
        return;
      }
      if (cmd === '/status') {
        const pct = Math.min(100, Math.floor((ctxUsedChars / 4 / ctxWindowTokens) * 100));
        emit(`模式 ${session.approvalMode} · 档位 ${session.tier} · 模型 ${session.model} · 上下文 ~${pct}% · 队列 ${queue.taskCount} 任务 / ${queue.steerCount} 插话`, 'info');
        return;
      }
      if (cmd === '/tree') {
        // session tree (origin + branch nodes); /tree <id> → resume path
        try {
          const { listSessionTree, renderSessionTree } = await import('./rolloutStore.js');
          const current = (session as any).sessionId || '';
          const target = arg.trim() || current;
          const tree = listSessionTree(target);
          emit('会话树:', 'info');
          for (const line of renderSessionTree(tree, current)) emit('  ' + line, 'info');
          if (arg.trim() && arg.trim() !== current) emit(`切到节点 ${arg.trim()} 续写: /resume ${arg.trim()}`, 'success');
          else emit('分支: /rewind 创建；节点续写: /tree <id> 后 /resume <id>', 'info');
        } catch (e: any) {
          emit('会话树读取失败: ' + (e?.message || e), 'error');
        }
        return;
      }
      if (cmd === '/feature') {
        // /feature list|add|done|next (rich-local mirror of FeatureCommand)
        const { loadFeatures, activeFeature, addFeature, markFeatureDone, setFeatureNext } = await import('./FeatureTracker.js');
        const ws = session.workspace || process.cwd();
        const sub = (arg.split(/\s+/)[0] || 'list').toLowerCase();
        const rest = arg.split(/\s+/).slice(1);
        if (sub === 'list' || sub === 'ls') {
          const items = loadFeatures(ws);
          if (items.length === 0) { emit('特性列表为空（/feature add <标题> 开始）', 'info'); return; }
          for (const f of items) {
            const mark = f.status === 'in-progress' ? '▶' : f.status === 'done' ? '✓' : f.status === 'blocked' ? '✗' : '·';
            emit(`  ${mark} ${f.id} ${f.title} [${f.status}]${f.evidence ? ' · ✓ ' + f.evidence : ''}`, 'info');
          }
          return;
        }
        if (sub === 'add') {
          const title = rest.join(' ').trim();
          const item = title ? addFeature(ws, title) : null;
          emit(item ? `已添加并激活: ${item.id} ${item.title}` : '用法: /feature add <标题>', item ? 'success' : 'warn');
          return;
        }
        if (sub === 'done') {
          const err = markFeatureDone(ws, rest[0] || '', rest.slice(1).join(' ').trim());
          emit(err ?? `已标记 done: ${rest[0]}`, err ? 'warn' : 'success');
          return;
        }
        if (sub === 'next') {
          const err = setFeatureNext(ws, rest[0] || '', rest.slice(1).join(' ').trim());
          emit(err ?? `已设为 active: ${rest[0]}`, err ? 'warn' : 'success');
          return;
        }
        emit('用法: /feature list|add <标题>|done <id> <证据>|next <id>', 'warn');
        return;
      }
      if (cmd === '/init') {
        // rich-local /init — probe workspace + write
        // .panshalach/AGENTS.md + feature_list.json. B-dual: reuses the SAME
        // probe/build logic as the registry InitCommand (the old inline
        // simplified copy diverged in output — now unified).
        try {
          const { probeWorkspace, buildAgentsMd } = await import('./commands/InitCommand.js');
          const fs = await import('node:fs');
          const path = await import('node:path');
          const ws = session.workspace || process.cwd();
          const probe = probeWorkspace(ws);
          const agents = buildAgentsMd(ws, probe);
          const agentsPath = path.join(ws, '.panshalach', 'AGENTS.md');
          const existed = fs.existsSync(agentsPath);
          if (existed && arg !== '--force' && arg !== '-f') { emit('AGENTS.md 已存在（/init --force 覆盖）', 'warn'); return; }
          fs.mkdirSync(path.join(ws, '.panshalach'), { recursive: true });
          fs.writeFileSync(agentsPath, agents, 'utf-8');
          const { saveFeatures, featureListPath } = await import('./FeatureTracker.js');
          if (!fs.existsSync(featureListPath(ws))) saveFeatures(ws, []);
          const cmds = [probe.buildCmd, probe.testCmd, probe.lintCmd].filter(Boolean).join(' | ') || '未探测到';
          emit(`已生成 ${agentsPath}（验证命令: ${cmds}）`, 'success');
        } catch (e: any) {
          emit('初始化失败: ' + (e?.message || e), 'error');
        }
        return;
      }

      // iron rule: unknown slash commands never reach the engine.
      // 加模糊建议 — line 空闲态置待定命令（回车确认执行，
      // Esc/其他输入取消）；rich / 运行中只提示建议。
      // 建议不能指向命令本身（自指：确认后又落"未知命令"无限循环），
      // 且待定命令确认路径会先过 handleLocalCommand（/exit /clear 只在那注册）。
      {
        const sug = suggestCommand(cmd);
        if (sug && ('/' + sug) !== cmd) {
          if (!useRich && !isRunning()) {
            pendingSuggestion = '/' + sug;
            emit(`未知命令 ${cmd} · 你是不是想要 /${sug}？（回车确认执行，Esc/其他输入取消）`, 'warn');
          } else {
            emit(`未知命令 ${cmd} · 你是不是想要 /${sug}？（输入 /help 查看全部命令）`, 'warn');
          }
        } else {
          emit(`未知命令: ${cmd}（输入 /help 查看可用命令；斜杠命令均本地执行）`, 'warn');
        }
      }
      return;
    }

    // auto-compact pre-flight (CC-style) — background-first, applied at
    // task boundary, never blocks input. Sync fallback only when critical.
    {
      const ratioNow = Math.min(1, (ctxUsedChars / 4) / ctxWindowTokens);
      const cs = await import('./compactService.js');
      if (cs.shouldAutoCompact(session, ratioNow)) {
        const { resolveSharedClient } = await import('../../cli/repl/ModelProvider.js');
        let client: any = null;
        try { client = (await resolveSharedClient(session.model, opts.provider as any)).client; } catch {}

        // A ready background result → apply with zero wait
        if (bgCompact && bgCompact.isReady()) {
          const res = bgCompact.result();
          bgCompact = null;
          if (res && res.ok) {
            const applied = cs.applyCompactResult(session, res);
            ctxUsedChars = cs.estimateSessionTokens(session) * 4;
            const msg = `${applied.message}`;
            // 拒绝/失败以 warn 呈现（盘故障不该与普通回执同级）
            if (!applied.ok) {
              if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'warn' });
              else renderer.warn(msg);
            } else {
              if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'info' });
              else renderer.info(msg);
            }
            if (useRich && typeof bridge.setTop === 'function') {
              const nr = Math.min(1, (ctxUsedChars / 4) / ctxWindowTokens);
              try { bridge.setTop({ ctxRatio: nr }); } catch {}
            }
          }
        } else if (!bgCompact) {
          // Nothing running yet → kick off a background compaction (non-blocking).
          const h = cs.startBackgroundCompact(session, client);
          if (h) {
            bgCompact = h;
            emitFeed('⏳ 已在后台预压缩历史（阈值为 ≥85% 上下文）……', 'warn');
          } else if (ratioNow >= 0.95) {
            // Critical: stream is about to blow up — do a sync fallback.
            // unified via runSyncCompact (feedback + meter reset)
            await runSyncCompact('⏳ auto-compact 同步兜底：');
          }
        }
      }
    }

    // steering injection — unconsumed steers join THIS round's prompt,
    // then are consumed immediately (injected ones cannot be recalled).
    const pendingSteers = queue.consumeSteers();
    if (pendingSteers.length > 0) {
      task = task + formatSteerInjection(pendingSteers);
      lastInjectedSteers = pendingSteers;
      emitFeed(`本轮已注入 ${pendingSteers.length} 条插话`, 'info');
      updateQueueCount();
    }

    if (!useRich) {
      renderer.writeLine(renderer.color(`\n[提交任务] ${task.split('\n\n【用户插话')[0]}`, 'cyan'));
    } else if (typeof bridge.setRunning === 'function') {
      try { bridge.setRunning(true); } catch {}
    }

    // Abort support: signal 贯穿 solveIssue → loop → 模型 fetch / 工具执行，
    // 中断时 runPromise 以 stopReason='aborted' 正常 settle（见下方 else 分支）。
    // 0.7.4 B6：移除永不 settle 的 abortPromise 死代码——abortReject 从未被调用，
    // Promise.race 的 aborted 分支不可达（真中断由 SIGINT → currentAbort.abort() →
    // loop signal 检查 → stopReason='aborted' 链路承担）。
    const controller = new AbortController();
    currentAbort = controller;
    lastAborted = false;

    const startedAt = Date.now();
    // 任务边界重取当前模型真实窗口（/model 切换后立即生效）
    ctxWindowTokens = resolveCtxWindowTokens();
    // 任务边界重置 line 模式流式/卡片状态
    lineUi.taskStartedAt = startedAt;
    lineUi.taskEndedAt = 0;
    lineUi.ghostIgnored = false;
    lineUi.stepCount = 0;
    lineUi.streamedAnswerChars = 0;
    lineUi.thinkingStart = 0;
    lineUi.thinkingBuf = '';
    lineUi.thinkingPrinted = false;
    lineUi.messageStreaming = false;
    lineUi.toolStack = [];
    lineUi.pendingTool = null;
    // gerund interval handle (declared here so the finally can clear it)
    let gerundTimer: NodeJS.Timeout | null = null;
    // new task boundary — settle previous rollouts, start a fresh clock
    agentTree.markAll('running', 'done');
    treeTaskStart = startedAt;

    try {
      // ensure MCP servers are initialized (lazy, once) before the run
      await initMcpServers();
      const { runAgentTask } = await import('../../server/runAgentTask.js');

      // real approval bridges.
      // - rich path → bridge.setConfirm(request) → ConfirmBar (y/n/a/Esc)
      // - line path → readline question bridge (60s silence → n)
      const approvalBridge = useRich
        ? (req: { tool: string; description: string; danger: boolean }) =>
            (bridgeRef.current.setConfirm(req) as Promise<'y' | 'n' | 'a'>)
        : createCliApprovalBridge();

      // 主 readline 不再全程 pause（那样会让任务运行中的 Ctrl+C
      // 无人接、输入缓冲成幽灵 ^C）。stdin 所有权只在审批 question 挂起时
      // 经 setApprovalActivityListener（line 段注册）临时交接。

      // gerund running label — line-mode inline updates every 4s.
      // Timer unref'd (non-deadline timers must not hold the
      // process) and always cleared in the finally below.
      // 重绘统一走本函数（清活行 → 原地写 → 记 inlineLine）。
      // 审批挂起时暂停；正文流式期间暂停。
      if (!useRich) {
        try {
          const { nextGerund, formatRunningLabel } = await import('./GerundSpinner.js');
          const gStart = startedAt;
          const paint = () => {
            // thinking 单行滚动是活行时 gerund 不重绘（避免 4s 覆盖思考行抖动）
            if (isApprovalActive() || lineUi.messageStreaming || lineUi.inlineLine === 'thinking') return;
            try {
              // 任务运行超 30s → 一次性等待 tip（受全局 ≤2 节流）
              if (Date.now() - gStart > 30000 && sessionTipGate.canShow('wait')) {
                sessionTipGate.markShown('wait');
                clearInlineLine();
                process.stdout.write(`${ANSI_DIM}Tip: 长时间无进展可 Ctrl+C 中断，补充上下文后再试${ANSI_RESET}\n`);
              }
              clearInlineLine();
              let label: string;
              const pt = lineUi.pendingTool;
              if (pt && Date.now() - pt.at > 3000) {
                // pre 后 3s 未 post → 进行时工具标签
                label = `${pt.doing} ${pt.summary}… ⏱ ${Math.floor((Date.now() - gStart) / 1000)}s`;
              } else {
                label = formatRunningLabel(Date.now() - gStart, nextGerund());
              }
              process.stdout.write('\r' + label + '   ');
              lineUi.inlineLine = 'gerund';
            } catch {}
          };
          paint();
          gerundTimer = setInterval(paint, 4000);
          gerundTimer.unref();
        } catch {}
      }

      const runPromise = runAgentTask(
        {
          task,
          // the task must run against the LIVE session state — /tier and
          // /workspace switches take effect immediately, and the session's
          // turns feed "最近 N 轮上下文" on the default path.
          tier: session.tier,
          workspace: session.workspace,
          model: session.model,
          simulate: false,
          session,
        },
        {
          provider: opts.provider,
          signal: controller.signal,
          approvalMode: session.approvalMode,
          sessionAllowlist: session.sessionApprovalAllowlist,
          approvalBridge,
          planMode: session.planMode,
          mcpTools: mcpToolsReady,
          onEvent: (ev: any) => {
            if (controller.signal.aborted) return;

            // feed the agent tree from rolloutId-carrying events
            if (ev && (ev.type === 'step' || ev.type === 'critique') && ev.rolloutId) {
              agentTree.upsert({
                id: String(ev.rolloutId),
                parent: null,
                status: 'running',
                stepCount: Number(ev.stepNumber ?? 1),
                durationMs: treeTaskStart ? Date.now() - treeTaskStart : 0,
                lastPhase: ev.type,
              });
            }

            // heuristic context meter (chars/4) from reasoning/plan/result/critique
            if (ev && ev.type === 'step') {
              bumpCtx(ev.thinking); bumpCtx(ev.plan);
              bumpCtx(typeof ev.result === 'string' ? ev.result : '');
              if (Array.isArray(ev.toolCalls)) {
                for (const tc of ev.toolCalls) {
                  bumpCtx(tc?.rawBlock); bumpCtx(tc?.argsSummary);
                }
              }
              if (useRich && typeof bridge.setTop === 'function') {
                const ratio = Math.min(1, (ctxUsedChars / 4) / ctxWindowTokens);
                try { bridge.setTop({ ctxRatio: ratio }); } catch {}
              }
            } else if (ev && ev.type === 'critique') {
              bumpCtx(ev.critique);
            }

            if (useRich) {
              mapSseToBridge(ev.type || 'event', ev, bridge);
            } else {
              renderSseEvent(ev.type || 'event', ev, renderer);
            }
          },
        }
      );

      // 0.7.4 B6：abortPromise 已删——中断时 runPromise 以 stopReason='aborted'
      // settle，统一走下方 else 分支（三态文案 + partialText 落盘）。
      const raced = { kind: 'done' as const, result: await runPromise };

      // persist the completed turn into the session + rollout jsonl
      // this task's rollouts are done
      agentTree.markAll('running', 'done');
      {
        const r = raced.result;
        const stopReason = (r as any)?.stopReason;
        // 中断语义保持：aborted 回合阻断排队任务自动执行（用户保留排队项手动重跑）
        if (stopReason === 'aborted') lastAborted = true;
        // 三态文案：completed→已通过验证；answered→已回复；aborted→已中断；error→执行失败；其余→未通过验证
        const summary = stopReason === 'completed' ? '已通过验证'
          : stopReason === 'answered' ? '已回复'
          : stopReason === 'aborted' ? '已中断'
          : stopReason === 'error' ? '任务执行失败'
          : r?.success ? '已通过验证' : '未通过验证';
        const turn = {
          id: Date.now().toString(36),
          timestamp: Date.now(),
          userInput: task.split('\n\n【用户插话')[0],
          userInputType: 'task' as const,
          tier: session.tier,
          durationMs: r?.durationMs ?? (Date.now() - startedAt),
          ...(stopReason === 'aborted' && (r as any)?.partialText ? { partialText: (r as any).partialText } : {}),
          result: {
            success: !!r?.success,
            summary,
            budgetReport: r?.budgetReport as any,
            stopReason,
            goal: task.split('\n\n【用户插话')[0],
            changedFiles: (r as any)?.changedFiles ?? [],
            verifyCmd: (r as any)?.verifyCmd ?? [],
            outcome: mapOutcome(stopReason),
          },
        };
        try { session.addTurn(turn); } catch {}
        try { rollout.appendTurn(session.id, turn as any); } catch {}
        // answered 时把模型正文呈现给用户（/edit 可取回）
        // 正文已随 message.delta 流式呈现 → 不再贴 600 字截断预览；
        // 仅当流式不可用（provider 无 streamChat，全程 0 字符流式）时兜底输出全文。
        if (stopReason === 'answered' && r) {
          const traj = (r as any).bestTrajectory;
          const answerText = traj?.steps?.[traj.steps.length - 1]?.result || '';
          if (answerText && useRich && typeof bridge.pushFeed === 'function') {
            bridge.pushFeed({ type: 'markdown', content: answerText });
          } else if (answerText && !useRich && lineUi.streamedAnswerChars < String(answerText).length) {
            // 流式不可用（0 字符）输出全文；流式部分送达时补差量，防尾部静默丢失
            const rest = String(answerText).slice(lineUi.streamedAnswerChars);
            if (rest) {
              renderer.writeLine(renderer.color(rest, 'white'));
              recordOutput(rest);
            }
          }
        }
        recordOutput(summary);
      }
    } catch (err: any) {
      const msg = '任务执行失败: ' + (err?.message || err);
      if (!useRich) renderer.error(msg);
      else if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'error' });
    } finally {
      currentAbort = null;
      void startedAt;
      if (gerundTimer) { try { clearInterval(gerundTimer); } catch {} }
      gerundTimer = null;
      // 清活行（gerund/thinking 残留）；正文流式收尾换行
      clearInlineLine();
      if (lineUi.messageStreaming) { try { process.stdout.write('\n'); } catch {} }
      lineUi.messageStreaming = false;
      lineUi.pendingTool = null;
      lineUi.toolStack = [];
      // 幽灵 ^C 窗口 — 任务刚结束的 1.5s 内缓冲的 Ctrl+C 只忽略一次
      lineUi.taskEndedAt = Date.now();
      lineUi.ghostIgnored = false;
      // 上下文占用 >75% → 一次性 tip（启发式 chars/4 估算，
      // 与 auto-compact 的 ratioNow 同源；受全局 ≤2 节流）
      if (!useRich) {
        const ratio = (ctxUsedChars / 4) / ctxWindowTokens;
        if (ratio > 0.75 && sessionTipGate.canShow('ctx')) {
          sessionTipGate.markShown('ctx');
          try { renderer.writeLine(renderer.color(`Tip: 上下文占用约 ${Math.round(ratio * 100)}% · /compact 可立即压缩`, 'gray')); } catch {}
        }
      }
      if (useRich && typeof bridge.setRunning === 'function') {
        try { bridge.setRunning(false); } catch {}
      } else {
        // Line path: restore prompt so the user can type the next task.
        if (lineRl) { try { lineRl.resume(); } catch {} }
        try { lineSetPrompt(); } catch {}
        if (lineRl) { try { lineRl.prompt(); } catch {} }
      }
    }

    // drain queued tasks once the turn settles (FIFO, one by one).
    // An aborted turn stops the drain — the user keeps the remaining queue.
    while (queue.taskCount > 0 && !lastAborted) {
      const next = queue.drainTasks();
      updateQueueCount();
      for (const t of next) {
        if (lastAborted) break;
        emitFeed(`▶ 执行排队任务：${t.slice(0, 80)}`, 'info');
        await runTaskViaSse(t, bridge);
      }
    }
  }

  // Map normalized SSE events (from agentServer) to the rich bridge (Ink UI).
  function mapSseToBridge(event: string, data: any, b: any) {
    if (!b) return;
    const t = (data && data.type) || event;

    if (t === 'start' || event === 'start') {
      if (typeof b.setRunning === 'function') { try { b.setRunning(true); } catch {} }
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: `开始执行: ${data.task || ''}`, level: 'info' });
      return;
    }
    if (t === 'phase' || event === 'phase') {
      const ph = localizePhase(data.phase || data);
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'phase', phase: ph });
      if (typeof b.setTop === 'function') b.setTop({ phase: ph });
      return;
    }
    if (t === 'thinking.start' || event === 'thinking.start') {
      // New thinking segment: clear only the thinking buffer (P1.4)
      if (typeof b.resetStream === 'function') { try { b.resetStream('thinking'); } catch {} }
      return;
    }
    if (t === 'message.start' || event === 'message.start') {
      // New message segment: clear only the message buffer (💭 stays visible)
      if (typeof b.resetStream === 'function') { try { b.resetStream('message'); } catch {} }
      return;
    }
    if (t === 'thinking.delta' || event === 'thinking.delta') {
      if (typeof b.appendStream === 'function') b.appendStream('thinking', data.text || '');
      return;
    }
    if (t === 'message.delta' || event === 'message.delta') {
      if (typeof b.appendStream === 'function') b.appendStream('message', data.text || '');
      return;
    }
    if (t === 'step' || event === 'step') {
      // Turn segment settled → clear live zone before the step card lands
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      if (typeof b.pushStep === 'function') b.pushStep(data);
      if (Array.isArray(data.toolCalls) && typeof b.pushTool === 'function') {
        for (const tc of data.toolCalls) b.pushTool(tc);
      }
      return;
    }
    if (t === 'critique' || event === 'critique') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      if (typeof b.pushCritique === 'function') b.pushCritique(data);
      return;
    }
    if (t === 'tool' || event === 'tool') {
      if (typeof b.pushTool === 'function') b.pushTool(data);
      return;
    }
    if (t === 'budget' || t === 'softLimit' || event === 'budget' || event === 'softLimit') {
      const ratio = typeof data.usedRatio === 'number' ? data.usedRatio : (typeof data.ratio === 'number' ? data.ratio : 0);
      if (typeof b.pushBudget === 'function') b.pushBudget(ratio);
      return;
    }
    if (t === 'degradation' || event === 'degradation') {
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: `⚠ 行为降级: ${data.reason || 'soft-limit'}`, level: 'warn' });
      return;
    }
    if (t === 'markdown' || event === 'markdown') {
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'markdown', content: data.content || '' });
      return;
    }
    if (t === 'thought' || event === 'thought') {
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'thought', short: data.short || '', full: data.full || data.thinking || '' });
      return;
    }
    if (t === 'progress' || event === 'progress') {
      // lightweight; surface as phase hint if numeric step present
      if (typeof data.step === 'number' || typeof data.stepNumber === 'number') {
        const n = data.step ?? data.stepNumber;
        if (typeof b.setTop === 'function') { try { b.setTop({ phase: `step ${n}` }); } catch {} }
      }
      return;
    }
    if (t === 'result' || event === 'result') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      // 四态文案：answered→已回复；aborted→已中断；error→执行失败；success→已通过验证；否则未通过验证
      const sr2 = data.stopReason;
      const resultText = sr2 === 'answered' ? '已回复' : sr2 === 'aborted' ? '已中断'
        : sr2 === 'error' ? '任务执行失败'
        : data.success ? '完成（已通过验证）' : '任务未通过验证';
      const level = sr2 === 'answered' || data.success ? 'success'
        : (sr2 === 'aborted' || sr2 === 'error') ? 'error' : 'warn';
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: resultText, level });
      if (data && data.budgetReport && typeof data.budgetReport.usageRatio === 'number') {
        if (typeof b.pushBudget === 'function') b.pushBudget(data.budgetReport.usageRatio);
      }
      if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
      return;
    }
    if (t === 'done' || event === 'done') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      if (data && data.durationMs && typeof b.pushFeed === 'function') {
        // "Cooked for" style tail note (CC-inspired)
        b.pushFeed({ type: 'text', text: `⏱ 用时 ${(data.durationMs / 1000).toFixed(1)}s`, level: 'info' });
      }
      if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
      return;
    }
    if (t === 'error' || event === 'error') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      const msg = data && (data.message || JSON.stringify(data));
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: '错误: ' + msg, level: 'error' });
      if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
      return;
    }
    // Fallback generic
    if (typeof b.pushFeed === 'function') {
      if (data && typeof data === 'object' && data.type) b.pushFeed(data);
      else b.pushFeed({ type: 'text', text: JSON.stringify(data), level: 'info' });
    }
  }

  // Line-mode renderer for SSE events (used when rich UI is not active).
  // line 模式接住 version 2 流式增量 —
  //   thinking.delta → 默认单行滚动（dim 斜体 ∴ + 最新行截断），verbose 开启时全文多行；
  //   message.delta  → 正文逐 delta 直接写 stdout（无前缀），回合结束补换行。
  function endThinkingBlock(r: ReturnType<typeof createOutputRenderer>) {
    const started = lineUi.thinkingStart > 0;
    if (lineUi.verbose) {
      if (lineUi.thinkingBuf) {
        const carry = lineUi.thinkingBuf;
        lineUi.thinkingBuf = '';
        printVerboseThinkingLine(carry, r);
      }
    } else if (started) {
      clearInlineLine();
      const secs = Math.max(1, Math.round((Date.now() - lineUi.thinkingStart) / 1000));
      try { r.writeLine(r.color(`∴ 已思考 ${secs}s`, 'gray')); } catch {}
    }
    lineUi.thinkingStart = 0;
    lineUi.thinkingBuf = '';
    lineUi.thinkingPrinted = false;
  }

  function printVerboseThinkingLine(line: string, r: ReturnType<typeof createOutputRenderer>) {
    void r;
    const text = String(line ?? '').replace(/\t/g, '  ');
    if (!text.trim()) return;
    clearInlineLine(); // gerund 标签可能还占着当前行（清行纪律）
    const w = Math.max(20, termWidth() - 4);
    for (const chunk of wrapByWidth(text, w)) {
      try { process.stdout.write(`${ANSI_DIM}${ANSI_ITALIC}  ${chunk}${ANSI_RESET}\n`); } catch {}
      lineUi.thinkingPrinted = true;
    }
  }

  function endMessageStream() {
    if (lineUi.messageStreaming) {
      lineUi.messageStreaming = false;
      try { process.stdout.write('\n'); } catch {}
    }
  }

  function renderSseEvent(event: string, data: any, r: ReturnType<typeof createOutputRenderer>) {
    switch (event) {
      case 'thinking.start':
        // 新思考段 — 记起点（首个 thinking.delta 也兜底记）；
        // 上一段若还有正文流式未收尾，先补换行
        endMessageStream();
        lineUi.thinkingStart = Date.now();
        lineUi.thinkingBuf = '';
        lineUi.thinkingPrinted = false;
        return;
      case 'thinking.delta': {
        // 接住思考增量（旧 line 模式直接忽略）
        const text = String(data.text || '');
        if (!text) return;
        if (!lineUi.thinkingStart) lineUi.thinkingStart = Date.now();
        if (lineUi.verbose) {
          // 全文多行 — 按完整行宽度折行 + 2 空格缩进（增量按行 flush）
          lineUi.thinkingBuf += text;
          let nl: number;
          while ((nl = lineUi.thinkingBuf.indexOf('\n')) !== -1) {
            const ready = lineUi.thinkingBuf.slice(0, nl);
            lineUi.thinkingBuf = lineUi.thinkingBuf.slice(nl + 1);
            printVerboseThinkingLine(ready, r);
          }
          return;
        }
        // 默认：单行滚动 — 取最新一行，dim 斜体 ∴ 前缀，截到终端宽度-4
        lineUi.thinkingBuf += text;
        const parts = lineUi.thinkingBuf.split('\n');
        let last = '';
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].trim()) { last = parts[i]; break; }
        }
        if (!last) return;
        clearInlineLine();
        const shown = truncateByWidth(last.replace(/\t/g, '  '), Math.max(10, termWidth() - 4));
        try { process.stdout.write(`${ANSI_DIM}${ANSI_ITALIC}∴ ${shown}${ANSI_RESET}`); } catch {}
        lineUi.inlineLine = 'thinking';
        return;
      }
      case 'message.start':
        // thinking 结束（收到 message.start → 折叠为灰字统计）
        endThinkingBlock(r);
        return;
      case 'message.delta': {
        // 正文流式 — 逐 delta 直接写 stdout（正文本体，无前缀）；
        // gerund 重绘在 messageStreaming 期间暂停（paint 回调里检查）。
        const text = String(data.text || '');
        if (!text) return;
        clearInlineLine();
        try { process.stdout.write(text); } catch {}
        lineUi.messageStreaming = true;
        lineUi.streamedAnswerChars += text.length;
        return;
      }
      case 'start':
        r.writeLine(r.color(`开始执行: ${data.task || ''}`, 'cyan'));
        break;
      case 'phase':
        // phase 值本地化（渲染层映射，不改事件值）
        r.writeLine(r.color(`── ${localizePhase(String(data.phase || data))} ──`, 'gray'));
        break;
      case 'step': {
        // 流式段收尾：thinking 折叠为统计行、正文流补换行
        endThinkingBlock(r);
        endMessageStream();
        const n = Number(data.stepNumber);
        if (Number.isFinite(n) && n > 0) lineUi.stepCount = n; // 步数（Chaser 末尾 lastStep = 总步数）
        const msg = `[Step ${data.stepNumber}] ${data.thinking || data.plan || ''}`;
        r.writeLine(r.color(msg, 'white'));
        // 旧的 step.toolCalls 一行渲染已删除（被实时工具卡片取代）；
        // step 只剩 thinking 汇总；verificationResult 维持现有渲染（无单独渲染）。
        break;
      }
      case 'tools/pre-execute': {
        // 工具实时卡片头行 `▸ <工具名青色> <参数摘要>`
        endMessageStream(); // 模型正文若刚流式完，先补换行再出卡片
        const tool = String(data.tool || 'tool');
        const params = (data.params && typeof data.params === 'object') ? data.params : {};
        const summary = summarizeToolParams(tool, params);
        lineUi.toolStack.push({ tool, params });
        lineUi.pendingTool = { tool, summary, doing: doingVerb(tool), at: Date.now() };
        clearInlineLine();
        r.writeLine(`${ANSI_DIM}▸${ANSI_RESET} ${r.color(tool, 'cyan')} ${r.color(summary, 'gray')}`);
        break;
      }
      case 'tools/post-execute': {
        // 结果行 `  ⎿ <动词句>`（从最近工具栈取回 pre 参数）
        let preParams: any = null;
        for (let i = lineUi.toolStack.length - 1; i >= 0; i--) {
          if (lineUi.toolStack[i].tool === String(data.tool || '')) {
            preParams = lineUi.toolStack.splice(i, 1)[0].params;
            break;
          }
        }
        if (preParams === null && lineUi.toolStack.length > 0) preParams = lineUi.toolStack.pop()!.params;
        lineUi.pendingTool = null;
        clearInlineLine();
        r.writeLine('  ⎿ ' + toolResultLine(data, preParams));
        break;
      }
      case 'critique':
        // 删除死前缀 `Critique: `（critique 机制已休眠，直接呈现内容）
        r.writeLine(r.color(String(data.critique || data), 'yellow'));
        break;
      case 'tool':
        r.writeLine(r.color(`⚙ ${data.tool || ''} ${data.target || ''} [${data.status || ''}]`, 'cyan'));
        if (data.result) {
          const preview = String(data.result).slice(0, 200);
          r.writeLine(r.color('   ' + preview, 'gray'));
        }
        break;
      case 'budget':
      case 'softLimit':
        const pct = Math.floor(((data.usedRatio || 0) * 100));
        const color = pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green';
        r.writeLine(r.color(`[预算 ${pct}%]`, color));
        break;
      case 'degradation':
        r.writeLine(r.color(`⚠ 行为降级: ${data.reason || 'soft-limit'}`, 'yellow'));
        break;
      case 'progress':
        r.writeLine(r.color(`… 进度 step ${data.step || data.stepNumber || ''}`, 'gray'));
        break;
      case 'markdown':
        // In line mode, render a compact preview
        {
          const content = String(data.content || '').trim();
          if (content) {
            const preview = content.length > 240 ? content.slice(0, 237) + '…' : content;
            r.writeLine(r.color(preview, 'white'));
          }
        }
        break;
      case 'thought':
        {
          const s = data.short || data.thinking || '';
          r.writeLine(r.color(`💭 ${s}`, 'magenta'));
        }
        break;
      case 'result':
        {
          // 流式段收尾
          endThinkingBlock(r);
          endMessageStream();
          // 结束总结块 — `✓ 已通过验证 · N 步 · Xs · ~Yk tokens · 预算 Z%`
          // + 第二行灰字「下一步」按 stopReason 分支。[最终预算] 并入总结行。
          const sr = String(data.stopReason || '');
          const elapsedMs = lineUi.taskStartedAt ? Date.now() - lineUi.taskStartedAt : 0;
          const stateText = sr === 'completed' ? '✓ 已通过验证'
            : sr === 'answered' ? '✓ 已回复'
            : sr === 'aborted' ? '↩ 已中断'
            : sr === 'error' ? '✗ 任务执行失败'
            : data.success === true ? '✓ 已通过验证' : '✗ 未通过验证';
          const parts: string[] = [stateText];
          if (lineUi.stepCount > 0) parts.push(`${lineUi.stepCount} 步`);
          if (elapsedMs > 0) parts.push(fmtMs(elapsedMs));
          const tokens = Number(data?.budgetReport?.estimatedUsedTokens) || 0;
          if (tokens > 0) parts.push(`~${(tokens / 1000).toFixed(1)}k tokens`);
          const ratio = Number(data?.budgetReport?.usageRatio);
          if (Number.isFinite(ratio) && ratio > 0) parts.push(`预算 ${Math.round(ratio * 100)}%`);
          const lineColor = (sr === 'aborted' || sr === 'error') ? 'yellow'
            : (sr === 'completed' || sr === 'answered' || data.success === true) ? 'green' : 'red';
          const summaryLine = parts.join(' · ');
          r.writeLine(r.color(summaryLine, lineColor));
          r.writeLine(r.color(`  下一步: ${nextStepHint(sr)}`, 'gray'));
          recordOutput(summaryLine);
        }
        break;
      case 'done':
        if (data.durationMs) {
          // "Cooked for" style tail note (CC-inspired)
          const t = `⏱ 用时 ${(data.durationMs / 1000).toFixed(1)}s`;
          r.writeLine(r.color(t, 'gray'));
          recordOutput(t);
        }
        break;
      case 'error':
        r.error(data.message || JSON.stringify(data));
        break;
      default:
        if (data && typeof data === 'object' && data.type) {
          renderSseEvent(data.type, data, r);
        } else {
          r.writeLine(JSON.stringify(data));
        }
    }
  }

  // --- Try rich UI (the real "交互升级") ---
  let bridge: any = null;
  let richActive = false;

  // Use a ref so the initial hostCtx lambdas see updates after assignment.
  const bridgeRef: { current: any } = { current: null };

  try {
    const { tryStartInkUI } = await import('./ui/startInkUI.js');

    // shared session (created above) — approval mode/allowlist are
    // seeded here and flow into the engine adapter via runTaskViaSse.
    // submissions route through handleUserLine (queue/steer aware).
    const hostCtx: any = {
      handleInput: async (text: string) => { await handleUserLine(text, bridgeRef.current); },
      executeTask: async (text: string) => { await handleUserLine(text, bridgeRef.current); },
    };

    const res = await tryStartInkUI(session as any, renderer, hostCtx);
    if (res && res.started) {
      richActive = true;
      bridge = (hostCtx as any).inkBridge || (hostCtx as any)._inkBridge || null;
      bridgeRef.current = bridge;

      // expose host-side handlers to the rich bridge
      try {
        (bridge as any).cycleMode = () => cycleMode();
        (bridge as any).clearQueue = () => { queue.clear(); updateQueueCount(); };
        (bridge as any).requestStatusPanel = () => {
          (async () => {
            const { recentCheckpoints } = await import('../../tools/fileHistory.js');
            const cps = recentCheckpoints(session.workspace || process.cwd(), 5);
            const feedOrLine = (text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
              if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level });
              else renderer.writeLine(renderer.color(text, 'gray'));
            };
            feedOrLine(`── 状态面板 ── 队列任务 ${queue.taskCount} · 未注入插话 ${queue.steerCount} · 模式 ${modeRing.current}`, 'info');
            for (const c of cps) feedOrLine(`  ↳ checkpoint ${c.rel}（${c.prevExists ? '可还原' : '创建型'}）`, 'info');
            if (cps.length === 0) feedOrLine('  ↳ （暂无 file-history checkpoint）', 'info');
          })().catch(() => {});
        };
      } catch {}

      // Rebind to ensure we pass the resolved bridge value.
      hostCtx.handleInput = async (text: string) => { await handleUserLine(text, bridgeRef.current); };
      hostCtx.executeTask = async (text: string) => { await handleUserLine(text, bridgeRef.current); };
    }
  } catch {
    // Any failure is silent; fall through to line streaming (still event-driven).
  }

  if (richActive && bridge) {
    // Rich Hermes UI owns the terminal. Nothing to clean up (no transport server).
    return;
  }

  // === Line streaming terminal (same in-process events, structured colored lines) ===
  // "通道升级" when rich UI (ink) is not available or TTY caps insufficient.
  renderer.clearScreen();
  // 启动横幅 — 粗体名 + dim 元信息（cwd 按显示宽度截断）
  {
    const banner = buildBanner({
      model: session.model,
      tier: String(session.tier),
      mode: modeRing.current,
      workspace: session.workspace || process.cwd(),
      width: termWidth(),
    });
    renderer.writeLine(renderer.color(banner[0], 'bold'));
    renderer.writeLine(renderer.color(banner[1], 'gray'));
    renderer.writeLine(renderer.color(banner[2], 'gray'));
    // 首跑预检——横幅处探测无任何可用 provider 时打一行灰字配置
    // 指引（不阻塞、不报错；用户配置好后 /model list 会热加载）。
    try {
      const { createDefaultModelProvider } = await import('../../cli/repl/ModelProvider.js');
      const probe = opts.provider ?? createDefaultModelProvider();
      const names = typeof probe.listModels === 'function' ? probe.listModels() : [];
      const anyUsable = names.some((n) => { try { return !!probe.createClient(n); } catch { return false; } })
        || !!(typeof probe.createDefaultClient === 'function' && probe.createDefaultClient());
      if (!anyUsable) {
        renderer.writeLine(renderer.color(
          '未检测到可用模型。三选一：① 项目根放 .panshalach.json（示例见 README/DEPLOY-CN §2.3） ② 用户级 ~/.panshalach/config.json ③ 启动后 /model list 选择',
          'gray'
        ));
      }
    } catch {}
  }
  if (resumedInfo) {
    renderer.info(`已恢复会话 ${resumedInfo.from}（${resumedInfo.turns} 轮上下文，模式 ${session.approvalMode}）——/status 查看，/undo 撤销最近写盘`);
  } else if (shouldShowStartupTip(session.turns.length, false, Math.random()) && sessionTipGate.canShow('startup')) {
    // 新会话 50% 概率出一条启动 tip
    sessionTipGate.markShown('startup');
    renderer.writeLine(renderer.color('Tip: 直接输入任务描述即可开始，如 "修复 README 里的错别字"', 'gray'));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: renderer.color('▸ ', 'cyan'),
    // Tab 补全 `/` 命令名（精确前缀优先 + 模糊兜底，常用命令在前）
    completer: (line: string): [string[], string] => completeLineCommand(line),
  });

  // Wire holders so the unified SSE runner (defined earlier) can restore the prompt
  // after consuming the SSE stream in the line-mode fallback.
  lineRl = rl;

  // 空闲提示符上方的模式徽标行 — 只在启动与模式变化后输出一次。
  function printModeBadgeIfPending() {
    if (!modeBadgePending) return;
    modeBadgePending = false;
    try { renderer.writeLine(renderer.color(modeBadgeLine(modeRing.current), 'gray')); } catch { modeBadgePending = true; }
  }

  /** 空闲态出提示符（徽标行置前；统一入口，防漏防刷）。 */
  function linePromptIdle() {
    printModeBadgeIfPending();
    try { rl.prompt(); } catch {}
  }

  lineSetPrompt = () => {
    rl.setPrompt(renderer.color('▸ ', 'cyan'));
    printModeBadgeIfPending(); // runTaskViaSse finally 恢复提示符前也补徽标（若模式刚变过）
  };

  rl.on('close', () => {
    renderer.writeLine('\n再见。');
    process.exit(0);
  });

  // 审批 question 挂起/结束时交接 stdin（暂停/恢复主 readline）。
  // 审批桥（approval.ts）经模块级钩子通知这里；gerund 的暂停在 paint 回调里
  // 直接检查 isApprovalActive()。
  try {
    setApprovalActivityListener((active) => {
      if (!lineRl) return;
      try { if (active) lineRl.pause(); else lineRl.resume(); } catch {}
    });
  } catch {}

  // Ctrl+C 全链路 — 统一入口（readline raw 模式的 \x03 走 rl 'SIGINT'；
  // cooked 模式 / POSIX 信号 / Windows console ctrl 走 process 'SIGINT' 兜底）。
  // 同一次按键两个入口都触发时用 100ms 去重。
  function handleSigint() {
    const now = Date.now();
    if (now - lineUi.lastSigintAt < 100) return;
    lineUi.lastSigintAt = now;
    // 1) 审批挂起 → 立即拒绝该次审批
    if (isApprovalActive()) {
      cancelActiveApproval('sigint');
      return;
    }
    // 2) 任务运行中 → 中断（提示合并：只由 aborted 分支出一条消息）
    if (currentAbort) {
      try { currentAbort.abort(); } catch {}
      return;
    }
    // 3) 幽灵 ^C：任务刚结束 1.5s 内的缓冲按键只忽略一次，随后放行到二次确认
    if (lineUi.taskEndedAt && now - lineUi.taskEndedAt < 1500) {
      if (!lineUi.ghostIgnored) {
        lineUi.ghostIgnored = true;
        renderer.writeLine(renderer.color('（任务刚结束，忽略退出）', 'gray'));
        return;
      }
      // 窗口内第二次按：已提示过一次，落到二次确认分支
    }
    // 4) 空闲 → 二次确认模式：2s 内再按才退出
    if (lineUi.idleCtrlCAt && now - lineUi.idleCtrlCAt < 2000) {
      renderer.writeLine('\n再见。');
      process.exit(0);
    }
    lineUi.idleCtrlCAt = now;
    renderer.writeLine(renderer.color('再按一次 Ctrl+C 退出 · Ctrl+C 正在执行时 = 中断任务', 'gray'));
    const t = setTimeout(() => { lineUi.idleCtrlCAt = 0; }, 2000);
    (t as any).unref?.();
  }

  rl.on('SIGINT', () => handleSigint());
  process.on('SIGINT', () => handleSigint());

  // shift+tab 循环模式环；Esc 取消待定命令建议。
  // 审批挂起期间（stdin 所有权在审批桥）与任务运行中（提示符不在屏，
  // 输出会被流式内容污染）一律忽略。
  try {
    process.stdin.on('keypress', (_str: string, key: any) => {
      if (!key) return;
      if (key.shift && key.name === 'tab') {
        if (isApprovalActive() || isRunning()) return;
        cycleMode();
        linePromptIdle(); // 回执已由 onChange 打印；徽标行 + 提示符在此补上
        return;
      }
      if (key.name === 'escape' && pendingSuggestion) {
        pendingSuggestion = null;
        renderer.writeLine(renderer.color('（已取消命令建议）', 'gray'));
        linePromptIdle();
      }
    });
  } catch {}

  // Simple command handling (local for now, can be proxied later)
  async function handleLocalCommand(line: string): Promise<boolean> {
    const trimmed = line.trim();
    if (!trimmed) return true;

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q') {
      rl.close();
      return true;
    }

    // 0.7.4 任务 C：`?` 不再截获——输入问号也是给模型的信息（控制人裁决），
    // `?` 作为普通任务文本透传；帮助只走 /help（buildQuickHelpLines 保留供 /help 复用）。

    if (trimmed === '/help' || trimmed === '/h') {
      // 与派发器 / classic 完全一致的分组帮助（HelpCommand 渲染）
      const reg = await getSharedRegistry();
      const view = buildHelpView(reg.list());
      for (const l of view.lines) renderer.writeLine(l.style ? renderer.color(l.text, l.style) : l.text);
      if (view.message) renderer.warn(view.message);
      return true;
    }

    if (trimmed === '/status') {
      const pct = Math.min(100, Math.floor((ctxUsedChars / 4 / ctxWindowTokens) * 100));
      renderer.writeLine('传输: 进程内直连（in-process events，无端口）。远程 UI 可用 /serve 启动 SSE 服务。');
      renderer.writeLine(`上下文估算: ~${pct}% of ${ctxWindowTokens} tokens（启发式）`);
      renderer.writeLine(`队列: ${queue.taskCount} 个排队任务；未注入插话: ${queue.steerCount}`);
      try {
        const { isBranch } = await import('../../cli/repl/rolloutStore.js');
        const origin = isBranch(session.id);
        if (origin) renderer.writeLine(`分支: branch of ${origin}（/resume 可回原会话）`);
      } catch {}
      if (lastInjectedSteers.length > 0) {
        renderer.writeLine(`最近注入的插话: ${lastInjectedSteers.join(' / ')}`);
      }
      return true;
    }

    if (trimmed === '/clear') {
      renderer.clearScreen();
      return true;
    }

    if (trimmed === '/edit' || trimmed === '/e') {
      const prev = getLastOutput();
      if (!prev) {
        renderer.warn('暂无上次输出可编辑');
        return true;
      }
      // Prefill for quick edit/resubmit in line mode
      try {
        (rl as any).line = prev;
        (rl as any).cursor = prev.length;
        if (typeof (rl as any)._refreshLine === 'function') (rl as any)._refreshLine();
        renderer.writeLine(renderer.color('(已载入上次输出，可编辑后回车提交)', 'gray'));
      } catch {
        renderer.writeLine('--- 上次输出 ---');
        renderer.writeLine(prev);
        renderer.writeLine('--- 直接提交以重用 ---');
        rl.prompt();
      }
      return true;
    }

    return false; // not a local command, treat as task
  }

  // Main input loop (line mode over SSE transport)
  let pendingPaste: string | null = null; // folded paste awaiting Enter
  linePromptIdle();

  rl.on('line', async (line) => {
    // 审批挂起期间主 readline 虽被暂停仍会消费同一 stdin——
    // 用户答 'y'/'n'/指导语会同时触发这里的 'line'。直接丢弃，防幽灵任务排队。
    if (isApprovalActive()) return;
    const trimmed = line.trim();
    if (!trimmed) {
      // 任务运行中（readline 已恢复消费输入）不打印提示符，避免污染流式输出
      if (isRunning()) return;
      if (pendingPaste !== null) {
        // 折叠粘贴的第二次回车 = 提交
        const submit = pendingPaste;
        pendingPaste = null;
        linePromptIdle();
        await handleUserLine(submit, undefined);
        return;
      }
      if (pendingSuggestion) {
        // 回车确认执行建议命令。
        // 先过本地命令注册（/exit /clear 等只在 handleLocalCommand），
        // 否则建议 /exit 确认后又落 runTaskViaSse 的"未知命令"分支自指循环。
        const sug = pendingSuggestion;
        pendingSuggestion = null;
        renderer.writeLine(renderer.color(`→ ${sug}`, 'gray'));
        if (!(await handleLocalCommand(sug))) {
          await runTaskViaSse(sug);
        }
        if (!isRunning()) linePromptIdle();
        return;
      }
      // 空输入回车给灰字引导（原来是静默重出提示符）
      renderer.writeLine(renderer.color('输入任务描述，或 ? 看快捷帮助', 'gray'));
      linePromptIdle();
      return;
    }
    if (pendingSuggestion) pendingSuggestion = null; // 其他输入 = 取消建议，按原样处理

    // Use the unified runner (no bridge → line renderer path).
    // while a task is running, submissions are queued/steered instead.
    if (isRunning()) {
      await handleUserLine(trimmed, undefined);
      // 任务结束时 finally 会统一恢复提示符
      return;
    }

    // paste guard (line mode) — large pastes fold and need a second
    // Enter to confirm (Esc-free simplification per instruction).
    const { detectPaste } = await import('./PasteGuard.js');
    const pasteInfo = detectPaste(line);
    if (pasteInfo.isPaste && pendingPaste === null) {
      pendingPaste = line;
      renderer.writeLine(renderer.color(`[粘贴 ${pasteInfo.lines} 行，已折叠；回车提交，Esc/输入其它内容取消]`, 'yellow'));
      linePromptIdle();
      return;
    }
    if (pendingPaste !== null) {
      // Any other input cancels the pending paste and is processed normally
      pendingPaste = null;
    }

    const isLocal = await handleLocalCommand(trimmed);
    if (isLocal) {
      linePromptIdle();
      return;
    }

    if (trimmed.startsWith('/')) {
      // 派发器本地命令（/mode /model /usage /tier …）多为早退分支、不经过
      // runTaskViaSse 的 finally — 这里统一恢复提示符。
      await runTaskViaSse(trimmed);
      if (!isRunning()) linePromptIdle();
      return;
    }

    // Use the unified runner (no bridge → line renderer path).
    // The runner's finally restores the prompt via lineSetPrompt/lineRl.
    await runTaskViaSse(trimmed);
  });
}

// Also export a thin wrapper so cli.ts can call it cleanly
export async function startDefaultSseCli() {
  return startSseInteractive();
}
