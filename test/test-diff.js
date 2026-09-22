'use strict';
const { ok, eq, includes, section, finish } = require('./lib');
const { lineDiff, renderDiffHtml, splitLines } = require('../out/diff.js');
const { escapeHtml } = require('../out/markdown.js');

section('diff：行级差异');
{
  const newFile = lineDiff('', 'hello from acp\n');
  eq(newFile.added, 1, '新建文件：1 行新增');
  eq(newFile.removed, 0, '新建文件：0 行删除');
  eq(newFile.rows[0].t, 'add', '第一行是新增');

  const modified = lineDiff('a\nb\nc\n', 'a\nB\nc\n');
  eq(modified.added, 1, '改一行：1 增');
  eq(modified.removed, 1, '改一行：1 删');
  const ctx = modified.rows.filter((r) => r.t === 'ctx').length;
  eq(ctx, 2, '未变的两行是上下文');

  const numbers = modified.rows.map((r) => `${r.t}:${r.oldNo ?? '-'}:${r.newNo ?? '-'}`);
  eq(numbers, ['ctx:1:1', 'del:2:-', 'add:-:2', 'ctx:3:3'], '行号标注正确（删行无新号，增行无旧号）');

  const added = lineDiff('x\n', 'x\ny\nz\n');
  eq(added.added, 2, '尾部新增两行');
  eq(added.rows[added.rows.length - 1].s, 'z', '最后一行内容正确');

  const same = lineDiff('same\n', 'same\n');
  eq(same.added, 0, '相同内容 0 增');
  eq(same.removed, 0, '相同内容 0 删');

  eq(splitLines('a\nb\n'), ['a', 'b'], 'splitLines 去掉尾随空行');
  eq(splitLines(''), [], 'splitLines 空串返回空数组');
  eq(splitLines(undefined), [], 'splitLines undefined 返回空数组');
}

section('diff：HTML 渲染与转义');
{
  const result = lineDiff('a\n', 'a\n<script>alert(1)</script>\n');
  const html = renderDiffHtml(result, escapeHtml);
  eq(html.includes('<script>'), false, 'diff 里的脚本被转义');
  includes(html, 'd-add', '新增行带高亮类');
  includes(html, '&lt;script&gt;', '转义后的内容确实在输出里');
}

finish();
