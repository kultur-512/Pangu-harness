# 烛龙（Zhulong）部署指南（DEPLOY-CN）

> 内部代号 Panshalach · 基于 openPangu 的记忆增强通用智能体（产品名烛龙 Zhulong）。
> 部署基线：**v0.8.0-rc**；`npm run build` 后 bin 指向 dist/（src 有更新时启动会出现 dist-fresh 黄字提醒）。
> **状态口径**：§1–§4 为**本机已验证路径**（Windows + Node 22 + LM Studio 本地 openPangu 端点，见 CHANGELOG 0.6.4/0.6.5/0.7.x 记录）；§5 昇腾与 §6 麒麟/国产 OS 为**标准流程框架，待端点/整机实测验证**，文中显著标注，不作为已完成能力声明。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 18**（需全局 fetch；开发实测 **Node 22**） |
| 操作系统 | Windows / Linux / macOS（§6 覆盖麒麟等国产 OS 路径） |
| 构建 | TypeScript 5.6（devDependency，仅构建期需要） |
| 运行时依赖 | **零运行时依赖**（`dependencies: {}`）；ink/react/chalk/ora/prompts 为可选富 UI（optionalDependencies，非 TTY 自动降级行模式） |
| 推理端点 | openPangu 端点（本机 LM Studio/vLLM，或昇腾 vLLM-ascend / MindIE），OpenAI 兼容 `/v1`；无 openPangu 端点时可先配置任意 OpenAI 兼容网关跑通流程 |

## 2. 本地部署（已验证路径）

### 2.1 获取、构建与全局安装

```bash
git clone <repo-url> Pangu
cd Pangu
npm install        # 安装 devDependencies（tsx/typescript）
npm run build      # tsc → dist/
npm link           # 全局部署：生成 zhulong / panshalach 全局 bin（旧别名 zorge 保留）
```

- 三个 bin（`zhulong` 对外主名 / `panshalach` / `zorge` 兼容别名）均指向 `dist/cli.js`。
- 重新拉取代码后需重跑 `npm run build`（bin 运行的是 dist 产物）。**0.7.4 起 dist-fresh 启动检查兜底**：交互模式启动时若存在比 `dist/cli.js` 更新的 src 改动，会打一行黄字提醒"⚠ dist 落后于 src，请执行 npm run build"（headless/一次性执行不打扰，检查异常不阻塞启动）——见到提醒重跑 `npm run build` 即可。

### 2.2 本地模型端点（LM Studio，实测路径）

1. 安装 **LM Studio 0.3+**，在模型搜索中加载 openPangu 模型（本机实测：`openpangu-embedded-1b-i1`，GGUF 量化版）。
2. 启动本地服务（Developer / Local Server），默认地址 `http://localhost:1234/v1`。
3. 确认模型已加载并在模型列表中可见：

```bash
curl http://localhost:1234/v1/models
```

> **能力边界（实测，如实声明）**：`openpangu-embedded-1b-i1` 的 chat template 不支持 tool use（`tool_choice:required` 亦无法诱导 tool_calls）；文本协议 + few-shot 教学下可完成简单写文件任务，但成功率受 1B 能力限制。**端到端验收建议使用支持 tool use / 指令遵循更强的模型（openPangu 7B+）**。

### 2.3 两级配置

加载顺序：用户级 `~/.panshalach/config.json` 为基底 → 项目级 `<workspace>/.panshalach.json` 深合并**覆盖**用户级（项目级优先；数组字段整体替换）。用户级目录可用 `PANSHA_USER_CONFIG_DIR` 重定向（便携部署/测试隔离）。仓库根有现成模板 `.panshalach.json.example`。

用户级 `~/.panshalach/config.json`（Windows 为 `C:\Users\<你>\.panshalach\config.json`）示例：

```json
{
  "model": "openpangu:openpangu-embedded-1b-i1",
  "providers": {
    "openpangu": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "EMPTY",
      "models": ["openpangu-embedded-1b-i1"],
      "modelContexts": { "openpangu-embedded-1b-i1": 8192 }
    }
  }
}
```

项目级 `.panshalach.json` 覆盖示例（放在工作区根目录，仅覆盖需要差异化的字段）：

```json
{
  "model": "openpangu:openPangu-7B",
  "providers": {
    "openpangu": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "models": ["openPangu-1B", "openPangu-7B", "openPangu-7B-VL"],
      "modelContexts": { "openPangu-1B": 4096, "openPangu-7B": 8192, "openPangu-7B-VL": 8192 }
    }
  }
}
```

**模型选择优先级**：① `PANSHA_MODEL` 环境变量（永远优先）→ ② 配置文件 `model` 字段（0.6.5 起 modelSeed 兜底播种生效）→ ③ REPL 内 `/model` 显式切换。模型路由用 `provider:model` 前缀写法（如 `openpangu:openPangu-7B`）。

### 2.4 部署验证

```bash
# 1) 交互式 REPL（对外主名）：应出现欢迎语 "Zhulong Interactive Shell（烛龙）"
zhulong
#    REPL 内可用 /model list 拉取端点模型，/status 查看配置

# 2) 一次性执行（headless 真实执行 + full 审批档位，写文件不被拒）
zhulong --headless --approval full run "在 hello.txt 写入一行文本 pong，然后读取验证"
#    预期（0.7.3 已按真实引擎行为重验）：写文件成功（hello.txt 落盘且内容为 pong，
#    过程出现 write_file 的 "Wrote N lines" 卡片），回合结局 completed（真实验证
#    PASS）；completed 任务自动沉淀记忆卡（/memory 可见）。注意：省略 --approval
#    时默认 readonly，写文件会被拒（预期以 "未通过验证" 收尾，属门禁正确行为）。

# 3) 只读巡检（验证审批门禁）
zhulong --headless run "总结当前目录结构"
```

注意（0.8 语义反转）：mock 仅显式 opt-in——`PANSHA_SMOKE=1` 时工具强制 mock（零 spawn，测试/CI 用）；非 TTY 环境默认真实执行，安全性由审批三档（无 `--approval` 默认 readonly 拒写）+ pathGuard + 敏感路径 + 写前读兜底。`--headless` / `PANSHA_HEADLESS=1` 保留为兼容别名（no-op）。

## 3. 配置参考

### 3.1 provider 配置字段（providers 三件套）

| 字段 | 说明 |
|---|---|
| `type` | 固定 `openai-compatible` |
| `baseUrl` | OpenAI 兼容端点根（含 `/v1`），如 `http://localhost:1234/v1` |
| `apiKey` | 显式密钥；本地端点常填 `EMPTY`。与 `apiKeyCmd` 同时存在时**显式 apiKey 优先** |
| `apiKeyCmd` | 密钥不落盘方案：执行命令取 stdout 首行作密钥，成功后缓存（借鉴 claude-code apiKeyHelper） |
| `headers` | 追加请求头 |
| `models` | 该 provider 可用模型名列表 |
| `modelContexts` | 模型名 → 上下文长度（token）。已接入压缩触发（未知回落 32768 保守值）：auto-compact 阈值与 loop 窗口预算均按此真值计算；未知/遗留 256000 哨兵一律按 unknown 处理回落 32768。也可被端点 `/models` 探测缓存覆盖合并（未知模型的上下文持久化为 null，不再写 256000 假值） |

### 3.2 环境变量三件套（provider 级）

`PANSHA_<PROV>_API_KEY` / `PANSHA_<PROV>_BASE_URL` / `PANSHA_<PROV>_MODEL`，`<PROV>` 为 provider 名大写（非字母数字转 `_`），如 provider 名 `openpangu` → `PANSHA_OPENPANGU_API_KEY`。仅凭 `PANSHA_<U>_API_KEY` 存在即可自动发现 env-only provider（此时必须提供 `_BASE_URL`，否则该条目不注入）。`SCNET_API_KEY`/`SCNET_KEY` 保留为 scnet provider 历史别名。

```bash
export PANSHA_OPENPANGU_API_KEY=EMPTY
export PANSHA_OPENPANGU_BASE_URL=http://127.0.0.1:8000/v1
export PANSHA_MODEL=openpangu:openPangu-7B
```

### 3.3 `--approval` 审批档位（三档）

| 档位 | 行为 |
|---|---|
| `readonly` | 只读工具放行；写文件/执行类一律拒绝 |
| `default` | 读放行；写需确认 |
| `full` | 全部放行（写不确认） |

- one-shot/headless：`--approval <readonly|default|full>` 或 `PANSHA_APPROVAL` 环境变量（0.6.5 前锁死 readonly，写文件必然被拒）。
- REPL 内：`/approvals <mode>` 随时切换；`max/ex/pangu` 档位任务开始前另有确认面板。

### 3.4 `PANSHA_*` 环境变量总表（全集，源自 src 扫描）

| 环境变量 | 作用 | 备注 |
|---|---|---|
| `PANSHA_MODEL` | 模型选择，优先级最高（`provider:model` 前缀写法） | 覆盖配置文件 `model` 字段 |
| `PANSHA_APPROVAL` | one-shot/headless 审批档位 `readonly/default/full` | 等价 `--approval` |
| `PANSHA_HEADLESS` | `=1` 兼容别名（0.8 起 no-op：非 TTY 已默认真实执行） | `--headless` flag 会设置它 |
| `PANSHA_SMOKE` | `=1` 强制工具 mock（零 spawn，测试/CI） | 0.8 起唯一 mock 触发方式（显式 opt-in） |
| `PANSHA_INTENT_GATE` | `=0` 关闭入口意图分类，全部按 execution 完整循环 | 逃生门 |
| `PANSHA_USER_CONFIG_DIR` | 重定向用户级配置目录（默认 `~/.panshalach`） | 便携部署/测试隔离 |
| `PANSHA_CTX_WINDOW` | 上下文窗口 token 数**显式覆盖**（0.7.3 起不再默认 128000 常量） | 未设置时按当前模型真实窗口：配置 `modelContexts` → `/model list` 探测缓存 → 未知回落 **32768** 保守值；压缩阈值与 loop 窗口预算均按该真值，每任务边界重取（`/model` 切换即生效） |
| `PANSHA_VERBOSE` | `=1` 初始开启 thinking 展示 | REPL 内可切换 |
| `PANSHA_SERVE_TOKEN` | SSE 服务（`/serve`）Bearer token | 未配置时仅允许 localhost 来源 |
| `PANSHA_SKILLS_USER` | 用户级 skills 根目录覆盖（默认 `~/.panshalach/skills`） | |
| `PANSHA_USE_LEGACY_PARSER` | `=1` 强制走文本协议解析（退出现代 JSON 主路径） | 诊断用 |
| `PANSHA_EXEC` | 内部标记：bash 子进程 env 注入，非用户配置项 | 勿手工设置 |
| `PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL` | provider 级三件套（见 §3.2） | 泛化任意 provider |

其余 CLI flag：`--resume/-r [id|last]`、`--branch/-b <name>`（会话续接/分支）、`--classic/-C/--line`（强制行模式 REPL）。

## 4. 远端 OpenAI 兼容网关接入

任意提供 `/v1/chat/completions`（支持 OpenAI 原生 tool_calls 最佳，文本协议为兜底）的网关均可接入：

```json
{
  "model": "openpangu:openPangu-7B",
  "providers": {
    "openpangu": {
      "type": "openai-compatible",
      "baseUrl": "https://<网关地址>/v1",
      "apiKeyCmd": "security find-generic-password -s openpangu -w",
      "models": ["openPangu-7B"]
    }
  }
}
```

- 密钥三种给法：`apiKey` 明文（本地端点 `EMPTY` 即可）→ `PANSHA_<PROV>_API_KEY` 环境变量（不进配置文件）→ `apiKeyCmd`（stdout 首行作密钥，适合密钥管理器）。
- `openpangu:` 前缀是 provider 路由名，不会发给网关（0.6.4 起注册表剥离前缀，修复原样发送导致网关 400 的问题）。
- 连通性自检：`PANSHA_MODEL=openpangu:openPangu-7B panshalach run "ping"`（ROADMAP-NEXT「真实 openPangu 运行步骤」：env 三件套 → 验证 → 真实评测）。

## 5. 昇腾 310P/910 + vLLM-ascend / MindIE 部署

> ⚠️ **本节为标准流程框架，待端点实测验证**——截至当前版本，昇腾真机端到端（含权重加载、tool_calls 兼容性、上下文窗口与压缩阈值实测）尚未执行，以下命令形状仅供参考，禁止视为已验证路径。验证结论将回填本节与 EVALUATION.md。

### 5.1 vLLM-ascend（命令形状）

```bash
# 前置：CANN + torch-npu + vllm-ascend 插件（版本组合待实测固化）
vllm serve /path/to/openPangu-7B \
  --served-model-name openPangu-7B \
  --port 8000
# 客户端侧照 §2.3/§4 配置，baseUrl=http://<昇腾机IP>:8000/v1
```

### 5.2 MindIE 服务化要点

- MindIE 以服务化方式暴露 OpenAI 兼容端点；要点为：服务配置中的监听地址/端口、`maxSeqLen` 等窗口参数与客户端 `modelContexts` 对齐、HTTPS/token 鉴权选项与 `headers`/`apiKey` 配置对齐。
- **待实测确认项**：openPangu 各规格在 MindIE 上的精度格式（fp16/int8/int4）、tool_calls 支持程度、并发与显存占用（ARCHITECTURE §5 资源表由真机实测回填）。

### 5.3 openPangu 权重获取（占位）

权重从 openPangu 官方发布渠道获取（华为开源平台/Gitee openPangu 仓库），遵循其模型许可协议；具体下载链接与校验方式**占位待补**。

## 6. 麒麟/国产 OS 兼容性

> ⚠️ **待整机实测验证**（麒麟 V10 SP3 / openEuler + 鲲鹏 920 aarch64 组合未跑过验收清单）。

- 本项目零运行时依赖（纯 JS + Node 标准库；可选依赖亦均为纯 JS），**无原生模块编译负担**，理论上 aarch64 与 x86_64 行为一致。
- Node 获取路径（二选一）：
  1. 发行版/移植渠道 Node ≥18 包（如麒麟软件商店、openEuler EPOL 的 `nodejs`）；
  2. 源码编译：Node 官方源码在 aarch64 上 `./configure && make -j && make install`（鲲鹏 920 实测耗时需回填）。
- 之后流程与 §2 相同（git clone → npm install → npm run build → npm link）。
- 待验证项：aarch64 上 `npm install` 可选依赖解析、ink 富 UI 在国产终端模拟器的兼容性（可 `--classic` 降级行模式规避）。

## 7. 常见问题（FAQ）

**Q1：端口占用（服务起不来 / `EADDRINUSE`）**
LM Studio 默认 `1234`、vLLM 默认 `8000`。端口被占时在服务侧换端口（LM Studio：Developer 设置里的 Server Port；vLLM：`--port`），并同步修改配置的 `baseUrl`（或 `PANSHA_<PROV>_BASE_URL`）。

**Q2：请求返回 400，提示模型不存在/未加载**
两种常见原因：① 端点侧模型未加载——LM Studio 未加载模型时 `/v1/chat/completions` 会报 400，先加载模型并用 `curl http://localhost:1234/v1/models` 核对模型名与配置 `models` 字段**逐字符一致**；② 请求体里带了 `provider:model` 前缀路由串——0.6.4 已修复（注册表剥离前缀），若复现请确认部署版本 ≥ 0.6.4。

**Q3：模型返回 200 但内容为空（reasoning_content 空响应）**
openPangu-Embedded 实测偶发"content 空但 reasoning_content 非空"的 200 空响应。0.6.4 起已有双重兜底：非流式响应 content 为空时采用 `reasoning_content`；空响应纳入 `withRetry` 可重试（429/5xx/网络错误 + 传输类错误 fetch failed/TypeError，≤5 次——0.7.3 起从 3 次放宽）。若仍频繁出现：检查是否上下文超窗（`modelContexts` 是否配小/配大）、量化版本是否过激，或换 7B+ 模型验证。

**Q4：任务显示"✗ 任务执行失败 · EMPTY_RESPONSE…"（0.7.4 新排障项）**
加载的模型是 **diffusion/embedding 类**（如 `openpangu-7b-diffusion-base-i1`）——LM Studio 对此类模型的 `/v1/chat/completions` 返回 200-garbage（`Unexpected endpoint or method. Returning 200 anyway`），0.7.4 起该故障被正确识别为 `error` 终态（此前被伪装成"已中断"）。处置：在 LM Studio 加载**标准自回归对话模型**（如 openpangu-7b 非 diffusion 版）后重试。

**Q5：`--approval readonly` 下写文件被拒**
设计行为，不是故障：readonly 档写文件/执行类一律拒绝。headless/一次性执行需要显式提权：`zhulong --headless --approval full run "…"` 或 `PANSHA_APPROVAL=full`；REPL 内用 `/approvals full`。另注意非 TTY 一次性执行必须带 `--headless`，否则工具走 mock 守卫不真实落盘。

**Q6：`zhulong` 命令找不到**
`npm link` 未执行或构建产物缺失：重跑 `npm run build && npm link`；Windows 下需新开终端使全局 bin 生效。
