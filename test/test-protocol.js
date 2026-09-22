'use strict';
const { ok, eq, section, finish } = require('./lib');
const { extractJsonObjects, resolveExecutable } = require('../out/acpClient.js');

section('JSON 流解析：单行 / 多行 / 半截 / 噪声');
{
  const one = extractJsonObjects('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  eq(one.objects.length, 1, '单个紧凑对象');
  eq(one.objects[0].id, 1, '字段解析正确');
  eq(one.rest.trim(), '', '残余为空');

  const two = extractJsonObjects('{"a":1}\n{"b":2}\n');
  eq(two.objects.length, 2, '一行一个，两个对象');
  eq([two.objects[0].a, two.objects[1].b], [1, 2], '两个对象内容正确');

  // 关键回归：对方一旦改用 pretty-print，按 \n 切就会碎掉
  const pretty = '{\n  "a": 1,\n  "b": {\n    "c": [1, 2]\n  }\n}\n';
  const parsed = extractJsonObjects(pretty);
  eq(parsed.objects.length, 1, '多行美化 JSON 被当作一个对象');
  eq(parsed.objects[0].b.c, [1, 2], '嵌套结构完整');

  const partial = extractJsonObjects('{"a":1}{"b":');
  eq(partial.objects.length, 1, '半截对象先交付完整的');
  eq(partial.rest, '{"b":', '半截对象留在缓冲区');

  const noisy = extractJsonObjects('some log line\n{"ok":true}\n');
  eq(noisy.objects.length, 1, '噪声行被跳过');
  eq(noisy.objects[0].ok, true, '有效对象仍然解析出来');

  // 字符串里的花括号不能当成结构
  const tricky = extractJsonObjects('{"s":"}{\\"x\\"","n":1}');
  eq(tricky.objects.length, 1, '字符串内的花括号不影响配平');
  eq(tricky.objects[0].n, 1, '解析后字段正确');
  eq(tricky.objects[0].s, '}{"x"', '字符串内容原样保留');

  const broken = extractJsonObjects('{not json}');
  eq(broken.objects.length, 0, '非法 JSON 被丢弃而不是抛异常');

  // 真实报文片段：带 diff 的审批请求
  const real = extractJsonObjects(
    '{"id":0,"method":"session/request_permission","params":{"toolCall":{"content":[{"type":"diff","newText":"a\\nb"}]}}}\n'
  );
  eq(real.objects.length, 1, '真实审批报文可解析');
  eq(real.objects[0].params.toolCall.content[0].newText, 'a\nb', '转义换行还原正确');
}

section('「空对象即失败」判据（Hermes 的静默失败信号）');
{
  const { isEmptyResult } = require('../out/acpClient.js');
  eq(isEmptyResult({}), true, '空对象 → 失败（这正是 load 未知会话的线上形态）');
  eq(isEmptyResult(null), true, 'null → 失败');
  eq(isEmptyResult(undefined), true, 'undefined → 失败');
  eq(
    isEmptyResult({ models: null, modes: null, field_meta: { a: 1 } }),
    false,
    '成功响应即使字段值为 null 也不算空'
  );
  eq(isEmptyResult({ models: { availableModels: [] } }), false, '带 models 的响应算成功');
  eq(!{}, false, '（反例自证）if(!result) 挡不住空对象：!{} === false');
}

section('死会话判据（不是靠猜，是按 Hermes 的实际行为）');
{
  const { looksLikeStaleSession } = require('../out/acpClient.js');
  eq(looksLikeStaleSession('refusal', 0), true, 'refusal + 零内容 → 判定为死会话');
  eq(looksLikeStaleSession('refusal', 3), false, 'refusal 但有内容 → 是真正的 provider 拒绝，不该新建会话');
  eq(looksLikeStaleSession('end_turn', 0), false, 'end_turn 就算没内容也不是死会话');
  eq(looksLikeStaleSession(undefined, 0), false, '没有 stopReason 时不乱判');
}

section('可执行文件解析');
{
  const found = resolveExecutable('hermes', []);
  ok(found !== null, '能在本机 PATH/常见目录里找到 hermes');
  if (found) {
    ok(/hermes(\.exe)?$/i.test(found.file), `解析结果指向 hermes：${found.file}`);
  }
  eq(resolveExecutable('definitely-not-a-real-binary-xyz', []), null, '不存在的命令返回 null');

  // 明确给出完整路径时不应依赖 PATH
  const native = process.env.USERPROFILE
    ? require('path').join(process.env.USERPROFILE, 'AppData', 'Roaming', 'hermes', 'bin', 'hermes.exe')
    : null;
  if (native) {
    const byPath = resolveExecutable(native, []);
    if (byPath) {
      eq(byPath.needsShell, false, '直接给 .exe 路径时不需要 shell');
    } else {
      ok(true, '（本机该路径不存在，跳过 .exe 直连检查）');
    }
  }
}

finish();
