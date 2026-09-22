'use strict';
const { ok, eq, includes, section, finish } = require('./lib');
const { renderMarkdown, escapeHtml, renderInline } = require('../out/markdown.js');

section('markdown：转义与 XSS');
{
  const dirty = '<script>alert(1)</script>';
  includes(renderMarkdown(dirty), '&lt;script&gt;', '原始 <script> 被转义');
  eq(renderMarkdown(dirty).includes('<script>'), false, '输出里不含可执行 script 标签');

  includes(renderMarkdown('`<b>x</b>`'), '&lt;b&gt;', '行内代码内容被转义');
  includes(renderMarkdown('<img src=x onerror=alert(1)>'), '&lt;img', 'img onerror 被转义');

  const evil = renderMarkdown('[点我](javascript:alert(1))');
  eq(evil.includes('href="javascript:'), false, 'javascript: 链接被拒绝');
  includes(renderMarkdown('[官网](https://example.com)'), 'href="https://example.com"', 'https 链接保留');
}

section('markdown：块级与行内');
{
  includes(renderMarkdown('## 标题'), '<h2>标题</h2>', '二级标题');
  includes(renderMarkdown('**粗**'), '<strong>粗</strong>', '粗体');
  includes(renderMarkdown('*斜*'), '<em>斜</em>', '斜体');
  includes(renderMarkdown('- a\n- b'), '<ul>', '无序列表');
  includes(renderMarkdown('1. a\n2. b'), '<ol>', '有序列表');
  includes(renderMarkdown('> 引用'), '<blockquote>', '引用块');
  includes(renderMarkdown('---'), '<hr>', '分隔线');
  includes(renderMarkdown('- [x] 完成'), 'checked', '任务列表勾选');

  const fenced = renderMarkdown('```c\nint main(void){return 0;}\n```');
  includes(fenced, 'class="language-c"', '围栏代码块带语言');
  includes(fenced, 'code-head', '代码块有独立标题栏（语言标签不再盖住第一行）');
  includes(fenced, 'tok-kw', 'C 关键字被着色');
  // 内容完整性：剥掉所有标签后必须一字不差（插 span 不能把标识符吞掉或改字）
  eq(
    fenced.replace(/<[^>]+>/g, '').includes('int main(void){return 0;}'),
    true,
    '代码内容保留（剥掉标签后原样）'
  );
  // 意图变了：main 后面紧跟 `(` → 按函数名上色（原来断言它"完全不上色"）
  includes(fenced, '<span class="tok-fn">main</span>', 'main 是函数名 → 函数色');
  eq(/<span class="tok-kw">main<\/span>/.test(fenced), false, 'main 不该被当成关键字');

  // 流式场景：模型还没吐出收尾的三反引号
  const unclosed = renderMarkdown('```c\nint a = 1;');
  includes(unclosed, 'tok-num', '未闭合围栏也能渲染并着色（流式中间态）');
  includes(unclosed, 'a = ', '变量与赋值保留');
  eq(unclosed.includes('```'), false, '未闭合围栏不会漏出反引号');

  includes(renderMarkdown('a\nb'), '<br>', '段落内换行变 <br>');
  includes(renderInline('`code` 和 **粗**'), '<code>code</code>', '行内代码与粗体共存');
}

section('代码着色：不乱染、不破 HTML');
{
  const { highlightCode } = require('../out/markdown.js');
  includes(highlightCode('const char *s = "hi";', 'c'), 'tok-kw', 'C 关键字着色');
  includes(highlightCode('const char *s = "hi";', 'c'), 'tok-str', 'C 字符串着色');
  includes(highlightCode('int a = 42;', 'c'), 'tok-num', '数字着色');
  includes(highlightCode('/* 说明 */ x', 'c'), 'tok-com', 'C 块注释着色');
  includes(highlightCode('// 行注释', 'c'), 'tok-com', 'C 行注释着色');
  eq(highlightCode('#include <stdio.h>', 'c').includes('tok-com'), false, 'C 里 # 不是注释');
  includes(highlightCode('# 注释', 'py'), 'tok-com', 'py 里 # 才是注释');
  eq(highlightCode('<script>alert(1)</script>', 'c').includes('<script>'), false, '着色不会引入未转义标签');
  eq(highlightCode('const x = 1', 'text').includes('tok-kw'), false, '不认识的语言保持纯文本');

  // 只上色 4 种 token 的后果：C 代码一片灰（实拍反馈"这么多灰色不方便阅读"）
  const c = highlightCode(
    'static void console_rx_task(void *arg) {\n  uint8_t buf[128];\n  uart_driver_install(UART_NUM_1, 512);\n}',
    'c'
  );
  includes(c, 'tok-fn', '函数名有自己的颜色');
  includes(c, 'tok-type', '_t 结尾的类型有自己的颜色');
  includes(c, 'tok-mac', '全大写宏有自己的颜色');
  includes(c, 'console_rx_task', '标识符内容没被吞掉');
  includes(c, 'uart_driver_install', '函数调用名没被吞掉');

  const pre = highlightCode('#include "driver/uart.h"\n#define CONSOLE_BAUD 115200', 'c');
  includes(pre, 'tok-pre', 'C 的 #include/#define 是预处理指令（不是注释）');
  includes(pre, 'tok-str', '头文件名按字符串上色');
  eq(pre.includes('tok-com'), false, 'C 里 # 行不该被染成注释色');
  includes(highlightCode('if (x) { return 1; }', 'c'), 'tok-kw', '关键字优先于函数名（if 仍是关键字色）');
  includes(highlightCode('# 注释', 'py'), 'tok-com', 'py 里 # 仍是注释');
  includes(highlightCode('s = "// 不是注释"', 'py'), 'tok-str', '字符串里的 // 不被误判为注释');
}

section('escapeHtml 基础');
{
  eq(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;', '五个危险字符全部转义');
}

finish();
