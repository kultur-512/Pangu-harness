// src/cli/repl/turn/SlashMenu.ts
// CC 式斜杠即时菜单（line 模式）：idle 态输入 `/` 即在提示符上方弹出可视化
// 命令菜单 —— 实时过滤 + ↑↓ 循环导航 + category 分组 + 滚动视口（选中项保持
// 在视口内）+ Enter 直接执行选中命令 + Esc 关闭。
//
// 分层纪律：
//  - 过滤/排序/滚动窗口/分组组装/渲染组装全部是纯函数（可单测）；
//  - 渲染组装只返回 string[]（固定 maxVisible+1 行，不足补空行），由调用方
//    writeLine/write 落终端 —— 菜单行数固定避免清块残留；
//  - createSlashMenuController 把纯函数接成状态机，IO 全部依赖注入
//    （write/refreshLine/execute/currentLine），本模块不出现 readline；
//  - 接线（sseInteractive）：包一层 rl._ttyWrite —— 仅当菜单激活且按键属于
//    {up, down, return/enter, escape} 时消费（up/down 不再触发 readline 历史
//    导航），其余按键原样透传；菜单关闭后 readline 默认行为原样恢复。
//  - 与 pendingSuggestion 的关系：菜单激活（Enter 被菜单消费）时待定建议流程
//    让位 —— execute 回调由宿主负责清 ctx.pendingSuggestion；菜单关闭自动恢复。
//  - 清行纪律：菜单块画在提示符上方，重画/关闭时先 `\r\x1b[K` 清提示符行
//    （readline 稍后 _refreshLine 重画）再 `\x1b[A\x1b[K` 逐行上溯清旧块 ——
//    与 gerund/thinking 的活行管理同源（不经 clearInlineLine，因其只管单行）。

import { fuzzyFilter } from '../FuzzyMatcher.js';
import { truncateByWidth } from './TurnRenderer.js';

// ==================== ANSI（模块局部，避免扩散依赖） ====================

const DIM = '\x1b[2m';
const DIM_OFF = '\x1b[22m';
const CYAN = '\x1b[36m';
const FG_OFF = '\x1b[39m';
const REVERSE = '\x1b[7m';
const REVERSE_OFF = '\x1b[27m';

// ==================== 数据形状 ====================

/** 菜单条目（name 不含 `/` 前缀）。 */
export interface SlashMenuItem {
  name: string;
  description: string;
  category: string;
  aliases?: string[];
}

/** 菜单行：组名小标题（dim，不计入导航）或命令条目（itemIndex = 过滤后下标）。 */
export type MenuRow =
  | { kind: 'group'; label: string }
  | { kind: 'item'; item: SlashMenuItem; itemIndex: number };

/** 滚动视口：rows[start, start+count)。 */
export interface MenuViewport {
  start: number;
  count: number;
}

// ==================== 纯函数：数据组装 ====================

/**
 * LINE_COMMANDS（常用度序）× registry 元数据（description/category）→ 菜单条目。
 * 只收录 order 里点名的命令（line 模式实际支持的命令面），registry 独有命令
 * （/run /serve 等经典模式命令）不进菜单；缺元数据的命令（如 /verbose，只在
 * 派发器内联处理）落空 description + 'other' 组。
 */
export function buildSlashMenuItems(
  order: ReadonlyArray<{ name: string; aliases?: string[] }>,
  commands: ReadonlyArray<{ name: string; aliases?: string[]; description: string; category: string }>,
): SlashMenuItem[] {
  const byName = new Map<string, { name: string; aliases?: string[]; description: string; category: string }>();
  for (const c of commands) byName.set(String(c.name).toLowerCase(), c);
  const out: SlashMenuItem[] = [];
  const seen = new Set<string>();
  for (const entry of order) {
    const key = String(entry.name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const meta = byName.get(key);
    out.push({
      name: entry.name,
      aliases: entry.aliases ? [...entry.aliases] : undefined,
      description: String(meta?.description ?? ''),
      category: String(meta?.category ?? 'other'),
    });
  }
  return out;
}

/**
 * 过滤 + 排序（对齐 completeLineCommand 的排序纪律，数据源换成带描述的
 * SlashMenuItem）：前缀精确（含别名前缀）优先保持常用度序 → 无精确命中时
 * 模糊兜底（FuzzyMatcher：子串 > 子序列，别名/描述弱信号计分）→ 无匹配空列表。
 */
export function filterCommands(items: ReadonlyArray<SlashMenuItem>, query: string): SlashMenuItem[] {
  const q = String(query ?? '').toLowerCase().trim();
  const list = items.slice();
  if (!q) return list; // 空查询 = 全量（常用度序，浏览模式）
  const exact = list.filter(
    (c) => c.name.toLowerCase().startsWith(q) || (c.aliases ?? []).some((a) => String(a).toLowerCase().startsWith(q))
  );
  if (exact.length > 0) return exact;
  const fuzzy = fuzzyFilter(q, list.map((c) => ({ name: c.name, aliases: c.aliases, description: c.description })));
  const byName = new Map(list.map((c) => [c.name, c] as const));
  return fuzzy.map((f) => byName.get(f.name)).filter((x): x is SlashMenuItem => !!x);
}

/** 分组组装：category 变化处插组名行（顺序 = 条目首次出现序）；组名行不计入导航。 */
export function buildRows(items: ReadonlyArray<SlashMenuItem>): MenuRow[] {
  const rows: MenuRow[] = [];
  let lastCat: string | null = null;
  items.forEach((item, i) => {
    if (item.category !== lastCat) {
      rows.push({ kind: 'group', label: item.category });
      lastCat = item.category;
    }
    rows.push({ kind: 'item', item, itemIndex: i });
  });
  return rows;
}

/**
 * 滚动窗口（纯计算，无记忆）：rowCount ≤ maxVisible 全显；超出时窗口滑动，
 * 选中行保持在视口内（以选中行为窗口末端锚定，边界钳到 [0, rowCount-maxVisible]）。
 */
export function scrollRows(rowCount: number, selectedRow: number, maxVisible: number): MenuViewport {
  const total = Math.max(0, Math.floor(rowCount));
  const visible = Math.max(1, Math.floor(maxVisible));
  if (total <= visible) return { start: 0, count: total };
  const maxStart = total - visible;
  let start = Math.floor(selectedRow) - visible + 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (start > maxStart) start = maxStart;
  return { start, count: visible };
}

// ==================== 纯函数：状态机 ====================

/** 菜单状态（open/query/selected 全部可由输入行推导）。 */
export interface SlashMenuState {
  open: boolean;
  query: string;
  selected: number;
}

/** 视口内最多显示的条目行数（+1 行 footer，块高固定 maxVisible+1）。 */
export const MENU_MAX_VISIBLE = 8;

export function initialMenuState(): SlashMenuState {
  return { open: false, query: '', selected: 0 };
}

/**
 * 输入行 → 菜单开合形状（focus 边界在这里）：`/` 开头且命令名段无空白 → 开
 * （query = `/` 后文本，`/` 单独输入 = 空查询全量浏览）；无 `/` 前缀、命令名
 * 已敲完进入参数段（空白）或 blocked（任务运行中/审批挂起）→ 关。
 */
export function menuShapeForLine(line: string, blocked: boolean): { open: boolean; query: string } {
  const raw = String(line ?? '');
  if (blocked || !raw.startsWith('/')) return { open: false, query: '' };
  const rest = raw.slice(1);
  if (/\s/.test(rest)) return { open: false, query: '' };
  return { open: true, query: rest };
}

/**
 * 输入行变化 → 下一状态：query 变化（或刚打开）选中归零；过滤数缩水时钳位；
 * blocked/无前缀 → 关闭。countForQuery 注入过滤后的条数（保持纯函数可测）。
 */
export function syncMenuState(
  prev: SlashMenuState,
  line: string,
  blocked: boolean,
  countForQuery: (query: string) => number,
): SlashMenuState {
  const shape = menuShapeForLine(line, blocked);
  if (!shape.open) return initialMenuState();
  const n = Math.max(0, countForQuery(shape.query) | 0);
  const queryChanged = shape.query !== prev.query;
  let selected = queryChanged || !prev.open ? 0 : Math.floor(prev.selected);
  if (!Number.isFinite(selected) || selected < 0) selected = 0;
  selected = n > 0 ? Math.min(selected, n - 1) : 0;
  return { open: true, query: shape.query, selected };
}

/** ↑↓ 导航（纯）：边界循环回绕；空列表不动。 */
export function moveSelection(state: SlashMenuState, filteredCount: number, delta: number): SlashMenuState {
  const n = Math.max(0, Math.floor(filteredCount));
  if (n === 0) return state;
  const cur = Math.min(Math.max(0, Math.floor(state.selected)), n - 1);
  const next = ((cur + Math.sign(delta || 0)) % n + n) % n;
  return { ...state, selected: next };
}

// ==================== 纯函数：渲染组装（返回 string[]，调用方 writeLine） ====================

export interface RenderSlashMenuOptions {
  rows: ReadonlyArray<MenuRow>;
  /** 选中条目在 rows 中的行下标（buildRows 输出里 itemIndex === selected 的行）；-1 = 无选中。 */
  selectedRow: number;
  /** 过滤后总条数（footer 的 `… 还有 N 条` 依据）。 */
  totalItems: number;
  maxVisible?: number;
  width?: number;
}

/**
 * 渲染组装（无 IO）：恒返回 maxVisible+1 行 —— 视口行（组名 dim 小标题 /
 * 条目 `/name  description`，name 青色、description dim，选中行反显）不足补
 * 空行 + 恒 1 行 footer（溢出 `… 还有 N 条` / 无匹配提示 / 快捷键提示）。
 */
export function renderSlashMenu(opts: RenderSlashMenuOptions): string[] {
  const maxVisible = Math.max(1, Math.floor(opts.maxVisible ?? MENU_MAX_VISIBLE));
  const width = Math.max(20, Math.floor(opts.width ?? 80));
  const rows = opts.rows ?? [];
  const total = Math.max(0, Math.floor(opts.totalItems ?? 0));
  const selectedRow = Math.floor(opts.selectedRow ?? -1);

  const vp = scrollRows(rows.length, selectedRow, maxVisible);
  const lines: string[] = [];
  let visibleItems = 0;
  for (let i = 0; i < vp.count; i++) {
    const row = rows[vp.start + i];
    if (!row) {
      lines.push('');
      continue;
    }
    const absRow = vp.start + i;
    if (row.kind === 'group') {
      lines.push(`${DIM}  ${truncateByWidth(row.label, Math.max(4, width - 4))}${DIM_OFF}`);
      continue;
    }
    visibleItems++;
    const name = `/${row.item.name}`;
    const desc = row.item.description
      ? truncateByWidth(row.item.description, Math.max(8, width - name.length - 8))
      : '';
    if (absRow === selectedRow) {
      // 高亮反显（整行统一反色，块状选中条）
      lines.push(`${REVERSE}  ${name}${desc ? '  ' + desc : ''}${REVERSE_OFF}`);
    } else {
      lines.push(`  ${CYAN}${name}${FG_OFF}  ${DIM}${desc}${DIM_OFF}`);
    }
  }
  while (lines.length < maxVisible) lines.push('');

  const hidden = total - visibleItems;
  let footer: string;
  if (total <= 0) footer = `${DIM}  （无匹配命令）${DIM_OFF}`;
  else if (hidden > 0) footer = `${DIM}  … 还有 ${hidden} 条${DIM_OFF}`;
  else footer = `${DIM}  ↑↓ 选择 · Enter 执行 · Esc 关闭${DIM_OFF}`;
  lines.push(footer);
  return lines;
}

// ==================== 控制器（纯函数接线，IO 注入） ====================

export interface SlashMenuDeps {
  /** 菜单数据源（LINE_COMMANDS × registry；宿主懒加载一次）。 */
  getItems: () => Promise<SlashMenuItem[]>;
  /** focus 边界：任务运行中 / 审批挂起 → 菜单不激活。 */
  isBlocked: () => boolean;
  /** 终端写（清块 + 菜单块都走这里）。 */
  write: (s: string) => void;
  /** 提示符行恢复（readline _refreshLine 由宿主注入）。 */
  refreshLine: () => void;
  /** Enter 执行选中命令（宿主走 handleLocalCommand/派发器等价路径，不重新输入）。 */
  execute: (cmd: string) => void | Promise<void>;
  /** 当前 readline 输入行（Esc 压制与数据装载后的重同步用；可缺省）。 */
  currentLine?: () => string;
  width?: () => number;
  maxVisible?: number;
}

export interface SlashMenuController {
  /**
   * keypress 拦截入口（宿主在 rl._ttyWrite 包装层调用）：
   * 返回 true = 菜单激活且该键被 UI 消费（up/down/return/enter/escape；
   * ctrl+c 先清块再放行 SIGINT；shift+tab 菜单内忽略），宿主不得再喂 readline。
   */
  handleKey(key: any): boolean;
  /** 输入行变化钩子：重过滤/开合/重绘（未变化的键按下后调用为 no-op）。 */
  syncLine(line: string): void;
  /** 强制关闭（清块 + 复位）。 */
  close(): void;
  isOpen(): boolean;
  getState(): SlashMenuState;
  getDrawnHeight(): number;
}

export function createSlashMenuController(deps: SlashMenuDeps): SlashMenuController {
  const maxVisible = Math.max(1, Math.floor(deps.maxVisible ?? MENU_MAX_VISIBLE));
  let state: SlashMenuState = initialMenuState();
  let items: SlashMenuItem[] | null = null;
  let itemsLoading = false;
  let drawnHeight = 0;
  let executing = false;
  /** Esc 压制：Esc 关闭后同一行内容不自动重开（输入一变即恢复）。 */
  let suppressLine: string | null = null;

  const filteredFor = (query: string): SlashMenuItem[] => filterCommands(items ?? [], query);

  function ensureItems(): boolean {
    if (items) return true;
    if (!itemsLoading) {
      itemsLoading = true;
      Promise.resolve()
        .then(deps.getItems)
        .then((list) => {
          items = Array.isArray(list) ? list : [];
        })
        .catch(() => {
          items = [];
        })
        .then(() => {
          itemsLoading = false;
          // 数据装载完成后的重同步：首键即出菜单（无需再敲一键）
          if (!executing && deps.currentLine) syncLine(deps.currentLine());
        });
    }
    return false;
  }

  /** 清块：提示符行 `\r\x1b[K` + 逐行上溯 `\x1b[A\x1b[K`；再让 readline 重画提示符行。 */
  function clearBlock(): void {
    if (drawnHeight <= 0) return;
    deps.write('\r\x1b[K');
    for (let i = 0; i < drawnHeight; i++) deps.write('\x1b[A\x1b[K');
    drawnHeight = 0;
    deps.refreshLine();
  }

  function draw(): void {
    const f = filteredFor(state.query);
    const rows = buildRows(f);
    const selectedRow = rows.findIndex((r) => r.kind === 'item' && r.itemIndex === state.selected);
    const width = Math.max(20, Math.floor(deps.width?.() ?? 80));
    const lines = renderSlashMenu({ rows, selectedRow, totalItems: f.length, maxVisible, width });
    // 先清提示符行（readline 稍后整体重画）与旧块，再画固定高度新块
    deps.write('\r\x1b[K');
    for (let i = 0; i < drawnHeight; i++) deps.write('\x1b[A\x1b[K');
    deps.write(lines.join('\n') + '\n');
    drawnHeight = lines.length;
    deps.refreshLine();
  }

  function close(): void {
    state = initialMenuState();
    clearBlock();
  }

  function syncLine(line: string): void {
    if (executing) return;
    const raw = String(line ?? '');
    const shape = menuShapeForLine(raw, deps.isBlocked());
    if (!shape.open) {
      suppressLine = null;
      if (state.open || drawnHeight > 0) close();
      return;
    }
    if (!state.open) {
      if (suppressLine !== null && suppressLine === raw) return; // Esc 压制窗口
      if (!items) {
        if (!ensureItems()) return; // 首次装载中，装载完成后重同步
      }
      suppressLine = null;
    }
    const prev = state;
    const next = syncMenuState(prev, raw, deps.isBlocked(), (q) => filteredFor(q).length);
    const changed = next.open !== prev.open || next.query !== prev.query || next.selected !== prev.selected;
    state = next;
    if (changed || drawnHeight === 0) draw();
  }

  function handleKey(key: any): boolean {
    if (!key || executing || !state.open) return false;
    if (deps.isBlocked()) {
      close();
      return false;
    }
    const name = String(key.name || '');
    if (name === 'up' || name === 'down') {
      const n = filteredFor(state.query).length;
      if (n > 0) {
        state = moveSelection(state, n, name === 'up' ? -1 : 1);
        draw();
      }
      return true; // up/down 被 UI 消费：不触发 readline 历史导航
    }
    if (name === 'return' || name === 'enter') {
      const f = filteredFor(state.query);
      const sel = f[Math.min(Math.max(0, state.selected), Math.max(0, f.length - 1))];
      if (!sel) return true; // 空列表：吞掉回车，不提交
      executing = true;
      suppressLine = null;
      close();
      const cmd = '/' + sel.name;
      try {
        Promise.resolve(deps.execute(cmd))
          .catch(() => {})
          .finally(() => {
            executing = false;
          });
      } catch {
        executing = false;
      }
      return true;
    }
    if (name === 'escape') {
      suppressLine = deps.currentLine ? deps.currentLine() : null;
      close();
      return true;
    }
    if (name === 'c' && key.ctrl) {
      // Ctrl+C：先清菜单块再放行 SIGINT 链路（提示行不与菜单残留叠画）
      close();
      return false;
    }
    if (key.shift && name === 'tab') {
      return true; // 菜单内忽略 shift+tab（模式环会让位/污染菜单块）
    }
    return false;
  }

  return {
    handleKey,
    syncLine,
    close,
    isOpen: () => state.open,
    getState: () => ({ ...state }),
    getDrawnHeight: () => drawnHeight,
  };
}
