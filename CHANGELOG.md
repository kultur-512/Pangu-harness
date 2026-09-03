# Changelog

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
- dogfooding 实战检验（T1-T7，8 条短板，报告见 docs/DOGFOOD-REPORT.md）
- 杂项清理（.sandbox-test/、根目录 test-*.mjs、probe-*.cjs 移出追踪；probe 保留于 scripts/ 且密钥剥离）

### 修复（短木板 #9）
- 负向工具清单注入（`<negative_tool_list>`：iron_law_check/thinking/plan/critique 声明非工具）
- UNKNOWN_TOOL 运行时护栏（TOOL_FORMAT_ERROR 记账 + 意图引导 + 连续 3 次硬停）

### 文档（0.4.0 收尾）
- README.md 新建（安装/快速开始/配置/命令/架构/FAQ）
- docs/ 归档整理（历史蓝图 → docs/archive/，含 ARCHIVE.md 索引）
- package.json description 更新（多供应商现状，去 GLM 专属字样）
- ZIS.md 一致性修正（重复标题、负向清单小节、维护态说明、归档引用）
- T7 三路对照补跑记录（Zorge raw 格式漂移 / Claude 完成 / Hermes 网关停滞）