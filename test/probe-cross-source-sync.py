#!/usr/bin/env python3
"""
跨源会话同步的端到端验证（Hermes 侧补丁是否真的打通）。

背景：ACP 适配器原本硬编码 source="acp"，导致编辑器面板只看得见自己建的会话；
`session/load` 也拒绝非 acp 来源。补丁把这两处改成「只屏蔽内部 tool 源」。

本脚本验证三件事：
  A. 只读：面板的 session/list 现在能看到 desktop 会话（拿你的真实工作区验）
  B. 隔离：用一个我自己造的 oneshot 会话，跑通 list → load → prompt，
     并要求它能回忆起加载前的对话内容（证明历史真的续上了，不是新建会话）
  C. 完整性：加载+提问之后，那条会话的 source 没有被改写成 acp

注意：这个脚本**会写**它自己创建的那条会话（不是别人的），所以不进默认测试套件。
用法: python3 test/probe-cross-source-sync.py
"""
import json
import os
import pathlib
import queue
import shutil
import sqlite3
import subprocess
import sys
import threading
import time

HERMES = os.environ.get("HERMES_BIN", "hermes")
DB = pathlib.Path(os.environ.get("HERMES_HOME", "D:/APP/hermes")) / "state.db"
WORKDIR = pathlib.Path(os.environ.get("TMPDIR", "D:/APP/hermes/cache/scratch")) / "synctest"
REAL_WORKSPACE = r"D:\Data\Codes\ESP32\ESPIDF\LCD"
KNOWN_DESKTOP_SESSION = "20260912_174920_8050c0"   # 「排查 CAN IAP ACK 超时问题」，仅只读引用
MAGIC = "7421"

ok_count = 0
fail_count = 0


def ok(cond, msg):
    global ok_count, fail_count
    if cond:
        ok_count += 1
        print(f"  ✓ {msg}")
    else:
        fail_count += 1
        print(f"  ✗ {msg}")


def section(title):
    print(f"\n== {title}")


class Acp:
    """最小 ACP 客户端：够跑 initialize / session.list / session.load / session.prompt"""

    def __init__(self, cwd):
        self.proc = subprocess.Popen(
            [HERMES, "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=str(cwd),
        )
        self.q = queue.Queue()
        self.log = []
        self.perms = []
        threading.Thread(target=self._pump, daemon=True).start()
        self.nid = 0

    def _pump(self):
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("method") == "session/update":
                self.log.append((msg.get("params") or {}).get("update") or {})
            elif msg.get("method") and "id" in msg:
                # agent → client 的请求必须回包，否则对面一直挂着
                p = msg.get("params") or {}
                if msg["method"] == "session/request_permission":
                    self.perms.append(p)
                    opts = p.get("options") or []
                    pick = next((o["optionId"] for o in opts if "allow" in str(o.get("optionId"))), None)
                    self._send({"jsonrpc": "2.0", "id": msg["id"],
                                "result": {"outcome": {"outcome": "selected", "optionId": pick}}})
                else:
                    self._send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
            self.q.put(msg)

    def _send(self, obj):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def request(self, method, params, timeout=180):
        self.nid += 1
        rid = self.nid
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self.q.get(timeout=1)
            except queue.Empty:
                continue
            if msg.get("id") == rid and ("result" in msg or "error" in msg):
                return msg
        raise TimeoutError(method)

    def dispose(self):
        try:
            self.proc.kill()
        except Exception:
            pass


def db_query(sql, params=()):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def main():
    if not WORKDIR.exists():
        WORKDIR.mkdir(parents=True)

    client = Acp(WORKDIR)
    try:
        client.request("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
            "clientInfo": {"name": "cross-source-probe", "version": "0.0.1"},
        })

        # ── A. 只读：面板现在能看到 desktop 会话吗 ──────────────────────────
        section("A. 只读验证：session/list 是否包含非 acp 来源的会话")
        # 自己挑目标，别硬编码：要「未归档 + 未隐藏 + 有真实 cwd + 非 acp」。
        # （第一版我硬编码了一条 desktop 会话做预期，结果它是 archived=1 ——
        #   归档会话不在默认列表里是**有意**的，桌面版归档的老对话不该翻出来。）
        cand = db_query("""SELECT id, source, COALESCE(title,''), COALESCE(cwd,'')
                           FROM sessions
                           WHERE source NOT IN ('acp', 'tool') AND archived = 0 AND hidden = 0
                             AND COALESCE(message_count,0) > 2 AND COALESCE(cwd,'') NOT IN ('', '.')
                           ORDER BY last_activity_at DESC LIMIT 1""")
        ok(len(cand) == 1, f"库里有可验证的非 acp 会话：{cand[0][0] if cand else '（没有）'}")
        if not cand:
            return
        expect_id, expect_src, expect_title, expect_cwd = cand[0][0], cand[0][1], cand[0][2], cand[0][3]
        print(f"  目标：{expect_id} | source={expect_src} | {expect_title[:26]} | {expect_cwd}")

        listed = client.request("session/list", {"cwd": expect_cwd})["result"]
        ids = [s["sessionId"] for s in listed.get("sessions", [])]
        print(f"  该工作区下共 {len(ids)} 个会话")
        for s in listed.get("sessions", [])[:6]:
            print(f"    {s['sessionId'][:26]:26s} | {str(s.get('title'))[:34]}")
        ok(len(ids) > 0, f"列表非空（{len(ids)} 条）")
        ok(expect_id in ids, f"包含那条 source={expect_src} 的会话（补丁前这里只会有 acp 来源的会话）")

        # ── B. 隔离验证：造一条我自己的非 acp 会话，走完整链路 ──────────────
        section("B. 隔离验证：list → load → prompt（用自建会话，不碰你的真实对话）")
        cli = subprocess.run(
            [HERMES, "chat", "-q", f"记住这个数字：{MAGIC}。只回答「记住了」三个字。",
             "--format", "stream-json"],
            cwd=str(WORKDIR), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
        )
        # 从 CLI 的 result 事件里直接拿 session_id —— 别用「和之前的全表快照做差集」，
        # 那样在 WAL 下会读到不一致的快照，并误选出别人的旧会话（第一版就栽在这）。
        target = None
        for line in (cli.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except Exception:
                continue
            if event.get("type") == "result" and event.get("session_id"):
                target = event["session_id"]
        ok(target is not None, f"从 CLI 的 result 事件拿到 session_id：{target}")
        if not target:
            print("  CLI stderr 尾部：", (cli.stderr or "")[-400:])
            return
        src_before = db_query("SELECT source FROM sessions WHERE id=?", (target,))[0][0]
        mc_before = db_query("SELECT COALESCE(message_count,0) FROM sessions WHERE id=?", (target,))[0][0]
        print(f"  目标会话 {target}（source={src_before}, 已有 {int(mc_before)} 条消息）")
        ok(src_before != "acp", f"它确实是非 acp 来源（{src_before}），正是补丁要打通的场景")

        listed2 = client.request("session/list", {"cwd": str(WORKDIR)})["result"]
        ids2 = [s["sessionId"] for s in listed2.get("sessions", [])]
        ok(target in ids2, "session/list 能看到这条非 acp 会话")

        client.log.clear()
        loaded = client.request("session/load", {"sessionId": target, "cwd": str(WORKDIR), "mcpServers": []})["result"]
        ok(isinstance(loaded, dict) and len(loaded) > 0, f"session/load 返回非空（补丁前这里是空对象 {{}}）：{list(loaded.keys())}")
        replayed = [u for u in client.log if str(u.get("sessionUpdate", "")).endswith("_chunk")]
        ok(len(replayed) > 0, f"载入时历史被回放（{len(replayed)} 条 chunk）")

        client.log.clear()
        ans = client.request("session/prompt", {
            "sessionId": target,
            "prompt": [{"type": "text", "text": "我刚才让你记住的数字是多少？只回答数字。"}],
        }, timeout=300)["result"]
        text = "".join(u.get("content", {}).get("text", "") for u in client.log
                       if u.get("sessionUpdate") == "agent_message_chunk")
        print(f"  它回答：{text.strip()[:80]!r}  (stopReason={ans.get('stopReason')})")
        ok(MAGIC in text, f"它回忆起了加载前的对话内容（{MAGIC}）—— 说明真的续上了历史，不是新建会话")

        # ── C. 完整性：source 有没有被改写 ─────────────────────────────────
        section("C. 完整性：加载/提问之后 source 是否被污染")
        src_after = db_query("SELECT source FROM sessions WHERE id=?", (target,))[0][0]
        ok(src_after == src_before, f"source 保持为 {src_after}（没被改写成 acp）")
        n = db_query("SELECT COUNT(*) FROM messages WHERE session_id=?", (target,))[0][0]
        ok(n >= 4, f"新消息已落到同一条会话里（共 {n} 条）—— 这就是双向同步")

    finally:
        client.dispose()

    print(f"\n—— {ok_count}/{ok_count + fail_count} 通过")
    sys.exit(1 if fail_count else 0)


if __name__ == "__main__":
    main()
