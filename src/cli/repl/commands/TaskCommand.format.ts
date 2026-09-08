// src/cli/repl/commands/TaskCommand.format.ts
// 纯渲染层:把 TaskState → CLI 行数组。无 IO、无副作用。
// 字段顺序对齐王佐 9/7 回复(taskId / originalRequirement / currentGoal /
//   decisions / milestones / verified / risks / nextStep / version / updatedAt)。
//
// UNKNOWN 态归 CLI 侧(ROADMAP-NEXT §3 R5:"任务状态机含 UNKNOWN 态,显式显示,不猜"),
// store 层不返回 UNKNOWN,本模块负责把"未设置/空数组"渲染成显式占位。
//
// 扩展点(明天补):formatTaskRisks / formatTaskNext / formatTaskDecision。

import type { TaskState } from '../types.js';

const UNKNOWN = '(未设置)';
const EMPTY = '(空)';

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatTaskStatus(s: TaskState): string[] {
  const lines: string[] = [];

  lines.push(`taskId:           ${s.taskId}`);
  lines.push(`version:          ${s.version}`);
  lines.push(`updatedAt:        ${fmtTs(s.updatedAt)}`);
  lines.push(`originalRequirement:`);
  lines.push(`  ${s.originalRequirement || UNKNOWN}`);
  lines.push(`currentGoal:      ${s.currentGoal ?? UNKNOWN}`);
  lines.push(`nextStep:         ${s.nextStep ?? UNKNOWN}`);

  lines.push(`decisions (${s.decisions.length}):`);
  if (s.decisions.length === 0) {
    lines.push(`  ${EMPTY}`);
  } else {
    for (const d of s.decisions) {
      lines.push(`  - [${fmtTs(d.ts)}] ${d.what}${d.why ? ` · why=${d.why}` : ''}`);
    }
  }

  lines.push(`milestones (${s.milestones.length}):`);
  if (s.milestones.length === 0) {
    lines.push(`  ${EMPTY}`);
  } else {
    for (const m of s.milestones) {
      lines.push(`  - [${fmtTs(m.ts)}] ${m.done ? '✓' : '·'} ${m.title}${m.evidence ? ` · ${m.evidence}` : ''}`);
    }
  }

  lines.push(`verified (${s.verified.length}):`);
  if (s.verified.length === 0) {
    lines.push(`  ${EMPTY}`);
  } else {
    for (const v of s.verified) {
      lines.push(`  - [${fmtTs(v.ts)}] ${v.what}${v.command ? ` · cmd=${v.command}` : ''}`);
    }
  }

  lines.push(`risks (${s.risks.length}):`);
  if (s.risks.length === 0) {
    lines.push(`  ${EMPTY}`);
  } else {
    for (const r of s.risks) {
      lines.push(`  - [${fmtTs(r.ts)}] ${r.risk}${r.mitigation ? ` · mitigation=${r.mitigation}` : ''}`);
    }
  }

  return lines;
}