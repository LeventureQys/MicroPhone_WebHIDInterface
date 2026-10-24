import { describe, expect, it } from 'vitest';
import { crc16, crcHi, crcLo } from '../../../src/renderer/src/device/proto/crc';

interface CrcVector {
  readonly index: number;
  readonly covered: string;
  readonly crc: number;
  readonly lo: number;
  readonly hi: number;
}

/** 需求文档附录 A.6 的 8 条自检向量（Lo,Hi 为线上发送顺序） */
const CRC_VECTORS: readonly CrcVector[] = [
  { index: 1, covered: '11 03 00 2B 00 01', crc: 0x92f6, lo: 0xf6, hi: 0x92 },
  { index: 2, covered: '00 02 00 08 00 00', crc: 0x19f8, lo: 0xf8, hi: 0x19 },
  { index: 3, covered: '00 02 00 08 00 05', crc: 0x1a38, lo: 0x38, hi: 0x1a },
  { index: 4, covered: '00 10 00 0A 20 24 00 01', crc: 0xc043, lo: 0x43, hi: 0xc0 },
  { index: 5, covered: '00 11 00 0E 20 5B 00 02 00 01 00 02', crc: 0x4239, lo: 0x39, hi: 0x42 },
  { index: 6, covered: '00 12 00 0A 20 5B 20 5C', crc: 0xe189, lo: 0x89, hi: 0xe1 },
  { index: 7, covered: '00 12 00 0E 20 5B 00 00 20 5C 00 32', crc: 0xc0d5, lo: 0xd5, hi: 0xc0 },
  { index: 8, covered: '00 13 00 0A 20 00 00 02', crc: 0xca70, lo: 0x70, hi: 0xca },
];

function bytes(hexText: string): Uint8Array {
  return Uint8Array.from(hexText.split(' ').map((part) => Number.parseInt(part, 16)));
}

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

describe('crc16 — 需求附录 A.6 自检向量', () => {
  for (const vector of CRC_VECTORS) {
    it(`A.6 #${vector.index} 覆盖字节 ${vector.covered} → CRC Lo ${hex2(vector.lo)} / Hi ${hex2(vector.hi)}（0x${hex4(vector.crc)}）`, () => {
      const crc = crc16(bytes(vector.covered));

      expect(crc).toBe(vector.crc);
      expect([crcLo(crc), crcHi(crc)]).toEqual([vector.lo, vector.hi]);
    });
  }
});

describe('crc16 — 通用性质', () => {
  it('空输入等于初值 0xFFFF', () => {
    expect(crc16(new Uint8Array(0))).toBe(0xffff);
  });

  it('奇数长度：追加 0x00 会改变结果（证明长度边界不自洽）', () => {
    const odd = bytes('01 02 03');

    expect(crc16(odd)).toBe(0x6161);
    expect(crc16(bytes('01 02 03 00'))).toBe(0xe8a0);
    expect(crc16(odd)).not.toBe(crc16(bytes('01 02 03 00')));
  });

  it('偶数长度：追加 0x00 会改变结果', () => {
    const even = bytes('12 34');

    expect(crc16(even)).toBe(0xc70c);
    expect(crc16(bytes('12 34 00'))).toBe(0x05c7);
    expect(crc16(even)).not.toBe(crc16(bytes('12 34 00')));
  });

  it('Modbus 标准校验值：ASCII "123456789" → 0x4B37', () => {
    const ascii = Uint8Array.from(Array.from('123456789').map((char) => char.charCodeAt(0)));

    expect(crc16(ascii)).toBe(0x4b37);
  });

  it('单字节输入 0xAA → 0x3F3F', () => {
    expect(crc16(Uint8Array.from([0xaa]))).toBe(0x3f3f);
  });

  it('重复调用结果稳定，且不改写入参', () => {
    const input = bytes('00 13 00 0A 20 00 00 02');
    const snapshot = Array.from(input);

    expect(crc16(input)).toBe(crc16(input));
    expect(Array.from(input)).toEqual(snapshot);
  });

  it('任意长度（0..64）的结果都是 0..0xFFFF 的整数', () => {
    for (let length = 0; length <= 64; length += 1) {
      const input = Uint8Array.from({ length }, () => Math.floor(Math.random() * 256));
      const crc = crc16(input);

      expect(Number.isInteger(crc)).toBe(true);
      expect(crc).toBeGreaterThanOrEqual(0);
      expect(crc).toBeLessThanOrEqual(0xffff);
    }
  });
});

describe('crcLo / crcHi', () => {
  it('按 16 位拆分：低字节先发', () => {
    expect(crcLo(0x1234)).toBe(0x34);
    expect(crcHi(0x1234)).toBe(0x12);
    expect(crcLo(0xffff)).toBe(0xff);
    expect(crcHi(0xffff)).toBe(0xff);
    expect(crcLo(0x0001)).toBe(0x01);
    expect(crcHi(0x0001)).toBe(0x00);
  });

  it('对 A.6 全部向量满足 crc16 = Hi << 8 | Lo', () => {
    for (const vector of CRC_VECTORS) {
      const crc = crc16(bytes(vector.covered));

      expect((crcHi(crc) << 8) | crcLo(crc)).toBe(crc);
    }
  });
});
