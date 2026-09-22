/**
 * 极简 Markdown → HTML 渲染（纯函数，可在 Node 里直接测）。
 *
 * 为什么自己写：ACP 的回复是流式增量，每个 chunk 都要重新渲染当前消息；
 * 引 marked / DOMPurify 会把扩展体积和 CSP 复杂度都拉上去，而 agent 输出
 * 的 Markdown 子集其实很小。这里所有输入都先转义，再做白名单变换 ——
 * 任何 <script> / onerror= 都到不了 DOM。
 */

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 围栏代码块的占位符：\u0000B<序号>\u0000（序号必须在两个标记中间） */
const PLACEHOLDER_PREFIX = '\u0000B';
const PLACEHOLDER_SUFFIX = '\u0000';

/** 只放行 http/https 链接，其它（javascript:、data:）一律降级成纯文本 */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/** 行内元素：先转义，再按白名单替换 */
export function renderInline(raw: string): string {
  let text = escapeHtml(raw);

  // 行内代码最先处理：里面的 * _ [ ] 都不该再被当成语法
  const codes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(String(code));
    return `\u0001I${codes.length - 1}\u0001`;
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const url = safeUrl(href);
    return url
      ? `<a href="${escapeHtml(url)}" title="${escapeHtml(url)}">${label}</a>`
      : match;
  });

  text = text.replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  text = text.replace(/~~(?!\s)([\s\S]+?)(?<!\s)~~/g, '<del>$1</del>');

  text = text.replace(/\u0001I(\d+)\u0001/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return text;
}

/** 只转义在文本节点里有意义的三个字符。
 *  代码高亮必须在转义之后做，而 escapeHtml 会把引号变成 &quot;，
 *  那样字符串字面量就再也匹配不上了 —— 所以代码块单独用这个。 */
export function escapeForText(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 认得的语言才上色；不认识的（比如 shell 输出）宁可保持纯文本，也别染花 */
const HIGHLIGHT_LANGS = new Set([
  'c', 'h', 'cpp', 'c++', 'cc', 'hpp', 'cs', 'java', 'js', 'javascript', 'ts', 'typescript',
  'py', 'python', 'rs', 'rust', 'go', 'sh', 'bash', 'json', 'yaml', 'yml', 'ini', 'cmake', 'makefile',
]);

/** `#` 开头的注释：只在脚本类语言里成立（C 里那是指令行，不能当注释） */
const HASH_COMMENT_LANGS = new Set(['py', 'python', 'sh', 'bash', 'yaml', 'yml', 'ini', 'cmake', 'makefile']);

const KEYWORD_RE = new RegExp(
  '^(?:' +
    [
      'if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
      'goto', 'sizeof', 'typedef', 'struct', 'union', 'enum', 'static', 'const', 'volatile', 'extern',
      'inline', 'register', 'restrict', 'unsigned', 'signed', 'void', 'char', 'short', 'int', 'long',
      'float', 'double', 'bool', 'true', 'false', 'NULL', 'nullptr', 'class', 'public', 'private',
      'protected', 'virtual', 'override', 'new', 'delete', 'try', 'catch', 'throw', 'namespace',
      'using', 'template', 'typename', 'auto', 'def', 'import', 'from', 'as', 'with', 'lambda',
      'pass', 'None', 'True', 'False', 'self', 'async', 'await', 'yield', 'global', 'function',
      'var', 'let', 'export', 'default', 'interface', 'extends', 'implements', 'typeof', 'instanceof',
      'func', 'fn', 'let', 'mut', 'impl', 'trait', 'pub', 'use', 'match', 'where', 'package', 'defer',
      'go', 'range', 'chan', 'select', 'map', 'struct', 'type', 'end',
    ].join('|') +
    ')$'
);

/** 类型名和 `_t` 结尾的 typedef：C 代码里满屏都是，不单独上色就是一片灰 */
const TYPE_RE = new RegExp(
  '^(?:' +
    [
      'void', 'char', 'short', 'int', 'long', 'float', 'double', 'bool',
      'size_t', 'ssize_t', 'string', 'object', 'number', 'boolean', 'any', 'unknown',
    ].join('|') +
    '|[A-Za-z_][A-Za-z0-9_]*_t' +
    ')$'
);

/** 全大写宏：CONSOLE_UART、UART_NUM_0 这类 */
const MACRO_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/** C 家族才有预处理指令（`#include` 在 C 里是指令，在 py 里是注释） */
const C_LANGS = new Set(['c', 'h', 'cpp', 'c++', 'cc', 'hpp', 'cs', 'java']);

/**
 * 极简语法着色（纯函数）。单趟扫描，注释/字符串/数字/关键字互不干扰，
 * 顺序也保证了 `"// 不是注释"` 这种内容不会被误判。
 */
export function highlightCode(code: string, lang: string): string {
  const language = String(lang || '').toLowerCase();
  const escaped = escapeForText(code);
  if (!HIGHLIGHT_LANGS.has(language)) {
    return escaped;
  }
  const allowHash = HASH_COMMENT_LANGS.has(language);
  // ⚠️ 用具名捕获组，不要靠位置读组：注释那一支是否包含 `#` 分支会改变后续组的下标，
  // 按固定位置读就会整体错位（字符串读成注释、关键字读成数字）。测试已经抓过这个 bug。
  // ⚠️ 也别手写转义：正则源 → TS 字符串 → HTML 有三层，`\\\\\\n` 这种数错一次就是
  // 一整行的语法错（真写坏过）。统一用 String.raw，所见即所得。
  const commentAlt = allowHash
    ? String.raw`(?<com>\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)`
    : String.raw`(?<com>\/\*[\s\S]*?\*\/|\/\/[^\n]*)`;
  // C 家族的 `#include` / `#define` 是预处理指令，不该按注释上色
  const preAlt = C_LANGS.has(language) ? String.raw`|(?<pre>#\s*\w+)` : '';
  const pattern = new RegExp(
    [
      commentAlt,
      preAlt,
      String.raw`|(?<str>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`,
      // 十六进制/二进制也要认：嵌入式代码里 0x55、0x40000000 满地都是，
      // 不认的话会被切成 `0` + `x55`（数字色 + 灰色），很难看
      String.raw`|(?<num>\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?)[uUlLfF]*\b)`,
      // 后面紧跟 `(` 的标识符按函数名上色；关键字优先判断，所以 `if (` 仍是关键字色
      String.raw`|(?<fn>[A-Za-z_]\w*)(?=\s*\()`,
      String.raw`|(?<word>[A-Za-z_]\w*)`,
    ].join(''),
    'g'
  );

  return escaped.replace(pattern, (...args: unknown[]) => {
    const match = String(args[0]);
    const groups = args[args.length - 1] as Record<string, string | undefined> | undefined;
    if (!groups || typeof groups !== 'object') {
      return match;
    }
    if (groups.com) {
      return `<span class="tok-com">${groups.com}</span>`;
    }
    if (groups.pre) {
      return `<span class="tok-pre">${groups.pre}</span>`;
    }
    if (groups.str) {
      return `<span class="tok-str">${groups.str}</span>`;
    }
    if (groups.num) {
      return `<span class="tok-num">${groups.num}</span>`;
    }
    if (groups.fn) {
      return KEYWORD_RE.test(groups.fn)
        ? `<span class="tok-kw">${groups.fn}</span>`
        : `<span class="tok-fn">${groups.fn}</span>`;
    }
    if (groups.word && KEYWORD_RE.test(groups.word)) {
      return `<span class="tok-kw">${groups.word}</span>`;
    }
    if (groups.word && TYPE_RE.test(groups.word)) {
      return `<span class="tok-type">${groups.word}</span>`;
    }
    if (groups.word && MACRO_RE.test(groups.word)) {
      return `<span class="tok-mac">${groups.word}</span>`;
    }
    return match;
  });
}

export function renderMarkdown(source: string): string {
  const src = String(source ?? '').replace(/\r\n?/g, '\n');
  const blocks: { lang: string; code: string }[] = [];

  // 围栏代码块先整块摘出来（未闭合的围栏也算，流式输出时很常见）
  const withPlaceholders = src.replace(/```([\w+#.-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    blocks.push({ lang: String(lang || ''), code: String(code).replace(/\n$/, '') });
    return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  const lines = withPlaceholders.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const placeholder = /^\u0000B(\d+)\u0000$/.exec(line);
    if (placeholder) {
      flushAll();
      const block = blocks[Number(placeholder[1])];
      const langClass = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : '';
      // 语言标签放进独立标题栏，不再绝对定位盖在代码右上角（会压住第一行）
      const head = `<div class="code-head">${escapeHtml(block.lang || '代码')}</div>`;
      out.push(
        `<div class="code-block">${head}<pre><code${langClass}>${highlightCode(block.code, block.lang)}</code></pre></div>`
      );
      continue;
    }

    // 占位符可能和正文同行（渲染兼容），先还原再走行内处理
    const restored = line.replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => {
      const block = blocks[Number(i)];
      return `\`\`\`\n${block ? block.code : ''}\n\`\`\``;
    });

    if (!restored.trim()) {
      flushAll();
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(restored)) {
      flushAll();
      out.push('<hr>');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(restored);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const quoteLine = /^\s*>\s?(.*)$/.exec(restored);
    if (quoteLine) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1]);
      continue;
    }
    if (quote.length) {
      flushQuote();
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(restored);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(restored);
    if (bullet || ordered) {
      flushParagraph();
      const wanted: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
      if (listType !== wanted) {
        flushList();
        listType = wanted;
        out.push(`<${wanted}>`);
      }
      const content = (bullet || ordered)![1];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      out.push(
        task
          ? `<li class="task"><input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> ${renderInline(task[2])}</li>`
          : `<li>${renderInline(content)}</li>`
      );
      continue;
    }
    flushList();
    paragraph.push(restored);
  }
  flushAll();
  return out.join('\n');
}
