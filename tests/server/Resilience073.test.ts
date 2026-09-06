// tests/server/Resilience073.test.ts
// 0.7.3 T2#6 / T2#8 / T3#11 / T3#12 行为锁定（runAgentTask / ModelProvider /
// ConfigManager / Session 层）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractWrittenFilePaths, resolveWindowTokens } from '../../src/server/runAgentTask.js';
import { appendProjectApprovalAllowlist } from '../../src/cli/repl/ConfigManager.js';
import { Session } from '../../src/cli/repl/Session.js';
import { resolveSharedClient } from '../../src/cli/repl/ModelProvider.js';

const TMP_DIRS: string[] = [];
function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-073srv-'));
  TMP_DIRS.push(d);
  return d;
}

afterEach(() => {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  TMP_DIRS.length = 0;
});

describe('0.7.3 T3#11 写集提取修正则', () => {
  function trajWithCmd(cmd: string): any {
    return { steps: [{ action: [{ toolName: 'bash', params: [{ name: 'command', value: cmd }] }] }] };
  }

  it('引号内空格：> "my file.txt" 整体捕获', () => {
    const out = extractWrittenFilePaths(trajWithCmd('echo hi > "my file.txt"'));
    assert.ok(out.includes('my file.txt'), `实际: ${JSON.stringify(out)}`);
  });

  it('Windows 盘符：> C:\\dir\\a.txt 不被截断', () => {
    const out = extractWrittenFilePaths(trajWithCmd('echo hi > C:\\dir\\a.txt'));
    assert.ok(out.includes('C:\\dir\\a.txt'), `实际: ${JSON.stringify(out)}`);
  });

  it('>> 追加重定向 与 tee / tee -a 均识别', () => {
    const append = extractWrittenFilePaths(trajWithCmd('echo x >> log.txt'));
    assert.ok(append.includes('log.txt'));

    const tee = extractWrittenFilePaths(trajWithCmd('make | tee build.log'));
    assert.ok(tee.includes('build.log'), `实际: ${JSON.stringify(tee)}`);

    const teeA = extractWrittenFilePaths(trajWithCmd('npm test 2>&1 | tee -a test-run.log'));
    assert.ok(teeA.includes('test-run.log'), `实际: ${JSON.stringify(teeA)}`);
    assert.ok(!teeA.includes('&1'), '2>&1 不得误收为文件');
  });

  it('write_file 参数路径仍原样提取（回归）', () => {
    const out = extractWrittenFilePaths({
      steps: [{ action: [{ toolName: 'write_file', params: [
        { name: 'file_path', value: 'src/foo.ts' },
        { name: 'content', value: 'x' },
      ] }] }],
    });
    assert.deepEqual(out, ['src/foo.ts']);
  });
});

describe('0.7.3 T3#12 \'a\' 决策持久化', () => {
  it('appendProjectApprovalAllowlist：新建/合并/去重，Session 启动加载回 allowlist', () => {
    const ws = tmpWs();

    // 1) 项目配置不存在 → 创建并写入
    assert.equal(appendProjectApprovalAllowlist(ws, 'bash'), true);
    let cfg: any = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach.json'), 'utf-8'));
    assert.deepEqual(cfg.approvalAllowlist, ['bash']);

    // 2) 已有其它配置字段 → 深度保留 + 追加
    cfg.model = 'test-model';
    fs.writeFileSync(path.join(ws, '.panshalach.json'), JSON.stringify(cfg), 'utf-8');
    assert.equal(appendProjectApprovalAllowlist(ws, 'write_file'), true);
    cfg = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach.json'), 'utf-8'));
    assert.equal(cfg.model, 'test-model', '既有字段不丢');
    assert.deepEqual(cfg.approvalAllowlist, ['bash', 'write_file']);

    // 3) 去重
    assert.equal(appendProjectApprovalAllowlist(ws, 'BASH'), true);
    cfg = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach.json'), 'utf-8'));
    assert.deepEqual(cfg.approvalAllowlist, ['bash', 'write_file']);

    // 4) 会话启动加载（并集：显式 init 保留 + 项目配置并入）
    const s = new Session({ workspace: ws, sessionApprovalAllowlist: ['grep'] } as any);
    assert.ok(s.sessionApprovalAllowlist.has('grep'), '显式传入保留');
    assert.ok(s.sessionApprovalAllowlist.has('bash') && s.sessionApprovalAllowlist.has('write_file'),
      '项目配置持久化的 \'a\' 决策加载进 sessionAllowlist');
  });

  it('损坏的项目配置 → 加载静默为空，不阻塞会话启动', () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, '.panshalach.json'), '{ broken json', 'utf-8');
    const s = new Session({ workspace: ws } as any);
    assert.equal(s.sessionApprovalAllowlist.size, 0);
  });
});

describe('0.7.3 T2#6 resolveWindowTokens（unknown → 32768 保守值）', () => {
  it('provider 真值优先；≤0 / ===256000 / 异常 → 32768', () => {
    const ok = { getModelContextLength: () => 8192 };
    assert.equal(resolveWindowTokens(ok as any, 'm'), 8192);
    assert.equal(resolveWindowTokens({ getModelContextLength: () => 0 } as any, 'm'), 32768);
    assert.equal(resolveWindowTokens({ getModelContextLength: () => 256000 } as any, 'm'), 32768, '遗留 256000 哨兵视为 unknown');
    assert.equal(resolveWindowTokens({ getModelContextLength: () => { throw new Error('x'); } } as any, 'm'), 32768);
    assert.equal(resolveWindowTokens(undefined, 'm'), 32768);
  });
});

describe('0.7.3 T2#8 首跑报错质量', () => {
  it('resolveSharedClient 无可用模型 → 报错文案含三选一指引', async () => {
    const empty = {
      createClient: () => null,
      createDefaultClient: () => null,
      invalidateProviderCache: () => {},
    };
    await assert.rejects(
      () => resolveSharedClient('no-such-model', empty as any),
      (err: any) => {
        const m = String(err?.message || '');
        return m.includes('.panshalach.json') && m.includes('/model list') && m.includes('~/.panshalach/config.json');
      }
    );
  });
});
