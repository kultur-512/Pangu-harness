# LME 90题 对照

> 生成: 2026-09-14T05:32:27.363Z

| 题型 | baseline | repaired | optimized | optimized2 | final |
|---|---|---|---|---|---|
| **knowledge-update** | strict 4/15 · len 7/15 | strict 4/15 · len 3/15 | strict 5/15 · len 5/15 | strict 4/15 · len 5/15 | strict 5/15 · len 6/15 |
| **multi-session** | strict 2/15 · len 2/15 | strict 2/15 · len 3/15 | strict 2/15 · len 2/15 | strict 3/15 · len 5/15 | strict 2/15 · len 4/15 |
| **single-session-assistant** | strict 2/15 · len 5/15 | strict 2/15 · len 5/15 | strict 4/15 · len 4/15 | strict 3/15 · len 3/15 | strict 3/15 · len 4/15 |
| **single-session-preference** | strict 0/15 · len 1/15 | strict 0/15 · len 1/15 | strict 0/15 · len 1/15 | strict 1/15 · len 1/15 | strict 1/15 · len 1/15 |
| **single-session-user** | strict 1/15 · len 0/15 | strict 5/15 · len 4/15 | strict 3/15 · len 2/15 | strict 3/15 · len 3/15 | strict 3/15 · len 3/15 |
| **temporal-reasoning** | strict 0/15 · len 1/15 | strict 0/15 · len 2/15 | strict 1/15 · len 4/15 | strict 2/15 · len 3/15 | strict 2/15 · len 4/15 |
| **TOTAL** | **strict 9/90 · len 16/90** | **strict 13/90 · len 18/90** | **strict 15/90 · len 18/90** | **strict 16/90 · len 20/90** | **strict 16/90 · len 22/90** |

- answers-baseline.jsonl: timeout=0 平均耗时=6.4s 平均落卡=8.3
- answers-repaired.jsonl: timeout=0 平均耗时=6.4s 平均落卡=9.0
- answers-optimized.jsonl: timeout=0 平均耗时=7.1s 平均落卡=9.1
- answers-optimized2.jsonl: timeout=0 平均耗时=10.6s 平均落卡=9.1
- answers-final.jsonl: timeout=0 平均耗时=3.1s 平均落卡=9.1
