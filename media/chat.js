/* Hermes 面板的 webview 脚本 —— 纯 JS，无构建步骤。
 * 它只做两件事：把扩展推来的增量操作落到 DOM 上，把用户操作回传扩展。
 * 所有 HTML 都由扩展侧渲染好（markdown 已转义），这里不做任何 eval / innerHTML 拼装。 */
(function () {
  const vscode = acquireVsCodeApi();

  const transcriptEl = document.getElementById('transcript');
  const homeEl = document.getElementById('home');
  const homeList = document.getElementById('home-list');
  const homeMore = document.getElementById('home-more');
  const emptyHint = document.getElementById('empty-hint');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const modelSelect = document.getElementById('model-select');
  const modeSelect = document.getElementById('mode-select');
  const input = document.getElementById('input');
  const btnSend = document.getElementById('btn-send');
  const btnStop = document.getElementById('btn-stop');
  const btnNew = document.getElementById('btn-new');
  const btnHistory = document.getElementById('btn-history');
  const btnRestart = document.getElementById('btn-restart');
  const btnContext = document.getElementById('btn-context');
  const popover = document.getElementById('popover');
  const usageWrap = document.getElementById('usage-wrap');
  const usageBar = document.getElementById('usage-bar');
  const usageText = document.getElementById('usage-text');
  const attachment = document.getElementById('attachment');
  const pendingBadge = document.getElementById('pending-badge');
  const chipsEl = document.getElementById('chips');
  const sketchEl = document.getElementById('sketch');
  const sketchCanvas = document.getElementById('sketch-canvas');
  const btnSketchClear = document.getElementById('sketch-clear');
  const btnSketchCancel = document.getElementById('sketch-cancel');
  const btnSketchInsert = document.getElementById('sketch-insert');

  const usageFill = document.createElement('div');
  usageFill.id = 'usage-fill';
  usageBar.appendChild(usageFill);

  /** id -> { data, sync, el } */
  const items = new Map();
  let meta = { status: 'offline', statusText: '未连接', models: [], commands: [], pendingApprovals: 0 };
  let busy = false;
  let stickToBottom = true;
  /** 最近一次 session/list 的结果，首页和"查看全部"弹层共用 */
  let lastSessions = { workspaceCwd: '', here: [], others: [] };
  /** 点时钟图标时置位：列表拉回来要开弹层。拉取是异步的，不能直接弹（会弹旧数据） */
  let wantPopover = false;
  /** 面板侧状态：本会话目标 / 计划模式（都是提示词层实现，扩展侧是真源） */
  let scratch = { goal: '', planMode: false };
  /** Hermes 给的模型清单（下拉是自家渲染的，所以得自己存一份） */
  let models = [];

  // ───────────────────────── 工具函数 ─────────────────────────

  function post(msg) {
    vscode.postMessage(msg);
  }

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function nearBottom() {
    return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60;
  }

  function maybeScroll(force) {
    if (force || stickToBottom) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
    stickToBottom = nearBottom();
  }

  /** 模型显示名：剥掉 provider 前缀。
   *  卡片里只有一百多像素，"opencode-go · deepseek-v4.1-flash" 必然被截成
   *  "opencode-go · deepseek-v4…" —— 前缀是整个字符串里最没用的一段。
   *  注意分隔符实测是「 · 」不是「:」，两种都得认（不同后端给的形态不一样）。 */
  function shortModelName(name) {
    let s = String(name || '');
    for (const sep of [' · ', '/', ':']) {
      const i = s.indexOf(sep);
      if (i > 0 && i + sep.length < s.length) {
        s = s.slice(i + sep.length);
        break;
      }
    }
    return s;
  }

  /** 没有进行中的会话时露出首页（最近会话 + 居中大图标），有内容时露出会话流 */
  function updateEmptyHint() {
    const home = items.size === 0;
    if (homeEl) {
      homeEl.classList.toggle('hidden', !home);
    }
    transcriptEl.classList.toggle('hidden', home);
    if (emptyHint) {
      emptyHint.style.display = home ? '' : 'none';
    }
  }

  /** 相对时间，Codex 那种「1 天」 */
  function relTime(iso) {
    if (!iso) {
      return '';
    }
    const t = Date.parse(iso);
    if (isNaN(t)) {
      return '';
    }
    const mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + ' 天';
    return Math.floor(days / 30) + ' 个月';
  }

  /** 首页：最近 3 条 + 「查看全部（N 个）」 */
  function renderHome() {
    if (!homeList) {
      return;
    }
    const all = lastSessions.here.concat(lastSessions.others);
    all.sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    homeList.innerHTML = '';
    all.slice(0, 3).forEach(function (s) {
      const row = document.createElement('div');
      row.className = 'home-row' + (s.current ? ' current' : '');
      const title = document.createElement('div');
      title.className = 't';
      title.textContent = s.title || s.sessionId;
      title.title = s.title || s.sessionId;
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = relTime(s.updatedAt);
      row.appendChild(title);
      row.appendChild(when);
      row.addEventListener('click', function () {
        post({ type: 'loadSession', sessionId: s.sessionId });
      });
      homeList.appendChild(row);
    });
    if (homeMore) {
      if (all.length > 3) {
        homeMore.textContent = '查看全部（' + all.length + ' 个）';
        homeMore.classList.remove('hidden');
      } else {
        homeMore.classList.add('hidden');
      }
    }
  }

  /** 审批模式那一格：现在是个按钮（下拉自家渲染），只负责显示当前值 */
  function syncModeSelect() {
    if (!modeSelect) {
      return;
    }
    const modes = meta.modes || [];
    const cur = meta.modeId || '';
    const found = modes.filter(function (m) {
      return m.id === cur;
    })[0];
    modeSelect.textContent = found ? found.name + ' ▾' : '';
    modeSelect.classList.toggle('hidden', modes.length === 0);
    // 审批模式不是"警告"：非默认只是需要留意，用强调色，不要警告橙
    modeSelect.classList.toggle('active', !!cur && cur !== 'default');
    modeSelect.title = found
      ? '审批模式：' + found.name + (found.description ? '（' + found.description + '）' : '') + '，点击切换'
      : '审批模式';
  }

  /** 模型那一格：同上，只显示当前模型 */
  function syncModelChip() {
    if (!modelSelect) {
      return;
    }
    const current = meta.modelId || '';
    const found = models.filter(function (m) {
      return m.modelId === current;
    })[0];
    const label = found ? shortModelName(found.name || found.modelId) : '';
    modelSelect.textContent = label ? label + ' ▾' : '';
    modelSelect.classList.toggle('hidden', models.length === 0);
    modelSelect.title = found
      ? '模型：' + (found.name || found.modelId) + '，点击切换'
      : '切换模型';
  }

  /** 审批模式下拉：带 Hermes 给的说明，当前项打勾 */
  function showModeMenu() {
    const modes = meta.modes || [];
    if (!modes.length) {
      return;
    }
    showMenuList(
      '审批模式',
      modes.map(function (m) {
        return {
          label: m.name,
          sub: m.description || '',
          checked: m.id === (meta.modeId || ''),
          run: function () { post({ type: 'setMode', modeId: m.id }); },
        };
      })
    );
  }

  /**
   * 模型下拉：103 个模型，所以必须有过滤框。
   * 之前用原生 <select>，弹出层是浏览器画的（白边、不能搜、一长条），改不动。
   */
  function showModelMenu() {
    if (!models.length) {
      return;
    }
    popover.innerHTML = '';
    popover.classList.add('menu');

    const head = document.createElement('div');
    head.className = 'menu-section';
    head.textContent = '切换模型（共 ' + models.length + ' 个）';
    popover.appendChild(head);

    const box = document.createElement('input');
    box.className = 'menu-search';
    box.type = 'text';
    box.placeholder = '输入关键字筛选…';
    popover.appendChild(box);

    const list = document.createElement('div');
    list.className = 'menu-list';
    popover.appendChild(list);

    const current = meta.modelId || '';
    const draw = function () {
      const q = box.value.trim().toLowerCase();
      const pool = models.filter(function (m) {
        if (!q) {
          return true;
        }
        const text = String(m.name || m.modelId).toLowerCase();
        return text.indexOf(q) >= 0 || String(m.modelId).toLowerCase().indexOf(q) >= 0;
      });
      // 当前模型置顶：找自己那一条不用滚
      pool.sort(function (a, b) {
        if (a.modelId === current) { return -1; }
        if (b.modelId === current) { return 1; }
        return 0;
      });
      list.innerHTML = '';
      if (!pool.length) {
        const none = document.createElement('div');
        none.className = 'menu-item';
        none.textContent = '没有匹配的模型';
        list.appendChild(none);
        return;
      }
      pool.slice(0, 60).forEach(function (m) {
        list.appendChild(
          menuRow({
            label: shortModelName(m.name || m.modelId),
            sub: m.modelId === current ? '当前' : '',
            checked: m.modelId === current,
            run: function () { post({ type: 'setModel', modelId: m.modelId }); },
          })
        );
      });
      if (pool.length > 60) {
        const more = document.createElement('div');
        more.className = 'menu-more';
        more.textContent = '还有 ' + (pool.length - 60) + ' 个…（继续输入缩小范围）';
        list.appendChild(more);
      }
    };
    draw();
    box.addEventListener('input', draw);
    popover.classList.remove('hidden');
    setTimeout(function () {
      box.focus();
    }, 0);
  }

  const KIND_LABEL = {
    read: '读取',
    edit: '修改',
    execute: '执行',
    search: '搜索',
    fetch: '获取',
    think: '思考',
    other: '工具',
  };

  function kindLabel(kind) {
    return KIND_LABEL[kind] || KIND_LABEL.other;
  }

  // Hermes 给的选项名是英文（Allow edit / Deny）；界面是中文，这里做展示层映射，
  // 原始名字放进 tooltip，避免"按钮像禁用"之类的误读。
  const PERMISSION_LABEL = {
    allow_once: '允许一次',
    allow_always: '总是允许',
    reject_once: '拒绝',
    reject_always: '总是拒绝',
  };

  function permissionLabel(option) {
    return PERMISSION_LABEL[option.kind] || option.name || option.optionId;
  }

  // Hermes 的审批卡标题是英文模板（"Approve edit: <path>"）；界面是中文，这里做展示层本地化
  function localizeTitle(title) {
    return String(title || '')
      .replace(/^Approve edit:\s*/i, '确认修改：')
      .replace(/^Approve\s+/i, '确认：');
  }

  function statusLabel(status) {
    switch (status) {
      case 'running':
        return '进行中…';
      case 'completed':
        return '完成';
      case 'failed':
        return '失败';
      case 'pending':
        return '待确认';
      default:
        return '';
    }
  }

  // ───────────────────────── 条目渲染 ─────────────────────────

  function renderUser(data) {
    const wrap = document.createElement('div');
    wrap.className = 'item user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    return {
      el: wrap,
      sync(d) {
        bubble.innerHTML = d.html || '';
      },
    };
  }

  function renderMarkdownItem(data) {
    const isThought = data.kind === 'thought';
    const wrap = document.createElement('div');
    wrap.className = 'item ' + data.kind;
    let head = null;
    let body = null;

    if (isThought) {
      head = document.createElement('div');
      head.className = 'thought-head';
      body = document.createElement('div');
      body.className = 'thought-body md';
      wrap.appendChild(head);
      wrap.appendChild(body);
      head.addEventListener('click', () => {
        const current = items.get(data.id);
        if (!current) {
          return;
        }
        // 判据必须与 sync() 里的一致（undefined 也算折叠），否则会出现
        // "看着是折的，点一下却还是折的"这种鬼打墙
        const wasCollapsed = current.data.collapsed !== false;
        current.data.collapsed = !wasCollapsed;
        current.sync(current.data);
      });
    } else {
      body = document.createElement('div');
      body.className = 'md';
      wrap.appendChild(body);
    }

    let copyBtn = null;
    if (data.kind === 'assistant') {
      // 角色行：给长对话一个视觉锚点，也顺手给「复制」一个正经的家
      const head = document.createElement('div');
      head.className = 'msg-head';
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = 'HERMES';
      head.appendChild(role);
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      head.appendChild(spacer);

      copyBtn = document.createElement('button');
      copyBtn.className = 'text-btn';
      copyBtn.title = '复制这条回复';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const current = items.get(data.id);
        copyText(current ? current.data.text || '' : '');
      });
      head.appendChild(copyBtn);
      wrap.insertBefore(head, body);
    }

    return {
      el: wrap,
      sync(d) {
        body.innerHTML = d.html || '';
        if (head) {
          // 「默认折叠」在这里兜底：只看一个上游布尔值等于把要求外包给
          // 一条不可控的数据通路 —— 字段缺失/undefined 一律按折叠处理。
          const collapsed = d.collapsed !== false;
          const chars = d.chars || 0;
          let text = collapsed ? '▸ ' : '▾ ';
          text += d.thinking ? '思考中…' : d.title || '思考过程';
          // 折叠态必须能看出里面有多少东西，否则就是个没信息量的胶囊
          if (collapsed && chars) {
            text += ' · ' + chars + ' 字';
          }
          head.textContent = text;
          head.title = collapsed ? '点击展开思考过程' : '点击收起';
          body.style.display = collapsed ? 'none' : '';
        }
        if (copyBtn) {
          copyBtn.style.display = d.text ? '' : 'none';
        }
      },
    };
  }

  function renderToolCard(data) {
    const isApproval = data.kind === 'approval';
    const wrap = document.createElement('div');
    wrap.className = 'item ' + (isApproval ? 'approval' : 'tool');

    const card = document.createElement('div');
    card.className = 'tool-card';

    const head = document.createElement('div');
    head.className = 'tool-head';
    const kindEl = document.createElement('span');
    kindEl.className = 'tool-kind';
    const titleEl = document.createElement('span');
    titleEl.className = 'tool-title';
    const statusEl = document.createElement('span');
    statusEl.className = 'tool-status';
    head.appendChild(kindEl);
    head.appendChild(titleEl);
    head.appendChild(statusEl);

    const body = document.createElement('div');
    body.className = 'tool-body';

    const actions = document.createElement('div');
    actions.className = 'approval-actions';

    const resolvedNote = document.createElement('div');
    resolvedNote.className = 'resolved-note hidden';

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(actions);
    card.appendChild(resolvedNote);
    wrap.appendChild(card);

    head.addEventListener('click', () => {
      const current = items.get(data.id);
      if (!current) {
        return;
      }
      current.data.collapsed = !current.data.collapsed;
      current.sync(current.data);
    });

    return {
      el: wrap,
      sync(d) {
        kindEl.textContent = kindLabel(d.toolKind);
        kindEl.className = 'tool-kind ' + (d.toolKind || 'other');
        titleEl.textContent = localizeTitle(d.title) || d.subtitle || d.id;
        titleEl.title = (d.locations || []).join('\n') || d.title || '';
        statusEl.textContent = statusLabel(d.status);
        statusEl.className = 'tool-status ' + (d.status || '');

        const hasBody = !!d.bodyHtml;
        body.style.display = hasBody && !d.collapsed ? '' : 'none';
        if (hasBody) {
          body.innerHTML = d.bodyHtml;
          for (const chip of body.querySelectorAll('[data-open-path]')) {
            chip.addEventListener('click', (ev) => {
              ev.preventDefault();
              post({ type: 'openFile', path: chip.getAttribute('data-open-path') });
            });
          }
          for (const link of body.querySelectorAll('a[href]')) {
            link.addEventListener('click', (ev) => {
              ev.preventDefault();
              post({ type: 'openExternal', url: link.getAttribute('href') });
            });
          }
        }

        // 审批按钮只在待确认时出现
        const options = d.options || [];
        const showActions = isApproval && d.status === 'pending' && options.length > 0;
        actions.innerHTML = '';
        actions.style.display = showActions ? '' : 'none';
        if (showActions) {
          for (const option of options) {
            const btn = document.createElement('button');
            const isReject = String(option.kind || '').startsWith('reject');
            btn.textContent = permissionLabel(option);
            btn.title = option.name || option.optionId;
            btn.className = isReject ? 'danger' : 'primary';
            btn.addEventListener('click', () => {
              for (const other of actions.querySelectorAll('button')) {
                other.disabled = true;
              }
              btn.classList.add('chosen');
              post({ type: 'permission', seq: d.requestId, optionId: option.optionId });
            });
            actions.appendChild(btn);
          }
        }

        if (isApproval && d.status !== 'pending') {
          resolvedNote.classList.remove('hidden');
          const chosen = d.resolvedOptionId
            ? PERMISSION_LABEL[d.resolvedOptionId] || d.resolvedOptionId
            : '';
          resolvedNote.textContent =
            d.status === 'failed'
              ? `已拒绝${chosen ? `（${chosen}）` : ''}`
              : `已批准${chosen ? `（${chosen}）` : ''}`;
        } else {
          resolvedNote.classList.add('hidden');
        }
      },
    };
  }

  function createItem(data) {
    let renderer;
    if (data.kind === 'user') {
      renderer = renderUser(data);
    } else if (data.kind === 'assistant' || data.kind === 'thought') {
      renderer = renderMarkdownItem(data);
    } else if (data.kind === 'tool' || data.kind === 'approval') {
      renderer = renderToolCard(data);
    } else {
      renderer = renderMarkdownItem({ ...data, kind: data.kind === 'error' ? 'error' : 'notice' });
    }
    renderer.sync(data);
    // 让行为测试能精确定位到"这一个"条目 —— 用类名取到的是 DOM 里第一个同类，
    // 断言会落在别人的元素上，给出假绿。
    renderer.el.setAttribute('data-item-id', data.id);
    transcriptEl.appendChild(renderer.el);
    items.set(data.id, { data, sync: renderer.sync, el: renderer.el });
    updateEmptyHint();
  }

  function applyOp(op) {
    switch (op.op) {
      case 'reset': {
        transcriptEl.innerHTML = '';
        items.clear();
        for (const item of op.items || []) {
          createItem(Object.assign({}, item));
        }
        if (op.meta) {
          applyMeta(op.meta);
        }
        maybeScroll(true);
        break;
      }
      case 'add':
        createItem(Object.assign({}, op.item));
        maybeScroll();
        break;
      case 'text': {
        const entry = items.get(op.id);
        if (entry) {
          entry.data.html = op.html;
          if (typeof op.chars === 'number') {
            entry.data.chars = op.chars;
          }
          entry.sync(entry.data);
          maybeScroll();
        }
        break;
      }
      case 'update': {
        const entry = items.get(op.id);
        if (entry) {
          Object.assign(entry.data, op.patch);
          entry.sync(entry.data);
          maybeScroll();
        }
        break;
      }
      case 'meta':
        applyMeta(op.meta);
        break;
      default:
        break;
    }
  }

  function applyMeta(next) {
    meta = next;
    statusDot.className = 'dot ' + (meta.status || 'offline');
    // 待确认数量走独立角标，不拼进状态文字（拼进去会在文案里重复、还会挤掉状态本身）
    statusText.textContent = meta.statusText || '';
    syncModeSelect();
    statusText.title = meta.sessionId ? `会话 ${meta.sessionId}` : '';

    const pending = meta.pendingApprovals || 0;
    if (pendingBadge) {
      pendingBadge.textContent = String(pending);
      pendingBadge.classList.toggle('hidden', pending === 0);
    }

    if (Array.isArray(meta.models)) {
      models = meta.models;
    }
    syncModelChip();

    if (meta.usage && meta.usage.size) {
      usageWrap.classList.remove('hidden');
      const pct = Math.min(100, Math.round((meta.usage.used / meta.usage.size) * 100));
      usageFill.style.width = pct + '%';
      if (pct > 85) {
        usageFill.style.background = 'var(--hermes-error)';
      } else if (pct > 60) {
        usageFill.style.background = 'var(--vscode-charts-orange, #d29922)';
      } else {
        usageFill.style.background = 'var(--hermes-accent)';
      }
      // 窄面板里 "上下文 3%（9130/1000000）" 会被截断，所以只留百分比，明细进 tooltip
      usageText.textContent = `上下文 ${pct}%`;
      usageText.title = `${meta.usage.used} / ${meta.usage.size} tokens`;
    } else {
      usageWrap.classList.add('hidden');
    }

    if (meta.title) {
      document.title = meta.title;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => post({ type: 'log', text: '已复制到剪贴板' }),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      /* 复制失败就算了，不值得打断用户 */
    }
    document.body.removeChild(ta);
  }

  // ───────────────────────── 输入框 ─────────────────────────

  function autofit() {
    input.style.height = 'auto';
    const maxHeight = Math.round(window.innerHeight * 0.65);
    const next = Math.min(input.scrollHeight, maxHeight);
    input.style.height = next + 'px';
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function sendPrompt() {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    post({ type: 'prompt', text });
    input.value = '';
    attachment.classList.add('hidden');
    attachment.textContent = '';
    autofit();
    hidePopover();
  }

  input.addEventListener('input', () => {
    autofit();
    maybeShowCommandMenu();
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      sendPrompt();
    } else if (ev.key === 'Escape') {
      hidePopover();
    }
  });

  window.addEventListener('resize', autofit);

  btnSend.addEventListener('click', sendPrompt);

  btnStop.addEventListener('click', () => {
    post({ type: 'cancel' });
  });

  btnNew.addEventListener('click', () => {
    post({ type: 'newSession' });
  });

  btnRestart.addEventListener('click', () => {
    post({ type: 'restart' });
  });

  btnContext.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // 「+」= Codex 那个下拉菜单（添加 / 插件），不再是"只插当前文件"
    showMenu();
  });

  modelSelect.addEventListener('click', (ev) => {
    ev.stopPropagation();
    showModelMenu();
  });

  btnHistory.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // 先记下"这次拉列表是为了开弹层"，等列表回来再弹（拉取是异步的）
    wantPopover = true;
    post({ type: 'listSessions' });
    // 扩展侧万一不回（连接挂了），别让标志位永久卡住
    setTimeout(() => {
      wantPopover = false;
    }, 5000);
  });

  // 点角标 → 直接跳到待确认的那张卡
  pendingBadge.addEventListener('click', () => {
    const card = transcriptEl.querySelector('.item.approval');
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });

  transcriptEl.addEventListener('scroll', () => {
    stickToBottom = nearBottom();
  });

  // ───────────────────────── 浮层 ─────────────────────────

  function showPopover(title, entries) {
    // 摘掉「+」菜单专用的类，否则会话列表也会被撑到菜单的宽度
    popover.classList.remove('menu');
    popover.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'popover-title';
    head.textContent = title;
    popover.appendChild(head);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'popover-item';
      empty.textContent = '（空）';
      popover.appendChild(empty);
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'popover-item' + (entry.current ? ' current' : '');
      const main = document.createElement('div');
      main.textContent = entry.label;
      if (entry.mono) {
        main.className = 'cmd-name';
      }
      row.appendChild(main);
      if (entry.sub) {
        const sub = document.createElement('div');
        sub.className = 'muted';
        sub.style.fontSize = '.82em';
        sub.textContent = entry.sub;
        row.appendChild(sub);
      }
      row.addEventListener('click', () => {
        hidePopover();
        entry.action();
      });
      popover.appendChild(row);
    }
    popover.classList.remove('hidden');
  }

  /** 路径归一：Windows 上盘符大小写、斜杠方向都可能不一致 */
  function normalizePath(p) {
    return String(p || '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase();
  }

  function shortWorkspace(p) {
    const cleaned = String(p || '').trim();
    // "." / 空 都表示这条会话没关联工作区（线上就是这么报的）
    if (!cleaned || cleaned === '.') {
      return '';
    }
    const parts = cleaned.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  /** 会话列表：当前工作区 / 其它（桌面版、CLI 里聊的）两组 */
  function showSessionSections(workspaceCwd, here, others) {
    popover.innerHTML = '';
    const MAX = 20;

    const addGroup = (label, items, showWorkspace) => {
      const head = document.createElement('div');
      head.className = 'popover-title';
      head.textContent = `${label}（${items.length}）`;
      popover.appendChild(head);

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'popover-item';
        empty.textContent = '（空）';
        popover.appendChild(empty);
        return;
      }

      for (const s of items.slice(0, MAX)) {
        const row = document.createElement('div');
        row.className = 'popover-item' + (s.current ? ' current' : '');
        const main = document.createElement('div');
        main.textContent = s.title || s.sessionId;
        row.appendChild(main);

        const bits = [(s.updatedAt || '').replace('T', ' ').slice(0, 19)];
        if (showWorkspace) {
          bits.push(shortWorkspace(s.cwd) || '无工作区');
        }
        if (s.current) {
          bits.push('当前');
        }
        const sub = document.createElement('div');
        sub.className = 'muted';
        sub.style.fontSize = '.82em';
        sub.textContent = bits.filter(Boolean).join(' · ');
        row.appendChild(sub);

        row.addEventListener('click', () => {
          hidePopover();
          post({ type: 'loadSession', sessionId: s.sessionId });
        });
        popover.appendChild(row);
      }

      if (items.length > MAX) {
        const more = document.createElement('div');
        more.className = 'popover-item muted';
        more.textContent = `还有 ${items.length - MAX} 条…`;
        popover.appendChild(more);
      }
    };

    const wsName = shortWorkspace(workspaceCwd);
    addGroup(wsName ? `当前工作区 · ${wsName}` : '当前工作区', here, false);
    addGroup('其它会话（桌面版 / CLI）', others, true);
    popover.classList.remove('hidden');
  }

  // ── 「+」菜单：对齐 Codex 的 + 下拉（添加 / 插件 两段） ─────────────
  /**
   * Hermes 的命令表是 **ACP 推上来的**（`meta.commands`），这里一条都不硬编码 ——
   * 换 Hermes 版本、换配置，菜单跟着变。
   */
  function showCommandList() {
    const commands = meta.commands || [];
    if (!commands.length) {
      showPopover('斜杠命令', [
        { label: '还没拿到命令表', sub: '连上 Hermes 之后就有', action: function () {} },
      ]);
      return;
    }
    showPopover(
      '斜杠命令 · 来自 Hermes（' + commands.length + '）',
      commands.map(function (c) {
        return {
          label: '/' + c.name,
          sub: c.description || '',
          mono: true,
          action: function () {
            input.value = '/' + c.name + ' ';
            input.focus();
            autofit();
          },
        };
      })
    );
  }

  /** 直接把某条 Hermes 命令发出去（/tools、/context 这类只读命令） */
  function sendCommand(name) {
    input.value = '/' + name;
    autofit();
    sendPrompt();
  }

  function menuEntries() {
    const entries = [
      { section: '添加' },
      {
        icon: '📎',
        label: '文件和文件夹',
        sub: '把文件或目录的路径加进输入框',
        run: function () { post({ type: 'pickFiles' }); },
      },
      {
        icon: '📌',
        label: '当前文件 / 选中代码',
        sub: '插入编辑器里的上下文',
        run: function () { post({ type: 'requestContext' }); },
      },
      { section: 'Hermes' },
      {
        icon: '⌨️',
        label: '斜杠命令',
        sub: 'Hermes 推上来的 ' + (meta.commands || []).length + ' 条命令',
        run: showCommandList,
      },
      {
        icon: '🧩',
        label: '技能',
        sub: '从真实安装的技能里挑（可搜索）',
        run: function () { post({ type: 'pickSkill' }); },
      },
      {
        icon: '🧰',
        label: '工具列表',
        sub: '发送 /tools，列出当前可用工具',
        run: function () { sendCommand('tools'); },
      },
      {
        icon: '📊',
        label: '上下文用量',
        sub: '发送 /context，看对话占用',
        run: function () { sendCommand('context'); },
      },
      { section: '面板（不是 Hermes 的功能，本地面板的便利项）' },
      {
        icon: '🎯',
        label: '目标',
        sub: scratch.goal ? '当前：' + scratch.goal : '每轮都带上（提示词层，不是 /goal）',
        run: function () { post({ type: 'setGoal' }); },
      },
      {
        icon: '💡',
        label: '计划模式',
        sub: '只出计划、不改文件（提示词层）',
        checked: !!scratch.planMode,
        run: function () { post({ type: 'togglePlanMode' }); },
      },
      {
        icon: '✏️',
        label: '绘图',
        sub: '手绘草图，存成 png 后插入路径',
        run: function () { openSketch(); },
      },
    ];
    return entries;
  }

  /** 一行菜单项（「+」菜单、模式下拉、模型下拉共用同一套渲染） */
  function menuRow(it) {
    const row = document.createElement('div');
    row.className = 'menu-item' + (it.checked ? ' checked' : '');
    if (it.icon) {
      const icon = document.createElement('span');
      icon.className = 'menu-icon';
      icon.textContent = it.icon;
      row.appendChild(icon);
    }
    const box = document.createElement('span');
    box.className = 'menu-text';
    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = it.label;
    box.appendChild(label);
    if (it.sub) {
      const sub = document.createElement('span');
      sub.className = 'menu-sub';
      sub.textContent = it.sub;
      box.appendChild(sub);
    }
    row.appendChild(box);
    if (it.checked) {
      const check = document.createElement('span');
      check.className = 'menu-check';
      check.textContent = '✓';
      row.appendChild(check);
    }
    row.addEventListener('click', function () {
      hidePopover();
      if (it.run) {
        it.run();
      }
    });
    return row;
  }

  /** 通用下拉：一个标题 + 若干行 */
  function showMenuList(title, entries) {
    popover.innerHTML = '';
    popover.classList.add('menu');
    const head = document.createElement('div');
    head.className = 'menu-section';
    head.textContent = title;
    popover.appendChild(head);
    entries.forEach(function (it) {
      popover.appendChild(menuRow(it));
    });
    popover.classList.remove('hidden');
  }

  function showMenu() {
    popover.innerHTML = '';
    // menu 这个类只给这些下拉用，弹到别的内容时要摘掉（否则会话列表会被撑宽）
    popover.classList.add('menu');
    menuEntries().forEach(function (it) {
      if (it.section) {
        const head = document.createElement('div');
        head.className = 'menu-section';
        head.textContent = it.section;
        popover.appendChild(head);
        return;
      }
      popover.appendChild(menuRow(it));
    });
    popover.classList.remove('hidden');
  }

  /** 输入框上方的状态条：目标 / 计划模式 正在生效时要看得见，也能点掉 */
  function syncScratchChips() {
    if (!chipsEl) {
      return;
    }
    chipsEl.innerHTML = '';
    const add = function (text, title, onClick) {
      const chip = document.createElement('button');
      chip.className = 'chip state';
      chip.textContent = text;
      chip.title = title;
      chip.addEventListener('click', onClick);
      chipsEl.appendChild(chip);
    };
    if (scratch.goal) {
      add('🎯 ' + scratch.goal, '本会话目标（点击修改/清除）', function () {
        post({ type: 'setGoal' });
      });
    }
    if (scratch.planMode) {
      add('💡 计划模式', '点击关闭计划模式', function () {
        post({ type: 'togglePlanMode' });
      });
    }
    chipsEl.classList.toggle('hidden', !chipsEl.childNodes.length);
  }

  // ── 绘图：手绘画布 → png → 路径插进输入框 ───────────────────────────
  let sketchCtx = null;

  function clearSketch() {
    if (!sketchCtx || !sketchCanvas) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    sketchCtx.fillStyle = '#ffffff'; // 白底：给模型看的图别用透明底
    sketchCtx.fillRect(0, 0, sketchCanvas.width / dpr, sketchCanvas.height / dpr);
    sketchCtx.strokeStyle = '#111111';
    sketchCtx.lineWidth = 2.5;
    sketchCtx.lineCap = 'round';
  }

  function openSketch() {
    if (!sketchEl || !sketchCanvas) {
      return;
    }
    sketchEl.classList.remove('hidden');
    const dpr = window.devicePixelRatio || 1;
    const cssW = sketchCanvas.clientWidth || 420;
    const cssH = Math.round((cssW * 5) / 8);
    sketchCanvas.width = Math.round(cssW * dpr);
    sketchCanvas.height = Math.round(cssH * dpr);
    sketchCtx = sketchCanvas.getContext('2d');
    sketchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clearSketch();

    let drawing = false;
    let last = null;
    const pos = function (ev) {
      const r = sketchCanvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    sketchCanvas.onpointerdown = function (ev) {
      drawing = true;
      last = pos(ev);
      if (sketchCanvas.setPointerCapture) {
        sketchCanvas.setPointerCapture(ev.pointerId);
      }
      ev.preventDefault();
    };
    sketchCanvas.onpointermove = function (ev) {
      if (!drawing || !last) {
        return;
      }
      const p = pos(ev);
      sketchCtx.beginPath();
      sketchCtx.moveTo(last.x, last.y);
      sketchCtx.lineTo(p.x, p.y);
      sketchCtx.stroke();
      last = p;
    };
    sketchCanvas.onpointerup = function () { drawing = false; };
    sketchCanvas.onpointercancel = function () { drawing = false; };
  }

  function hidePopover() {
    popover.classList.add('hidden');
    popover.classList.remove('menu');
  }

  document.addEventListener('click', (ev) => {
    if (!popover.classList.contains('hidden') && !popover.contains(ev.target)) {
      hidePopover();
    }
  });

  function maybeShowCommandMenu() {
    const value = input.value;
    if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) {
      if (!value.startsWith('/')) {
        hidePopover();
      }
      return;
    }
    const prefix = value.slice(1).toLowerCase();
    const commands = (meta.commands || []).filter((c) => (c.name || '').toLowerCase().startsWith(prefix));
    if (!commands.length) {
      hidePopover();
      return;
    }
    showPopover(
      '斜杠命令',
      commands.slice(0, 12).map((c) => ({
        label: '/' + c.name,
        sub: c.description || '',
        mono: true,
        action: () => {
          input.value = '/' + c.name + ' ';
          input.focus();
          autofit();
        },
      }))
    );
  }

  // ───────────────────────── 扩展 → webview ─────────────────────────

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg.op) {
      applyOp(msg);
      return;
    }
    switch (msg.type) {
      case 'busy':
        busy = !!msg.running;
        btnStop.classList.toggle('hidden', !busy);
        btnSend.disabled = false;
        break;
      case 'insertText': {
        const prefix = input.value && !input.value.endsWith('\n') ? '\n' : '';
        input.value = input.value + prefix + msg.text;
        autofit();
        const preview = String(msg.text).split('\n').slice(0, 3).join('\n');
        attachment.textContent = '已附加上下文：\n' + preview + (String(msg.text).split('\n').length > 3 ? '\n…' : '');
        attachment.classList.remove('hidden');
        input.focus();
        break;
      }
      case 'sessions': {
        // 分两组：当前工作区的、以及其它（桌面版 / CLI 里聊的，多半没有工作区）。
        // 后者才是"和桌面版同步"真正要看的东西。
        const ws = normalizePath(msg.workspaceCwd || '');
        const here = [];
        const others = [];
        for (const s of msg.sessions || []) {
          const p = normalizePath(s.cwd || '');
          if (ws && p && p !== '.' && p === ws) {
            here.push(s);
          } else {
            others.push(s);
          }
        }
        lastSessions = { workspaceCwd: msg.workspaceCwd || '', here: here, others: others };
        renderHome();
        // 点过时钟图标就把弹层打开。这里以前只刷首页列表 —— 而有对话时首页是
        // 隐藏的，于是表现成"点了没反应"。
        if (wantPopover) {
          wantPopover = false;
          showSessionSections(lastSessions.workspaceCwd, here, others);
        }
        break;
      }
      case 'insertHint': {
        // 技能名这类"提示词小片段"：只写进输入框，不占用上下文附件那一行
        const need = String(msg.text || '');
        if (need && input.value.indexOf(need) < 0) {
          const prefix = input.value && !input.value.endsWith('\n') ? '\n' : '';
          input.value = input.value + prefix + need;
        }
        autofit();
        input.focus();
        break;
      }
      case 'scratch':
        scratch = { goal: msg.goal || '', planMode: !!msg.planMode };
        syncScratchChips();
        break;
      case 'notice':
        post({ type: 'log', text: msg.text });
        break;
      case 'state':
        if (msg.state && msg.state.sessionId) {
          vscode.setState({ sessionId: msg.state.sessionId });
        }
        break;
      default:
        break;
    }
  });

  // 首页「查看全部」→ 打开完整会话列表弹层
  if (homeMore) {
    homeMore.addEventListener('click', function () {
      showSessionSections(lastSessions.workspaceCwd, lastSessions.here, lastSessions.others);
    });
  }
  // 审批模式：现在是自家下拉（原生 <select> 的弹出层样式改不动、也没法带说明）
  if (modeSelect) {
    modeSelect.addEventListener('click', function (ev) {
      ev.stopPropagation();
      showModeMenu();
    });
  }

  // 绘图浮层的按钮
  if (btnSketchClear) {
    btnSketchClear.addEventListener('click', clearSketch);
  }
  if (btnSketchCancel) {
    btnSketchCancel.addEventListener('click', function () {
      sketchEl.classList.add('hidden');
    });
  }
  if (btnSketchInsert) {
    btnSketchInsert.addEventListener('click', function () {
      if (sketchCanvas) {
        post({ type: 'sketchImage', dataUrl: sketchCanvas.toDataURL('image/png') });
      }
      sketchEl.classList.add('hidden');
    });
  }

  autofit();
  updateEmptyHint();
  renderHome();
  syncScratchChips();
  post({ type: 'ready' });
})();
