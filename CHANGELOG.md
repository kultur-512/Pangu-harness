# Changelog

## 0.5.0 (Panshalach 命题化重构)

### 品牌与命题定位
- 项目对外品牌更名 **Panshalach**（package name/bin `panshalach`；保留 `zorge` bin 与内部存储名作为兼容别名）
- 定位改为：基于 openPangu 的记忆增强长程上下文智能体（软件工程长期维护场景），贴华为 openPangu 命题
- 可见层文案更名：欢迎语/提示符/模型身份串（你是 Panshalach…）/SSE server 文案/memory 管理器标题/zorge 档位描述/`/init` 文档指针

### 文档重建
- 新增 [REFACTOR-ASSESSMENT.md](REFACTOR-ASSESSMENT.md)：现有代码逐模块对照 openPangu 命题的重构评估与 P1–P6 改造路径
- 新增 docs/panshalach/ 命题文档集：README / ARCHITECTURE（提交物 1 雏形）/ MEMORY-DESIGN / EVALUATION（提交物 2 骨架，待真实 openPangu 数据）/ USER-GUIDE / ROADMAP
- **物理清理**旧 Zorge/GLM/30-rounds 文档（docs/ 下全部规划/复盘/归档）与过时流程元数据（docs/agents、.agents）
- `.zorge.json.example` 改为 openPangu provider 示例

### 说明
- 内部存储名 `.zorge.json` / `.zorge-memory.json` / `~/.zorge/` / `ZORGE_*` / `ZorgeChaser` 本轮保留（会话资产兼容），收敛计划见 docs/panshalach/ROADMAP.md P6
- openPangu 记忆写闭环 / 事件记忆 / 任务状态机 / 语义检索 / 真机评测 为 P1–P7 后续里程碑（见 ROADMAP）

## 0.4.0 (dogfooding 战役)

### 新增
- --headless 逃生口（ZORGE_HEADLESS=1 / zorge --headless：非 TTY 真实执行，SMOKE 仍最高优先）
- maxHunks 参数（diff 工具：ctx 不计 + 全替换豁免）

### 修复
- computeLineDiff contextLines=0 泄漏折叠标记
- looksBinary off-by-one 边界（31 vs 32）
- stringWidth ZWSP/ZWNJ/word-joiner 宽度（1 → 0）

### 测试
- 二进制边界测试（0x1F/0x20、0x08/0x09）+ 回归守卫
- --headless 4 用例；基线 303 → 309

### 工程
- dogfooding 实战检验（T1-T7，8 条短板；报告已随旧文档清理归档，历史见 git）
- 杂项清理（.sandbox-test/、根目录 test-*.mjs、probe-*.cjs 移出追踪；probe 保留于 scripts/ 且密钥剥离）

### 修复（短木板 #9）
- 负向工具清单注入（`<negative_tool_list>`：iron_law_check/thinking/plan/critique 声明非工具）
- UNKNOWN_TOOL 运行时护栏（TOOL_FORMAT_ERROR 记账 + 意图引导 + 连续 3 次硬停）
