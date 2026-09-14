# 烛龙（Zhulong）· 内部代号 Panshalach（盤沙拉克）

基于 openPangu 的记忆增强通用智能体——解决长交互/多轮任务/长文档/持续状态跟踪中的**中期遗忘**与**上下文断裂**；软件工程与日常对话、知识问答皆为所长。

> 华为命题《基于 openPangu 的记忆增强智能体架构设计与优化》· 国产操作系统软件组
> 场景主线：**软件工程长期维护**（跨多轮需求演进 / 跨文件关联 / 持续状态跟踪）
> 当前版本 **v0.8.6** · `npm test` **1349 例全绿**（concurrency=4，CI 已挂 test 门）· **90 题 LongMemEval 交付口径**：ZL×M3 strict 41/90（已追平 CC×M3）为旗舰基准，ZL×7B 31/90 本地最优，ZL×1B 23/90 为 1B 基线（矩阵与逐题数据见 [scripts/eval/longmemeval-90/COMPARE-90.md](scripts/eval/longmemeval-90/COMPARE-90.md)）· 分版详录见 [CHANGELOG.md](CHANGELOG.md) · 未完成项见 [docs/panshalach/ROADMAP-NEXT.md](docs/panshalach/ROADMAP-NEXT.md)

**命名约定**（用户明确指示）
- **外部产品名**（用户/市场看到）：**烛龙**（Zhulong）—— CLI 启动、欢迎语、模型身份串均使用此名
- **内部项目代号**（代码/存储/包名）：**盤沙拉克** Panshalach —— package name、类名、存储目录、`.env` 前缀均使用此代号

## 长程上下文能力

- **记忆卡（结构化记忆）**：失败教训 / 成功经验 / 用户偏好 / 对话事实；证据门槛写入（只认真实验证通过）+ kind 分桶容量（failure 40 / success 10 / preference 80，pinned 免淘汰）+ 档位可见性 + 参照文件过滤 + 四段阶梯衰减 + 验证保鲜 + 同主题合并 + 注入审计（`/memory stats`：注入账本 + 最近注入事件）+ 原子写与损坏隔离
- **上下文协议（0.8）**：messages 双通道（小模型自动降级文本协议）+ stable/volatile 三段 prompt（前缀缓存友好）+ 意图三路分流 + 卡死硬闸 + 工具大输出落盘回读
- **交互手感（0.8）**：输入 `/` 即时命令菜单（过滤/↑↓ 导航）· shift+tab 档位环专属色徽标 · `/model` 菜单化编号直达 · `/tier` 思考强度滑杆
- **会话资产**：追加式 rollout jsonl（turn/approval/rewind + 业务事件/压缩标记/注入审计）+ `--resume`/`--branch`/`/tree` 续接与分支
- **上下文压缩**：模型摘要旧轮（用户指令原文 ≤2000 字符逐字保留）+ 保留最近 6 轮（字节感知收缩）；摘要注入 prompt + 补漏提炼成功卡（手动/自动同路径）；上下文计量挂网关实测 usage（CJK-aware 估算兜底）；任务内溢出应急为确定性截断（保首尾步，与压缩严格区分）
- **任务状态跟踪**：active feature + 下一步 + 完成证据（`/feature`）
- **记忆检索与时间锚定（0.8.4/0.8.5）**：对话对卡宽进严排（写入只拦无信息量内容，质量后移排序：confidence 定价 + 软惩罚只进排序不进淘汰）+ 混合检索（词面 + 语义 n-gram 融合，`PANSHA_SEMANTIC_SEARCH=0` 可关，异常自动降级）+ 时间锚定（区分记录时间/事实时间/今天：卡带 [事实时间]，prompt 注入"今天是 X"）+ 窗口感知注入预算（8K≈10%/大窗 15%、1600 token 帽 + 实测 token 门，`PANSHA_MEMORY_LIMIT` 显式时不变）
- **注入工程**：L0 硬约束(≤3) / L1 记忆注入（窗口感知预算 + 注入去重） / 档位契约 / 溢出 auto-pull（按意图门禁）
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

- 命题交付文档：[docs/panshalach/](docs/panshalach/README.md)（架构设计 / 记忆设计 / 效果评估 / 使用手册 / 路线与未完成项）
- 变更史（各版本段即变更申报记录）：[CHANGELOG.md](CHANGELOG.md)

## FAQ

- **内部为什么还出现 .panshalach/PANSHA_/PanshalachChaser**？内部工程代号（盘沙拉克 Panshalach）用于代码/包名/存储/env 前缀，与外部产品名"烛龙"分离；用户可见文案走"烛龙 Zhulong"。`.panshalach.json`/`.panshalach-memory.json`/`~/.panshalach/`/`PANSHA_*`/`PanshalachChaser` 均为内部存储/标识；`.panshalach.json.example` 是工程示例。命名收口与迁移见 [ROADMAP-NEXT](docs/panshalach/ROADMAP-NEXT.md) §3.2。
- **零依赖？** 是。`dependencies: {}`，核心引擎零运行时依赖；UI 类（ink/chalk/ora/prompts）在 optionalDependencies，缺失自动降级。
- **评测是真实模型吗？** 是。效果评估只用真实 openPangu 运行结果（本机/昇腾端点），不混合成数据，见 [EVALUATION.md](docs/panshalach/EVALUATION.md)。
