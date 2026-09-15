# LME 48题 × 9格 成绩矩阵

> 生成时间: 2026-09-13T08:57:50.100Z
> 完成格子: A1, B1, C1, C2, E1, E2, F1, F2, H1, I1, J1

## Strict 评分（多子句匹配 + normalize）

| 题型 | A1 (CC×M3) | B1 (CC×M3) | C1 (Pi×1B) | C2 (Pi×1B) | E1 (ZL-direct×1B) | E2 (ZL-direct×1B) | F1 (ZL-direct×1B) | F2 (ZL-direct×1B) | H1 (ZL-pipeline×1B) | I1 (ZL-pipeline×1B) | J1 (ZL-compact×1B) |
|-|-|-|-|-|-|-|-|-|-|-|-|
| **knowledge-update** | 3/8 (38%) | 0/8 (0%) | 3/8 (38%) | 5/8 (63%) | 5/8 (63%) | 5/8 (63%) | 5/8 (63%) | 5/8 (63%) | 6/8 (75%) | 6/8 (75%) | 4/8 (50%) |
| **multi-session** | 7/8 (88%) | 0/8 (0%) | 3/8 (38%) | 5/8 (63%) | 7/8 (88%) | 7/8 (88%) | 7/8 (88%) | 7/8 (88%) | 7/8 (88%) | 7/8 (88%) | 6/8 (75%) |
| **single-session-assistant** | 5/8 (63%) | 6/8 (75%) | 5/8 (63%) | 4/8 (50%) | 6/8 (75%) | 6/8 (75%) | 6/8 (75%) | 6/8 (75%) | 6/8 (75%) | 6/8 (75%) | 4/8 (50%) |
| **single-session-preference** | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) | 0/8 (0%) |
| **single-session-user** | 2/8 (25%) | 0/8 (0%) | 3/8 (38%) | 2/8 (25%) | 3/8 (38%) | 3/8 (38%) | 3/8 (38%) | 3/8 (38%) | 5/8 (63%) | 5/8 (63%) | 1/8 (13%) |
| **temporal-reasoning** | 3/8 (38%) | 0/8 (0%) | 2/8 (25%) | 2/8 (25%) | 3/8 (38%) | 3/8 (38%) | 3/8 (38%) | 3/8 (38%) | 3/8 (38%) | 3/8 (38%) | 1/8 (13%) |
| **TOTAL** | **20/48** (42%) | **6/48** (13%) | **16/48** (33%) | **18/48** (38%) | **24/48** (50%) | **24/48** (50%) | **24/48** (50%) | **24/48** (50%) | **27/48** (56%) | **27/48** (56%) | **16/48** (33%) |

## Lenient 评分（数字回退 fallback）

| 题型 | A1 | B1 | C1 | C2 | E1 | E2 | F1 | F2 | H1 | I1 | J1 |
|-|-|-|-|-|-|-|-|-|-|-|-|
| **knowledge-update** | 4/8 | 0/8 | 4/8 | 4/8 | 4/8 | 4/8 | 4/8 | 4/8 | 4/8 | 4/8 | 4/8 |
| **multi-session** | 6/8 | 0/8 | 2/8 | 4/8 | 5/8 | 5/8 | 5/8 | 6/8 | 7/8 | 6/8 | 4/8 |
| **single-session-assistant** | 2/8 | 3/8 | 2/8 | 2/8 | 3/8 | 2/8 | 2/8 | 2/8 | 3/8 | 3/8 | 3/8 |
| **single-session-preference** | 1/8 | 0/8 | 2/8 | 2/8 | 2/8 | 2/8 | 2/8 | 2/8 | 2/8 | 2/8 | 2/8 |
| **single-session-user** | 1/8 | 0/8 | 1/8 | 1/8 | 1/8 | 1/8 | 1/8 | 1/8 | 1/8 | 1/8 | 1/8 |
| **temporal-reasoning** | 6/8 | 0/8 | 2/8 | 3/8 | 5/8 | 5/8 | 5/8 | 5/8 | 7/8 | 7/8 | 5/8 |
| **TOTAL** | **20/48** | **3/48** | **13/48** | **16/48** | **20/48** | **19/48** | **19/48** | **20/48** | **24/48** | **23/48** | **19/48** |

## 1B 重复性：E1 vs E2（ZL-direct EN）

| 题型 | E1 strict | E2 strict | 差异 |
|------|---------|---------|------|
| knowledge-update | 5/8 | 5/8 | 0 |
| multi-session | 7/8 | 7/8 | 0 |
| single-session-assistant | 6/8 | 6/8 | 0 |
| single-session-preference | 0/8 | 0/8 | 0 |
| single-session-user | 3/8 | 3/8 | 0 |
| temporal-reasoning | 3/8 | 3/8 | 0 |

## 跨语言：E1 (EN) vs F1 (CN)（ZL-direct 1B）

| 题型 | E1 strict | F1 strict | 差异 |
|------|---------|---------|------|
| knowledge-update | 5/8 | 5/8 | 0 |
| multi-session | 7/8 | 7/8 | 0 |
| single-session-assistant | 6/8 | 6/8 | 0 |
| single-session-preference | 0/8 | 0/8 | 0 |
| single-session-user | 3/8 | 3/8 | 0 |
| temporal-reasoning | 3/8 | 3/8 | 0 |

## CC×M3: recall (A1) vs full-pipeline (B1)


## Pi×1B 重复性：C1 vs C2（EN）

| 题型 | C1 strict | C2 strict | 差异 |
|------|---------|---------|------|
| knowledge-update | 3/8 | 5/8 | +2 |
| multi-session | 3/8 | 5/8 | +2 |
| single-session-assistant | 5/8 | 4/8 | -1 |
| single-session-preference | 0/8 | 0/8 | 0 |
| single-session-user | 3/8 | 2/8 | -1 |
| temporal-reasoning | 2/8 | 2/8 | 0 |

---
*Strict: multi-clause substring match + \p{P}\p{S} normalize. Lenient: number fallback.*
