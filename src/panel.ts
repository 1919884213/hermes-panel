/**
 * 侧边栏面板：把 ACP 客户端、会话状态机和 webview 串起来。
 * 这是唯一碰 vscode API 的地方（连同 extension.ts）。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AcpClient,
  JsonObject,
  isEmptyResult,
  looksLikeStaleSession,
  resolveExecutable,
  defaultSearchDirs,
} from './acpClient';
import { buildHtml } from './htmlTemplate';
import { createState, reduce, snapshot, TranscriptEvent, TranscriptState, WebviewOp } from './transcript';

interface PendingPermission {
  agentId: number | string;
  gate: (result: JsonObject) => void;
}

export class HermesPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hermesPanel.chat';

  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private state: TranscriptState;
  private permissions = new Map<string, PendingPermission>();
  private permissionSeq = 1;
  private starting?: Promise<void>;
  private running = false;
  /** 本回合收到的 assistant 内容块数——用来识别「空手而归」的死会话 */
  private turnChunks = 0;
  private readonly output: vscode.OutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    const maxItems = vscode.workspace.getConfiguration('hermesPanel').get<number>('maxTranscriptItems', 400);
    this.state = createState(maxItems);
    this.output = vscode.window.createOutputChannel('Hermes 面板');
    context.subscriptions.push(this.output);
  }

  // ────────────────────────────── webview 生命周期 ──────────────────────────────

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = buildHtml({
      cspSource: view.webview.cspSource,
      nonce: makeNonce(),
      cssUri: view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css')).toString(),
      jsUri: view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js')).toString(),
      workspaceName: this.workspaceName(),
    });

    view.webview.onDidReceiveMessage(
      (msg) => this.onWebviewMessage(msg),
      undefined,
      this.context.subscriptions
    );

    this.post([snapshot(this.state)]);
    void this.ensureConnection().catch(() => undefined);
  }

  private post(ops: WebviewOp[] | JsonObject[]): void {
    if (!this.view) {
      return;
    }
    for (const op of ops) {
      void this.view.webview.postMessage(op);
    }
  }

  private dispatch(event: TranscriptEvent): void {
    const ops = reduce(this.state, event);
    if (ops.length) {
      this.post(ops);
    }
  }

  private log(line: string): void {
    const stamped = `[${new Date().toLocaleTimeString('zh-CN')}] ${line}`;
    this.output.appendLine(stamped);
    // 镜像到 console，这样无 GUI 也能从 exthost.log 里读（便于自测）
    console.log('[hermes-panel]', line);
  }

  private workspaceCwd(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : os.homedir();
  }

  /**
   * workspaceState 的 key。Windows 上同一个文件夹可能以 `d:\` 和 `D:\` 两种写法出现，
   * 若不归一化就会被当成两个 key，会话记录时有时无（实测日志里就出现过小写盘符）。
   */
  private sessionKey(cwd: string): string {
    const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    return `hermesPanel.sessionId:${normalized}`;
  }

  private workspaceName(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return '（无工作区）';
    }
    return path.basename(folder.uri.fsPath);
  }

  // ────────────────────────────── ACP 连接 ──────────────────────────────

  private config() {
    const cfg = vscode.workspace.getConfiguration('hermesPanel');
    return {
      command: cfg.get<string>('command', 'hermes'),
      args: cfg.get<string[]>('args', ['acp']),
      autoApproveEdits: cfg.get<boolean>('autoApproveEdits', false),
      autoResume: cfg.get<boolean>('autoResume', true),
    };
  }

  /** 找到 Hermes 可执行文件；找不到就抛出带修复建议的错误 */
  public diagnose(): { ok: boolean; detail: string } {
    const { command } = this.config();
    const found = resolveExecutable(command, defaultSearchDirs());
    if (!found) {
      return {
        ok: false,
        detail:
          `找不到可执行文件「${command}」。已尝试 PATH 与以下目录：\n` +
          defaultSearchDirs().join('\n') +
          `\n请在设置 hermesPanel.command 中填写完整路径。`,
      };
    }
    return { ok: true, detail: `${found.file}${found.needsShell ? '（通过 shell 启动）' : ''}` };
  }

  private ensureConnection(): Promise<void> {
    // 先看有没有启动流程在飞：有就跟它走。这个判断必须排在 client.alive 前面 ——
    // 进程活着但会话还没建完时，外部调用者要等的是「整轮启动完成」，不是「进程在」。
    if (this.starting) {
      return this.starting;
    }
    if (this.client?.alive) {
      return Promise.resolve();
    }
    this.starting = this.connect().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async connect(): Promise<void> {
    if (this.client) {
      this.client.dispose();
      this.client = undefined;
    }
    const cfg = this.config();
    this.dispatch({ t: 'status', status: 'connecting' });

    const check = this.diagnose();
    if (!check.ok) {
      this.dispatch({ t: 'status', status: 'error', text: '找不到 Hermes 可执行文件' });
      this.dispatch({ t: 'notice', text: check.detail, level: 'error' });
      throw new Error(check.detail);
    }

    const cwd = this.workspaceCwd();
    this.log(`启动 ${cfg.command} ${cfg.args.join(' ')}（cwd=${cwd}）`);

    const client = new AcpClient({
      command: cfg.command,
      args: cfg.args,
      cwd,
      onUpdate: (params) => this.onSessionUpdate(params),
      onRequest: (method, params, id) => this.onAgentRequest(method, params, id),
      onLog: (line) => this.log(`[hermes] ${line}`),
      onExit: (info) => this.onClientExit(info),
    });
    client.start();
    this.client = client;

    try {
      const result = await client.request<JsonObject>(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            // 文件读写与终端由 Hermes 自己的工具链路完成，这里不开客户端侧 fs，
            // 免得出现两边都想干活、审批语义还不一致的尴尬。
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'hermes-vscode-panel', version: this.version() },
        },
        60_000
      );
      this.log(`initialize 完成：protocolVersion=${result.protocolVersion}`);
      await this.bootstrapSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatch({ t: 'status', status: 'error', text: '连接失败' });
      this.dispatch({ t: 'notice', text: `连接 Hermes 失败：${message}`, level: 'error' });
      this.log(`连接失败：${message}`);
      throw err;
    }
  }

  private version(): string {
    return String(this.context.extension.packageJSON?.version ?? '0.0.0');
  }

  /**
   * 启动流程内部的会话建立。
   *
   * ⚠️ 这条路径本身就跑在 `this.starting` 那个 promise 里面，所以**绝不能**
   * 回头调用 ensureConnection()：那会 await 到自己，形成自锁 —— 表现为
   * 「面板第一次连接就永久卡住，且不报任何错」。（这正是被看门狗抓出来的 bug。）
   */
  private async bootstrapSession(): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error('Hermes 未连接');
    }
    const cwd = this.workspaceCwd();
    const cfg = this.config();

    const savedId = this.context.workspaceState.get<string>(this.sessionKey(cwd));
    if (cfg.autoResume && savedId) {
      try {
        const result = await client.request<JsonObject | null>(
          'session/load',
          { sessionId: savedId, cwd, mcpServers: [] },
          180_000
        );
        // ⚠️ 必须判「空对象」。Hermes 的 load_session 在会话不存在时 return None，
        // 线上序列化后是 `{}`，且**不抛错**；不判空就会打印「已恢复会话」，
        // 把死 id 当真，然后第一条消息以 stop_reason=refusal 静默失败。
        // 注意 `if (!result)` 是错的 —— `!{}` 为 false，挡不住它。
        // 另注：load/resume 的响应里并没有 sessionId 字段，只有 session/new 有。
        if (isEmptyResult(result)) {
          this.log(`会话 ${savedId} 在 Hermes 里已不存在，改为新建`);
          this.dispatch({
            t: 'notice',
            text: '上次的会话在这个 Hermes 进程里已经不在了（通常是它建好后没跑过一轮对话，因此没落库）。已自动新建会话。',
          });
          await this.createNewSession();
          return;
        }
        this.log(`已恢复会话 ${savedId}`);
        this.dispatch({ t: 'session', sessionId: savedId, cwd, models: result.models, modes: result.modes });
        this.dispatch({ t: 'status', status: 'ready', text: '已恢复上次会话' });
        return;
      } catch (err) {
        this.log(`恢复会话失败，改为新建：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.createNewSession();
  }

  /** 外部入口（面板按钮 / 命令 / 右键菜单）：先确保连上，再建新会话 */
  public async newSession(): Promise<void> {
    if (!this.client?.alive) {
      await this.ensureConnection().catch(() => undefined);
    }
    await this.createNewSession();
  }

  /**
   * 真正发 session/new 的地方。只依赖 this.client，**不触发连接流程** ——
   * 这样它既能从启动流程里安全调用，也能被外部入口复用。
   */
  private async createNewSession(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const cwd = this.workspaceCwd();
    try {
      const result = await client.request<JsonObject>('session/new', { cwd, mcpServers: [] }, 120_000);
      const sessionId = String(result.sessionId);
      await this.context.workspaceState.update(this.sessionKey(cwd), sessionId);
      this.dispatch({ t: 'reset' });
      this.dispatch({ t: 'session', sessionId, cwd, models: result.models, modes: result.modes });
      this.dispatch({ t: 'status', status: 'ready', text: '新建会话完成' });
      this.log(`新建会话 ${sessionId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatch({ t: 'status', status: 'error', text: '新建会话失败' });
      this.dispatch({ t: 'notice', text: `新建会话失败：${message}`, level: 'error' });
    }
  }

  private onClientExit(info: { code: number | null; signal: string | null; expected: boolean }): void {
    if (info.expected) {
      this.log('Hermes 进程已按预期退出');
      return;
    }
    this.dispatch({ t: 'status', status: 'error', text: 'Hermes 进程已退出' });
    this.dispatch({
      t: 'notice',
      text: `Hermes 进程意外退出（code=${info.code}, signal=${info.signal}）。可点右上角 ↻ 重连。`,
      level: 'error',
    });
  }

  private onSessionUpdate(params: JsonObject): void {
    const update = params.update || {};
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.turnChunks++;
    }
    this.dispatch({ t: 'update', update });
  }

  // ────────────────────────────── agent → client 请求 ──────────────────────────────

  private async onAgentRequest(method: string, params: JsonObject, id: number | string): Promise<JsonObject> {
    if (method === 'session/request_permission') {
      return this.handlePermission(params, id);
    }
    if (method === 'fs/read_text_file') {
      const filePath = String(params.path || '');
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        return { content: Buffer.from(data).toString('utf8') };
      } catch (err) {
        throw new Error(`无法读取 ${filePath}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (method === 'fs/write_text_file') {
      const filePath = String(params.path || '');
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(String(params.content ?? ''), 'utf8'));
      return {};
    }
    this.log(`未实现的 agent 请求：${method}（已回空结果）`);
    return {};
  }

  private handlePermission(params: JsonObject, agentId: number | string): Promise<JsonObject> {
    const toolCall = params.toolCall || {};
    const options: JsonObject[] = Array.isArray(params.options) ? params.options : [];
    const cfg = this.config();

    const pick = (kind: string): JsonObject | undefined => options.find((o) => o.kind === kind);
    const allowOnce = pick('allow_once') || options.find((o) => String(o.optionId).startsWith('allow'));

    if (cfg.autoApproveEdits && toolCall.kind === 'edit' && allowOnce) {
      this.dispatch({
        t: 'notice',
        text: `已按设置自动批准修改：${toolCall.title || toolCall.toolCallId}`,
      });
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: allowOnce.optionId } });
    }

    const seq = `perm-${this.permissionSeq++}`;
    return new Promise<JsonObject>((resolve) => {
      this.permissions.set(seq, { agentId, gate: resolve });
      this.dispatch({ t: 'permission', params, requestId: seq });
      this.log(`等待审批：${toolCall.title || toolCall.toolCallId}（${seq}）`);
    });
  }

  private resolvePermission(seq: string, optionId: string | undefined): void {
    const entry = this.permissions.get(seq);
    if (!entry) {
      return;
    }
    this.permissions.delete(seq);
    const outcome = optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } };
    entry.gate(outcome);
    this.dispatch({ t: 'permission-resolved', requestId: seq, optionId });
    this.log(`审批结果 ${seq} → ${optionId || 'cancelled'}`);
  }

  // ────────────────────────────── webview → extension ──────────────────────────────

  private async onWebviewMessage(msg: JsonObject): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          // 首页要显示「最近的会话」，所以连上之后主动拉一次列表。
          // 注意：这里是从 webview 进来的外部入口，可以安全 await ensureConnection；
          // 绝不能在 bootstrapSession 内部调它（会自己等自己 → 死锁）。
          this.goal = this.context.workspaceState.get<string>('hermesPanel.goal', '');
          this.planMode = this.context.workspaceState.get<boolean>('hermesPanel.planMode', false);
          void this.pushScratchState();
          void this.listSessions();
          this.post([snapshot(this.state)]);
          break;

        case 'prompt':
          await this.sendPrompt(String(msg.text ?? ''));
          break;

        case 'cancel': {
          const sessionId = this.state.meta.sessionId;
          if (this.client && sessionId) {
            this.client.notify('session/cancel', { sessionId });
            this.log('已请求中断当前回合');
          }
          break;
        }

        case 'newSession':
          await this.newSession();
          break;

        case 'restart':
          await this.restart();
          break;

        case 'listSessions':
          await this.listSessions();
          break;

        case 'pickFiles':
          await this.pickFiles();
          break;

        case 'setGoal':
          await this.setGoal();
          break;

        case 'togglePlanMode':
          await this.togglePlanMode();
          break;

        case 'sketchImage':
          await this.saveSketch(String(msg.dataUrl || ''));
          break;

        case 'pickSkill':
          await this.pickSkill();
          break;

        case 'loadSession':
          await this.loadSession(String(msg.sessionId));
          break;

        case 'setModel':
          await this.setModel(String(msg.modelId));
          break;

        case 'setMode':
          await this.setMode(String(msg.modeId));
          break;

        case 'permission':
          this.resolvePermission(String(msg.seq), msg.optionId ? String(msg.optionId) : undefined);
          break;

        case 'openFile': {
          const target = String(msg.path || '');
          if (target) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
            await vscode.window.showTextDocument(doc, { preview: true });
          }
          break;
        }

        case 'openExternal': {
          const url = String(msg.url || '');
          if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        }

        case 'requestContext': {
          const block = await this.buildContextBlock(true);
          if (block) {
            this.post([{ type: 'insertText', text: block } as unknown as WebviewOp]);
          } else {
            this.post([{ type: 'notice', text: '没有打开的编辑器，也没有选中内容。' } as unknown as WebviewOp]);
          }
          break;
        }

        case 'log':
          this.log(`[webview] ${msg.text}`);
          break;

        default:
          this.log(`未知的 webview 消息：${msg.type}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatch({ t: 'notice', text: message, level: 'error' });
      this.log(`处理 webview 消息失败：${message}`);
    }
  }

  public async restart(): Promise<void> {
    this.client?.dispose();
    this.client = undefined;
    this.dispatch({ t: 'reset' });
    this.dispatch({ t: 'notice', text: '正在重启 ACP 连接……' });
    // 关键：上一次连接流程可能还挂在这里（比如 initialize 还没回来）。
    // 不等它收尾就重新启动，两个流程会互相覆盖：新的 ensureConnection 拿到
    // 的是旧的 starting promise，于是「重启」变成了「什么都不做」。
    const inflight = this.starting;
    if (inflight) {
      await inflight.catch(() => undefined);
    }
    await this.ensureConnection().catch(() => undefined);
  }

  private async listSessions(): Promise<void> {
    await this.ensureConnection().catch(() => undefined);
    if (!this.client) {
      return;
    }
    // 刻意**不传 cwd**：要的是全部会话。桌面版/CLI 的对话大多没有关联工作区
    // （它们在线上报 cwd="."），只按当前工作区过滤会把它们整批漏掉 —— 而"看到桌面版
    // 的对话"正是这个列表存在的意义。分组交给 webview 做（它有 workspaceCwd 可比）。
    const sessions = await this.client.request<JsonObject>('session/list', {}, 30_000);
    this.post([
      {
        type: 'sessions',
        workspaceCwd: this.workspaceCwd(),
        sessions: (sessions.sessions || []).map((s: JsonObject) => ({
          sessionId: s.sessionId,
          title: s.title || s.sessionId,
          updatedAt: s.updatedAt || '',
          cwd: s.cwd || '',
          current: s.sessionId === this.state.meta.sessionId,
        })),
      } as unknown as WebviewOp,
    ]);
  }

  private async loadSession(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    // 原先这里 client 为空就直接静默 return —— 那正是"点了没反应"这类 bug 的温床。
    // 连不上必须说出来，而且先尝试把连接接起来（这是外部入口，可以安全 await）。
    await this.ensureConnection().catch(() => undefined);
    if (!this.client) {
      this.dispatch({
        t: 'notice',
        text: '载入失败：还没连上 Hermes（ACP 子进程未就绪）。试试顶栏的重启按钮。',
        level: 'error',
      });
      return;
    }
    const cwd = this.workspaceCwd();
    this.dispatch({ t: 'reset' });
    this.dispatch({ t: 'notice', text: '正在载入历史会话……' });
    const result = await this.client.request<JsonObject | null>(
      'session/load',
      { sessionId, cwd, mcpServers: [] },
      180_000
    );
    // 同上：load 找不到会话时返回空对象 {} 而不是错误，必须显式判空
    if (isEmptyResult(result)) {
      this.log(`载入失败：Hermes 里找不到会话 ${sessionId}`);
      await this.createNewSession();
      this.dispatch({
        t: 'notice',
        text: `载入失败：Hermes 里找不到会话 ${sessionId.slice(0, 8)}…（可能它建好后没跑过一轮对话，所以没落库）。已改为新建会话。`,
        level: 'error',
      });
      return;
    }
    await this.context.workspaceState.update(this.sessionKey(cwd), sessionId);
    this.dispatch({ t: 'session', sessionId, cwd, models: result.models, modes: result.modes });
    this.dispatch({ t: 'status', status: 'ready', text: '已载入历史会话' });
    // 成功路径也要留痕：之前这里不打日志，出问题时根本看不出点过没有
    this.log(`已载入会话 ${sessionId}`);
  }

  private async setModel(modelId: string): Promise<void> {
    const sessionId = this.state.meta.sessionId;
    if (!this.client || !sessionId || !modelId) {
      return;
    }
    await this.client.request('session/set_model', { sessionId, modelId }, 60_000);
    this.dispatch({ t: 'meta', patch: { modelId } });
    this.dispatch({ t: 'notice', text: `已切换模型：${modelId}` });
  }

  private async setMode(modeId: string): Promise<void> {
    const sessionId = this.state.meta.sessionId;
    if (!this.client || !sessionId || !modeId) {
      return;
    }
    await this.client.request('session/set_mode', { sessionId, modeId }, 60_000);
    this.dispatch({ t: 'meta', patch: { modeId } });
    const name = this.state.meta.modes?.find((m) => m.id === modeId)?.name || modeId;
    this.dispatch({ t: 'notice', text: `审批模式：${name}` });
  }

  /**
   * 本会话目标（面板侧备忘）。
   *
   * ⚠️ 这不是 Hermes 的 `/goal`。Hermes 的 `/goal` 是 Ralph 循环：目标存在
   * `state_meta` 里、由裁判模型判定是否继续、每轮自动续跑 —— 那套只实现在
   * **CLI 层**（`hermes_cli/goal_command.py` + `_maybe_continue_goal_after_turn`），
   * ACP 通道没有暴露（ACP 只推 9 条斜杠命令，里面没有 /goal）。
   * 这里做到的是「每轮都带上这个目标」，本质是提示词层。
   */
  private goal = '';
  /** 计划模式：同样只改提示词，不改 agent 行为 */
  private planMode = false;

  private wrapPrompt(text: string): string {
    const parts: string[] = [];
    if (this.planMode) {
      parts.push('【计划模式】只给出计划（步骤、涉及文件、风险），不要修改任何文件；等我确认后再执行。');
    }
    if (this.goal) {
      parts.push(`【本会话目标】${this.goal}`);
    }
    return parts.length ? `${parts.join('\n')}\n\n${text}` : text;
  }

  private postRaw(msg: JsonObject): void {
    if (this.view) {
      void this.view.webview.postMessage(msg as unknown as WebviewOp);
    }
  }

  private async pushScratchState(): Promise<void> {
    this.postRaw({ type: 'scratch', goal: this.goal, planMode: this.planMode });
  }

  /** 「文件和文件夹」：一个入口同时选文件或目录（VS Code 允许两者都开） */
  private async pickFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: '添加到对话',
      title: '选择要交给 Hermes 的文件或文件夹（路径会插进输入框）',
    });
    if (!picked || !picked.length) {
      return;
    }
    const text = picked.map((uri) => uri.fsPath).join('\n');
    this.postRaw({ type: 'insertText', text: text + '\n' });
    this.log(`已添加 ${picked.length} 个路径到输入框`);
  }

  private async setGoal(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: '本会话目标',
      prompt: '每一轮都会带上它（面板侧实现，不是 Hermes 的 /goal 自动续跑）',
      value: this.goal,
      placeHolder: '例：把 KickPi 上的 LVGL 界面跑起来',
    });
    if (value === undefined) {
      return;
    }
    this.goal = value.trim();
    await this.context.workspaceState.update('hermesPanel.goal', this.goal);
    await this.pushScratchState();
    this.dispatch({
      t: 'notice',
      text: this.goal ? `本会话目标已设置：${this.goal}` : '已清除本会话目标',
    });
  }

  private async togglePlanMode(): Promise<void> {
    this.planMode = !this.planMode;
    await this.context.workspaceState.update('hermesPanel.planMode', this.planMode);
    await this.pushScratchState();
    this.dispatch({
      t: 'notice',
      text: this.planMode ? '计划模式已开启：只出计划、不改文件' : '计划模式已关闭',
    });
  }

  /** 手绘草图落盘，然后把路径插进输入框（agent 能直接读这个 png） */
  private async saveSketch(dataUrl: string): Promise<void> {
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
    if (!match) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const dir = folder
      ? vscode.Uri.joinPath(folder, '.hermes-sketch')
      : vscode.Uri.joinPath(this.context.globalStorageUri, 'sketch');
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, `草图-${Date.now()}.png`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(match[1], 'base64'));
    this.postRaw({ type: 'insertText', text: file.fsPath + '\n' });
    this.dispatch({ t: 'notice', text: `草图已保存：${file.fsPath}` });
  }

  /**
   * 技能根目录。优先 HERMES_HOME；没设就从 hermes 可执行文件反推
   * （`<home>/bin/hermes` → `<home>`）；最后兜底 `~/.hermes`。
   * 全都不存在就返回空 —— 菜单会明说找不到，而不是列一堆假名字。
   */
  private skillRoots(): { dir: string; tag: string }[] {
    const candidates: string[] = [];
    if (process.env.HERMES_HOME) {
      candidates.push(process.env.HERMES_HOME);
    }
    try {
      const resolved = resolveExecutable('hermes', defaultSearchDirs());
      if (resolved?.file) {
        // `<home>/bin/hermes` → `<home>`
        candidates.push(path.resolve(path.dirname(resolved.file), '..'));
      }
    } catch {
      // 反推失败就靠下面的兜底
    }
    candidates.push(path.resolve(os.homedir(), '.hermes'));

    for (const home of candidates) {
      const roots = [
        { dir: path.join(home, 'skills'), tag: '本地' },
        { dir: path.join(home, 'hermes-agent', 'skills'), tag: '内置' },
      ].filter((r) => {
        try {
          return fs.statSync(r.dir).isDirectory();
        } catch {
          return false;
        }
      });
      if (roots.length) {
        return roots;
      }
    }
    return [];
  }

  /** 扫**真实安装的**技能（读 SKILL.md 的 frontmatter），不硬编码任何技能名 */
  private discoverSkills(): { name: string; description: string; tag: string }[] {
    const out: { name: string; description: string; tag: string }[] = [];
    const seen = new Set<string>();
    for (const root of this.skillRoots()) {
      const stack: { dir: string; depth: number }[] = [{ dir: root.dir, depth: 0 }];
      while (stack.length) {
        const cur = stack.pop() as { dir: string; depth: number };
        if (cur.depth > 3) {
          continue;
        }
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(cur.dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = path.join(cur.dir, entry.name);
          if (entry.isDirectory()) {
            stack.push({ dir: full, depth: cur.depth + 1 });
            continue;
          }
          if (entry.name !== 'SKILL.md') {
            continue;
          }
          const name = path.basename(cur.dir);
          if (seen.has(name)) {
            continue;
          }
          seen.add(name);
          let description = '';
          try {
            const head = fs.readFileSync(full, 'utf8').slice(0, 1200);
            const m = /^description:\s*(.+)$/m.exec(head);
            description = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
          } catch {
            // 读不到就当没描述，不影响列出名字
          }
          out.push({ name, description, tag: root.tag });
        }
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * 「技能」：用 VS Code 原生 quick pick。
   * 这台机器上真实技能有 170+ 个，塞进 webview 弹层是灾难；原生那个能模糊搜索。
   */
  private async pickSkill(): Promise<void> {
    const skills = this.discoverSkills();
    if (!skills.length) {
      this.dispatch({
        t: 'notice',
        text: `没找到技能目录（找过 HERMES_HOME、hermes 同级目录、${path.resolve(
          os.homedir(),
          '.hermes'
        )}）`,
        level: 'error',
      });
      return;
    }
    const picked = await vscode.window.showQuickPick(
      skills.map((s) => ({
        label: s.name,
        description: s.description,
        detail: s.tag === '内置' ? '内置技能' : '本地技能',
      })),
      {
        title: `选择技能（共 ${skills.length} 个）`,
        placeHolder: '输入关键字筛选名称或描述',
        matchOnDescription: true,
      }
    );
    if (!picked) {
      return;
    }
    this.postRaw({ type: 'insertHint', text: `用 ${picked.label} 技能：` });
    this.log(`已把技能「${picked.label}」写进输入框`);
  }

  public async sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    await this.ensureConnection().catch(() => undefined);
    const client = this.client;
    if (!client) {
      this.dispatch({ t: 'notice', text: 'Hermes 未连接，无法发送。', level: 'error' });
      return;
    }
    let sessionId = this.state.meta.sessionId;
    if (!sessionId) {
      await this.newSession();
      sessionId = this.state.meta.sessionId;
    }
    if (!sessionId) {
      return;
    }

    this.dispatch({ t: 'user', text: trimmed });
    // 面板侧的「目标 / 计划模式」是**提示词层**实现：界面上显示用户的原话，
    // 真正发出去的才带前缀 —— 免得对话流里冒出一堆自己加的话。
    const outgoing = this.wrapPrompt(trimmed);
    this.dispatch({ t: 'status', status: 'running' });
    if (this.view) {
      void this.view.webview.postMessage({ type: 'busy', running: true } as unknown as WebviewOp);
    }

    const client_ = client;
    this.running = true;
    try {
      this.turnChunks = 0;
      let result = await client_.request<JsonObject>(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: outgoing }] },
        0 // 交给用户自己中断；prompt 可能跑很久
      );

      // 会话在 Hermes 侧失效时，prompt 不报错，只回一个「空手而归」的 refusal。
      // 这里自愈一次：确认会话真的没了 → 新建 → 重发。
      if (looksLikeStaleSession(result.stopReason, this.turnChunks)) {
        this.log(`回合以 refusal 结束且没有任何回复内容，疑似会话 ${sessionId} 已失效`);
        const retryId = await this.recoverStaleSession();
        if (retryId) {
          this.log(`已在会话 ${retryId} 上重试本次提问`);
          this.turnChunks = 0;
          result = await client_.request<JsonObject>(
            'session/prompt',
            { sessionId: retryId, prompt: [{ type: 'text', text: outgoing }] },
            0
          );
        }
      }

      this.dispatch({ t: 'turn-end', stopReason: result.stopReason });
      if (result.usage) {
        this.log(
          `回合结束：${result.stopReason}，tokens=${result.usage.totalTokens ?? '?'}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatch({ t: 'status', status: 'error', text: '回合失败' });
      this.dispatch({ t: 'notice', text: `回合失败：${message}`, level: 'error' });
    } finally {
      this.running = false;
      if (this.view) {
        void this.view.webview.postMessage({ type: 'busy', running: false } as unknown as WebviewOp);
      }
    }
  }

  /**
   * 会话失效后的自愈。
   *
   * 返回可重试的 sessionId；返回 undefined 表示「不该重试」。
   *
   * 用 `session/list` 而不是 `session/load` 来确认会话是否还在 —— 因为 load
   * 对**存活**的会话会把历史重放一遍，等于往当前面板里灌一份重复的对话记录。
   * list 是只读的，没有这个副作用。
   */
  private async recoverStaleSession(): Promise<string | undefined> {
    const client = this.client;
    const cwd = this.workspaceCwd();
    const stale = this.state.meta.sessionId;
    if (!client || !stale) {
      return undefined;
    }
    try {
      const listed = await client.request<JsonObject>('session/list', { cwd }, 30_000);
      const stillThere = (listed.sessions || []).some((s: JsonObject) => s.sessionId === stale);
      if (stillThere) {
        // 会话还在，说明 refusal 是别的缘故（比如 provider 拒绝），不要乱建新会话
        this.log(`会话 ${stale} 仍在列表中，refusal 另有原因，不重试`);
        return undefined;
      }
    } catch (err) {
      this.log(`确认会话是否存活时出错：${err instanceof Error ? err.message : String(err)}`);
    }
    this.log(`会话 ${stale} 已失效，自动新建后重试`);
    await this.createNewSession();
    this.dispatch({
      t: 'notice',
      text: '刚才那个会话在 Hermes 里已经不存在了（通常是它建好后没跑过一轮对话，因此没落库）。已自动新建会话并重试。',
    });
    return this.state.meta.sessionId;
  }

  // ────────────────────────────── 编辑器上下文 ──────────────────────────────

  /** 把「当前文件 / 选中代码」拼成一段可直接发给 agent 的文本 */
  public async buildContextBlock(withFence: boolean): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const doc = editor.document;
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    const lang = doc.languageId;
    const code = hasSelection ? doc.getText(selection) : doc.getText();
    if (!code.trim()) {
      return undefined;
    }
    const from = hasSelection ? selection.start.line + 1 : 1;
    const to = hasSelection ? selection.end.line + 1 : doc.lineCount;
    const head = hasSelection
      ? `文件 \`${rel}\`（第 ${from}-${to} 行，共 ${to - from + 1} 行）`
      : `文件 \`${rel}\`（完整内容，共 ${doc.lineCount} 行）`;
    const body = withFence ? `\n\n\`\`\`${lang}\n${code}\n\`\`\`` : `\n\n${code}`;
    return head + body;
  }

  /** 右键菜单命令：把代码 + 指令一起发出去 */
  public async askWithContext(instruction: string, useSelectionOnly: boolean): Promise<void> {
    const block = await this.buildContextBlock(true);
    if (!block) {
      void vscode.window.showWarningMessage('Hermes：请先打开一个文件（或选中一段代码）。');
      return;
    }
    const mode = useSelectionOnly ? '（仅选中部分）' : '';
    const prompt = `${instruction}${mode}\n${block}`;
    await vscode.commands.executeCommand(`${HermesPanelProvider.viewType}.focus`);
    await this.sendPrompt(prompt);
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get transcriptText(): string {
    return this.state.items.map((item) => item.text || item.title || '').join('\n');
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
