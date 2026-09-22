/**
 * webview 交互行为测试（headless Edge + --dump-dom）。
 *
 * 为什么要有它：改 UI 时最容易犯的错不是样式丑，而是**把某条交互链路接断**。
 * 实例：把「历史」按钮的处理器从"弹列表"改成"刷首页列表"后，有对话时点它
 * 毫无反应 —— 静态预览和截图完全看不出来，因为 DOM 都是对的，只是没人点。
 * 所以这里真的派发 click、真的读回传（stub 记在 window.__sent）的消息。
 *
 * 依赖 test/make-preview.js 先生成预览页（那里 stub 了 acquireVsCodeApi）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.argv[2] || 'D:/APP/hermes/cache/scratch/hermes-ui/preview.html';
const OUT = process.argv[3] || 'D:/APP/hermes/cache/scratch/hermes-ui/behavior.html';
const EDGE =
  process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const PROBE = `<script>
(function () {
  var out = { steps: [] };
  function click(sel) {
    var el = document.querySelector(sel);
    if (!el) { out.steps.push('MISSING ' + sel); return false; }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    out.steps.push('click ' + sel);
    return true;
  }
  function popoverVisible() {
    var p = document.querySelector('#popover');
    return !!p && !p.classList.contains('hidden') && p.getBoundingClientRect().height > 0;
  }
  function sentTypes() {
    return (window.__sent || []).map(function (m) { return m && m.type; }).filter(Boolean);
  }
  function sentLoads() {
    return (window.__sent || [])
      .filter(function (m) { return m && m.type === 'loadSession'; })
      .map(function (m) { return m.sessionId; });
  }
  var DAY = 86400000;
  var FAKE = {
    workspaceCwd: 'D:\\\\Data\\\\Codes\\\\ESP32\\\\ESPIDF\\\\LCD',
    sessions: [
      { sessionId: 'here-1', title: '本工作区的会话', updatedAt: new Date().toISOString(), cwd: 'd:\\\\Data\\\\Codes\\\\ESP32\\\\ESPIDF\\\\LCD', current: false },
      { sessionId: 'desk-1', title: '桌面版聊的', updatedAt: new Date(Date.now() - DAY).toISOString(), cwd: '.', current: false },
      { sessionId: 'desk-2', title: 'CLI 聊的', updatedAt: new Date(Date.now() - 2 * DAY).toISOString(), cwd: '.', current: false },
      { sessionId: 'desk-3', title: '更早的', updatedAt: new Date(Date.now() - 3 * DAY).toISOString(), cwd: '.', current: false }
    ]
  };

  setTimeout(function () {
    // ① 时钟图标：应该让扩展去拉列表
    click('#btn-history');
    out.sentAfterHistory = sentTypes();

    // ② 列表回来：应该把弹层弹出来（这就是被接断的那条链路）
    window.postMessage(
      { type: 'sessions', workspaceCwd: FAKE.workspaceCwd, sessions: FAKE.sessions },
      '*'
    );
    setTimeout(function () {
      try {
      out.popoverVisible = popoverVisible();
      out.popoverItems = document.querySelectorAll('#popover .popover-item').length;
      out.popoverGroupTitles = Array.prototype.map.call(
        document.querySelectorAll('#popover .popover-title'),
        function (e) { return e.textContent; }
      );

      // ③ 点弹层里第一条：应该回传 loadSession 并关掉弹层
      var first = document.querySelector('#popover .popover-item');
      if (first) {
        first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      out.loadsAfterPopoverClick = sentLoads();
      out.popoverClosedAfterClick = !popoverVisible();

      // ④ 首页行的点击（首页在有对话时是隐藏的，但 DOM 在，能验链路）
      click('.home-row');
      out.loadsAfterHomeRowClick = sentLoads();

      // ⑤ 「查看全部（N 个）」的文字
      var more = document.querySelector('#home-more');
      out.homeMoreText = more ? more.textContent : null;
      out.homeMoreVisible = !!more && !more.classList.contains('hidden');

      // ⑥ 思考块：默认折叠。关键在于**连 collapsed 字段都不给**也得是折的 ——
      // 只信上游一个布尔值，等于把这条要求外包给不可控的数据通路。
      // 这里同步派发 message（postMessage 是异步的，紧接着读 DOM 会读到旧状态）。
      var feed = function (m) {
        window.dispatchEvent(new MessageEvent('message', { data: m }));
      };
      feed({ op: 'add', item: { id: 'th1', kind: 'thought', title: '思考过程', thinking: true } });
      feed({ op: 'text', id: 'th1', html: '<p>先看看这个</p>', chars: 42 });
      var th = document.querySelector('[data-item-id="th1"]');
      var thHead = th ? th.querySelector('.thought-head') : null;
      var thBody = th ? th.querySelector('.thought-body') : null;
      out.thoughtExists = !!th;
      out.thoughtHeadRunning = thHead ? thHead.textContent : null;
      out.thoughtHiddenWithoutField = thBody ? getComputedStyle(thBody).display === 'none' : null;

      if (thHead) { thHead.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      out.thoughtExpanded = thBody ? getComputedStyle(thBody).display !== 'none' : null;

      if (thHead) { thHead.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      out.thoughtCollapsedAgain = thBody ? getComputedStyle(thBody).display === 'none' : null;

      // 回合结束时扩展侧发来的 patch 形态
      feed({ op: 'update', id: 'th1', patch: { collapsed: true, thinking: false } });
      out.thoughtHeadSettled = thHead ? thHead.textContent : null;

      // ⑦ 皮肤对抗：旧 CSS 里按 ID 写的规则会压过新加的类（模型下拉就中过招：
      //    改成 .chip 后那个旧胶囊框还在，因为 #model-select 是 ID）。
      var cs = function (el) { return el ? getComputedStyle(el) : null; };
      var ms = cs(document.querySelector('#model-select'));
      var mods = cs(document.querySelector('#mode-select'));
      var send = cs(document.querySelector('#btn-send'));
      out.modelBorderW = ms ? ms.borderTopWidth : null;
      out.modelBg = ms ? ms.backgroundColor : null;
      out.modeBorderW = mods ? mods.borderTopWidth : null;
      out.sendBg = send ? send.backgroundColor : null;

      // ⑧ 「+」菜单：Codex 那个下拉（添加 / 插件 两段）
      var pickMenu = function (name) {
        var rows = [].slice.call(document.querySelectorAll('#popover .menu-item'));
        for (var i = 0; i < rows.length; i++) {
          var l = rows[i].querySelector('.menu-label');
          if (l && l.textContent === name) {
            rows[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
          }
        }
        return false;
      };
      click('#btn-context');
      var pop = document.querySelector('#popover');
      out.menuOpen = !pop.classList.contains('hidden');
      out.menuIsMenu = pop.classList.contains('menu');
      out.menuSections = [].slice.call(document.querySelectorAll('#popover .menu-section')).map(function (e) { return e.textContent; });
      out.menuItems = document.querySelectorAll('#popover .menu-item').length;
      out.menuLabels = [].slice.call(document.querySelectorAll('#popover .menu-label')).map(function (e) { return e.textContent; });

      out.clickedPlan = pickMenu('计划模式');
      out.sentAfterPlan = sentTypes();

      click('#btn-context');
      out.clickedCmd = pickMenu('斜杠命令');
      var cmdTitle = document.querySelector('#popover .popover-title');
      out.cmdPopoverTitle = cmdTitle ? cmdTitle.textContent : null;

      click('#btn-context');
      out.clickedSkill = pickMenu('技能');
      out.sentAfterSkill = sentTypes();

      click('#btn-context');
      out.clickedSketch = pickMenu('绘图');
      out.sketchVisible = !document.querySelector('#sketch').classList.contains('hidden');

      feed({ type: 'scratch', goal: '把 LVGL 跑起来', planMode: true });
      out.chipsVisible = !document.querySelector('#chips').classList.contains('hidden');
      out.chipTexts = [].slice.call(document.querySelectorAll('#chips .chip')).map(function (e) { return e.textContent; });

      // ⑨ 「+」号要足亮（用户要求"改为白色"）
      var plus = document.querySelector('#btn-context');
      var plusSvg = plus ? plus.querySelector('svg') : null;
      var probe = document.createElement('span');
      probe.style.color = 'var(--vscode-foreground)';
      document.body.appendChild(probe);
      out.foregroundColor = getComputedStyle(probe).color;
      probe.parentNode.removeChild(probe);
      out.plusColor = plus ? getComputedStyle(plus).color : null;
      out.plusFill = plusSvg ? getComputedStyle(plusSvg).fill : null;

      // ⑩ 模式 / 模型下拉：自家渲染（原生 <select> 的弹出层是浏览器画的，白边、又不能搜）
      feed({
        op: 'meta',
        meta: {
          status: 'ready',
          statusText: '就绪',
          modelId: 'p:m2',
          models: [
            { modelId: 'p:m1', name: 'p · m1', description: '' },
            { modelId: 'p:m2', name: 'p · m2', description: '' },
          ],
          modes: [
            { id: 'default', name: 'Default', description: '改前询问' },
            { id: 'accept_edits', name: 'Accept Edits', description: '自动允许工作区编辑' },
            { id: 'dont_ask', name: "Don't Ask", description: '本会话不再问' },
          ],
          modeId: 'accept_edits',
          commands: [],
          pendingApprovals: 0,
        },
      });
      var modeChip = document.querySelector('#mode-select');
      var modelChip = document.querySelector('#model-select');
      out.modeChipTag = modeChip.tagName;
      out.modeChipText = modeChip.textContent;
      out.modeChipActive = modeChip.classList.contains('active');
      out.modelChipText = modelChip.textContent;

      modeChip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.modeMenuItems = [].slice.call(document.querySelectorAll('#popover .menu-item')).map(function (e) {
        var l = e.querySelector('.menu-label');
        var s = e.querySelector('.menu-sub');
        return (l ? l.textContent : '') + (s ? ' / ' + s.textContent : '');
      });
      out.modeMenuChecked = document.querySelectorAll('#popover .menu-item.checked').length;

      modelChip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.modelMenuHasSearch = !!document.querySelector('#popover .menu-search');
      out.modelMenuItems = document.querySelectorAll('#popover .menu-item').length;
      var searchBox = document.querySelector('#popover .menu-search');
      if (searchBox) {
        searchBox.value = 'm2';
        searchBox.dispatchEvent(new Event('input', { bubbles: true }));
      }
      out.modelMenuFiltered = [].slice.call(document.querySelectorAll('#popover .menu-label')).map(function (e) {
        return e.textContent;
      });

      // 探针里任何一步抛异常都要把错误带出来 —— 否则只会看到"没拿到测量块"，
      // 那是症状不是原因（第一次就栽在这上面）
      } catch (err) {
        out.error = String((err && err.stack) || err);
      }

      var pre = document.createElement('pre');
      pre.textContent = 'BEHAVIOR-START\\n' + JSON.stringify(out, null, 1) + '\\nBEHAVIOR-END';
      document.body.appendChild(pre);
    }, 150);
  }, 400);
})();
</script>`;

function run() {
  if (!fs.existsSync(SRC)) {
    // 自己把预览页生成出来 —— 能跑在测试套件里，就不会有人记得先手动生成
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'make-preview.js'), path.dirname(SRC), 'dark'], {
        stdio: 'ignore',
      });
    } catch (err) {
      console.log('跳过：预览页生成失败（' + String(err.message).split('\n')[0] + '）');
      process.exit(0);
    }
  }
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/nonce-([A-Za-z0-9]+)/);
  const nonceAttr = m ? ` nonce="${m[1]}"` : '';
  fs.writeFileSync(OUT, html.replace(/<\/body>/, PROBE.replace('<script', '<script' + nonceAttr) + '\n</body>'), 'utf8');

  // 先校验生成的页面里每段内联脚本的**语法**。
  // 模板字符串里写 'don\'t' 这种转义会被本文件吃掉，生成出去就变成 'don't'
  // —— 整段脚本静默不执行，表现只是"没拿到测量块"。这个坑我栽过两次了。
  const page = fs.readFileSync(OUT, 'utf8');
  for (const [i, script] of [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].entries()) {
    if (!script[1].trim()) {
      continue;
    }
    try {
      new Function(script[1]);
    } catch (err) {
      console.log(`✗ 生成页第 ${i} 段内联脚本语法错误：${err.message}`);
      process.exit(1);
    }
  }

  let dom = '';
  try {
    dom = execFileSync(
      EDGE,
      ['--headless=new', '--disable-gpu', '--virtual-time-budget=6000', '--window-size=460,900', '--dump-dom', 'file:///' + OUT],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (err) {
    console.log('跳过：起不了 headless Edge（' + String(err.message).split('\n')[0] + '）');
    process.exit(0);
  }

  // 注意要锚定 <pre>：--dump-dom 会把 <script> 源码一起吐出来，
  // 源码里也有 BEHAVIOR-START 这个字面量，不锚定就会匹配到脚本自己。
  const found = dom.match(/<pre>BEHAVIOR-START([\s\S]*?)BEHAVIOR-END/);
  if (!found) {
    console.log('✗ 没拿到测量块（页面可能没跑起来）');
    process.exit(1);
  }
  const r = JSON.parse(found[1]);

  const checks = [
    ['点时钟图标 → 回传 listSessions', (r.sentAfterHistory || []).includes('listSessions')],
    ['列表返回 → 弹层自动打开', r.popoverVisible === true],
    ['弹层里有 4 条会话', r.popoverItems === 4],
    ['弹层分成两组', (r.popoverGroupTitles || []).length === 2],
    ['点弹层条目 → 回传 loadSession', (r.loadsAfterPopoverClick || []).join() === 'here-1'],
    ['点条目后弹层关闭', r.popoverClosedAfterClick === true],
    ['首页行点击 → 也能回传 loadSession', (r.loadsAfterHomeRowClick || []).length === 2],
    ['首页显示「查看全部（4 个）」', r.homeMoreText === '查看全部（4 个）'],
    ['思考块：不给 collapsed 字段也是折叠的', r.thoughtHiddenWithoutField === true],
    ['思考块头部：思考中显示「思考中…」', /思考中/.test(r.thoughtHeadRunning || '')],
    ['思考块头部：折叠态显示字数', /42 字/.test(r.thoughtHeadRunning || '')],
    ['思考块：点头部可展开', r.thoughtExpanded === true],
    ['思考块：再点可折叠', r.thoughtCollapsedAgain === true],
    ['思考块：回合结束后显示「思考过程 · 42 字」', r.thoughtHeadSettled === '▸ 思考过程 · 42 字'],
    ['模型下拉没有可见边框（旧 ID 规则被压住）', r.modelBorderW === '0px'],
    ['模型下拉背景透明', r.modelBg === 'rgba(0, 0, 0, 0)'],
    ['模式下拉没有可见边框', r.modeBorderW === '0px'],
    ['发送按钮有可见圆底（不是透明/等于卡片底色）', !!r.sendBg && r.sendBg !== 'rgba(0, 0, 0, 0)'],
    [
      '「+」菜单三段：添加 / Hermes / 面板',
      (r.menuSections || []).length === 3 &&
        r.menuSections[0] === '添加' &&
        r.menuSections[1] === 'Hermes' &&
        /面板/.test(r.menuSections[2]),
    ],
    ['菜单共 9 项（2 添加 + 4 Hermes + 3 面板）', r.menuItems === 9],
    [
      'Hermes 段是 Hermes 自己的东西（斜杠命令 / 技能 / 工具列表 / 上下文用量）',
      ['斜杠命令', '技能', '工具列表', '上下文用量'].every(function (n) {
        return (r.menuLabels || []).indexOf(n) >= 0;
      }),
    ],
    ['菜单里不再有 Codex 的插件条目（Documents/PDF/…）', (r.menuLabels || []).indexOf('Documents') < 0],
    ['点「斜杠命令」→ 打开命令弹层', r.clickedCmd === true && /^斜杠命令/.test(r.cmdPopoverTitle || '')],
    ['点「技能」→ 回传 pickSkill', r.clickedSkill === true && (r.sentAfterSkill || []).includes('pickSkill')],
    ['点「绘图」→ 画布浮层出现', r.clickedSketch === true && r.sketchVisible === true],
    ['目标/计划模式生效时显示状态角标', r.chipsVisible === true && (r.chipTexts || []).length === 2],
    [
      '「+」号用的是足亮前景色（没被压暗）',
      !!r.foregroundColor && r.plusColor === r.foregroundColor && r.plusFill === r.foregroundColor,
    ],
    ['模式/模型格子是按钮（不再是原生 <select>）', r.modeChipTag === 'BUTTON'],
    ['非默认审批模式用强调色（不是警告橙）', r.modeChipActive === true],
    ['模式格子显示当前值并带下拉箭头', r.modeChipText === 'Accept Edits ▾'],
    ['点模式格子 → 下拉 3 项、带说明、当前项打勾', (r.modeMenuItems || []).length === 3 && /改前询问/.test((r.modeMenuItems || []).join('|')) && r.modeMenuChecked === 1],
    ['模型下拉有搜索框', r.modelMenuHasSearch === true && r.modelMenuItems === 2],
    ['搜索框能过滤模型', (r.modelMenuFiltered || []).join() === 'm2'],
  ];

  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) bad += 1;
  }
  if (bad) {
    console.log(`—— 交互行为 ${checks.length - bad}/${checks.length} 通过（失败 ${bad}）`);
    console.log(JSON.stringify(r, null, 1));
    process.exit(1);
  }
  console.log(`—— 交互行为 ${checks.length}/${checks.length} 通过`);
}

run();
