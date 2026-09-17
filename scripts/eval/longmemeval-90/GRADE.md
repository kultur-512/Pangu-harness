# LME 90题 对照

> 生成: 2026-09-16T05:15:34.773Z

| 题型 | Pi-full-90 | Pi-90 |
|---|---|---|
| **knowledge-update** | strict 2/15 · len 2/15 | strict 6/15 · len 6/15 |
| **multi-session** | strict 4/15 · len 6/15 | strict 8/15 · len 10/15 |
| **single-session-assistant** | strict 6/15 · len 5/15 | strict 5/15 · len 4/15 |
| **single-session-preference** | strict 0/15 · len 1/15 | strict 1/15 · len 1/15 |
| **single-session-user** | strict 3/15 · len 2/15 | strict 7/15 · len 3/15 |
| **temporal-reasoning** | strict 3/15 · len 3/15 | strict 4/15 · len 6/15 |
| **TOTAL** | **strict 18/90 · len 19/90** | **strict 31/90 · len 30/90** |

- answers-Pi-full-90.jsonl: timeout=0 平均耗时=29.9s 平均落卡=0.0
- answers-Pi-90.jsonl: timeout=0 平均耗时=1.2s 平均落卡=0.0

## 逐题型 A/B 差值（answers-Pi-full-90.jsonl → answers-Pi-90.jsonl，strict）

| 题型 | A | B | Δ |
|---|---|---|---|
| knowledge-update | 2/15 | 6/15 | +4 |
| multi-session | 4/15 | 8/15 | +4 |
| single-session-assistant | 6/15 | 5/15 | -1 |
| single-session-preference | 0/15 | 1/15 | +1 |
| single-session-user | 3/15 | 7/15 | +4 |
| temporal-reasoning | 3/15 | 4/15 | +1 |
| **TOTAL** | 18/90 | 31/90 | **+13** |

## 逐题翻转（21 题）

- 01493427 [knowledge-update] 0→1（A→B 转对）
- 06db6396 [knowledge-update] 0→1（A→B 转对）
- 0977f2af [knowledge-update] 0→1（A→B 转对）
- 184da446 [knowledge-update] 0→1（A→B 转对）
- 0100672e [multi-session] 0→1（A→B 转对）
- 099778bb [multi-session] 0→1（A→B 转对）
- 0ea62687 [multi-session] 0→1（A→B 转对）
- 10d9b85a [multi-session] 1→0（A→B 转错）
- 1a8a66a6 [multi-session] 0→1（A→B 转对）
- 1f2b8d4f [multi-session] 0→1（A→B 转对）
- 0e5e2d1a [single-session-assistant] 1→0（A→B 转错）
- 1903aded [single-session-assistant] 1→0（A→B 转错）
- 1de5cff2 [single-session-assistant] 0→1（A→B 转对）
- 35a27287 [single-session-preference] 0→1（A→B 转对）
- 001be529 [single-session-user] 0→1（A→B 转对）
- 1faac195 [single-session-user] 0→1（A→B 转对）
- 25e5aa4f [single-session-user] 0→1（A→B 转对）
- 29f2956b [single-session-user] 0→1（A→B 转对）
- 0bb5a684 [temporal-reasoning] 0→1（A→B 转对）
- 2a1811e2 [temporal-reasoning] 1→0（A→B 转错）
- 2ebe6c92 [temporal-reasoning] 0→1（A→B 转对）

