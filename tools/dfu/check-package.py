#!/usr/bin/env python3
"""DFU 升级包 ↔ 厂商 hex 对照检查（刷写前的最后一道门禁）。

为什么要这个工具：2026-11-21 的 V0.0.6 界面升级「658/658 块全部 ACK」却起不来，
事后只能靠 SWD 救。设备侧 CRC 只能告诉我们"镜像不完整"，不能说明是谁写坏的。
把包解析出的明文载荷和 hex 里同一段 App 区逐字节比，才能区分：
  1) 包本身与 hex 不一致（固件方导出错，主机怎么写都没救）；
  2) 包没问题（那就只能是链路/设备侧擦写问题）。

用法：
  python tools/dfu/check-package.py --package "<dfu .bin>" [--hex "<firmware .hex>"]
                                    [--app-base 0x8000] [--max-bytes 0x30000]

不带 --hex 时只做包自检（结构 / 长度 / 校验和），打印解析结果。
退出码：0 = 一致或仅自检通过；1 = 发现不一致或包自检失败。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field

SIGMA_START = 0xC4
SIGMA_CMD_DFU = 0x0B
DFU_CMD_INFO = 0x02
DFU_CMD_BLOCK = 0x03
MODBUS_FUNC_RAND_WRITE = 0x10
GAMMA_KEY_BYTES = (0x63, 0xBB, 0x9C, 0x1C)
GAMMA_BIAS = 0xA3
GAMMA_BYTES = 8192
BLOCK_BYTES = 256
WORD_BYTES = 4


def hex32(value: int) -> str:
    return f"0x{value & 0xFFFFFFFF:08X}"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sigma_crc(data: bytes) -> int:
    total = sum(data) & 0xFFFF
    return ((~total & 0xFFFF) + 1) & 0xFFFF


def modbus_crc(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def nibble_swap(value: int) -> int:
    return ((value << 4) & 0xF0) | ((value >> 4) & 0x0F)


def gamma_decrypt(payload: bytes) -> bytes:
    """前 min(len, 8192) 字节是 Gamma 密文，按 4 字节粒度做逆变换，之后原样。"""
    out = bytearray(payload)
    limit = min(len(payload), GAMMA_BYTES) & ~3
    for i in range(limit):
        out[i] = nibble_swap((payload[i] - GAMMA_BIAS) & 0xFF) ^ GAMMA_KEY_BYTES[i % WORD_BYTES]
    return bytes(out)


def sum32_le_words(data: bytes) -> int:
    total = 0
    for i in range(0, len(data) - 3, 4):
        total = (total + int.from_bytes(data[i:i + 4], "little")) & 0xFFFFFFFF
    return total


@dataclass
class Package:
    header_kind: str
    header_size: int
    model_code: str
    model_name: str
    version: tuple[int, int, int]
    length: int
    checksum: int
    block_count: int
    block_sizes: list[int]
    plain: bytes
    computed_checksum: int
    problems: list[str] = field(default_factory=list)


def parse_package(path: str) -> Package:
    raw = open(path, "rb").read()
    problems: list[str] = []

    if len(raw) >= 3 and raw[0] == SIGMA_START:
        size = raw[1] | (raw[2] << 8)
        if size < 9 or size > 1022:
            raise SystemExit(f"包首 SigmaBus 帧长度非法: {size}")
        if sigma_crc(raw[:size - 2]) != int.from_bytes(raw[size - 2:size], "little"):
            raise SystemExit("包首 SigmaBus 帧 CRC 错")
        header_kind, header_size = "sigma", size
    elif len(raw) >= 8 and raw[1] == MODBUS_FUNC_RAND_WRITE:
        size = (raw[2] << 8) | raw[3]
        if modbus_crc(raw[:size - 2]) != int.from_bytes(raw[size - 2:size], "little"):
            raise SystemExit("包首 Modbus 帧 CRC 错")
        header_kind, header_size = "modbus", size
    else:
        raise SystemExit("包首既不是 SigmaBus 0x0B 也不是 Modbus 0x10，不是 DFU 包")

    pos = header_size
    frames: list[tuple[int, bytes]] = []
    while pos < len(raw):
        if raw[pos] != SIGMA_START:
            problems.append(f"偏移 {pos} 处期待 0xC4，实际 0x{raw[pos]:02X}")
            break
        if pos + 3 > len(raw):
            problems.append(f"偏移 {pos} 处帧头被截断")
            break
        length = raw[pos + 1] | (raw[pos + 2] << 8)
        if length < 9 or pos + length > len(raw):
            problems.append(f"偏移 {pos} 处帧长度 {length} 非法/越界")
            break
        if sigma_crc(raw[pos:pos + length - 2]) != int.from_bytes(raw[pos + length - 2:pos + length], "little"):
            problems.append(f"偏移 {pos} 处帧 CRC 错")
            break
        addr = raw[pos + 3]
        cmd = raw[pos + 4] & 0x7F
        data = raw[pos + 5:pos + length - 2]
        if addr != 0:
            problems.append(f"偏移 {pos} 处帧地址 {addr} != 0")
        frames.append((cmd, data))
        pos += length

    if not frames:
        raise SystemExit("包内没有任何 SigmaBus 帧")

    cmd0, data0 = frames[0]
    if cmd0 != SIGMA_CMD_DFU or not data0 or data0[0] != DFU_CMD_INFO:
        raise SystemExit("第二帧不是固件信息帧（DFU_CMD_INFO）")

    body = data0[2:]
    if len(body) not in (81, 85):
        raise SystemExit(f"信息帧载荷 {len(body)} B，不是 81 / 85")
    model_code = body[0:6].decode("ascii", "replace").rstrip("\x00")
    model_name = body[6:70].decode("ascii", "replace").rstrip("\x00")
    version = (body[70], body[71], body[72])
    length = int.from_bytes(body[73:77], "little")
    checksum = int.from_bytes(body[77:81], "little")

    block_sizes: list[int] = []
    payload = bytearray()
    for index, (cmd, data) in enumerate(frames[1:], start=1):
        if cmd != SIGMA_CMD_DFU or len(data) < 3 or data[0] != DFU_CMD_BLOCK:
            problems.append(f"第 {index} 帧不是数据块（cmd=0x{cmd:02X} data0=0x{data[0]:02X}）")
            break
        chunk = data[2:]
        if len(chunk) > BLOCK_BYTES:
            problems.append(f"第 {index} 块 {len(chunk)} B 超过 {BLOCK_BYTES}")
        block_sizes.append(len(chunk))
        payload += chunk

    for index, size in enumerate(block_sizes[:-1]):
        if size != BLOCK_BYTES:
            problems.append(f"第 {index} 块 {size} B，非末块应为 {BLOCK_BYTES}")
            break
    if block_sizes and block_sizes[-1] % WORD_BYTES:
        problems.append(f"末块 {block_sizes[-1]} B 不是 {WORD_BYTES} 的整数倍")

    if length != len(payload):
        problems.append(f"信息帧声明长度 {length} != 块合计 {len(payload)}")
    if length > 0x30000:
        problems.append(f"声明长度 {length} 超过 App 区上限 0x30000")

    cipher = bytes(payload)
    plain = gamma_decrypt(cipher)
    computed = sum32_le_words(plain)
    if computed != checksum:
        problems.append(f"校验和 {hex32(checksum)} != 明文实算 {hex32(computed)}")

    return Package(
        header_kind=header_kind,
        header_size=header_size,
        model_code=model_code,
        model_name=model_name,
        version=version,
        length=length,
        checksum=checksum,
        block_count=len(block_sizes),
        block_sizes=block_sizes,
        plain=plain,
        computed_checksum=computed,
        problems=problems,
    )


def parse_ihex(path: str) -> dict[int, int]:
    memory: dict[int, int] = {}
    base = 0
    for lineno, line in enumerate(open(path, "r", encoding="utf-8", errors="replace"), start=1):
        line = line.strip()
        if not line:
            continue
        if not line.startswith(":"):
            raise SystemExit(f"{path}:{lineno} 不是 Intel HEX 记录")
        record = bytes.fromhex(line[1:])
        if len(record) < 5:
            raise SystemExit(f"{path}:{lineno} 记录过短")
        if sum(record) & 0xFF:
            raise SystemExit(f"{path}:{lineno} 记录校验和错")
        count, addr, rectype = record[0], (record[1] << 8) | record[2], record[3]
        data = record[4:4 + count]
        if rectype == 0x00:
            for offset, byte in enumerate(data):
                memory[base + addr + offset] = byte
        elif rectype == 0x01:
            break
        elif rectype == 0x02:
            base = int.from_bytes(data, "big") << 4
        elif rectype == 0x04:
            base = int.from_bytes(data, "big") << 16
        elif rectype in (0x03, 0x05):
            continue
        else:
            raise SystemExit(f"{path}:{lineno} 未知记录类型 0x{rectype:02X}")
    return memory


def main() -> int:
    parser = argparse.ArgumentParser(description="DFU 包与厂商 hex 对照检查")
    parser.add_argument("--package", required=True)
    parser.add_argument("--hex")
    parser.add_argument("--app-base", default="0x8000")
    parser.add_argument("--max-bytes", default="0x30000")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    app_base = int(args.app_base, 0)
    max_bytes = int(args.max_bytes, 0)

    pkg = parse_package(args.package)
    report: dict[str, object] = {
        "package": {
            "path": args.package,
            "sha256": sha256(open(args.package, "rb").read()),
            "headerKind": pkg.header_kind,
            "headerSize": pkg.header_size,
            "modelCode": pkg.model_code,
            "modelName": pkg.model_name,
            "version": ".".join(str(v) for v in pkg.version),
            "length": pkg.length,
            "blocks": pkg.block_count,
            "checksum": hex32(pkg.checksum),
            "computedChecksum": hex32(pkg.computed_checksum),
            "payloadSha256": sha256(pkg.plain),
        },
        "problems": list(pkg.problems),
    }

    print(f"包: {args.package}")
    print(f"  形态 {pkg.header_kind} ({pkg.header_size} B) / {pkg.model_code} / {pkg.model_name} / "
          f"{'.'.join(str(v) for v in pkg.version)}")
    print(f"  声明长度 {pkg.length} B / {pkg.block_count} 块（末块 {pkg.block_sizes[-1] if pkg.block_sizes else 0} B）"
          f" / 校验和 {hex32(pkg.checksum)}（实算 {hex32(pkg.computed_checksum)}）")
    print(f"  载荷 sha256 {sha256(pkg.plain)}")
    for problem in pkg.problems:
        print(f"  [!] {problem}")

    exit_code = 1 if pkg.problems else 0

    if args.hex:
        memory = parse_ihex(args.hex)
        region = bytes(memory.get(app_base + i, 0xFF) for i in range(min(pkg.length, max_bytes)))
        report["hex"] = {
            "path": args.hex,
            "sha256": sha256(open(args.hex, "rb").read()),
            "minAddr": hex32(min(memory)) if memory else None,
            "maxAddr": hex32(max(memory)) if memory else None,
            "appRegionSha256": sha256(region),
            "appRegionBytes": sum(1 for i in range(app_base, app_base + max_bytes) if i in memory),
        }
        print(f"hex: {args.hex}")
        print(f"  覆盖地址 {report['hex']['minAddr']}..{report['hex']['maxAddr']} / "
              f"App 区(0x{app_base:X}+) {report['hex']['appRegionBytes']} B")
        print(f"  App 区 sha256 {sha256(region)}")

        if len(region) != len(pkg.plain):
            print(f"  [!] 长度不一致：包 {len(pkg.plain)} B，hex 取 {len(region)} B")
            exit_code = 1
            report["match"] = False
        else:
            mismatches = [i for i in range(len(region)) if region[i] != pkg.plain[i]]
            report["match"] = not mismatches
            report["mismatchCount"] = len(mismatches)
            if mismatches:
                first = mismatches[0]
                exit_code = 1
                print(f"  [!] 不一致 {len(mismatches)} 字节，首个偏移 +0x{first:X} "
                      f"(地址 0x{app_base + first:05X})：包 0x{pkg.plain[first]:02X} vs hex 0x{region[first]:02X}")
                report["firstMismatch"] = {"offset": first, "addr": hex32(app_base + first),
                                           "package": pkg.plain[first], "hex": region[first]}
                around = range(max(0, first - 8), min(len(region), first + 8))
                print("    包: " + " ".join(f"{pkg.plain[i]:02X}" for i in around))
                print("    hex:" + " ".join(f"{region[i]:02X}" for i in around))
            else:
                print("  [OK] 包载荷与 hex 的 App 区逐字节一致")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=1)
        print(f"报告: {args.json_out}")

    print("结论: " + ("一致/通过" if exit_code == 0 else "存在问题"))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
