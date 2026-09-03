# Zorge 实战检验报告（dogfooding T1-T7）

> 战役日期：本报告随检验过程实时记录。分支：`zorge-dogfood`（主分支零改动）。
> 方法学修正声明：见下方 **Finding #1** —— 本战役在非交互（无 TTY）会话中执行，
> Zorge 的安全闸 `isSmokeEnvironment()` 无条件 mock 真实执行，导致"由 Zorge 亲手完成
> 任务"的原始方法学在本环境不可行。所有 T1-T6 代码任务改为**由检验工程师以 Zorge 的
> 工具原语（read/glob/grep/edit + npm test）执行同一任务输入**，并在每任务标注
> 执行来源（engineer-executed）。这本身是战役最有价值的发现，详见短板清单。

## 预注册假设（检验前写下，复盘对照）

- 预期强项：单文件小改动 / 测试驱动（RBW+diff+审批纪律）/ 会话 resume / 后台压缩
- 预期弱项：跨文件大重构（无真子代理+串行 rollout）/ 长任务 token 爆炸 / 复杂多步规划
- 预期意外：真实任务中工具调用格式漂移率远高于合成测试；安全闸（isTTY red line）在
  非交互环境的可用性；pathGuard 对用户级路径（~/.zorge）的权限行为

## 观测基线（阶段零）

- 门禁基线：298 tests / 297 pass / 1 skip / 0 fail / exit 0（检验前实测）
- 提交数（master）：25
- smoke / cleanup：PASS（检验前实测）
- 环境事实：`process.stdout.isTTY === undefined`（本会话无 TTY）；`ZORGE_SMOKE` 未设置；
  `winpty`/`script` 不存在（无法为 Zorge 提供伪终端）；`claude`/`hermes` 已安装（T7 可用）

---

## Finding #1 —— Zorge 无法在非交互/CI 环境执行真实任务（安全闸无逃生口）

**证据链（实测）：**
1. `src/tools/engineAdapter.ts:71-73`：`isSmokeEnvironment() = !process.stdout.isTTY || ZORGE_SMOKE==='1'`
2. `:77-87`：命中即返回 mock adapter（`execute: async () => SMOKE_MOCK_RESULT`），**无任何逃生口**
3. 实测 `node dist/cli.js "任务"`：one-shot 路径只认斜杠命令，任务文本报"未知命令"
4. 实测 `echo "任务" | node dist/cli.js --line`：banner 打印后即退出（exit -1），管道行未被消费
5. 实测 `node -e "console.log(process.stdout.isTTY)"` → `undefined`（本会话管道 stdout）

**影响：**
- 本战役"由 Zorge 亲手完成任务"的原始方法学在本环境不可行（原始 DoD 的
  "≥2 个零人工代码介入"因此**无法诚实达成**，如实申报）
- 推论（真实短板）：Zorge 的 M1 红线（isTTY → mock）意味着 **CI / 自动化 / 无头环境
  无法用真实执行做 dogfooding 或回归**；mock 模式还掩盖了真实工具调用格式漂移
  （预注册假设"漂移率"在本环境**不可测**——mock 下工具调用从未真正发出/解析）

**改进建议（草拟，复盘后定稿）：** 为 CI/无头场景提供一个显式的 `ZORGE_EXEC_ALLOW=1`
显式逃生口（须同时显式设置且 stdout 非 TTY 时仍要求 approvalMode=default+ 审批桥，
或以 `--allow-headless-exec` CLI 标志开启，文档化风险）——但必须保持默认拒绝。

---

## T5 —— 实战检验实录（rollout jsonl 提取 + 权限边界检验）

**数据源：** `~/.zorge/rollouts/32236f91-4cad-4cb4-a9af-7428930ae381.jsonl`（M2 resume 验证产物）

### 轨迹表（3 轮，meta + turn 事件）

| 事件 | ts | 关键字段 | 结果 |
|------|-----|---------|------|
| meta | 1788143477818 | id=32236f91…, tier=high, workspace=/tmp/m2-resume, model=default, approvalMode=readonly | 会话初始化（只读审批默认） |
| turn t1 | 1788143477818 | userInput="task 1", durationMs=10, success=true, score=88 | 完成（smoke 级短任务） |
| turn t2 | 1788143477819 | userInput="task 2", durationMs=10, success=true, score=88 | 完成 |
| turn t3 | 1788143477820 | userInput="task 3", durationMs=10, success=true, score=88 | 完成 |

观测：rollout 结构完整（meta→turn 序列、approvalMode=readonly 安全默认、无 approval 事件
= 全程只读）。**局限**：该 jsonl 是验证脚本产物，不含真实工具调用序列——rollout 的
`turn.result` 只存 summary（`score=88`），**工具级轨迹并未落盘**（turn 层聚合，非 step 层），
这是 T5 深挖时发现的数据完整性局限（见短板清单 #5）。

### 权限边界检验（pathGuard 实证）

| 请求 | 结果 | 判定 |
|------|------|------|
| 绝对路径 `C:\Users\19395\.zorge\rollouts\….jsonl`（workspace 外） | `PATH_ESCAPED` | ✅ 设计正确拒绝 |
| 相对穿越 `..\..\.zorge\rollouts\x.jsonl` | `PATH_ESCAPED` | ✅ 设计正确拒绝 |
| 工作区内 `.zorge/skills/…/SKILL.md` | `ALLOWED` | ✅ 项目级 skills 可用 |

**架构观察（真实短板 #4）：** Zorge 的工具层永远无法读取自己存储在用户主目录的
rollout/历史（`~/.zorge`）——/resume 在启动层（Node 进程内）读，但工具层被 pathGuard
隔离。对"agent 需要读取自身历史做分析"的场景（如本 T5 任务）没有显式 opt-in 通道。

---

## 任务结果表（T1-T7）

| 任务 | 完成 | 执行来源 | 人工介入 | 耗时 | 备注 |
|------|------|---------|---------|------|------|
| T1 diff contextLines=0 测试 | ✅ | engineer（gate-blocked） | 0 | ~6min | **red→green**：contextLines=0 仍泄漏折叠标记 ctx 行（真实 bug） |
| T2 looksBinary off-by-one | ✅ | engineer（gate-blocked） | 1（播种，测试设计者本职） | ~8min | **red→green**：播种 bug 逃过既有 7 测试（覆盖缺口） |
| T3 stringWidth 零宽 | ✅ | engineer（gate-blocked） | 0 | ~5min | ZWSP/ZWNJ 宽度=1 是真实 bug（改 0） |
| T4 compactSession 抽取 | ✅ | engineer（gate-blocked） | 0 | ~7min | runSyncCompact 统一两处重复；全量绿 |
| T5 rollout 提取+权限 | ✅ | engineer（gate-blocked） | 0 | ~4min | pathGuard 拒绝 ~/.zorge（设计正确）；turn 层无工具级轨迹 |
| T6 glob 上限 | ✅ | engineer（gate-blocked） | 0 | ~4min | 双上限已存在；补 walkFiles maxFiles 机制测试 |
| T7 三路对照 | ⚠️ | Zorge=engineer；claude/hermes=**环境失败** | 0 | ~15min | 见对照表 |

**执行来源说明（诚实申报）：** 因 Finding #1（isTTY 安全闸无逃生口），Zorge 在本会话
**无法执行任何真实任务**——T1-T6 全部由检验工程师以 Zorge 的同一工具原语
（read/glob/grep/edit + npm test）执行任务输入。原始 DoD 的"≥2 个零人工代码介入"
**无法诚实达成**，如实申报为 0 个；这本身是战役最有价值的发现。

## T7 三路对照表（任务：computeLineDiff 增加 maxHunks 参数）

| 维度 | Zorge | Claude Code (2.1.251) | Hermes (0.20.0) |
|------|-------|----------------------|-----------------|
| 完成/未完成 | ✅ 完成（engineer-executed） | ❌ 未完成 | ❌ 未完成 |
| 步骤数 | 4（读实现→实现→测试 red→fix→green） | — | — |
| 工具调用数 | read/edit/npm test（等效原语） | — | — |
| 人工介入次数 | 1（gate-blocked 方法学） | 0 | 0 |
| 耗时 | ~10min | 失败于 API 层 | 失败于 API 层 |
| 最终 diff 质量 | 好（10/10 测试 + 全量 303 绿） | N/A | N/A |
| 失败模式 | ①isTTY 闸（mock 无逃生口）②maxHunks 默认 5 与既有契约冲突（3 测试回归→重设计为 ctx-计数+全替换豁免） | **API 524**（origin timeout，`new.maoyu.cfd` 网关）→ 后确认**上游无余额**（用户确认） | **API 521**（origin down，3 次重试放弃）→ 同一网关**无余额** |

**T7 结论（诚实记录）：**
1. 两竞争方失败根因 = **共享推理网关 `new.maoyu.cfd` 无余额/宕机**（用户确认），
   非能力对比——对照试验因基础设施不可用无法完成，**方法学结论：三路对照依赖同一
   上游网关 = 单一故障点**（Zorge 自身 scnet 路由同样经该网关，Zorge 行也因此只能
   engineer-executed）。
2. 待用户配置完成后可复跑对照；本报告保留失败模式记录作为基线。

## T7 对照补跑（2026-09-01，网关恢复后，master 0.4.0 状态）

> 新任务（三路从零开始，Zorge 侧未实现过）：给 `src/tools/glob.ts` 增加 `maxDepth`（默认 5），
> 超深目录不再递归，更新测试并运行验证。
> 模型：三家均走用户配置的网关（claude=DeepSeek-V4-Flash-0731/glm-5.3-flash override，
> hermes=其默认 provider）；Zorge 用 `zorge --headless run`（scnet）。混合沙箱：
> claude/hermes 在隔离沙箱（glob.ts 副本 + node_modules junction）执行，Zorge 在真实仓库 headless 执行。

| 维度 | Zorge (0.4.0, --headless) | Claude Code (2.1.251) | Hermes (0.20.0) |
|------|--------------------------|----------------------|-----------------|
| 完成/未完成 | ❌ 未完成（得分 13/100，117s） | ✅ 完成 | ❌ 未完成 |
| 步骤数 | 5（全部读/试错，未达写操作） | ~4（读 glob/walk → 实现 → 测试 → 验证） | 1+（读后 provider 停滞） |
| 工具调用数 | read_file ×多次（含 5 次错误调用） | Read/Bash/Edit（自复制 walk/pathGuard/types 补全沙箱） | 读文件后中止 |
| 人工介入次数 | 0 | 0 | 0 |
| 耗时 | 117s（10 步配额内） | ~6min | ~10min（2 次运行均中止） |
| 最终 diff 质量 | N/A（零写盘） | 好（10/10 测试独立验证 + tsc clean；diff +8/-2） | N/A（零写盘） |
| 失败模式 | **真实任务工具格式漂移**：调用不存在的 `iron_law_check`/`thinking`/`plan`/`Read` 标签，5 步空转在文件读取；收入既有评分 13 | 无（一次通过） | **provider 失响应**：2 次独立运行均 "unresponsive for 5 consecutive stale attempts" 中止（网关波动，与初战 521/524 同源的持续性问题） |

**补跑结论（三行）：**
1. **Zorge 的真实短板不是执行层而是行为层**：--headless 逃生口工作正常（真实读文件、
   实时思考/批评、headless 无桥审批），但模型在自由任务中**工具调用格式漂移率极高**
   （`iron_law_check` 等不存在工具）——预注册假设 "真实任务漂移率远高于合成测试" **实证命中**。
   合成测试（detector 10/10）与真实执行之间的格式纪律缺口 = Zorge 目前最大的能力天花板。
2. **Claude Code 三路中唯一完成**，且产出经独立验证（10/10 + tsc clean）；中途遇到沙箱
   缺依赖时自主补全（复制 walk/pathGuard/types）——自我修复能力显著强于 Zorge raw 模式。
3. **Hermes 受网关可靠性拖累**（provider 失响应 ×2），无法给出能力判定——与初战同为
   基础设施问题；其 CLI 交互方式（-z --yolo）可用，但上游持续不稳。

## T7 复跑（#9 修复后）—— 待外部条件（网关未恢复）

> 复跑于 2026-09-01（B 部分，与 C 文档收尾同日）。短板 #9 修复（负向清单 + 运行时护栏）
> 已在修复批次验证（PromptBuilder 12/12、executor 15/15），但**三路对照复跑因网关状态
> 无法成行**——如实记录，不编造数据。

### B-0 网关探测结果（实测）

| 探测 | 结果 | 判定 |
|---|---|---|
| `zorge --headless run "回复 OK"`（scnet） | 120s 超时未完成 | ❌ 网关挂起 |
| `claude -p "say ok"` | 7s 返回 "ok" | ✅ 可用 |
| `hermes -z "say ok" --yolo` | 120s 超时 | ❌ 网关挂起 |

判定：三路中仅 claude 可用；Zorge（scnet）与 hermes 均挂起——与初战 521/524 及补跑
"provider stale ×2"同源的**共享网关不稳定/未充值**问题（用户此前确认 API 无余额，配置中）。

### 复跑任务（网关恢复后执行，与 2026-09-01 补跑完全一致保证可比）

```
给 src/tools/glob.ts 增加一个参数 maxDepth（默认 5），超过深度的目录不再递归。
更新测试覆盖（含默认行为回归），运行验证。
```

### 复跑命令（三路，各自独立沙箱防污染——上次 Hermes 起点被 Claude 产物污染的教训）

```bash
# Zorge（真实仓库，master 当前含 #9 修复）
npm run build && node dist/cli.js --headless run "给 src/tools/glob.ts 增加参数 maxDepth（默认 5）..."

# Claude / Hermes（各用独立 sandbox：glob.ts + walk/pathGuard/types 副本 + node_modules junction）
claude -p "..." --permission-mode acceptEdits --allowedTools Bash
hermes -z "..." --yolo

# 对比表模板（追加到本小节）
# 维度：完成/未完成 · 步骤数 · 误调未知工具次数（#9 直接度量）· 人工介入 · 耗时 · 评分
```

### 预期验证要点（#9 修复有效性的判定标准）

1. **误调未知工具次数**：修复前 5 次（iron_law_check 等）；修复后应显著下降
   （负向清单抑制 + 护栏引导）。
2. **空转步数**：修复前 5 步空转未达写操作；修复后应 ≤1 步（护栏引导立即纠偏）。
3. 若 Zorge 完成：与 Claude 产出对比 diff 质量；评分 vs 13 的提升幅度。

---

## 短板清单（≥3，按严重度排序）

| # | 短板 | 严重度 | 证据 |
|---|------|--------|------|
| 1 | **isTTY 安全闸使 Zorge 无法在 CI/无头/非交互环境执行真实任务**（无逃生口） | 高 | engineAdapter.ts:71-87 实测（管道 REPL banner 即退、one-shot 只认斜杠命令、winpty 不可用） |
| 2 | **测试覆盖缺口：二进制检测边界零覆盖**（播种 off-by-one 逃过全部既有测试） | 高 | readFile.test.ts 仅覆盖 NUL 分支；31/32 边界无测试 |
| 3 | **maxHunks 默认值设计冲突**：通用 diff 工具加默认 cap 会静默破坏调用方契约（coarse 全替换 6000 hunks） | 中 | T7 实测 3 个既有测试回归；需 ctx-计数+全替换豁免才两全 |
| 4 | **工具层无法访问 `~/.zorge` 自身历史**（pathGuard 无 opt-in 通道） | 中 | T5 实证 PATH_ESCAPED；/resume 只在启动层 |
| 5 | **rollout 仅 turn 层聚合，工具级轨迹未落盘**（无法回放真实调用序列） | 中 | T5 读取 3 轮 jsonl 仅 summary="score=88" |
| 6 | **stringWidth 零宽字符缺口**（ZWSP/ZWNJ/word-joiner 算 1 而非 0） | 低 | T3 实测 |
| 7 | **contextLines=0 泄漏折叠标记 ctx 行** | 低 | T1 实测（已修复） |
| 8 | **三路对照依赖单一推理网关**（521/524 全挂） | 中（运维） | T7 实测 + 用户确认无余额 |
| 9 | **真实任务工具调用格式漂移率高**：模型自由调用 `iron_law_check`/`thinking`/`plan`/`Read` 等不存在工具，5 步空转未达写操作 | 高 | T7 补跑 Zorge 行实测（headless 真实执行，得分 13）；合成 detector 10/10 与真实漂移形成反差 |

## 改进建议

1. **#1 → CI 无头执行通道**：新增显式 `ZORGE_EXEC_ALLOW=1` 逃生口（须与
   approvalMode=default+ 审批桥同时满足才生效，默认拒绝），或 `--allow-headless-exec`
   标志 + 文档化风险；否则 dogfooding/CI 回归永远走 mock。
2. **#2 → 边界测试补强**：给 readFile 补 0x1F/0x0B/0x1C 等控制字符边界的参数化测试
   （本次已补 0x1F）；推广到其它 `b < N` 类边界判断（grep/executor 别名归一）。
3. **#3 → API 默认值哲学**：通用工具的新参数默认取"行为不变"值（maxHunks=Infinity），
   由调用方显式收紧；或文档声明 cap 语义（ctx 不计、全替换豁免），本次已按后者落地。
4. **#4 → 会话数据自省通道**：为 `~/.zorge` 增加显式白名单命令（如 `/history inspect`）
   或在 pathGuard 加 `allowUserZorgeDir` 选项（默认关）。
5. **#5 → step 层轨迹落盘**：rollout 事件增加 `step` 类型（工具调用+结果），供
   /rewind 级回放与 T5 式审计。
6. **#8 → 网关冗余**：ModelProvider 支持多 provider 故障转移（已有 invalidateProviderCache
   单次重试），扩展为跨 provider 重试。
7. **#9（补跑新增，高优先）→ 真实格式纪律**：把合成测试的工具格式约束下沉为
   **运行时护栏**——adapter 对未知工具调用立即注入"可用工具清单"+ 格式示例回传模型
   （而非静默 UNKNOWN_TOOL），并把连续格式错误计入 failureMemory；或参考 claude 的
   做法，把工具 schema 显式注入 system prompt 顶部，减少漂移。

---

## 阶段四：门禁结果（检验后）

```
npx tsc --noEmit            EXIT 0
npm run build               EXIT 0
verify-zorge-cleanup.mjs    PASS
test-repl-smoke.mjs         PASS
全量 node --test            303 tests：302 pass + 0 fail + 1 skip（symlink 权限），EXIT 0
```

基线 298 → 检验后 303（T1/T2/T3/T6/T7 共新增 5 用例）；**主分支零改动**（全部在
`zorge-dogfood` 分支）；零新增 npm 依赖；M2.0 挂起门禁未回退（clean exit）。

---

## T7 对照（a6 中转站，2026-09-01 下午）

> 用户提供可用中转站 a6（`https://api.a6api.com/v1`），补齐此前因 `new.maoyu.cfd`
> 网关不稳定而无法成行的三路对照。任务与 2026-09-01 补跑**完全一致**（glob maxDepth），
> 三家均走 `glm-5.3-flash`（a6 端点 84 个模型中选同一模型保证公平；claude 保留其默认配置）。

### 前置：修复发现的真实能力缺口（fix-a6-routing 分支，3 commits）

dogfooding 直接暴露 Zorge 两个多供应商缺口，已修于 **`fix-a6-routing` 分支**（独立于 master，待评审合入）：

1. **裸名路由只认 scnet**：`.zorge.json` 新增 a6 provider 后 `createClient('a6:glm-5.3-flash')`
   会落进 scnet 分支——新增通用 `provider:model` 前缀路由（additive，scnet 语义不变）。
2. **非流式 complete 不解析 SSE 响应体**：a6 端点对非流式请求也返回 SSE `data:` 流，
   旧 `doComplete` 的 `res.json()` 失败返回 `{}`——补 SSE 行解析（向后兼容，JSON 路径不变）。
3. `ZORGE_MODEL` env 种子（无头一次性 mode 免交互 /model 直接指定 provider:model）。

验证：直连 `a6:glm-5.3-flash` 补全 5s 返回"你好"；ModelProvider 测试 10/10、stream 测试 3/3 不回归。

### 三路结果

| 维度 | Zorge（a6，修复后） | 修复前（2026-09-01，scnet） | Claude Code（默认） | Hermes（a6） |
|------|---------------------|---------------------------|---------------------|--------------|
| provider/模型 | **a6 / glm-5.3-flash**（`session.model` 落盘确认） | scnet / GLM-5.1 | 默认（glm/DeepSeek override） | a6 / glm-5.3-flash（配置已对） |
| 完成/未完成 | ❌ **未完成**（`result.success=false`，零代码改动） | ❌ 未完成（评分 13） | ✅ **完成** | ❌ 未成行 |
| 步骤数 / rollouts | **11 steps / 2 rollouts**（真实执行） | 5 步空转 | ~4 步 | — |
| 工具调用数 | 11（读文件真实成功；1 次误调） | 多次读 + 5 次误调 | Read/Bash/npm test | — |
| **误调未知工具次数** | **1**（`UNKNOWN_TOOL: param`——参数名当工具名） | **5**（iron_law_check 等） | 0 | — |
| 人工介入次数 | 0 | 0 | 0 | 0 |
| 耗时 | 1952s（超 15min 上限，多次停滞重试） | 117s | ~6min | 120s ×3 超时 |
| 评分 | 75（引擎自评，非交付） | 13 | — | — |
| 失败模式 | **Read-Before-Write 卡死**：glob.ts 反复读不进而拒绝盲改；一次残余工具名漂移；RBW 铁律生效但零产出 | 格式漂移空转 | 无 | **客户端与 a6 网关交互挂起**（api_mode 补齐后仍 120s 超时 ×3） |

预算：tokens 8552 / usageRatio 7%（120k 预算内，未触发降级）——a6 通道**端到端真实可用**，
瓶颈不在执行层而在**行为层**（RBW 读文件反复落空后的死守）。

### 结论（≥3 行）

1. **#9 修复有效性：部分证实**——误调未知工具次数 **5 → 1（-80%）**，且引擎轨迹自述
   "连续三步的 UNKNOWN_TOOL 问题未再复现"（负向清单 + 护栏引导生效）；但残余 1 次
   （参数名 `param` 被当工具名）说明漂移未根除。
2. **打分提升 13 → 75 会误导**——75 是引擎启发式自评（11 步真实执行 + 读成功），
   **交付为零**（glob.ts 未改动）。真实的"完成度"对比：Claude 唯一交付（DEFAULT_MAX_DEPTH +
   净化 + 3 测试 + 9/9 + 全量 315/0/1，还发现 walkFiles 本已支持 maxDepth）。
3. **Zorge 新瓶颈 = RBW 读文件链路**：模型"glob.ts 从未成功读入"（真实 read_file 成功但
   内容未进上下文），宁守铁律不盲改（安全面 ✓）但 32 分钟零产出（效率面 ✗）。这是
   #9 之后暴露的**下一个高优先短板**（读→上下文交付的可靠性）。
4. Hermes 行如实记录失败（客户端与 a6 挂起），与历轮"provider stale"同源；复跑命令保留。

### 附注

- **零密钥泄漏**：a6 与 maoyu 密钥均未进入 git 追踪（git grep 两 key 零命中）；a6 密钥仅存于
  `.zorge.json`（gitignore）与 hermes 真实配置（AppData，用户原有，已补 api_mode）。
- **还原**：`~/.hermes/config.yaml` 死路径编辑已还原（备份 `.bak-a6` 保留）；真实 AppData
  配置保留修复态 + `.bak-a6` 备份。
- **fix-a6-routing 分支**（3 commits：路由 + SSE 解析 + ZORGE_MODEL）建议评审后合入 master——
  它把 Zorge 变成真正的多供应商 agent（任意 provider:model 前缀可用）。
