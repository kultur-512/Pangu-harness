# LME 90题 对照

> 生成: 2026-09-15T03:19:14.274Z

| 题型 | zl-m3-cjk15 | zl-m3-90 |
|---|---|---|
| **knowledge-update** | strict 9/15 · len 9/15 | strict 9/15 · len 9/15 |
| **multi-session** | strict 7/15 · len 10/15 | strict 9/15 · len 11/15 |
| **single-session-assistant** | strict 10/15 · len 5/15 | strict 10/15 · len 6/15 |
| **single-session-preference** | strict 1/15 · len 2/15 | strict 0/15 · len 2/15 |
| **single-session-user** | strict 10/15 · len 4/15 | strict 10/15 · len 4/15 |
| **temporal-reasoning** | strict 9/15 · len 9/15 | strict 9/15 · len 8/15 |
| **TOTAL** | **strict 46/90 · len 39/90** | **strict 47/90 · len 40/90** |

- answers-zl-m3-cjk15.jsonl: timeout=0 平均耗时=8.3s 平均落卡=9.1
- answers-zl-m3-90.jsonl: timeout=0 平均耗时=8.6s 平均落卡=9.1

## 逐题型 A/B 差值（answers-zl-m3-cjk15.jsonl → answers-zl-m3-90.jsonl，strict）

| 题型 | A | B | Δ |
|---|---|---|---|
| knowledge-update | 9/15 | 9/15 | 0 |
| multi-session | 7/15 | 9/15 | +2 |
| single-session-assistant | 10/15 | 10/15 | 0 |
| single-session-preference | 1/15 | 0/15 | -1 |
| single-session-user | 10/15 | 10/15 | 0 |
| temporal-reasoning | 9/15 | 9/15 | 0 |
| **TOTAL** | 46/90 | 47/90 | **+1** |

## 逐题翻转（7 题）

- 0100672e [multi-session] 0→1（A→B 转对）
- 09ba9854 [multi-session] 0→1（A→B 转对）
- 2bf43736 [single-session-assistant] 1→0（A→B 转错）
- 4388e9dd [single-session-assistant] 0→1（A→B 转对）
- 35a27287 [single-session-preference] 1→0（A→B 转错）
- 0db4c65d [temporal-reasoning] 0→1（A→B 转对）
- 6e984301 [temporal-reasoning] 1→0（A→B 转错）

