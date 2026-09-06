// verify-pangu-cleanup.mjs
// Run with: node verify-pangu-cleanup.mjs
// Static hygiene checks for Panshalach (brand alias PanshalachChaser / legacy Glm53SweProChaser).
// NOTE: internal class names keep historical identifiers until ROADMAP P6 rename;
// this script guards the compatibility-alias layer in the meantime.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir)) {
    const f = path.join(dir, e);
    let s;
    try { s = fs.statSync(f); } catch { continue; }
    if (s.isDirectory()) {
      if (/node_modules|^\.git$|dist$/.test(path.basename(f))) continue;
      walk(f, acc);
    } else if (/\.(ts|js|cjs|mjs)$/.test(f)) {
      acc.push(f);
    }
  }
  return acc;
}

const files = walk(SRC);
let directOldImport = [];
let packageMainOk = false;
let cliUsesPanshalach = false;
let sandboxUsesPanshalach = false;
let hardCodedIsStrongOutsideTier = [];

const OLD_IMPORT_RE = /from\s+['"][^'"]*Glm53SweProChaser(?![^'"]*PanshalachChaser)/;
const OLD_REQUIRE_RE = /require\(['"][^'"]*Glm53SweProChaser/;
const PANSHA_IMPORT_RE = /from\s+['"][^'"]*PanshalachChaser['"]/;

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const t = fs.readFileSync(f, 'utf8');

  // 1) Direct import of old module in non-stub sources
  if (!rel.endsWith('Glm53SweProChaser.ts')) {
    if (OLD_IMPORT_RE.test(t) || OLD_REQUIRE_RE.test(t)) {
      directOldImport.push(rel);
    }
  }

  // 2) Look for hard-coded isStrongMode branches that ignore tierConfig
  //    We allow: tierConfig.isStrongMode, TierConfig, isHighRigor derived from tier
  //    Flag suspicious: standalone "if (isStrongMode)" or "if (isStrong)" not near "tierConfig"
  const lines = t.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/\bif\s*\(\s*(isStrongMode|isStrong)\b/.test(ln)) {
      // Look at surrounding context for tierConfig or TierConfig
      const ctx = lines.slice(Math.max(0, i-3), i+4).join('\n');
      if (!/tierConfig|TierConfig|ironLawInjectionLevel|memoryLoadLevel/.test(ctx)) {
        hardCodedIsStrongOutsideTier.push(`${rel}:${i+1}`);
      }
    }
  }
}

// package.json
try {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  packageMainOk = (pj.main === 'dist/PanshalachChaser.js') || (pj.main === './dist/PanshalachChaser.js');
} catch {}

// cli.ts (兼容层) + 新 REPL 结构
// 允许：
//   - src/cli.ts 直接引用 PanshalachChaser（旧单文件模式）
//   - 或 src/cli/repl/**/*.ts 中引用（新 ZIS REPL 模式）
try {
  const cli = fs.readFileSync(path.join(SRC, 'cli.ts'), 'utf8');
  const hasDirect = /import\s+\{[^}]*PanshalachChaser[^}]*\}\s+from\s+['"]\.\/PanshalachChaser['"]/.test(cli)
                 || /new\s+PanshalachChaser\(/.test(cli);
  if (hasDirect) {
    cliUsesPanshalach = true;
  } else {
    // 新结构：检查 repl 目录下的命令和 Repl 是否使用了 PanshalachChaser
    const replDir = path.join(SRC, 'cli', 'repl');
    if (fs.existsSync(replDir)) {
      const replFiles = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d)) {
          const f = path.join(d, e);
          const st = fs.statSync(f);
          if (st.isDirectory()) walk(f);
          else if (/\.(ts|js)$/.test(f)) replFiles.push(f);
        }
      })(replDir);
      cliUsesPanshalach = replFiles.some(f => {
        const t = fs.readFileSync(f, 'utf8');
        const hasPanshalachRef = /PanshalachChaser/.test(t);
        const staticFrom = /from\s+['"][^'"]*PanshalachChaser['"]/.test(t);
        const dynImport = /import\s*\(\s*['"][^'"]*PanshalachChaser[^'"]*['"]\s*\)/.test(t);
        const newCall = /new\s+PanshalachChaser\s*\(/.test(t);
        return hasPanshalachRef && (staticFrom || dynImport || newCall);
      });
    }
  }
} catch {}

// sandbox-test-runner.ts (moved to scripts/ in dogfood-④; preserved because
// this gate depends on it)
try {
  const sb = fs.readFileSync(path.join(ROOT, 'scripts', 'sandbox-test-runner.ts'), 'utf8');
  sandboxUsesPanshalach = /import\s+\{[^}]*PanshalachChaser[^}]*\}\s+from\s+['"](?:\.\/|\.\.\/)?src\/PanshalachChaser['"]/.test(sb)
                  || /new\s+PanshalachChaser\(/.test(sb);
} catch {}

console.log('=== Panshalach Cleanup Verification (internal alias layer) ===');
console.log('package.json main -> dist/PanshalachChaser.js :', packageMainOk ? 'OK' : 'FAIL');
console.log('src/cli.ts uses PanshalachChaser            :', cliUsesPanshalach ? 'OK' : 'FAIL');
console.log('sandbox-test-runner.ts uses PanshalachChaser :', sandboxUsesPanshalach ? 'OK' : 'FAIL');
console.log('Direct old module imports (non-stub)   :', directOldImport.length ? 'FAIL' : 'OK', directOldImport.length);
directOldImport.forEach(x => console.log('  BAD:', x));
console.log('Hard-coded isStrongMode outside tier   :', hardCodedIsStrongOutsideTier.length ? 'REVIEW' : 'OK', hardCodedIsStrongOutsideTier.length);
hardCodedIsStrongOutsideTier.slice(0, 20).forEach(x => console.log('  REVIEW:', x));

const allOk = packageMainOk && cliUsesPanshalach && sandboxUsesPanshalach && directOldImport.length === 0;
console.log('OVERALL CLEANUP STATUS (static checks):', allOk ? 'PASS' : 'NEEDS_REVIEW');

// ==================== 0.7 终止语义重构清理检查（backlog D1） ====================
// 判官（continuationJudge）+ TestTimeOrchestrator 已归档（archive/2026-09-05-removals/），
// Trajectory 迁出至 src/loop/trajectory.ts，回合终止三态 TurnStopReason 落地。
// 逐项 CHECK，最后 OVERALL 汇总（与本脚本前半段风格一致）。

const fileExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** 剥离行/块注释——历史性提及（"已归档"/"迁出"注释）不算引用。字符串里的 '//'（如 URL）不剥离。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// 全仓库代码文件扫描（排除 node_modules/.git/dist/archive；排除脚本自身——
// 自身的 CHECK 正则字面量不应自证其罪）。
const SELF_NAME = path.basename(process.argv[1] || '');
const repoFiles = [];
(function walkRepo(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const f = path.join(dir, e);
    let s;
    try { s = fs.statSync(f); } catch { continue; }
    if (s.isDirectory()) {
      // 排除依赖目录、git/工具目录（.git/.claude worktrees 等）、构建产物与归档
      if (/node_modules|^\.git$|^dist$|^archive$/.test(e) || e.startsWith('.')) continue;
      walkRepo(f);
    } else if (/\.(ts|tsx|js|jsx|cjs|mjs)$/.test(e) && e !== SELF_NAME) {
      repoFiles.push(f);
    }
  }
})(ROOT);

const repoTexts = repoFiles.map((f) => {
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch {}
  return { rel: path.relative(ROOT, f).replace(/\\/g, '/'), code: stripComments(t) };
});

/** 返回命中正则的文件（注释已剥离后的代码引用） */
function findRefs(re) {
  return repoTexts.filter(({ code }) => re.test(code)).map(({ rel }) => rel);
}

const REMOVALS = path.join(ROOT, 'archive', '2026-09-05-removals');
const readSrc = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// CHECK 1/2：判官 / TestTimeOrchestrator 已归档（archive 下存在 + src 内无活体文件）
const judgeArchived = fileExists(path.join(REMOVALS, 'continuationJudge.archived.ts'))
  && !fileExists(path.join(SRC, 'loop', 'continuationJudge.ts'));
const orchArchivedFile = fileExists(path.join(REMOVALS, 'TestTimeOrchestrator.archived.ts'));
const orchLiveFiles = repoTexts.filter(({ rel }) => rel.startsWith('src/') && /TestTimeOrchestrator(?!\.archived)/.test(path.basename(rel)));

// CHECK 3：Trajectory 已迁出（src/loop/trajectory.ts 存在且导出 Trajectory）
const trajPath = path.join(SRC, 'loop', 'trajectory.ts');
const trajSrc = readSrc(trajPath);
const trajectoryMigrated = fileExists(trajPath) && /export\s+interface\s+Trajectory\b/.test(trajSrc);

// CHECK 4：TurnStopReason 枚举存在（src/cli/repl/types.ts，含三态关键值）
const typesSrc = readSrc(path.join(SRC, 'cli', 'repl', 'types.ts'));
const turnStopReasonEnum = /TurnStopReason/.test(typesSrc)
  && /'completed'/.test(typesSrc)
  && /'answered'/.test(typesSrc)
  && /'no-verification'/.test(typesSrc);

// CHECK 5-8：遗留符号全仓库零代码引用（注释不算）
const judgeFnRefs = findRefs(/\brunWithVerificationJudge\b/);
const orchRefs = findRefs(/\bTestTimeOrchestrator\b/);
const scoreFieldInTrajectory = /\bscore\s*\??\s*:/.test(trajSrc);
const scoreRefs = findRefs(/\b(?:trajectory|bestTrajectory|traj|best|rollout)\w*\.score\b/);
const continueCountRefs = findRefs(/\bcontinueCount\b/);

const cleanupChecks = [
  ['judge file archived (archive/ 下有，src/loop/ 无)', judgeArchived],
  ['TestTimeOrchestrator archived (archive/ 下有，src/ 无活体)', orchArchivedFile && orchLiveFiles.length === 0],
  ['Trajectory migrated out (src/loop/trajectory.ts 存在且导出)', trajectoryMigrated],
  ['TurnStopReason enum present (src/cli/repl/types.ts 三态)', turnStopReasonEnum],
  ['runWithVerificationJudge zero refs repo-wide', judgeFnRefs.length === 0],
  ['TestTimeOrchestrator zero code refs (src/+tests/, excl archive)', orchRefs.length === 0],
  ['Trajectory `score` field zero refs', !scoreFieldInTrajectory && scoreRefs.length === 0],
  ['`continueCount` zero refs repo-wide', continueCountRefs.length === 0],
];

console.log('\n=== 0.7 Termination-Semantics Cleanup (judge/orchestrator removal) ===');
for (const [label, ok] of cleanupChecks) {
  console.log(`CHECK ${label.padEnd(58)}:`, ok ? 'OK' : 'FAIL');
}
const refDetail = [['runWithVerificationJudge refs', judgeFnRefs], ['TestTimeOrchestrator refs', orchRefs],
  ['Trajectory .score refs', scoreRefs], ['continueCount refs', continueCountRefs], ['orch live files in src/', orchLiveFiles.map((f) => f.rel ?? f)]];
for (const [label, hits] of refDetail) {
  if (hits.length) {
    console.log(`  BAD ${label}:`);
    hits.slice(0, 20).forEach((h) => console.log('    ', h));
  }
}

const cleanupOk = cleanupChecks.every(([, ok]) => ok);
console.log('OVERALL 0.7 CLEANUP STATUS:', cleanupOk ? 'PASS' : 'FAIL');

const allOk2 = allOk && cleanupOk;
console.log('OVERALL CLEANUP STATUS (static checks):', allOk2 ? 'PASS' : 'NEEDS_REVIEW');
process.exit(allOk2 ? 0 : 2);
