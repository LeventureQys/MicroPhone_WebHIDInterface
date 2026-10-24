/**
 * SigmaBus 帧层（Bootloader DFU 通道）。
 *
 * 帧格式（DFU 材料 §1.2）：C4 | LEN_L LEN_H | ADDR | CMD | DATA(LEN-7) | CRC_L CRC_H，
 * LEN 是整帧字节数，最小 9，最大 1022（设备侧 `Packet.Len < 1023`，超了状态机静默复位）。
 * SigmaCRC 是"16 位累加取反加一"，不是 CRC-16/CRC-32 —— 与参数协议的 Modbus CRC 毫无关系。
 *
 * 纯字节计算：不依赖运行环境与会话状态，可在单测里直接调用。
 */
import type { DfuInfo } from './image';

export const SIGMA_START = 0xc4;
export const SIGMA_CMD_DFU = 0x0b;
export const SIGMA_CMD_ACK = 0x02;
export const DFU_CMD_STATUS = 0x01;
export const DFU_CMD_INFO = 0x02;
export const DFU_CMD_BLOCK = 0x03;
export const DFU_STATUS_INFO_ERR = 0x01;
export const DFU_STATUS_CODE_ERR = 0x02;
export const DFU_STATUS_CONTINUE = 0x03;
export const DFU_STATUS_FAIL = 0x04;
export const DFU_STATUS_SUCCESS = 0x05;
export const SIGMA_ACK_DEV_ADDR_ERR = 0x0001;
export const SIGMA_ACK_LEN_ERR = 0x0002;
export const SIGMA_ACK_CHECKSUM_ERR = 0x0003;
export const MAX_SIGMA_FRAME = 1022;

/** 帧头 3 + ADDR 1 + CMD 1 + CRC 2 = 7；DFU 材料 §1.2 规定整帧不小于 9。 */
const SIGMA_OVERHEAD = 7;
const MIN_SIGMA_FRAME = 9;

/** 信息帧载荷：ModelCode 6 + ModelName 64 + Ver 3 + Length 4 + Checksum 4。 */
const INFO_PAYLOAD_BYTES = 81;
const MODEL_CODE_BYTES = 6;
const MODEL_NAME_BYTES = 64;

/** 数据块载荷上限；与 image.ts 的 BLOCK_BYTES 同值，此处独立定义避免 image ↔ frame 的运行时环。 */
const BLOCK_PAYLOAD_MAX = 256;

export interface SigmaFrame {
  readonly addr: number;
  /** 已做 `cmd & 0x7F`（DFU 材料 §1.2：CRC 通过后 bit7 被忽略）。 */
  readonly cmd: number;
  /** 载荷：DFU 帧里 data[0] = DFU_CMD，data[1] = CHIP_ID。 */
  readonly data: Uint8Array;
}

export type SigmaProblem = 'start' | 'length' | 'capacity' | 'crc' | 'addr';

export interface SigmaIssue {
  readonly problem: SigmaProblem;
  /** 帧首字节在本次输入缓冲区里的下标。 */
  readonly offset: number;
  readonly detail: string;
}

export interface SigmaDecodeResult {
  readonly frames: readonly SigmaFrame[];
  /** 尾部不足以构成一帧的残余字节，调用方应留到下一次喂入时再拼。 */
  readonly rest: Uint8Array;
  readonly issues: readonly SigmaIssue[];
}

function hex(value: number, width = 2): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

/** `((~(Σ bytes)) & 0xFFFF) + 1) & 0xFFFF`，发送时低字节在前。 */
export function sigmaCrc(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) sum += bytes[i];
  return ((~sum & 0xffff) + 1) & 0xffff;
}

/**
 * 载荷小于 2 字节时会生成解码侧判 `length` 失败的帧：编码侧不拦，
 * 重同步测试需要构造这种坏帧，默认 addr = 0（设备只认 0）。
 */
export function encodeSigmaFrame(cmd: number, data: Uint8Array, addr = 0): Uint8Array {
  const length = SIGMA_OVERHEAD + data.length;
  if (length > MAX_SIGMA_FRAME) {
    throw new RangeError(`sigma frame length ${length} exceeds ${MAX_SIGMA_FRAME}`);
  }
  const frame = new Uint8Array(length);
  frame[0] = SIGMA_START;
  frame[1] = length & 0xff;
  frame[2] = (length >> 8) & 0xff;
  frame[3] = addr;
  frame[4] = cmd;
  frame.set(data, 5);
  const crc = sigmaCrc(frame.subarray(0, length - 2));
  frame[length - 2] = crc & 0xff;
  frame[length - 1] = (crc >> 8) & 0xff;
  return frame;
}

/**
 * 逐帧切分字节流并重同步。设备把 HID 报告无脑塞进 FIFO（DFU 材料 §1.1），
 * 所以上位机必须自己从任意位置找回 0xC4 并丢弃坏帧，不能假设输入对齐。
 */
export function decodeSigmaStream(buffer: Uint8Array): SigmaDecodeResult {
  const frames: SigmaFrame[] = [];
  const issues: SigmaIssue[] = [];
  let pos = 0;

  while (pos < buffer.length) {
    if (buffer[pos] !== SIGMA_START) {
      issues.push({
        problem: 'start',
        offset: pos,
        detail: `expected start byte ${hex(SIGMA_START)}, got ${hex(buffer[pos])}`,
      });
      pos += 1;
      continue;
    }

    if (buffer.length - pos < 3) break;

    const length = buffer[pos + 1] | (buffer[pos + 2] << 8);
    if (length < MIN_SIGMA_FRAME) {
      issues.push({ problem: 'length', offset: pos, detail: `frame length ${length} < ${MIN_SIGMA_FRAME}` });
      pos += 1;
      continue;
    }
    if (length > MAX_SIGMA_FRAME) {
      issues.push({ problem: 'capacity', offset: pos, detail: `frame length ${length} > ${MAX_SIGMA_FRAME}` });
      pos += 1;
      continue;
    }
    if (length > buffer.length - pos) break;

    const addr = buffer[pos + 3];
    if (addr !== 0) {
      issues.push({ problem: 'addr', offset: pos, detail: `frame address ${addr} is not 0` });
      // 设备会整帧丢弃并回 0x0001，这里等价处理：不产出帧，直接跳过整帧。
      pos += length;
      continue;
    }

    const expected = buffer[pos + length - 2] | (buffer[pos + length - 1] << 8);
    const actual = sigmaCrc(buffer.subarray(pos, pos + length - 2));
    if (actual !== expected) {
      issues.push({
        problem: 'crc',
        offset: pos,
        detail: `sigma crc mismatch: frame says ${hex(expected, 4)}, bytes give ${hex(actual, 4)}`,
      });
      pos += 1;
      continue;
    }

    frames.push({
      addr,
      cmd: buffer[pos + 4] & 0x7f,
      data: buffer.slice(pos + 5, pos + length - 2),
    });
    pos += length;
  }

  return { frames, rest: buffer.slice(pos), issues };
}

function writeAscii(target: Uint8Array, offset: number, value: string, width: number, field: string): void {
  if (value.length > width) {
    throw new RangeError(`${field} ${JSON.stringify(value)} is longer than ${width} ASCII characters`);
  }
  for (let i = 0; i < width; i += 1) {
    // 其余字节留 0x00：设备侧不校验 ModelName，但出厂包的补齐方式就是 0x00。
    target[offset + i] = i < value.length ? value.charCodeAt(i) & 0xff : 0;
  }
}

/** 固件信息帧：载荷 83 B（DFU_CMD + CHIP_ID + 81），整帧 90 B。 */
export function encodeDfuInfoFrame(info: DfuInfo): Uint8Array {
  const data = new Uint8Array(2 + INFO_PAYLOAD_BYTES);
  data[0] = DFU_CMD_INFO;
  data[1] = 0x00;
  writeAscii(data, 2, info.modelCode, MODEL_CODE_BYTES, 'modelCode');
  writeAscii(data, 2 + MODEL_CODE_BYTES, info.modelName, MODEL_NAME_BYTES, 'modelName');
  let offset = 2 + MODEL_CODE_BYTES + MODEL_NAME_BYTES;
  data[offset] = info.version.x;
  data[offset + 1] = info.version.y;
  data[offset + 2] = info.version.z;
  offset += 3;
  writeUint32Le(data, offset, info.length);
  writeUint32Le(data, offset + 4, info.checksum);
  return encodeSigmaFrame(SIGMA_CMD_DFU, data);
}

function writeUint32Le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

/** 数据块帧：载荷 2 + n（n ∈ [1,256]），整帧 9 + n。 */
export function encodeDfuBlockFrame(data: Uint8Array): Uint8Array {
  if (data.length < 1 || data.length > BLOCK_PAYLOAD_MAX) {
    throw new RangeError(`dfu block length ${data.length} outside [1, ${BLOCK_PAYLOAD_MAX}]`);
  }
  const payload = new Uint8Array(2 + data.length);
  payload[0] = DFU_CMD_BLOCK;
  payload[1] = 0x00;
  payload.set(data, 2);
  return encodeSigmaFrame(SIGMA_CMD_DFU, payload);
}

/** 设备→主机状态帧 `C4 0A 00 00 0B 01 00 <status> CRC`：data[1] 是 CHIP_ID，status 在 data[2]。 */
export function decodeDfuStatus(frame: SigmaFrame): { readonly status: number } | null {
  if (frame.cmd !== SIGMA_CMD_DFU) return null;
  if (frame.data.length < 3 || frame.data[0] !== DFU_CMD_STATUS) return null;
  return { status: frame.data[2] };
}

/**
 * SigmaBus ACK 帧 `C4 09 00 00 02 <err_lo> <err_hi> CRC`：err 低字节在前。
 * 依据 DFU 材料 §2.5 的实测字节（`02 01 00` → DEV_ADDR_ERR 0x0001、`02 03 00` → CHECKSUM_ERR 0x0003），
 * 小端解读才与本文件导出的 SIGMA_ACK_* 常量自洽。
 */
export function decodeSigmaAck(frame: SigmaFrame): { readonly err: number } | null {
  if (frame.cmd !== SIGMA_CMD_ACK) return null;
  if (frame.data.length < 2) return null;
  return { err: frame.data[0] | (frame.data[1] << 8) };
}
