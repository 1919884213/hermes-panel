/**
 * 会话记录状态机（纯模块，不依赖 vscode）。
 *
 * 输入：本地事件 + ACP 的 session/update 通知
 * 输出：一串「WebviewOp」增量操作 —— 扩展侧和 webview 侧消费的是同一串
 * 操作，所以不存在两套渲染逻辑对不齐的问题。
 *
 * 这里刻意只做数据变换，不碰 DOM、不碰 vscode API，方便在 Node 里单测。
 */
import { escapeHtml, renderMarkdown } from './markdown';
import { DiffResult, lineDiff, renderDiffHtml } from './diff';

export type ItemKind = 'user' | 'assistant' | 'thought' | 'tool' | 'approval' | 'notice' | 'error';
export type ItemStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface ItemView {
  id: string;
  kind: ItemKind;
  html?: string;
  text?: string;
  title?: string;
  subtitle?: string;
  status?: ItemStatus;
  toolKind?: string;
  locations?: string[];
  bodyHtml?: string;
  collapsed?: boolean;
  /** 思考块是否还在生成中（用来在折叠态显示「思考中…」） */
  thinking?: boolean;
  /** 正文字符数：折叠时得让人知道里面有多少东西，否则就是一个没信息量的胶囊 */
  chars?: number;
  options?: PermissionOption[];
  requestId?: number;
  resolvedOptionId?: string;
  diff?: { path: string; added: number; removed: number };
  ts: number;
}

export interface Meta {
  status: 'offline' | 'connecting' | 'ready' | 'running' | 'error';
  statusText: string;
  sessionId?: string;
  title?: string;
  cwd?: string;
  modelId?: string;
  models: { modelId: string; name: string; description?: string }[];
  /** Hermes 的审批模式（Default / Accept Edits / Don't Ask），对应 Codex 输入框里那个模式位 */
  modes?: { id: string; name: string; description?: string }[];
  modeId?: string;
  usage?: { used: number; size: number };
  commands: { name: string; description?: string }[];
  pendingApprovals: number;
}

export type WebviewOp =
  | { op: 'reset'; items: ItemView[]; meta: Meta }
  | { op: 'add'; item: ItemView }
  | { op: 'text'; id: string; html: string; chars?: number }
  | { op: 'update'; id: string; patch: Partial<ItemView> }
  | { op: 'meta'; meta: Meta };

export type TranscriptEvent =
  | { t: 'reset' }
  | { t: 'status'; status: Meta['status']; text?: string }
  | { t: 'user'; text: string }
  | { t: 'notice'; text: string; level?: 'info' | 'error' }
  | { t: 'update'; update: any }
  | { t: 'permission'; params: any; requestId: number | string }
  | { t: 'permission-resolved'; requestId: number | string; optionId?: string }
  | { t: 'turn-end'; stopReason?: string }
  | { t: 'session'; sessionId: string; cwd?: string; models?: any; modes?: any; commands?: any }
  | { t: 'meta'; patch: Partial<Meta> };

const TOOL_OUTPUT_CAP = 24_000;

interface InternalItem extends ItemView {
  /** 累积的原始文本（markdown 源） */
  raw?: string;
  /** 工具输出的累积纯文本 */
  bodyText?: string;
}

export interface TranscriptState {
  items: InternalItem[];
  index: Map<string, InternalItem>;
  /** toolCallId -> itemId，用来把后续 tool_call_update 贴回正确卡片 */
  toolCalls: Map<string, string>;
  meta: Meta;
  revision: number;
  maxItems: number;
}

export function createState(maxItems = 400): TranscriptState {
  return {
    items: [],
    index: new Map(),
    toolCalls: new Map(),
    meta: {
      status: 'offline',
      statusText: '未连接',
      models: [],
      commands: [],
      pendingApprovals: 0,
    },
    revision: 0,
    maxItems,
  };
}

export function snapshot(state: TranscriptState): WebviewOp {
  return {
    op: 'reset',
    items: state.items.map(toView),
    meta: { ...state.meta },
  };
}

/**
 * 回合结束：思考块标记为结束并收起。
 * 渲染层也会兜底（字段缺失即折叠），这里额外让**状态本身**也保持折叠这个事实，
 * 免得重新渲染（snapshot / 重载面板）时又冒出来。
 */
function settleThoughts(state: TranscriptState): WebviewOp[] {
  const ops: WebviewOp[] = [];
  for (const item of state.items) {
    if (item.kind !== 'thought') {
      continue;
    }
    const patch: Partial<ItemView> = {};
    if (item.thinking) {
      patch.thinking = false;
    }
    if (item.collapsed !== true) {
      patch.collapsed = true;
    }
    if (Object.keys(patch).length) {
      ops.push(...patchItem(state, item, patch));
    }
  }
  return ops;
}

function toView(item: InternalItem): ItemView {
  const { raw: _raw, bodyText: _bodyText, ...view } = item;
  // chars 是派生字段：折叠态要显示"里面有多少字"，而 raw 不往 webview 送
  return { ...view, chars: String(item.raw || '').length };
}

function addItem(state: TranscriptState, item: InternalItem): WebviewOp[] {
  state.items.push(item);
  state.index.set(item.id, item);
  state.revision++;

  const ops: WebviewOp[] = [{ op: 'add', item: toView(item) }];
  if (state.items.length > state.maxItems) {
    const dropped = state.items.splice(0, state.items.length - state.maxItems);
    for (const old of dropped) {
      state.index.delete(old.id);
      state.toolCalls.forEach((itemId, toolCallId) => {
        if (itemId === old.id) {
          state.toolCalls.delete(toolCallId);
        }
      });
    }
    ops.length = 0;
    ops.push(snapshot(state));
  }
  return ops;
}

function patchItem(state: TranscriptState, item: InternalItem, patch: Partial<ItemView>): WebviewOp[] {
  Object.assign(item, patch);
  state.revision++;
  return [{ op: 'update', id: item.id, patch }];
}

function metaOps(state: TranscriptState, patch: Partial<Meta>): WebviewOp[] {
  Object.assign(state.meta, patch);
  state.revision++;
  return [{ op: 'meta', meta: { ...state.meta } }];
}

function textToHtml(text: string): string {
  return renderMarkdown(text);
}

/** ACP 的 content 数组：text / content 包裹 / diff 三种形态 */
function readContentBlocks(content: any): { text: string; diffs: { path: string; oldText?: string; newText?: string }[] } {
  const texts: string[] = [];
  const diffs: { path: string; oldText?: string; newText?: string }[] = [];
  if (!Array.isArray(content)) {
    return { text: '', diffs };
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'diff') {
      diffs.push({ path: block.path || '', oldText: block.oldText, newText: block.newText });
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'content' && block.content) {
      const inner = block.content;
      if (inner.type === 'text' && typeof inner.text === 'string') {
        texts.push(inner.text);
      } else if (inner.type === 'diff') {
        diffs.push({ path: inner.path || '', oldText: inner.oldText, newText: inner.newText });
      } else if (inner.type === 'resource_link' || inner.type === 'resource') {
        texts.push(`[资源] ${inner.uri || inner.name || ''}`);
      }
    }
  }
  return { text: texts.join('\n'), diffs };
}

/** 工具回执里常见 `- **output:** xxx` 这种 markdown 列表。原样塞进 <pre> 会在界面上
 *  露出 `**output:**` 字样，看着像没渲染完。这里拆成整齐的键值行，其余仍走 <pre>。
 *  键名顺手本地化：界面上是中文，`exit_code` 这种内部字段名读起来很生硬。 */
const KV_LABELS: Record<string, string> = {
  output: '输出',
  stdout: '标准输出',
  stderr: '错误输出',
  exit_code: '退出码',
  command: '命令',
  files: '文件',
  path: '路径',
  duration: '耗时',
  result: '结果',
  error: '错误',
  status: '状态',
  lines: '行数',
  content: '内容',
};

export function splitKeyValueLines(text: string): { kv: [string, string][]; rest: string[] } {
  const kv: [string, string][] = [];
  const rest: string[] = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*[-*]\s+\*\*(.+?)\*\*\s*[：:]?\s*(.*)$/.exec(line);
    if (match) {
      kv.push([match[1].replace(/[：:]\s*$/, ''), match[2]]);
    } else {
      rest.push(line);
    }
  }
  return { kv, rest };
}

function toolBodyHtml(text: string, diffs: DiffResult[], diffPaths: string[]): string {
  const parts: string[] = [];
  const { kv, rest } = splitKeyValueLines(text);
  if (kv.length) {
    parts.push(
      `<div class="kv">${kv
        .map(
          ([k, v]) =>
            `<div class="k">${escapeHtml(KV_LABELS[k] || k)}</div><div class="v">${escapeHtml(v)}</div>`
        )
        .join('')}</div>`
    );
  }
  const body = rest.join('\n').trim();
  if (body) {
    parts.push(`<pre class="tool-out">${escapeHtml(body)}</pre>`);
  }
  diffs.forEach((result, i) => {
    parts.push(
      `<div class="tool-diff"><div class="diff-head"><span class="path">${escapeHtml(diffPaths[i] || '')}</span>` +
        `<span class="diff-stat"><span class="d-add-stat">+${result.added}</span> ` +
        `<span class="d-del-stat">-${result.removed}</span></span></div>` +
        `<div class="diff-body">${renderDiffHtml(result, escapeHtml)}</div></div>`
    );
  });
  return parts.join('');
}

function mergeDiffs(existing: { diffs: DiffResult[]; paths: string[] }, found: { path: string; oldText?: string; newText?: string }[]) {
  for (const d of found) {
    existing.diffs.push(lineDiff(d.oldText ?? '', d.newText ?? ''));
    existing.paths.push(d.path);
  }
}

function statusFromAcp(status: string | undefined): ItemStatus | undefined {
  if (!status) {
    return undefined;
  }
  if (status === 'pending') {
    return 'pending';
  }
  if (status === 'in_progress') {
    return 'running';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'running';
}

export function reduce(state: TranscriptState, event: TranscriptEvent): WebviewOp[] {
  switch (event.t) {
    case 'reset': {
      state.items = [];
      state.index = new Map();
      state.toolCalls = new Map();
      state.meta = { status: state.meta.status, statusText: state.meta.statusText, models: [], commands: [], pendingApprovals: 0 };
      return [snapshot(state)];
    }

    case 'status': {
      return metaOps(state, { status: event.status, statusText: event.text ?? statusText(event.status) });
    }

    case 'meta': {
      return metaOps(state, event.patch);
    }

    case 'user': {
      const item: InternalItem = {
        id: `user:${state.revision}:${Date.now()}`,
        kind: 'user',
        text: event.text,
        html: escapeHtml(event.text).replace(/\n/g, '<br>'),
        ts: Date.now(),
      };
      return addItem(state, item);
    }

    case 'notice': {
      const item: InternalItem = {
        id: `notice:${state.revision}:${Date.now()}`,
        kind: event.level === 'error' ? 'error' : 'notice',
        text: event.text,
        html: `<p>${escapeHtml(event.text)}</p>`,
        ts: Date.now(),
      };
      return addItem(state, item);
    }

    case 'session': {
      const models = event.models?.availableModels;
      const patch: Partial<Meta> = {
        sessionId: event.sessionId,
        cwd: event.cwd,
        modelId: event.models?.currentModelId ?? state.meta.modelId,
      };
      if (Array.isArray(models)) {
        patch.models = models.map((m: any) => ({
          modelId: m.modelId,
          name: m.name || m.modelId,
          description: m.description,
        }));
      }
      if (event.modes !== undefined) {
        const available = event.modes?.availableModes;
        if (Array.isArray(available)) {
          patch.modes = available.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            description: m.description,
          }));
        }
        if (event.modes?.currentModeId) {
          patch.modeId = event.modes.currentModeId;
        }
      }
      if (Array.isArray(event.commands)) {
        patch.commands = event.commands.map((c: any) => ({ name: c.name, description: c.description }));
      }
      return metaOps(state, patch);
    }

    case 'turn-end': {
      const done = event.stopReason && event.stopReason !== 'end_turn' ? `（${event.stopReason}）` : '';
      return [
        ...metaOps(state, { status: 'ready', statusText: `就绪${done}` }),
        ...markRunningTools(state),
        // 回合结束必须把思考块收回去：用户中途展开过也不能例外，
        // 否则"默认折叠"会变成"这次折叠、下次看心情"。
        ...settleThoughts(state),
      ];
    }

    case 'permission': {
      const params = event.params || {};
      const toolCall = params.toolCall || {};
      const toolCallId: string = toolCall.toolCallId || `approval-${event.requestId}`;
      const { text, diffs } = readContentBlocks(toolCall.content);
      const parsed = diffs.map((d) => ({ result: lineDiff(d.oldText ?? '', d.newText ?? ''), path: d.path }));
      const isEdit = (toolCall.kind || '') === 'edit' || parsed.length > 0;
      const canAlways = Array.isArray(params.options)
        ? params.options.some((o: any) => o.kind === 'allow_always')
        : false;

      const item: InternalItem = {
        id: `approval:${toolCallId}`,
        kind: 'approval',
        title: toolCall.title || (isEdit ? '请求修改文件' : '请求执行操作'),
        subtitle: text.split('\n')[0] || '',
        status: 'pending',
        toolKind: toolCall.kind || 'other',
        locations: (toolCall.locations || []).map((l: any) => l.path).filter(Boolean),
        options: Array.isArray(params.options) ? params.options : [],
        requestId: event.requestId as any,
        collapsed: false,
        ts: Date.now(),
      };
      if (parsed.length) {
        item.diff = { path: parsed[0].path, added: parsed[0].result.added, removed: parsed[0].result.removed };
        item.bodyHtml = toolBodyHtml('', parsed.map((p) => p.result), parsed.map((p) => p.path));
      } else if (text.trim()) {
        item.bodyHtml = toolBodyHtml(text, [], []);
      }
      if (!canAlways) {
        item.subtitle = item.subtitle || '（无「总是允许」选项）';
      }
      state.toolCalls.set(toolCallId, item.id);
      const ops = addItem(state, item);
      return [...ops, ...metaOps(state, { pendingApprovals: countPending(state) })];
    }

    case 'permission-resolved': {
      const item = findApproval(state, event.requestId);
      if (!item) {
        return [];
      }
      return [
        ...patchItem(state, item, {
          status: event.optionId && event.optionId.startsWith('reject') ? 'failed' : 'completed',
          resolvedOptionId: event.optionId,
          collapsed: true,
        }),
        ...metaOps(state, { pendingApprovals: countPending(state) }),
      ];
    }

    case 'update': {
      return reduceUpdate(state, event.update || {});
    }

    default:
      return [];
  }
}

function statusText(status: Meta['status']): string {
  switch (status) {
    case 'offline':
      return '未连接';
    case 'connecting':
      return '正在连接 Hermes…';
    case 'running':
      return 'Hermes 正在处理…';
    case 'error':
      return '出错';
    default:
      return '就绪';
  }
}

function countPending(state: TranscriptState): number {
  let count = 0;
  for (const item of state.items) {
    if (item.kind === 'approval' && item.status === 'pending') {
      count++;
    }
  }
  return count;
}

function findApproval(state: TranscriptState, requestId: number | string): InternalItem | undefined {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind === 'approval' && String(item.requestId) === String(requestId)) {
      return item;
    }
  }
  return undefined;
}

/** 回合结束时，把还挂在「进行中」的工具卡片收尾 */
function markRunningTools(state: TranscriptState): WebviewOp[] {
  const ops: WebviewOp[] = [];
  for (const item of state.items) {
    if (item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')) {
      ops.push(...patchItem(state, item, { status: 'completed' }));
    }
  }
  return ops;
}

function reduceUpdate(state: TranscriptState, update: any): WebviewOp[] {
  const kind = update.sessionUpdate;

  switch (kind) {
    case 'user_message_chunk': {
      const text = update.content?.text ?? '';
      const id = `msg:${update.messageId || 'user'}`;
      const existing = state.index.get(id);
      if (existing) {
        existing.raw = (existing.raw || '') + text;
        existing.html = escapeHtml(existing.raw).replace(/\n/g, '<br>');
        state.revision++;
        return [{ op: 'text', id, html: existing.html, chars: String(existing.raw || '').length }];
      }
      const item: InternalItem = {
        id,
        kind: 'user',
        raw: text,
        html: escapeHtml(text).replace(/\n/g, '<br>'),
        ts: Date.now(),
      };
      return addItem(state, item);
    }

    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = update.content?.text ?? '';
      const isThought = kind === 'agent_thought_chunk';
      const id = `${isThought ? 'thought' : 'msg'}:${update.messageId || state.revision}`;
      let item = state.index.get(id);
      if (!item) {
        item = {
          id,
          kind: isThought ? 'thought' : 'assistant',
          title: isThought ? '思考过程' : undefined,
          collapsed: isThought,
          thinking: isThought,
          raw: '',
          ts: Date.now(),
        };
        const ops = addItem(state, item);
        // 首块也要走一次 text op，否则 webview 里是空壳
        item.raw = text;
        item.html = textToHtml(text);
        state.revision++;
        return [...ops, { op: 'text', id, html: item.html, chars: String(item.raw || '').length }];
      }
      item.raw = (item.raw || '') + text;
      item.html = textToHtml(item.raw);
      state.revision++;
      return [{ op: 'text', id, html: item.html, chars: String(item.raw || '').length }];
    }

    case 'tool_call':
    case 'tool_call_update': {
      const toolCallId: string = update.toolCallId || `tool-${state.revision}`;
      const mappedId = state.toolCalls.get(toolCallId);
      let item = mappedId ? state.index.get(mappedId) : undefined;

      if (!item) {
        // 对未知 toolCallId 的「纯进度」更新（没有标题、没有内容、没有类型）
        // 不该凭空造一张卡片：那通常是审批伪调用（如 edit-approval-1）的收尾，
        // 或者是已被裁剪掉的旧卡片的迟到更新。
        const hasSubstance = !!(update.title || update.kind || (update.content && update.content.length) || (update.locations && update.locations.length));
        if (kind === 'tool_call_update' && !hasSubstance) {
          return [];
        }
        item = {
          id: `tool:${toolCallId}`,
          kind: 'tool',
          title: update.title || toolCallId,
          toolKind: update.kind || 'other',
          status: kind === 'tool_call' ? 'running' : statusFromAcp(update.status) || 'running',
          locations: (update.locations || []).map((l: any) => l.path).filter(Boolean),
          collapsed: false,
          bodyText: '',
          ts: Date.now(),
        };
        state.toolCalls.set(toolCallId, item.id);
        const ops = addItem(state, item);
        applyToolContent(item, update);
        if (item.bodyHtml || item.title) {
          ops.push({ op: 'update', id: item.id, patch: { ...toView(item) } as Partial<ItemView> });
        }
        return ops;
      }

      applyToolContent(item, update);
      const patch: Partial<ItemView> = {};
      if (update.title) {
        patch.title = update.title;
      }
      if (update.kind) {
        patch.toolKind = update.kind;
      }
      if (update.status) {
        patch.status = statusFromAcp(update.status);
      } else if (kind === 'tool_call') {
        patch.status = 'running';
      }
      if (update.locations) {
        const paths = (update.locations || []).map((l: any) => l.path).filter(Boolean);
        if (paths.length) {
          patch.locations = paths;
        }
      }
      if (item.bodyHtml !== undefined) {
        patch.bodyHtml = item.bodyHtml;
      }
      if (item.diff) {
        patch.diff = item.diff;
      }
      const ops = patchItem(state, item, patch);
      // 审批卡的终态可能是 agent 自己推过来的（收尾的 tool_call_update），
      // 这时待审批计数也必须跟着回落，否则角标会一直挂着。
      if (item.kind === 'approval') {
        ops.push(...metaOps(state, { pendingApprovals: countPending(state) }));
      }
      return ops;
    }

    case 'agent_plan_update': {
      const entries = (update.entries || update.plan || []) as any[];
      const lines = entries.map((e: any) => `- [${e.status || 'pending'}] ${e.content || e.title || ''}`);
      const item: InternalItem = {
        id: `plan:${state.revision}:${Date.now()}`,
        kind: 'notice',
        title: '计划',
        html: renderMarkdown(lines.join('\n')),
        ts: Date.now(),
      };
      return addItem(state, item);
    }

    case 'available_commands_update': {
      const commands = (update.availableCommands || []).map((c: any) => ({
        name: c.name,
        description: c.description,
      }));
      return metaOps(state, { commands });
    }

    case 'usage_update': {
      if (typeof update.used === 'number') {
        return metaOps(state, { usage: { used: update.used, size: update.size ?? state.meta.usage?.size ?? 0 } });
      }
      return [];
    }

    case 'session_info_update': {
      const patch: Partial<Meta> = {};
      if (update.title) {
        patch.title = String(update.title);
      }
      const provenance = update._meta?.hermes?.sessionProvenance;
      if (provenance?.acpSessionId) {
        patch.sessionId = provenance.acpSessionId;
      }
      if (update.updatedAt) {
        // 保留字段，当前 UI 只展示标题
      }
      return Object.keys(patch).length ? metaOps(state, patch) : [];
    }

    case 'current_mode_update':
    case 'config_option_update':
      return [];

    default:
      return [];
  }
}

function applyToolContent(item: InternalItem, update: any): void {
  const { text, diffs } = readContentBlocks(update.content);
  if (text) {
    item.bodyText = ((item.bodyText || '') + (item.bodyText ? '\n' : '') + text).slice(-TOOL_OUTPUT_CAP);
  }
  const collected: DiffResult[] = [];
  const paths: string[] = [];
  if (diffs.length) {
    mergeDiffs({ diffs: collected, paths }, diffs);
    item.diff = {
      path: collected[0] ? diffs[0].path : item.diff?.path || '',
      added: (item.diff?.added || 0) + collected.reduce((sum, d) => sum + d.added, 0),
      removed: (item.diff?.removed || 0) + collected.reduce((sum, d) => sum + d.removed, 0),
    };
  }
  if (item.bodyText || collected.length) {
    item.bodyHtml = toolBodyHtml(item.bodyText || '', collected, paths);
  }
}
