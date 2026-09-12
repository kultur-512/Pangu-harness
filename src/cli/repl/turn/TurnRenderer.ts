// src/cli/repl/turn/TurnRenderer.ts
// M1-TurnController（0.8 第 2 步，四模块搬家）：line/rich 渲染纯助手 + SSE 事件渲染。
// 纯函数（truncateByWidth/buildBanner/toolResultLine/nextStepHint 等，测试在用）+
// mapSseToBridge / renderSseEvent（runTaskViaSse 事件分发用）。
// 依赖纪律：只依赖 turn/TurnContext 与 repl/ 外部模块，不反向 import turn/ 其余模块。

import { readFileSync } from 'node:fs';
import { createOutputRenderer } from '../OutputRenderer.js';
import { stringWidth, padByWidth } from '../stringWidth.js';
import type { OutputRendererLike, TurnContext } from './TurnContext.js';
import { clearInlineLine, recordOutput } from './TurnContext.js';

// ---- line 模式渲染纯助手（模块级，便于测试） ----
export const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED = '\x1b[31m';
const ANSI_ITALIC = '\x1b[3m';
export const ANSI_CYAN = '\x1b[36m';
export const ANSI_RESET = '\x1b[0m';

// ==================== 0.8.1 UX 收敛（真机 MiniMax-M3 实测驱动） ====================
// 两个显示层纯助手：只改"渲染时"的文本，落盘原文（turn/trajectory）不受影响。

/** 未解析调用块的折叠提示行（折叠后唯一展示内容）。 */
export const UNPARSED_CALL_NOTICE = '⚠ 模型输出的调用格式无法解析（已跳过）';

/**
 * 疑似未解析调用块探测（改进 2）：
 *  - 以裸 `<>` 块开头；或
 *  - 含配对的 <tool_name>…</tool_name> 标签，且名字含 `_`（read_file/write_file_path
 *    等）或配对体内还有嵌套标签（调用块形态；排除 <div>x</div> 等普通 HTML 词）。
 */
export function looksLikeUnparsedCallBlock(text: string): boolean {
  const s = String(text ?? '');
  if (s.startsWith('<>')) return true;
  const m = s.match(/<([a-z][a-z0-9_]{1,39})>([\s\S]*?)<\/\1>/i);
  if (!m) return false;
  return m[1].includes('_') || /<[a-z][a-z0-9_]{1,39}>/i.test(m[2]);
}

/** 渲染层折叠：疑似未解析调用块 → 一行提示，不再展示原始 XML 噪声。 */
export function collapseUnparsedCallBlock(text: string): string {
  const s = String(text ?? '');
  return looksLikeUnparsedCallBlock(s) ? UNPARSED_CALL_NOTICE : s;
}

const ANSI_BOLD_OFF = '\x1b[22m';
const ANSI_FG_OFF = '\x1b[39m';

// ==================== 0.8 UI 对齐 U1：spinner 帧行组装 ====================
// 纯组装（无 IO 无 timer）：帧字符青色 + 动词亮色（bold）+ 耗时 dim。
// 动画退化路径（reducedMotion / 非 TTY）不走这里——沿用 GerundSpinner
// formatRunningLabel 的纯文本（无 ANSI）。

/** spinner 运行行：`<帧字符青> <动词亮>… <⏱ Ns dim>`。 */
export function spinnerRunningLine(frame: string, verb: string, elapsedMs: number): string {
  const secs = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${ANSI_CYAN}${frame}${ANSI_FG_OFF} ${ANSI_BOLD}${verb}${ANSI_BOLD_OFF}… ${ANSI_DIM}⏱ ${secs}s${ANSI_BOLD_OFF}`;
}

/** 进行时工具标签行（pre 后 3s 未 post）：帧字符前缀 + `Writing xxx… ⏱ Ns`。 */
export function spinnerToolLine(frame: string, doing: string, summary: string, elapsedMs: number): string {
  const secs = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${ANSI_CYAN}${frame}${ANSI_FG_OFF} ${ANSI_BOLD}${doing}${ANSI_BOLD_OFF} ${summary}… ${ANSI_DIM}⏱ ${secs}s${ANSI_BOLD_OFF}`;
}

/**
 * line 模式轻量 markdown（改进 3）：`**x**` → ANSI 粗体、`` `x` `` → ANSI 青色。
 * 用于整段呈现（answerText 兜底 / step 正文）与 U2 流式行缓冲的段内转换。
 * 代码 span 优先占位（内层 `**` 不再二次替换），跨行不匹配；
 * 未闭合的 `**` / 单个 `` ` `` 原样保留；有序列表 `1. ` 前缀不转换不着色。
 */
export function renderInlineMarkdown(text: string): string {
  const s = String(text ?? '');
  if (!s) return s;
  const codes: string[] = [];
  let out = s.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    codes.push(`${ANSI_CYAN}${inner}${ANSI_FG_OFF}`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, `${ANSI_BOLD}$1${ANSI_BOLD_OFF}`);
  if (codes.length > 0) {
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
  }
  return out;
}

// ==================== 0.8 UI 对齐 U2：流式正文行缓冲 ====================

/**
 * U2 流式增量冲刷：从缓冲里切出「完整段」（以 `\n` 或 `。` 收尾）做行内
 * markdown 转换后可输出；尾段不足一个完整段 → 留在缓冲等下一 delta。
 * 纯函数：返回 ready（已转换、可直接写终端）与 rest（继续缓冲的残段）。
 */
export function flushBufferedMarkdown(buf: string): { ready: string; rest: string } {
  const s = String(buf ?? '');
  if (!s) return { ready: '', rest: '' };
  const last = Math.max(s.lastIndexOf('\n'), s.lastIndexOf('。'));
  if (last === -1) return { ready: '', rest: s };
  return {
    ready: renderInlineMarkdown(s.slice(0, last + 1)),
    rest: s.slice(last + 1),
  };
}

/** 终端宽度（列）。非 TTY / 测试环境默认 80。 */
export function termWidth(): number {
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
    const parsed = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf-8'));
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

// ==================== 0.8 UI 对齐 U4：空闲状态行 ====================

/**
 * U4 空闲状态行（提示符上方 dim 行，回合边界刷新、非常驻重绘）：
 * `<模型短名> · <tier> · <模式> · ctx ~N%`。
 * ctx 用启发式 chars/4 估算（与 auto-compact / Tip 同源），封顶 100%。
 */
export function buildIdleStatusLine(opts: {
  model: string;
  tier: string;
  mode: string;
  ctxUsedChars: number;
  ctxWindowTokens: number;
}): string {
  const short = stripModelProviderPrefix(opts.model);
  const ratio = (Number(opts.ctxUsedChars) || 0) / 4 / Math.max(1, Number(opts.ctxWindowTokens) || 1);
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return `${short} · ${opts.tier} · ${opts.mode} · ctx ~${pct}%`;
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

/** 启动 tip 条件 — 新会话（无历史轮、非 resume）且掷中 50% 概率。 */
export function shouldShowStartupTip(turns: number, resumed: boolean, rand: number): boolean {
  return turns === 0 && !resumed && rand < 0.5;
}

// ==================== SSE 事件渲染（rich 桥 + line 模式） ====================

const CLEAR_ON_WRITE = new Set(['writeLine', 'write', 'stream', 'success', 'warn', 'error', 'info', 'table', 'codeBlock']);
/**
 * renderer 包装器 — 所有正式输出（writeLine/success/warn/…）前先清活行。
 * gerund/thinking 的原地重绘不经过这里（直接 stdout + 记 inlineLine），
 * 因此清行纪律只有这一个入口。
 */
export function createClearingRenderer(rawRenderer: OutputRendererLike, clearInline: () => void): OutputRendererLike {
  return new Proxy(rawRenderer, {
    get(target: any, prop: string | symbol) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (CLEAR_ON_WRITE.has(String(prop))) {
        return (...args: any[]) => { clearInline(); return v.apply(target, args); };
      }
      return v.bind(target);
    },
  }) as OutputRendererLike;
}

// Map normalized SSE events (from agentServer) to the rich bridge (Ink UI).
export function mapSseToBridge(event: string, data: any, b: any, ctx?: TurnContext) {
  if (!b) return;
  const t = (data && data.type) || event;

  if (t === 'start' || event === 'start') {
    if (typeof b.setRunning === 'function') { try { b.setRunning(true); } catch {} }
    if (ctx) ctx.runningBadgeOn = true;
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
    if (typeof b.pushStep === 'function') {
      // 0.8.1 UX：rich 卡片同样折叠疑似未解析调用块（只改显示，事件原文不变）
      b.pushStep({
        ...data,
        ...(typeof data.thinking === 'string' ? { thinking: collapseUnparsedCallBlock(data.thinking) } : {}),
        ...(typeof data.plan === 'string' ? { plan: collapseUnparsedCallBlock(data.plan) } : {}),
      });
    }
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
      : sr2 === 'error' ? '任务执行失败' : data.success ? '完成（已通过验证）' : '任务未通过验证';
    const level = sr2 === 'answered' || data.success ? 'success'
      : (sr2 === 'aborted' || sr2 === 'error') ? 'error' : 'warn';
    if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: resultText, level });
    if (data && data.budgetReport && typeof data.budgetReport.usageRatio === 'number') {
      if (typeof b.pushBudget === 'function') b.pushBudget(data.budgetReport.usageRatio);
    }
    if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
    if (ctx) ctx.runningBadgeOn = false;
    return;
  }
  if (t === 'done' || event === 'done') {
    if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
    if (data && data.durationMs && typeof b.pushFeed === 'function') {
      // "Cooked for" style tail note (CC-inspired)
      b.pushFeed({ type: 'text', text: `⏱ 用时 ${(data.durationMs / 1000).toFixed(1)}s`, level: 'info' });
    }
    if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
    if (ctx) ctx.runningBadgeOn = false;
    return;
  }
  if (t === 'error' || event === 'error') {
    if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
    const msg = data && (data.message || JSON.stringify(data));
    if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: '错误: ' + msg, level: 'error' });
    if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
    if (ctx) ctx.runningBadgeOn = false;
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
//   message.delta  → 增量先入行缓冲，按完整段（\n 或 。收尾）做行内 markdown
//                    转换后写 stdout（U2），回合/段结束由 endMessageStream 冲刷残段。
/** 正文流收尾（U2 扩展，导出供 TurnController answered 兜底复用）：先冲刷行缓冲
 *  残段（renderInlineMarkdown 兜底转换），流式态则补换行。幂等：缓冲空且未流式时 no-op。 */
export function endMessageStream(ctx: TurnContext) {
  const buf = ctx.lineUi.messageBuf;
  if (buf) {
    ctx.lineUi.messageBuf = '';
    try { process.stdout.write(renderInlineMarkdown(buf)); } catch {}
  }
  if (ctx.lineUi.messageStreaming) {
    ctx.lineUi.messageStreaming = false;
    try { process.stdout.write('\n'); } catch {}
  }
}

function endThinkingBlock(ctx: TurnContext, r: ReturnType<typeof createOutputRenderer>) {
  const started = ctx.lineUi.thinkingStart > 0;
  if (ctx.lineUi.verbose) {
    if (ctx.lineUi.thinkingBuf) {
      const carry = ctx.lineUi.thinkingBuf;
      ctx.lineUi.thinkingBuf = '';
      printVerboseThinkingLine(ctx, carry, r);
    }
  } else if (started) {
    clearInlineLine(ctx);
    const secs = Math.max(1, Math.round((Date.now() - ctx.lineUi.thinkingStart) / 1000));
    try { r.writeLine(r.color(`∴ 已思考 ${secs}s`, 'gray')); } catch {}
  }
  ctx.lineUi.thinkingStart = 0;
  ctx.lineUi.thinkingBuf = '';
  ctx.lineUi.thinkingPrinted = false;
}

function printVerboseThinkingLine(ctx: TurnContext, line: string, r: ReturnType<typeof createOutputRenderer>) {
  void r;
  const text = String(line ?? '').replace(/\t/g, '  ');
  if (!text.trim()) return;
  clearInlineLine(ctx); // gerund 标签可能还占着当前行（清行纪律）
  const w = Math.max(20, termWidth() - 4);
  for (const chunk of wrapByWidth(text, w)) {
    try { process.stdout.write(`${ANSI_DIM}${ANSI_ITALIC}  ${chunk}${ANSI_RESET}\n`); } catch {}
    ctx.lineUi.thinkingPrinted = true;
  }
}

export function renderSseEvent(ctx: TurnContext, event: string, data: any, r: ReturnType<typeof createOutputRenderer>) {
  switch (event) {
    case 'thinking.start':
      // 新思考段 — 记起点（首个 thinking.delta 也兜底记）；
      // 上一段若还有正文流式未收尾，先补换行
      endMessageStream(ctx);
      ctx.lineUi.thinkingStart = Date.now();
      ctx.lineUi.thinkingBuf = '';
      ctx.lineUi.thinkingPrinted = false;
      return;
    case 'thinking.delta': {
      // 接住思考增量（旧 line 模式直接忽略）
      const text = String(data.text || '');
      if (!text) return;
      if (!ctx.lineUi.thinkingStart) ctx.lineUi.thinkingStart = Date.now();
      if (ctx.lineUi.verbose) {
        // 全文多行 — 按完整行宽度折行 + 2 空格缩进（增量按行 flush）
        ctx.lineUi.thinkingBuf += text;
        let nl: number;
        while ((nl = ctx.lineUi.thinkingBuf.indexOf('\n')) !== -1) {
          const ready = ctx.lineUi.thinkingBuf.slice(0, nl);
          ctx.lineUi.thinkingBuf = ctx.lineUi.thinkingBuf.slice(nl + 1);
          printVerboseThinkingLine(ctx, ready, r);
        }
        return;
      }
      // 默认：单行滚动 — 取最新一行，dim 斜体 ∴ 前缀，截到终端宽度-4
      ctx.lineUi.thinkingBuf += text;
      const parts = ctx.lineUi.thinkingBuf.split('\n');
      let last = '';
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].trim()) { last = parts[i]; break; }
      }
      if (!last) return;
      clearInlineLine(ctx);
      const shown = truncateByWidth(last.replace(/\t/g, '  '), Math.max(10, termWidth() - 4));
      try { process.stdout.write(`${ANSI_DIM}${ANSI_ITALIC}∴ ${shown}${ANSI_RESET}`); } catch {}
      ctx.lineUi.inlineLine = 'thinking';
      return;
    }
    case 'message.start':
      // thinking 结束（收到 message.start → 折叠为灰字统计）
      endThinkingBlock(ctx, r);
      return;
    case 'message.delta': {
      // 正文流式（0.8 UI 对齐 U2）：增量先入行缓冲，按完整段（`\n` 或 `。` 收尾）
      // 冲刷——段内做行内 markdown 转换（**粗体** / `行内码`），行级粒度写 stdout。
      // 未满一段的残段留缓冲（段结束/流结束由 endMessageStream 冲刷兜底）；
      // gerund 重绘在 messageStreaming 期间暂停（paint 回调里检查）。
      const text = String(data.text || '');
      if (!text) return;
      ctx.lineUi.messageStreaming = true;
      ctx.lineUi.streamedAnswerChars += text.length;
      const { ready, rest } = flushBufferedMarkdown(ctx.lineUi.messageBuf + text);
      ctx.lineUi.messageBuf = rest;
      if (ready) {
        clearInlineLine(ctx);
        try { process.stdout.write(ready); } catch {}
      }
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
      endThinkingBlock(ctx, r);
      endMessageStream(ctx);
      const n = Number(data.stepNumber);
      if (Number.isFinite(n) && n > 0) ctx.lineUi.stepCount = n; // 步数（Chaser 末尾 lastStep = 总步数）
      // F3（0.8.1 第 2 轮）：thinking/plan/toolCalls/正文全空的 step 不渲染
      // `[Step N]` 头行——空内容仍打头是 chat 直答 `[Step 1]` 噪声源，loop 空
      // 步同样净化；任一字段非空才渲染（loop 路径回归不受影响）。
      const hasStepContent = !!(String(data.thinking || '').trim() || String(data.plan || '').trim()
        || (Array.isArray(data.toolCalls) && data.toolCalls.length > 0)
        || String(data.result ?? '').trim());
      if (hasStepContent) {
        // 0.8.1 UX：正文呈现前先折叠疑似未解析调用块（改进 2），再做轻量
        // markdown 转换（改进 3）。只改显示——落盘 step 原文不受影响。
        const body = renderInlineMarkdown(
          collapseUnparsedCallBlock(String(data.thinking || data.plan || ''))
        );
        const msg = `[Step ${data.stepNumber}] ${body}`;
        r.writeLine(r.color(msg, 'white'));
      }
      // 旧的 step.toolCalls 一行渲染已删除（被实时工具卡片取代）；
      // step 只剩 thinking 汇总；verificationResult 维持现有渲染（无单独渲染）。
      break;
    }
    case 'tools/pre-execute': {
      // 工具实时卡片头行 `▸ <工具名青色> <参数摘要>`
      endMessageStream(ctx); // 模型正文若刚流式完，先补换行再出卡片
      const tool = String(data.tool || 'tool');
      const params = (data.params && typeof data.params === 'object') ? data.params : {};
      const summary = summarizeToolParams(tool, params);
      ctx.lineUi.toolStack.push({ tool, params });
      ctx.lineUi.pendingTool = { tool, summary, doing: doingVerb(tool), at: Date.now() };
      clearInlineLine(ctx);
      r.writeLine(`${ANSI_DIM}▸${ANSI_RESET} ${r.color(tool, 'cyan')} ${r.color(summary, 'gray')}`);
      break;
    }
    case 'tools/post-execute': {
      // 结果行 `  ⎿ <动词句>`（从最近工具栈取回 pre 参数）
      let preParams: any = null;
      for (let i = ctx.lineUi.toolStack.length - 1; i >= 0; i--) {
        if (ctx.lineUi.toolStack[i].tool === String(data.tool || '')) {
          preParams = ctx.lineUi.toolStack.splice(i, 1)[0].params;
          break;
        }
      }
      if (preParams === null && ctx.lineUi.toolStack.length > 0) preParams = ctx.lineUi.toolStack.pop()!.params;
      ctx.lineUi.pendingTool = null;
      clearInlineLine(ctx);
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
        endThinkingBlock(ctx, r);
        endMessageStream(ctx);
        // 结束总结块 — `✓ 已通过验证 · N 步 · Xs · ~Yk tokens · 预算 Z%`
        // + 第二行灰字「下一步」按 stopReason 分支。[最终预算] 并入总结行。
        const sr = String(data.stopReason || '');
        const elapsedMs = ctx.lineUi.taskStartedAt ? Date.now() - ctx.lineUi.taskStartedAt : 0;
        const stateText = sr === 'completed' ? '✓ 已通过验证'
          : sr === 'answered' ? '✓ 已回复'
          : sr === 'aborted' ? '↩ 已中断'
          : sr === 'error' ? '✗ 任务执行失败'
          : data.success === true ? '✓ 已通过验证' : '✗ 未通过验证';
        const parts: string[] = [stateText];
        // F4（0.8.1 第 2 轮）：chat 轮（answered）不显示步数——`✓ 已回复 · 2.6s`；
        // loop 轮保持 `✓ 已通过验证 · N 步 · Xs`。
        if (sr !== 'answered' && ctx.lineUi.stepCount > 0) parts.push(`${ctx.lineUi.stepCount} 步`);
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
        recordOutput(ctx, summaryLine);
      }
      break;
    case 'done':
      if (data.durationMs) {
        // "Cooked for" style tail note (CC-inspired)
        const t = `⏱ 用时 ${(data.durationMs / 1000).toFixed(1)}s`;
        r.writeLine(r.color(t, 'gray'));
        recordOutput(ctx, t);
      }
      break;
    case 'error':
      r.error(data.message || JSON.stringify(data));
      break;
    default: {
      // 自递归守卫（真机 18 步会话实测栈溢出）：data.type === event 时
      // 用相同参数重入会无限递归。未知事件直接截断 dump，不重入。
      const nextType = data && typeof data === 'object' ? data.type : undefined;
      if (nextType && nextType !== event) {
        renderSseEvent(ctx, String(nextType), data, r);
      } else {
        const dump = JSON.stringify(data ?? null) ?? 'null';
        r.writeLine(dump.length > 200 ? dump.slice(0, 200) + '…' : dump);
      }
    }
  }
}
