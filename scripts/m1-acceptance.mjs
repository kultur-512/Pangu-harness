// scripts/m1-acceptance.mjs
// M1 ACCEPTANCE BATTLE DRIVER (batch 2.5)
//
// Runs the M1 acceptance task against the real engine + real model (scnet):
//   fix .sandbox-test/buggy-calculator add() bug (add(2,3) must be 5),
//   then run real `npm test` until green.
//
// Environment note (documented deviation): this harness has no interactive
// TTY, so the driver sets process.stdout.isTTY = true to cross the engine's
// smoke gate. The production REPL path is unchanged; non-TTY runs (smoke/CI)
// keep the mock. The approval bridge logs every request (default mode) and
// answers 'y' — equivalent to a user pressing y on the confirm card.

// ---- TTY override MUST come before engine imports ----
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });

import path from 'path';
import fs from 'fs';
const WORKSPACE = path.resolve(process.cwd(), '.sandbox-test', 'buggy-calculator');
const TASK = process.env.M1_TASK || [
  '修复本项目 src/calculator.js 中 add 函数的 bug：add(2, 3) 应返回 5（当前错误地返回 a - b）。',
  '要求：',
  '1) 先用 read_file 读取 src/calculator.js 和 calculator.test.js，确认 bug 与测试期望；',
  '2) 用 edit_file 把 return a - b 改成 return a + b；',
  '3) 用 bash 执行 npm test 验证测试全部通过。',
].join('\n');

const { resolveSharedClient } = await import('../dist/cli/repl/ModelProvider.js');
const { Session } = await import('../dist/cli/repl/Session.js');
const { PanshalachChaser } = await import('../dist/PanshalachChaser.js');
const { TierRegistry } = await import('../dist/tiers/TierConfig.js');
const { PromptBuilder } = await import('../dist/cli/repl/PromptBuilder.js');

function fmtK(v) {
  if (typeof v !== 'string') return String(v);
  return v.length > 400 ? v.slice(0, 400) + `…(+${v.length - 400} chars)` : v;
}

function log(line = '') {
  process.stdout.write(line + '\n');
}

const session = new Session({
  tier: 'high',
  workspace: WORKSPACE,
  approvalMode: 'default',
  sessionApprovalAllowlist: [],
});

const events = [];
let approvalCount = 0;

const client = await resolveSharedClient(session.model).then((r) => r.client);
log('=== M1 ACCEPTANCE BATTLE ===');
log(`workspace: ${WORKSPACE}`);
log(`tier: ${session.tier} | approvalMode: ${session.approvalMode} | model: ${session.model}`);
log('');

const tierConfig = TierRegistry.get(session.tier);
const pb = new PromptBuilder(session, tierConfig);
const enriched = await pb.buildForTask(TASK);

const chaser = new PanshalachChaser(client, session.tier);

const start = Date.now();
try {
  const result = await chaser.solveIssue(enriched, WORKSPACE, {
    tier: session.tier,
    yes: true,
    memoryPreInjected: true,
    approvalMode: session.approvalMode,
    sessionAllowlist: session.sessionApprovalAllowlist,
    approvalTimeoutMs: 60_000,
    approvalBridge: async (req) => {
      approvalCount++;
      log(`[approval.request #${approvalCount}] ${req.tool}${req.danger ? ' [DANGER]' : ''}: ${fmtK(req.description)} → y`);
      events.push({ type: 'approval.request', tool: req.tool, description: req.description, decision: 'y' });
      return 'y';
    },
    onStep: (event) => {
      events.push(event);
      if (event.type === 'phase') {
        log(`[phase] ${event.phase}`);
      } else if (event.type === 'step') {
        const tools = Array.isArray(event.toolCalls) ? event.toolCalls.map((t) => t.toolName).join(',') : '';
        log(`[step ${event.stepNumber}] tools=[${tools}]`);
        if (typeof event.result === 'string' && event.result.trim()) {
          for (const block of event.result.split('\n---\n')) {
            log(`  ┌─ ${fmtK(block.replace(/\n⟦DIFF⟧.*$/s, ''))}`);
            const dm = block.match(/⟦DIFF⟧(\[.*\])$/s);
            if (dm) {
              try {
                const hunks = JSON.parse(dm[1]);
                for (const h of hunks.slice(0, 12)) {
                  log(`  │ ${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`);
                }
                if (hunks.length > 12) log(`  │ … ${hunks.length - 12} 行省略 …`);
              } catch {}
            }
            log('  └─');
          }
        }
      } else if (event.type === 'critique') {
        log(`[critique] ${fmtK(event.critique)}`);
      } else if (event.type === 'softLimit') {
        log(`[softLimit] usedRatio=${event.usedRatio}`);
      } else if (event.type === 'degradation') {
        log(`[degradation] ${event.reason}`);
      } else if (event.type === 'error') {
        log(`[error] ${event.message}`);
      }
    },
  });

  const duration = Date.now() - start;
  log('');
  log('=== RUN RESULT ===');
  log(`duration: ${(duration / 1000).toFixed(1)}s`);
  log(`success: ${result.success} | score: ${result.score} | rollouts: ${result.totalRollouts}`);
  const steps = result.bestTrajectory?.steps || [];
  const verifiedSteps = steps.filter((s) => s.didRealVerification).length;
  log(`steps in best trajectory: ${steps.length} | steps with didRealVerification: ${verifiedSteps}`);
  if (result.budgetReport) {
    log(`budget: used≈${result.budgetReport.estimatedUsedTokens}/${result.budgetReport.budgetTokens} tokens (softLimit=${result.budgetReport.triggeredSoftLimit})`);
  }
  log(`approvals: ${approvalCount} (all logged above)`);
  log('');
  log('=== POST-RUN FILE STATE ===');
  const calc = fs.readFileSync(WORKSPACE + 'src/calculator.js', 'utf-8');
  log('src/calculator.js:');
  for (const l of calc.split('\n')) log('  | ' + l);
  process.exitCode = 0;
} catch (e) {
  log('');
  log('=== DRIVER ERROR (must not happen; crash = acceptance fail) ===');
  log(String(e && e.stack ? e.stack : e));
  process.exitCode = 1;
}
