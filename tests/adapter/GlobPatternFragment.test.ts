// glob pattern 残片清洗回归（REPL 真机 M3：`][minimax[>` 残片致 glob 跑空、
// 前端把解析失败的调用渲染成裸 XML）。pattern 不能套路径的激进 `]` 截断——
// 合法 glob 字符类含 `]`（如连续字符类）；只在 `][` + `>`/`<` 残片特征时截断。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UniversalToolCallAdapter } from '../../src/adapter/UniversalToolCallAdapter.js';

const adapter = new UniversalToolCallAdapter();

function parsePattern(pattern: string): string | undefined {
  const r = adapter.parse(`<><glob><pattern>${pattern}</pattern></glob></>`);
  return r.toolCalls[0]?.params.find((p: any) => p.name === 'pattern')?.value;
}

describe('glob pattern 残片清洗', () => {
  it('残片 `][minimax[>`（> 结尾）→ 从 ][ 截断', () => {
    assert.equal(parsePattern('**/*][minimax[>'), '**/*');
  });

  it('残片含 <（标签噪声）→ 同样截断', () => {
    assert.equal(parsePattern('src/*]<]minimax[>'), 'src/*');
  });

  it('合法连续字符类（][ 无 > 尾）保持原样', () => {
    assert.equal(parsePattern('*.[cm][jt]s'), '*.[cm][jt]s');
    assert.equal(parsePattern('**/*.test.[jt]s'), '**/*.test.[jt]s');
  });

  it('普通 pattern 无残片不动', () => {
    assert.equal(parsePattern('src/**/*.js'), 'src/**/*.js');
  });

  it('路径参数的激进规则不受影响（回归）', () => {
    const r = adapter.parse('<><write_file><path>todo.js]</path><content>x</content></write_file></>');
    assert.equal(r.toolCalls[0]?.params.find((p: any) => p.name === 'path')?.value, 'todo.js');
  });
});
