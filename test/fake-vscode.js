'use strict';
/**
 * 假的 `vscode` 模块 —— 一个「忠实的记录器」，不是空壳。
 *
 * 有了它，`out/extension.js` 可以在无 GUI、无第二个编辑器实例的情况下被直接
 * 驱动：命令注册、webview 消息协议、postMessage 全都能断言。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function createFakeVscode(opts = {}) {
  const workspaceFolder = opts.workspaceFolder || path.join(os.tmpdir(), 'hermes-panel-fake-ws');
  const configValues = Object.assign(
    {
      command: 'hermes',
      args: ['acp'],
      autoApproveEdits: false,
      autoResume: false,
      maxTranscriptItems: 400,
    },
    opts.config || {}
  );

  const state = {
    commands: new Map(),
    posted: [],
    logs: [],
    providers: new Map(),
    messageHandler: null,
    workspaceStateMap: new Map(),
    openedFiles: [],
    externalUrls: [],
  };

  let activeEditor = null;

  const Uri = {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }),
    parse: (s) => ({ fsPath: s, toString: () => s }),
    joinPath: (base, ...parts) => Uri.file(path.join(base.fsPath, ...parts)),
  };

  const fake = {
    Uri,
    ViewColumn: { One: 1 },
    window: {
      registerWebviewViewProvider: (type, provider, options) => {
        state.providers.set(type, { provider, options });
        return { dispose() {} };
      },
      createOutputChannel: (name) => ({
        name,
        appendLine: (line) => state.logs.push(line),
        append: () => {},
        dispose: () => {},
        show: () => {},
      }),
      showInformationMessage: async (m) => {
        state.logs.push(`[info] ${m}`);
      },
      showWarningMessage: async (m) => {
        state.logs.push(`[warn] ${m}`);
      },
      showErrorMessage: async (m) => {
        state.logs.push(`[err] ${m}`);
      },
      showTextDocument: async (doc) => {
        state.openedFiles.push(doc && doc.uri ? doc.uri.fsPath : String(doc));
        return {};
      },
      get activeTextEditor() {
        return activeEditor;
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceFolder }, name: path.basename(workspaceFolder), index: 0 }],
      getConfiguration: () => ({
        get: (key, def) => (key in configValues ? configValues[key] : def),
      }),
      asRelativePath: (uri) => uri.fsPath,
      fs: {
        readFile: async (uri) => Buffer.from(fs.readFileSync(uri.fsPath)),
        writeFile: async (uri, data) => fs.writeFileSync(uri.fsPath, data),
      },
      openTextDocument: async (uri) => ({ uri }),
    },
    commands: {
      registerCommand: (id, handler) => {
        state.commands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        const handler = state.commands.get(id);
        return handler ? handler(...args) : undefined;
      },
    },
    env: {
      openExternal: async (uri) => {
        state.externalUrls.push(String(uri));
        return true;
      },
    },
  };

  const context = {
    subscriptions: [],
    extensionUri: { fsPath: opts.extensionUri || path.join(__dirname, '..') },
    packageJSON: { version: '0.1.0-test' },
    extension: { packageJSON: { version: '0.1.0-test' } },
    workspaceState: {
      get: (key, def) => (state.workspaceStateMap.has(key) ? state.workspaceStateMap.get(key) : def),
      update: async (key, value) => {
        state.workspaceStateMap.set(key, value);
      },
    },
  };

  function makeView() {
    const webview = {
      options: {},
      cspSource: 'vscode-webview://test',
      html: '',
      asWebviewUri: (uri) => ({ toString: () => `vscode-webview://test/${path.basename(uri.fsPath)}` }),
      onDidReceiveMessage: (cb) => {
        state.messageHandler = cb;
        return { dispose() {} };
      },
      postMessage: async (msg) => {
        state.posted.push(msg);
        return true;
      },
    };
    return { webview, onDidDispose: () => ({ dispose() {} }), show: () => {}, visible: true };
  }

  /**
   * 造一个假编辑器。传入 selection 时，document.getText(selection) 只返回选中片段；
   * 空选中必须返回 ''（否则 panel 的「无选中」分支永远不会被执行到）。
   */
  function setActiveEditor(text, info = {}) {
    const filePath = info.path || path.join(workspaceFolder, 'main.c');
    const hasSelection = typeof info.selectedText === 'string';
    activeEditor = {
      document: {
        uri: { fsPath: filePath },
        languageId: info.languageId || 'c',
        lineCount: String(info.fullText || text).split('\n').length,
        getText: (selection) => {
          if (!selection) {
            return info.fullText || text;
          }
          return selection.__selectedText || '';
        },
      },
      selection: hasSelection
        ? {
            isEmpty: false,
            __selectedText: info.selectedText,
            start: { line: info.startLine ?? 0 },
            end: { line: info.endLine ?? (info.startLine ?? 0) + String(info.selectedText).split('\n').length - 1 },
          }
        : { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
    };
  }

  async function sendFromWebview(msg) {
    if (!state.messageHandler) {
      throw new Error('webview 尚未注册消息处理器：先调用 resolveWebviewView');
    }
    await state.messageHandler(msg);
  }

  function findBy(predicate, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const hit = state.posted.find(predicate);
        if (hit) {
          return resolve(hit);
        }
        if (Date.now() > deadline) {
          return reject(new Error('等待 webview 消息超时'));
        }
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  return { fake, state, context, makeView, setActiveEditor, sendFromWebview, findBy };
}

module.exports = { createFakeVscode };
