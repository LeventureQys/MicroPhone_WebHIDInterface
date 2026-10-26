/**
 * 固件镜像层（Bootloader DFU）：.bin 解析、Gamma 加解密、32 位小端字累加和、长度上界。
 *
 * 设备侧没有任何长度校验（DFU 材料 §6 ⑦），写超 0x30000 会覆盖 0x38000 状态字节与 0x39000 型号区，
 * 后者只能 SWD 救 —— 所以能变砖的输入必须在这里挡住，`parseImage` 拒绝即代表一个字节都不能发。
 *
 * 校验和的名字叫 "CRC-32"，实现是 32 位小端字累加和（DFU 材料 §4.2），作用在**解密后**的明文上。
 *
 * 包首「进入 DFU」帧有两种形态都要收（协议《DFU固件升级通讯协议说明_20261026》§3.1）：
 * 旧打包脚本的 SigmaBus 帧，与 2026-10-26 起换成参数协议 `0x10` 写 `0x1008=1` 的新帧。
 * 之后的 Info/Block 帧仍是 Bootloader 的 SigmaBus 格式，不随触发帧改变。
 *
 * 纯计算：不依赖运行环境，可在单测里直接调用。
 */
import {
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  MAX_SIGMA_FRAME,
  SIGMA_CMD_DFU,
  SIGMA_START,
  decodeSigmaStream,
  encodeDfuBlockFrame,
  encodeDfuInfoFrame,
  sigmaCrc,
} from './frame';
import type { SigmaFrame } from './frame';
import { crc16 } from '../proto/crc';

export interface DfuInfo {
  /** 6 字节 ASCII：`000000` = 通用镜像，`Bootld` = 刷 Bootloader。 */
  readonly modelCode: string;
  /** 64 字节 ASCII，尾部 0x00 已去掉；设备侧不校验。 */
  readonly modelName: string;
  readonly version: { readonly x: number; readonly y: number; readonly z: number };
  /** FwLength，本次要写的总字节数。 */
  readonly length: number;
  /** FwChecksum，对明文算的 32 位小端字累加和。 */
  readonly checksum: number;
}

export interface ParsedImage {
  readonly info: DfuInfo;
  /** 包首「进入 DFU」帧的形态：SigmaBus（旧打包脚本）或 Modbus（协议 1026 起的新脚本） */
  readonly headerKind: PackageHeaderKind;
  /** 每块 ≤ 256 B，**密文形态**（与包内块帧载荷逐字节一致，可直接重发）。 */
  readonly blocks: readonly Uint8Array[];
  /** 全部块按顺序拼接后的密文（前 min(len,8192) 字节是 Gamma 密文，之后是明文）。 */
  readonly cipher: Uint8Array;
  /** 对 cipher 做 Gamma 逆变换后的明文,设备写进 Flash 的就是这些字节。 */
  readonly plain: Uint8Array;
  /** 包内原始帧字节（首帧是 EnterDfu，之后 Info + 块），用于与编码结果逐字节对拍。 */
  readonly frames: readonly Uint8Array[];
}

export type PackageHeaderKind = 'sigma' | 'modbus';

export type ImageProblem =
  | 'frame'
  | 'crc'
  | 'infoCount'
  | 'blockSize'
  | 'lengthMismatch'
  | 'checksumMismatch'
  | 'limitExceeded'
  | 'modelMissing'
  | 'notAligned';

export interface ImageRejection {
  readonly problem: ImageProblem;
  /** 简短英文技术文案，界面负责翻译。 */
  readonly message: string;
  readonly detail?: Readonly<Record<string, number | string>>;
}

export const GAMMA_KEY = 0x1c9cbb63;
export const GAMMA_BYTES = 8192;
export const BLOCK_BYTES = 256;
export const APP_MAX_BYTES = 0x30000;
export const BOOT_MAX_BYTES = 0x8000;
export const BOOT_MODEL_CODE = 'Bootld';

/** GAMMA_KEY 的小端字节序，与设备侧 `key >> (8*j)` 一致。 */
const GAMMA_KEY_BYTES = [0x63, 0xbb, 0x9c, 0x1c] as const;
const GAMMA_BIAS = 0xa3;

const SIGMA_CMD_PARAM_WRITE = 0x03;
const MODBUS_FUNC_RAND_WRITE = 0x10;
const ENTER_DFU_ADDR = 0x1008;
const ENTER_DFU_PAYLOAD = [0x08, 0x10, 0x01, 0x00] as const;
const INFO_PAYLOAD_BYTES = 81;
/** 协议文档《DFU固件升级通讯协议说明_20261026》记的 85 B：尾部多 4 B，设备只读前 81 B，两种都收 */
const INFO_PAYLOAD_BYTES_DOC = 85;
const MODEL_CODE_BYTES = 6;
const MODEL_NAME_BYTES = 64;
const WORD_BYTES = 4;

type ParseResult = { readonly ok: true; readonly image: ParsedImage } | { readonly ok: false; readonly rejection: ImageRejection };

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function nibbleSwap(value: number): number {
  return ((value << 4) & 0xf0) | ((value >> 4) & 0x0f);
}

/**
 * 只处理前 min(len, 8192) 字节，且按 4 字节粒度：尾部不足 4 字节既不参与运算，也保证不了正确性
 * （设备侧 `len/4` 同样截断）。
 */
export function gammaDecrypt(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  const limit = Math.min(bytes.length, GAMMA_BYTES) & ~3;
  for (let i = 0; i < limit; i += 1) {
    out[i] = nibbleSwap((bytes[i] - GAMMA_BIAS) & 0xff) ^ GAMMA_KEY_BYTES[i % WORD_BYTES];
  }
  return out;
}

export function gammaEncrypt(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  const limit = Math.min(bytes.length, GAMMA_BYTES) & ~3;
  for (let i = 0; i < limit; i += 1) {
    out[i] = (nibbleSwap(bytes[i] ^ GAMMA_KEY_BYTES[i % WORD_BYTES]) + GAMMA_BIAS) & 0xff;
  }
  return out;
}

/** 32 位小端字累加（DFU 材料 §4.2）：`s = (s + u32le) >>> 0`，尾部不足 4 字节不参与。 */
export function sum32LittleEndianWords(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i + WORD_BYTES <= bytes.length; i += WORD_BYTES) {
    const word = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function reject(
  problem: ImageProblem,
  message: string,
  detail?: Readonly<Record<string, number | string>>,
): { readonly ok: false; readonly rejection: ImageRejection } {
  return { ok: false, rejection: detail ? { problem, message, detail } : { problem, message } };
}

function readAscii(bytes: Uint8Array, offset: number, width: number): string {
  let text = '';
  for (let i = 0; i < width; i += 1) text += String.fromCharCode(bytes[offset + i]);
  return text.replace(/\0+$/, '');
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeInfo(data: Uint8Array): DfuInfo {
  const body = data.subarray(2);
  return {
    modelCode: readAscii(body, 0, MODEL_CODE_BYTES),
    modelName: readAscii(body, MODEL_CODE_BYTES, MODEL_NAME_BYTES),
    version: {
      x: body[MODEL_CODE_BYTES + MODEL_NAME_BYTES],
      y: body[MODEL_CODE_BYTES + MODEL_NAME_BYTES + 1],
      z: body[MODEL_CODE_BYTES + MODEL_NAME_BYTES + 2],
    },
    length: readUint32Le(body, MODEL_CODE_BYTES + MODEL_NAME_BYTES + 3),
    checksum: readUint32Le(body, MODEL_CODE_BYTES + MODEL_NAME_BYTES + 3 + WORD_BYTES),
  };
}

function isPrintableModelCode(data: Uint8Array): boolean {
  for (let i = 0; i < MODEL_CODE_BYTES; i += 1) {
    const byte = data[2 + i];
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

/**
 * 识别包首的「进入 DFU」帧，返回形态与字节数；不是已知形态返回 null。
 *
 * 两种形态并存（协议《DFU固件升级通讯协议说明_20261026》§3.1）：
 * - `sigma`：旧打包脚本的 `C4 0B 00 00 03 08 10 01 00 15 FF`（SigmaBus 随机写 0x1008=1）；
 * - `modbus`：2026-10-26 起的新脚本把它换成参数协议帧 `00 10 00 0A 10 08 00 01 8D 09`。
 * 触发帧只影响"怎么让设备进 Bootloader"，本仓始终自己重建 Modbus 帧发送，
 * 这里只校验包结构不把坏包当成升级包。
 */
function detectPackageHeader(bytes: Uint8Array): { readonly kind: PackageHeaderKind; readonly size: number } | null {
  if (bytes.length >= 3 && bytes[0] === SIGMA_START) {
    const size = bytes[1] | (bytes[2] << 8);
    if (size < 9 || size > MAX_SIGMA_FRAME || size > bytes.length) return null;
    if (bytes[3] !== 0 || bytes[4] !== SIGMA_CMD_PARAM_WRITE) return null;
    const received = bytes[size - 2] | (bytes[size - 1] << 8);
    if (sigmaCrc(bytes.subarray(0, size - 2)) !== received) return null;
    const payload = bytes.subarray(5, size - 2);
    if (payload.length !== ENTER_DFU_PAYLOAD.length) return null;
    for (let i = 0; i < ENTER_DFU_PAYLOAD.length; i += 1) {
      if (payload[i] !== ENTER_DFU_PAYLOAD[i]) return null;
    }
    return { kind: 'sigma', size };
  }

  // Modbus 帧：UnitID + Func + Len(大端) + Data + CRC(低字节先发)；进入 DFU 恰为 DataLen 4
  if (bytes.length >= 8 && bytes[1] === MODBUS_FUNC_RAND_WRITE) {
    const size = (bytes[2] << 8) | bytes[3];
    if (size !== ENTER_DFU_PAYLOAD.length + 6 || size > bytes.length) return null;
    const received = bytes[size - 2] | (bytes[size - 1] << 8);
    if (crc16(bytes.subarray(0, size - 2)) !== received) return null;
    const addr = (bytes[4] << 8) | bytes[5];
    const value = (bytes[6] << 8) | bytes[7];
    if (addr !== ENTER_DFU_ADDR || value === 0) return null;
    return { kind: 'modbus', size };
  }

  return null;
}

/**
 * 已确认 decodeSigmaStream 无 issue 且无残余字节，所以这里按每帧 LEN 依次切片一定落在帧边界上；
 * 保留原始字节是为了和编码结果逐字节对拍（cmd 的 bit7 归一化会丢信息，重编码不再等价）。
 */
function sliceRawFrames(bytes: Uint8Array, count: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let pos = 0;
  for (let i = 0; i < count; i += 1) {
    const length = bytes[pos + 1] | (bytes[pos + 2] << 8);
    frames.push(bytes.slice(pos, pos + length));
    pos += length;
  }
  return frames;
}

/**
 * 解析厂商升级包（EnterDfu + Info + N×Block）。**不抛异常**：任何拒绝都走 `{ ok:false }`。
 * 校验顺序固定为「结构 → 信息帧位置 → 块长度/对齐 → modelMissing → limitExceeded → lengthMismatch → checksumMismatch」，
 * 即先结构后内容、先上界后长度一致性、先长度后校验和（SubStage_4.1 §4.2 / 设计文档 §5.10）。
 */
export function parseImage(bytes: Uint8Array): ParseResult {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return reject('frame', 'package is empty', { size: 0 });
  }

  // 先拷成裸 Uint8Array：Buffer.prototype.slice 返回的是共享视图，会让 blocks/frames 悄悄指向调用方的缓冲区。
  const source = new Uint8Array(bytes);
  const header = detectPackageHeader(source);
  if (header === null) {
    return reject('frame', 'package does not start with an EnterDfu header (SigmaBus 0x03 or Modbus 0x10 write 0x1008)');
  }
  const body = source.subarray(header.size);
  const decoded = decodeSigmaStream(body);
  const crcIssue = decoded.issues.find((issue) => issue.problem === 'crc');
  if (crcIssue) {
    return reject('crc', `frame at offset ${crcIssue.offset} failed sigma crc`, { offset: crcIssue.offset + header.size });
  }
  if (decoded.issues.length > 0) {
    const first = decoded.issues[0];
    return reject('frame', `frame at offset ${first.offset + header.size}: ${first.detail}`, {
      offset: first.offset + header.size,
    });
  }
  if (decoded.rest.length > 0) {
    return reject('frame', `package ends with ${decoded.rest.length} unmatched bytes`, { rest: decoded.rest.length });
  }

  const frames = decoded.frames;
  if (frames.length === 0) return reject('infoCount', 'package contains no firmware info frame');

  const infoIndexes: number[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame.cmd === SIGMA_CMD_DFU && frame.data.length > 0 && frame.data[0] === DFU_CMD_INFO) {
      infoIndexes.push(i);
    }
  }
  if (infoIndexes.length === 0) return reject('infoCount', 'package contains no firmware info frame');
  if (infoIndexes.length > 1) {
    return reject('infoCount', `package contains ${infoIndexes.length} firmware info frames`, {
      count: infoIndexes.length,
    });
  }
  if (infoIndexes[0] !== 0) {
    // 报包内序号（含 EnterDfu 头，1 起），与"包内第几帧"的直觉一致
    const index = infoIndexes[0] + 1;
    return reject('frame', `firmware info frame is at index ${index}, expected 1 (right after the EnterDfu header)`, {
      index,
    });
  }

  const infoFrame = frames[0];
  const infoBytes = infoFrame.data.length - 2;
  if (infoBytes !== INFO_PAYLOAD_BYTES && infoBytes !== INFO_PAYLOAD_BYTES_DOC) {
    return reject(
      'infoCount',
      `firmware info frame carries ${infoBytes} bytes, expected ${INFO_PAYLOAD_BYTES} (or ${INFO_PAYLOAD_BYTES_DOC} per protocol doc)`,
      { length: infoBytes },
    );
  }

  const blockFrames: SigmaFrame[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame.cmd !== SIGMA_CMD_DFU || frame.data.length < 3 || frame.data[0] !== DFU_CMD_BLOCK) {
      return reject('frame', `frame at index ${i + 1} is not a firmware data block`, { index: i + 1 });
    }
    blockFrames.push(frame);
  }
  if (blockFrames.length === 0) return reject('frame', 'package contains no firmware data block');

  const sizes = blockFrames.map((frame) => frame.data.length - 2);
  for (let i = 0; i < sizes.length; i += 1) {
    const isLast = i === sizes.length - 1;
    if (sizes[i] > BLOCK_BYTES || (!isLast && sizes[i] !== BLOCK_BYTES)) {
      return reject('blockSize', `block ${i} carries ${sizes[i]} bytes, expected ${BLOCK_BYTES}`, {
        index: i,
        size: sizes[i],
        expected: BLOCK_BYTES,
      });
    }
  }
  for (let i = 0; i < sizes.length; i += 1) {
    if (sizes[i] % WORD_BYTES !== 0) {
      return reject('notAligned', `block ${i} carries ${sizes[i]} bytes, not a multiple of ${WORD_BYTES}`, {
        index: i,
        size: sizes[i],
      });
    }
  }

  if (!isPrintableModelCode(infoFrame.data)) {
    return reject('modelMissing', 'firmware info frame carries a non printable model code', {
      modelCode: Array.from(infoFrame.data.subarray(2, 2 + MODEL_CODE_BYTES))
        .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
        .join(' '),
    });
  }

  const info = decodeInfo(infoFrame.data);
  const total = sizes.reduce((sum, size) => sum + size, 0);

  // 上界先于长度一致性：声明长度就超界时不必等收齐块，越早拒绝越安全（DFU 材料 §6⑦ 唯一的变砖路径）。
  const limit = info.modelCode === BOOT_MODEL_CODE ? BOOT_MAX_BYTES : APP_MAX_BYTES;
  if (info.length > limit) {
    return reject('limitExceeded', `firmware length ${info.length} exceeds ${limit} for model ${info.modelCode}`, {
      length: info.length,
      limit,
      modelCode: info.modelCode,
    });
  }

  if (info.length !== total) {
    return reject('lengthMismatch', `firmware length ${info.length} does not match ${total} bytes of blocks`, {
      length: info.length,
      actual: total,
    });
  }

  const blocks = blockFrames.map((frame) => frame.data.slice(2));
  const cipher = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    cipher.set(block, offset);
    offset += block.length;
  }
  const plain = gammaDecrypt(cipher);
  const checksum = sum32LittleEndianWords(plain);
  if (checksum !== info.checksum) {
    return reject(
      'checksumMismatch',
      `firmware checksum ${hex32(info.checksum)} does not match ${hex32(checksum)} computed over the decrypted image`,
      { expected: info.checksum, actual: checksum },
    );
  }

  return {
    ok: true,
    image: {
      info,
      headerKind: header.kind,
      blocks,
      cipher,
      plain,
      // frames[0] 保持"包首 EnterDfu 帧"的位置，两种形态都放在这里，索引语义不变
      frames: [source.slice(0, header.size), ...sliceRawFrames(body, frames.length)],
    },
  };
}

/** 与 frame.ts 的 `encodeDfuInfoFrame` 同一实现，镜像层对外用这个更短的名字。 */
export function encodeInfoFrame(info: DfuInfo): Uint8Array {
  return encodeDfuInfoFrame(info);
}

/** 与 frame.ts 的 `encodeDfuBlockFrame` 同一实现；`block` 传密文块（即 `ParsedImage.blocks[i]`）。 */
export function encodeBlockFrame(block: Uint8Array): Uint8Array {
  return encodeDfuBlockFrame(block);
}
