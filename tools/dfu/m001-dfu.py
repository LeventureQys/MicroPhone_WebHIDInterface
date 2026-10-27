"""M001 real-device DFU tool (Windows, ctypes HID).

Why not Electron: the confined DSH shell cannot create named pipes, so Electron's
multi-process IPC dies at startup; hidwin.py talks to the device directly.

Sub-commands:
  state            read both protocols, report which firmware is running
  enter            ask MainApp to reboot into the Bootloader (waits for re-enumeration)
  flash            Bootloader-only: info frame + code blocks + success wait
  flash-all        enter + flash (device must be running MainApp)
  verify           read the Modbus version after the device restarted
  package          parse the .bin and print its header/length/checksum only

Every run appends JSONL to --log (default ./dfu-<stamp>.jsonl) and prints a JSON summary.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hidwin  # noqa: E402

TARGET_VID = 0x0A67
TARGET_PID = 0x0010
OUT_ID = 0x51
IN_ID = 0x11
REPORT_PAYLOAD = 63
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_PACKAGE = os.path.join(
    REPO_ROOT,
    "Document",
    "Protocol",
    "dfu_M001 MCU V0.0.2_2026-10-26_Rev0.bin",
)

ENTER_FRAME = bytes.fromhex("0010000A100800018D09")  # Modbus: write 0x1008 = 1


# ---------------------------------------------------------------- frame helpers
def sigma_crc(data: bytes) -> int:
    return ((~sum(data) & 0xFFFF) + 1) & 0xFFFF


def modbus_crc(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def encode_sigma(cmd: int, payload: bytes) -> bytes:
    length = 7 + len(payload)
    frame = bytearray(length)
    frame[0] = 0xC4
    frame[1] = length & 0xFF
    frame[2] = (length >> 8) & 0xFF
    frame[3] = 0x00
    frame[4] = cmd
    frame[5 : 5 + len(payload)] = payload
    crc = sigma_crc(bytes(frame[: length - 2]))
    frame[length - 2] = crc & 0xFF
    frame[length - 1] = (crc >> 8) & 0xFF
    return bytes(frame)


def decode_sigma(buffer: bytes):
    frames = []
    pos = 0
    while pos + 3 <= len(buffer):
        if buffer[pos] != 0xC4:
            pos += 1
            continue
        length = buffer[pos + 1] | (buffer[pos + 2] << 8)
        if length < 9 or length > 1022 or length > len(buffer) - pos:
            break
        frame = buffer[pos : pos + length]
        received = frame[length - 2] | (frame[length - 1] << 8)
        if sigma_crc(frame[: length - 2]) != received:
            pos += 1
            continue
        cmd = frame[4] & 0x7F
        data = frame[5 : length - 2]
        status = data[2] if cmd == 0x0B and len(data) >= 3 and data[0] == 0x01 else None
        ack = (data[0] | (data[1] << 8)) if cmd == 0x02 and len(data) >= 2 else None
        frames.append({"cmd": cmd, "data": data, "status": status, "ack": ack, "raw": frame})
        pos += length
    return frames


def decode_modbus(buffer: bytes):
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
        if modbus_crc(buffer[offset : offset + length - 2]) != (
            buffer[offset + length - 2] | (buffer[offset + length - 1] << 8)
        ):
            offset += 1
            continue
        frames.append(
            {
                "func": buffer[offset + 1],
                "data": buffer[offset + 4 : offset + length - 2],
                "raw": buffer[offset : offset + length],
            }
        )
        offset += length
    return frames


def split_reports(frame: bytes):
    reports = []
    for offset in range(0, len(frame), REPORT_PAYLOAD):
        chunk = frame[offset : offset + REPORT_PAYLOAD]
        reports.append(bytes([OUT_ID]) + chunk + bytes(REPORT_PAYLOAD - len(chunk)))
    return reports


# ---------------------------------------------------------------- package parse
def load_package(path: str):
    with open(path, "rb") as handle:
        package = handle.read()
    if package[0] == 0xC4:
        header_length = package[1] | (package[2] << 8)
        header_kind = "sigma"
    else:
        header_length = (package[2] << 8) | package[3]
        header_kind = "modbus"
    enter_frame = package[:header_length]
    frames = decode_sigma(package[header_length:])
    info_frame = next((f for f in frames if f["cmd"] == 0x0B and f["data"][:1] == b"\x02"), None)
    block_frames = [f for f in frames if f["cmd"] == 0x0B and f["data"][:1] == b"\x03"]
    if info_frame is None or not block_frames:
        raise ValueError("包内没有信息帧或代码块帧")
    info = info_frame["data"]
    stream = bytearray()
    for frame in block_frames:
        stream += frame["data"][2:]
    return {
        "path": path,
        "bytes": len(package),
        "header_kind": header_kind,
        "enter_frame": enter_frame,
        "info_frame": info_frame,
        "info_data": info,
        "model_code": info[2:8].decode("latin-1"),
        "version": f"{info[72]}.{info[73]}.{info[74]}",
        "fw_length": struct.unpack("<I", info[75:79])[0],
        "fw_checksum": struct.unpack("<I", info[79:83])[0],
        "stream": bytes(stream),
        "block_frames": len(block_frames),
    }


def patched_info_frame(info_frame: dict, model_code: bytes) -> bytes:
    """Rewrite ModelCode in memory only and reseal SigmaCRC (vendor file untouched)."""
    frame = bytearray(info_frame["raw"])
    frame[7 : 7 + 6] = model_code  # C4 LenL LenH Addr Cmd DFU_CMD CHIP_ID then ModelCode
    crc = sigma_crc(bytes(frame[: len(frame) - 2]))
    frame[-2] = crc & 0xFF
    frame[-1] = (crc >> 8) & 0xFF
    return bytes(frame)


# ---------------------------------------------------------------- device session
class Session:
    def __init__(self, log_path: str):
        self.log_path = log_path
        self.started = time.time()
        self.device: hidwin.HidDevice | None = None
        self.target_info: dict = {}

    def log(self, record: dict):
        record["t"] = round(time.time() - self.started, 3)
        with open(self.log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def open(self, wait_seconds: float = 0.0) -> bool:
        deadline = time.time() + wait_seconds
        while True:
            target = next(
                (
                    d
                    for d in hidwin.enumerate_hid()
                    if d.get("vid") and int(d["vid"], 16) == TARGET_VID and int(d["pid"], 16) == TARGET_PID
                ),
                None,
            )
            if target is not None:
                try:
                    self.device = hidwin.HidDevice(target["path"])
                    self.target_info = target
                    self.log({"kind": "open", "path": target["path"], "product": target.get("product")})
                    return True
                except OSError as error:
                    self.target_info = {"openError": str(error)}
            if time.time() >= deadline:
                return False
            time.sleep(0.2)

    def close(self):
        if self.device is not None:
            try:
                self.device.close()
            except Exception:
                pass
            self.device = None

    def read_report(self, timeout_ms: float = 15):
        """Read one report; a dead handle (device reset / re-enumerated) closes the session."""
        try:
            return self.device.read(timeout_ms)
        except OSError as error:
            self.log({"kind": "read-error", "error": str(error)})
            self.close()
            return None

    def collect(self, predicate, timeout_ms: float):
        """Read IN reports until predicate(frame) or timeout; returns (frame|None, raw bytes seen)."""
        deadline = time.perf_counter() + timeout_ms / 1000.0
        buffer = bytearray()
        while time.perf_counter() < deadline and self.device is not None:
            report = self.read_report(15)
            if report is None:
                continue
            buffer += report[1:] if report and report[0] == IN_ID else report
            for frame in decode_sigma(bytes(buffer)):
                if predicate(frame):
                    return frame, bytes(buffer)
        return None, bytes(buffer)

    def collect_modbus(self, predicate, timeout_ms: float):
        deadline = time.perf_counter() + timeout_ms / 1000.0
        buffer = bytearray()
        while time.perf_counter() < deadline and self.device is not None:
            report = self.read_report(15)
            if report is None:
                continue
            buffer += report[1:] if report and report[0] == IN_ID else report
            for frame in decode_modbus(bytes(buffer)):
                if predicate(frame):
                    return frame, bytes(buffer)
        return None, bytes(buffer)

    def drain(self, quiet_ms: float = 40.0):
        deadline = time.perf_counter() + quiet_ms / 1000.0
        seen = bytearray()
        while time.perf_counter() < deadline and self.device is not None:
            report = self.read_report(5)
            if report is None:
                continue
            deadline = time.perf_counter() + quiet_ms / 1000.0
            seen += report
        return bytes(seen)

    def send_frame(self, frame: bytes, gap_ms: float = 3.0):
        for report in split_reports(frame):
            self.device.write(report)
            if gap_ms > 0 and len(frame) > REPORT_PAYLOAD:
                time.sleep(gap_ms / 1000.0)

    def status_exchange(self, frame: bytes, timeout_ms: float, gap_ms: float = 3.0):
        self.drain(20)
        started = time.perf_counter()
        try:
            self.send_frame(frame, gap_ms)
        except Exception as error:
            return {"kind": "send-fail", "error": str(error)}
        reply, raw = self.collect(lambda f: f["status"] is not None or f["ack"] is not None, timeout_ms)
        elapsed = round((time.perf_counter() - started) * 1000)
        if reply is None:
            return {"kind": "timeout", "ms": elapsed, "raw": raw.hex(" ")[:200]}
        if reply["status"] is not None:
            return {"kind": "status", "value": reply["status"], "ms": elapsed}
        return {"kind": "ack", "value": reply["ack"], "ms": elapsed}

    def devinfo(self, timeout_ms: float = 1200.0):
        self.drain(20)
        try:
            self.send_frame(encode_sigma(0x06, bytes([0x00, 0x00, 0x0B, 0x00])))
        except Exception as error:
            return {"kind": "send-fail", "error": str(error)}
        reply, _ = self.collect(lambda f: f["cmd"] == 0x06 and len(f["data"]) >= 4, timeout_ms)
        if reply is None:
            return {"kind": "timeout"}
        words = [
            reply["data"][at] | (reply["data"][at + 1] << 8)
            for at in range(4, len(reply["data"]) - 1, 2)
        ]
        return {
            "kind": "devinfo",
            "words": [f"{w:04X}" for w in words],
            "asciiHighFirst": "".join(chr((w >> 8) & 0xFF) + chr(w & 0xFF) for w in words),
        }

    def modbus_read(self, addr: int, count: int, timeout_ms: float = 900.0):
        body = bytearray([0x00, 0x13, 0x00, 0x0A, (addr >> 8) & 0xFF, addr & 0xFF, (count >> 8) & 0xFF, count & 0xFF])
        crc = modbus_crc(body)
        body += bytes([crc & 0xFF, (crc >> 8) & 0xFF])
        self.drain(20)
        try:
            self.send_frame(bytes(body))
        except Exception as error:
            return {"kind": "send-fail", "error": str(error)}
        reply, _ = self.collect_modbus(lambda f: f["func"] == 0x13, timeout_ms)
        if reply is None:
            return {"kind": "timeout"}
        data = reply["data"]
        values = [(data[at] << 8) | data[at + 1] for at in range(4, len(data) - 1, 2)]
        return {"kind": "ok", "values": [f"{v:04X}" for v in values]}


# ---------------------------------------------------------------- commands
def cmd_state(session: Session) -> dict:
    out: dict = {}
    if not session.open(wait_seconds=2.0):
        return {"error": "设备不在列/打不开", "detail": session.target_info}
    out["product"] = session.target_info.get("product")
    out["hidVersion"] = session.target_info.get("version")

    reply = session.modbus_read(0x0000, 0x000F)
    out["modbus"] = reply
    if reply["kind"] == "ok":
        words = [int(v, 16) for v in reply["values"]]
        out["mode"] = "MainApp"
        out["version"] = f"{words[11]}.{words[12]}.{words[13]}.{words[14]}" if len(words) > 14 else "?"
    time.sleep(0.15)
    info = session.devinfo()
    out["devinfo"] = info
    if info["kind"] == "devinfo" and out.get("mode") != "MainApp":
        out["mode"] = "Bootloader"
    out.setdefault("mode", "unknown(无应答)")
    return out


def cmd_enter(session: Session, wait_seconds: float = 20.0) -> dict:
    out: dict = {}
    if not session.open(wait_seconds=2.0):
        return {"error": "设备不在列/打不开"}
    session.drain(40)
    try:
        session.send_frame(ENTER_FRAME)
    except Exception as error:
        out["sendError"] = str(error)
    ack, _ = session.collect_modbus(lambda f: f["func"] == 0x02, 1200)
    out["ack"] = None if ack is None else f"0x{((ack['data'][0] << 8) | ack['data'][1]):04X}"
    session.log({"kind": "enter-ack", "value": out["ack"]})

    session.close()
    started = time.time()
    # 协议 §3.2：ACK 之后 MainApp 还要静音/关 UI 再写状态字节，约 200 ms 才复位；
    # 太早重开只会抓到正在掉线的旧句柄（ReadFile 报 1167）。
    time.sleep(1.2)
    deadline = started + wait_seconds
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        if session.open(wait_seconds=0.0):
            info = session.devinfo(1200)
            if info["kind"] == "devinfo":
                out["reenumerated"] = True
                out["reopen_ms"] = round((time.time() - started) * 1000)
                out["devinfo"] = info
                out["attempts"] = attempt
                session.log({"kind": "reenumerated", "ms": out["reopen_ms"], "devinfo": info})
                return out
            session.close()
        time.sleep(0.3)
    out["reenumerated"] = False
    out["error"] = "等不到 Bootloader（重新枚举后仍不应答 DevInfo）"
    return out


def cmd_flash(session: Session, package: dict, chunk: int, gap_ms: float, post_ms: float, timeout_ms: int, retries: int = 4) -> dict:
    out: dict = {"chunks": [], "bytes": 0}
    if not session.open(wait_seconds=3.0):
        return {"error": "设备不在列/打不开"}

    precheck = session.devinfo(1200)
    out["precheck"] = precheck
    session.log({"kind": "precheck", "value": precheck})
    if precheck["kind"] != "devinfo":
        out["error"] = "Bootloader 不应答 DevInfo（设备可能已挂死，需要拔插上电）"
        return out

    info_raw = package["info_frame"]["raw"]
    result = session.status_exchange(info_raw, 3000)
    out["info"] = result
    session.log({"kind": "info", "value": result})
    if result.get("kind") == "status" and result.get("value") == 0x01:
        info_raw = patched_info_frame(package["info_frame"], b"000000")
        result = session.status_exchange(info_raw, 3000)
        out["infoPatched"] = result
        session.log({"kind": "info-patched", "value": result})
    if not (result.get("kind") == "status" and result.get("value") == 0x03):
        out["error"] = "信息帧未被接受"
        return out
    out["infoAccepted"] = True

    stream = package["stream"]
    total = len(stream)
    started = time.perf_counter()
    index = 0
    written = 0
    last_status = None
    # 设备在 DfuProgram 里先 DataCount += len 再写 Flash；写失败时地址不前进，
    # 所以重发同一块会让 DataCount 多算 64 B，最终提前 64*N 字节判定"收齐"→ 0x04。
    # 补偿办法：最后一块一次性发完剩余的 896 B（因为 0x30480-896 = 0x30100 是 256 对齐，
    # HalSpiFlashWrite 的页切分不会回绕），DataCount 变成 164992+64N 仍 ≥ 长度，
    # 而实际写入的 164992 B 与校验和全部正确。
    final_len = chunk * 14
    while written < total:
        remaining = total - written
        length = remaining if (remaining <= final_len and remaining % 256 == 128) else chunk
        piece = stream[written : written + length]
        frame = encode_sigma(0x0B, b"\x03\x00" + piece)
        # 0x02 = 设备写失败或 1 s 断流（主循环被擦除卡住时两者都长这样）。
        # 设备在 IapAddress 前进之前就 return，所以重发同一块是安全的；
        # 实测 4 KB 扇区擦除会偶发 0x02，重发通常立刻过。
        tries = 0
        while True:
            result = session.status_exchange(frame, timeout_ms, gap_ms)
            if result.get("kind") == "status" and result["value"] == 0x02 and tries < retries:
                tries += 1
                session.log({"kind": "retry", "n": index + 1, "addr": f"0x{0x8000 + written:05X}", "try": tries})
                time.sleep(0.05)
                continue
            break
        index += 1
        address = 0x8000 + written
        if result["kind"] == "send-fail":
            out["error"] = f"块 {index} 发送失败：{result['error']}"
            out["device"] = "OUT 端点不再接收"
            break
        session.log(
            {
                "kind": "block",
                "n": index,
                "addr": f"0x{address:05X}",
                "len": length,
                "ms": result.get("ms"),
                "reply": result,
                "retries": tries,
            }
        )
        if result["kind"] != "status":
            out["error"] = f"块 {index}/{total // chunk} 无有效应答（{result['kind']}）@ 0x{address:05X}"
            out["lastRaw"] = result.get("raw", "")[:200]
            break
        last_status = result["value"]
        if index <= 2 or index % 100 == 0 or length != chunk:
            out["chunks"].append(
                {
                    "n": index,
                    "addr": f"0x{address:05X}",
                    "len": length,
                    "ms": result["ms"],
                    "elapsed": round(time.perf_counter() - started, 1),
                }
            )
        if result["value"] == 0x05:
            out["success"] = True
            out["doneAt"] = f"0x{address:05X}"
            out["blocks"] = index
            out["bytes"] = written + length
            break
        if result["value"] != 0x03:
            out["error"] = f"块 {index} 返回状态 0x{result['value']:02X} @ 0x{address:05X}"
            break
        written += length
        out["bytes"] = written
        out["retries"] = out.get("retries", 0) + tries
        if post_ms > 0:
            time.sleep(post_ms / 1000.0)
    out["elapsed"] = round(time.perf_counter() - started, 1)
    out["blocksSent"] = index
    out["lastStatus"] = last_status
    return out


def cmd_verify(session: Session, wait_seconds: float = 25.0) -> dict:
    session.close()
    started = time.time()
    if not session.open(wait_seconds=wait_seconds):
        return {"error": "升级后等不到设备重新枚举"}
    out = {"reopen_ms": round((time.time() - started) * 1000)}
    for attempt in range(1, 9):
        time.sleep(1.0)
        reply = session.modbus_read(0x0000, 0x000F)
        if reply["kind"] == "ok":
            words = [int(v, 16) for v in reply["values"]]
            out["mode"] = "MainApp"
            out["version"] = f"{words[11]}.{words[12]}.{words[13]}.{words[14]}"
            out["attempt"] = attempt
            return out
        info = session.devinfo(600)
        out[f"attempt{attempt}"] = info["kind"]
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["state", "enter", "flash", "flash-all", "verify", "package"])
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--chunk", type=int, default=64)
    parser.add_argument("--gap-ms", type=float, default=3.0)
    parser.add_argument("--post-ms", type=float, default=6.0)
    parser.add_argument("--timeout-ms", type=int, default=3000)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--log", default=None)
    args = parser.parse_args()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    log_path = args.log or os.path.join(os.getcwd(), f"dfu-{stamp}.jsonl")
    session = Session(log_path)
    summary: dict = {"command": args.command, "log": log_path}
    try:
        if args.command == "package":
            package = load_package(args.package)
            summary["package"] = {
                k: package[k]
                for k in ("bytes", "header_kind", "model_code", "version", "fw_length", "fw_checksum", "block_frames")
            }
            summary["package"]["stream"] = len(package["stream"])
            summary["package"]["enterFrame"] = package["enter_frame"].hex(" ")
            summary["package"]["infoFrameLen"] = len(package["info_frame"]["raw"])
            print(json.dumps(summary, ensure_ascii=False, indent=1))
            return 0
        if args.command in ("flash", "flash-all"):
            package = load_package(args.package)
            summary["package"] = {
                k: package[k]
                for k in ("bytes", "header_kind", "model_code", "version", "fw_length", "fw_checksum", "block_frames")
            }
            summary["package"]["stream"] = len(package["stream"])
            summary["params"] = {
                "chunk": args.chunk,
                "gap_ms": args.gap_ms,
                "post_ms": args.post_ms,
                "timeout_ms": args.timeout_ms,
            }
        if args.command == "state":
            summary["state"] = cmd_state(session)
        elif args.command == "enter":
            summary["enter"] = cmd_enter(session)
        elif args.command == "flash":
            summary["flash"] = cmd_flash(session, package, args.chunk, args.gap_ms, args.post_ms, args.timeout_ms, args.retries)
            if summary["flash"].get("success"):
                summary["verify"] = cmd_verify(session)
        elif args.command == "flash-all":
            summary["enter"] = cmd_enter(session)
            if summary["enter"].get("reenumerated"):
                summary["flash"] = cmd_flash(session, package, args.chunk, args.gap_ms, args.post_ms, args.timeout_ms, args.retries)
                if summary["flash"].get("success"):
                    summary["verify"] = cmd_verify(session)
            else:
                summary["error"] = "进入 DFU 失败"
        elif args.command == "verify":
            summary["verify"] = cmd_verify(session)
    except Exception as error:  # noqa: BLE001
        summary["error"] = f"{type(error).__name__}: {error}"
        summary["traceback"] = traceback.format_exc()
    finally:
        session.close()
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
