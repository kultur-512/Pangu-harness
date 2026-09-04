# Panshalach

基于 openPangu 的记忆增强长程上下文智能体——解决长交互/多轮任务/长文档/持续状态跟踪中的**中期遗忘**与**上下文断裂**。

> 华为命题《基于 openPangu 的记忆增强智能体架构设计与优化》· 国产操作系统软件组
> 场景主线：**软件工程长期维护**（跨多轮需求演进 / 跨文件关联 / 持续状态跟踪）

## 长程上下文能力

- **记忆卡（结构化记忆）**：失败教训 / 成功经验 / 用户偏好；类别分档可见性 + 参照文件过滤 + 四段阶梯衰减 + 同主题合并 + 容量控制（`/memory`）
- **会话资产**：追加式 rollout jsonl（turn/approval/rewind）+ `--resume`/`--branch`/`/tree` 续接与分支
- **上下文压缩**：模型摘要旧轮 + 保留最近 6 轮；压缩同时补漏提炼成功卡
- **任务状态跟踪**：active feature + 下一步 + 完成证据（`/feature`）
- **注入工程**：L0 硬约束(≤3) / L1 记忆注入(分档 3/6/8/10) / 档位契约 / 注入去重 / token 预算
- **执行纪律**：真实 read/write/bash/glob/grep + Read-Before-Write + Verify-Before-Claim + 四档审批 + 可回滚——支撑长周期持续执行

## 安装

```bash
npm install          # devDependencies（tsx/typescript）
npm run build        # → dist/
npm install -g .     # 提供 panshalach bin（保留旧别名 zorge）
```

## 快速开始

1. 配置 openPangu（本机/昇腾 OpenAI 兼容端点），编辑 `.zorge.json`：
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
3. 或一条命令：`ZORGE_MODEL="openpangu:openPangu-7B" panshalach run "你的任务"`

## 命令总表

```
tier / model / approvals / undo / rewind / compact / usage / resume / agents /
status / memory / review / config / init / history / trace / session /
workspace / feature / tree / clear / help / exit
```

## 测试与验证

```bash
npm test            # node --test + tsx，62 组用例
npx tsc --noEmit    # 类型检查
```

## 文档

- 命题交付文档：[docs/panshalach/](docs/panshalach/README.md)（架构设计 / 记忆设计 / 效果评估 / 使用手册 / ROADMAP）
- 重构评估报告：[REFACTOR-ASSESSMENT.md](REFACTOR-ASSESSMENT.md)（代码逐模块对照命题的改造路径）

## FAQ

- **内部为什么还出现 zorge/.zorge**？历史兼容名。对外品牌为 Panshalach；`.zorge.json`/`.zorge-memory.json`/`~/.zorge`/`ZORGE_*`/`ZorgeChaser` 均为内部存储名，收敛计划见 [ROADMAP](docs/panshalach/ROADMAP.md) P6。
- **零依赖？** 是。`dependencies: {}`，核心引擎零运行时依赖；UI 类（ink/chalk/ora/prompts）在 optionalDependencies，缺失自动降级。
- **评测是真实模型吗？** 是。效果评估只用真实 openPangu 运行结果（本机/昇腾端点），不混合成数据，见 [EVALUATION.md](docs/panshalach/EVALUATION.md)。
