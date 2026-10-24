/**
 * 设备侧 DFU 协议栈（SigmaBus 帧 + DFU_CMD 0x02/0x03 状态机 + 假 Flash）。
 *
 * 与上位机 src/renderer/src/device/dfu/** 各写一遍组帧、Gamma 与校验和，互为对拍：
 * 任何一侧写错，另一侧的单测就会红。本文件是纯逻辑，不碰 WS / HTTP / 文件系统，
 * 回执一律从构造参数 onReplies 交出（每条一个 63 B 报告数组）。
 */

import { splitReports } from './device-stack.mjs';

export { splitReports };

/** SigmaBus 帧起始符（DFU 材料 §1.2） */
export const SIGMA_START = 0xc4;
/** 命令层：0x0B = DFU，0x02 = 设备 → 主机 ACK */
export const CMD_DFU = 0x0b;
export const CMD_ACK = 0x02;
/** Bootloader 里唯一的随机写：参数 0x1008 = 1（幂等空实现，DFU 材料 §2.1） */
export const CMD_PARAM_WRITE = 0x03;

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

/** KEY = 0x1C9CBB63 的小端字节 */
export const GAMMA_KEY = 0x1c9cbb63;
export const GAMMA_BYTES = 8192;
export const BLOCK_BYTES = 256;
export const APP_MAX_BYTES = 0x30000;
export const BOOT_MAX_BYTES = 0x8000;
/** LEN 必须 < 1023（DFU 材料 §1.2）；设计文档 §5.9 记为 MAX_SIGMA_FRAME */
export const MAX_SIGMA_FRAME = 1022;
/** 帧头后的固定字段：C4 + LEN(2) + ADDR + CMD + CRC(2) */
export const SIGMA_OVERHEAD = 7;
/** 信息帧总长（DFU 材料 §2.2） */
export const INFO_FRAME_BYTES = 90;
/** DFU 状态帧总长（DFU 材料 §2.4） */
export const STATUS_FRAME_BYTES = 10;
/** 状态帧发回时 LEN 固定值，仅用于自检可读性 */
export const ACK_FRAME_BYTES = 9;
/** 未知/不校验的芯片号字段：本协议全 0 */
export const CHIP_ID = 0x00;

const KEY_BYTES = Object.freeze([0x63, 0xbb, 0x9c, 0x1c]);
const MODEL_WILDCARD = '000000';
const MODEL_BOOTLOADER = 'Bootld';
const MODEL_CODE_BYTES = 6;
const MODEL_NAME_BYTES = 64;
const INFO_PAYLOAD_BYTES = 81;
const PARAM_ENTER_DFU_ADDR = 0x1008;

const STATE_IDLE = 'idle';
const STATE_INFO_ACCEPTED = 'infoAccepted';
const STATE_DONE = 'done';
const STATE_FAILED = 'failed';

function concatBytes(left, right) {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function nibbleSwap(value) {
  return ((value << 4) & 0xf0) | ((value >> 4) & 0x0f);
}

function readU32(bytes, offset) {
  return (
    ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0)
  );
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function asciiOf(bytes) {
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

/** 16 位累加取反加一：（~(Σframe[0..n-3]) + 1） & 0xFFFF，低字节先发（设计 §6.2） */
export function sigmaCrc(bytes) {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 1) sum = (sum + bytes[index]) & 0xffff;
  return ((~sum & 0xffff) + 1) & 0xffff;
}

/** 组一帧：C4 | LEN_L | LEN_H | ADDR | CMD | DATA | CRC_L | CRC_H；LEN 是整帧字节数 */
export function buildSigmaFrame(cmd, data, addr = 0) {
  const payload = data ? Uint8Array.from(data) : new Uint8Array(0);
  if (!Number.isInteger(addr) || addr < 0 || addr > 0xff) throw new RangeError(`addr must be a byte, got ${addr}`);
  const length = payload.length + SIGMA_OVERHEAD;
  if (length < ACK_FRAME_BYTES || length > MAX_SIGMA_FRAME) {
    throw new RangeError(`frame length ${length} is outside 9..${MAX_SIGMA_FRAME}`);
  }
  const frame = new Uint8Array(length);
  frame[0] = SIGMA_START;
  frame[1] = length & 0xff;
  frame[2] = (length >> 8) & 0xff;
  frame[3] = addr;
  frame[4] = cmd & 0xff;
  frame.set(payload, 5);
  const crc = sigmaCrc(frame.subarray(0, length - 2));
  frame[length - 2] = crc & 0xff;
  frame[length - 1] = (crc >> 8) & 0xff;
  return frame;
}

/**
 * 把字节流按 LEN 切成帧。
 * 只在"输入一定是良构包"的场景用（打包工具、黄金样本对拍）；坏帧直接抛，
 * 免得调用方拿着一堆半帧继续算校验和。
 */
export function decodeSigmaFrames(bytes) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes[offset] !== SIGMA_START) throw new RangeError(`no start byte at ${offset}`);
    if (offset + 3 > bytes.length) throw new RangeError(`truncated header at ${offset}`);
    const length = bytes[offset + 1] | (bytes[offset + 2] << 8);
    if (length < ACK_FRAME_BYTES || length > MAX_SIGMA_FRAME) {
      throw new RangeError(`frame length ${length} at ${offset} is outside 9..${MAX_SIGMA_FRAME}`);
    }
    if (offset + length > bytes.length) throw new RangeError(`frame at ${offset} needs ${length} bytes`);
    frames.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

/** 单字节解密：p = nibbleSwap(c - 0xA3) ^ keyByte[i % 4] */
function decryptByte(cipher, index) {
  return nibbleSwap((cipher - 0xa3) & 0xff) ^ KEY_BYTES[index % 4];
}

function encryptByte(plain, index) {
  return (nibbleSwap(plain ^ KEY_BYTES[index % 4]) + 0xa3) & 0xff;
}

/** 前 min(len, 8192) 字节、4 字节粒度；返回新数组，入参不改 */
export function gammaDecrypt(bytes) {
  const plain = Uint8Array.from(bytes);
  const limit = Math.min(plain.length, GAMMA_BYTES);
  for (let index = 0; index < limit; index += 1) plain[index] = decryptByte(plain[index], index);
  return plain;
}

/** gammaDecrypt 的逆运算，打包工具用；同样只处理前 8192 字节 */
export function gammaEncrypt(bytes) {
  const cipher = Uint8Array.from(bytes);
  const limit = Math.min(cipher.length, GAMMA_BYTES);
  for (let index = 0; index < limit; index += 1) cipher[index] = encryptByte(cipher[index], index);
  return cipher;
}

/** 32 位小端字累加（名字叫 CRC-32，实现是求和，DFU 材料 §4.2），对明文算 */
export function sum32Words(bytes) {
  let sum = 0;
  const words = Math.floor(bytes.length / 4);
  for (let index = 0; index < words; index += 1) {
    sum = (sum + readU32(bytes, index * 4)) >>> 0;
  }
  return sum >>> 0;
}

export class DfuStack {
  #modelCode;
  #allowBootld;
  #onReplies;
  #buffer = new Uint8Array(0);
  #state = STATE_IDLE;
  #status = null;
  #info = null;
  #fwLength = 0;
  #fwChecksum = 0;
  #dataCount = 0;
  #checksum = 0;
  #blocks = 0;
  #completed = false;
  #powerLost = false;
  #framesIn = 0;
  #framesOut = 0;

  /**
   * @param {object} opts
   * @param {string} [opts.modelCode]    设备自身型号码，缺省 JYM001
   * @param {boolean} [opts.allowBootld] 是否接受 ModelCode='Bootld'（缺省 false）
   * @param {() => number} [opts.now]
   * @param {object} [opts.timers]
   * @param {(reports: Uint8Array[]) => void} opts.onReplies
   */
  constructor(opts) {
    if (!opts || typeof opts.onReplies !== 'function') {
      throw new TypeError('DfuStack requires opts.onReplies(reports)');
    }
    this.#modelCode = typeof opts.modelCode === 'string' && opts.modelCode.length > 0 ? opts.modelCode : 'JYM001';
    this.#allowBootld = opts.allowBootld === true;
    this.#onReplies = opts.onReplies;
  }

  get modelCode() {
    return this.#modelCode;
  }

  /** 入站 63 B 报告（不含 report ID） */
  feed(payload) {
    if (this.#powerLost) return;
    const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
    if (bytes.length === 0) return;
    this.#buffer = concatBytes(this.#buffer, bytes);
    const replies = [];
    this.#drain(replies);
    if (replies.length > 0) this.#onReplies(replies);
  }

  state() {
    return this.#state;
  }

  lastStatus() {
    return this.#status;
  }

  /** 假 Flash：已写入的明文字节数 / 校验和累计值 / 块数 */
  flash() {
    return { bytes: this.#dataCount, checksum: this.#checksum, blocks: this.#blocks };
  }

  /** 最近一次被接受的信息帧；侧车据此回写固件版本寄存器 */
  info() {
    return this.#info ? { ...this.#info, version: { ...this.#info.version } } : null;
  }

  /** 已完成一次成功升级后为 true（侧车据此切回 app 模式） */
  completed() {
    return this.#completed;
  }

  stats() {
    return { framesIn: this.#framesIn, framesOut: this.#framesOut };
  }

  /** 强制断电：后续帧不再处理，状态停在 failed */
  powerLoss() {
    this.#powerLost = true;
    this.#state = STATE_FAILED;
    this.#completed = false;
    this.#buffer = new Uint8Array(0);
  }

  reset() {
    this.#buffer = new Uint8Array(0);
    this.#state = STATE_IDLE;
    // #status/#dataCount/#checksum/#blocks 故意保留：侧车升级成功后立刻 reset 传输指针，
    // 但假 Flash 里写进去的内容还在，控制面要能读到 0x05 与块数这两条证据
    this.#info = null;
    this.#fwLength = 0;
    this.#fwChecksum = 0;
    this.#completed = false;
    this.#powerLost = false;
  }

  #drain(replies) {
    for (;;) {
      // 报告尾部补 0x00（需求 §3.2）：帧尾之后是填充，等下一包的新帧
      while (this.#buffer.length > 0 && this.#buffer[0] !== SIGMA_START) this.#buffer = this.#buffer.subarray(1);
      if (this.#buffer.length < 3) return;
      const length = this.#buffer[1] | (this.#buffer[2] << 8);
      if (length < ACK_FRAME_BYTES || length > MAX_SIGMA_FRAME) {
        // 帧长字段不可信时已无法再对齐字节流，回长度错并清空累积器（D10）
        this.#buffer = new Uint8Array(0);
        this.#pushAck(replies, SIGMA_ACK_LEN_ERR);
        return;
      }
      if (this.#buffer.length < length) return;
      const frame = this.#buffer.subarray(0, length);
      this.#buffer = this.#buffer.subarray(length);
      this.#handleFrame(frame, replies);
      if (this.#powerLost) return;
    }
  }

  #handleFrame(frame, replies) {
    const length = frame.length;
    this.#framesIn += 1;
    const expected = frame[length - 2] | (frame[length - 1] << 8);
    if (sigmaCrc(frame.subarray(0, length - 2)) !== expected) {
      // ACK 语义：整帧丢弃、Flash 指针不前进（DFU 材料 §2.5 / D9）
      this.#pushAck(replies, SIGMA_ACK_CHECKSUM_ERR);
      return;
    }
    if (frame[3] !== 0) {
      this.#pushAck(replies, SIGMA_ACK_DEV_ADDR_ERR);
      return;
    }
    const cmd = frame[4] & 0x7f;
    const data = frame.subarray(5, length - 2);
    if (cmd === CMD_DFU) this.#handleDfu(data, replies);
    else if (cmd === CMD_PARAM_WRITE) this.#handleParamWrite(data, replies);
    else this.#pushAck(replies, SIGMA_ACK_LEN_ERR);
  }

  /** 旧参数随机写：Bootloader 里只有 0x1008 是幂等空实现（D11） */
  #handleParamWrite(data, replies) {
    if (data.length < 4) {
      this.#pushAck(replies, SIGMA_ACK_LEN_ERR);
      return;
    }
    // SigmaBus 参数帧是小端：addr = data[0] | data[1] << 8，value 同
    const addr = data[0] | (data[1] << 8);
    if (addr !== PARAM_ENTER_DFU_ADDR) {
      this.#pushAck(replies, SIGMA_ACK_DEV_ADDR_ERR);
      return;
    }
    this.#pushAck(replies, 0x0000);
  }

  #handleDfu(data, replies) {
    if (data.length < 2) {
      this.#pushAck(replies, SIGMA_ACK_LEN_ERR);
      return;
    }
    const dfuCmd = data[0];
    if (dfuCmd === DFU_CMD_INFO) {
      this.#handleInfo(data, replies);
      return;
    }
    if (dfuCmd === DFU_CMD_BLOCK) {
      this.#handleBlock(data, replies);
      return;
    }
    // DFU_CMD 0x01 是设备 → 主机方向，主机发了没有回应（DFU 材料 §1.3）；
    // 未知 DFU_CMD 在设备侧同样没有 case，一并静默。
  }

  #handleInfo(data, replies) {
    // LEN 必须是 90：data = DFU_CMD + CHIP_ID + 81（D1）
    if (data.length + SIGMA_OVERHEAD !== INFO_FRAME_BYTES) {
      this.#pushStatus(replies, DFU_STATUS_CODE_ERR);
      return;
    }
    const payload = data.subarray(2, 2 + INFO_PAYLOAD_BYTES);
    const modelCode = asciiOf(payload.subarray(0, MODEL_CODE_BYTES));
    const modelName = asciiOf(payload.subarray(MODEL_CODE_BYTES, MODEL_CODE_BYTES + MODEL_NAME_BYTES));
    const version = {
      x: payload[MODEL_CODE_BYTES + MODEL_NAME_BYTES],
      y: payload[MODEL_CODE_BYTES + MODEL_NAME_BYTES + 1],
      z: payload[MODEL_CODE_BYTES + MODEL_NAME_BYTES + 2],
    };
    const length = readU32(payload, MODEL_CODE_BYTES + MODEL_NAME_BYTES + 3);
    const checksum = readU32(payload, MODEL_CODE_BYTES + MODEL_NAME_BYTES + 7);
    if (!this.#modelMatches(modelCode)) {
      this.#pushStatus(replies, DFU_STATUS_INFO_ERR);
      return;
    }
    // D7：重发信息帧是新的一轮，指针/计数/校验和全部归零
    this.#info = { modelCode, modelName, version, length, checksum };
    this.#fwLength = length;
    this.#fwChecksum = checksum;
    this.#dataCount = 0;
    this.#checksum = 0;
    this.#blocks = 0;
    this.#completed = false;
    this.#state = STATE_INFO_ACCEPTED;
    this.#pushStatus(replies, DFU_STATUS_CONTINUE);
  }

  #handleBlock(data, replies) {
    if (this.#state !== STATE_INFO_ACCEPTED) {
      // 没先发信息帧，或上一轮已 done/failed（D2、D5）
      this.#pushStatus(replies, DFU_STATUS_CODE_ERR);
      return;
    }
    const count = data.length - 2;
    const remaining = this.#fwLength - this.#dataCount;
    const expected = remaining >= BLOCK_BYTES ? BLOCK_BYTES : remaining;
    if (count <= 0 || count !== expected) {
      this.#pushStatus(replies, DFU_STATUS_CODE_ERR);
      return;
    }
    if (this.#dataCount + count > this.#fwLength) {
      this.#pushStatus(replies, DFU_STATUS_CODE_ERR);
      return;
    }
    const cipher = data.subarray(2, 2 + count);
    const plain = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      const absolute = this.#dataCount + index;
      plain[index] = absolute < GAMMA_BYTES ? decryptByte(cipher[index], absolute) : cipher[index];
    }
    // 设备侧按块做 len/4 截断累加（DFU 材料 §4.2），块间互不影响
    this.#checksum = (this.#checksum + sum32Words(plain)) >>> 0;
    this.#dataCount += count;
    this.#blocks += 1;
    if (this.#dataCount === this.#fwLength) {
      if (this.#checksum === this.#fwChecksum) {
        this.#state = STATE_DONE;
        this.#completed = true;
        this.#pushStatus(replies, DFU_STATUS_SUCCESS);
      } else {
        this.#state = STATE_FAILED;
        this.#pushStatus(replies, DFU_STATUS_FAIL);
      }
      return;
    }
    this.#pushStatus(replies, DFU_STATUS_CONTINUE);
  }

  #modelMatches(modelCode) {
    if (modelCode === this.#modelCode) return true;
    if (modelCode === MODEL_WILDCARD) return true;
    return this.#allowBootld && modelCode === MODEL_BOOTLOADER;
  }

  #pushAck(replies, code) {
    const frame = buildSigmaFrame(CMD_ACK, [code & 0xff, (code >> 8) & 0xff]);
    this.#framesOut += 1;
    replies.push(...splitReports(frame));
  }

  #pushStatus(replies, status) {
    this.#status = status;
    const frame = buildSigmaFrame(CMD_DFU, [DFU_CMD_STATUS, CHIP_ID, status]);
    this.#framesOut += 1;
    replies.push(...splitReports(frame));
  }
}
