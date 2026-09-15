# LME 90题 对照

> 生成: 2026-09-15T07:37:59.514Z

| 题型 | zl-7b-90 | 7b |
|---|---|---|
| **knowledge-update** | strict 10/15 · len 9/15 | strict 9/15 · len 9/15 |
| **multi-session** | strict 1/15 · len 3/15 | strict 3/15 · len 5/15 |
| **single-session-assistant** | strict 5/15 · len 5/15 | strict 8/15 · len 5/15 |
| **single-session-preference** | strict 1/15 · len 1/15 | strict 1/15 · len 1/15 |
| **single-session-user** | strict 8/15 · len 4/15 | strict 7/15 · len 4/15 |
| **temporal-reasoning** | strict 2/15 · len 5/15 | strict 3/15 · len 5/15 |
| **TOTAL** | **strict 27/90 · len 27/90** | **strict 31/90 · len 29/90** |

- answers-zl-7b-90.jsonl: timeout=0 平均耗时=32.5s 平均落卡=9.1
- answers-7b.jsonl: timeout=0 平均耗时=46.2s 平均落卡=9.1

## 逐题型 A/B 差值（answers-zl-7b-90.jsonl → answers-7b.jsonl，strict）

| 题型 | A | B | Δ |
|---|---|---|---|
| knowledge-update | 10/15 | 9/15 | -1 |
| multi-session | 1/15 | 3/15 | +2 |
| single-session-assistant | 5/15 | 8/15 | +3 |
| single-session-preference | 1/15 | 1/15 | 0 |
| single-session-user | 8/15 | 7/15 | -1 |
| temporal-reasoning | 2/15 | 3/15 | +1 |
| **TOTAL** | 27/90 | 31/90 | **+4** |

## 逐题翻转（14 题）

- 18bc8abd [knowledge-update] 1→0（A→B 转错）
- 00ca467f [multi-session] 0→1（A→B 转对）
- 078150f1 [multi-session] 0→1（A→B 转对）
- 0a995998 [multi-session] 0→1（A→B 转对）
- 0ea62687 [multi-session] 1→0（A→B 转错）
- 1903aded [single-session-assistant] 1→0（A→B 转错）
- 1b9b7252 [single-session-assistant] 0→1（A→B 转对）
- 1d4da289 [single-session-assistant] 0→1（A→B 转对）
- 3249768e [single-session-assistant] 0→1（A→B 转对）
- 3e321797 [single-session-assistant] 0→1（A→B 转对）
- 15745da0 [single-session-user] 0→1（A→B 转对）
- 19b5f2b3 [single-session-user] 1→0（A→B 转错）
- 21436231 [single-session-user] 1→0（A→B 转错）
- 08f4fc43 [temporal-reasoning] 0→1（A→B 转对）

