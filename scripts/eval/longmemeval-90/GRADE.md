# LME 90题 对照

> 生成: 2026-09-14T02:05:43.717Z

| 题型 | optimized | optimized2 |
|---|---|---|
| **knowledge-update** | strict 5/15 · len 5/15 | strict 4/15 · len 5/15 |
| **multi-session** | strict 2/15 · len 2/15 | strict 3/15 · len 5/15 |
| **single-session-assistant** | strict 4/15 · len 4/15 | strict 3/15 · len 3/15 |
| **single-session-preference** | strict 0/15 · len 1/15 | strict 1/15 · len 1/15 |
| **single-session-user** | strict 3/15 · len 2/15 | strict 3/15 · len 3/15 |
| **temporal-reasoning** | strict 1/15 · len 4/15 | strict 2/15 · len 3/15 |
| **TOTAL** | **strict 15/90 · len 18/90** | **strict 16/90 · len 20/90** |

- answers-optimized.jsonl: timeout=0 平均耗时=7.1s 平均落卡=9.1
- answers-optimized2.jsonl: timeout=0 平均耗时=10.6s 平均落卡=9.1

## 逐题型 A/B 差值（answers-optimized.jsonl → answers-optimized2.jsonl，strict）

| 题型 | A | B | Δ |
|---|---|---|---|
| knowledge-update | 5/15 | 4/15 | -1 |
| multi-session | 2/15 | 3/15 | +1 |
| single-session-assistant | 4/15 | 3/15 | -1 |
| single-session-preference | 0/15 | 1/15 | +1 |
| single-session-user | 3/15 | 3/15 | 0 |
| temporal-reasoning | 1/15 | 2/15 | +1 |
| **TOTAL** | 15/90 | 16/90 | **+1** |

## 逐题翻转（11 题）

- 184da446 [knowledge-update] 1→0（A→B 转错）
- 00ca467f [multi-session] 0→1（A→B 转对）
- 0a995998 [multi-session] 0→1（A→B 转对）
- 1c549ce4 [multi-session] 1→0（A→B 转错）
- 2bf43736 [single-session-assistant] 1→0（A→B 转错）
- 1d4e3b97 [single-session-preference] 0→1（A→B 转对）
- 1faac195 [single-session-user] 0→1（A→B 转对）
- 21436231 [single-session-user] 1→0（A→B 转错）
- 2ebe6c92 [temporal-reasoning] 0→1（A→B 转对）
- 370a8ff4 [temporal-reasoning] 0→1（A→B 转对）
- 5e1b23de [temporal-reasoning] 1→0（A→B 转错）

