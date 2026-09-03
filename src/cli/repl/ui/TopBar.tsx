// src/cli/repl/ui/TopBar.tsx
// Top status bar for ink UI (UX polished).
// Shows tier (colored), model, workspace, phase, and a compact budget progress bar.
// Fixed height, high contrast, no layout shift.

function makeBudgetBar(ratio: number, width = 10): string {
  const pct = Math.max(0, Math.min(100, Math.floor((ratio || 0) * 100)));
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + `] ${pct}%`;
}

export function TopBar(props: {
  tier: string;
  model: string;
  workspace: string;
  budgetRatio: number;
  ctxRatio?: number;
  phase?: string;
  running?: boolean;
  modeBadge?: string;
}) {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__ZORGE_INK__ || {};
  const { Box, Text } = ink;

  const { tier, model, workspace, budgetRatio, ctxRatio, phase, running, modeBadge } = props;
  const pct = Math.max(0, Math.min(100, Math.floor((budgetRatio || 0) * 100)));
  const budgetColor = pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green';

  // P0.3 + M2.3: context meter — "N% context used"; past the 70% warning line
  // it flips to a CC-style countdown "N% until auto-compact" (auto at 85%).
  const ctxPct = ctxRatio != null
    ? Math.max(0, Math.min(100, Math.floor(ctxRatio * 100)))
    : null;
  const ctxColor = (ctxPct ?? 0) >= 85 ? 'red' : (ctxPct ?? 0) > 70 ? 'yellow' : 'gray';
  const ctxLabel = ctxPct != null
    ? (ctxPct >= 70 ? `⏳ ${100 - ctxPct}% until auto-compact` : `${ctxPct}% context used`)
    : '';

  const shortWs = (workspace || '').replace((process.env && process.env.HOME) || '', '~').slice(-26);
  const phaseLabel = phase ? phase.toUpperCase() : '';
  const status = running ? 'RUN' : (phaseLabel || '');

  const bar = makeBudgetBar(budgetRatio, 8);

  if (Box && Text) {
    const badgeNode = modeBadge
      ? R.createElement(Text, { color: modeBadge === 'PLAN' ? 'magenta' : 'blue', bold: true }, ` [${modeBadge}]`)
      : null;
    return R.createElement(
      Box,
      { borderStyle: 'single', paddingX: 1, marginBottom: 0 },
      R.createElement(Text, { color: 'cyan', bold: true }, tier.toUpperCase()),
      badgeNode,
      R.createElement(Text, { color: 'gray' }, ' | '),
      R.createElement(Text, {}, model || 'default'),
      R.createElement(Text, { color: 'gray' }, ' | '),
      R.createElement(Text, { dimColor: true }, shortWs),
      R.createElement(Text, { color: 'gray' }, ' | '),
      R.createElement(Text, { color: budgetColor }, bar),
      ctxLabel ? R.createElement(Text, { color: 'gray' }, ' | ') : null,
      ctxLabel ? R.createElement(Text, { color: ctxColor }, ctxLabel) : null,
      status ? R.createElement(Text, { color: 'gray' }, ' | ') : null,
      status ? R.createElement(Text, { color: running ? 'yellow' : 'cyan' }, status) : null
    );
  }

  return `[${tier.toUpperCase()}]${modeBadge ? '[' + modeBadge + ']' : ''} ${model} ${shortWs} ${bar}${ctxLabel ? ' | ' + ctxLabel : ''} ${status ? '| ' + status : ''}`;
}
