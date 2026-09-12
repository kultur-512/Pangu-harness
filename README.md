# 烛龙（Zhulong）· 内部代号 Panshalach（盤沙拉克）

基于 openPangu 的记忆增强通用智能体——解决长交互/多轮任务/长文档/持续状态跟踪中的**中期遗忘**与**上下文断裂**；软件工程与日常对话、知识问答皆为所长。

> 华为命题《基于 openPangu 的记忆增强智能体架构设计与优化》· 国产操作系统软件组
> 场景主线：**软件工程长期维护**（跨多轮需求演进 / 跨文件关联 / 持续状态跟踪）
> 当前版本 **v0.8.0-rc**（0.7 终止语义重构/意图前移/记忆落定 → 0.8 换地基：turn 四模块 + messages 双通道协议 + stable/volatile 三段 prompt + 执行层七项强化 + Claude Code 级交互手感 + 记忆链治理）· 分版详录见 [CHANGELOG.md](CHANGELOG.md)

**命名约定**（用户明确指示）
- **外部产品名**（用户/市场看到）：**烛龙**（Zhulong）—— CLI 启动、欢迎语、模型身份串均使用此名
- **内部项目代号**（代码/存储/包名）：**盤沙拉克** Panshalach —— package name、类名、存储目录、`.env` 前缀均使用此代号

## 长程上下文能力

- **记忆卡（结构化记忆）**：失败教训 / 成功经验 / 用户偏好；证据门槛写入（只认真实验证通过）+ 类别分档可见性 + 参照文件过滤 + 四段阶梯衰减 + 验证保鲜 + 同主题合并 + 注入审计（`/memory`）
- **上下文协议（0.8）**：messages 双通道（小模型自动降级文本协议）+ stable/volatile 三段 prompt（前缀缓存友好）+ 意图三路分流 + 卡死硬闸 + 工具大输出落盘回读
- **交互手感（0.8）**：输入 `/` 即时命令菜单（过滤/↑↓ 导航）· shift+tab 档位环专属色徽标 · `/model` 菜单化编号直达 · `/tier` 思考强度滑杆
- **会话资产**：追加式 rollout jsonl（turn/approval/rewind + 业务事件/压缩标记/注入审计）+ `--resume`/`--branch`/`/tree` 续接与分支
- **上下文压缩**：模型摘要旧轮 + 保留最近 6 轮；压缩同时补漏提炼成功卡
- **任务状态跟踪**：active feature + 下一步 + 完成证据（`/feature`）
- **注入工程**：L0 硬约束(≤3) / L1 记忆注入(分档 3/6/8/10) / 档位契约 / 注入去重 / token 预算
- **执行纪律**：真实 read/write/bash/glob/grep + Read-Before-Write + Verify-Before-Claim + 四档审批 + 可回滚——支撑长周期持续执行

## 安装

```bash
npm install          # devDependencies（tsx/typescript）
npm run build        # → dist/
npm install -g .     # 提供 panshalach / zhulong bin（保留旧别名 zorge）
```

## 快速开始

1. 配置 openPangu（本机/昇腾 OpenAI 兼容端点），编辑 `.panshalach.json`：
   ```json
   {
     "model": "openpangu:openPangu-7B",
     "providers": {
       "openpangu": {
         "type": "openai-compatible",
         "baseUrl": "http://127.0.0.1:8000/v1",
         "apiKey": "EMPTY",
         "models": ["openPangu-1B", "openPangu-7B", "openPangu-7B-VL"]
       }
     }
   }
   ```
2. `panshalach` → `/model list` → `/model openpangu:openPangu-7B` → 输入任务
3. 或一条命令：`PANSHA_MODEL="openpangu:openPangu-7B" panshalach run "你的任务"`

## 命令总表

```
tier / model / approvals / undo / rewind / compact / usage / resume / agents /
status / memory / review / config / init / history / trace / session /
workspace / feature / tree / clear / help / exit
```

## 测试与验证

```bash
npm test            # node --test + tsx
npx tsc --noEmit    # 类型检查
```

## 文档

- 命题交付文档：[docs/panshalach/](docs/panshalach/README.md)（架构设计 / 记忆设计 / 效果评估 / 使用手册 / ROADMAP）
- 重构评估报告：[REFACTOR-ASSESSMENT.md](REFACTOR-ASSESSMENT.md)（代码逐模块对照命题的改造路径）

## FAQ

- **内部为什么还出现 .panshalach/PANSHA_/PanshalachChaser**？内部工程代号（盘沙拉克 Panshalach）用于代码/包名/存储/env 前缀，与外部产品名"烛龙"分离；用户可见文案走"烛龙 Zhulong"。`.panshalach.json`/`.panshalach-memory.json`/`~/.panshalach/`/`PANSHA_*`/`PanshalachChaser` 均为内部存储/标识；`.panshalach.json.example` 是工程示例。命名收口与迁移见 [ROADMAP-NEXT](docs/panshalach/ROADMAP-NEXT.md) §3.2。
- **零依赖？** 是。`dependencies: {}`，核心引擎零运行时依赖；UI 类（ink/chalk/ora/prompts）在 optionalDependencies，缺失自动降级。
- **评测是真实模型吗？** 是。效果评估只用真实 openPangu 运行结果（本机/昇腾端点），不混合成数据，见 [EVALUATION.md](docs/panshalach/EVALUATION.md)。
