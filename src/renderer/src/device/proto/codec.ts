import { MAX_FRAME_BYTES } from '../protocol';
import { FUNC_ACK, FUNC_RAND_READ, FUNC_SEQ_READ, type ParamFrame } from './frame';

export const ACK_NO_ERR = 0x0000;
export const ACK_DEV_ADDR_ERR = 0x0001;
export const ACK_LEN_ERR = 0x0002;
export const ACK_CHECKSUM_ERR = 0x0003;
export const ACK_READ_ONLY_ERR = 0x0004;
export const ACK_DATA_ERR = 0x0005;

export type AckCode = 0 | 1 | 2 | 3 | 4 | 5;

/** 本地错误（没有 ACK 帧可解析）用，不占协议码位 */
export const ACK_NONE = -1;

export interface WordPair {
  readonly addr: number;
  readonly raw: number;
}

export interface ReadReply {
  readonly start: number;
  readonly values: readonly number[];
}

export interface RandReadReply {
  readonly entries: readonly WordPair[];
}

export interface AckReply {
  readonly ack: AckCode;
}

type AckErrorCode = 'readOnly' | 'range' | 'crc' | 'addr' | 'len' | null;

const FRAME_OVERHEAD_BYTES = 6;
/** 随机读写每字 4 字节，连续读写每字 2 字节；上限由 512 B 帧容量反推（126 / 251） */
const RAND_WORD_LIMIT = Math.floor((MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES) / 4);
const SEQ_WORD_LIMIT = Math.floor((MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES - 4) / 2);

const ACK_ERROR_CODES: Readonly<Record<AckCode, AckErrorCode>> = {
  0: null,
  1: 'addr',
  2: 'len',
  3: 'crc',
  4: 'readOnly',
  5: 'range',
};

function writeWord(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function readWord(source: Uint8Array, offset: number): number {
  return (source[offset] << 8) | source[offset + 1];
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

/** 随机写：`(AddrHi,AddrLo,ValHi,ValLo)` 重复 */
export function encodeRandWrite(pairs: readonly WordPair[]): Uint8Array {
  if (pairs.length < 1 || pairs.length > RAND_WORD_LIMIT) {
    throw new RangeError(`random write needs 1..${RAND_WORD_LIMIT} words, got ${pairs.length}`);
  }
  const data = new Uint8Array(pairs.length * 4);
  for (let index = 0; index < pairs.length; index += 1) {
    writeWord(data, index * 4, pairs[index].addr);
    writeWord(data, index * 4 + 2, pairs[index].raw);
  }
  return data;
}

/** 连续写：首址(2B) + 数目(2B) + 值(2B × N) */
export function encodeSeqWrite(start: number, values: readonly number[]): Uint8Array {
  if (values.length < 1 || values.length > SEQ_WORD_LIMIT) {
    throw new RangeError(`sequential write needs 1..${SEQ_WORD_LIMIT} words, got ${values.length}`);
  }
  const data = new Uint8Array(4 + values.length * 2);
  writeWord(data, 0, start);
  writeWord(data, 2, values.length);
  for (let index = 0; index < values.length; index += 1) {
    writeWord(data, 4 + index * 2, values[index]);
  }
  return data;
}

/** 随机读请求：地址序列（每个 2B 大端） */
export function encodeRandRead(addrs: readonly number[]): Uint8Array {
  if (addrs.length < 1 || addrs.length > RAND_WORD_LIMIT) {
    throw new RangeError(`random read needs 1..${RAND_WORD_LIMIT} addresses, got ${addrs.length}`);
  }
  const data = new Uint8Array(addrs.length * 2);
  for (let index = 0; index < addrs.length; index += 1) {
    writeWord(data, index * 2, addrs[index]);
  }
  return data;
}

/** 连续读请求：首址(2B) + 数目(2B) */
export function encodeSeqRead(start: number, count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 1 || count > SEQ_WORD_LIMIT) {
    throw new RangeError(`sequential read needs 1..${SEQ_WORD_LIMIT} words, got ${count}`);
  }
  const data = new Uint8Array(4);
  writeWord(data, 0, start);
  writeWord(data, 2, count);
  return data;
}

export function encodeAck(code: AckCode): Uint8Array {
  if (!Number.isInteger(code) || code < ACK_NO_ERR || code > ACK_DATA_ERR) {
    throw new RangeError(`ack code ${code} is outside 0..${ACK_DATA_ERR}`);
  }
  const data = new Uint8Array(2);
  writeWord(data, 0, code);
  return data;
}

/**
 * 解析已通过 CRC 校验的响应帧。抛错意味着设备回了不合规的数据或调用方传错了帧，
 * 属于实现 bug；传输层必须 try/catch 转成 TransportError，不能让异常穿到 UI。
 */
export function parseReply(frame: ParamFrame): ReadReply | RandReadReply | AckReply {
  const data = frame.data;
  switch (frame.func) {
    case FUNC_ACK: {
      if (data.length !== 2) {
        throw new Error(`ack reply data must be 2 bytes, got ${data.length}`);
      }
      const code = readWord(data, 0);
      if (code > ACK_DATA_ERR) {
        throw new Error(`ack reply code 0x${hex(code, 4)} is not a known error code`);
      }
      return { ack: code as AckCode };
    }
    case FUNC_SEQ_READ: {
      if (data.length < 4) {
        throw new Error(`sequential read reply data must be >= 4 bytes, got ${data.length}`);
      }
      const start = readWord(data, 0);
      const count = readWord(data, 2);
      if (data.length !== 4 + count * 2) {
        throw new Error(`sequential read reply expects ${4 + count * 2} data bytes, got ${data.length}`);
      }
      const values: number[] = [];
      for (let index = 0; index < count; index += 1) {
        values.push(readWord(data, 4 + index * 2));
      }
      return { start, values };
    }
    case FUNC_RAND_READ: {
      if (data.length === 0 || data.length % 4 !== 0) {
        throw new Error(`random read reply data must be a non-empty multiple of 4 bytes, got ${data.length}`);
      }
      const entries: WordPair[] = [];
      for (let offset = 0; offset < data.length; offset += 4) {
        entries.push({ addr: readWord(data, offset), raw: readWord(data, offset + 2) });
      }
      return { entries };
    }
    default:
      throw new Error(`unexpected reply func 0x${hex(frame.func, 2)}`);
  }
}

export function ackToErrorCode(code: AckCode): AckErrorCode {
  return ACK_ERROR_CODES[code];
}
