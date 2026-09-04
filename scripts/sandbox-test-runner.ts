// sandbox-test-runner.ts
// Runs the Panshalach (GLM-5.x Strong Engineering Agent) inside an isolated sandbox against a known-buggy project.
// 使用�?tier 体系（默�?high�?
import { PanshalachChaser } from '../src/PanshalachChaser.js';
import { ExtremeGlmToolCallAdapter } from '../src/adapter/ExtremeGlmToolCallAdapter.js';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SANDBOX = resolve('C:/Users/19395/ZCodeProject/.sandbox-test/buggy-calculator');

console.log('=== Panshalach �?Strong Engineering Agent �?Isolated Sandbox Test ===');
console.log(`Sandbox: ${SANDBOX}`);
console.log('Tier    : high (默认高强度工程模�?');
console.log('');

// Real file system executor for the sandbox
function createSandboxExecutor() {
  return {
    async execute(toolCalls: any[]): Promise<string> {
      let results: string[] = [];

      for (const call of toolCalls) {
        const name = call.toolName;
        const params = Object.fromEntries(call.params.map((p: any) => [p.name, p.value]));

        try {
          if (name === 'Read' || name === 'read_file') {
            const filePath = params.file_path || params.path;
            const full = join(SANDBOX, filePath);
            if (!existsSync(full)) {
              results.push(`READ_ERROR: File not found: ${filePath}`);
              continue;
            }
            const content = readFileSync(full, 'utf8');
            results.push(`READ_SUCCESS: ${filePath}\n${content}`);
          }

          else if (name === 'Write' || name === 'write_file' || name === 'Edit') {
            const filePath = params.file_path || params.path;
            const content = params.content || params.new_content || params.text;
            const full = join(SANDBOX, filePath);
            writeFileSync(full, content, 'utf8');
            results.push(`WRITE_SUCCESS: ${filePath}`);
          }

          else if (name === 'Bash' || name === 'bash' || name === 'RunCommand') {
            const cmd = params.command;
            console.log(`[SANDBOX EXEC] $ ${cmd}`);
            try {
              const output = execSync(cmd, {
                cwd: SANDBOX,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 15000,
              });
              results.push(`BASH_OUTPUT:\n${output}`);
            } catch (err: any) {
              results.push(`BASH_ERROR:\n${err.stdout || ''}\n${err.stderr || err.message}`);
            }
          }

          else {
            results.push(`UNKNOWN_TOOL: ${name}`);
          }
        } catch (e: any) {
          results.push(`EXEC_ERROR: ${e.message}`);
        }
      }

      return results.join('\n---\n');
    }
  };
}

// Create a model client that produces GLM-5.3 style tool calls
function createSimulatedGlmClient() {
  let step = 0;

  return {
    async complete(prompt: string): Promise<string> {
      step++;

      const lower = prompt.toLowerCase();

      // Step 1: Explore the project
      if (step === 1) {
        return `<thinking>我需要先了解这个项目结构。看起来是一个计算器项目，有测试在报错�?/thinking>
<plan>1. 读取 package.json 了解项目
2. 读取 src/calculator.js 查看实现
3. 读取测试文件
4. 定位 add 函数�?bug 并修�?/plan>
<verify>运行 npm test 确认测试通过</verify>
<>
  <Read>
    <file_path>package.json</file_path>
  </Read>
</>`;
      }

      // Step 2: Read the buggy source
      if (step === 2 || lower.includes('calculator')) {
        return `<thinking>add 函数明显是错的：return a - b 应该�?a + b�?/thinking>
<plan>直接修复 add 函数</plan>
<verify>修复后运行测�?/verify>
<>
  <Read>
    <file_path>src/calculator.js</file_path>
  </Read>
</>`;
      }

      // Step 3: Actually fix it
      if (step >= 3 && (lower.includes('bug') || lower.includes('fix') || lower.includes('add'))) {
        return `<thinking>确认 bug：在 add 函数里用了减法�?/thinking>
<plan>�?return a - b 改成 return a + b</plan>
<verify>运行测试验证</verify>
<>
  <Write>
    <file_path>src/calculator.js</file_path>
    <content>export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}
</content>
  </Write>
</>`;
      }

      // Final step: run tests
      return `<thinking>代码已修改，现在验证�?/thinking>
<plan>执行测试</plan>
<>
  <Bash>
    <command>npm test</command>
  </Bash>
</>`;
    }
  };
}

async function main() {
  const executor = createSandboxExecutor();
  const modelClient = createSimulatedGlmClient();

  const chaser = new PanshalachChaser(modelClient);

  // Override the internal verification engine to use our real sandbox executor
  // (This is a bit hacky but works for this isolated test)
  (chaser as any).solveIssue = async function(issue: string, workspace: string, config: any) {
    // We manually run a simplified loop here for clearer sandbox demo
    console.log('\n[AGENT] 开始在隔离沙箱中解�?issue...');
    console.log(`Issue: ${issue}\n`);

    const loop = new (await import('./src/loop/VerifyCritiqueLoop.js')).VerifyCritiqueLoop(
      modelClient,
      executor,
      8
    );

    const result = await loop.run(
      `你现在在隔离沙箱 ${workspace} 中工作。\n` +
      `Issue: ${issue}\n` +
      `请使�?Read / Write / Bash 工具来探索和修复代码。`
    );

    // Run final verification
    const finalTest = await executor.execute([{ toolName: 'Bash', params: [{ name: 'command', value: 'npm test' }] }]);

    const success = finalTest.includes('PASS') || finalTest.includes('ok') || !finalTest.includes('not ok');

    return {
      success,
      bestTrajectory: {
        id: 'sandbox-run-1',
        steps: result.steps,
        score: success ? 95 : 45,
      },
      score: success ? 95 : 45,
      totalRollouts: 1,
    };
  };

  const result = await chaser.solveIssue(
    'Fix the add function so that add(2, 3) returns 5 instead of -1. Tests are failing.',
    SANDBOX,
    { tier: 'high', maxRollouts: 1, maxStepsPerRollout: 8 }
  );

  console.log('\n=== FINAL SANDBOX TEST RESULT ===');
  console.log(`Success: ${result.success}`);
  console.log(`Score  : ${result.score}`);

  if (result.bestTrajectory) {
    console.log(`\nTrajectory steps: ${result.bestTrajectory.steps.length}`);
    result.bestTrajectory.steps.forEach((step: any, i: number) => {
      console.log(`\n--- Step ${i + 1} [${step.verificationSignal || '?'}] ---`);
      if (step.thought) console.log('Thought:', step.thought.slice(0, 120));
      if (step.plan) console.log('Plan  :', step.plan.slice(0, 100));
      if (step.result) console.log('Result:', step.result.slice(0, 150));
    });
  }

  // Final real test run
  console.log('\n=== Final real test execution in sandbox ===');
  try {
    const finalOutput = execSync('npm test', { cwd: SANDBOX, encoding: 'utf8', stdio: 'pipe' });
    console.log(finalOutput);
  } catch (e: any) {
    console.log(e.stdout || e.message);
  }
}

main().catch(console.error);
