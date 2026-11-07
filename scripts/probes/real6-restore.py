"""第六轮真机联调 · 用裸 HID（ctypes，不依赖 Electron）把设备参数还原成参数表默认值。

    python scripts/probes/real6-restore.py

读 artifacts/real6/defaults.json（由 real6-defaults.mjs 从 registers.ts 生成），
逐项 0x10 写入后整段回读比对，结果写 artifacts/real6/restore.json。
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


def reports(frame: bytes) -> list[bytes]:
    chunks = []
    for offset in range(0, len(frame), PAYLOAD):
        chunk = frame[offset : offset + PAYLOAD]
        chunks.append(bytes([OUT_ID]) + chunk + bytes(PAYLOAD - len(chunk)))
    return chunks


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
        expected = crc16(buffer[offset : offset + length - 2])
        received = buffer[offset + length - 2] | (buffer[offset + length - 1] << 8)
        if expected != received:
            offset += 1
            continue
        frames.append({"func": buffer[offset + 1], "data": buffer[offset + 4 : offset + length - 2]})
        offset += length
    return frames


class Link:
    def __init__(self, device: hidwin.HidDevice):
        self.device = device
        self.buffer = bytearray()

    def drain(self) -> None:
        while self.device.read(5) is not None:
            pass

    def send(self, frame: bytes) -> None:
        for report in reports(frame):
            self.device.write(report)
            time.sleep(0.002)

    def pump(self, timeout_ms: float) -> list[dict]:
        deadline = time.perf_counter() + timeout_ms / 1000.0
        while time.perf_counter() < deadline:
            report = self.device.read(10)
            if report is None:
                continue
            self.buffer += report[1:] if report and report[0] == IN_ID else report
        frames = decode_stream(bytes(self.buffer))
        self.buffer.clear()
        return frames

    def exchange(self, frame: bytes, wait_ms: float = 200) -> list[dict]:
        self.drain()
        self.send(frame)
        return self.pump(wait_ms)

    def read_seq(self, start: int, count: int) -> list[int]:
        frame = encode(0x13, bytes([(start >> 8) & 0xFF, start & 0xFF, (count >> 8) & 0xFF, count & 0xFF]))
        for _ in range(3):
            frames = self.exchange(frame, 600)
            reply = next((item for item in frames if item["func"] == 0x13), None)
            if reply is None:
                continue
            total = (reply["data"][2] << 8) | reply["data"][3]
            return [(reply["data"][4 + index * 2] << 8) | reply["data"][5 + index * 2] for index in range(total)]
        return []


def main() -> int:
    targets = [
        item
        for item in hidwin.enumerate_hid()
        if item.get("vid") and int(item["vid"], 16) == VID and int(item["pid"], 16) == PID
    ]
    if not targets:
        print("设备不在线（VID 0A67 / PID 0010）")
        return 1
    device = hidwin.HidDevice(targets[0]["path"])
    link = Link(device)

    defaults = json.loads((ROOT / "artifacts" / "real6" / "defaults.json").read_text(encoding="utf-8"))
    results = []
    for item in defaults:
        addr = item["addr"]
        raw = item["raw"]
        frames = link.exchange(encode(0x10, bytes([(addr >> 8) & 0xFF, addr & 0xFF, (raw >> 8) & 0xFF, raw & 0xFF])), 120)
        ack = next((((f["data"][0] << 8) | f["data"][1]) for f in frames if f["func"] == 0x02 and len(f["data"]) >= 2), None)
        results.append({"addr": addr, "field": item["field"], "raw": raw, "ack": ack})
        time.sleep(0.02)

    time.sleep(0.3)
    words = link.read_seq(0x2000, 114)
    mismatches = [
        {"addr": item["addr"], "field": item["field"], "expected": item["raw"], "actual": words[item["addr"] - 0x2000]}
        for item in defaults
        if len(words) == 114 and words[item["addr"] - 0x2000] != item["raw"]
    ]
    payload = {
        "written": len(results),
        "writeFailures": [item for item in results if item["ack"] != 0],
        "readBack": len(words),
        "mismatches": mismatches,
    }
    (ROOT / "artifacts" / "real6" / "restore.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps({k: payload[k] for k in ("written", "readBack")}))
    print("writeFailures", len(payload["writeFailures"]))
    print("mismatches", len(mismatches))
    for item in mismatches[:10]:
        print("  ", item)
    device.close()
    return 0 if not mismatches and not payload["writeFailures"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
