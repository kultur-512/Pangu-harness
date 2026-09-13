#!/usr/bin/env node
// scripts/eval/longmemeval-48/cell-zl-compact.mjs
// ZL-pipeline 真实上下文压缩测试：recordFactLines 播种 → PANSHA_MEMORY_LIMIT=40 检索
//
// Step 1: 解析 haystack markdown，按句子拆分成事实行
//         调用 recordFactLines() 批量落卡到 <wsDir>/memory.json
// Step 2: Panshalach headless 以 PANSHA_MEMORY_LIMIT=40 运行
//         模型只看到 PANSHA_MEMORY_LIMIT 条检索出的相关记忆，不是完整 haystack
//
// 对比基准：
//   H1/ZL-pipeline 假pipeline（直接喂 haystack 原文）= 24519 字平均
//   本测试 = 真实 pipeline（40 条记忆卡注入）= 压缩后上下文

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const REPO = 'P:/MY_codes/Pangu';
const Q_PATH = resolve(REPO, 'scripts/eval/longmemeval-48/questions.jsonl');
const HAY_DIR = resolve(REPO, 'scripts/eval/longmemeval-48/haystacks');
const OUT_DIR = resolve(REPO, 'scripts/eval/longmemeval-48');

// recordFactLines 实现（从 src/memory/chatFactMemory.ts 复制核心逻辑）
const hashId = (seed) => createHash('sha1').update(seed).digest('hex').slice(0, 12);

function isFactSentence(x) {
  const t = x.trim();
  if (t.length < 12 || t.length > 240) return false;
  if (/\d/.test(t)) return true;
  if (/[一-龥]/.test(t)) return true;
  if (/\b(my|i|we|our)\b/i.test(t) && /[A-Z]/.test(t)) return true;
  if (/\p{Lu}{2,}/u.test(t)) return true;
  return false;
}

function splitSentences(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.match(/[^.!?]*[.!?]+|[^.!?]+$/g) ?? [trimmed];
    for (const part of parts) {
      let p = part.trim();
      if (!p) continue;
      while (p.length > 240) { out.push(p.slice(0, 240)); p = p.slice(240); }
      if (p) out.push(p);
    }
  }
  return out;
}

// 从 haystack markdown 提取事实句子
// G1/G2 重写（0.8.2 审查修复）：
//   ① turn 捕获改为整块——旧正则只吃标记行同一行文本，编号列表/段落续行
//      整段丢失（assistant 题播种 0-14 卡、single-session-assistant 1/8 的根因）；
//   ② Session 日期入卡——`## Session N (..., 2023/05/20 ...)` 的绝对日期写进
//      卡 summary 前缀 `[S1·2023-05-20]`，knowledge-update/temporal 的时序锚点
//      （E1 的 M3 蒸馏卡显式写 OLD/LATEST 日期所以能做对，J1 此前没有）；
//   ③ assistant 轮放宽 isFactSentence（12-240 字符句全保留，靠检索排序兜底）。
const TURN_RE = /^\*\*(User|Assistant)\*\*:\s*/;
const SESSION_RE = /^## Session (\d+) \([^,]+,\s*(\d{4}\/\d{2}\/\d{2})/;

function extractTurns(haystackContent) {
  const turns = [];
  let sessionIdx = 0;
  let sessionDate = '';
  let cur = null; // { speaker, sessionIdx, sessionDate, lines }
  const flush = () => {
    if (cur) turns.push({ ...cur, text: cur.lines.join('\n').trim() });
    cur = null;
  };
  for (const line of String(haystackContent ?? '').split(/\r?\n/)) {
    const sm = line.match(SESSION_RE);
    if (sm) {
      flush();
      sessionIdx = Number(sm[1]);
      sessionDate = sm[2];
      continue;
    }
    const tm = line.match(TURN_RE);
    if (tm) {
      flush();
      cur = { speaker: tm[1], sessionIdx, sessionDate, lines: [line.slice(tm[0].length)] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return turns;
}

function extractFactLines(haystackContent) {
  const turns = extractTurns(haystackContent);
  const lines = [];
  for (const turn of turns) {
    const sentences = splitSentences(turn.text);
    const tag = `[S${turn.sessionIdx}·${turn.sessionDate || 'unknown'}]`;
    for (const s of sentences) {
      const body = s.replace(/^\d+[.、]\s*/, '').trim(); // 剥列表编号后判定（防编号数字误判）
      const relaxed = turn.speaker === 'Assistant'
        ? (body.length >= 12 && body.length <= 240)
        : isFactSentence(body);
      if (relaxed) lines.push(`${tag} ${s}`);
    }
  }
  return lines;
}

// 写入 memory.json（RefinedMemoryStore 格式）
// 注意：RefinedMemoryStore 默认文件名是 .panshalach-memory.json
function writeMemoryJson(wsDir, cards) {
  const memPath = join(wsDir, '.panshalach-memory.json');
  const data = {
    version: 1,
    cards: cards.map((c) => ({
      id: c.id,
      kind: c.kind || 'preference',
      category: c.category || 'OTHER',
      memoryCategory: c.memoryCategory || 'insight',
      summary: c.summary,
      weight: c.weight ?? 0.7,
      taskStyle: c.taskStyle ?? 'all',
      count: c.count ?? 1,
      lastSeen: c.lastSeen ?? Date.now(),
      firstSeen: c.firstSeen ?? Date.now(),
      applicableTiers: c.applicableTiers ?? [],
      sourceContext: c.sourceContext ?? 'LME haystack extraction',
      decayWeight: c.decayWeight ?? 1.0,
      lastUsedAt: c.lastUsedAt ?? Date.now(),
    })),
  };
  writeFileSync(memPath, JSON.stringify(data, null, 2), 'utf8');
  return memPath;
}

function seedMemory(wsDir, qid) {
  const hayFile = join(HAY_DIR, `${qid}.md`);
  if (!existsSync(hayFile)) return 0;
  const hay = readFileSync(hayFile, 'utf8');
  const factLines = extractFactLines(hay);
  if (factLines.length === 0) return 0;

  const now = Date.now();
  const existing = new Set();
  const cards = [];
  for (const raw of factLines) {
    const line = raw.trim();
    if (line.length < 4 || existing.has(line)) continue;
    cards.push({
      id: hashId(`chatfact-${line}`),
      kind: 'preference',
      category: 'OTHER',
      memoryCategory: 'insight',
      summary: line,
      weight: 0.7,
      taskStyle: 'all',
      count: 1,
      lastSeen: now,
      firstSeen: now,
      applicableTiers: ['general', 'failure', 'implementation', 'insight'],
      sourceContext: 'LME haystack sentence extraction',
      decayWeight: 1.0,
      lastUsedAt: now,
    });
    existing.add(line);
  }
  writeMemoryJson(wsDir, cards);
  return cards.length;
}

// 运行 ZL pipeline（真实压缩）：先播种 memory.json，再以 PANSHA_MEMORY_LIMIT=40 运行
// 文件放 REPO 根目录，cwd=REPO 时相对路径能找到

function runZLPipeline({ qid, question, lang }) {
  // 隔离工作区（0.8.2 安全修正）：不写 REPO 根的 .panshalach-memory.json
  //（那会覆盖/删除真实记忆文件），每题独立 tmp 目录；种子文件用绝对路径
  // env 注入——RefinedMemoryStore 已修 isAbsolute 直采（此前绝对路径被
  // join 拼成垃圾路径 → 静默零注入）。
  const tmpDir = join(OUT_DIR, `tmp-zl-compact2-${qid}`);
  mkdirSync(tmpDir, { recursive: true });
  const cardCount = seedMemory(tmpDir, qid);
  const memFile = join(tmpDir, '.panshalach-memory.json');
  if (cardCount === 0) return { stdout: '', stderr: 'seed-empty', status: -1, ms: 0, cardCount: 0 };

  // Step 2: 写 prompt
  const sys = lang === 'CN'
    ? '你有一个长期记忆区，存储了用户的结构化笔记。请仅依据长期记忆中的事实回答问题。回答简洁，给出最直接的答案。'
    : 'You have long-term memory stored as structured notes. Answer using ONLY the facts retrieved from your memory. Be concise and give the direct answer.';
  const promptFile = join(tmpDir, 'prompt.txt');
  const composed = [sys, '', '【问题】', question, ''].join('\n');
  writeFileSync(promptFile, composed, 'utf8');

  // Step 3: 运行 Panshalach
  const env = {
    ...process.env,
    PANSHA_NO_MEMORY: '',               // 启用记忆检索
    PANSHA_MEMORY_FILE: memFile,        // 绝对路径（isAbsolute 直采）
    PANSHA_MEMORY_LIMIT: '40',          // 限制检索条数（核心：上下文压缩）
    PANSHA_MODEL: 'openpangu:openpangu-embedded-1b-i1',
  };

  const t0 = Date.now();
  const r = spawnSync('npx.cmd', [
    'tsx', 'src/cli.ts',
    '--headless', '--approval', 'full', 'run',
    `@${promptFile}`,
  ], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    cwd: REPO, windowsHide: true, env, shell: true,
  });

  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
    ms: Date.now() - t0,
    cardCount,
  };
}

// 复用 cell.mjs 的 cell 声明（避免重复定义冲突）
const cells = {
  J1: { harness: 'zl-compact', model: '1B', mode: 'pipeline-compact', lang: 'EN', rep: 1 },
  K1: { harness: 'zl-compact', model: '1B', mode: 'pipeline-compact', lang: 'CN', rep: 1 },
};

const arg = process.argv.find((a) => a.startsWith('--cell='));
const cellId = arg ? arg.split('=')[1] : process.argv[process.argv.indexOf('--cell') + 1];
if (!cellId || !cells[cellId]) {
  console.error('Usage: node cell-zl-compact.mjs --cell <J1|K1>');
  console.error('Cells:', Object.keys(cells).join(', '));
  process.exit(2);
}
const cfg = cells[cellId];

function stripPrefix(s) {
  return (s || '').replace(/^@path 已展开.*\n?/, '').replace(/^.*?开始执行.*?\n?/, '').trim();
}

function main() {
  const rows = readFileSync(Q_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const outFile = join(OUT_DIR, `answers-${cellId}.jsonl`);

  let existing = new Set();
  if (existsSync(outFile) && !process.argv.includes('--fresh')) {
    for (const l of readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { existing.add(JSON.parse(l).question_id); } catch {}
    }
  } else {
    writeFileSync(outFile, '');
  }
  const results = [];
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  const todo = rows.filter((r) => !existing.has(r.question_id)).slice(0, limit);
  console.log(`[${cellId}] harness=${cfg.harness} model=${cfg.model} mode=${cfg.mode} lang=${cfg.lang} — ${rows.length} q (${existing.size} done, ${todo.length} todo${limitArg ? ` limit=${limit}` : ''})`);

  for (const row of todo) {
    process.stdout.write(`[${cellId}] ${row.question_id} ... `);
    let r;
    try {
      r = runZLPipeline({ qid: row.question_id, question: row.question, lang: cfg.lang });
    } catch (e) {
      r = { stdout: '', stderr: String(e), status: -1, ms: 0, cardCount: 0 };
    }
    const out = {
      question_id: row.question_id,
      question_type: row.question_type,
      gold: row.gold,
      ms: r.ms,
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      cell: cellId,
      cardCount: r.cardCount,
      ...cfg,
    };
    results.push(out);
    writeFileSync(outFile, JSON.stringify(out) + '\n', { flag: 'a' });
    process.stdout.write(`${r.status} ${r.ms}ms cards=${r.cardCount}\n`);
  }
  console.log(`[${cellId}] Done: ${results.length} → ${outFile}`);
}

main();
