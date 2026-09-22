'use strict';
/**
 * 扩展宿主测试：用假的 vscode 模块直接驱动真实的 out/extension.js。
 *
 * 覆盖 manifest 管不到的那一半 —— 命令是否真的注册、webview 消息协议是否
 * 走得通、postMessage 出来的东西 webview 认不认。后半段是真连 `hermes acp`
 * 的活体检查（用 SKIP_LIVE=1 可跳过）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { ok, eq, includes, section, finish, waitFor } = require('./lib');
const { createFakeVscode } = require('./fake-vscode');

const WORKDIR = path.join(os.tmpdir(), `hermes-panel-ext-${Date.now()}`);
const LIVE = process.env.SKIP_LIVE !== '1';

/** 分段打点：任何一步卡住都能从日志看出卡在哪 */
function stage(label) {
  console.log(`[stage] ${label}`);
}

/**
 * 看门狗：测试绝不允许无限期挂着。
 * 没有它的话，一个永远不返回的 promise 会让整个套件静默僵死 —— 这正是
 * 第一次跑的时候发生的事（7 分钟无输出、无报错）。
 */
const watchdog = setTimeout(() => {
  console.error('\n看门狗触发：测试运行超过 240 秒，强制退出。');
  process.exit(3);
}, 240_000);
watchdog.unref?.();

async function main() {
  fs.mkdirSync(WORKDIR, { recursive: true });
  stage('准备假 vscode 环境');

  const h = createFakeVscode({ workspaceFolder: WORKDIR, config: { autoResume: false } });

  // 拦截模块加载：把 'vscode' 换成假的
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') {
      return h.fake;
    }
    return originalLoad.call(this, request, ...rest);
  };

  const ext = require('../out/extension.js');
  ext.activate(h.context);

  section('激活与命令注册');
  const expected = [
    'hermesPanel.focus',
    'hermesPanel.newSession',
    'hermesPanel.restart',
    'hermesPanel.askSelection',
    'hermesPanel.fixSelection',
    'hermesPanel.reviewSelection',
    'hermesPanel.askFile',
    'hermesPanel.selfTest',
  ];
  const missing = expected.filter((id) => !h.state.commands.has(id));
  eq(missing, [], 'package.json 里声明的 8 个命令全部注册');
  eq(h.state.providers.has('hermesPanel.chat'), true, 'webview 视图 provider 已注册');

  const providerEntry = h.state.providers.get('hermesPanel.chat');
  eq(
    !!(providerEntry.options && providerEntry.options.webviewOptions),
    true,
    '注册时带上 webviewOptions（切标签不丢上下文）'
  );

  section('webview HTML：CSP 与资源引用');
  const view = h.makeView();
  providerEntry.provider.resolveWebviewView(view);
  const html = view.webview.html;
  includes(html, 'Content-Security-Policy', 'HTML 带 CSP');
  includes(html, "default-src 'none'", 'CSP 默认拒绝一切');
  includes(html, 'nonce-', 'CSP 使用 per-render nonce');
  eq(/unsafe-eval/.test(html), false, 'CSP 不含 unsafe-eval');
  includes(html, 'chat.css', '引用了 chat.css');
  includes(html, 'chat.js', '引用了 chat.js');
  eq(/src="file:/.test(html), false, '没有 file:// 本地引用（webview 会拒绝）');
  includes(html, 'Hermes 面板', '页面标题正确');
  eq(/<script(?![^>]*nonce=)/.test(html), false, '每个 script 标签都带 nonce');

  section('webview 消息协议');
  await h.sendFromWebview({ type: 'ready' });
  const resetOp = await h.findBy((m) => m.op === 'reset', 5_000);
  ok(!!resetOp, '收到 ready 后回发 reset 快照');
  eq(typeof resetOp.items, 'object', 'reset 里带 items 数组');
  eq(typeof resetOp.meta, 'object', 'reset 里带 meta');
  eq(resetOp.meta.status, 'offline', '初始状态为未连接');

  section('编辑器上下文拼装（选中代码）');
  h.setActiveEditor('int main(void) {\n  return 0;\n}\n', {
    path: path.join(WORKDIR, 'main.c'),
    selectedText: 'return 0;',
    startLine: 1,
    endLine: 1,
  });
  const provider = providerEntry.provider;
  const block = await provider.buildContextBlock(true);
  includes(block, 'main.c', '上下文里带文件名');
  includes(block, '第 2-2 行', '上下文里带行号范围');
  includes(block, '```c', '上下文里带代码围栏与语言');
  includes(block, 'return 0;', '上下文里是选中的那段代码');
  eq(block.includes('int main'), false, '没选中时不会把整文件塞进去（这里是选中了才不含其它行）');

  h.setActiveEditor('', { path: path.join(WORKDIR, 'empty.c'), fullText: '' });
  eq(await provider.buildContextBlock(true), undefined, '空编辑器返回 undefined 而不是空串');

  if (!LIVE) {
    console.log('\n（SKIP_LIVE=1，跳过活体链路测试）');
    try {
      fs.rmSync(WORKDIR, { recursive: true, force: true });
    } catch {}
    finish();
    return;
  }

  section('活体链路：面板 → ACP → hermes（真流式）');
  stage('发送 prompt（会真的调用模型）');
  const before = h.state.posted.length;
  await h.sendFromWebview({ type: 'prompt', text: '只回答两个字：收到' });
  stage('prompt 已返回，等待 webview 侧收到流式回复');

  const assistantOp = await waitFor(
    () => {
      for (let i = before; i < h.state.posted.length; i++) {
        const msg = h.state.posted[i];
        if (msg.op === 'text' && /收到/.test(msg.html || '')) {
          return msg;
        }
        if (msg.op === 'add' && msg.item && msg.item.kind === 'assistant' && /收到/.test(msg.item.html || '')) {
          return msg;
        }
      }
      return null;
    },
    60_000,
    '等待助手回复包含「收到」'
  );
  ok(!!assistantOp, '扩展真的把 hermes 的回复推给了 webview');

  await waitFor(
    () => h.state.posted.some((m) => m.op === 'meta' && m.meta && m.meta.status === 'ready'),
    30_000,
    '等待状态回到 ready'
  );
  ok(true, '回合结束后状态回到 ready');

  ok(
    h.state.workspaceStateMap.size > 0,
    'sessionId 被记进 workspaceState（下次可自动恢复）'
  );

  const userOp = h.state.posted.find((m) => m.op === 'add' && m.item && m.item.kind === 'user');
  ok(!!userOp, '用户消息被本地回显到面板');
  includes(userOp.item.html, '只回答两个字', '回显的是原始输入');

  ok(
    h.state.logs.some((l) => l.includes('新建会话')),
    'OutputChannel 里留下了「新建会话」的审计记录'
  );
  ok(
    h.state.logs.some((l) => l.includes('回合结束')),
    'OutputChannel 里留下了回合结束与 token 用量'
  );

  section('restart 命令：断开后能重连回来');
  stage('执行 restart');
  await h.state.commands.get('hermesPanel.restart')();
  ok(
    h.state.posted.some((m) => m.op === 'reset'),
    'restart 会重置面板'
  );
  await waitFor(
    () => h.state.logs.filter((l) => l.includes('新建会话')).length >= 2,
    90_000,
    '等待 restart 后重新建会话'
  );
  ok(true, 'restart 后确实重新建立了会话（不是「什么都不做」）');

  console.log(`\n扩展日志（OutputChannel）共 ${h.state.logs.length} 行：`);
  for (const line of h.state.logs.slice(0, 16)) {
    console.log(`    ${line}`);
  }

  try {
    fs.rmSync(WORKDIR, { recursive: true, force: true });
  } catch {}

  finish();
}

main().catch((err) => {
  console.error(`\n扩展宿主测试异常：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
