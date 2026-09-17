#!/usr/bin/env node
// scripts/eval/longmemeval-90/calibrate-tokens.mjs
// 实测各模型 token/字 比（CJK vs ASCII），校准 estTokens 的 CJK_TOKENS_PER_CHAR。
//
// 原理：向 OpenAI 兼容端点发 3 个探针（单字基线 "x" / 纯中文 "中"×N / 纯 ASCII "a"×N，
// max_tokens=1），读响应 usage.prompt_tokens，做差消掉 chat 模板固定开销：
//   cjk_per_char  = (tokens("中"×N) - tokens("x")) / N
//   ascii_per_char= (tokens("a"×N) - tokens("x")) / N
// 对照：estTokens 当前 CJK 系数默认 1.0（旧值 1.5）、ascii 0.25。
//
// 用法：
//   node scripts/eval/longmemeval-90/calibrate-tokens.mjs            # 全部已知目标（离线跳过）
//   node scripts/eval/longmemeval-90/calibrate-tokens.mjs 1b m3      # 只测指定名
//
// 目标定义（可改 TARGETS）：
//   1b  → 本地 LM Studio http://localhost:1234 · openpangu-embedded-1b-i1
//   7b  → 本地 LM Studio http://localhost:1234 · openpangu7b-with-medusa
//   m3  → MiniMax API（MINIMAX_API_HOST / MINIMAX_API_KEY）· MiniMax-M3

const N = 200; // 探针字符数（越大越稳）

// 自然混合句探针（避免 "a"×N 同字符重复被 BPE 高度压缩的退化；CJK 与 ASCII 各自多样）
const CJK_SEED = '这是一个用于校准分词器的自然中文句子，包含常见汉字标点符号与数字2024年月日。';
const ASCII_SEED = 'The quick brown fox jumps over the lazy dog near a river 1234567890, and it keeps running.';
const mkProbe = (seed) => {
  const unit = seed.replace(/\s+/g, '');
  return unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
};
const CJK_PROBE = mkProbe(CJK_SEED);
const ASCII_PROBE = mkProbe(ASCII_SEED.replace(/[^a-zA-Z0-9 ]/g, ''));

const TARGETS = {
  '1b': { label: '1B', baseUrl: 'http://localhost:1234', model: 'openpangu-embedded-1b-i1', key: undefined },
  '7b': { label: '7B', baseUrl: 'http://localhost:1234', model: 'openpangu7b-with-medusa', key: undefined },
  'm3': { label: 'M3', baseUrl: process.env.MINIMAX_API_HOST || 'https://api.minimaxi.com', model: 'MiniMax-M3', key: process.env.MINIMAX_API_KEY },
};

async function promptTokens(baseUrl, apiKey, model, content) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 1 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  const t = Number(j?.usage?.prompt_tokens);
  return Number.isFinite(t) ? t : null;
}

async function calibrate(t) {
  const base = await promptTokens(t.baseUrl, t.key, t.model, 'x');
  const cjk = await promptTokens(t.baseUrl, t.key, t.model, CJK_PROBE);
  const ascii = await promptTokens(t.baseUrl, t.key, t.model, ASCII_PROBE);
  if ([base, cjk, ascii].some((x) => x == null)) {
    return { label: t.label, model: t.model, error: 'usage.prompt_tokens 缺失' };
  }
  return {
    label: t.label,
    model: t.model,
    baseTokens: base,
    cjkPerChar: (cjk - base) / N,
    asciiPerChar: (ascii - base) / N,
  };
}

async function main() {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(TARGETS);
  console.log(`[calibrate] 探针 N=${N} 字符 · 对照 estTokens：CJK 默认 1.0（旧 1.5）/ ascii 0.25\n`);

  const rows = [];
  for (const name of names) {
    const t = TARGETS[name];
    if (!t) { console.error(`[calibrate] 未知目标: ${name}`); continue; }
    try {
      const r = await calibrate(t);
      if (r.error) {
        console.log(`${r.label} (${r.model}): ✗ ${r.error}`);
      } else {
        rows.push(r);
        console.log(
          `${r.label} (${r.model}): CJK ${r.cjkPerChar.toFixed(3)} token/字 · ASCII ${r.asciiPerChar.toFixed(3)} token/字 · ` +
          `基线 ${r.baseTokens} token`,
        );
      }
    } catch (e) {
      console.log(`${t.label} (${t.model}): ✗ ${String(e.message || e)}`);
    }
  }

  console.log('\n=== 校准判定 ===');
  console.log('注：自然混合句测得的是"典型文本"值（常见 2-gram 合并）；单字重复 "中"×N 测得的是"原子"值（每字≈1 token 上界）。安全系数应取上界附近。');
  for (const r of rows) {
    const cjk = r.cjkPerChar;
    let verdict;
    if (cjk <= 0.35) verdict = '≈ ascii 档（异常，疑似 tokenizer 未分字或探针错）';
    else if (cjk < 0.9) verdict = '典型文本 <1.0（常见词合并）→ 默认 1.0 为安全上界，正确（若想更省容量可下调，但会低估生僻字）';
    else if (cjk <= 1.2) verdict = '≈ 1.0（含原子单字上界）→ 默认值正确';
    else if (cjk <= 1.6) verdict = '介于 1.0~1.5 → 偏保守';
    else verdict = '>1.5 → 应上调系数（LLaMA 系特征）';
    console.log(`${r.label}: CJK ${cjk.toFixed(3)} token/字 → ${verdict}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
