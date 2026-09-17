// 20 个各异测试任务定义：setup(ws) 写 fixture；prompt 仿用户；verify(ws) 客观验证
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const W = (ws, rel, content) => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), content); };

export const TASKS = [
// ============ 小 ============
{ id: 'regex-mail', size: 'S',
  setup(ws) { W(ws, 'task.txt', '写一个 src/validate.js，导出 isValidEmail(email)，用正则校验邮箱格式（@、域名、TLD），然后写一个不经过测试框架的快速自测：node -e 方式验证 3 个合法 2 个非法样例都能通过。'); },
  prompt: '写一个 src/validate.js，导出 isValidEmail(email)，用正则校验邮箱格式（@、域名、TLD），然后写一个不经过测试框架的快速自测：node -e 方式验证 3 个合法 2 个非法样例都能通过。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/validate.js'))) return [false, 'no src/validate.js'];
    try {
      execSync('node -e "import(\'./src/validate.js\').then(m=>{const ok=[m.isValidEmail(\'a@b.co\'),m.isValidEmail(\'x.y+z@domain.io\'),m.isValidEmail(\'u@sub.domain.org\')];const bad=[!m.isValidEmail(\'noat\'),!m.isValidEmail(\'a@b\')];if(!ok.every(Boolean)||!bad.every(Boolean))process.exit(1)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'regex self-test passed'];
    } catch (e) { return [false, 'self-test failed: ' + String(e.stderr || e.message).slice(0, 80)]; }
  } },
{ id: 'camel-conv', size: 'S',
  setup(ws) { W(ws, 'task.txt', '写 src/strutil.js 导出 camelToSnake(s)（驼峰转下划线，如 getUserInfo → get_user_info）和 snakeToCamel(s)，并附一段可直接 node 运行的自测代码验证互转。'); },
  prompt: '写 src/strutil.js 导出 camelToSnake(s)（驼峰转下划线，如 getUserInfo → get_user_info）和 snakeToCamel(s)，并附一段可直接 node 运行的自测代码验证互转。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/strutil.js'))) return [false, 'no file'];
    try {
      execSync('node -e "import(\'./src/strutil.js\').then(m=>{if(m.camelToSnake(\'getUserInfo\')!==\'get_user_info\')process.exit(1);if(m.snakeToCamel(\'get_user_info\')!==\'getUserInfo\')process.exit(2)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'conversion ok'];
    } catch (e) { return [false, 'convert failed: ' + String(e.stderr || e.message).slice(0, 80)]; }
  } },
{ id: 'json-repair', size: 'S',
  setup(ws) {
    W(ws, 'data.broken.json', '{\n  "name": "demo",\n  "count": 42,\n  "tags": ["a", "b",],\n  "meta": { "ok": true, }\n}\n');
    W(ws, 'task.txt', 'data.broken.json 是一个有语法错误的 JSON（尾逗号等问题）。修复它并把合法结果保存为 data.json，不要改动任何数据内容。');
  },
  prompt: 'data.broken.json 是一个有语法错误的 JSON（尾逗号等问题）。修复它并把合法结果保存为 data.json，不要改动任何数据内容。',
  verify(ws) {
    if (!existsSync(join(ws, 'data.json'))) return [false, 'no data.json'];
    try { const d = JSON.parse(readFileSync(join(ws, 'data.json'), 'utf8')); return [d.name === 'demo' && d.count === 42 && d.tags.length === 2 && d.meta.ok === true, 'parsed']; }
    catch (e) { return [false, 'invalid json']; }
  } },
{ id: 'readme-gen', size: 'S',
  setup(ws) {
    W(ws, 'package.json', '{\n  "name": "img-resize-cli",\n  "version": "2.1.0",\n  "description": "批量图片缩放命令行工具",\n  "bin": { "imgresize": "./cli.js" },\n  "keywords": ["image", "resize", "cli"]\n}');
    W(ws, 'cli.js', '#!/usr/bin/env node\nconsole.log("imgresize v2.1.0");\n');
    W(ws, 'task.txt', '根据 package.json 和 cli.js 的内容，为这个项目写一份专业的 README.md（含项目简介、安装方式、使用示例、关键词标签）。');
  },
  prompt: '根据 package.json 和 cli.js 的内容，为这个项目写一份专业的 README.md（含项目简介、安装方式、使用示例、关键词标签）。',
  verify(ws) {
    if (!existsSync(join(ws, 'README.md'))) return [false, 'no README.md'];
    const md = readFileSync(join(ws, 'README.md'), 'utf8');
    const need = ['img-resize-cli', '安装', 'npm', 'imgresize'].filter(k => md.includes(k));
    return [need.length >= 3, 'keywords ' + need.length + '/4, len=' + md.length];
  } },
{ id: 'fizzbuzz-file', size: 'S',
  setup(ws) { W(ws, 'task.txt', '写 src/fizzbuzz.js，导出 fizzbuzz(n) 返回 1..n 的数组：3 的倍数替换为 Fizz，5 的倍数替换为 Buzz，15 的倍数替换为 FizzBuzz，其余为数字。写完后用 node 直接运行验证 fizzbuzz(15) 的最后三项。'); },
  prompt: '写 src/fizzbuzz.js，导出 fizzbuzz(n) 返回 1..n 的数组：3 的倍数替换为 Fizz，5 的倍数替换为 Buzz，15 的倍数替换为 FizzBuzz，其余为数字。写完后用 node 直接运行验证 fizzbuzz(15) 的最后三项。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/fizzbuzz.js'))) return [false, 'no file'];
    try {
      execSync('node -e "import(\'./src/fizzbuzz.js\').then(m=>{const r=m.fizzbuzz(15);if(r[2]!==\'Fizz\'||r[4]!==\'Buzz\'||r[14]!==\'FizzBuzz\'||r[0]!==1)process.exit(1)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'fizzbuzz ok'];
    } catch (e) { return [false, 'failed: ' + String(e.stderr || e.message).slice(0, 80)]; }
  } },
{ id: 'csv-to-json', size: 'S',
  setup(ws) {
    W(ws, 'users.csv', 'id,name,role,active\n1,alice,admin,true\n2,bob,dev,false\n3,carol,dev,true\n');
    W(ws, 'task.txt', '写 scripts/convert.js 把 users.csv 转换为 users.json（数组，每行一个对象，active 转为布尔值），运行它生成 users.json。');
  },
  prompt: '写 scripts/convert.js 把 users.csv 转换为 users.json（数组，每行一个对象，active 转为布尔值），运行它生成 users.json。',
  verify(ws) {
    if (!existsSync(join(ws, 'users.json'))) return [false, 'no users.json'];
    try { const d = JSON.parse(readFileSync(join(ws, 'users.json'), 'utf8')); return [d.length === 3 && d[1].name === 'bob' && d[2].active === true && d[1].active === false, 'csv converted']; }
    catch (e) { return [false, 'invalid']; }
  } },
{ id: 'palindrome', size: 'S',
  setup(ws) { W(ws, 'task.txt', '写 src/pal.js 导出 isPalindrome(s)（忽略大小写、空格和标点），并用 node 直接自测：racecar、A man a plan a canal Panama、hello 三个样例。'); },
  prompt: '写 src/pal.js 导出 isPalindrome(s)（忽略大小写、空格和标点），并用 node 直接自测：racecar、A man a plan a canal Panama、hello 三个样例。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/pal.js'))) return [false, 'no file'];
    try {
      execSync('node -e "import(\'./src/pal.js\').then(m=>{if(!m.isPalindrome(\'racecar\'))process.exit(1);if(!m.isPalindrome(\'A man a plan a canal Panama\'))process.exit(2);if(m.isPalindrome(\'hello\'))process.exit(3)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'pal ok'];
    } catch (e) { return [false, 'failed: ' + String(e.stderr || e.message).slice(0, 80)]; }
  } },
{ id: 'env-sample', size: 'S',
  setup(ws) { W(ws, 'task.txt', '为一个典型的 Node Web 项目写一份 .env.example（PORT=3000、DATABASE_URL、JWT_SECRET、LOG_LEVEL=info、NODE_ENV=development 等常见变量，含注释说明）。'); },
  prompt: '为一个典型的 Node Web 项目写一份 .env.example（PORT=3000、DATABASE_URL、JWT_SECRET、LOG_LEVEL=info、NODE_ENV=development 等常见变量，含注释说明）。',
  verify(ws) {
    if (!existsSync(join(ws, '.env.example'))) return [false, 'no .env.example'];
    const t = readFileSync(join(ws, '.env.example'), 'utf8');
    const need = ['PORT', 'DATABASE_URL', 'JWT_SECRET', 'LOG_LEVEL'].filter(k => t.includes(k));
    return [need.length >= 3, 'vars ' + need.length + '/4'];
  } },
// ============ 中 ============
{ id: 'todo-cli', size: 'M',
  setup(ws) { W(ws, 'task.txt', '写一个零依赖的 todo CLI（todo.js）：子命令 add <text>、list、done <id>，数据存 todos.json。实现后依次运行：node todo.js add 买牛奶、node todo.js add 写报告、node todo.js done 1、node todo.js list，确认 done 的条目标记为已完成。'); },
  prompt: '写一个零依赖的 todo CLI（todo.js）：子命令 add <text>、list、done <id>，数据存 todos.json。实现后依次运行：node todo.js add 买牛奶、node todo.js add 写报告、node todo.js done 1、node todo.js list，确认 done 的条目标记为已完成。',
  verify(ws) {
    if (!existsSync(join(ws, 'todo.js'))) return [false, 'no todo.js'];
    try {
      execSync('node todo.js add 压测条目', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      const d = JSON.parse(readFileSync(join(ws, 'todos.json'), 'utf8'));
      const item = (Array.isArray(d) ? d : d.items).find(x => String(x.text).includes('压测条目'));
      return [!!item, 'add works'];
    } catch (e) { return [false, 'add failed: ' + String(e.stderr || e.message).slice(0, 80)]; }
  } },
{ id: 'lru-cache', size: 'M',
  setup(ws) { W(ws, 'task.txt', '写 src/lru.js 导出 class LRUCache（constructor(capacity)、get(key)、set(key,value)），O(1) 复杂度；并写 tests/lru.test.js（node:test）覆盖：容量淘汰、get 刷新顺序、覆盖写。运行测试确认通过。'); },
  prompt: '写 src/lru.js 导出 class LRUCache（constructor(capacity)、get(key)、set(key,value)），O(1) 复杂度；并写 tests/lru.test.js（node:test）覆盖：容量淘汰、get 刷新顺序、覆盖写。运行测试确认通过。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/lru.js'))) return [false, 'no lru.js'];
    try {
      // miss 返回值提示词未规定：undefined / -1 / null 均为合法约定，只断言"不返回旧值"
      execSync('node -e "import(\'./src/lru.js\').then(m=>{const c=new m.LRUCache(2);c.set(\'a\',1);c.set(\'b\',2);c.get(\'a\');c.set(\'c\',3);const mb=c.get(\'b\');if(mb===2)process.exit(1);if(c.get(\'a\')!==1)process.exit(2);if(c.get(\'c\')!==3)process.exit(3)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'lru behavior ok'];
    } catch (e) { return [false, 'lru failed: ' + String(e.stderr || e.message).slice(0, 80)]; }
  } },
{ id: 'debounce-lib', size: 'M',
  setup(ws) { W(ws, 'task.txt', '写 src/timing.js 导出 debounce(fn, ms) 和 throttle(fn, ms)，并写 tests/timing.test.js（node:test + timers）验证：debounce 只执行最后一次调用、throttle 在窗口内只执行一次首调。运行测试确认通过。'); },
  prompt: '写 src/timing.js 导出 debounce(fn, ms) 和 throttle(fn, ms)，并写 tests/timing.test.js（node:test + timers）验证：debounce 只执行最后一次调用、throttle 在窗口内只执行一次首调。运行测试确认通过。',
  verify(ws) {
    const t1 = existsSync(join(ws, 'src/timing.js')), t2 = existsSync(join(ws, 'tests/timing.test.js'));
    if (!t1) return [false, 'no timing.js'];
    if (t2) {
      try { const o = execSync('node --test tests/timing.test.js', { cwd: ws, encoding: 'utf8', timeout: 60000 }); return [!o.includes('# fail') || o.includes('# fail 0'), 'tests green']; }
      catch (e) { return [false, 'tests failed']; }
    }
    return [true, 'timing.js only (no tests file)'];
  } },
{ id: 'bugfix-pagination', size: 'M',
  setup(ws) {
    W(ws, 'src/paginate.js', 'export function paginate(items, page, pageSize) {\n  const start = page * pageSize; // off-by-one bug：page 从 1 开始\n  return items.slice(start, start + pageSize);\n}\n');
    W(ws, 'tests/paginate.test.js', 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { paginate } from "../src/paginate.js";\ntest("page 1 first", () => { assert.deepEqual(paginate([1,2,3,4,5], 1, 2), [1,2]); });\ntest("page 2", () => { assert.deepEqual(paginate([1,2,3,4,5], 2, 2), [3,4]); });\ntest("page beyond", () => { assert.deepEqual(paginate([1,2], 3, 2), []); });\n');
    W(ws, 'task.txt', '运行 node --test tests/paginate.test.js 会失败。修复 src/paginate.js 的分页 bug 让所有测试通过（page 从 1 开始）。');
  },
  prompt: '运行 node --test tests/paginate.test.js 会失败。修复 src/paginate.js 的分页 bug 让所有测试通过（page 从 1 开始）。',
  verify(ws) {
    try { const o = execSync('node --test tests/paginate.test.js', { cwd: ws, encoding: 'utf8', timeout: 60000 }); return [o.includes('# fail 0'), 'tests green']; }
    catch (e) { const o = String(e.stdout || ''); return [o.includes('# fail 0'), 'check']; }
  } },
{ id: 'env-parser', size: 'M',
  setup(ws) { W(ws, 'task.txt', '写 src/envparse.js 导出 parseEnv(text)：解析 .env 格式（KEY=value、# 注释行、引号值去引号、空行跳过、行内 # 注释剥离），并写 tests/envparse.test.js 覆盖以上情况，运行测试确认通过。'); },
  prompt: '写 src/envparse.js 导出 parseEnv(text)：解析 .env 格式（KEY=value、# 注释行、引号值去引号、空行跳过、行内 # 注释剥离），并写 tests/envparse.test.js 覆盖以上情况，运行测试确认通过。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/envparse.js'))) return [false, 'no envparse.js'];
    const probe = [
      '# comment line',
      'A=1',
      "B='two words'",
      'C=val # trailing',
      '',
      'D=',
    ].join('\n');
    writeFileSync(join(ws, '.probe.env'), probe);
    try {
      execSync('node -e "import(\'./src/envparse.js\').then(m=>{const fs=require(\'fs\');const r=m.parseEnv(fs.readFileSync(\'.probe.env\',\'utf8\'));if(r.A!==\'1\'||r.B!==\'two words\'||r.C!==\'val\'||r.D!==\'\')process.exit(1)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'parser ok'];
    } catch (e) { return [false, 'parse failed: ' + String(e.stderr || e.message).slice(0, 100)]; }
  } },
{ id: 'md-toc', size: 'M',
  setup(ws) {
    W(ws, 'doc.md', '# 大标题\n\n引言。\n\n## 第一章 入门\n内容A。\n\n### 1.1 安装\n内容B。\n\n## 第二章 进阶\n内容C。\n\n### 2.1 配置\n内容D。\n');
    W(ws, 'task.txt', '写 scripts/toc.js：读 doc.md，提取所有 ## 和 ### 标题生成目录（缩进区分层级，格式 "- 标题"），追加写入 toc.md 并运行。');
  },
  prompt: '写 scripts/toc.js：读 doc.md，提取所有 ## 和 ### 标题生成目录（缩进区分层级，格式 "- 标题"），追加写入 toc.md 并运行。',
  verify(ws) {
    if (!existsSync(join(ws, 'toc.md'))) return [false, 'no toc.md'];
    const t = readFileSync(join(ws, 'toc.md'), 'utf8');
    const ok = t.includes('第一章 入门') && t.includes('2.1 配置');
    return [ok, 'toc ' + (ok ? 'has' : 'missing') + ' headings'];
  } },
{ id: 'retry-lib', size: 'M',
  setup(ws) { W(ws, 'task.txt', '写 src/retry.js 导出 async retry(fn, opts)（opts: retries=3, baseMs=100）：失败按指数退避重试（100/200/400ms），全部失败抛最后错误；并写 tests/retry.test.js（node:test）验证：第 2 次成功会成功、全部失败抛错、重试次数正确。运行测试确认通过。'); },
  prompt: '写 src/retry.js 导出 async retry(fn, opts)（opts: retries=3, baseMs=100）：失败按指数退避重试（100/200/400ms），全部失败抛最后错误；并写 tests/retry.test.js（node:test）验证：第 2 次成功会成功、全部失败抛错、重试次数正确。运行测试确认通过。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/retry.js'))) return [false, 'no retry.js'];
    const t2 = existsSync(join(ws, 'tests/retry.test.js'));
    if (t2) {
      try { const o = execSync('node --test tests/retry.test.js', { cwd: ws, encoding: 'utf8', timeout: 120000 }); return [!o.includes('# fail') || o.includes('# fail 0'), 'tests green']; }
      catch (e) { return [false, 'tests failed']; }
    }
    return [true, 'retry.js only (no tests file)'];
  } },
// ============ 大 ============
{ id: 'ini-parser', size: 'L',
  setup(ws) { W(ws, 'task.txt', '写 src/ini.js 导出 parseINI(text) 和 stringifyINI(obj)：支持 [section]、key=value、; 和 # 注释、数值/布尔自动类型推断、字符串保留。写 tests/ini.test.js 覆盖：多 section、注释、类型推断、roundtrip（parse(stringify(x)) 深相等）、缺 value 报错。运行测试确认通过。'); },
  prompt: '写 src/ini.js 导出 parseINI(text) 和 stringifyINI(obj)：支持 [section]、key=value、; 和 # 注释、数值/布尔自动类型推断、字符串保留。写 tests/ini.test.js 覆盖：多 section、注释、类型推断、roundtrip（parse(stringify(x)) 深相等）、缺 value 报错。运行测试确认通过。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/ini.js'))) return [false, 'no ini.js'];
    const t2 = existsSync(join(ws, 'tests/ini.test.js'));
    if (t2) {
      try { const o = execSync('node --test tests/ini.test.js', { cwd: ws, encoding: 'utf8', timeout: 60000 }); return [!o.includes('# fail') || o.includes('# fail 0'), 'tests green']; }
      catch (e) { return [false, 'tests failed']; }
    }
    try {
      execSync('node -e "import(\'./src/ini.js\').then(m=>{const r=m.parseINI(\'[db]\\nhost = localhost\\nport = 5432\\n; c\\nverbose = true\\n\');if(r.db.host!==\'localhost\'||r.db.port!==5432||r.db.verbose!==true)process.exit(1)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'parse ok (no tests file)'];
    } catch (e) { return [false, 'parse failed']; }
  } },
{ id: 'task-queue', size: 'L',
  setup(ws) { W(ws, 'task.txt', '写 src/queue.js 导出 class TaskQueue({concurrency:2, retries:1, timeoutMs:5000})：add(fn, priority) 返回 Promise、按优先级调度、并发上限、失败自动重试 retries 次、单任务超时 timeoutMs。写 tests/queue.test.js（node:test）覆盖并发上限、优先级顺序、重试、超时。运行测试确认通过。'); },
  prompt: '写 src/queue.js 导出 class TaskQueue({concurrency:2, retries:1, timeoutMs:5000})：add(fn, priority) 返回 Promise、按优先级调度、并发上限、失败自动重试 retries 次、单任务超时 timeoutMs。写 tests/queue.test.js（node:test）覆盖并发上限、优先级顺序、重试、超时。运行测试确认通过。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/queue.js'))) return [false, 'no queue.js'];
    const t2 = existsSync(join(ws, 'tests/queue.test.js'));
    if (t2) {
      try { const o = execSync('node --test tests/queue.test.js', { cwd: ws, encoding: 'utf8', timeout: 120000 }); return [!o.includes('# fail') || o.includes('# fail 0'), 'tests green']; }
      catch (e) { return [false, 'tests failed']; }
    }
    return [true, 'queue.js only (no tests)'];
  } },
{ id: 'log-analyzer', size: 'L',
  setup(ws) {
    const lines = [];
    const levels = ['INFO', 'WARN', 'ERROR'];
    const sources = ['auth', 'api', 'db'];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 500; i++) {
      const lv = levels[Math.floor(rnd() * (rnd() > 0.8 ? 3 : 2))];
      const src = sources[Math.floor(rnd() * 3)];
      const ts = '2026-09-16T' + String(8 + Math.floor(i / 100)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + ':' + String((i * 7) % 60).padStart(2, '0');
      lines.push(ts + ' [' + lv + '] ' + src + ': message ' + i + (lv === 'ERROR' ? ' code=E' + (i % 9) : ' ok'));
    }
    W(ws, 'app.log', lines.join('\n'));
    const errCount = lines.filter(l => l.includes('[ERROR]')).length;
    W(ws, 'expected.txt', String(errCount));
    W(ws, 'task.txt', '写 scripts/analyze.js 分析 app.log：统计总行数、各级别（INFO/WARN/ERROR）行数、每个来源（auth/api/db）的 ERROR 数，输出 JSON 报告到 report.json（字段：total, info, warn, error, errorsBySource）。');
  },
  prompt: '写 scripts/analyze.js 分析 app.log：统计总行数、各级别（INFO/WARN/ERROR）行数、每个来源（auth/api/db）的 ERROR 数，输出 JSON 报告到 report.json（字段：total, info, warn, error, errorsBySource）。',
  verify(ws) {
    if (!existsSync(join(ws, 'report.json'))) return [false, 'no report.json'];
    try {
      const rp = JSON.parse(readFileSync(join(ws, 'report.json'), 'utf8'));
      const expected = Number(readFileSync(join(ws, 'expected.txt'), 'utf8').trim());
      const totalOk = rp.total === 500;
      const errOk = Math.abs((rp.error ?? 0) - expected) <= 2;
      const srcOk = rp.errorsBySource && typeof rp.errorsBySource === 'object';
      return [totalOk && errOk && srcOk, 'total=' + rp.total + ' err=' + rp.error + '/' + expected];
    } catch (e) { return [false, 'invalid report']; }
  } },
{ id: 'md-table-sort', size: 'L',
  setup(ws) {
    W(ws, 'data.md', '| 名称 | 数量 | 单价 |\n|---|---|---|\n| 苹果 | 30 | 5.5 |\n| 香蕉 | 12 | 3.2 |\n| 樱桃 | 45 | 12.0 |\n| 榴莲 | 7 | 25.0 |\n');
    W(ws, 'task.txt', '写 scripts/sorttable.js：读 data.md 的 markdown 表格，按"数量"列降序排序后重写整个表格回 data.md（保持格式），并运行脚本。');
  },
  prompt: '写 scripts/sorttable.js：读 data.md 的 markdown 表格，按"数量"列降序排序后重写整个表格回 data.md（保持格式），并运行脚本。',
  verify(ws) {
    const t = readFileSync(join(ws, 'data.md'), 'utf8');
    const rows = t.split('\n').filter(l => l.startsWith('|') && !l.includes('--') && !l.includes('名称'));
    const nums = rows.map(r => Number(r.split('|')[2].trim()));
    const sorted = nums.every((n, i) => i === 0 || nums[i - 1] >= n);
    return [sorted && nums.length === 4 && nums[0] === 45, 'sorted: ' + nums.join(',')];
  } },
{ id: 'fib-memo', size: 'L',
  setup(ws) { W(ws, 'task.txt', '写 src/fib.js 导出 memoFib(n)：带记忆化的斐波那契（Map 缓存），支持 n 到 10000 不栈溢出（迭代或尾递归+缓存）；并写 tests/fib.test.js 验证 fib(10)=55、fib(50)=12586269025、fib(10000) 在 200ms 内完成。运行测试确认通过。'); },
  prompt: '写 src/fib.js 导出 memoFib(n)：带记忆化的斐波那契（Map 缓存），支持 n 到 10000 不栈溢出（迭代或尾递归+缓存）；并写 tests/fib.test.js 验证 fib(10)=55、fib(50)=12586269025、fib(10000) 在 200ms 内完成。运行测试确认通过。',
  verify(ws) {
    if (!existsSync(join(ws, 'src/fib.js'))) return [false, 'no fib.js'];
    const t2 = existsSync(join(ws, 'tests/fib.test.js'));
    if (t2) {
      try { const o = execSync('node --test tests/fib.test.js', { cwd: ws, encoding: 'utf8', timeout: 60000 }); return [!o.includes('# fail') || o.includes('# fail 0'), 'tests green']; }
      catch (e) { return [false, 'tests failed']; }
    }
    try {
      execSync('node -e "import(\'./src/fib.js\').then(m=>{const v=m.memoFib(50);if(String(v)!==\'12586269025\')process.exit(1);const t=Date.now();m.memoFib(10000);if(Date.now()-t>2000)process.exit(2)})"', { cwd: ws, encoding: 'utf8', timeout: 30000 });
      return [true, 'fib ok (no tests file)'];
    } catch (e) { return [false, 'fib failed']; }
  } },
{ id: 'rest-api', size: 'L',
  setup(ws) { W(ws, 'task.txt', '写一个零依赖的 REST API 服务器（server.js，端口 3000）：内存存储的 books 资源，支持 GET /books、GET /books/:id、POST /books（JSON body）、DELETE /books/:id，404 和 400 错误处理。写完后启动服务器并用 curl 完成一次完整 CRUD 冒烟（创建→查询→删除→确认 404），最后停掉服务器。'); },
  prompt: '写一个零依赖的 REST API 服务器（server.js，端口 3000）：内存存储的 books 资源，支持 GET /books、GET /books/:id、POST /books（JSON body）、DELETE /books/:id，404 和 400 错误处理。写完后启动服务器并用 curl 完成一次完整 CRUD 冒烟（创建→查询→删除→确认 404），最后停掉服务器。',
  verify(ws) {
    if (!existsSync(join(ws, 'server.js'))) return [false, 'no server.js'];
    return [true, 'server.js exists (smoke manual)'];
  } },
];
