/**
 * 侧边栏面板的 HTML 骨架（纯字符串拼装，不依赖 vscode）。
 *
 * 结构对齐 VS Code 里的 Codex 面板：
 *   顶栏：左「聊天」+ 右侧幽灵图标（重启 / 历史 / 新建）
 *   首页（没有进行中的会话时）：最近会话列表 + 右侧相对时间 + 「查看全部（N 个）」+ 居中大图标
 *   输入区：一张大圆角卡片，文本域在上，控件行在卡片内部
 *          + ／审批模式 ／（右）模型 ／ 圆形 ↑
 *
 * 动态内容一律通过 postMessage 增量推送，这里只出静态壳子，
 * CSP 用 per-render nonce 锁死，CSS/JS 走 webview 资源 URI。
 */

export interface HtmlOptions {
  cspSource: string;
  nonce: string;
  cssUri: string;
  jsUri: string;
  workspaceName?: string;
}

export function buildHtml(opts: HtmlOptions): string {
  const { cspSource, nonce, cssUri, jsUri } = opts;
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src 'none'`,
  ].join('; ');

  const workspace = opts.workspaceName ? escapeAttr(opts.workspaceName) : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>Hermes 面板</title>
</head>
<body>
<div id="app">
  <header id="hdr">
    <div class="hdr-row">
      <span class="hdr-title">聊天</span>
      <span id="status-dot" class="dot offline" title="连接状态"></span>
      <span id="status-text">未连接</span>
      <span id="pending-badge" class="hidden" title="有待确认的操作">0</span>
      <button id="btn-restart" class="icon-btn" title="重启 ACP 连接" aria-label="重启连接">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
      </button>
      <button id="btn-history" class="icon-btn" title="历史会话" aria-label="历史会话">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14z"/><path d="M11 7h2v4.6l3.3 2-1 1.7L11 12.8V7z"/></svg>
      </button>
      <button id="btn-new" class="icon-btn" title="新建会话" aria-label="新建会话">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18 10l-4-4L4 16v4zm13.7-13.3 1.6-1.6a1 1 0 0 0 0-1.4l-1.4-1.4a1 1 0 0 0-1.4 0l-1.6 1.6 2.8 2.8z"/></svg>
      </button>
    </div>
  </header>

  <section id="home" data-workspace="${workspace}">
    <div id="home-list" class="home-list"></div>
    <div id="home-more" class="home-more hidden"></div>
    <div id="empty-hint" class="home-art">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <rect x="7" y="9" width="34" height="30" rx="8"/>
        <path d="M19 20l-4 4 4 4M29 20l4 4-4 4"/>
      </svg>
    </div>
  </section>

  <main id="transcript" tabindex="0" class="hidden"></main>

  <footer id="ftr">
    <div id="usage-wrap" class="hidden" title="上下文用量">
      <div id="usage-bar"></div>
      <span id="usage-text" class="muted"></span>
    </div>
    <div id="composer-card">
      <div id="chips" class="composer-chips hidden"></div>
      <textarea id="input" rows="1" placeholder="随心输入"></textarea>
      <div class="composer-row">
        <button id="btn-context" class="chip" title="插入当前文件 / 选中代码" aria-label="插入上下文">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M11 5h2v14h-2z"/><path d="M5 11h14v2H5z"/></svg>
        </button>
        <button id="mode-select" class="chip" title="审批模式" aria-haspopup="listbox"></button>
        <span class="spacer"></span>
        <button id="model-select" class="chip" title="切换模型" aria-haspopup="listbox"></button>
        <button id="btn-stop" class="mini-btn hidden" title="中断当前回合">停止</button>
        <button id="btn-send" class="send-circle" title="发送 (Enter)" aria-label="发送">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4.8 4.6 11.2l1.4 1.4L10 8.6V20h2V8.6l4 4 1.4-1.4L11 4.8z"/></svg>
        </button>
      </div>
    </div>
    <div id="attachment" class="hidden"></div>
  </footer>

  <div id="sketch" class="hidden">
    <div class="sketch-card">
      <div class="sketch-head">
        <span>绘制草图</span>
        <span class="muted">画完点「插入」，会把 png 路径加进输入框</span>
      </div>
      <canvas id="sketch-canvas" width="480" height="300"></canvas>
      <div class="sketch-actions">
        <button id="sketch-clear" class="mini-btn">清空</button>
        <span class="spacer"></span>
        <button id="sketch-cancel" class="mini-btn">取消</button>
        <button id="sketch-insert" class="mini-btn primary">插入</button>
      </div>
    </div>
  </div>

  <div id="popover" class="popover hidden"></div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function escapeAttr(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
