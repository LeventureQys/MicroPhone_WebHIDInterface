import { MAX_FRAME_BYTES, UNIT_ID } from '../protocol';
import { crc16, crcHi, crcLo } from './crc';

export const FUNC_RAND_WRITE = 0x10;
export const FUNC_SEQ_WRITE = 0x11;
export const FUNC_RAND_READ = 0x12;
export const FUNC_SEQ_READ = 0x13;
export const FUNC_ACK = 0x02;

export type FrameProblem = 'crc' | 'length' | 'capacity' | 'func' | 'unit';

export interface DecodeIssue {
  readonly problem: FrameProblem;
  /** 相对本次输入缓冲的起偏移（丢字节前的位置） */
  readonly offset: number;
  readonly detail: string;
}

export interface ParamFrame {
  readonly unitId: number;
  readonly func: number;
  /** 不含 Len 与 CRC；新切片，不与入参共享 */
  readonly data: Uint8Array;
}

export interface DecodeResult {
  readonly frames: readonly ParamFrame[];
  /** 未消费字节（半帧）；新切片，不与入参共享 */
  readonly rest: Uint8Array;
  readonly issues: readonly DecodeIssue[];
}

const HEADER_BYTES = 4;
const CRC_BYTES = 2;
const MIN_FRAME_BYTES = HEADER_BYTES + CRC_BYTES;
/** 重同步只丢 1 字节：丢整帧会把坏帧后面的好帧一起丢掉 */
const RESYNC_STEP = 1;

function isParamFunc(func: number): boolean {
  return (
    func === FUNC_ACK ||
    func === FUNC_RAND_WRITE ||
    func === FUNC_SEQ_WRITE ||
    func === FUNC_RAND_READ ||
    func === FUNC_SEQ_READ
  );
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

/**
 * 拼一帧：UnitID + Func + LenHi + LenLo + Data + CRCLo + CRCHi。
 * Len 含头尾共 6 字节固定开销，CRC 覆盖 UnitID..Data 末字节，低字节先发。
 */
export function encodeFrame(func: number, data: Uint8Array, unitId: number = UNIT_ID): Uint8Array {
  const len = data.length + MIN_FRAME_BYTES;
  if (len > MAX_FRAME_BYTES) {
    throw new RangeError(`frame length ${len} exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  const frame = new Uint8Array(len);
  frame[0] = unitId & 0xff;
  frame[1] = func & 0xff;
  frame[2] = (len >>> 8) & 0xff;
  frame[3] = len & 0xff;
  frame.set(data, HEADER_BYTES);
  const crc = crc16(frame.subarray(0, len - CRC_BYTES));
  frame[len - 2] = crcLo(crc);
  frame[len - 1] = crcHi(crc);
  return frame;
}

/**
 * 流式拆帧：输入任意字节序列，输出零到多帧 + 未消费字节 + 问题清单。
 *
 * 扫描用索引推进而不是每帧 slice 一次尾部——每步都复制尾缓冲在长输入上是 O(n²)。
 * 任何输入都不抛异常（R1-4）：坏字节只记 issue 并丢 1 字节重同步。
 */
export function decodeStream(buffer: Uint8Array, expectedUnitId?: number): DecodeResult {
  const frames: ParamFrame[] = [];
  const issues: DecodeIssue[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    // 步骤 0（补位零规则）：发送方每帧按 63 B 补 0x00（C1），而 UnitID=0x00 + Func=0x00
    // 不可能是合法帧（0x00 不是任何功能码），所以连续两个 0x00 只可能是补位：静默丢 1 个、
    // 不记 issue。单个前导 0x00 必须留着——它可能是被报文边界切开的下一帧 UnitID。
    while (offset + 1 < buffer.length && buffer[offset] === 0x00 && buffer[offset + 1] === 0x00) {
      offset += 1;
    }

    const available = buffer.length - offset;
    if (available < HEADER_BYTES) break;

    const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
    if (len < MIN_FRAME_BYTES) {
      issues.push({ problem: 'length', offset, detail: `Len ${len} < ${MIN_FRAME_BYTES}` });
      offset += RESYNC_STEP;
      continue;
    }
    if (len > MAX_FRAME_BYTES) {
      issues.push({ problem: 'capacity', offset, detail: `Len ${len} > ${MAX_FRAME_BYTES}` });
      offset += RESYNC_STEP;
      continue;
    }
    if (len > available) break;

    const unitId = buffer[offset];
    if (expectedUnitId !== undefined && unitId !== expectedUnitId) {
      issues.push({
        problem: 'unit',
        offset,
        detail: `UnitID 0x${hex(unitId, 2)} != expected 0x${hex(expectedUnitId, 2)}`,
      });
      offset += RESYNC_STEP;
      continue;
    }

    const func = buffer[offset + 1];
    if (!isParamFunc(func)) {
      issues.push({ problem: 'func', offset, detail: `Func 0x${hex(func, 2)} is not a parameter function code` });
      offset += RESYNC_STEP;
      continue;
    }

    const expected = crc16(buffer.subarray(offset, offset + len - CRC_BYTES));
    const received = buffer[offset + len - CRC_BYTES] | (buffer[offset + len - 1] << 8);
    if (expected !== received) {
      issues.push({
        problem: 'crc',
        offset,
        detail: `CRC 0x${hex(received, 4)} != computed 0x${hex(expected, 4)}`,
      });
      offset += RESYNC_STEP;
      continue;
    }

    frames.push({
      unitId,
      func,
      data: buffer.slice(offset + HEADER_BYTES, offset + len - CRC_BYTES),
    });
    offset += len;
  }

  return { frames, rest: buffer.slice(offset), issues };
}

/** 整帧字节数 = Data 字节数 + 6（UnitID/Func/LenHi/LenLo/CRCLo/CRCHi） */
export function frameLength(frame: ParamFrame): number {
  return frame.data.length + MIN_FRAME_BYTES;
}
