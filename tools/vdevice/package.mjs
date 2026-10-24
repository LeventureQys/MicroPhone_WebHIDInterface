/**
 * 厂商格式升级包生成器（测试夹具，R6-4）：把一段明文镜像打成
 * [EnterDfu 11 B][Info 90 B][Block 265 B]×N，与出厂包同构。
 *
 * 只服务于测试与自检脚本，不参与运行时；因此产物直接自检并抛错，
 * 而不是像上位机 parseImage 那样返回结构化拒绝。
 */

import {
  APP_MAX_BYTES,
  BLOCK_BYTES,
  CHIP_ID,
  CMD_DFU,
  CMD_PARAM_WRITE,
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  SIGMA_OVERHEAD,
  buildSigmaFrame,
  decodeSigmaFrames,
  gammaEncrypt,
  sigmaCrc,
  sum32Words,
} from './dfu-stack.mjs';

const ALIGN_BYTES = 4;
const MODEL_CODE_BYTES = 6;
const MODEL_NAME_BYTES = 64;
const INFO_PAYLOAD_BYTES = 81;
const CRC_BYTES = 2;
/** C4(1) + LEN(2) + ADDR(1) + CMD(1) + DFU_CMD(1) + CHIP_ID(1)：数据从帧偏移 7 开始 */
const DATA_OFFSET = SIGMA_OVERHEAD;
const LENGTH_IN_PAYLOAD = MODEL_CODE_BYTES + MODEL_NAME_BYTES + 3;
const CHECKSUM_IN_PAYLOAD = LENGTH_IN_PAYLOAD + 4;
const ENTER_DFU_DATA = Object.freeze([0x08, 0x10, 0x01, 0x00]);

function writeU32LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function writeAscii(target, offset, length, text) {
  for (let index = 0; index < length; index += 1) {
    target[offset + index] = index < text.length ? text.charCodeAt(index) & 0x7f : 0x00;
  }
}

function requireText(value, bytes, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  if (value.length > bytes) throw new RangeError(`${label} must be at most ${bytes} characters, got ${value.length}`);
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) throw new RangeError(`${label} must be printable ASCII, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Gamma 与累加校验和都是 4 字节粒度，不补零会让尾字节既不解密也不计校验和 */
function alignPlain(image) {
  const bytes = image instanceof Uint8Array ? image : Uint8Array.from(image ?? []);
  if (bytes.length === 0) throw new RangeError('image must not be empty');
  const plain = new Uint8Array(Math.ceil(bytes.length / ALIGN_BYTES) * ALIGN_BYTES);
  plain.set(bytes, 0);
  return plain;
}

/** 把明文按 256 B 切块（末块可短） */
function splitBlocks(bytes) {
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
    blocks.push(bytes.subarray(offset, Math.min(offset + BLOCK_BYTES, bytes.length)));
  }
  return blocks;
}

function encodeInfoFrame(info) {
  const payload = new Uint8Array(INFO_PAYLOAD_BYTES);
  writeAscii(payload, 0, MODEL_CODE_BYTES, info.modelCode);
  writeAscii(payload, MODEL_CODE_BYTES, MODEL_NAME_BYTES, info.modelName);
  payload[LENGTH_IN_PAYLOAD - 3] = info.version.x;
  payload[LENGTH_IN_PAYLOAD - 2] = info.version.y;
  payload[LENGTH_IN_PAYLOAD - 1] = info.version.z;
  writeU32LE(payload, LENGTH_IN_PAYLOAD, info.length);
  writeU32LE(payload, CHECKSUM_IN_PAYLOAD, info.checksum);
  return buildSigmaFrame(CMD_DFU, [DFU_CMD_INFO, CHIP_ID, ...payload]);
}

function resealCrc(frame) {
  const crc = sigmaCrc(frame.subarray(0, frame.length - CRC_BYTES));
  frame[frame.length - 2] = crc & 0xff;
  frame[frame.length - 1] = (crc >> 8) & 0xff;
}

function blockPayloadSize(frame) {
  return frame.length - DATA_OFFSET - CRC_BYTES;
}

/** 逐帧复算 SigmaCRC；打包自检与篡改工具共用，返回帧视图（改视图即改入参副本） */
export function verifyFrames(bytes) {
  const frames = decodeSigmaFrames(bytes);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const expected = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
    if (sigmaCrc(frame.subarray(0, frame.length - 2)) !== expected) {
      throw new Error(`frame ${index} has an invalid SigmaCRC`);
    }
  }
  return frames;
}

/**
 * 把一段明文镜像打成厂商格式升级包（EnterDfu + Info + N×Block）。
 * @param {{ image: Uint8Array, modelCode: string, modelName?: string, version?: {x:number,y:number,z:number} }} opts
 * @returns {{ bytes: Uint8Array, info: { length: number, checksum: number, blocks: number } }}
 */
export function buildPackage(opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('buildPackage requires an options object');
  const modelCode = requireText(opts.modelCode, MODEL_CODE_BYTES, 'modelCode');
  const modelName = opts.modelName === undefined ? modelCode : requireText(opts.modelName, MODEL_NAME_BYTES, 'modelName');
  const version = opts.version ?? {};
  for (const axis of ['x', 'y', 'z']) {
    const value = version[axis] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`version.${axis} must be an integer in 0..255, got ${JSON.stringify(version[axis])}`);
    }
  }
  const plain = alignPlain(opts.image);
  if (plain.length > APP_MAX_BYTES) {
    throw new RangeError(`image needs ${plain.length} bytes, above the app limit ${APP_MAX_BYTES}`);
  }
  const checksum = sum32Words(plain);
  const blocks = splitBlocks(gammaEncrypt(plain));
  const frames = [buildSigmaFrame(CMD_PARAM_WRITE, ENTER_DFU_DATA)];
  frames.push(
    encodeInfoFrame({
      modelCode,
      modelName,
      version: { x: version.x ?? 0, y: version.y ?? 0, z: version.z ?? 0 },
      length: plain.length,
      checksum,
    }),
  );
  for (const block of blocks) frames.push(buildSigmaFrame(CMD_DFU, [DFU_CMD_BLOCK, CHIP_ID, ...block]));

  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    bytes.set(frame, offset);
    offset += frame.length;
  }

  verifyFrames(bytes);
  if (plain.length % ALIGN_BYTES !== 0) throw new Error('self check failed: FwLength is not 4-byte aligned');
  if (blocks.reduce((sum, block) => sum + block.length, 0) !== plain.length) {
    throw new Error('self check failed: FwLength does not match the block payload');
  }
  return { bytes, info: { length: plain.length, checksum, blocks: blocks.length } };
}

/** 篡改工具：把第 index 个数据字节翻转（R6-2 用），并保持该帧 SigmaCRC 合法 */
export function tamperByte(bytes, index) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`index must be a non-negative integer, got ${index}`);
  const out = Uint8Array.from(bytes);
  const blocks = decodeSigmaFrames(out).slice(2);
  const payloadBytes = blocks.reduce((sum, frame) => sum + blockPayloadSize(frame), 0);
  if (index >= payloadBytes) throw new RangeError(`index ${index} is beyond the ${payloadBytes} data bytes`);
  let remaining = index;
  for (const frame of blocks) {
    const size = blockPayloadSize(frame);
    if (remaining >= size) {
      remaining -= size;
      continue;
    }
    frame[DATA_OFFSET + remaining] ^= 0xff;
    resealCrc(frame);
    return out;
  }
  throw new RangeError(`index ${index} is beyond the ${payloadBytes} data bytes`);
}

/** 篡改 FwLength 字段（R6-3 用），信息帧 LEN 与 SigmaCRC 仍保持合法 */
export function overrideLength(bytes, length) {
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
    throw new RangeError(`length must be an integer in 0..4294967295, got ${JSON.stringify(length)}`);
  }
  const out = Uint8Array.from(bytes);
  const frames = decodeSigmaFrames(out);
  if (frames.length < 2) throw new RangeError('package is missing the DFU info frame');
  const info = frames[1];
  if ((info[4] & 0x7f) !== CMD_DFU || info[5] !== DFU_CMD_INFO) {
    throw new RangeError('frame 1 of the package is not a DFU info frame');
  }
  writeU32LE(info, DATA_OFFSET + LENGTH_IN_PAYLOAD, length);
  resealCrc(info);
  return out;
}

/** 确定性测试镜像：测试与自检脚本共用同一段数据，避免各自造 */
export function syntheticImage(size) {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError(`size must be a positive integer, got ${size}`);
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7 + 0x5a) & 0xff;
  return bytes;
}

/** 读回包内信息帧的字段（测试与自检脚本用来断言 FwLength/FwChecksum 被改成了什么） */
export function readInfoFields(bytes) {
  const frames = decodeSigmaFrames(bytes);
  if (frames.length < 2) throw new RangeError('package is missing the DFU info frame');
  const frame = frames[1];
  const payload = frame.subarray(DATA_OFFSET, frame.length - CRC_BYTES);
  const modelCode = String.fromCharCode(...payload.subarray(0, MODEL_CODE_BYTES));
  const readU32 = (offset) =>
    (payload[offset] | (payload[offset + 1] << 8) | (payload[offset + 2] << 16) | (payload[offset + 3] << 24)) >>> 0;
  return {
    modelCode,
    version: { x: payload[LENGTH_IN_PAYLOAD - 3], y: payload[LENGTH_IN_PAYLOAD - 2], z: payload[LENGTH_IN_PAYLOAD - 1] },
    length: readU32(LENGTH_IN_PAYLOAD),
    checksum: readU32(CHECKSUM_IN_PAYLOAD),
  };
}
