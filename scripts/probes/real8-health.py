"""第八轮（V0.0.6 升级复测）· 裸 HID 只读健康快照（不依赖 Electron）。

    python scripts/probes/real8-health.py [tag]

读 0x0000×62（信息区）/ 0x1000×14（配置区）/ 0x2000×118（预设区，V0.3 起 118 项），
解码型号 / 名称 / 版本 / SN，写 artifacts/dfu-check-20261121/health-<tag>.json。

只发 0x13 连续读，不写任何寄存器 —— 设备停在任何模式都不会被它改状态。
"""

from __future__ import annotations

import json
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "dfu"))
import hidwin  # noqa: E402

VID = 0x0A67
PID = 0x0010
OUT_ID = 0x51
IN_ID = 0x11
PAYLOAD = 63
PRESET_WORDS = 118
CONFIG_WORDS = 14
INFO_WORDS = 62


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def encode(func: int, data: bytes) -> bytes:
    length = len(data) + 6
    body = bytes([0x00, func, (length >> 8) & 0xFF, length & 0xFF]) + data
    crc = crc16(body)
    return body + bytes([crc & 0xFF, (crc >> 8) & 0xFF])


def decode_stream(buffer: bytes) -> list[dict]:
    frames = []
    offset = 0
    while offset < len(buffer):
        while offset + 1 < len(buffer) and buffer[offset] == 0 and buffer[offset + 1] == 0:
            offset += 1
        if len(buffer) - offset < 4:
            break
        length = (buffer[offset + 2] << 8) | buffer[offset + 3]
        if length < 6 or length > 512:
            offset += 1
            continue
        if length > len(buffer) - offset:
            break
        expected = crc16(buffer[offset:offset + length - 2])
        received = buffer[offset + length - 2] | (buffer[offset + length - 1] << 8)
        if expected != received:
            offset += 1
            continue
        frames.append({"func": buffer[offset + 1], "data": buffer[offset + 4:offset + length - 2]})
        offset += length
    return frames


def decode_ascii(words: list[int]) -> str:
    """信息区按大端字存 ASCII：JYM001 → 4A59 4D30 3031。"""
    text = ""
    for word in words:
        high = (word >> 8) & 0xFF
        low = word & 0xFF
        if high in (0x00, 0xFF):
            break
        text += chr(high)
        if low in (0x00, 0xFF):
            break
        text += chr(low)
    return text.rstrip()


def main() -> int:
    tag = sys.argv[1] if len(sys.argv) > 1 else "v006"
    targets = [
        item
        for item in hidwin.enumerate_hid()
        if item.get("vid") and int(item["vid"], 16) == VID and int(item["pid"], 16) == PID
    ]
    if not targets:
        print(json.dumps({"error": "设备不在线", "hid": []}, ensure_ascii=False))
        return 1

    device = hidwin.HidDevice(targets[0]["path"])

    def read_seq(start: int, count: int) -> list[int]:
        frame = encode(0x13, bytes([(start >> 8) & 0xFF, start & 0xFF, (count >> 8) & 0xFF, count & 0xFF]))
        for _ in range(3):
            while device.read(5) is not None:
                pass
            for offset in range(0, len(frame), PAYLOAD):
                chunk = frame[offset:offset + PAYLOAD]
                device.write(bytes([OUT_ID]) + chunk + bytes(PAYLOAD - len(chunk)))
                time.sleep(0.002)
            buffer = bytearray()
            deadline = time.perf_counter() + 0.8
            reply = None
            while time.perf_counter() < deadline:
                report = device.read(10)
                if report is None:
                    continue
                buffer += report[1:] if report and report[0] == IN_ID else report
                frames = decode_stream(bytes(buffer))
                reply = next((item for item in frames if item["func"] == 0x13), None)
                if reply is not None:
                    break
            if reply is None:
                continue
            total = (reply["data"][2] << 8) | reply["data"][3]
            return [(reply["data"][4 + index * 2] << 8) | reply["data"][5 + index * 2] for index in range(total)]
        return []

    preset = read_seq(0x2000, PRESET_WORDS)
    config = read_seq(0x1000, CONFIG_WORDS)
    info = read_seq(0x0000, INFO_WORDS)

    identity = {
        "modelCode": decode_ascii(info[0:3]) if len(info) >= 3 else None,
        "deviceName": decode_ascii(info[3:11]) if len(info) >= 11 else None,
        "firmware": ".".join(str(word) for word in info[11:15]) if len(info) >= 15 else None,
        "fwType": info[15] if len(info) >= 16 else None,
        "vid": f"{(info[22] >> 8) & 0xFF:02X}{(info[22] & 0xFF):02X}" if len(info) >= 23 else None,
        "pid": f"{(info[23] >> 8) & 0xFF:02X}{(info[23] & 0xFF):02X}" if len(info) >= 24 else None,
        "serial": decode_ascii(info[30:62]) if len(info) >= 62 else None,
    }
    payload = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "identity": identity,
        "counts": {"preset": len(preset), "config": len(config), "info": len(info)},
        "raw": {"preset": preset, "config": config, "info": info},
    }
    out = ROOT / "artifacts" / "dfu-check-20261121" / f"health-{tag}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({**identity, "counts": payload["counts"], "file": str(out)}, ensure_ascii=False, indent=1))
    device.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
