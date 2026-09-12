#!/usr/bin/env node
// scripts/eval/overnight-report.mjs
// 汇总 overnight-0913/ 下的真机样本 → 记忆开/关对比报告（Markdown + SVG 曲线）。
// 用法：node scripts/eval/overnight-report.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'scripts', 'eval', 'results', 'overnight-0913');

async function main() {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
  /** @type {Array<{task:string,tier:string,round:string,verdict:string,stop:string,dur:number,inj:number,ver:number}>} */
  const rows = [];
  for (const f of files) {
    const m = f.match(/^(T\d)-(A|B)(?:-bizseed)?(?:-r(\d+))?\.json$/);
    if (!m) continue;
    try {
      const d = JSON.parse(await readFile(join(DIR, f), 'utf8'));
      const r = Array.isArray(d.results) ? d.results[0] : d;
      rows.push({
        task: m[1], tier: m[2], round: m[3] || '1',
        bizseed: f.includes('-bizseed-'),
        verdict: r.verdict, stop: r.stopReason,
        dur: r.durationMs ?? 0,
        inj: (r.memory?.injectedCardIds ?? []).length,
        ver: (r.memory?.verifiedCardIds ?? []).length,
      });
    } catch { /* skip bad */ }
  }

  const cells = {};
  for (const r of rows) {
    const k = `${r.task}-${r.tier}${r.bizseed ? '-bizseed' : ''}`;
    (cells[k] ??= []).push(r);
  }
  const pass = (v) => v === 'completed';
  const stats = Object.entries(cells).map(([k, rs]) => ({
    key: k,
    n: rs.length,
    completed: rs.filter((r) => pass(r.verdict)).length,
    invalid: rs.filter((r) => r.verdict === 'invalid').length,
    na: rs.filter((r) => r.verdict === 'not_applicable').length,
    avgDur: Math.round(rs.reduce((a, b) => a + b.dur, 0) / rs.length),
    avgInj: (rs.reduce((a, b) => a + b.inj, 0) / rs.length).toFixed(1),
  })).sort((a, b) => a.key.localeCompare(b.key));

  // Markdown 报告
  const lines = [
    '# 连夜真机评测报告（MiniMax-M3 · 2026-09-13 凌晨）',
    '',
    '## 记忆开/关对比（T1-T3 × A/B）',
    '',
    '| 任务×档位 | n | completed | invalid | not_applicable | 平均耗时 | 平均注入卡数 |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const st of stats) {
    lines.push(`| ${st.key} | ${st.n} | ${st.completed} | ${st.invalid} | ${st.na} | ${(st.avgDur / 1000).toFixed(0)}s | ${st.avgInj} |`);
  }
  // A/B 差值行
  for (const t of ['T1', 'T2', 'T3']) {
    const a = stats.find((s) => s.key === `${t}-A`);
    const b = stats.find((s) => s.key === `${t}-B`);
    if (a && b) {
      const rateA = a.n ? (a.completed / a.n * 100).toFixed(0) : '—';
      const rateB = b.n ? (b.completed / b.n * 100).toFixed(0) : '—';
      lines.push(`| **${t} A→B 差值** | | | | | | **完成率 ${rateA}% → ${rateB}%** |`);
    }
  }
  lines.push('', '> 口径：completed = 外部 verify.sh 退出码 0（R6 验收四问④）；invalid = B 档零注入防线失败；not_applicable 仅 T3/T5 的 A 档未溢出。单样本方差大（MiniMax 端点夜间时延 9s→200s 波动），结论看趋势不看单点。');
  await writeFile(join(DIR, 'REPORT.md'), lines.join('\n'), 'utf8');

  // SVG 曲线：T1 各轮 completed(1)/fail(0) 折线 A vs B
  const t1 = rows.filter((r) => r.task === 'T1').sort((a, b) => Number(a.round) - Number(b.round));
  const rounds = [...new Set(t1.map((r) => r.round))];
  const W = 560, H = 220, PAD = 40;
  const xy = (tier) => rounds.map((rd, i) => {
    const r = t1.find((x) => x.round === rd && x.tier === tier);
    return `${PAD + i * ((W - 2 * PAD) / Math.max(1, rounds.length - 1))},${H - PAD - (r && pass(r.verdict) ? 1 : 0) * (H - 2 * PAD)}`;
  }).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace" font-size="12">
<rect width="100%" height="100%" fill="#111"/>
<text x="${W / 2}" y="18" fill="#fff" text-anchor="middle">T1 completed(1)/fail(0) — A(memo off) vs B(memo on)</text>
<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#555"/>
<line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="#555"/>
<polyline points="${xy('A')}" fill="none" stroke="#e66" stroke-width="2"/>
<polyline points="${xy('B')}" fill="none" stroke="#6b6" stroke-width="2"/>
${rounds.map((rd, i) => `<text x="${PAD + i * ((W - 2 * PAD) / Math.max(1, rounds.length - 1))}" y="${H - PAD + 16}" fill="#999" text-anchor="middle">r${rd}</text>`).join('')}
<text x="${W - PAD}" y="${PAD - 6}" fill="#e66" text-anchor="end">A off</text>
<text x="${W - PAD}" y="${PAD - 22}" fill="#6b6" text-anchor="end">B on</text>
</svg>`;
  await writeFile(join(DIR, 'T1-curve.svg'), svg, 'utf8');
  console.log(lines.join('\n'));
  console.log('\n[report] REPORT.md + T1-curve.svg written to', DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
