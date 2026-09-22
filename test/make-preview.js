'use strict';
/**
 * 把侧边栏面板单独渲染成一个静态 HTML，用于「看着改」UI。
 *
 * 关键点：HTML 不是手写的，而是用**生产代码**（out/transcript.js 的状态机）
 * 把事件流变成 op 再灌进 media/chat.js —— 所以预览里看到的 DOM 结构与真实
 * 面板一致，改 CSS 的效果也就是真实的。
 *
 * 用法: node test/make-preview.js [输出目录] [dark|light]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createState, reduce } = require('../out/transcript.js');
const { renderMarkdown } = require('../out/markdown.js');

/**
 * 预览用的一段真实 C 代码。
 * 消息里的**围栏代码块**走 highlightCode，和 diff 卡片不是同一条渲染路径 ——
 * 想验证高亮效果就得在预览里有一段围栏代码块，否则看的是 diff（本来就不上色）。
 */
const CODE_DEMO = renderMarkdown(
  '```c\n' +
    [
      '#include "driver/uart.h"',
      '',
      '#define CONSOLE_UART UART_NUM_0',
      '#define CONSOLE_BAUD 115200',
      '',
      'static void console_rx_task(void *arg)',
      '{',
      '    uint8_t buf[128];',
      '    size_t len = 0;',
      '    while (1) {',
      '        int n = uart_read_bytes(CONSOLE_UART, buf, sizeof(buf), pdMS_TO_TICKS(20));',
      '        if (n > 0 && buf[0] == 0x55) { /* 帧头 */ }',
      '    }',
      '}',
    ].join('\n') +
    '\n```'
);

const ROOT = path.join(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(os.tmpdir(), 'hermes-ui');
const THEME = (process.argv[3] || 'dark').toLowerCase();

// ───────────────────────── 构造一段有代表性的对话 ─────────────────────────

const state = createState(400);
const ops = [];
const push = (...evs) => evs.forEach((e) => ops.push(...reduce(state, e)));

push({
  t: 'session',
  sessionId: '7f4ec599-7583-4217-a2b4-861631721175',
  cwd: 'D:\\Data\\Codes\\ESP32\\ESPIDF\\LLM',
  models: {
    availableModels: [
      { modelId: 'a', name: 'opencode-go · deepseek-v4.1-flash' },
      { modelId: 'b', name: 'Nous Portal · claude-sonnet-5' },
      { modelId: 'c', name: 'Nous Portal · gpt-6-astra' },
    ],
    currentModelId: 'a',
  },
});
push({
  t: 'update',
  update: {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'help', description: 'List available commands' },
      { name: 'model', description: 'Show current model and provider, or switch models' },
      { name: 'reset', description: 'Clear conversation history' },
    ],
  },
});
push({
  t: 'update',
  update: { sessionUpdate: 'usage_update', used: 9130, size: 1000000 },
});

push({
  t: 'user',
  text: '帮我看看 bsp_uart.c 里串口初始化那段，为什么第一次发送会丢第一帧？',
});

for (const chunk of ['先看', '一下', '串口', '初始化的', '调用顺序', '……']) {
  push({ t: 'update', update: { sessionUpdate: 'agent_thought_chunk', messageId: 'th1', content: { type: 'text', text: chunk } } });
}

const markdown = `## 结论

问题出在**使能顺序**上：你在 \`uart_set_pin()\` 之前就先发了一帧数据。

典型表现：

- 第一帧整体丢失（不是丢一个字节）
- 之后一切正常

修复方式：

\`\`\`c
static void bsp_uart_init(void)
{
    uart_config_t cfg = {
        .baud_rate = 115200,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
    };
    ESP_ERROR_CHECK(uart_param_config(UART_NUM_1, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM_1, TX, RX, -1, -1));   /* 先配引脚 */
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_1, 1024, 0, 0, NULL, 0));
}
\`\`\`

注意 \`uart_driver_install()\` 必须在写之前完成，否则发送队列还不存在。`;

for (let i = 0; i < markdown.length; i += 36) {
  push({ t: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: markdown.slice(i, i + 36) } } });
}

// 一个已完成的读取工具
push({
  t: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-read',
    title: 'read_file: bsp_uart.c',
    kind: 'read',
    locations: [{ path: 'D:\\Data\\Codes\\ESP32\\ESPIDF\\LLM\\main\\bsp_uart.c' }],
    content: [{ type: 'content', content: { type: 'text', text: '读取 bsp_uart.c' } }],
  },
});
push({
  t: 'update',
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-read',
    status: 'completed',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Read D:\\Data\\Codes\\ESP32\\ESPIDF\\LLM\\main\\bsp_uart.c — 48 total lines\n\n```\n1|#include "bsp_uart.h"\n2|\n3|void bsp_uart_init(void)\n4|{\n5|    uart_driver_install(UART_NUM_1, 1024, 0, 0, NULL, 0);\n6|}\n```',
        },
      },
    ],
  },
});

// 一个已完成的终端命令
push({
  t: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-exec',
    title: 'terminal: idf.py build',
    kind: 'execute',
    locations: [],
    content: [{ type: 'content', content: { type: 'text', text: '$ idf.py build' } }],
  },
});
push({
  t: 'update',
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-exec',
    status: 'completed',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'terminal result\n- **output:** Project build complete. To flash, run: idf.py flash\n- **exit_code:** 0',
        },
      },
    ],
  },
});

// 一个进行中的写入
push({
  t: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-edit',
    title: 'write_file: bsp_uart.c',
    kind: 'edit',
    locations: [{ path: 'D:\\Data\\Codes\\ESP32\\ESPIDF\\LLM\\main\\bsp_uart.c' }],
    content: [{ type: 'content', content: { type: 'text', text: '正在写入 bsp_uart.c' } }],
  },
});

// 待确认的审批卡（用真实报文形状）
push({
  t: 'permission',
  requestId: 'perm-1',
  params: {
    sessionId: '7f4ec599-7583-4217-a2b4-861631721175',
    options: [
      { kind: 'allow_once', name: 'Allow edit', optionId: 'allow_once' },
      { kind: 'reject_once', name: 'Deny', optionId: 'deny' },
    ],
    toolCall: {
      toolCallId: 'edit-approval-1',
      kind: 'edit',
      status: 'pending',
      title: 'Approve edit: D:\\Data\\Codes\\ESP32\\ESPIDF\\LLM\\main\\bsp_uart.c',
      content: [
        {
          type: 'diff',
          path: 'D:\\Data\\Codes\\ESP32\\ESPIDF\\LLM\\main\\bsp_uart.c',
          oldText: 'void bsp_uart_init(void)\n{\n    uart_driver_install(UART_NUM_1, 1024, 0, 0, NULL, 0);\n}',
          newText:
            'void bsp_uart_init(void)\n{\n    uart_config_t cfg = { .baud_rate = 115200 };\n    ESP_ERROR_CHECK(uart_param_config(UART_NUM_1, &cfg));\n    ESP_ERROR_CHECK(uart_set_pin(UART_NUM_1, TX, RX, -1, -1));\n    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_1, 1024, 0, 0, NULL, 0));\n}',
        },
      ],
    },
  },
});

push({ t: 'notice', text: '本回合已消耗 19177 tokens' });

push({ t: 'status', status: 'ready', text: '就绪 · 1 项待确认' });

// ───────────────────────── 主题变量 ─────────────────────────

const DARK = {
  '--vscode-font-family': "'Segoe WPC','Segoe UI','Microsoft YaHei UI',system-ui,sans-serif",
  '--vscode-font-size': '13px',
  '--vscode-foreground': '#cccccc',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-sideBar-background': '#181818',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-button-background': '#0078d4',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#026ec1',
  '--vscode-button-secondaryBackground': '#313131',
  '--vscode-button-secondaryForeground': '#cccccc',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-dropdown-background': '#313131',
  '--vscode-dropdown-foreground': '#cccccc',
  '--vscode-dropdown-border': '#3c3c3c',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-errorForeground': '#f85149',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-editorWidget-border': '#313131',
  '--vscode-textCodeBlock-background': '#2b2b2b',
  '--vscode-gitDecoration-addedResourceForeground': '#81b88b',
  '--vscode-gitDecoration-deletedResourceForeground': '#e34671',
  '--vscode-charts-orange': '#d18616',
  '--vscode-toolbar-hoverBackground': '#3c3c3c',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-editorGroupHeader-tabsBackground': '#181818',
  '--vscode-inputValidation-infoBackground': '#063b49',
  '--vscode-editor-font-family': "Consolas,'Courier New',monospace",
  '--vscode-editor-font-size': '16px',
};

const LIGHT = {
  ...DARK,
  '--vscode-foreground': '#3b3b3b',
  '--vscode-editor-background': '#ffffff',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-button-background': '#005fb8',
  '--vscode-button-secondaryBackground': '#e5e5e5',
  '--vscode-button-secondaryForeground': '#3b3b3b',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-input-border': '#cecece',
  '--vscode-dropdown-background': '#ffffff',
  '--vscode-dropdown-foreground': '#3b3b3b',
  '--vscode-textLink-foreground': '#006ab1',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-textCodeBlock-background': '#f2f2f2',
  '--vscode-gitDecoration-addedResourceForeground': '#587c0c',
  '--vscode-gitDecoration-deletedResourceForeground': '#ad0707',
  '--vscode-charts-orange': '#d18616',
  '--vscode-inputValidation-infoBackground': '#d6ecff',
  '--vscode-editorGroupHeader-tabsBackground': '#f8f8f8',
};

const vars = THEME === 'light' ? LIGHT : DARK;
const varCss = Object.entries(vars)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join('\n');

const opsJson = JSON.stringify(ops).replace(/</g, '\\u003c');

// ── 直接复用**编译后的真实模板**，不再手抄一份标记 ──────────────────────
// 手抄副本会漂移：chat.js 后来新增了一个 getElementById 目标，副本里没有那个元素，
// 脚本一解引用就抛错 → 后面所有 op 都没应用 → 预览变成一张空白页。（已踩过）
const { buildHtml } = require('../out/htmlTemplate.js');

const themeStyle = `<style>
:root {
${varCss}
}
html, body {
  height: 100%;
  margin: 0;
  background: var(--vscode-sideBar-background);
}
/* 预览容器：模拟侧边栏宽度 */
#app { max-width: 420px; height: 100vh; margin: 0 auto; border-left: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); }
</style>`;

const STUB = `<script>
// chat.js 需要 acquireVsCodeApi；静态预览里只把回传消息记下来
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (m) { (window.__sent = window.__sent || []).push(m); },
    getState: function () { return {}; },
    setState: function () {},
  };
};
</script>`;

const APPLY = `<script>
const HOME = location.search.indexOf('home') >= 0;
const OPS = ${opsJson};
if (HOME) {
  // 首页态：只把 meta 落过去（这样模型/模式下拉是真实填充的样子），一条消息都不灌。
  // 直接跳过所有 op 会让下拉是空壳 —— 那是预览的假象，会误导改样式的人。
  const withMeta = OPS.filter(function (op) { return op && op.meta; })[0];
  if (withMeta) { window.postMessage({ op: 'reset', items: [], meta: withMeta.meta }, '*'); }
} else { OPS.forEach(function (op) { window.postMessage(op, '*'); }); }
// 会话弹层是由一条独立消息驱动的（不是 op），这里补一份真实形状的样例，
// 这样调它的样式时能看到真实渲染，而不是靠想象。
window.postMessage({ type: 'sessions', workspaceCwd: 'D:\\\\Data\\\\Codes\\\\ESP32\\\\ESPIDF\\\\LCD', sessions: [
  { sessionId: 's1', title: '只回答两个字：收到', updatedAt: '2026-09-21T11:44:23', cwd: 'd:\\\\Data\\\\Codes\\\\ESP32\\\\ESPIDF\\\\LCD', current: true },
  { sessionId: 's2', title: '排查 CAN IAP ACK 超时问题', updatedAt: '2026-09-12T17:49:20', cwd: 'd:\\\\Data\\\\Codes\\\\ESP32\\\\ESPIDF\\\\LCD', current: false },
  { sessionId: 's3', title: '制作 Hermes VSCode 插件', updatedAt: '2026-09-21T11:06:32', cwd: '.', current: false },
  { sessionId: 's4', title: '写 VS Code 内联补全扩展', updatedAt: '2026-09-21T08:53:51', cwd: '.', current: false },
  { sessionId: 's5', title: '整理Obsidian根目录零散文件', updatedAt: '2026-09-21T11:29:29', cwd: 'D:\\\\Data\\\\obsidian\\\\Sirlin', current: false }
]}, '*');
// 预览用的补充：真实的审批模式。录夹具时面板还没有这个功能，所以夹具里没有 ——
// 这三个值是活体探针实测回来的（不是编的），免得预览里模式格子永远是空的。
if (location.search.indexOf('modes') >= 0) {
  var withModels = OPS.filter(function (o) { return o.meta && o.meta.models; })[0];
  window.postMessage({ op: 'meta', meta: {
    status: 'ready',
    statusText: '就绪',
    modelId: 'opencode-go:deepseek-v4.1-flash',
    models: withModels ? withModels.meta.models : [],
    modes: [
      { id: 'default', name: 'Default', description: '改前询问（Ask before edits）' },
      { id: 'accept_edits', name: 'Accept Edits', description: '自动允许工作区与临时目录的编辑' },
      { id: 'dont_ask', name: "Don't Ask", description: '本会话不再询问（敏感路径除外）' }
    ],
    modeId: 'accept_edits',
    commands: [],
    pendingApprovals: 0
  }}, '*');
}
var openDropdown = function (id) {
  return function () {
    var b = document.getElementById(id);
    if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  };
};
// 注意旗标要互斥判断：'modemenu' 里也含子串 'menu'，
// 用三个独立 if 会一次全开（我第一版就栽在这，截图里看到的是「+」菜单）
if (location.search.indexOf('modemenu') >= 0) {
  setTimeout(openDropdown('mode-select'), 800);
} else if (location.search.indexOf('modelmenu') >= 0) {
  setTimeout(openDropdown('model-select'), 800);
} else if (location.search.indexOf('menu') >= 0) {
  setTimeout(openDropdown('btn-context'), 800);
}
// ?code=1：在对话末尾补一段围栏代码块，用来验证语法着色的真实效果
if (location.search.indexOf('code') >= 0) {
  window.postMessage({ op: 'add', item: {
    id: 'code-demo', kind: 'assistant', ts: Date.now(),
    html: ${JSON.stringify(CODE_DEMO)}
  }}, '*');
  setTimeout(function () { window.scrollTo(0, document.body.scrollHeight); }, 700);
}
</script>`;

function must(text, marker) {
  if (!text.includes(marker)) {
    throw new Error(`预览模板锚点未命中（htmlTemplate 改了？）：${marker}`);
  }
  return text;
}

const SCRIPT_TAG = '<script nonce="preview" src="media/chat.js"></script>';
const html = must(
  buildHtml({
    cspSource: 'vscode-webview://preview',
    nonce: 'preview',
    cssUri: 'media/chat.css',
    jsUri: 'media/chat.js',
    workspaceName: 'LLM',
  }),
  SCRIPT_TAG
)
  // 真实面板里 CSP 是必须的；静态预览要跑内联脚本，所以这里摘掉
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '')
  .replace('<title>Hermes 面板</title>', `<title>Hermes 面板 UI 预览（${THEME}）</title>`)
  .replace('</head>', `${themeStyle}\n</head>`)
  // 桩必须在 chat.js 之前，OPS 必须在 chat.js 之后（它是同步脚本，按解析顺序执行）
  .replace(SCRIPT_TAG, `${STUB}\n${SCRIPT_TAG}\n${APPLY}`);

fs.mkdirSync(path.join(OUT_DIR, 'media'), { recursive: true });
for (const file of fs.readdirSync(path.join(ROOT, 'media'))) {
  fs.copyFileSync(path.join(ROOT, 'media', file), path.join(OUT_DIR, 'media', file));
}

/** 展开版：去掉内部滚动与固定高度，方便一张长图截全（用于看卡片/审批的细节） */
const EXPANDED = `
<style>
  html, body { height: auto; }
  #app { height: auto !important; }
  #transcript { overflow: visible !important; }
</style>`;

fs.writeFileSync(path.join(OUT_DIR, 'preview.html'), html, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'preview-full.html'), html.replace('</head>', `${EXPANDED}\n</head>`), 'utf8');
console.log(`preview -> ${path.join(OUT_DIR, 'preview.html')}  (${ops.length} ops, theme=${THEME})`);
console.log(`preview -> ${path.join(OUT_DIR, 'preview-full.html')}  (整页展开版)`);
