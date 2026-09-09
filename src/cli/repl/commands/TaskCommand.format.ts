// src/cli/repl/commands/TaskCommand.format.ts
// 纯渲染层:把 TaskState → CLI 行数组。无 IO、无副作用。
// 字段顺序对齐王佐 9/7 回复(taskId / originalRequirement / currentGoal /
//   decisions / milestones / verified / risks / nextStep / version / updatedAt)。
//
// UNKNOWN 态归 CLI 侧(ROADMAP-NEXT §3 R5:"任务状态机含 UNKNOWN 态,显式显示,不猜"),
// store 层不返回 UNKNOWN,本模块负责把"未设置/空数组"渲染成显式占位。
//
// 扩展点:formatTaskRisks / formatTaskNext / deriveNext 已在 9/9 落地;
// formatTaskDecision 留 0.8 立项后再补(/task decide 已直接行内确认,无需单独渲染函数)。

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

/** 纯渲染 /task risks。空数组显式 "(无风险)",不靠 caller 兜底。 */
export function formatTaskRisks(s: TaskState): string[] {
  const lines: string[] = [];
  lines.push(`risks (${s.risks.length}):`);
  if (s.risks.length === 0) {
    lines.push(`  (无风险)`);
    return lines;
  }
  // 按时间正序(与 status 一致;store 层无序保证)
  const sorted = [...s.risks].sort((a, b) => a.ts - b.ts);
  for (const r of sorted) {
    lines.push(`  - [${fmtTs(r.ts)}] ${r.risk}${r.mitigation ? ` · mitigation=${r.mitigation}` : ''}`);
  }
  return lines;
}

/**
 * 纯渲染 /task next。
 * `derived` 由 caller(TaskCommand.ts:next 分支)算出后传入:
 *   - undefined   → state.nextStep 字段直显
 *   - { from: 'milestone-title' | 'milestone-evidence' | 'risks-mitigation', raw?: string }
 *                  → 由 caller 提供的推导来源;渲染层负责标注"由 XXX 推导" + 原值
 * 全缺 → UNKNOWN 态显式 + 引导 decide。
 */
export function formatTaskNext(
  s: TaskState,
  derived?: { from: 'milestone-title' | 'milestone-evidence' | 'risks-mitigation'; raw?: string },
): string[] {
  const lines: string[] = [];
  if (s.nextStep) {
    lines.push('nextStep:');
    lines.push(`  字段: ${s.nextStep}`);
    lines.push(`  来源: nextStep 字段`);
    return lines;
  }

  // 推导路径:与 TaskCommand.ts:next 分支的 5 档优先级对齐
  if (derived) {
    lines.push('nextStep:');
    if (derived.from === 'milestone-title') {
      lines.push(`  字段: ${derived.raw ?? ''}`);
      lines.push(`  来源: 推导（最后一个未 done milestone 的 title）`);
      if (derived.raw) lines.push(`  原值: milestones[*].title = "${derived.raw}"`);
    } else if (derived.from === 'milestone-evidence') {
      lines.push(`  字段: ${derived.raw ?? ''}`);
      lines.push(`  来源: 推导（最后一个未 done milestone 的 evidence）`);
      if (derived.raw) lines.push(`  原值: milestones[*].evidence = "${derived.raw}"`);
    } else if (derived.from === 'risks-mitigation') {
      lines.push(`  字段: ${derived.raw ?? ''}`);
      lines.push(`  来源: 推导（risks[0].mitigation）`);
      if (derived.raw) lines.push(`  原值: risks[0].mitigation = "${derived.raw}"`);
    }
    return lines;
  }

  // 全缺 UNKNOWN 态
  lines.push('nextStep:');
  lines.push('  (无法推断：nextStep 未设、milestones 全 done、risks 无 mitigation)');
  lines.push('  提示: 用 /task decide "<下一步>" 显式设定。');
  return lines;
}

/** 推导 nextStep 优先级的纯函数。返回 null 表示全缺(UNKNOWN 态)。
 *  优先级:nextStep → 未 done milestone.title → 未 done milestone.evidence → risks[0].mitigation。
 *  返回 { value, from } 给渲染层标注来源。 */
export function deriveNext(s: TaskState):
  | { value: string; from: 'milestone-title' | 'milestone-evidence' | 'risks-mitigation'; raw: string }
  | null {
  if (s.nextStep) return null; // 走字段直显路径
  // 最后一个未 done milestone(按 ts 倒序找,或尾序)
  const undone = [...s.milestones].reverse().find((m) => !m.done);
  if (undone) {
    if (undone.title) return { value: undone.title, from: 'milestone-title', raw: undone.title };
    if (undone.evidence) return { value: undone.evidence, from: 'milestone-evidence', raw: undone.evidence };
  }
  // risks[0].mitigation
  if (s.risks.length > 0 && s.risks[0].mitigation) {
    return { value: s.risks[0].mitigation, from: 'risks-mitigation', raw: s.risks[0].mitigation };
  }
  return null;
}