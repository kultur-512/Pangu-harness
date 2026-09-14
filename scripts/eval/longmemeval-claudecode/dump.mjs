#!/usr/bin/env node
// scripts/eval/longmemeval-claudecode/dump.mjs
// 给"Claude Code 作为被测对象"用的 LME 抽样+落盘脚本。
// 与 longmemeval-run.mjs 的关键差异：不调产品 CLI，只把题目/haystack 落盘，
// 让 Claude Code 自己在会话里读 haystack、写 memory/、回答。
//
// 用法：
//   node scripts/eval/longmemeval-claudecode/dump.mjs [--n 12]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const DATA_FILE = join(ROOT, 'scripts', 'eval', 'longmemeval', 'data', 'longmemeval_oracle.json');
const OUT_DIR = join(ROOT, 'scripts', 'eval', 'longmemeval-claudecode');
const HAY_DIR = join(OUT_DIR, 'haystacks');

const N_PER_TYPE = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--n') || '12', 10) / 6;

function sample(data, nPerType) {
  const byType = new Map();
  for (const q of data) {
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type).push(q);
  }
  for (const list of byType.values()) list.sort((a, b) => a.question_id.localeCompare(b.question_id));
  const picked = [];
  const keys = [...byType.keys()].sort();
  for (const t of keys) {
    const list = byType.get(t);
    for (let i = 0; i < nPerType && i < list.length; i++) picked.push(list[i]);
  }
  return picked;
}

function fmtTurn(t) {
  const role = t.role === 'user' ? 'USER' : 'ASST';
  const date = t.date ? `[${t.date}] ` : '';
  return `${date}${role}: ${t.content}`;
}

function fmtHaystack(q) {
  const lines = [
    `# Question ${q.question_id} (${q.question_type})`,
    `# Question date: ${q.question_date}`,
    `# Sessions: ${q.haystack_sessions?.length ?? 0} | Session ids: ${(q.haystack_session_ids || []).join(', ')}`,
    '',
    '## Conversations (read carefully — extract key facts to memory)',
    '',
  ];
  for (let i = 0; i < (q.haystack_sessions || []).length; i++) {
    const sess = q.haystack_sessions[i];
    const sid = q.haystack_session_ids?.[i] ?? `s${i}`;
    const sdate = q.haystack_dates?.[i] ?? '';
    lines.push(`### Session ${i + 1} (${sid}${sdate ? ' · ' + sdate : ''})`);
    lines.push('');
    for (const t of sess) lines.push(fmtTurn(t));
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  if (!existsSync(DATA_FILE)) {
    console.error(`missing: ${DATA_FILE}`);
    process.exit(2);
  }
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const picked = sample(data, N_PER_TYPE);
  console.log(`[dump] sampled ${picked.length} questions (${N_PER_TYPE}/type)`);

  await mkdir(HAY_DIR, { recursive: true });

  const questionsRows = [];
  for (const q of picked) {
    const hayFile = join(HAY_DIR, `${q.question_id}.md`);
    await writeFile(hayFile, fmtHaystack(q), 'utf8');
    questionsRows.push({
      question_id: q.question_id,
      question_type: q.question_type,
      question: q.question,
      gold: q.answer,
      haystack_file: `haystacks/${q.question_id}.md`,
      facts_target: estimateFacts(q),
    });
    console.log(`  ${q.question_id} [${q.question_type}] → ${hayFile}`);
  }

  const qFile = join(OUT_DIR, 'questions.jsonl');
  await writeFile(qFile, questionsRows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  console.log(`[dump] questions manifest: ${qFile}`);
}

function estimateFacts(q) {
  // 粗略：每会话对 user→assistant 算一条候选事实
  let n = 0;
  for (const s of q.haystack_sessions || []) for (let i = 0; i < s.length - 1; i++) {
    if (s[i].role === 'user' && s[i + 1].role === 'assistant') n++;
  }
  return n;
}

main().catch((e) => { console.error(e); process.exit(1); });
