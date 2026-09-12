// tests/repl/turn/SlashMenu.test.ts
// SlashMenu 纯函数测试：过滤/分组/滚动窗口/状态机/渲染组装
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRows,
  buildSlashMenuItems,
  filterCommands,
  initialMenuState,
  menuShapeForLine,
  moveSelection,
  renderSlashMenu,
  scrollRows,
  syncMenuState,
} from '../../../src/cli/repl/turn/SlashMenu.js';

const ITEMS = [
  { name: 'help', description: '显示帮助信息', category: 'general' },
  { name: 'model', description: '切换模型', category: 'general' },
  { name: 'approvals', description: '审批档位', category: 'general' },
  { name: 'memory', description: '记忆卡管理', category: 'memory' },
  { name: 'compact', description: '压缩上下文', category: 'memory' },
  { name: 'mcp-list', description: 'MCP 工具列表', category: 'mcp' },
];

describe('SlashMenu filterCommands', () => {
  it('空查询 = 全量（浏览模式，保持原序）', () => {
    assert.deepEqual(filterCommands(ITEMS, '').map((x) => x.name), ITEMS.map((x) => x.name));
  });

  it('前缀精确优先（model 命中且排前）', () => {
    const out = filterCommands(ITEMS, 'mo');
    assert.equal(out[0].name, 'model');
  });

  it('别名参与前缀匹配', () => {
    const withAlias = [{ name: 'approvals', aliases: ['mode'], description: 'x', category: 'g' }];
    assert.equal(filterCommands(withAlias as any, 'mode')[0].name, 'approvals');
  });

  it('无匹配 → 空列表', () => {
    assert.deepEqual(filterCommands(ITEMS, 'zzzz'), []);
  });
});

describe('SlashMenu buildRows 分组', () => {
  it('category 变化处插组名行（组名不计入 itemIndex 序列）', () => {
    const rows = buildRows(ITEMS.slice(0, 4));
    const groups = rows.filter((r) => r.kind === 'group');
    assert.equal(groups.length >= 1, true, '至少一个组名行');
    const items = rows.filter((r) => r.kind === 'item');
    assert.equal(items.length, 4);
    // itemIndex 是**过滤后条目**的下标（0..n-1 连续）
    assert.deepEqual(items.map((r) => (r as any).itemIndex), [0, 1, 2, 3]);
  });
});

describe('SlashMenu scrollRows 滚动窗口', () => {
  it('总数 ≤ 视口：全显从 0 开始', () => {
    assert.deepEqual(scrollRows(5, 4, 8), { start: 0, count: 5 });
  });

  it('超出时窗口滑动，选中行保持在视口内', () => {
    const v = scrollRows(20, 10, 8);
    assert.ok(v.start <= 10 && v.start + v.count >= 10 + 1, '选中行必须可见');
    assert.equal(v.count, 8);
  });

  it('选中在末尾时窗口钳到 maxStart', () => {
    const v = scrollRows(20, 19, 8);
    assert.equal(v.start, 12);
  });
});

describe('SlashMenu 状态机', () => {
  it('menuShapeForLine：/ 开头且命令段无空白才开', () => {
    assert.equal(menuShapeForLine('/mod', false).open, true);
    assert.equal(menuShapeForLine('/mod arg', false).open, false, '进入参数段即关');
    assert.equal(menuShapeForLine('你好', false).open, false);
    assert.equal(menuShapeForLine('/mod', true).open, false, 'blocked（运行中）不开');
  });

  it('syncMenuState：query 变化选中归零；缩水时钳位', () => {
    const s0 = initialMenuState();
    const s1 = syncMenuState(s0, '/m', false, () => 3);
    assert.equal(s1.open, true);
    const s2 = syncMenuState(s1, '/mo', false, () => 2);
    assert.ok(s2.selected <= 1, '过滤缩水后选中钳位');
  });

  it('moveSelection：边界循环回绕；空列表不动', () => {
    const s = { open: true, query: 'm', selected: 0 };
    const down = moveSelection(s, 3, 1);
    assert.equal(down.selected, 1);
    const wrapped = moveSelection({ ...s, selected: 2 }, 3, 1);
    assert.equal(wrapped.selected, 0, '末尾向下回绕到 0');
    assert.deepEqual(moveSelection(s, 0, 1), s, '空列表不动');
  });
});

describe('SlashMenu renderSlashMenu 渲染组装', () => {
  const items = filterCommands(ITEMS, '');
  const rows = buildRows(items);

  it('恒返回 maxVisible+1 行（视口 + footer）', () => {
    const lines = renderSlashMenu({ rows, selectedRow: 1, totalItems: items.length, maxVisible: 8 });
    assert.equal(lines.length, 8 + 1);
  });

  it('溢出 footer 提示还有 N 条', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`,
      description: `d${i}`,
      category: 'g',
    }));
    const rows20 = buildRows(many);
    const lines = renderSlashMenu({ rows: rows20, selectedRow: 0, totalItems: many.length, maxVisible: 8 });
    assert.ok(lines[lines.length - 1].includes('还有'), '溢出提示 footer');
  });

  it('选中行包含反显标记（ANSI 7）', () => {
    const lines = renderSlashMenu({ rows: buildRows(ITEMS), selectedRow: 1, totalItems: ITEMS.length, maxVisible: 8 });
    const sel = lines.find((l) => l.includes('\x1b[7m'));
    assert.ok(sel, '选中行应有反显标记');
  });
});
