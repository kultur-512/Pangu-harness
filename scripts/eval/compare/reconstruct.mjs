// report.json 早期被覆盖；对未重跑的 15 个任务用现存工作区产物现场 verify 重建行
import { TASKS } from './tasks.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const rp = 'P:/MY_codes/Pangu/.zcode/compare/report.json';
const report = JSON.parse(readFileSync(rp, 'utf8'));
const have = new Set(report.map(r => r.id));
for (const t of TASKS) {
  if (have.has(t.id)) continue;
  const zlWs = 'D:/zl-tasks/' + t.id, ccWs = 'P:/cc-tasks/' + t.id;
  if (!existsSync(zlWs) && !existsSync(ccWs)) { console.log('[skip] ' + t.id + ' (no workspaces)'); continue; }
  const zlV = existsSync(zlWs) ? t.verify(zlWs) : [false, 'workspace gone'];
  const ccV = existsSync(ccWs) ? t.verify(ccWs) : [false, 'workspace gone'];
  report.push({ id: t.id, size: t.size,
    zl: { ms: null, exit: 0, ok: zlV[0], detail: zlV[1] + ' (reconstructed)' },
    cc: { ms: null, exit: 0, ok: ccV[0], detail: ccV[1] + ' (reconstructed)' },
    zlAnswerHead: '', ccAnswerHead: '' });
  console.log(`[${t.id}] zl: ${zlV[0] ? 'PASS' : 'FAIL'} ${zlV[1]} | cc: ${ccV[0] ? 'PASS' : 'FAIL'} ${ccV[1]}`);
}
writeFileSync(rp, JSON.stringify(report, null, 2));
console.log('reconstructed rows written; total: ' + report.length);
