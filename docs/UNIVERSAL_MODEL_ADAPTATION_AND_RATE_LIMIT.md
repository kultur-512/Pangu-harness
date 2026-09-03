# 通用模型适配 + Maoyulin 中转使用策略（Universal Model Support）

> **重要规则（按最新指示）**：
> - **客户端层面完全不做任何自动限流/节流/延迟**。
> - 唯一 AI 行为限制：**禁止未经用户明确要求，对中转站进行“测活”、批量多模型对比测试、持续探测、压力测试**。
> - 用户主动要求的一切动作（包括高频调用、多次 rollout、快速测试特定模型等）全部允许。
> - 限流如果需要，由用户/调用方自己在编排层自己加。

本框架的目标是：
- 在 GLM-5.x 上实现**极致 benchmark 表现**（SWE-Pro ~90 路径，当前重点）
- 同时保持对其他模型的合理适配能力（同一中转）

---

## 1. 限流策略说明（已完全放开）

- `UniversalMaoyulinClient` **完全不进行任何自动限流、延迟或节流**。
- `SimpleRateLimiter` 仅作为**可选工具类**存在，供需要自己控频的场景使用（默认不启用）。
- 之前所有强制 1 req/s 的行为已彻底移除。

**仅有的 AI 行为规则**：
- 除非用户**明确主动要求**，否则禁止对中转站进行：
  - 模型列表探测 / 测活
  - 多模型批量对比测试
  - 无意义的持续高频请求

用户主动说“帮我测一下 minimax-m3 和 grok-build-0.1”这类指令是完全允许的。

其余所有动作（包括快速连续调用、多次 rollout、高 token 请求等）均无限制。

---

## 2. 架构总览（GLM 极致强化优先）

```
模型调用层
  └── UniversalMaoyulinClient（完全不做任何自动限流）
        └── 返回 { content, toolCalls, detectedFormat, model, raw }

工具解析（GLM 首选 + 兼容）
  ├── ExtremeGlmToolCallAdapter（GLM-5.x 极致路径，重点强化）
  │     - 严格 <> 格式
  │     - GLM 特有 malformed 恢复（direct tag、invoke style 等）
  │     - 极强 repair hint
  │
  └── UniversalToolCallAdapter（用于非 GLM 模型）

核心循环（GLM 残酷模式）
  ├── StructuredReasoner（极深 thinking + 强制 format_check + 残酷 critique）
  ├── VerifyCritiqueLoop（GLM-strict：从第1步开始批评、每步强制格式纪律、重验证）
  └── Glm53SweProChaser（GLM 模型自动 glm-strict + 重锚点 + 格式+验证倾斜打分）
```

---

## 3. 两种运行模式

### 3.1 GLM-Strict 模式（Benchmark Chasing 专用）
- 目标：最大化 GLM-5.x 在 SWE-Bench / SWE-Pro 上的表现
- 工具格式：**只接受严格 <> 格式**
- Parser：ExtremeGlmToolCallAdapter
- Prompt 里要强行注入 GLM 格式要求
- 推荐用于正式 benchmark 跑分

### 3.2 Universal 模式（默认，多模型适配）
- 目标：同一套框架 + 同一中转，能 reasonably 跑通 minimax、grok 等模型
- 工具格式：三种都支持（优先尝试严格 GLM，失败则宽松解析）
- Parser：UniversalToolCallAdapter
- 推荐作为日常开发和跨模型对比使用

**切换方式**：
```ts
const chaser = new Glm53SweProChaser(client, 'universal');        // 默认
// 或
const chaser = new Glm53SweProChaser(client, 'glm-strict');
```

---

## 4. 工具调用格式支持矩阵

| 格式                        | GLM-5.2 | minimax-m3 | grok-build-0.1 | 解析策略          | 备注 |
|-----------------------------|---------|------------|----------------|-------------------|------|
| `<>` `<ToolName>` ... `</>` | 优秀    | 差         | 差             | glm-xml-strict    | GLM 基准必备 |
| `Read(file_path="...")`     | 常见    | 优秀       | 常见           | glm-loose-plain   | Maoyulin 实际观测 |
| `invoke tool X with a is b` | 少见    | 少见       | 曾出现         | glm-loose-plain   | 已被 parser 覆盖 |
| OpenAI `tool_calls` JSON    | 理论支持| 理论支持   | 理论支持       | openai-tool_calls | 目前中转较少返回 |

`UniversalToolCallAdapter` 会按顺序尝试以上策略，并返回 `detectedFormat` 供上层决策和 prompt 修复使用。

---

## 5. 推荐使用方式（GLM 强化版，无客户端限流）

### 5.1 创建客户端（无限制）

```ts
import { UniversalMaoyulinClient } from './model/UniversalMaoyulinClient.js';

const client = new UniversalMaoyulinClient({
  apiKey: 'sk-xxx',
  baseUrl: 'https://api.maoyulin.xyz',
  defaultModel: 'glm-5.2',
  // 不再传 minIntervalMs，客户端完全不限流
});
```

### 5.2 直接 GLM 极致模式（推荐）

```ts
import { VerifyCritiqueLoop } from './loop/VerifyCritiqueLoop.js';

const loop = new VerifyCritiqueLoop(client, verificationEngine, {
  useUniversalAdapter: false,
  strictGlmOnly: true,           // GLM 极致
});
```

### 5.3 通过 ZorgeChaser 使用（推荐；旧名 Glm53SweProChaser 为兼容别名）

```ts
import { ZorgeChaser } from './ZorgeChaser.js';
// 兼容：import { Glm53SweProChaser } from './Glm53SweProChaser.js';

const chaser = new ZorgeChaser(client, { tier: 'high' });  // 默认 high

const outcome = await chaser.solveIssue(
  "修复 add 函数，使 add(2,3) 返回 5",
  workspaceRoot,
  {
    tier: 'high',
    maxRollouts: 5,
    maxStepsPerRollout: 25,
  }
);
```

旧文档中出现的 `Glm53SweProChaser` / `modelMode: 'strong'` 等仅为历史用法。当前推荐使用 `ZorgeChaser` + `tier`（quick/standard/high/max/ex/zorge，默认 high）。

---

## 6. 低频中转下的最佳实践

1. **永远走客户端**  
   不要在业务循环里直接 `https.request` 或自己拼 axios，统一使用 `UniversalMaoyulinClient`。

2. **实验脚本必须手动控频**  
   `sandbox-test-two-models.cjs`、`sandbox-test-universal-models.cjs` 等都必须有 ≥5s 间隔 + 每个模型前重置状态。

3. **不要并发 rollout**  
   即使 TestTimeOrchestrator 支持多 rollout，实际跑的时候也应该串行 + 额外 sleep，或者把 maxRollouts 压到 2~3。

4. **格式自适应提示**  
   `UniversalMaoyulinClient.getFormatHint(detectedFormat, model)` 可以根据上一次解析结果给模型正确的格式提示。

5. **失败后不要立即重试**  
   遇到 429 应该指数退避，或干脆等 10~30 秒再试。

---

## 7. 迁移建议

### 旧代码（仅支持 GLM <>）
- `src/model/maoyulin-client.cjs` + `ExtremeGlmToolCallAdapter`
- 建议逐步替换为 `UniversalMaoyulinClient` + `VerifyCritiqueLoop`（useUniversalAdapter: false 可模拟旧行为）

### 沙箱测试脚本
- 保留 `sandbox-test-*.cjs` 作为**手动、低频**验证工具
- 不要把它们变成 CI 或高频 benchmark runner

---

## 8. 当前状态总结（本次改动后）

- [x] `UniversalToolCallAdapter.ts` 已实现三种格式统一解析
- [x] `UniversalMaoyulinClient.ts` 已内置可选限流
- [x] `RateLimiter.ts` 独立可用
- [x] `VerifyCritiqueLoop.ts` 已支持 string / {content, toolCalls} 两种返回
- [x] `ZorgeChaser.ts`（原 Glm53SweProChaser.ts）已支持 tier 体系
- [x] 保留了 legacy 别名 `Glm53SweProChaser`（@deprecated）

**下一步可选（不涉及中转请求）**：
- 在主循环中根据 `detectedFormat` 动态注入格式修复提示
- 把 `universal-tool-parser.cjs` 也同步更新为调用 `UniversalToolCallAdapter`（减少重复逻辑）
- 增加模型家族偏好配置（glm 优先严格格式，其他模型优先松散格式）

---

## 9. 重要警告

> **请严格遵守“每秒一次”的中转压力上限。**  
> 任何自动化多模型对比、快速重跑、并发 rollout 都必须先得到明确人工确认。

本框架现在已经具备了“完美贴合 GLM + 合理适配其他模型”的技术基础，剩下的就是**在 1 req/s 的严苛约束下，如何用最少的调用拿到最高质量的轨迹**。

---

**文档版本**：v1（引入 Universal 适配后首次发布）
**维护者**：框架核心开发
**相关代码**：
- `src/model/UniversalMaoyulinClient.ts`
- `src/adapter/UniversalToolCallAdapter.ts`
- `src/loop/VerifyCritiqueLoop.ts`
- `src/ZorgeChaser.ts`（主入口；兼容别名 `src/Glm53SweProChaser.ts`）
- `src/utils/RateLimiter.ts`
