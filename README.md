# Hermes 面板

在 VS Code 侧边栏里直接使用 [Hermes Agent](https://hermes-agent.nousresearch.com/docs/)。
面板通过 **ACP（Agent Client Protocol）** 与本地 `hermes acp` 子进程通信，所以 agent 侧的能力
——工具、记忆、skills、模型、终端——全部由你已有的 Hermes 提供，扩展只负责把它画出来。

## 功能

- **流式对话**：回复逐字推送，思考过程单独折叠展示
- **工具卡片**：读取 / 修改 / 执行 / 搜索 分别标注，带状态（进行中 / 完成 / 失败）与可折叠输出
- **文件 diff 审批**：Hermes 要改文件时弹出审批卡，直接看增删行，选「允许」或「拒绝」
- **会话管理**：新建会话、列出当前工作区的历史会话、点击切回
- **模型切换**：下拉选择，清单来自 Hermes 自身（与 `hermes model` 一致）
- **上下文用量条**：实时显示当前会话占用了多少上下文
- **斜杠命令**：输入 `/` 会浮出 Hermes 支持的斜杠命令
- **编辑器上下文**：右键菜单把选中代码或整个文件交给 Hermes

## 要求

1. 本机已安装并配置好 Hermes（`hermes setup` 或 `hermes model` 完成过一次即可）
2. 自检通过：`hermes acp --check` 应输出 `Hermes ACP check OK`
3. VS Code 1.134.0 或更高

扩展默认从 `PATH` 里找 `hermes`。找不到时可手动指定：

```json
{
  "hermesPanel.command": "D:\\APP\\hermes\\bin\\hermes.exe",
  "hermesPanel.args": ["acp"]
}
```

## 快捷键与命令

| 命令 | 快捷键 | 说明 |
|---|---|---|
| 打开 Hermes 面板 | `Ctrl+Alt+H` | 聚焦侧边栏面板 |
| 新建会话 | — | 丢弃当前上下文，开一个新会话 |
| 重启 ACP 连接 | — | 连接异常时的重连按钮（面板右上角 ↻） |
| Hermes: 解释选中代码 | — | 编辑器右键菜单 |
| Hermes: 修复选中代码 | — | 编辑器右键菜单 |
| Hermes: 审查选中代码 | — | 编辑器右键菜单 |
| Hermes: 把当前文件发给 Hermes | — | 编辑器右键菜单 |
| Hermes: 自检 | — | 在输出通道里打印诊断信息并发一条最小 prompt |

面板里：`Enter` 发送，`Shift+Enter` 换行。

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `hermesPanel.command` | `hermes` | Hermes 可执行文件路径 |
| `hermesPanel.args` | `["acp"]` | 启动参数 |
| `hermesPanel.autoApproveEdits` | `false` | 自动批准文件修改（危险，等于跳过 diff 确认） |
| `hermesPanel.autoResume` | `true` | 重开面板时自动恢复本工作区上次的会话 |
| `hermesPanel.maxTranscriptItems` | `400` | 面板保留的最大条目数 |

## 排查

- **状态点一直是灰的 / 提示找不到可执行文件**：在设置里写全 `hermesPanel.command` 的绝对路径。
- **连不上但命令行能用**：在 VS Code 的「输出」面板选择「Hermes 面板」通道，里面有完整的启动日志和 Hermes 的 stderr。
  也可以跑一次命令面板里的「Hermes: 自检」。
- **Remote SSH / WSL**：扩展声明为 `extensionKind: ["workspace"]`，运行在远端（也就是代码所在的那一侧），
  因此远端必须装好 Hermes。

## 开发

```bash
npm install
npm run compile      # tsc -p ./
npm test             # 全套测试（含真连 hermes 的活体测试）
SKIP_LIVE=1 npm test # 只跑离线部分
npm run package      # 生成 .vsix
```

测试分三层：纯模块单测（markdown 转义、diff、JSON 流解析）、用**真实抓包报文**回放状态机、
以及真起 `hermes acp` 的端到端测试（会消耗少量模型额度，但能验到「文件真的落盘」）。

## 许可

MIT
