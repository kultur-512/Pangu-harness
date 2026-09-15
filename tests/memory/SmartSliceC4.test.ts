// tests/memory/SmartSliceC4.test.ts
// C4（2026-09-14 LME 归因）：smartSlice 数字句前置 + 跳过式补齐——
//   (a) 第一遍数字句收集由 break 改 continue：装不下的大数字句不再挡住其后的
//       小数字句（与注入侧 R1 同款 skip 语义）；
//   (b) 输出恒为"数字句在前、补齐句在后"（构造性保证），使 A 行 400 渲染段
//       （C2）内数字事实前置。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { smartSlice } from '../../src/memory/chatFactMemory.js';

describe('C4：smartSlice 数字句前置 + 跳过式补齐', () => {
  it('大数字句装不下时，其后的数字句仍被收录并前移（旧第一遍 break 下整段丢弃）', () => {
    // 三句全含数字：D1=244、D2=205、D3=95，预算 400
    const d1 = 'x'.repeat(240) + ' 42.';
    const d2 = 'y'.repeat(200) + ' 77.';
    const d3 = 'z'.repeat(90) + ' 33.';
    const out = smartSlice(`${d1} ${d2} ${d3}`, 400);
    assert.ok(out.length <= 400, `预算内，got ${out.length}`);
    assert.ok(out.includes('42.'), '首数字句保留');
    assert.ok(out.includes('33.'), '装不下的大数字句之后的小数字句仍收录（旧 break 必红）');
    assert.ok(!out.includes('77.'), '装不下的大数字句本身被跳过（不占预算）');
    assert.ok(out.indexOf('42.') < out.indexOf('33.'), '保留的数字句按原相对序');
  });

  it('混合内容：数字句排在最前，补齐句在后（A 行 400 渲染段内数字事实前置）', () => {
    // 全文 95 字符 > 预算 70 才触发裁剪：数字句(25) + 普通句 26/26/18
    const out = smartSlice(
      'plain alpha sentence here. value is 42 units total. plain beta sentence here. plain gamma tail.',
      70
    );
    assert.ok(out.length <= 70, `预算内，got ${out.length}`);
    assert.ok(out.startsWith('value is 42'), '数字句在输出最前（C4 前置锁定）');
    assert.ok(out.includes('alpha') && out.includes('gamma'), '装得下的补齐句照常保留');
    assert.ok(
      out.indexOf('42') < out.indexOf('alpha'),
      '数字句先于普通补齐句'
    );
  });

  it('预算内（不超长）原文原样返回；结果不超预算', () => {
    assert.equal(smartSlice('short text 42.', 100), 'short text 42.');
    const out = smartSlice('a'.repeat(500) + ' 7. ' + 'b'.repeat(500), 300);
    assert.ok(out.length <= 300, `兜底不超预算，got ${out.length}`);
  });
});

describe('review 建议返工-1：smartSlice gold 丢失边界（>预算数字句回退硬切保头部）', () => {
  it('>400 字符数字句 + 小填充句：数字句头部必须存活（不得被填充句挤掉）', () => {
    const longDigit = '最终测量结果为 9876543 个单位，这一数字经过三次独立复核确认无误。' + '补充说明文字。'.repeat(20);
    const out = smartSlice(longDigit + ' Small filler note here.', 400);
    assert.ok(out.includes('9876543'), `数字句头部必须存活，got ${JSON.stringify(out.slice(0,120))}`);
  });
  it('数字句装得下时行为不变（skip 语义回归）', () => {
    const out = smartSlice('小数字句 42 个。' + '填充。'.repeat(200), 400);
    assert.ok(out.includes('42'), '数字句存活');
  });
});
