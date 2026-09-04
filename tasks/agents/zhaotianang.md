# Agent 注册卡 — zhaotianang

- 控制人: 赵天昂
- 拼音:   zhaotianang
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: feature/zhaotianang
- 角色:  **Main-B（中坚）**
- 任务块: W4 — P4 语义检索 v0 + P5 多级摘要

## 工作内容

- `src/memory/embed.ts`：`EmbeddingProvider` 接口 + `LocalNGramHashProvider`（字符 2-gram 4096 哈希桶 + 余弦）。
- `src/memory/RefinedMemoryStore.ts`：构造接 `embedProvider`/`embedCache`；`loadFiltered` 加 `semanticScore`；排序 = 0.5w + 0.2rel + 0.3sem；`.panshalach-embed-cache.json` 缓存。
- `src/cli/repl/compactService.ts` + `compactStrategies.ts`：三级摘要（L0=6 轮逐字 / L1 中期 12k+ 摘要 / L2 长期 30k+ 段落）。
- `src/cli/MemoryCommand.ts`：`memory search-semantic <text>` / `memory embed-stats`。
- `.panshalach.json.example`：`embedding.provider` 字段。

## 备注

- 阶段交付见 `WORK-PLAN-MAIN-LEARN.md` §5.4
- 与翟源昊（W1）协调 `EmbeddingProvider` 接口签名（W1.1 接口契约 PR）
- 与王浩宇（W2）协调 markUsed 后 embed 缓存 TTL 一致性
