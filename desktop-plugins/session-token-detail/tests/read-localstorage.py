#!/usr/bin/env python3
"""只读地读 Hermes 桌面 App 渲染进程 localStorage 里某个键的值（默认读本插件的 prices）。

为什么需要它：桌面插件的 ctx.storage 落在渲染进程的 Electron localStorage
（<APPDATA>/Hermes/Local Storage/leveldb），文件系统以外没有 API 可读；App 默认也不开
CDP 端口。改了插件的落盘逻辑之后，这是唯一能从外面「回读确认」的办法。

踩过的两个坑（别再犯）：
  * **键是 ASCII/UTF-8，值是 UTF-16LE**（前缀 0x00/0x01 区分编码）——只按 UTF-16 找键
    会什么都找不到（第一版就是这么白跑一趟的）。
  * 值可能被 snappy 压进 .ldb 块里（读不出来，只能靠 MANIFEST 确认键存在）；
    最近的写入在 .log（memtable）里且不压缩 —— 所以**写完尽快读**。

跑法：
    python tests/read-localstorage.py                        # 默认读本插件
    python tests/read-localstorage.py <leveldb 目录> [键子串]
"""
import json
import os
import re
import sys

NEEDLE_DEFAULT = 'hermes.plugin.session-token-detail'


def read_files(root):
    out = []

    for name in sorted(os.listdir(root)):
        if name.endswith(('.ldb', '.log')):
            with open(os.path.join(root, name), 'rb') as handle:
                out.append((name, handle.read()))

    return out


def utf16_run(blob, at, limit=4_000_000):
    """从 at 起尽量长地解一段 UTF-16LE（高字节为 0 的连续字节）。"""
    end = at

    while end + 1 < len(blob) and end - at < limit:
        low, high = blob[end], blob[end + 1]

        if high != 0 or low == 0:
            break

        end += 2

    return blob[at:end].decode('utf-16-le', 'ignore')


def ascii_run(blob, at, limit=4_000_000):
    end = at

    while end < len(blob) and end - at < limit and 0x20 <= blob[end] <= 0x7E:
        end += 1

    return blob[at:end].decode('latin-1', 'ignore')


def json_objects(text):
    """从一段文本里抠出所有能解析的 JSON 对象。"""
    found = []

    for match in re.finditer(r'\{', text):
        depth = 0

        for index in range(match.start(), len(text)):
            char = text[index]

            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1

                if depth == 0:
                    chunk = text[match.start():index + 1]

                    try:
                        found.append((chunk, json.loads(chunk)))
                    except Exception:
                        pass

                    break

    return found


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get('APPDATA', ''), 'Hermes', 'Local Storage', 'leveldb'
    )
    needle = sys.argv[2] if len(sys.argv) > 2 else NEEDLE_DEFAULT

    print(f'# 扫描 {root}\n# 过滤 {needle!r}')

    seen = set()

    for name, blob in read_files(root):
        for encoding in ('ascii', 'utf16'):
            target = needle.encode('ascii' if encoding == 'ascii' else 'utf-16-le')
            start = 0

            while True:
                at = blob.find(target, start)

                if at < 0:
                    break

                start = at + 1

                # 键后面紧跟 0x00/0x01 + varint 长度 + 值；两种编码都截一大段来试解析。
                follow = blob[at:at + 4_000_000]
                text = ascii_run(follow, len(target)) if encoding == 'ascii' else utf16_run(follow, len(target))
                text = text or follow[:400_000].decode('latin-1', 'ignore')

                for chunk, value in json_objects(text):
                    if chunk in seen or not isinstance(value, dict) or 'profiles' not in value:
                        continue

                    seen.add(chunk)

                    print(f'\n=== {name} @ {at} ({encoding}) — {len(chunk)} 字节 ===')
                    print(f'  currency={value.get("currency")} rate={value.get("rate")} activeProfile={value.get("activeProfile")!r}')
                    print(f'  sessions={json.dumps(value.get("sessions"), ensure_ascii=False)}')

                    for pid, profile in (value.get('profiles') or {}).items():
                        tiers = profile.get('tiers')

                        if tiers:
                            print(f'    {pid} 「{profile.get("name")}」 {len(tiers)} 档 lock={profile.get("tierLock")}')

                            for index, tier in enumerate(tiers):
                                print(f'        [{index}] ≤{tier.get("maxContext")} {json.dumps(tier.get("prices"), ensure_ascii=False)}')
                        else:
                            print(f'    {pid} 「{profile.get("name")}」 {json.dumps(profile.get("prices"), ensure_ascii=False)}')

    if not seen:
        print('（没读到可解析的 profiles 值：要么没写过，要么最新值已被压进 .ldb 块）')
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
