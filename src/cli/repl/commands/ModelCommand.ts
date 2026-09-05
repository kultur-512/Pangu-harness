// src/cli/repl/commands/ModelCommand.ts
import type { Command, CommandContext, CommandResult, ModelProvider } from '../types.js';
import { ConfigManager } from '../ConfigManager.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// S2: module-private last /models error — never on globalThis (cross-session leak).
let lastScnetListError: string | null = null;

const command: Command = {
  name: 'model',
  description: '查看或切换模型；/model list 拉取远程模型列表',
  category: 'state',
  usage: '/model [name|list]   例如: /model list 或 /model openPangu-7B 或 /model scnet:<模型名>',
  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const provider: ModelProvider | undefined = ctx.provider || ctx.session.provider;

    // Always attempt to pick up a freshly created .panshalach.json or newly set env var
    // as soon as the user touches /model at all. This is the most common "I just configured it" flow.
    try {
      const active = ctx.provider || ctx.session.provider;
      if (active && typeof (active as any).invalidateProviderCache === 'function') {
        (active as any).invalidateProviderCache();
      }
    } catch {}

    if (!args[0]) {
      ctx.renderer.writeLine(`当前模型: ${ctx.session.model}`);
      if (provider) {
        const models = provider.listModels?.() || [];
        ctx.renderer.info('已注册/可用入口: ' + models.join(', '));
      }
      return {};
    }

    const sub = args[0];

    // /model list  -> list remote models for scnet (or current provider)
    if (sub === 'list' || sub === 'ls') {
      if (!provider) {
        ctx.renderer.warn('当前没有注入 ModelProvider，无法列出远程模型。');
        return {};
      }

      const ws = ctx.session.workspace || process.cwd();

      // === Direct raw load of .panshalach.json from the workspace (ignores any caching / BOM issues) ===
      // S1: diagnostics carry error TYPES only — never config content / key material / file snippets.
      let scnetCfg: any = null;
      let rawLoadDiag = '';
      try {
        const projPath = join(ws, '.panshalach.json');
        if (existsSync(projPath)) {
          let buf = readFileSync(projPath);
          // strip UTF-8 BOM bytes
          if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
            buf = buf.slice(3);
          }
          const hadBomBytes = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
          let txt = buf.toString('utf-8');
          txt = txt.trim();

          let parsed: any = null;
          try {
            parsed = JSON.parse(txt);
          } catch (pe: any) {
            rawLoadDiag = 'JSON.parse failed: ' + (pe?.message || pe);
          }

          if (parsed) {
            const sc = parsed.providers && parsed.providers.scnet;
            if (sc && sc.apiKey) {
              scnetCfg = { ...sc };
              rawLoadDiag = `raw-json ok (bom=${hadBomBytes})`;
            } else if (sc) {
              rawLoadDiag = `raw-json parsed, scnet present but no apiKey (bom=${hadBomBytes})`;
            } else if (parsed.providers) {
              rawLoadDiag = `raw-json parsed, providers present but no scnet (bom=${hadBomBytes})`;
            } else {
              rawLoadDiag = `raw-json parsed but no providers section (bom=${hadBomBytes})`;
            }
          }
        } else {
          rawLoadDiag = 'raw file not found at ' + join(ws, '.panshalach.json');
        }
      } catch (e: any) {
        rawLoadDiag = 'raw read error: ' + (e?.message || e);
      }

      // If no key in file, fall back to env
      if (!scnetCfg) {
        const envKey = process.env.SCNET_API_KEY || process.env.SCNET_KEY;
        if (envKey) {
          scnetCfg = {
            type: 'openai-compatible',
            baseUrl: 'https://api.scnet.cn/api/llm/v1',
            apiKey: envKey,
          };
          rawLoadDiag += ' (from env)';
        }
      }

      // Force into the running provider so createClient("scnet") etc. works immediately
      if (scnetCfg?.apiKey) {
        try {
          const active = ctx.provider || ctx.session.provider;
          if (active && typeof (active as any).forceScnetConfig === 'function') {
            (active as any).forceScnetConfig(scnetCfg);
          }
          if (active && typeof (active as any).invalidateProviderCache === 'function') {
            (active as any).invalidateProviderCache();
          }
        } catch {}
      }

      // Invalidate any old cache
      try {
        if (typeof (provider as any).invalidateProviderCache === 'function') {
          (provider as any).invalidateProviderCache();
        }
      } catch {}

      let targetProvider = 'scnet';
      if (ctx.session.model && ctx.session.model.includes(':')) {
        targetProvider = ctx.session.model.split(':')[0];
      }

      ctx.renderer.info(`正在从 "${targetProvider}" 拉取模型列表...`);

      // === Primary path: direct fetch using the config we just discovered from the workspace ===
      // contextLength 允许 null——未知窗口持久化为 null（不再写 256000
      // 哨兵），预算侧把 null/≤0/256000 一律视为 unknown → 32768 保守值。
      let listed: Array<{ id: string; contextLength?: number | null }> | null = null;

      if (targetProvider === 'scnet' && scnetCfg?.apiKey) {
        // S1: never echo key material (masked or not) to the terminal.
        try {
          ctx.renderer.writeLine('[scnet] 已读取工作区密钥，直接调用 /models ...');
        } catch {}

        try {
          const base = (scnetCfg.baseUrl || 'https://api.scnet.cn/api/llm/v1').replace(/\/+$/, '');
          const url = base + '/models';

          const res = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${scnetCfg.apiKey}` },
          });

          if (res.ok) {
            const json: any = await res.json().catch(() => ({}));
            let data: any[] = [];
            if (Array.isArray(json)) {
              data = json;
            } else if (Array.isArray(json?.data)) {
              data = json.data;
            } else if (Array.isArray(json?.models)) {
              data = json.models;
            }
            const ids: string[] = [];
            for (const item of data) {
              if (item && typeof item === 'string') ids.push(item);
              else if (item && typeof item.id === 'string') ids.push(item.id);
            }
            if (ids.length > 0) {
              const ctxMap = scnetCfg.modelContexts || {};
              listed = ids.map((id: string) => ({ id, contextLength: (typeof ctxMap[id] === 'number' && ctxMap[id] > 0) ? ctxMap[id] : null }));
            }
          } else {
            lastScnetListError = `${res.status} ${res.statusText}`;
          }
        } catch (e: any) {
          lastScnetListError = e?.message || String(e);
        }
      }

      // Fallbacks to provider methods (in case direct fetch had issues but provider now has the config)
      if (!listed) {
        try {
          if (typeof (provider as any).listProviderModelsWithContext === 'function') {
            listed = await (provider as any).listProviderModelsWithContext(targetProvider);
          }
        } catch {}
      }
      if (!listed) {
        try {
          if (typeof (provider as any).listProviderModels === 'function') {
            const ids = await (provider as any).listProviderModels(targetProvider);
            if (ids?.length) {
              // listProviderModels 不带上下文信息 → 未知，持久化 null
              listed = ids.map((id: string) => ({ id, contextLength: null }));
            }
          }
        } catch {}
      }

      if (!listed || listed.length === 0) {
        const wsForCheck = ws;
        let hasKey = false;
        try {
          const cm2 = new ConfigManager(wsForCheck);
          const a = cm2.getAll();
          if (a.providers?.scnet?.apiKey) hasKey = true;
        } catch {}

        const envHasKey = !!(process.env.SCNET_API_KEY || process.env.SCNET_KEY);

        // IMPORTANT: also trust the direct/raw load we did at the top of this command.
        // The raw path + regex fallback may have found the key even if ConfigManager (for whatever reason) didn't.
        const directHasKey = !!(scnetCfg && scnetCfg.apiKey);

        const effectiveHasKey = hasKey || envHasKey || directHasKey;

        if (targetProvider === 'scnet') {
          if (!effectiveHasKey) {
            ctx.renderer.warn('未能从 "scnet" 拉取模型列表。');
            ctx.renderer.writeLine(`原因：当前会话工作区 (${wsForCheck}) 没有找到有效的 scnet 密钥，当前进程也没有 SCNET_API_KEY。`);
            ctx.renderer.writeLine('');
            if (rawLoadDiag) {
              ctx.renderer.writeLine(`诊断: ${rawLoadDiag}`);
            }
            ctx.renderer.writeLine('');
            ctx.renderer.writeLine('推荐做法：');
            ctx.renderer.writeLine('  1. 确认文件存在： ' + join(wsForCheck, '.panshalach.json'));
            ctx.renderer.writeLine('  2. 退出并重启 Panshalach（新进程启动时会正确加载）：');
            ctx.renderer.writeLine('       /exit');
            ctx.renderer.writeLine('       npm run build');
            ctx.renderer.writeLine('       # 然后启动 pangu');
            ctx.renderer.writeLine('  3. 启动后直接： /model list 拉取模型，然后 /model scnet:<模型名> 或 /model <模型名> 切换');
            ctx.renderer.writeLine('');
            ctx.renderer.writeLine('或者临时用环境变量快速验证：');
            ctx.renderer.writeLine('       $env:SCNET_API_KEY="sk-tp-你的密钥"; pangu');
          } else {
            const lastErr = lastScnetListError;
            ctx.renderer.warn('未能从 "scnet" 拉取到模型列表（检测到密钥，但 /models 调用失败）。');
            if (rawLoadDiag) {
              ctx.renderer.writeLine(`诊断: ${rawLoadDiag}`);
            }
            if (lastErr) ctx.renderer.writeLine('最后错误: ' + lastErr);
            ctx.renderer.writeLine('可能原因：网络、密钥对应的计划不支持列模型、接口返回空、或需要特定请求头。');
            ctx.renderer.writeLine('即使列表失败，你也可以尝试： /model scnet:<模型名>  （使用配置里 /models 返回的具体模型名）。');
          }
        } else {
          ctx.renderer.warn(`未能从 "${targetProvider}" 拉取到模型列表。`);
        }
        return {};
      }

      // Success
      ctx.renderer.writeLine(`远程模型列表 (${targetProvider})：`);
      for (const m of listed) {
        // 未知上下文如实显示"未知"（不再冒充 256K）
        const k = (typeof m.contextLength === 'number' && m.contextLength > 0)
          ? `${Math.round(m.contextLength / 1000)}K`
          : '未知';
        ctx.renderer.writeLine(`  - ${m.id}  (上下文 ~${k})`);
      }

      // Persist + adopt
      try {
        const projPath = join(ws, '.panshalach.json');
        let proj: any = {};
        if (existsSync(projPath)) {
          try {
            let txt = readFileSync(projPath, 'utf-8');
            if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
            proj = JSON.parse(txt.trim());
          } catch {}
        }
        if (!proj.providers) proj.providers = {};
        if (!proj.providers[targetProvider]) proj.providers[targetProvider] = { type: 'openai-compatible', baseUrl: 'https://api.scnet.cn/api/llm/v1' };
        proj.providers[targetProvider].models = listed.map(m => m.id);
        if (!proj.providers[targetProvider].modelContexts) proj.providers[targetProvider].modelContexts = {};
        // 未知上下文持久化 null（不再写 256000 哨兵）——
        // null 会被 typeof 检查自然跳过，预算侧回落 32768 保守值。
        for (const m of listed) {
          proj.providers[targetProvider].modelContexts[m.id] =
            (typeof m.contextLength === 'number' && m.contextLength > 0) ? m.contextLength : null;
        }
        writeFileSync(projPath, JSON.stringify(proj, null, 2), 'utf-8');
        ctx.renderer.info(`已保存到 ${projPath}`);
      } catch (e: any) {
        ctx.renderer.warn('保存失败: ' + (e?.message || e));
      }

      try {
        const active = ctx.provider || ctx.session.provider;
        if (active && typeof (active as any).adoptRemoteModels === 'function') {
          const map: Record<string, number> = {};
          for (const m of listed) {
            if (typeof m.contextLength === 'number' && m.contextLength > 0) map[m.id] = m.contextLength;
          }
          (active as any).adoptRemoteModels(targetProvider, listed.map(m => m.id), map);
        }
        ctx.renderer.info('已载入当前会话，可直接使用 /model <模型名>（例如 /model openPangu-7B）。');
      } catch {}

      return {};
    }

    // Normal switch
    let name = sub;

    // Normalize "scnet:xxx" → bare name.
    // Explicit model names like "openPangu-7B" are passed through as-is.
    if (name.startsWith('scnet:')) {
      name = name.slice(6);
    }

    // Pre-validate with provider before switching
    if (provider && typeof provider.isModelAvailable === 'function') {
      const okDirect = provider.isModelAvailable(name);
      const okScnet = provider.isModelAvailable('scnet:' + name);
      if (!okDirect && !okScnet) {
        const avail = (provider.listModels?.() || []).join(', ');

        // Special helpful message when switching to the bare scnet provider name
        const isScnetEntry = (name === 'scnet');
        // For the scnet entry we always talk about scnet as the backend
        if (isScnetEntry) {
          ctx.renderer.warn(`模型 "scnet" 不可用（尚未配置 scnet 供应商）。`);
          ctx.renderer.writeLine('');
          ctx.renderer.writeLine('要使用 /model scnet 直连 scnet 的模型，请先配置密钥：');
          ctx.renderer.writeLine('');
          ctx.renderer.writeLine('方法一（推荐，立即生效，下次启动自动读取）：');
          ctx.renderer.writeLine('  在当前目录创建 .panshalach.json，内容例如：');
          ctx.renderer.writeLine('  {');
          ctx.renderer.writeLine('    "providers": {');
          ctx.renderer.writeLine('      "scnet": {');
          ctx.renderer.writeLine('        "type": "openai-compatible",');
          ctx.renderer.writeLine('        "baseUrl": "https://api.scnet.cn/api/llm/v1",');
          ctx.renderer.writeLine('        "apiKey": "sk-tp-你的密钥"');
          ctx.renderer.writeLine('      }');
          ctx.renderer.writeLine('    }');
          ctx.renderer.writeLine('  }');
          ctx.renderer.writeLine('');
          ctx.renderer.writeLine('方法二（临时）：');
          ctx.renderer.writeLine('  $env:SCNET_API_KEY="sk-tp-你的密钥"');
          ctx.renderer.writeLine('  然后重新启动 pangu');
          ctx.renderer.writeLine('');
          ctx.renderer.writeLine('配置好后先 /model list 拉取模型列表，再 /model scnet:<模型名> 切换（会自动热加载最新配置）。');
          return {};
        }

        ctx.renderer.warn(`模型 "${name}" 不可用。可选: ${avail || '(无)'}  （可用 /model list 刷新远程列表）`);
        return {};
      }
    }

    ctx.session.updateModel(name);

    // Resolve the effective model for better UX (e.g. provider-prefixed or bare-provider names)
    let displayName = name;
    try {
      const active = ctx.provider || ctx.session.provider;
      if (active && typeof (active as any).getEffectiveModel === 'function') {
        const eff = (active as any).getEffectiveModel(name);
        if (eff && eff !== name) {
          displayName = `${name} → ${eff}`;
        }
      }
    } catch {}

    ctx.renderer.success(`模型已切换到: ${displayName}`);
    return {};
  },
};

export default command;
