import { describe, expect, it } from 'vitest';
import {
  ACK_CHECKSUM_ERR,
  ACK_DATA_ERR,
  ACK_DEV_ADDR_ERR,
  ACK_LEN_ERR,
  ACK_NO_ERR,
  ACK_NONE,
  ACK_READ_ONLY_ERR,
  ackToErrorCode,
  encodeAck,
  encodeRandRead,
  encodeRandWrite,
  encodeSeqRead,
  encodeSeqWrite,
  parseReply,
  type AckCode,
  type AckReply,
  type RandReadReply,
  type ReadReply,
  type WordPair,
} from '../../../src/renderer/src/device/proto/codec';
import {
  FUNC_ACK,
  FUNC_RAND_READ,
  FUNC_RAND_WRITE,
  FUNC_SEQ_READ,
  FUNC_SEQ_WRITE,
  decodeStream,
  encodeFrame,
  type ParamFrame,
} from '../../../src/renderer/src/device/proto/frame';

function bytes(hexText: string): Uint8Array {
  return Uint8Array.from(hexText.split(' ').map((part) => Number.parseInt(part, 16)));
}

function toHex(input: Uint8Array): string {
  return Array.from(input)
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

function frameOf(func: number, data: Uint8Array): ParamFrame {
  const result = decodeStream(encodeFrame(func, data));

  expect(result.frames.length).toBe(1);
  return result.frames[0];
}

function parseWords(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function repeat<T>(count: number, factory: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => factory(index));
}

describe('encodeRandWrite', () => {
  it('数据段是 (AddrHi,AddrLo,ValHi,ValLo) 重复，且能解回同样的字对', () => {
    const pairs: WordPair[] = [
      { addr: 0x2024, raw: 0x0001 },
      { addr: 0x2057, raw: 0x1234 },
    ];
    const data = encodeRandWrite(pairs);
    const frame = frameOf(FUNC_RAND_WRITE, data);

    expect(toHex(data)).toBe('20 24 00 01 20 57 12 34');
    expect(toHex(frame.data)).toBe(toHex(data));

    const restored: WordPair[] = [];
    for (let offset = 0; offset < frame.data.length; offset += 4) {
      restored.push({ addr: parseWords(frame.data, offset), raw: parseWords(frame.data, offset + 2) });
    }
    expect(restored).toEqual(pairs);
  });

  it('单字对拼出的整帧与 A.7「写降噪开关 0x2024=1」逐字节一致', () => {
    const frame = encodeFrame(FUNC_RAND_WRITE, encodeRandWrite([{ addr: 0x2024, raw: 0x0001 }]));

    expect(toHex(frame)).toBe('00 10 00 0A 20 24 00 01 43 C0');
  });
});

describe('encodeSeqWrite', () => {
  it('数据段是 首址(2B) + 数目(2B) + 值(2B ×N)，且能解回', () => {
    const data = encodeSeqWrite(0x205b, [0x0001, 0x0002]);
    const frame = frameOf(FUNC_SEQ_WRITE, data);

    expect(toHex(data)).toBe('20 5B 00 02 00 01 00 02');
    expect(toHex(frame.data)).toBe(toHex(data));
    expect(parseWords(frame.data, 0)).toBe(0x205b);
    expect(parseWords(frame.data, 2)).toBe(2);
    expect([parseWords(frame.data, 4), parseWords(frame.data, 6)]).toEqual([1, 2]);
  });

  it('N = 251 时整帧正好 512 B', () => {
    const data = encodeSeqWrite(0x2000, repeat(251, () => 0x00ff));
    const frame = encodeFrame(FUNC_SEQ_WRITE, data);

    expect(data.length).toBe(506);
    expect(frame.length).toBe(512);
    expect(decodeStream(frame).frames.length).toBe(1);
  });
});

describe('encodeRandRead', () => {
  it('数据段是地址序列，且能拼出 A.7 的整帧', () => {
    const single = encodeRandRead([0x2057]);
    const double = encodeRandRead([0x205b, 0x205c]);

    expect(toHex(single)).toBe('20 57');
    expect(toHex(encodeFrame(FUNC_RAND_READ, single))).toBe('00 12 00 08 20 57 61 E4');
    expect(toHex(double)).toBe('20 5B 20 5C');
    expect(toHex(encodeFrame(FUNC_RAND_READ, double))).toBe('00 12 00 0A 20 5B 20 5C 89 E1');
  });

  it('N = 126 上限可用（数据段 252 B）', () => {
    const data = encodeRandRead(repeat(126, (index) => 0x2000 + index));

    expect(data.length).toBe(252);
    expect(encodeFrame(FUNC_RAND_READ, data).length).toBe(258);
  });
});

describe('encodeSeqRead', () => {
  it('数据段是 首址(2B) + 数目(2B)，且能拼出 A.7 的整帧', () => {
    const two = encodeSeqRead(0x2000, 2);
    const preset = encodeSeqRead(0x2000, 114);

    expect(toHex(two)).toBe('20 00 00 02');
    expect(toHex(encodeFrame(FUNC_SEQ_READ, two))).toBe('00 13 00 0A 20 00 00 02 70 CA');
    expect(toHex(encodeFrame(FUNC_SEQ_READ, preset))).toBe('00 13 00 0A 20 00 00 72 71 2E');
  });

  it('count = 251 上限可用', () => {
    expect(encodeFrame(FUNC_SEQ_READ, encodeSeqRead(0x2000, 251)).length).toBe(10);
  });
});

describe('parseReply', () => {
  it('0x12 响应：20 5B 00 00 20 5C 00 32 → 两项 {addr, raw}', () => {
    const decoded = decodeStream(bytes('00 12 00 0E 20 5B 00 00 20 5C 00 32 D5 C0'));
    expect(decoded.frames.length).toBe(1);

    const reply = parseReply(decoded.frames[0]) as RandReadReply;
    expect(reply.entries).toEqual([
      { addr: 0x205b, raw: 0x0000 },
      { addr: 0x205c, raw: 0x0032 },
    ]);
  });

  it('0x13 响应：20 00 00 02 00 00 00 01 → start 0x2000 / values [0,1]', () => {
    const frame = frameOf(FUNC_SEQ_READ, bytes('20 00 00 02 00 00 00 01'));
    const reply = parseReply(frame) as ReadReply;

    expect(reply.start).toBe(0x2000);
    expect(reply.values).toEqual([0, 1]);
  });

  it('0x02 响应：ACK 成功与校验和错各自解出错误码', () => {
    const ok = parseReply(decodeStream(bytes('00 02 00 08 00 00 F8 19')).frames[0]) as AckReply;
    const crcError = parseReply(decodeStream(bytes('00 02 00 08 00 03 B8 18')).frames[0]) as AckReply;

    expect(ok.ack).toBe(ACK_NO_ERR);
    expect(crcError.ack).toBe(ACK_CHECKSUM_ERR);
  });

  it('0x02 数据段长度不是 2 → 抛 Error', () => {
    const frame = frameOf(FUNC_ACK, bytes('00'));

    expect(() => parseReply(frame)).toThrow(Error);
    expect(() => parseReply(frame)).toThrow(/ack reply data must be 2 bytes/);
  });

  it('0x02 错误码超出 0..5 → 抛 Error', () => {
    const frame = frameOf(FUNC_ACK, bytes('00 06'));

    expect(() => parseReply(frame)).toThrow(/is not a known error code/);
  });

  it('0x13 数据段不足 4 字节 → 抛 Error', () => {
    const frame = frameOf(FUNC_SEQ_READ, bytes('20 00'));

    expect(() => parseReply(frame)).toThrow(/must be >= 4 bytes/);
  });

  it('0x13 数据段与「首址 + 数目」不符 → 抛 Error', () => {
    const frame = frameOf(FUNC_SEQ_READ, bytes('20 00 00 02 00 00'));

    expect(() => parseReply(frame)).toThrow(/expects 8 data bytes/);
  });

  it('0x12 数据段长度为 0 → 抛 Error', () => {
    const frame = frameOf(FUNC_RAND_READ, new Uint8Array(0));

    expect(() => parseReply(frame)).toThrow(/non-empty multiple of 4 bytes/);
  });

  it('0x12 数据段长度不是 4 的倍数 → 抛 Error', () => {
    const frame = frameOf(FUNC_RAND_READ, bytes('20 57 61'));

    expect(() => parseReply(frame)).toThrow(/non-empty multiple of 4 bytes/);
  });

  it('非响应功能码 → 抛 Error，消息带功能码', () => {
    const frame = frameOf(FUNC_RAND_WRITE, bytes('20 24 00 01'));

    expect(() => parseReply(frame)).toThrow(Error);
    expect(() => parseReply(frame)).toThrow('unexpected reply func 0x10');
  });
});

describe('编码入参越界抛 RangeError', () => {
  it('encodeRandWrite：0 项与 127 项', () => {
    expect(() => encodeRandWrite([])).toThrow(RangeError);
    expect(() => encodeRandWrite(repeat(127, () => ({ addr: 0x2000, raw: 0 })))).toThrow(RangeError);
  });

  it('encodeSeqWrite：0 项与 252 项', () => {
    expect(() => encodeSeqWrite(0x2000, [])).toThrow(RangeError);
    expect(() => encodeSeqWrite(0x2000, repeat(252, () => 0))).toThrow(RangeError);
  });

  it('encodeRandRead：0 个与 127 个地址', () => {
    expect(() => encodeRandRead([])).toThrow(RangeError);
    expect(() => encodeRandRead(repeat(127, () => 0x2000))).toThrow(RangeError);
  });

  it('encodeSeqRead：count 为 0 与 252', () => {
    expect(() => encodeSeqRead(0x2000, 0)).toThrow(RangeError);
    expect(() => encodeSeqRead(0x2000, 252)).toThrow(RangeError);
  });
});

describe('encodeAck', () => {
  it('六个合法码写成 2 字节大端', () => {
    expect(toHex(encodeAck(ACK_NO_ERR))).toBe('00 00');
    expect(toHex(encodeAck(ACK_DEV_ADDR_ERR))).toBe('00 01');
    expect(toHex(encodeAck(ACK_LEN_ERR))).toBe('00 02');
    expect(toHex(encodeAck(ACK_CHECKSUM_ERR))).toBe('00 03');
    expect(toHex(encodeAck(ACK_READ_ONLY_ERR))).toBe('00 04');
    expect(toHex(encodeAck(ACK_DATA_ERR))).toBe('00 05');
    expect(encodeAck(ACK_READ_ONLY_ERR).length).toBe(2);
  });

  it('码位越界抛 RangeError', () => {
    expect(() => encodeAck(6 as AckCode)).toThrow(RangeError);
    expect(() => encodeAck(-1 as AckCode)).toThrow(RangeError);
  });

  it('拼出的整帧与 A.7 的 ACK 帧逐字节一致', () => {
    expect(toHex(encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR)))).toBe('00 02 00 08 00 00 F8 19');
    expect(toHex(encodeFrame(FUNC_ACK, encodeAck(ACK_CHECKSUM_ERR)))).toBe('00 02 00 08 00 03 B8 18');
  });
});

describe('ackToErrorCode', () => {
  const CASES: readonly { readonly code: AckCode; readonly expected: string | null }[] = [
    { code: 0, expected: null },
    { code: 1, expected: 'addr' },
    { code: 2, expected: 'len' },
    { code: 3, expected: 'crc' },
    { code: 4, expected: 'readOnly' },
    { code: 5, expected: 'range' },
  ];

  for (const item of CASES) {
    it(`ACK ${item.code} → ${item.expected === null ? 'null（成功）' : item.expected}`, () => {
      expect(ackToErrorCode(item.code)).toBe(item.expected);
    });
  }

  it('协议码常量与 A.3 表一致', () => {
    expect([ACK_NO_ERR, ACK_DEV_ADDR_ERR, ACK_LEN_ERR, ACK_CHECKSUM_ERR, ACK_READ_ONLY_ERR, ACK_DATA_ERR]).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it('ACK_NONE 是 -1，不占协议码位', () => {
    expect(ACK_NONE).toBe(-1);
  });
});
