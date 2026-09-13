# LME 90题 对照

> 生成: 2026-09-13T19:02:13.867Z

| 题型 | baseline | repaired | ZL-direct-90 | ZL-pipeline-90 | ZL-compact-90 | CC-90 | Pi-90 |
|---|---|---|---|---|---|---|---|
| **knowledge-update** | strict 4/15 · len 7/15 | strict 4/15 · len 3/15 | strict 7/15 · len 9/15 | strict 3/15 · len 8/15 | strict 6/15 · len 8/15 | strict 8/15 · len 9/15 | strict 8/15 · len 9/15 |
| **multi-session** | strict 2/15 · len 2/15 | strict 2/15 · len 3/15 | strict 5/15 · len 8/15 | strict 1/15 · len 5/15 | strict 6/15 · len 10/15 | strict 4/15 · len 11/15 | strict 2/15 · len 8/15 |
| **single-session-assistant** | strict 2/15 · len 5/15 | strict 2/15 · len 5/15 | strict 4/15 · len 3/15 | strict 6/15 · len 6/15 | strict 3/15 · len 3/15 | strict 8/15 · len 3/15 | strict 4/15 · len 3/15 |
| **single-session-preference** | strict 0/15 · len 1/15 | strict 0/15 · len 1/15 | strict 0/15 · len 1/15 | strict 0/15 · len 2/15 | strict 1/15 · len 2/15 | strict 1/15 · len 2/15 | strict 0/15 · len 1/15 |
| **single-session-user** | strict 1/15 · len 0/15 | strict 5/15 · len 4/15 | strict 4/15 · len 4/15 | strict 4/15 · len 4/15 | strict 6/15 · len 4/15 | strict 8/15 · len 4/15 | strict 5/15 · len 4/15 |
| **temporal-reasoning** | strict 0/15 · len 1/15 | strict 0/15 · len 2/15 | strict 0/15 · len 4/15 | strict 0/15 · len 2/15 | strict 4/15 · len 5/15 | strict 2/15 · len 9/15 | strict 1/15 · len 2/15 |
| **TOTAL** | **strict 9/90 · len 16/90** | **strict 13/90 · len 18/90** | **strict 20/90 · len 29/90** | **strict 14/90 · len 27/90** | **strict 26/90 · len 32/90** | **strict 31/90 · len 38/90** | **strict 20/90 · len 27/90** |

- answers-baseline.jsonl: timeout=0 平均耗时=6.4s 平均落卡=8.3
- answers-repaired.jsonl: timeout=0 平均耗时=6.4s 平均落卡=9.0
- answers-ZL-direct-90.jsonl: timeout=0 平均耗时=7.0s 平均落卡=0.0
- answers-ZL-pipeline-90.jsonl: timeout=0 平均耗时=12.4s 平均落卡=0.0
- answers-ZL-compact-90.jsonl: timeout=0 平均耗时=7.7s 平均落卡=0.0
- answers-CC-90.jsonl: timeout=0 平均耗时=7.1s 平均落卡=0.0
- answers-Pi-90.jsonl: timeout=0 平均耗时=2.9s 平均落卡=0.0
