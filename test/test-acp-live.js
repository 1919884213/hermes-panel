'use strict';
/**
 * 真·端到端：起一个真实的 `hermes acp` 子进程，走完整协议。
 *
 * 这个测试**会消耗少量模型额度**（两条极短 prompt），换来的是「协议真的通」
 * 而不是「看起来通」。它验证的东西包括：
 *   - initialize 握手与能力协商
 *   - session/new 返回模型清单
 *   - prompt 流式推送 agent_message_chunk
 *   - 工具调用 tool_call / tool_call_update 收敛
 *   - session/request_permission 的 diff 审批闭环
 *   - 审批通过后文件**真的**被写到磁盘上（外部状态验证）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok, eq, includes, section, finish, waitFor } = require('./lib');
const { AcpClient, isEmptyResult, looksLikeStaleSession, resolveExecutable } = require('../out/acpClient.js');

const WORKDIR = path.join(os.tmpdir(), `hermes-panel-live-${Date.now()}`);
const TARGET = path.join(WORKDIR, 'acp_live_test.txt');
const TARGET_CONTENT = 'live test payload';

async function main() {
  fs.mkdirSync(WORKDIR, { recursive: true });

  const exe = resolveExecutable('hermes', []);
  if (!exe) {
    console.error('找不到 hermes 可执行文件，跳过实机测试');
    process.exit(0);
  }
  console.log(`hermes: ${exe.file}`);
  console.log(`工作目录: ${WORKDIR}`);

  const updates = [];
  const permissions = [];
  const logs = [];
  let exitInfo = null;

  const client = new AcpClient({
    command: 'hermes',
    args: ['acp'],
    cwd: WORKDIR,
    onUpdate: (params) => updates.push(params.update || {}),
    onRequest: async (method, params) => {
      if (method === 'session/request_permission') {
        permissions.push(params);
        const options = params.options || [];
        const allow = options.find((o) => o.kind === 'allow_once') || options.find((o) => String(o.optionId).startsWith('allow'));
        return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      }
      if (method === 'fs/read_text_file') {
        return { content: fs.readFileSync(params.path, 'utf8') };
      }
      if (method === 'fs/write_text_file') {
        fs.writeFileSync(params.path, params.content);
        return {};
      }
      return {};
    },
    onLog: (line) => logs.push(line),
    onExit: (info) => {
      exitInfo = info;
    },
  });

  client.start();

  try {
    section('initialize');
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'hermes-panel-live-test', version: '0.0.0' },
    });
    eq(init.protocolVersion, 1, '协议版本为 1');
    ok(!!init.agentInfo, 'agentInfo 存在（对面确实是 Hermes）');
    ok(typeof init.agentCapabilities === 'object', 'agentCapabilities 是对象');
    eq(Array.isArray(init.authMethods), true, 'authMethods 是数组');

    section('session/new');
    const created = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] });
    ok(typeof created.sessionId === 'string' && created.sessionId.length > 8, `拿到 sessionId：${created.sessionId}`);
    ok(created.models && Array.isArray(created.models.availableModels), '返回可用模型清单');
    ok(
      created.models.availableModels.length > 0,
      `模型清单非空（${created.models.availableModels.length} 个）`
    );
    const sessionId = created.sessionId;

    section('session/prompt（纯对话）');
    updates.length = 0;
    const first = await client.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: '只回答两个字：收到' }] },
      300_000
    );
    eq(first.stopReason, 'end_turn', '回合正常结束');
    ok(!!first.usage, '返回 token 用量');

    const agentText = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => u.content?.text || '')
      .join('');
    includes(agentText, '收到', '流式 chunk 拼出了完整回复');
    ok(
      updates.some((u) => u.sessionUpdate === 'available_commands_update'),
      '收到斜杠命令清单'
    );
    ok(updates.some((u) => u.sessionUpdate === 'usage_update'), '收到上下文用量更新');
    // 不断言 session_info_update：它由「标题生成」这个辅助模型调用完成后才推，
    // 是设计上的带外异步事件，时序不稳定（实测两次跑一次有、一次没有）。
    // 标题与 provenance 的解析由「夹具回放」测试确定性覆盖（wire-*.json 里就有真实报文）。

    section('session/prompt（触发工具 + 文件审批）');
    updates.length = 0;
    permissions.length = 0;
    const second = await client.request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: `用 write_file 工具在当前工作目录创建文件 acp_live_test.txt，内容写 "${TARGET_CONTENT}"，然后用 read_file 读回来确认。`,
          },
        ],
      },
      300_000
    );
    eq(second.stopReason, 'end_turn', '带工具的回合正常结束');

    const toolCalls = updates.filter((u) => u.sessionUpdate === 'tool_call');
    const toolUpdates = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    ok(toolCalls.length > 0, `产生了工具调用（${toolCalls.length} 次）`);
    ok(toolUpdates.length > 0, `产生过工具状态更新（${toolUpdates.length} 次）`);
    ok(
      toolUpdates.some((u) => u.status === 'completed'),
      '至少一个工具收敛到 completed（不会永远挂着）'
    );
    ok(
      toolCalls.some((u) => u.kind === 'edit' || u.kind === 'read'),
      '工具类型标注了 edit / read'
    );

    section('session/request_permission 的 diff 闭环');
    eq(permissions.length, 1, `收到 1 次审批请求（实际 ${permissions.length} 次）`);
    if (permissions.length) {
      const req = permissions[0];
      ok(Array.isArray(req.options) && req.options.length > 0, '审批请求带选项列表');
      const optionKinds = req.options.map((o) => o.kind);
      ok(optionKinds.includes('allow_once'), `包含 allow_once 选项（${optionKinds.join(',')}）`);
      const diffBlocks = (req.toolCall?.content || []).filter((c) => c.type === 'diff');
      ok(diffBlocks.length > 0, '审批请求里带 diff 内容块');
      if (diffBlocks.length) {
        includes(diffBlocks[0].newText, TARGET_CONTENT, 'diff 的 newText 就是待写入内容');
      }
    }

    section('外部状态验证（审批通过后文件必须真的落盘）');
    ok(fs.existsSync(TARGET), `文件已创建：${TARGET}`);
    if (fs.existsSync(TARGET)) {
      const content = fs.readFileSync(TARGET, 'utf8');
      includes(content, TARGET_CONTENT, '磁盘上的内容与请求一致');
    }

    section('session/list 与 cancel 通知');
    const listed = await client.request('session/list', { cwd: WORKDIR }, 60_000);
    ok(Array.isArray(listed.sessions), 'session/list 返回数组');
    ok(
      listed.sessions.some((s) => s.sessionId === sessionId),
      '刚建的会话出现在列表里'
    );
    client.notify('session/cancel', { sessionId });
    await new Promise((r) => setTimeout(r, 300));
    ok(client.alive, '发送 cancel 通知后进程仍然存活');

    section('会话隔离：新会话不应带旧历史');
    const other = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] });
    ok(other.sessionId !== sessionId, '新建会话拿到不同的 sessionId');

    section('死会话的真实行为（复现线上那个 bug）');
    const bogus = '00000000-0000-4000-8000-000000000000';

    // 对照组：真实存在的会话，load 返回**非空**对象
    const loadedReal = await client.request(
      'session/load',
      { sessionId, cwd: WORKDIR, mcpServers: [] },
      120_000
    );
    eq(isEmptyResult(loadedReal), false, 'load 一个真实存在的会话 → 非空对象（对照组）');

    const loadedBogus = await client.request(
      'session/load',
      { sessionId: bogus, cwd: WORKDIR, mcpServers: [] },
      60_000
    );
    eq(loadedBogus, {}, 'load 未知会话 → 线上是空对象 {}（Python 侧 return None），且不报错');
    eq(isEmptyResult(loadedBogus), true, '空对象必须被判为失败 —— 注意 if(!result) 挡不住它（!{} 是 false）');
    eq(
      !!loadedBogus && typeof loadedBogus.sessionId === 'string',
      false,
      'load 的响应里本来就没有 sessionId 字段（只有 session/new 有）'
    );

    const listedBogus = await client.request('session/list', { cwd: WORKDIR }, 60_000);
    eq(
      listedBogus.sessions.some((s) => s.sessionId === bogus),
      false,
      'list 里不含未知会话 → 可当只读的「会话是否存活」探针（load 会重放历史，不能用）'
    );

    updates.length = 0;
    const staleTurn = await client.request(
      'session/prompt',
      { sessionId: bogus, prompt: [{ type: 'text', text: '这条消息不可能被处理' }] },
      60_000
    );
    const staleChunks = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').length;
    eq(staleTurn.stopReason, 'refusal', 'prompt 打给死会话 → 返回 refusal，同样不报错（静默失败）');
    eq(staleChunks, 0, '死会话回合零条 assistant 内容 —— 这正是自愈判据的第二半');
    eq(
      looksLikeStaleSession(staleTurn.stopReason, staleChunks),
      true,
      '判定函数把「refusal + 零内容」识别为死会话'
    );

    section('自愈路径可行：换新会话后同样的提问能成功');
    const recovered = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] });
    ok(recovered.sessionId !== bogus, '自愈得到的是一个可用的新 sessionId');
    updates.length = 0;
    const retried = await client.request(
      'session/prompt',
      { sessionId: recovered.sessionId, prompt: [{ type: 'text', text: '只回答两个字：收到' }] },
      300_000
    );
    eq(retried.stopReason, 'end_turn', '在新会话上重试成功（自愈闭环成立）');
    ok(
      updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').length > 0,
      '重试这一轮有真实的流式内容'
    );
  } finally {
    client.dispose();
    await new Promise((r) => setTimeout(r, 500));
  }

  section('收尾');
  ok(logs.length >= 0, `stderr 日志行数：${logs.length}`);
  if (exitInfo && !exitInfo.expected) {
    ok(false, `进程意外退出：code=${exitInfo.code} signal=${exitInfo.signal}`);
  }

  try {
    fs.rmSync(WORKDIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }

  finish();
}

main().catch((err) => {
  console.error(`\n实机测试异常：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
