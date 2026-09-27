# session-bulk-archive — 自测

插件本体是上一层的 `plugin.js`。这个目录是它的离线测试台：桩掉
`@hermes/plugin-sdk`（`node_modules/@hermes/plugin-sdk/index.mjs`），用真
React 19 + `react-dom/server` 把 `register()` 注册出来的贡献渲染一遍，并把它
的数据层接到**正在运行的本地后端**上跑：

- GET（会话列表）真的发请求，所以列表映射 / `profile=all` / `archived=exclude|only`
  这些容易写错的地方是真被验证的；
- 写请求（PATCH 归档）**只记录不发送**，不会动你的会话数据。

## 跑法

```bash
cd D:/APP/hermes/desktop-plugins/session-bulk-archive

# 1) 找后端端口（桌面 App 会给每个 profile 起一个 loopback 后端）
netstat -ano | grep LISTENING | grep 127.0.0.1

# 2) 指定其中一个跑（token 会自动从 / 抓，不用手填）
SBA_BASE=http://127.0.0.1:<port> node tests/test.mjs
```

输出是一行一个断言，最后一行是 `N passed, M failed`；有 FAIL 时退出码非 0。
没有可用后端时会报 `no dashboard session token served by …`，换个端口再试。

## 覆盖点（改动 plugin.js 后重跑）

- 默认**不注册任何 pane**（零布局占用）；只有命令/开关才注册右侧面板
- 列表请求形状 + 渲染行数与 App 真实返回**逐条对齐**
- 勾选 → 计数 → 确认框标题 → 每个会话一条 `PATCH /api/sessions/<id>`
  （body 带 `archived` 与所属 `profile`，请求作用域也带 `profile`）
- 切「已归档」→ `archived=only`，并列出真实的已归档会话
- ⌘K 命令 / 快捷键 ⌘⌥A 都走 `host.navigate('/session-archive')`（不再有弹窗）
- **不注册任何 `statusBar.*` 贡献**：状态栏那颗 chip 已移除（它以前兼任弹窗宿主），
  测试里有回归断言盯着
- 侧边栏 Kanban 下方那行「会话归档」= 导航行（`sidebar.nav`, order 60 > Kanban 的 50）
  + `/session-archive` 整页；点它走 `host.navigate`，不是弹窗
- i18n：所有 key 都能解析（缺 key 会直接渲染出英文 key，测得出）

`node_modules/` 只服务于这个测试台，插件运行时不需要它。
