/**
 * ACP (Agent Client Protocol) 客户端 —— 纯 Node，不依赖 vscode。
 *
 * 与 `hermes acp` 子进程通过 stdio 说 JSON-RPC 2.0：
 *   - 发送：每行一个 JSON 对象（NDJSON）
 *   - 接收：健壮地做括号配平扫描，兼容紧凑单行与美化多行两种输出
 *
 * 这个模块刻意不 import 'vscode'，这样可以在 Node 里直接对真实的
 * `hermes acp` 做端到端测试（见 test/test-acp-live.js）。
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface JsonObject {
  [key: string]: any;
}

export interface AcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** agent -> client 的通知（method === 'session/update'） */
  onUpdate: (params: JsonObject) => void;
  /** agent -> client 的请求，必须回一个 result 对象（或抛错） */
  onRequest: (method: string, params: JsonObject, id: number | string) => Promise<JsonObject>;
  onLog?: (line: string) => void;
  onExit?: (info: AcpExitInfo) => void;
}

/**
 * 从流式缓冲区里取出完整的 JSON 对象。
 *
 * 为什么不用「按 \n split」：Hermes 当前输出是紧凑单行，但协议没规定
 * 必须如此；一旦对方换上 pretty-print，按行切就会碎成一堆半截 JSON。
 * 所以这里按字符做括号配平 + 字符串/转义状态跟踪。
 *
 * 返回已解析的对象数组，以及尚未完整的残余缓冲。
 */
export function extractJsonObjects(buffer: string): { objects: JsonObject[]; rest: string } {
  const objects: JsonObject[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastComplete = -1;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];

    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const slice = buffer.slice(start, i + 1);
        try {
          objects.push(JSON.parse(slice));
          lastComplete = i;
        } catch {
          // 不是合法 JSON：丢弃这一段，继续往后找
        }
        start = -1;
      } else if (depth < 0) {
        start = -1;
        depth = 0;
      }
    }
  }

  if (lastComplete >= 0 && start < 0) {
    return { objects, rest: buffer.slice(lastComplete + 1) };
  }
  return { objects, rest: start >= 0 ? buffer.slice(start) : '' };
}

/**
 * 在 PATH（以及若干常见安装位置）里找可执行文件。
 *
 * Windows 上 Node 的 spawn 用 CreateProcess，只认 .exe，不会像 shell 那样
 * 去解析 .cmd/.bat —— 所以这里显式枚举 PATHEXT 候选，并把 .cmd/.bat 的
 * 情况标记出来交给调用方决定是否走 shell。
 */
export interface ResolvedExecutable {
  /** 可直接交给 spawn 的文件路径（.cmd/.bat 时需要 shell） */
  file: string;
  /** true 表示必须通过 shell 启动（.cmd/.bat） */
  needsShell: boolean;
}

export function resolveExecutable(
  command: string,
  extraDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): ResolvedExecutable | null {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  const hasPathSeparator = /[\\/]/.test(command);
  const dirs = hasPathSeparator
    ? [path.dirname(command)]
    : [...(env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs];
  const base = hasPathSeparator ? path.basename(command) : command;

  const candidates: string[] = [];
  for (const dir of dirs) {
    const alreadyExt = path.extname(base) !== '';
    if (alreadyExt) {
      candidates.push(path.join(dir, base));
    } else {
      for (const ext of exts) {
        candidates.push(path.join(dir, base + ext.toLowerCase()));
        candidates.push(path.join(dir, base + ext));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const st = fs.statSync(candidate);
      if (!st.isFile()) {
        continue;
      }
      const ext = path.extname(candidate).toLowerCase();
      return { file: candidate, needsShell: (ext === '.cmd' || ext === '.bat') && isWin };
    } catch {
      // 权限/竞态问题：跳过这个候选
    }
  }
  return null;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
}

export class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<number | string, Pending>();
  private nextId = 1;
  private expectedExit = false;

  constructor(private readonly opts: AcpClientOptions) {}

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  start(): void {
    if (this.proc) {
      return;
    }
    const resolved = resolveExecutable(this.opts.command, defaultSearchDirs());
    if (!resolved) {
      throw new Error(
        `找不到 Hermes 可执行文件「${this.opts.command}」。请确认已安装 Hermes，` +
          `或在设置 hermesPanel.command 里写明完整路径（如 C:\\Users\\you\\AppData\\Roaming\\hermes\\bin\\hermes.exe）。`
      );
    }

    const spawnOpts = {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env || {}) },
      windowsHide: true,
    };

    this.proc = resolved.needsShell
      ? (spawn(`"${resolved.file}"`, this.opts.args, { ...spawnOpts, shell: true }) as ChildProcessWithoutNullStreams)
      : (spawn(resolved.file, this.opts.args, spawnOpts) as ChildProcessWithoutNullStreams);

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => this.emitLog(chunk));

    this.proc.on('error', (err) => {
      this.emitLog(`[启动失败] ${err.message}`);
      this.failAll(err);
    });

    this.proc.on('exit', (code, signal) => {
      const info: AcpExitInfo = { code, signal, expected: this.expectedExit };
      this.proc = null;
      this.failAll(new Error(`Hermes 进程已退出（code=${code}, signal=${signal}）`));
      this.opts.onExit?.(info);
    });
  }

  private emitLog(text: string): void {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed) {
      this.opts.onLog?.(trimmed);
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const { objects, rest } = extractJsonObjects(this.buffer);
    this.buffer = rest;
    for (const msg of objects) {
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonObject): void {
    // 1) agent 对我们请求的应答
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.emitLog(`[收到未知应答 id=${msg.id}]`);
        return;
      }
      this.pending.delete(msg.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (msg.error) {
        const err: any = new Error(msg.error.message || 'ACP 请求失败');
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 2) agent -> client 的请求：必须回包，否则对面会一直挂着
    if (msg.id !== undefined && msg.method) {
      Promise.resolve()
        .then(() => this.opts.onRequest(msg.method, msg.params || {}, msg.id))
        .then(
          (result) => this.respond(msg.id, result),
          (err) => this.respondError(msg.id, -32603, err instanceof Error ? err.message : String(err))
        );
      return;
    }

    // 3) 通知
    if (msg.method === 'session/update') {
      this.opts.onUpdate(msg.params || {});
      return;
    }
    if (msg.method) {
      this.emitLog(`[未处理的通知] ${msg.method}`);
    }
  }

  request<T = JsonObject>(method: string, params: JsonObject, timeoutMs = 60_000): Promise<T> {
    if (!this.proc) {
      return Promise.reject(new Error('Hermes 进程尚未启动'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve, reject, method };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP 请求超时：${method}（${timeoutMs}ms）`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: number | string, result: JsonObject): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(msg: JsonObject): void {
    if (!this.proc) {
      throw new Error('Hermes 进程尚未启动');
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(err);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.expectedExit = true;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      try {
        proc.stdin.end();
      } catch {
        // 忽略：进程可能已经没了
      }
      // 给对面一点体面退场的时间，然后硬来
      const killer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // 已经退出
        }
      }, 1500);
      killer.unref?.();
    }
    this.failAll(new Error('ACP 连接已关闭'));
  }
}

/**
 * Hermes 在「会话不存在」时给出的失败信号是**空对象**，不是 null、也不是错误。
 *
 *   acp_adapter/server.py: load_session -> `return None`（会话不在内存也不在库里）
 *   但经过 ACP 框架序列化后，线上拿到的是 `{}`。
 *
 * 教训：`if (!result)` 挡不住它（`!{}` 是 false）。要么判「空对象」，要么判字段，
 * 别用真假值。成功的 load/resume 一定带 models / modes / _meta。
 */
export function isEmptyResult(
  result: unknown
): result is null | undefined | Record<string, never> {
  if (result === null || result === undefined) {
    return true;
  }
  if (typeof result !== 'object') {
    return false;
  }
  return Object.keys(result as Record<string, unknown>).length === 0;
}

/**
 * 一个回合是不是「空手而归」——疑似会话在 Hermes 侧已经失效。
 *
 * 背景（读 acp_adapter/server.py 得来，不是猜的）：
 *   - `session/prompt` 遇到未知 session_id 时**不报错**，而是返回
 *     `PromptResponse(stop_reason="refusal")`，且这一轮不会有任何 assistant 内容。
 *   - `refusal` 本身也是「provider 拒绝了请求」的合法 stop_reason，但那种情况
 *     至少会带一条 Hermes 自述的助手消息。
 * 所以判据是：refusal **且**整轮零条 agent_message_chunk。
 */
export function looksLikeStaleSession(stopReason: string | undefined, agentChunks: number): boolean {
  return stopReason === 'refusal' && agentChunks === 0;
}

/** Hermes 常见的几个安装位置，PATH 没配到时的兜底 */
export function defaultSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || env.HOME || '';
  const dirs = [
    path.join(home, 'AppData', 'Roaming', 'hermes', 'bin'),
    path.join(home, 'AppData', 'Local', 'Programs', 'hermes', 'bin'),
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.hermes', 'bin'),
  ];
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, 'hermes', 'bin'));
  }
  return dirs.filter(Boolean);
}
