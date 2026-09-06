#!/usr/bin/env node
// scripts/eval/fill-evaluation.mjs
// 从 results/<date>.json 读取评测结果，回填到 docs/panshalach/EVALUATION.md §4。
//
// 用法：
//   node scripts/eval/fill-evaluation.mjs <results-file>
//   node scripts/eval/fill-evaluation.mjs scripts/eval/results/20260906-real-openpangu.json
//
// 行为：
//   1. 读取 results JSON
//   2. 查找 EVALUATION.md 中的 §4 占位标记
//   3. 替换标记之间的内容为格式化后的评测数据
//   4. 写回 EVALUATION.md
//
// 安全：只替换 <!-- R6-AUTO-FILL §4 START --> ... <!-- R6-AUTO-FILL §4 END --> 之间的内容

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { normalizeFailureTaxonomy } from './results/schema.mjs';

const ROOT = resolve(process.cwd());
const EVALUATION_PATH = resolve(ROOT, 'docs', 'panshalach', 'EVALUATION.md');

const START_MARKER = '<!-- R6-AUTO-FILL §4 START -->';
const END_MARKER = '<!-- R6-AUTO-FILL §4 END -->';

/**
 * 格式化单个结果为 markdown 表格行。
 * @param {object} r
 * @returns {string}
 */
function formatResultRow(r) {
  const tier = r.tier || '?';
  const taskId = r.taskId || '?';
  const verdict = r.verdict || '?';
  const signal = r.verification?.signal || 'none';
  const memInjected = (r.memory?.injectedCardIds || []).length;
  const memVerified = (r.memory?.verifiedCardIds || []).length;
  const promptChars = r.prompt?.chars || 0;
  const duration = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '?';
  const tax = normalizeFailureTaxonomy(r.failureTaxonomy);
  const failure = tax ? `${tax.primary}${tax.secondary ? ' + ' + tax.secondary : ''}` : '—';

  return `| ${taskId} | ${tier} | ${verdict} | ${signal} | ${memInjected}/${memVerified} | ${promptChars} | ${duration} | ${failure} |`;
}

/**
 * 格式化汇总为 markdown。
 * @param {object} summary
 * @returns {string}
 */
function formatSummary(summary) {
  const lines = [];
  lines.push(`- **总运行数**: ${summary.totalRuns}`);
  lines.push(`- **有效样本**: ${summary.validSamples}`);
  lines.push(`- **通过**: ${summary.passed} | **失败**: ${summary.failed}`);
  lines.push(`- **通过率**: ${summary.validSamples > 0 ? (summary.passed / summary.validSamples * 100).toFixed(1) : 'N/A'}%`);
  lines.push('');

  if (summary.byTier) {
    lines.push('### 按消融档位');
    lines.push('');
    lines.push('| 档位 | 总数 | 通过 | 失败 | 无效 | 不适用 | 通过率 |');
    lines.push('|------|------|------|------|------|--------|--------|');
    for (const [tier, stats] of Object.entries(summary.byTier)) {
      if (stats.total === 0) continue;
      const rate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : 'N/A';
      lines.push(`| ${tier} | ${stats.total} | ${stats.passed} | ${stats.failed} | ${stats.invalid} | ${stats.notApplicable} | ${rate}% |`);
    }
    lines.push('');
  }

  if (summary.byFailure && Object.keys(summary.byFailure).length > 0) {
    lines.push('### 失败分类');
    lines.push('');
    lines.push('| 分类 | 计数 |');
    lines.push('|------|------|');
    for (const [key, count] of Object.entries(summary.byFailure)) {
      lines.push(`| ${key} | ${count} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 生成 §4 评测数据段。
 * @param {object} data - { meta, summary, results }
 * @returns {string}
 */
function generateSection4(data) {
  const lines = [];
  lines.push(`> 自动生成于 ${data.meta?.generatedAt || '?'} | 来源: ${data.meta?.source || '?'} | 模型: ${data.meta?.model || '?'}`);
  lines.push('');

  lines.push('## 汇总');
  lines.push('');
  lines.push(...formatSummary(data.summary).split('\n'));
  lines.push('');

  lines.push('## 详细结果');
  lines.push('');
  lines.push('| 任务 | 档位 | 结论 | 验证信号 | 注入/验证卡 | Prompt 字符 | 耗时 | 失败分类 |');
  lines.push('|------|------|------|----------|------------|------------|------|----------|');
  for (const r of data.results || []) {
    lines.push(formatResultRow(r));
  }
  lines.push('');

  return lines.join('\n');
}

// ── 主入口 ──

async function main() {
  const resultsFile = process.argv[2];
  if (!resultsFile) {
    console.error('用法: node scripts/eval/fill-evaluation.mjs <results-file>');
    console.error('示例: node scripts/eval/fill-evaluation.mjs scripts/eval/results/20260906-real-openpangu.json');
    process.exit(1);
  }

  // 读取结果
  const resultsPath = resolve(ROOT, resultsFile);
  console.log(`[fill-eval] 读取结果: ${relative(ROOT, resultsPath)}`);
  const resultsData = JSON.parse(await readFile(resultsPath, 'utf8'));

  // 读取 EVALUATION.md
  console.log(`[fill-eval] 读取: ${relative(ROOT, EVALUATION_PATH)}`);
  let evalContent = await readFile(EVALUATION_PATH, 'utf8');

  // 生成 §4 内容
  const section4 = generateSection4(resultsData);

  // 替换占位区域
  const startIdx = evalContent.indexOf(START_MARKER);
  const endIdx = evalContent.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error('[fill-eval] EVALUATION.md 中未找到 R6-AUTO-FILL §4 占位标记');
    console.error(`  请在 EVALUATION.md §4 区域添加:`);
    console.error(`  ${START_MARKER}`);
    console.error(`  （自动填充内容）`);
    console.error(`  ${END_MARKER}`);
    process.exit(1);
  }

  const before = evalContent.slice(0, startIdx + START_MARKER.length);
  const after = evalContent.slice(endIdx);
  evalContent = before + '\n\n' + section4 + '\n' + after;

  // 写回
  await writeFile(EVALUATION_PATH, evalContent, 'utf8');
  console.log(`[fill-eval] 已回填到: ${relative(ROOT, EVALUATION_PATH)}`);
  console.log('[fill-eval] DONE');
}

main().catch(e => {
  console.error('[fill-eval] 错误:', e);
  process.exit(1);
});