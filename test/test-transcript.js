'use strict';
/**
 * 状态机测试 —— 喂的是**真实抓取的 ACP 报文**
 * （test/fixtures/*.json 由探测脚本从 `hermes acp` 的线上流量按真实时序导出），
 * 不是手写的理想化假数据。
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, includes, section, finish } = require('./lib');
const { createState, reduce, snapshot } = require('../out/transcript.js');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

/** 按抓包时序回放：update 与 permission 交错发生，顺序不能打乱 */
function replay(state, fixture, ops) {
  const seen = { perm: 0 };
  for (const event of fixture.events || []) {
    if (event.kind === 'update') {
      ops.push(...reduce(state, { t: 'update', update: event.data }));
    } else if (event.kind === 'permission') {
      seen.perm += 1;
      ops.push(...reduce(state, { t: 'permission', params: event.data, requestId: `perm-${seen.perm}` }));
    }
  }
  return seen;
}

function kindOf(state, kind) {
  return state.items.filter((i) => i.kind === kind);
}

section('回放真实报文：只读 + 搜索工具');
{
  const fixture = loadFixture('wire-read.json');
  const state = createState();
  const ops = [];
  reduce(state, { t: 'user', text: '用 read_file 读前 3 行' });
  replay(state, fixture, ops);

  ok(state.items.length > 0, `产生了 ${state.items.length} 个条目`);
  eq(kindOf(state, 'user').length, 1, '用户消息被本地记录');
  ok(kindOf(state, 'assistant').length >= 1, '至少有 1 条助手回复');
  ok(kindOf(state, 'thought').length >= 1, '思考过程被单独归类');
  eq(kindOf(state, 'thought')[0].collapsed, true, '思考过程默认折叠');

  const tools = kindOf(state, 'tool');
  eq(tools.length, 2, '两个工具调用（search_files / read_file），没有幻影卡片');
  ok(
    tools.every((t) => t.status === 'completed'),
    '两个工具都收敛到 completed'
  );
  const search = tools.find((t) => t.toolKind === 'search');
  ok(!!search, '识别出 search 类工具');
  includes(search.bodyHtml, 'Found 1 file', '搜索输出落到工具卡片里');
  ok(search.locations && search.locations.length > 0, '工具卡片带上文件位置');

  const assistant = kindOf(state, 'assistant')[0];
  ok(assistant.html && assistant.html.length > 0, '助手消息渲染出了 HTML');
  includes(assistant.html, 'acp_probe.py', '回复内容里包含被读取的文件名');

  eq(state.meta.usage.size, 1000000, '上下文上限来自 usage_update');
  ok(state.meta.commands.length > 3, `斜杠命令清单被记录（${state.meta.commands.length} 条）`);
  ok(!!state.meta.sessionId, '会话 ID 从 session_info_update 的 provenance 里拿到');
  ok(!!state.meta.title, '会话标题被记录');

  const shapes = new Set(ops.map((o) => o.op));
  ok(shapes.has('add'), '产生过 add op');
  ok(shapes.has('text'), '产生过 text op（流式追加）');
  ok(shapes.has('update'), '产生过 update op（工具状态推进）');
  ok(shapes.has('meta'), '产生过 meta op');
  ok(
    [...shapes].every((s) => ['reset', 'add', 'text', 'update', 'meta'].includes(s)),
    `op 种类全部合法：${[...shapes].join(', ')}`
  );
}

section('回放真实报文：写文件 + diff 审批卡');
{
  const fixture = loadFixture('wire-write.json');
  const state = createState();
  const ops = [];
  const seen = replay(state, fixture, ops);

  eq(seen.perm, 1, '夹具里含 1 条真实审批请求');

  const tools = kindOf(state, 'tool');
  eq(
    tools.map((t) => t.toolKind).sort(),
    ['edit', 'execute', 'read'],
    '三种工具各建一张卡片，且没有为审批伪调用生成幻影卡片'
  );

  const exec = tools.find((t) => t.toolKind === 'execute');
  includes(exec.bodyHtml, 'echo done', '终端工具卡片带命令原文');
  includes(exec.bodyHtml, '退出码', '终端回执的 exit_code 被本地化成「退出码」');
  eq(exec.status, 'completed', '终端工具收敛为 completed');

  const edit = tools.find((t) => t.toolKind === 'edit');
  eq(edit.status, 'completed', '写文件工具收敛为 completed');
  includes(edit.bodyHtml, 'write_file completed', '写文件工具的完成回执落在卡片里');

  // ── 审批卡：Codex 式体验的核心，diff 来自真实报文 ──
  const approvals = kindOf(state, 'approval');
  eq(approvals.length, 1, '生成 1 张审批卡');
  const card = approvals[0];
  eq(card.requestId, 'perm-1', '审批卡带上本地请求序号');
  eq(card.toolKind, 'edit', '审批卡知道这是 edit 类操作');
  eq(
    card.options.map((o) => o.kind),
    ['allow_once', 'reject_once'],
    '审批选项 kind 原样透传（UI 据此决定主/次按钮）'
  );
  includes(card.bodyHtml, 'd-add', '审批卡里渲染出 diff 高亮行');
  includes(card.bodyHtml, 'hello from acp', 'diff 显示待写入的真实内容');
  eq(card.diff.added, 1, '审批卡的 diff 统计：+1 行');
  eq(card.diff.removed, 0, '审批卡的 diff 统计：-0 行');
  eq(card.diff.path.endsWith('acp_write_test.txt'), true, '审批卡记录了目标文件路径');

  // 用户点「允许」后，Hermes 会紧接着把审批伪调用标记为完成
  eq(card.status, 'completed', '卡片最终收敛（不会永远挂在待确认）');
  eq(state.meta.pendingApprovals, 0, '没有残留的待审批计数');

  ok(
    ops.some((o) => o.op === 'update' && o.id === card.id && o.patch && o.patch.status),
    '审批卡的状态变化是通过 update op 增量下发的'
  );
}

section('审批的待确认计数（合成场景）');
{
  const state = createState();
  const params = loadFixture('wire-write.json').events.find((e) => e.kind === 'permission').data;
  reduce(state, { t: 'permission', params, requestId: 'perm-9' });
  const card = kindOf(state, 'approval')[0];
  eq(card.status, 'pending', '仅收到审批请求时卡片是待确认');
  eq(state.meta.pendingApprovals, 1, '待审批计数为 1');
  eq(card.collapsed, false, '待确认时默认展开 diff');

  reduce(state, { t: 'permission-resolved', requestId: 'perm-9', optionId: 'reject_once' });
  eq(card.status, 'failed', '拒绝后标记为失败');
  eq(card.resolvedOptionId, 'reject_once', '记录用户的拒绝选项');
  eq(card.collapsed, true, '处理完自动折叠');
  eq(state.meta.pendingApprovals, 0, '待审批计数清零');

  const unknown = reduce(state, { t: 'permission-resolved', requestId: 'perm-不存在', optionId: 'allow_once' });
  eq(unknown.length, 0, '对未知审批序号的应答被安全忽略');
}

section('回合结束与状态收敛');
{
  const state = createState();
  reduce(state, { t: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-x', title: 'terminal: sleep', kind: 'execute' } });
  eq(kindOf(state, 'tool')[0].status, 'running', '工具开始时是 running');
  reduce(state, { t: 'turn-end', stopReason: 'end_turn' });
  eq(kindOf(state, 'tool')[0].status, 'completed', '回合结束时残留的 running 被收尾');
  eq(state.meta.status, 'ready', '状态回到 ready（否则会卡在「正在处理」）');

  const cancelled = createState();
  reduce(cancelled, { t: 'turn-end', stopReason: 'cancelled' });
  includes(cancelled.meta.statusText, 'cancelled', '中断原因透传到状态文本');
}

section('未知报文与边界');
{
  const state = createState();
  const ops = reduce(state, { t: 'update', update: { sessionUpdate: '未来才有的字段_x', foo: 1 } });
  eq(ops.length, 0, '未知 sessionUpdate 不产生 op 也不抛异常');

  const phantom = createState();
  reduce(phantom, { t: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit-approval-77', status: 'completed' } });
  eq(kindOf(phantom, 'tool').length, 0, '未知工具的无内容进度更新不会造出幻影卡片');

  const weird = createState();
  reduce(weird, { t: 'update', update: { sessionUpdate: 'tool_call' } });
  eq(kindOf(weird, 'tool').length, 1, '缺 toolCallId 的工具调用也能兜住');

  const capState = createState(3);
  for (let i = 0; i < 8; i++) {
    reduce(capState, { t: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: `m${i}`, content: { type: 'text', text: `第${i}条` } } });
  }
  eq(capState.items.length, 3, '超过上限后只保留最近 N 条');
  eq(snapshot(capState).op, 'reset', '裁剪后下发一次全量 reset（webview 才不会错位）');
}

section('快照不含内部字段');
{
  const state = createState();
  reduce(state, { t: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'hi' } } });
  const snap = snapshot(state);
  const keys = Object.keys(snap.items[0]).sort();
  eq(keys.includes('raw'), false, '内部累积字段 raw 不外泄');
  eq(keys.includes('bodyText'), false, '内部累积字段 bodyText 不外泄');
  includes(snap.items[0].html, 'hi', '渲染结果照常下发');
}

section('思考过程：默认折叠 + 回合结束收起');
{
  const state = createState();
  const ops = [];
  ops.push(
    ...reduce(state, {
      t: 'update',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: '先想一下' },
      },
    })
  );
  const add = ops.find((o) => o.op === 'add' && o.item.kind === 'thought');
  ok(!!add, '思考块会创建一个条目');
  eq(add.item.collapsed, true, '思考块创建时就是折叠的');
  eq(add.item.thinking, true, '思考中：thinking 标记为 true');
  const textOp = ops.find((o) => o.op === 'text');
  eq(textOp.chars, 4, 'text op 带上字符数（折叠态要显示"多少字"）');

  // 模拟用户中途手动展开
  const thought = state.items.find((i) => i.kind === 'thought');
  thought.collapsed = false;
  const endOps = reduce(state, { t: 'turn-end', stopReason: 'end_turn' });
  const patch = endOps.filter((o) => o.op === 'update' && o.id === thought.id).pop();
  ok(!!patch, '回合结束会下发思考块的更新');
  eq(patch.patch.collapsed, true, '回合结束把思考块收回去（中途展开过也不例外）');
  eq(patch.patch.thinking, false, '回合结束清掉"思考中"');
  eq(
    snapshot(state).items.find((i) => i.kind === 'thought').collapsed,
    true,
    '终态也是折叠的（重载面板不会又冒出来）'
  );
}

finish();
