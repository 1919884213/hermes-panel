# Hermes Desktop 插件集

Hermes 桌面端（Electron）的 UI 插件。每个插件是一个独立目录，**目录名必须等于插件 id**。

## 安装

把插件目录整个复制到 `<HERMES_HOME>/desktop-plugins/` 下即可（Windows 默认
`D:\APP\hermes\desktop-plugins\`，Linux/macOS 为 `~/.hermes/desktop-plugins/`）：

```bash
# 例：装「会话 Token 详情 · 费用估算」
cp -r session-token-detail "<HERMES_HOME>/desktop-plugins/"
```

装完在 App 里按 `Ctrl/⌘K` → **Reload desktop plugins** 生效。
插件改文件后也会热重载。

> 桌面插件**不需要**在 `config.yaml` 的 `plugins:` 段登记（那是 CLI 插件系统）。

## 插件列表

### session-token-detail — 会话 Token 详情 · 费用估算

状态栏右下角一枚常驻 chip，显示当前聚焦会话的上下文占用与花费；点开是明细面板：

- 上下文窗口占比、按类拆分（系统提示 / 工具 / 技能 / 记忆 / 对话）
- **会话费用**：按你填的单价分项估算（输入 / 输出 / 缓存读 / 缓存写 / 每次调用），
  口径与 Hermes 自己的 `agent/usage_pricing.py` 一致
- Token 计数、API 调用次数、压缩次数、缓存命中率、吞吐 t/s、平均延迟
- **价格配置文件**（≤ 20 个）：每个可独立命名与改价，用户主动切换；
  还能把某个会话**单独绑定**到某套配置，切换全局配置不影响它
- 价格来源优先级：配置文件 > 手填 > 网关价目（自动取回并缓存 24h）> 通用默认价

### session-bulk-archive — 会话批量归档

原生界面归档会话要一个个点，这个插件补上「多选 → 一次归档」：

- 侧边栏一行「会话归档」→ 整页多选列表
- `⌘K` 命令 / 快捷键 `⌘⌥A` 跳到同一页
- 勾选多个 → 归档；「已归档」视图里可批量恢复

### session-cost-rmb

预留目录，暂无代码。

## 开发与测试

每个插件自带离线测试台（`tests/test.mjs`）：桩掉 `@hermes/plugin-sdk`，用
`react-dom/server` 静态渲染**真正的 `plugin.js`**，对纯函数手算核对、断言注册形状与
渲染文案。

```bash
cd session-token-detail
node tests/test.mjs      # 退出码非 0 = 有 FAIL
```

`node_modules/` 不入库（只给测试台用，运行时不需要）。跑测试前从任一已装插件的
目录拷一份过去即可：

```bash
cp -r "<HERMES_HOME>/desktop-plugins/session-token-detail/node_modules" ./session-token-detail/
```

### 硬约束（违反 = 加载器直接拒）

- 只能 `import` `react`、`react/jsx-runtime`、`@hermes/plugin-sdk` 三个说明符
- 文件**不编译**：只能写 `jsx(type, props, key)` / `jsxs(...)`，不能写 JSX 语法
- `key` 必须走 `jsx()` 的第三个参数，放 props 里会被 React 警告
- i18n 每个 key 必须在 zh / en 两套 bundle 里都有，且不留死 key

## 许可

随本仓库 LICENSE。
