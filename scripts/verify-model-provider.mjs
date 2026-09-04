// scripts/verify-model-provider.mjs
// Pure-Node (no tsx, no child spawn) verification for P3 ModelProvider blueprint.
// Uses built dist only. Exits 0 on success.

import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const root = process.cwd();

async function load() {
  const typesUrl = pathToFileURL(pathResolve(root, 'dist/cli/repl/types.js')).href;
  const provUrl = pathToFileURL(pathResolve(root, 'dist/cli/repl/ModelProvider.js')).href;
  const chaserUrl = pathToFileURL(pathResolve(root, 'dist/PanshalachChaser.js')).href;

  const [typesMod, provMod, chaserMod] = await Promise.all([
    import(typesUrl),
    import(provUrl),
    import(chaserUrl),
  ]);

  return {
    DefaultModelProvider: provMod.DefaultModelProvider || provMod.createDefaultModelProvider && (await import(provUrl)).createDefaultModelProvider,
    createDefaultModelProvider: provMod.createDefaultModelProvider,
    PanshalachChaser: chaserMod.PanshalachChaser,
  };
}

async function main() {
  const { createDefaultModelProvider, PanshalachChaser } = await load();

  // 1) Basic provider creation and default behavior (no fallback)
  const p1 = createDefaultModelProvider();
  if (!Array.isArray(p1.listModels())) { console.error('FAIL listModels type'); process.exit(1); }
  if (p1.isModelAvailable('default')) { console.error('FAIL default should be unavailable without fallback'); process.exit(1); }
  if (p1.createClient('default') !== null) { console.error('FAIL createClient default without fallback'); process.exit(1); }
  if (p1.createDefaultClient() !== null) { console.error('FAIL createDefaultClient without fallback'); process.exit(1); }

  // 2) Provider with fallbackComplete
  let called = 0;
  const fb = async (prompt) => { called++; return 'FB:' + String(prompt).slice(0, 5); };
  const p2 = createDefaultModelProvider({ fallbackComplete: fb });
  const c2 = p2.createClient('default');
  if (!c2 || typeof c2.complete !== 'function') { console.error('FAIL fallback client'); process.exit(1); }
  const r2 = await c2.complete('hello');
  if (r2 !== 'FB:hello') { console.error('FAIL fallback result'); process.exit(1); }
  if (called < 1) { console.error('FAIL fallback not called'); process.exit(1); }

  // 3) Register a named client and isModelAvailable / create
  const p3 = createDefaultModelProvider();
  p3.register('maoyulin', () => ({ async complete() { return 'MAO'; } }));
  if (!p3.isModelAvailable('maoyulin')) { console.error('FAIL registered available'); process.exit(1); }
  const c3 = p3.createClient('maoyulin');
  if (!c3) { console.error('FAIL create registered'); process.exit(1); }
  const r3 = await c3.complete('x');
  if (r3 !== 'MAO') { console.error('FAIL registered result'); process.exit(1); }

  // 4) Unknown name -> null
  if (p3.createClient('ghost') !== null) { console.error('FAIL unknown name'); process.exit(1); }

  // 5) createDefaultClient falls back to fallbackComplete when default not usable
  const p4 = createDefaultModelProvider({ fallbackComplete: async () => 'FB2' });
  const c4 = p4.createDefaultClient();
  if (!c4) { console.error('FAIL default fallback to fb'); process.exit(1); }

  // 6) PanshalachChaser NO_MODEL_CLIENT defense
  const bad = new PanshalachChaser(null, 'high');
  const resBad = await bad.solveIssue('x', process.cwd(), { tier: 'high', yes: true });
  if (resBad.error !== 'NO_MODEL_CLIENT') { console.error('FAIL NO_MODEL_CLIENT not returned'); process.exit(1); }
  if (resBad.success !== false) { console.error('FAIL NO_MODEL_CLIENT success flag'); process.exit(1); }

  // 7) PanshalachChaser with valid client works (mock)
  let completeCalls = 0;
  const goodClient = {
    async complete(prompt) {
      completeCalls++;
      // Return a minimal response that downstream can tolerate (string is fine)
      return 'OK ' + String(prompt).slice(0, 20);
    }
  };
  const good = new PanshalachChaser(goodClient, 'high');
  // We only care it does not throw on entry and returns a result object (may be partial due to missing tools etc.)
  const resGood = await good.solveIssue('dummy task', process.cwd(), { tier: 'high', yes: true, maxRollouts: 1, maxStepsPerRollout: 1 });
  if (resGood && typeof resGood === 'object' && 'score' in resGood) {
    // ok
  } else {
    console.error('FAIL good client did not return result object');
    process.exit(1);
  }

  console.error('P3 ModelProvider checks:');
  console.error('  default unavailable without fallback: OK');
  console.error('  fallbackComplete wraps to client: OK');
  console.error('  register + isAvailable + create: OK');
  console.error('  unknown -> null: OK');
  console.error('  createDefaultClient fallback chain: OK');
  console.error('  PanshalachChaser NO_MODEL_CLIENT defense: OK');
  console.error('  PanshalachChaser with client does not explode: OK');
  console.error('P3 ModelProvider OK');
}

main().catch(e => { console.error(e); process.exit(1); });
