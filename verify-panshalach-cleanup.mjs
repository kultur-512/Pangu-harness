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
process.exit(allOk ? 0 : 2);
