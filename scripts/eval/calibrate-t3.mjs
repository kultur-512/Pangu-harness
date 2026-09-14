#!/usr/bin/env node
// scripts/eval/calibrate-t3.mjs
// T3 fixture 校准脚本（EVAL-FEASIBILITY §1.5：校准脚本化，禁止手调）。
//
// 目标：把 tasks/T3/document.md 扩充到 "目标窗口 × 负载系数" 的字节规模，
// 使 A 档（overflowWindow）在对应窗口配置下稳定触发真溢出。
// 规模口径：CJK ≈ 1.5 字/token × 3 字节/字 ≈ 4.5 bytes/token（保守）。
//
// 内容纪律：保留原骨架（verify.sh keyword 锚点所在分节原样保留），只在各章
// 后追加同主题增补小节（模板段落 + 槽位变化），加深干货密度不改分节语义。
//
// 用法：
//   node scripts/eval/calibrate-t3.mjs --window-tokens 32768 [--load 1.0] [--check]
//   --check 只打印当前字节数与目标，不写盘。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const DOC = resolve(REPO, 'tasks/T3/document.md');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : (process.argv[i + 1] ?? dflt);
};
const windowTokens = Number(arg('window-tokens', 32768));
const load = Number(arg('load', 1.0));
const checkOnly = process.argv.includes('--check');

// 规模口径（EVAL-FEASIBILITY §1.5 规格原文：60-80KB ≈ 20-30K tokens ≈ 32K
// 窗口的 0.8-1.2 倍负载）⇒ bytes/token ≈ 2.4-2.7（markdown 混排实测口径）。
const BYTES_PER_TOKEN = 2.4;
const targetBytes = Math.round(windowTokens * BYTES_PER_TOKEN * load);

const original = readFileSync(DOC, 'utf8');
if (checkOnly) {
  console.log(`current=${Buffer.byteLength(original)}B target=${targetBytes}B (window=${windowTokens} tokens × load ${load})`);
  process.exit(0);
}

// ── 增补内容模板池（同主题：LLM × 软件工程；{n}/{term}/{pct}/{yr} 槽位轮转）──
const TERMS = ['检索增强生成', '上下文压缩', '多智能体编排', '代码补全', '缺陷定位', '测试生成', '需求追溯', '静态分析融合', '增量摘要', '工具调用协议', '记忆外置', '微调对齐'];
const FILLS = [
  (n, term, pct, yr) => `在${term}的工程实践中，评测团队在 ${yr} 年对 ${n * 37} 个真实仓库样本做了对照实验：引入${term}管线后，一次通过率提升约 ${pct}%，但代价是上下文组装时间增加 ${Math.round(pct / 3)}%。报告指出，收益与仓库规模呈弱正相关——当跨文件依赖深度超过 ${n + 2} 层时， naive 的滑动窗口策略会系统性丢失接口契约信息，此时结构化索引的召回优势才开始显现。`,
  (n, term, pct, yr) => `关于${term}的另一条主线是度量体系。${yr} 年提出的评估框架把任务拆成 ${n + 3} 个可观测阶段，每个阶段独立打分再聚合。在 ${n * 53} 个盲测样本上，该框架与人工评审的一致率达到 ${70 + (pct % 25)}%；分歧主要集中在"部分正确"的边界判定。工程团队据此调整了阈值校准策略：宁可多判 PARTIAL 也不放过伪造的 PASS——这一原则后来成为智能体验证纪律的设计依据之一。`,
  (n, term, pct, yr) => `${term}的成本模型同样值得记录。以 ${yr} 年的公开报价折算，处理一个千文件级项目的全量上下文约消耗 ${n * 11} 万 token 预算；若改为分层摘要 + 按需取回，预算可压缩到原来的 ${Math.max(12, 40 - pct % 20)}%左右。多位受访者强调，预算优化的真正难点不在算法而在工程纪律：必须显式记录每一笔上下文开销，否则优化无从谈起。这一观察直接催生了"上下文计量即一等公民"的设计潮流。`,
  (n, term, pct, yr) => `失败案例分析是${term}文献中相对稀缺但价值最高的部分。${yr} 年一项覆盖 ${n * 29} 次运行的事后审计发现：${pct}% 的失败并非模型能力不足，而是上下文组装阶段的关键信息被截断或排序失当；另有 ${Math.max(8, pct - 17)}% 源于工具输出超限后的静默丢弃。审计报告的结论被反复引用："小模型 + 好的上下文工程，稳定优于大模型 + 粗放的上下文堆砌。"`,
  (n, term, pct, yr) => `在${term}与安全性的交叉地带，${yr} 年的综述系统梳理了 ${n + 5} 类已知风险，其中与长上下文直接相关的是"中段遗忘攻击"：把恶意指令埋在超长文档中段，利用模型对中段内容的注意力衰减实施注入。防御方案的共同思路是结构化分节 + 关键段完整性校验，这与工程侧的分节召回机制不谋而合。`,
];
const HEADINGS = [
  '实证数据与工程度量', '成本模型与预算纪律', '失败模式与事后审计',
  '安全性交叉观察', '工具链生态现状', '典型工作流拆解', '与相邻技术的对比',
];

// ── 解析原骨架：按 `## ` 分章，锚点句原样保留 ──
const lines = original.split('\n');
const chapterIdx = lines.map((l, i) => (/^## /.test(l) ? i : -1)).filter((i) => i >= 0);
const refStart = lines.findIndex((l) => /^## 参考文献/.test(l));
const bodyEnd = refStart === -1 ? lines.length : refStart; // 增补只插到参考文献之前
const refBlock = refStart === -1 ? [] : lines.slice(refStart);

let fill = 0; let termI = 0; let yr = 2023;
const appendices = chapterIdx
  .filter((i) => i < bodyEnd)
  .map((ci, k) => {
    const next = chapterIdx[k + 1] ?? bodyEnd;
    const title = lines[ci].trim();
    if (/参考文献|摘要/.test(title)) return '';
    const per = Math.ceil((targetBytes - Buffer.byteLength(original)) / Math.max(1, chapterIdx.filter((i) => i < bodyEnd).length) / 900) + 1;
    const secs = [];
    for (let j = 0; j < per; j++) {
      const term = TERMS[termI++ % TERMS.length];
      const heading = HEADINGS[fill % HEADINGS.length];
      const n = fill + 1;
      const pct = 15 + ((fill * 7) % 60);
      const y = yr + (fill % 4);
      secs.push(`\n#### 增补 ${n}·${heading}（${term}）\n\n${FILLS[fill % FILLS.length](n, term, pct, y)}\n`);
      fill++;
    }
    return { at: next, text: secs.join('\n') };
  })
  .filter(Boolean);

// 按插入位置从后往前拼
let out = lines.slice(0, bodyEnd);
const inserts = new Map();
for (const a of appendices) inserts.set(a.at, [...(inserts.get(a.at) ?? []), a.text]);
for (const [at, texts] of [...inserts.entries()].sort((a, b) => b[0] - a[0])) {
  out.splice(at, 0, ...texts);
}
out = out.concat(refBlock);

let doc = out.join('\n');
// 迭代加轮次直到达标（模板池轮转 + 轮次标记保证非逐字节重复）
let round = 1;
while (Buffer.byteLength(doc) < targetBytes && round <= 200) {
  const extra = `\n\n#### 复审记录 第${round}轮\n\n评审组在第 ${yr + round} 年的复审中复核了上述 ${TERMS[round % TERMS.length]} 相关结论：样本扩充至 ${round * 413} 个后，主要指标波动在 ±3% 以内，原有分节框架与召回检查点维持不变。复审同时确认，第 1 章关于"上下文窗口约束下的代码生成范式转移"的论断、第 3 章四位研究者（李沐/陈天奇/周明/刘知远）的贡献表述、以及第 5 章"多模态融合的下一代智能软件开发平台"的展望，在更大样本下依然成立。\n`;
  doc += extra;
  round++;
}

writeFileSync(DOC, doc, 'utf8');
const bytes = Buffer.byteLength(doc);
console.log(`calibrated: ${bytes}B (${(bytes / 1024).toFixed(1)}KB) target=${targetBytes}B window=${windowTokens} load=${load} rounds=${round - 1} appendices=${fill}`);
// 锚点完整性自检
for (const anchor of ['上下文窗口约束下的代码生成范式转移', '李沐', '陈天奇', '周明', '刘知远', '参数服务器架构', 'TVM', '多语言预训练', '知识增强预训练', '多模态融合的下一代智能软件开发平台']) {
  if (!doc.includes(anchor)) {
    console.error(`ANCHOR MISSING: ${anchor}`);
    process.exit(1);
  }
}
console.log('anchors: all present');
