// tests/loop/FormatPromptCooperation.test.ts
// T1 格式教学重构（openPangu 工具调用配合度修复）红→绿锁定：
//  - 首句换为 V1 实证措辞（V1 3/3 零警告 vs 现状 1/3）；
//  - read_file 示例恒有（实证：bash 独苗示例 → 模型 18/18 全选 bash）；
//  - edit_file/glob/bash 按可用工具追加完整参数示例；
//  - 示例参数值用中性占位（实证：示例值会泄漏进模型输出）；
//  - 文本协议参数渲染：每工具一行"工具名 — 用途（参数：...）"（修"模型看不到参数名"）；
//  - schema 注入时用途/参数名从 schema 取（MCP 空壳 description 用兜底文案）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredReasoner } from '../../src/reasoning/StructuredReasoner.js';

const FULL_LIST = ['bash', 'read_file', 'glob', 'grep', 'write_file', 'edit_file'];

describe('T1 格式教学重构（buildToolCallFormatEnforcementPrompt）', () => {
  it('首句为 V1 实证措辞：只输出一个工具调用块 + 可用工具清单', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(FULL_LIST);
    assert.ok(
      p.includes('你必须只输出一个工具调用块，不要输出任何解释文字。可用工具：'),
      `首句必须是 V1 实证措辞，got: ${p.slice(0, 200)}`
    );
    assert.ok(p.includes('read_file'), '可用工具清单必须列出工具名');
  });

  it('read_file 示例恒有（即使可用清单只有 bash）', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(['bash']);
    assert.ok(p.includes('<read_file>'), 'read_file 示例必须恒在（工具选择正确性的关键 few-shot）');
    assert.ok(p.includes('<file_path>'), 'read_file 示例必须带参数');
    assert.ok(p.includes('<bash>'), 'bash 可用 → bash 示例也在');
  });

  it('edit_file / glob 可用时各追加完整参数示例', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(FULL_LIST);
    assert.ok(p.includes('<edit_file>'), 'edit_file 可用 → 必须有 edit_file 示例');
    assert.ok(p.includes('<old_string>'), 'edit_file 示例必须带 old_string');
    assert.ok(p.includes('<new_string>'), 'edit_file 示例必须带 new_string');
    assert.ok(p.includes('<glob>'), 'glob 可用 → 必须有 glob 示例');
    assert.ok(p.includes('<pattern>'), 'glob 示例必须带 pattern');
  });

  it('bash 独占清单（无 glob/edit）→ 不出现对应示例（防诱导不可用工具）', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(['bash', 'read_file']);
    assert.ok(!p.includes('<edit_file>'), 'edit_file 不可用 → 不得出示例（防 UNKNOWN_TOOL 空转）');
    assert.ok(!p.includes('<glob>'), 'glob 不可用 → 不得出示例');
  });

  it('示例参数值用中性占位（防示例值泄漏进模型输出）', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(FULL_LIST);
    assert.ok(p.includes('sample.txt'), '文件占位必须是 sample.txt');
    assert.ok(p.includes('待替换的原文'), 'old_string 占位必须是中性文案');
    assert.ok(!p.includes('src/index.ts'), '不得出现具体项目路径（实证泄漏源）');
    assert.ok(!p.includes('notes.txt'), '不得出现旧示例值 notes.txt');
  });

  it('文本协议参数渲染：每个可用工具一行"工具名 — 用途（参数：…）"', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(FULL_LIST);
    assert.match(p, /read_file — .+（参数：file_path, offset, limit）/, 'read_file 速览行');
    assert.match(p, /bash — .+（参数：command）/, 'bash 速览行');
    assert.match(p, /grep — .+（参数：pattern/, 'grep 速览行（参数名可见——修文本协议参数盲区）');
  });

  it('schema 注入：用途取 description 首行、参数名从 schema 取（不写死）', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(['my_tool', 'bash'], {
      schemaById: {
        my_tool: {
          description: '部署静态站点到边缘节点。\n第二行不该出现',
          parameters: {
            type: 'object',
            properties: { target: { type: 'string' }, region: { type: 'string' }, token: { type: 'string' } },
            required: ['target'],
          },
        },
        bash: { description: 'x', parameters: { type: 'object', properties: {} } },
      },
    });
    assert.match(p, /my_tool — 部署静态站点到边缘节点。?（参数：target, region, token）/, 'description 首行 + 全部参数名');
    assert.ok(!p.includes('第二行不该出现'), '用途只取 description 首行');
  });

  it('MCP 空壳 description 用兜底文案（不出现"undefined/空破折号"）', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(['mcp_fs_read'], {
      schemaById: { mcp_fs_read: { description: '', parameters: { type: 'object', properties: {} } } },
    });
    assert.match(p, /mcp_fs_read — .+/, '未知工具必须有速览行');
    assert.ok(!p.includes('undefined'), '不得出现 undefined 字样');
  });

  it('prompt 总增量受控：全工具清单下速览区 ≤ ~600 字符', () => {
    const p = StructuredReasoner.buildToolCallFormatEnforcementPrompt(FULL_LIST);
    const m = /各工具用途与参数[\s\S]*?\n\n/.exec(p);
    assert.ok(m, '必须存在速览区块');
    assert.ok(
      m[0].length <= 700,
      `速览区（含标题行）应 ≤ ~600 字符，got ${m[0].length}: ${m[0]}`
    );
  });
});
