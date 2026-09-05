# feature-zhaiyuanhao1 工作日志 — 2026-09-04

agent: zhaiyuanhao / <待填写>
date:  2026-09-04
last_updated: $(date +%H:%M)

## 想做什么（目的）
W1 起步：把仓库从"已完成改名+命题骨架"推到"4 主力可并行开干"。3 件事：
1. 注册 4 主力（翟源昊 / 王浩宇 / 王祚 / 赵天昂）并建各自 feature/<pinyin>1 分支。
2. 部署 docs/agent/ 协作记忆骨架（工作日志 + 交接声明 + README）。
3. 部署远端 hook + CI gate（保护 master/develop，校验 feature 分支有注册卡 + 日志）。

## 打算怎么改（动作）
- 改：.gitignore（补 agent 协作记忆 + 草稿/沙箱 + 评审缓存的忽略规则）
- 新增：docs/agent/{README,logs/.gitkeep,handover/README}.md
- 新增：scripts/protect-protected-branches.sh（远端 pre-receive hook）
- 新增：.github/workflows/agent-branch-guard.yml（CI gate）
- 新增：tasks/{.gitkeep, agents/<4张>.md, standups/.gitkeep}

## 实际干了什么（事实）
- 改了 .gitignore：补 ~10 行 agent 相关忽略（notes-/drafts/sandbox- 等）
- 新增 docs/agent/README.md：协作记忆目录说明（与 AGENT-CONTRIBUTION.md §6.1 对应）
- 新增 docs/agent/logs/.gitkeep：占位入 git
- 新增 docs/agent/handover/README.md：交接声明模板与规则
- 新增 scripts/protect-protected-branches.sh：拒绝非 kultur 推 master/develop、拒绝未注册 feature 分支
- 新增 .github/workflows/agent-branch-guard.yml：3 个 job — branch-ownership / agent-logs-gate / build-and-test
- 新增 tasks/agents/{zhaiyuanhao,wanghaoyu,wangzuo,zhaotianang}.md：4 张主力注册卡

## 卡点 / 需要别人决定（接口争议）
- 4 主力 agent-id 待各控制人在 .claude-settings.json 中填实际值（目前留"<待填写>"）
- 远端 hook 部署需 kultur 在服务器侧执行（脚本内 KULTUR_KEY_FINGERPRINT 占位待替换）

## TODO（明天 / 下一轮）
- [ ] 4 主力分别 git checkout -b feature/<自己 pinyin>1 origin/master（origin 无 develop）
- [ ] 4 主力拉一次 master 同步 git fetch origin master
- [ ] W1.1 接口契约 PR（5 文件签名）：openai-compatible complete 返回 ModelClientOutput；MemoryClientOutput 类型；EmbeddingProvider 接口；MemoryEvent 接口；TaskState 接口
- [ ] W1.5 W1 末 stand-up 总结

## 开工前必查（已完成）
- [x] git fetch origin master develop
- [x] cat docs/agent/handover/feature-*.md（首次建立，全空）

## 21:40 旧模型品牌残留清理（三区并行）

**想法/目的**：按用户指示"不要留下 glm 相关"，把重命名后遗留的旧品牌类名、文件名、格式串、provider 特化分支全部清理，不留兼容别名。

**动作内容**：3 个 subagent 并行分区 + 主会话统一收尾
- adapter 层：git mv ExtremeGlmToolCallAdapter→StrictStructuredToolAdapter、GlmToolCallParser→XmlStructuredToolParser；格式串 glm-xml-strict/glm-loose-plain→xml-strict/loose-plain；adapter README 重写；2 个测试文件同步改名
- 核心链路：StructuredReasoner 三方法改名（getEngineeringIronLawsHeader 等）、isStrictGlm 选项删除、VerifyCritiqueLoop/PanshalachChaser/FailureMemory 等 14 文件中性化
- provider 层：ModelProvider 删 bare glm/glm5 shorthand、_pickBestGLMModel→_pickBestProviderModel；ModelCommand 文案通用化；maoyulin 客户端默认模型改 openPangu-7B
- 删除：src/Glm53SweProChaser.ts（兼容 stub）、scripts/test-glm-shorthand.mjs（主会话执行 git rm）
- 文档：ROADMAP-NEXT P1.4 标记完成、REFACTOR-ASSESSMENT/CHANGELOG/AGENT-CONTRIBUTION 措辞中性化

**结果**：commit 17851f9（51 files, +652/-737）
- tsc --noEmit EXIT 0
- 505 tests: 504 pass / 0 fail / 1 skip
- verify-panshalach-cleanup.mjs PASS
- grep -ri glm src/ tests/ scripts/ examples/ = 0 命中

**给其他分支的提示**：detectedFormat 值已从 glm-xml-strict/glm-loose-plain 改为 xml-strict/loose-plain；Glm53SweProChaser 类与 glm shorthand 已删除——若有分支引用需同步（详见 docs/agent/handover/）。

## 23:30 模型接入层调查 + 配置驱动迭代方案（方案落库，未动代码）

**想法/目的**：用户要求清理所有死调用逻辑、统一配置驱动，参考 claude-code 与 dsh 的调用思路，先出迭代方案等指令再开工。

**动作内容**：
- 逆向 claude-code cli.js：env 覆盖链（settings env 块 → process.env → 默认）、apiKeyHelper、provider 布尔选择器
- 读 dsh preset.yml/agent.cordis.yml：声明式组合、宿主面/代理面分离
- 调查本仓模型调用链：唯一网络路径 = openai-compatible.ts；定位死代码 5 文件与 ModelProvider scnet 特化 4 处
- 发现 getModelContextLength 只查 scnet → openPangu-1B 的 4096 配置实际不生效
- 发现 probe-scnet-real.mjs 硬编码真实 scnet 密钥（已进 git 历史，仅口头描述不落密钥本体）

**结果**：方案落库 docs/agent/handover/feature-zhaiyuanhao1-model-provider-plan-2026-09-04.md（调查结论 + 参考思路 + 三步迭代 + 分支依赖 + 风险）。迭代 1（清理+env 泛化+apiKeyCmd）→ 迭代 2（tool_calls 透传）→ 迭代 3（env 块 + /model list 通用化）。

**卡点 / 需要别人决定**：等用户开工指令；迭代 2 是王浩宇 ModelClientOutput 契约的前置，落定后需在 handover 追加声明。
