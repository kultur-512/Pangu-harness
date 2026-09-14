#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-cells.mjs
// 90 题多 harness 交叉对比 runner（方案二）。
//
// 格子（与 48 矩阵同范式扩容）：
//   ZL-direct-90   烛龙 CLI × 本地 1B · 记忆卡内联 recall（PANSHA_NO_MEMORY=1，E1 范式）
//   ZL-pipeline-90 烛龙 CLI × 本地 1B · haystack 前置内联（H1 范式）
//   ZL-compact-90  烛龙 CLI × 本地 1B · recordFactLines 同源播种 + PANSHA_MEMORY_LIMIT=40 检索（J1 范式）
//   CC-90          Claude Code × MiniMax-M3 · 记忆卡 recall（A1 范式）
//   Pi-90          Pi × 本地 1B · 记忆卡 recall（C1 范式）
//   （ZL-product-90 即 run-product.mjs 的 repaired 轮，另行产出）
//
// 同源纪律：ZL-compact-90 播种 import src/memory/chatFactMemory.js 的
// recordFactLines（跑本脚本须 node --import tsx），禁用评测复制品直写存储。
//
// ZL-compact-90 口径声明（B11 补全，2026-09-14）：
//   旧口径（2026-09-13 冻结）：facts 数组跨会话累积、recordFactLines 一次性调用
//   不传 sessionDate（卡无 factDate/factDateText）+ QA spawn 不带 PANSHA_TODAY——
//   v1 strict 26/90（v2 grader 重算 32/90）在该旧口径取得，答案文件
//   answers-ZL-compact-90.jsonl 为旧口径产物。
//   新口径 ZL-compact-v2（本次起）：逐会话调用 recordFactLines（每会话传
//   sessionDate → 卡带 factDate/factDateText，渲染带 [事实时间:…]）+ QA spawn 带
//   PANSHA_TODAY（question_date 经 oracle 全量 json 富化，与 run-product.mjs 同
//   模式）。这是记忆内容与 QA prompt 的口径变更——成绩会移动，补全后成绩须以
//   ZL-compact-v2 新行登记于 COMPARE-90 附录，不得与旧数字混排。澄清：7B 模型
//   升级轮的 31/90 对应格是 ZL-product 管线（run-product.mjs），不是本格。
//
// 用法：node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell <ID>
// （被 import 时不执行 main：IS_MAIN 守卫，collectCompactSeedGroups 可测）
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
})();

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(DIR, '../../..');
const Q_PATH = join(DIR, 'questions.jsonl');
const HAY_DIR = join(DIR, 'haystacks');
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';
const OUT_DIR = DIR;

const CELLS = {
  'ZL-direct-90':   { harness: 'ZL-direct',   model: '1B', mode: 'recall' },
  'ZL-pipeline-90': { harness: 'ZL-pipeline', model: '1B', mode: 'pipeline' },
  'ZL-compact-90':  { harness: 'ZL-compact',  model: '1B', mode: 'pipeline-compact' },
  'CC-90':          { harness: 'CC',          model: 'M3', mode: 'recall' },
  'Pi-90':          { harness: 'Pi',          model: '1B', mode: 'recall' },
};

const cellId = IS_MAIN ? process.argv[process.argv.indexOf('--cell') + 1] : undefined;
if (IS_MAIN && (!cellId || !CELLS[cellId])) {
  console.error('Usage: node run-cells.mjs --cell <' + Object.keys(CELLS).join('|') + '>');
  process.exit(2);
}
const cfg = IS_MAIN ? CELLS[cellId] : undefined;
const ONE_B = 'openpangu:openpangu-embedded-1b-i1';

const readMem = (qid) => {
  const p = `${MEM_DIR}/lme-${qid}.md`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};
const readHay = (qid) => {
  const p = `${HAY_DIR}/${qid}.md`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

const SYS = 'You have long-term memory stored as structured notes. Answer the user\'s question using ONLY the facts in the memory below. Be concise and give the direct answer.';

function buildPrompt({ qid, question, mode }) {
  if (mode === 'pipeline') {
    const hay = readHay(qid);
    return 'Conversation history:\n' + hay + '\n\n## Question\n' + question + '\n\nAnswer:';
  }
  const mem = readMem(qid);
  return [SYS, '', '## Long-term memory', mem, '## /Long-term memory', '', '## Question', question, '', 'Answer:'].join('\n');
}

/** ZL-compact 播种：产品 recordFactLines 同源落卡（tsx loader 必需）。
 *  B11（2026-09-14，ZL-compact-v2 口径）：逐会话调用 recordFactLines——行收集按
 *  `## Session N (…, DATE …)` 分组（collectCompactSeedGroups 纯函数，tests/eval/
 *  RunCellsSeed.test.ts 钉死），每组立即以该会话的 sessionDate 落卡，卡带
 *  factDate/factDateText（0.8.3 时间锚定与 run-product 同源）。旧实现 facts 数组
 *  跨会话累积、一次性调用不传 sessionDate——会话日期全部丢失（旧口径）。 */
const SEED_TURN_RE = /^\*\*(User|Assistant)\*\*: /;
const SEED_SESSION_RE = /^## Session \d+ \([^,]+,\s*(\d{4})\/(\d{2})\/(\d{2})/;

/** 纯函数：haystack 文本 → [{date:'yyyy-MM-dd'|'', lines:['【S·date】Q: …\nA: …']}]
 *  会话边界复位 pendingQ（悬空 User 行不与下一会话 Assistant 配对）；无会话头的
 *  配对落 date='' 的组（行前缀退化为 unknown，与旧行为一致）。 */
export function collectCompactSeedGroups(hay) {
  const groups = [];
  let cur = null;
  let pendingQ = null;
  for (const line of String(hay ?? '').split(/\r?\n/)) {
    const sm = line.match(SEED_SESSION_RE);
    if (sm) {
      cur = { date: `${sm[1]}-${sm[2]}-${sm[3]}`, lines: [] };
      groups.push(cur);
      pendingQ = null; // 审查建议-5：跨会话悬空 User 行不得与下一会话首条 Assistant 配对
      continue;
    }
    if (!SEED_TURN_RE.test(line)) continue;
    const body = line.replace(SEED_TURN_RE, '');
    if (line.startsWith('**User**: ')) {
      pendingQ = body; // 待与下一个 Assistant 行配对
    } else if (pendingQ !== null) {
      if (!cur) { cur = { date: '', lines: [] }; groups.push(cur); }
      cur.lines.push(`【S·${cur.date || 'unknown'}】Q: ${pendingQ}\nA: ${body}`);
      pendingQ = null;
    }
  }
  return groups;
}

async function seedCompact(qid, wsDir) {
  const { recordFactLines } = await import('../../../src/memory/chatFactMemory.js');
  const prev = process.env.PANSHA_MEMORY_FILE;
  process.env.PANSHA_MEMORY_FILE = 'memory.json';
  try {
    const groups = collectCompactSeedGroups(readHay(qid));
    let recorded = 0;
    let total = 0;
    let sessions = 0;
    for (const g of groups) {
      if (!g.lines.length) continue;
      sessions++;
      // B11：逐会话落卡，sessionDate = 该会话头日期（空 date → undefined →
      // recordFactLines 不带 factDate，与旧口径行为一致）
      const r = await recordFactLines(wsDir, g.lines, { sessionDate: g.date || undefined });
      recorded += r.recorded;
      total += r.total;
    }
    return { recorded, total, sessions };
  } finally {
    if (prev === undefined) delete process.env.PANSHA_MEMORY_FILE;
    else process.env.PANSHA_MEMORY_FILE = prev;
  }
}

async function runZL({ qid, prompt, today }) {
  const tmpDir = join(OUT_DIR, `tmp-${cellId}`);
  mkdirSync(tmpDir, { recursive: true });
  const wsDir = join(tmpDir, qid);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'prompt.txt'), prompt, 'utf8');
  const env = { ...process.env, PANSHA_MODEL: ONE_B, PANSHA_MEMORY_FILE: 'memory.json' };
  let facts = null;
  if (cfg.mode === 'recall') env.PANSHA_NO_MEMORY = '1';
  if (cfg.mode === 'pipeline-compact') {
    delete env.PANSHA_NO_MEMORY;
    env.PANSHA_MEMORY_LIMIT = '40';
    // B11 修正：await 播种——旧代码不 await（注释却称"同步完成"），spawnSync
    // 阻塞事件循环使落卡实际发生在 QA 子进程启动之后（靠子进程启动慢侥幸生效），
    // 且 facts 字段序列化为 {}。现真正播完再 spawn，facts 落真实计数。
    facts = await seedCompact(qid, wsDir);
  }
  // B11（ZL-compact-v2 口径）：QA spawn 补 PANSHA_TODAY（"今天是 X"身份行锚定）。
  // 仅 compact 格注入——direct/pipeline 格保持旧口径（且显式 delete 防父 shell
  // 残留值穿透进子进程，对齐 run-product 的审查 FAIL-3）。
  if (cfg.mode === 'pipeline-compact') {
    if (today) env.PANSHA_TODAY = today;
    else delete env.PANSHA_TODAY;
  } else {
    delete env.PANSHA_TODAY;
  }
  const t0 = Date.now();
  const r = spawnSync('npx.cmd', [
    'tsx', 'src/cli.ts', '--headless', '--approval', 'full', 'run', `@${join(wsDir, 'prompt.txt')}`,
  ], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    cwd: REPO, windowsHide: true, env, shell: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0, facts };
}

function runCC({ prompt }) {
  // review 建议-4：CC/Pi 格保持旧口径——防父 shell 残留 PANSHA_TODAY 穿透
  // （两格的时间锚定口径为"无注入"，与 ZL 格分离）。
  delete process.env.PANSHA_TODAY;
  const t0 = Date.now();
  const r = spawnSync('claude.cmd', [
    '--print', '--dangerously-skip-permissions',
    '--model', 'MiniMax-M3',
    '--add-dir', MEM_DIR,
    '--add-dir', HAY_DIR,
    '--', prompt,
  ], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    cwd: REPO, windowsHide: true, shell: true, input: prompt,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

function runPi({ prompt }) {
  delete process.env.PANSHA_TODAY; // 同 runCC：Pi 格口径不含时间锚定
  const cliJs = 'C:/Users/19395/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const sys = 'You have long-term memory stored as structured notes. Answer the user\'s question using only the facts in the provided memory files. Reply concisely with just the answer, no preamble.';
  const tmpDir = join(OUT_DIR, 'tmp-pi');
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${cellId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');
  const args = [
    '-p', '--no-session',
    '--provider', 'openpangu',
    '--model', 'openpangu-embedded-1b-i1',
    '--no-tools', '--no-skills', '--no-extensions',
    '--no-context-files', '--no-prompt-templates',
    '--system-prompt', sys,
    `@${tmpFile}`,
  ];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

// B11：question_date 宽容解析 → yyyy-MM-dd 供 PANSHA_TODAY（复制自 run-product.mjs
// 的 looseParseQuestionDate + isoFrom——run-product 未导出该函数，且本迭代只允许
// 改 run-cells.mjs，故就地复制 ~10 行；两处口径需人工同步，已申报）。
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function looseParseQuestionDate(raw) {
  const s = String(raw ?? '');
  let m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return isoFrom(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return isoFrom(Number(m[3]), mo, Number(m[2]));
  }
  return null;
}
function isoFrom(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // 组件回环校验：V8 对越界日期滚动不报错（02-31 → 03-03），必须防假日期
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function main() {
  const rows = readFileSync(Q_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  // B11：questions.jsonl 拿不到 question_date——与 run-product.mjs 同法回 oracle
  // 全量 json 按 qid 富化（oracleById 模式）。缺失/不匹配 → question_date 空 →
  // runZL 不设 PANSHA_TODAY（回退真实当天，与旧口径一致）。
  const ORACLE = join(REPO, 'scripts', 'eval', 'longmemeval', 'data', 'longmemeval_oracle.json');
  let oracleById = null;
  if (existsSync(ORACLE)) {
    oracleById = new Map(
      JSON.parse(readFileSync(ORACLE, 'utf8')).map((q) => [q.question_id, q]),
    );
    for (const row of rows) row.question_date = oracleById.get(row.question_id)?.question_date;
  } else if (cfg.mode === 'pipeline-compact') {
    console.warn(`[run-cells] oracle 数据缺失（${ORACLE}）——ZL-compact 格 PANSHA_TODAY 不可用，回退真实当天`);
  }
  const outFile = join(OUT_DIR, `answers-${cellId}.jsonl`);
  const existing = new Set();
  if (existsSync(outFile)) {
    for (const l of readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { existing.add(JSON.parse(l).question_id); } catch {}
    }
  }
  const todo = rows.filter((r) => !existing.has(r.question_id));
  console.log(`[${cellId}] harness=${cfg.harness} model=${cfg.model} mode=${cfg.mode} — ${rows.length} q (${existing.size} done, ${todo.length} todo)`);

  for (const row of todo) {
    process.stdout.write(`[${cellId}] ${row.question_id} ... `);
    let r;
    try {
      const prompt = buildPrompt({ qid: row.question_id, question: row.question, mode: cfg.mode });
      if (cfg.harness === 'CC') r = runCC({ prompt });
      else if (cfg.harness === 'Pi') r = runPi({ prompt });
      else {
        const today = cfg.mode === 'pipeline-compact'
          ? looseParseQuestionDate(row.question_date)
          : null; // 非 compact 格不锚定（旧口径不变）
        r = await runZL({ qid: row.question_id, prompt, today });
      }
    } catch (e) {
      r = { stdout: '', stderr: String(e), status: -1, ms: 0 };
    }
    const out = {
      question_id: row.question_id,
      question_type: row.question_type,
      gold: row.gold,
      ms: r.ms,
      status: r.status,
      stdout: r.stdout,
      stderr: (r.stderr || '').slice(-2000),
      facts: r.facts ?? undefined,
      cell: cellId,
      harness: cfg.harness,
      model: cfg.model,
      mode: cfg.mode,
    };
    writeFileSync(outFile, JSON.stringify(out) + '\n', { flag: 'a' });
    process.stdout.write(`${r.status} ${r.ms}ms\n`);
  }
  console.log(`[${cellId}] Done → ${outFile}`);
}

// IS_MAIN 守卫：被 tests/eval/RunCellsSeed.test.ts import 时只取纯函数不执行评测
if (IS_MAIN) main().catch((e) => { console.error(e); process.exit(1); });
