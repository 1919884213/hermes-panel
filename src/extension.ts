import * as vscode from 'vscode';
import { HermesPanelProvider } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new HermesPanelProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HermesPanelProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const register = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('hermesPanel.focus', () => vscode.commands.executeCommand(`${HermesPanelProvider.viewType}.focus`));
  register('hermesPanel.newSession', () => provider.newSession());
  register('hermesPanel.restart', () => provider.restart());

  register('hermesPanel.askSelection', () =>
    provider.askWithContext('解释下面这段代码的功能、关键逻辑，以及可能的问题。', true)
  );
  register('hermesPanel.fixSelection', () =>
    provider.askWithContext('请找出下面这段代码的缺陷，给出修复后的完整代码，并说明改了什么地方、为什么。', true)
  );
  register('hermesPanel.reviewSelection', () =>
    provider.askWithContext(
      '请以代码审查的视角审查下面这段代码：正确性、边界条件、错误处理、资源管理、命名与可移植性。按严重程度排序。',
      true
    )
  );
  register('hermesPanel.askFile', () =>
    provider.askWithContext('请通读下面这个文件，概述它的职责、关键流程和值得注意的实现细节。', false)
  );

  register('hermesPanel.selfTest', async () => {
    const diag = provider.diagnose();
    console.log('[hermes-panel] selftest diagnose:', JSON.stringify(diag));
    if (!diag.ok) {
      void vscode.window.showErrorMessage(`Hermes 自检失败：${diag.detail}`);
      return;
    }
    await vscode.commands.executeCommand(`${HermesPanelProvider.viewType}.focus`);
    await provider.sendPrompt('只回答两个字：收到');
    console.log('[hermes-panel] selftest prompt finished');
    void vscode.window.showInformationMessage('Hermes 自检完成，详情见「Hermes 面板」输出通道。');
  });

  // 无 GUI 也能跑的自检：HERMES_PANEL_SELFTEST=1 启动编辑器，4 秒后自动发一条最小 prompt，
  // 结果会写进 OutputChannel 和 exthost.log —— 用来验证「真的连上了」而不是「看起来连上了」。
  if (process.env.HERMES_PANEL_SELFTEST === '1') {
    const timer = setTimeout(async () => {
      try {
        const diag = provider.diagnose();
        console.log('[hermes-panel] selftest diagnose:', JSON.stringify(diag));
        if (!diag.ok) {
          return;
        }
        await vscode.commands.executeCommand(`${HermesPanelProvider.viewType}.focus`);
        await provider.sendPrompt('只回答两个字：收到');
        console.log('[hermes-panel] selftest prompt finished');
      } catch (err) {
        console.log('[hermes-panel] selftest failed:', err instanceof Error ? err.message : String(err));
      }
    }, 4000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }

  console.log('[hermes-panel] activated');
}

export function deactivate(): void {
  // provider 的订阅随 context.dispose() 一起回收
}
