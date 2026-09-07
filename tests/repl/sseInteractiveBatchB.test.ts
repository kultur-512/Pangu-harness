// tests/repl/sseInteractiveBatchB.test.ts
// 批次 B（0.7.1 UI 手感 P2 引导级 + P3 质感级）纯助手单测 —
// 启动横幅（宽度截断）、Tab 补全、未知命令建议、模式徽标/回执、
// phase 本地化、情境 tip 节流、宽度补齐。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pkgVersion,
  stripModelProviderPrefix,
  buildBanner,
  LINE_COMMANDS,
  completeLineCommand,
  suggestCommand,
  buildQuickHelpLines,
  modeBadgeLine,
  modeSwitchReceipt,
  localizePhase,
  localizeRolloutStatus,
  createTipGate,
  shouldShowStartupTip,
} from '../../src/cli/repl/sseInteractive.js';
import { padByWidth, stringWidth } from '../../src/cli/repl/stringWidth.js';
import { buildHelpView } from '../../src/cli/repl/commands/HelpCommand.js';

describe('P2-1 启动横幅 v2', () => {
  it('pkgVersion reads package.json (falls back to 0.7.0)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    assert.equal(pkgVersion(), String(pkg.version || '0.7.0'));
  });

  it('stripModelProviderPrefix removes `provider:` prefix only', () => {
    assert.equal(stripModelProviderPrefix('openpangu:emb-1b-i1'), 'emb-1b-i1');
    assert.equal(stripModelProviderPrefix('default'), 'default');
    assert.equal(stripModelProviderPrefix(''), '');
  });

  it('banner: 3 lines, bold head with version, meta line with model/tier/mode/cwd', () => {
    const b = buildBanner({
      model: 'openpangu:emb-1b-i1',
      tier: 'high',
      mode: 'default',
      workspace: 'C:\\ws',
      version: '0.7.0',
      width: 100,
    });
    assert.equal(b.length, 3);
    assert.equal(b[0], '烛龙 Zhulong v0.7.0');
    assert.ok(b[1].startsWith('  模型 emb-1b-i1 · 档位 high · 模式 default · C:\\ws'), b[1]);
    // 0.7.4 任务 C：`?` 改为透传模型——横幅不再宣传快捷帮助
    assert.ok(!b[2].includes('? 快捷帮助'), b[2]);
    assert.ok(b[2].includes('/help 全部命令'), b[2]);
    assert.ok(b[2].includes('Ctrl+C 中断任务/二次退出'), b[2]);
  });

  it('banner: cwd truncated by display width when terminal is narrow', () => {
    const ws = 'C:\\' + '目录'.repeat(10); // 3 + 40 = 43 列宽
    const b = buildBanner({
      model: 'm',
      tier: 'high',
      mode: 'default',
      workspace: ws,
      version: '0.7.0',
      width: 60,
    });
    assert.ok(stringWidth(b[1]) <= 60, `width=${stringWidth(b[1])}`);
    assert.ok(b[1].endsWith('…'), b[1]);
    assert.ok(b[1].includes('目录'), b[1]);
  });
});

describe('P2-2 Tab 补全 completeLineCommand', () => {
  it('exact prefix: /m → mode/model/memory in commonness order', () => {
    const [hits, bare] = completeLineCommand('/m');
    assert.deepEqual(hits, ['/mode', '/model', '/memory']);
    assert.equal(bare, '/m');
  });

  it('/he → /help; /q → /exit via alias', () => {
    assert.deepEqual(completeLineCommand('/he')[0], ['/help']);
    assert.deepEqual(completeLineCommand('/q')[0], ['/exit']);
  });

  it('fuzzy fallback: /modl ranks /mode first', () => {
    const [hits] = completeLineCommand('/modl');
    assert.ok(hits.length > 0, 'should have fuzzy hits');
    assert.equal(hits[0], '/mode');
  });

  it('non-slash input and arg-carrying lines complete nothing', () => {
    assert.deepEqual(completeLineCommand('hello'), [[], 'hello']);
    assert.deepEqual(completeLineCommand('/model gpt'), [[], '/model gpt']);
    assert.deepEqual(completeLineCommand(''), [[], '']);
  });

  it('LINE_COMMANDS covers the quick-help surface (20 primary commands)', () => {
    assert.ok(LINE_COMMANDS.length >= 20, `got ${LINE_COMMANDS.length}`);
    const names = new Set(LINE_COMMANDS.map((c) => c.name));
    for (const n of ['help', 'mode', 'model', 'memory', 'usage', 'undo', 'compact', 'resume', 'exit']) {
      assert.ok(names.has(n), `missing ${n}`);
    }
  });
});

describe('P2-2 未知命令建议 suggestCommand', () => {
  it('typo /modl → mode; /hlep → help', () => {
    assert.equal(suggestCommand('/modl'), 'mode');
    assert.equal(suggestCommand('/hlep'), 'help');
  });

  it('alias typo /exi → exit; exact match passes through', () => {
    assert.equal(suggestCommand('/exi'), 'exit');
    assert.equal(suggestCommand('/mode'), 'mode');
  });

  it('garbage / empty input → null (no hallucinated suggestion)', () => {
    assert.equal(suggestCommand('/zzzz'), null);
    assert.equal(suggestCommand(''), null);
    assert.equal(suggestCommand('/'), null);
  });
});

describe('P2-4 模式徽标行与 /mode 回执', () => {
  it('modeBadgeLine glyphs: ⏸ plan / ⏵ default / ⏵⏵ auto-accept / ⏵⏵ full', () => {
    assert.equal(modeBadgeLine('plan'), '⏸ plan · shift+tab 切换');
    assert.equal(modeBadgeLine('default'), '⏵ default · shift+tab 切换');
    assert.equal(modeBadgeLine('auto-accept'), '⏵⏵ auto-accept · shift+tab 切换');
    assert.equal(modeBadgeLine('full'), '⏵⏵ full · shift+tab 切换');
  });

  it('modeSwitchReceipt states the consequence of each mode', () => {
    assert.equal(modeSwitchReceipt('default'), '已切换: default · 写操作需确认');
    assert.ok(modeSwitchReceipt('plan').includes('只读计划模式'));
    assert.ok(modeSwitchReceipt('auto-accept').includes('写操作自动接受'));
    assert.ok(modeSwitchReceipt('full').includes('全部放行'));
  });
});

describe('P3-2 phase / rollout 状态本地化（渲染层映射）', () => {
  it('localizePhase: explore→侦察, rollout→执行, judge→评判, done→收尾, 未知透传', () => {
    assert.equal(localizePhase('explore'), '侦察');
    assert.equal(localizePhase('rollout'), '执行');
    assert.equal(localizePhase('judge'), '评判');
    assert.equal(localizePhase('done'), '收尾');
    assert.equal(localizePhase('custom-phase'), 'custom-phase');
  });

  it('localizeRolloutStatus maps the four statuses and passes through unknown', () => {
    assert.equal(localizeRolloutStatus('running'), '进行中');
    assert.equal(localizeRolloutStatus('done'), '完成');
    assert.equal(localizeRolloutStatus('failed'), '失败');
    assert.equal(localizeRolloutStatus('pending'), '等待');
    assert.equal(localizeRolloutStatus('other'), 'other');
  });
});

describe('P3-3 情境 tip 节流 createTipGate', () => {
  it('per-key one-shot + global max of 2 per session', () => {
    const gate = createTipGate(2);
    assert.ok(gate.canShow('startup'));
    gate.markShown('startup');
    assert.ok(!gate.canShow('startup'), 'same key must not repeat');
    assert.ok(gate.canShow('wait'));
    gate.markShown('wait');
    assert.ok(!gate.canShow('ctx'), 'global cap reached');
    assert.equal(gate.shownCount, 2);
    gate.markShown('ctx'); // idempotent-ish: cap already reached, count unchanged
    assert.equal(gate.shownCount, 2);
  });

  it('default max is 2 and keys are independent', () => {
    const gate = createTipGate();
    gate.markShown('a');
    gate.markShown('b');
    assert.equal(gate.shownCount, 2);
    assert.ok(!gate.canShow('c'));
  });

  it('shouldShowStartupTip: fresh session + coin flip only', () => {
    assert.equal(shouldShowStartupTip(0, false, 0.3), true);
    assert.equal(shouldShowStartupTip(0, false, 0.7), false, 'coin missed (50%)');
    assert.equal(shouldShowStartupTip(2, false, 0.3), false, 'already has turns');
    assert.equal(shouldShowStartupTip(0, true, 0.3), false, 'resumed session');
  });
});

describe('P2-2 buildQuickHelpLines（0.7.4 起仅供 /help 复用，? 不再截获）+ P3-1 宽度补齐', () => {
  it('buildQuickHelpLines: 8+ entries and a dim tail pointing at /help with the total', () => {
    const ql = buildQuickHelpLines(26);
    assert.ok(ql.length >= 10, `entries=${ql.length}`);
    assert.equal(ql[0], '快捷帮助');
    for (const cmd of ['/mode', '/model', '/memory', '/usage', '/undo', '/compact', '/resume', '/exit']) {
      assert.ok(ql.some((l) => l.includes(cmd)), `missing ${cmd}`);
    }
    assert.equal(ql[ql.length - 1], '/help 查看全部 26 条命令');
  });

  it('padByWidth pads to display width, CJK aware, never shrinks', () => {
    assert.equal(padByWidth('ab', 4), 'ab  ');
    assert.equal(padByWidth('你好', 6), '你好  ');
    assert.equal(padByWidth('你好', 3), '你好', 'over-width stays untouched');
    assert.equal(padByWidth('', 2), '  ');
    assert.equal(stringWidth(padByWidth('/mode', 10)), 10);
  });
});

describe('P2-3 buildHelpView（三处 /help 共用的分组视图）', () => {
  const cmds = [
    { name: 'help', aliases: ['?', 'h'], description: '显示帮助信息', category: 'system', usage: '/help [command]' },
    { name: 'exit', description: '退出', category: 'system' },
    { name: 'undo', description: '回退最近写盘', category: 'session' },
  ];

  it('groups by category with bold header and cyan category rows', () => {
    const view = buildHelpView(cmds as any);
    assert.equal(view.lines[0].text, '可用命令:');
    assert.equal(view.lines[0].style, 'bold');
    assert.ok(view.lines.some((l) => l.text === '[system]' && l.style === 'cyan'));
    assert.ok(view.lines.some((l) => l.text === '[session]'));
    assert.ok(view.lines.some((l) => l.text.startsWith('  /help') && l.text.includes('显示帮助信息')));
    assert.equal(view.lines[view.lines.length - 1].text, '输入 /help <命令> 查看详细用法');
  });

  it('/help <name> detail view and not-found message', () => {
    const ok = buildHelpView(cmds as any, ['undo']);
    assert.equal(ok.lines[0].text, '/undo');
    assert.ok(ok.lines.some((l) => l.text === '回退最近写盘'));
    const byAlias = buildHelpView(cmds as any, ['?']);
    assert.ok(byAlias.lines[0].text.startsWith('/help'), byAlias.lines[0].text);
    const miss = buildHelpView(cmds as any, ['nope']);
    assert.equal(miss.message, '未找到命令: nope');
  });
});
