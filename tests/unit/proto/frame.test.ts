import { describe, expect, it } from 'vitest';
import { PAYLOAD_BYTES, splitFrame } from '../../../src/renderer/src/device/protocol';
import {
  FUNC_ACK,
  FUNC_RAND_READ,
  FUNC_RAND_WRITE,
  FUNC_SEQ_READ,
  FUNC_SEQ_WRITE,
  decodeStream,
  encodeFrame,
  frameLength,
  type ParamFrame,
} from '../../../src/renderer/src/device/proto/frame';

interface BusinessFrame {
  readonly purpose: string;
  readonly func: number;
  readonly data: string;
  readonly frame: string;
}

function bytes(hexText: string): Uint8Array {
  return Uint8Array.from(hexText.split(' ').map((part) => Number.parseInt(part, 16)));
}

function toHex(input: Uint8Array): string {
  return Array.from(input)
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function seqReadReply(start: number, values: readonly number[]): Uint8Array {
  const data = new Uint8Array(4 + values.length * 2);
  data[0] = (start >>> 8) & 0xff;
  data[1] = start & 0xff;
  data[2] = (values.length >>> 8) & 0xff;
  data[3] = values.length & 0xff;
  for (let index = 0; index < values.length; index += 1) {
    data[4 + index * 2] = (values[index] >>> 8) & 0xff;
    data[5 + index * 2] = values[index] & 0xff;
  }
  return data;
}

/** 需求文档附录 A.7 的 11 条业务帧（完整帧 hex 逐字节比对） */
const BUSINESS_FRAMES: readonly BusinessFrame[] = [
  { purpose: '进入 DFU 写 0x1008=1', func: FUNC_RAND_WRITE, data: '10 08 00 01', frame: '00 10 00 0A 10 08 00 01 8D 09' },
  { purpose: '读型号码 0x0000-0x0002', func: FUNC_RAND_READ, data: '00 00 00 01 00 02', frame: '00 12 00 0C 00 00 00 01 00 02 B8 A6' },
  { purpose: '读设备名 0x0003-0x0005', func: FUNC_RAND_READ, data: '00 03 00 04 00 05', frame: '00 12 00 0C 00 03 00 04 00 05 AD 65' },
  { purpose: '读固件版本 0x000B-0x000E', func: FUNC_RAND_READ, data: '00 0B 00 0C 00 0D 00 0E', frame: '00 12 00 0E 00 0B 00 0C 00 0D 00 0E CD DC' },
  { purpose: '读 MIC 电平 0x2057', func: FUNC_RAND_READ, data: '20 57', frame: '00 12 00 08 20 57 61 E4' },
  { purpose: '写降噪开关 0x2024=1', func: FUNC_RAND_WRITE, data: '20 24 00 01', frame: '00 10 00 0A 20 24 00 01 43 C0' },
  { purpose: '连续读 0x2022 起 4 个', func: FUNC_SEQ_READ, data: '20 22 00 04', frame: '00 13 00 0A 20 22 00 04 50 C2' },
  { purpose: '连续读预设 0x2000 起 114 个', func: FUNC_SEQ_READ, data: '20 00 00 72', frame: '00 13 00 0A 20 00 00 72 71 2E' },
  { purpose: '读心跳 0x1000', func: FUNC_RAND_READ, data: '10 00', frame: '00 12 00 08 10 00 34 1A' },
  { purpose: 'ACK 成功', func: FUNC_ACK, data: '00 00', frame: '00 02 00 08 00 00 F8 19' },
  { purpose: 'ACK 校验和错', func: FUNC_ACK, data: '00 03', frame: '00 02 00 08 00 03 B8 18' },
];

/** ACK 六个错误码帧（0 = 成功，1..5 = 错误码） */
const ACK_FRAMES: readonly { readonly code: number; readonly frame: string }[] = [
  { code: 0, frame: '00 02 00 08 00 00 F8 19' },
  { code: 1, frame: '00 02 00 08 00 01 39 D9' },
  { code: 2, frame: '00 02 00 08 00 02 79 D8' },
  { code: 3, frame: '00 02 00 08 00 03 B8 18' },
  { code: 4, frame: '00 02 00 08 00 04 F9 DA' },
  { code: 5, frame: '00 02 00 08 00 05 38 1A' },
];

describe('encodeFrame — A.7 业务帧逐字节一致', () => {
  for (const item of BUSINESS_FRAMES) {
    it(`A.7 ${item.purpose}：${item.frame}`, () => {
      const frame = encodeFrame(item.func, bytes(item.data));

      expect(toHex(frame)).toBe(item.frame);
      expect(frame.length).toBe(bytes(item.data).length + 6);
      expect(frameLength({ unitId: frame[0], func: item.func, data: bytes(item.data) })).toBe(frame.length);
    });
  }
});

describe('decodeStream — A.7 业务帧可解回', () => {
  for (const item of BUSINESS_FRAMES) {
    it(`A.7 ${item.purpose} → func 0x${item.func.toString(16).toUpperCase()} / data ${item.data}`, () => {
      const result = decodeStream(bytes(item.frame));

      expect(result.issues).toEqual([]);
      expect(result.rest.length).toBe(0);
      expect(result.frames.length).toBe(1);
      expect(result.frames[0].unitId).toBe(0);
      expect(result.frames[0].func).toBe(item.func);
      expect(toHex(result.frames[0].data)).toBe(item.data);
      expect(frameLength(result.frames[0])).toBe(bytes(item.frame).length);
    });
  }
});

describe('ACK 错误码帧逐字节一致', () => {
  for (const ack of ACK_FRAMES) {
    it(`ACK 码 0x000${ack.code}：${ack.frame}`, () => {
      const frame = encodeFrame(FUNC_ACK, Uint8Array.from([0x00, ack.code]));
      const result = decodeStream(frame);

      expect(toHex(frame)).toBe(ack.frame);
      expect(result.frames.length).toBe(1);
      expect(result.frames[0].func).toBe(FUNC_ACK);
      expect(toHex(result.frames[0].data)).toBe(`00 0${ack.code}`);
    });
  }
});

describe('0x11 连续写帧（A.6 #5 覆盖字节，A.7 表内无 0x11 样例）', () => {
  it('00 11 00 0E 20 5B 00 02 00 01 00 02 39 42 逐字节一致', () => {
    const frame = encodeFrame(FUNC_SEQ_WRITE, bytes('20 5B 00 02 00 01 00 02'));
    const result = decodeStream(frame);

    expect(toHex(frame)).toBe('00 11 00 0E 20 5B 00 02 00 01 00 02 39 42');
    expect(result.frames.length).toBe(1);
    expect(result.frames[0].func).toBe(FUNC_SEQ_WRITE);
    expect(toHex(result.frames[0].data)).toBe('20 5B 00 02 00 01 00 02');
  });
});

describe('R1-3 分片重组 + 补位零消解', () => {
  it('298 B 的 0x13 响应 + 17 个补位 0x00（315 B）一次喂入：1 帧、0 issue、rest 只剩单个 0x00', () => {
    const values = Array.from({ length: 144 }, (_, index) => index);
    const data = seqReadReply(0x2000, values);
    const original = encodeFrame(FUNC_SEQ_READ, data);

    expect(data.length).toBe(292);
    expect(original.length).toBe(298);

    const padded = concat(original, new Uint8Array(17));
    expect(padded.length).toBe(315);

    const result = decodeStream(padded);

    expect(result.frames.length).toBe(1);
    expect(result.frames[0].func).toBe(FUNC_SEQ_READ);
    expect(toHex(result.frames[0].data)).toBe(toHex(data));
    expect(result.issues).toEqual([]);
    expect(result.rest.length).toBe(1);
    expect(result.rest[0]).toBe(0x00);
  });

  it('切成 5 个 63 B 载荷逐包喂入（串联同一缓冲）：每包喂完 issues 恒为 0，最终 1 帧、rest 只剩单个 0x00', () => {
    const values = Array.from({ length: 144 }, (_, index) => index);
    const data = seqReadReply(0x2000, values);
    const original = encodeFrame(FUNC_SEQ_READ, data);

    const reports = splitFrame(original);
    expect(reports.length).toBe(5);
    expect(reports.every((report) => report.length === PAYLOAD_BYTES)).toBe(true);

    const frames: ParamFrame[] = [];
    const issueCounts: number[] = [];
    const restLengths: number[] = [];
    let rest = new Uint8Array(0);
    for (const report of reports) {
      const result = decodeStream(concat(rest, report));
      frames.push(...result.frames);
      issueCounts.push(result.issues.length);
      rest = result.rest;
      restLengths.push(rest.length);
    }

    expect(issueCounts).toEqual([0, 0, 0, 0, 0]);
    expect(restLengths).toEqual([63, 126, 189, 252, 1]);
    expect(frames.length).toBe(1);
    expect(frames[0].func).toBe(FUNC_SEQ_READ);
    expect(frames[0].data.length).toBe(292);
    expect(toHex(frames[0].data)).toBe(toHex(data));
  });

  it('两次 decodeStream（半帧 → 补齐）等价于一次喂全', () => {
    const original = encodeFrame(FUNC_SEQ_READ, seqReadReply(0x2000, [0x1234, 0x5678]));
    const head = original.subarray(0, 5);
    const tail = original.subarray(5);

    const first = decodeStream(head);
    expect(first.frames.length).toBe(0);
    expect(first.issues).toEqual([]);
    expect(toHex(first.rest)).toBe(toHex(head));

    const second = decodeStream(concat(first.rest, tail));
    const whole = decodeStream(original);

    expect(second.frames.length).toBe(1);
    expect(whole.frames.length).toBe(1);
    expect(toHex(second.frames[0].data)).toBe(toHex(original.subarray(4, original.length - 2)));
    expect(toHex(second.frames[0].data)).toBe(toHex(whole.frames[0].data));
  });

  it('无间隔两帧一次喂入 → 解出两个帧', () => {
    const first = bytes('00 12 00 08 20 57 61 E4');
    const second = bytes('00 12 00 08 10 00 34 1A');
    const result = decodeStream(concat(first, second));

    expect(result.frames.map((frame) => toHex(frame.data))).toEqual(['20 57', '10 00']);
    expect(result.issues).toEqual([]);
    expect(result.rest.length).toBe(0);
  });
});

describe('补位零规则（§5.4.2 步骤 0）', () => {
  function padTo(report: Uint8Array, size: number): Uint8Array {
    return concat(report, new Uint8Array(size - report.length));
  }

  it('长串补位零不刷诊断：200 个 0x00 → 0 帧、0 issue、rest 只剩 1 个 0x00', () => {
    const result = decodeStream(new Uint8Array(200));

    expect(result.frames).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.rest.length).toBe(1);
    expect(result.rest[0]).toBe(0x00);
  });

  it('补位 + 下一帧：先喂 0x13 响应补到 63 B，再喂 ACK 补到 63 B → 2 帧有序、0 issue', () => {
    const seqReply = bytes('00 13 00 0A 20 22 00 04 50 C2');
    const ack = bytes('00 02 00 08 00 00 F8 19');
    const firstReport = padTo(seqReply, PAYLOAD_BYTES);
    const secondReport = padTo(ack, PAYLOAD_BYTES);

    const first = decodeStream(firstReport);
    expect(first.frames.map((frame) => toHex(frame.data))).toEqual(['20 22 00 04']);
    expect(first.issues).toEqual([]);
    expect(first.rest.length).toBe(1);

    const second = decodeStream(concat(first.rest, secondReport));
    expect(second.frames.map((frame) => frame.func)).toEqual([FUNC_ACK]);
    expect(toHex(second.frames[0].data)).toBe('00 00');
    expect(second.issues).toEqual([]);
    expect(second.rest.length).toBe(1);
    expect(second.rest[0]).toBe(0x00);

    // 两个 63 B 报文一次喂全，结果必须与逐包一致
    const whole = decodeStream(concat(firstReport, secondReport));
    expect(whole.frames.map((frame) => frame.func)).toEqual([FUNC_SEQ_READ, FUNC_ACK]);
    expect(whole.frames.map((frame) => toHex(frame.data))).toEqual(['20 22 00 04', '00 00']);
    expect(whole.issues).toEqual([]);
    expect(whole.rest.length).toBe(1);
  });

  it('单零保留：先喂 1 个 0x00（被切开的下一帧 UnitID）→ 0 帧、rest 1、0 issue；补齐后解出 ACK', () => {
    const first = decodeStream(Uint8Array.from([0x00]));
    expect(first.frames).toEqual([]);
    expect(first.issues).toEqual([]);
    expect(first.rest.length).toBe(1);

    const second = decodeStream(concat(first.rest, bytes('02 00 08 00 00 F8 19')));
    expect(second.frames.length).toBe(1);
    expect(second.frames[0].func).toBe(FUNC_ACK);
    expect(toHex(second.frames[0].data)).toBe('00 00');
    expect(second.issues).toEqual([]);
    expect(second.rest.length).toBe(0);
  });

  it('不是"丢弃所有前导零"：完整 ACK 帧（UnitID = 0x00）仍解出 1 帧', () => {
    const result = decodeStream(bytes('00 02 00 08 00 00 F8 19'));

    expect(result.frames.length).toBe(1);
    expect(result.frames[0].func).toBe(FUNC_ACK);
    expect(result.issues).toEqual([]);
    expect(result.rest.length).toBe(0);
  });

  it('两个 0x00 前缀不产生 issue：00 00 + 完整 ACK 帧 → 1 帧、0 issue、rest 0', () => {
    const result = decodeStream(concat(Uint8Array.from([0x00, 0x00]), bytes('00 02 00 08 00 00 F8 19')));

    expect(result.frames.length).toBe(1);
    expect(result.frames[0].func).toBe(FUNC_ACK);
    expect(result.issues).toEqual([]);
    expect(result.rest.length).toBe(0);
  });
});

describe('Len 边界（R1-5）', () => {
  it('Len = 6（空 Data）产出合法帧', () => {
    const frame = encodeFrame(FUNC_ACK, new Uint8Array(0));
    const result = decodeStream(frame);

    expect(toHex(frame.subarray(2, 4))).toBe('00 06');
    expect(frame.length).toBe(6);
    expect(result.frames.length).toBe(1);
    expect(result.frames[0].func).toBe(FUNC_ACK);
    expect(result.frames[0].data.length).toBe(0);
    expect(frameLength(result.frames[0])).toBe(6);
  });

  it('Len = 512（506 B Data）产出合法帧', () => {
    const data = Uint8Array.from({ length: 506 }, (_, index) => index & 0xff);
    const frame = encodeFrame(FUNC_SEQ_WRITE, data);
    const result = decodeStream(frame);

    expect(frame.length).toBe(512);
    expect(toHex(frame.subarray(2, 4))).toBe('02 00');
    expect(result.frames.length).toBe(1);
    expect(result.rest.length).toBe(0);
    expect(toHex(result.frames[0].data)).toBe(toHex(data));
    expect(frameLength(result.frames[0])).toBe(512);
  });

  it('Len = 513 记 capacity 问题，不产出帧、不抛异常', () => {
    const input = concat(Uint8Array.from([0x00, 0x13, 0x02, 0x01]), new Uint8Array(20));

    expect(() => decodeStream(input)).not.toThrow();
    const result = decodeStream(input);
    expect(result.frames.length).toBe(0);
    expect(result.issues[0].problem).toBe('capacity');
    expect(result.issues[0].offset).toBe(0);
  });

  it('Len < 6 记 length 问题，不产出帧', () => {
    const input = bytes('00 12 00 05 00 00');
    const result = decodeStream(input);

    expect(result.frames.length).toBe(0);
    expect(result.issues[0].problem).toBe('length');
    expect(result.issues[0].offset).toBe(0);
  });

  it('encodeFrame 超过 512 B 抛 RangeError（507 B Data → Len 513）', () => {
    expect(() => encodeFrame(FUNC_RAND_WRITE, new Uint8Array(507))).toThrow(RangeError);
    expect(() => encodeFrame(FUNC_RAND_WRITE, new Uint8Array(506))).not.toThrow();
  });
});

describe('decodeStream — 坏输入不抛异常（R1-4）', () => {
  it('半帧（30 B 的 0x13 响应头 + 部分数据）不产出帧，rest 保留全部输入，无 issue', () => {
    const input = concat(Uint8Array.from([0x00, 0x13, 0x01, 0x2a]), new Uint8Array(26));
    const result = decodeStream(input);

    expect(input.length).toBe(30);
    expect(result.frames.length).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.rest.length).toBe(30);
    expect(toHex(result.rest)).toBe(toHex(input));
  });

  it('截断（声明 Len = 20，只给 18 字节）不产出帧，rest 保留，无 issue', () => {
    const input = concat(Uint8Array.from([0x00, 0x13, 0x00, 0x14]), new Uint8Array(14));
    const result = decodeStream(input);

    expect(input.length).toBe(18);
    expect(result.frames.length).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.rest.length).toBe(18);
  });

  it('帧中间插入垃圾字节：记 crc 问题且不产出该帧', () => {
    const good = bytes('00 12 00 08 20 57 61 E4');
    const broken = concat(good.subarray(0, 4), Uint8Array.from([0xaa, 0xbb]), good.subarray(4));

    expect(() => decodeStream(broken)).not.toThrow();
    const result = decodeStream(broken);
    expect(result.frames.length).toBe(0);
    expect(result.issues[0].problem).toBe('crc');
    expect(result.issues[0].offset).toBe(0);
  });

  it('两帧之间插入垃圾字节：丢 1 字节重同步后仍解出后面的好帧', () => {
    const first = bytes('00 12 00 08 20 57 61 E4');
    const second = bytes('00 12 00 08 10 00 34 1A');
    const third = bytes('00 13 00 0A 20 22 00 04 50 C2');
    // 垃圾取非零字节：连续两个 0x00 现在被步骤 0 当补位静默跳过，不再产生 issue
    const stream = concat(first, Uint8Array.from([0xaa, 0xbb]), second, third);
    const result = decodeStream(stream);

    expect(result.frames.map((frame) => toHex(frame.data))).toEqual(['20 57', '10 00', '20 22 00 04']);
    expect(result.issues.map((issue) => issue.problem)).toEqual(['func', 'capacity']);
    expect(result.issues[0].offset).toBe(8);
    expect(result.rest.length).toBe(0);
  });

  it('CRC 不符：记 crc 问题，不产出帧，不抛异常', () => {
    const input = bytes('00 12 00 08 20 57 61 E5');
    const result = decodeStream(input);

    expect(result.frames.length).toBe(0);
    expect(result.issues[0].problem).toBe('crc');
    expect(result.issues[0].offset).toBe(0);
  });

  it('未知功能码：记 func 问题，不产出帧', () => {
    const input = bytes('00 0F 00 08 00 00 00 00');
    const result = decodeStream(input);

    expect(result.frames.length).toBe(0);
    expect(result.issues[0].problem).toBe('func');
    expect(result.issues[0].offset).toBe(0);
  });

  it('unitId 不匹配：记 unit 问题，不产出帧', () => {
    const input = bytes('00 12 00 08 20 57 61 E4');
    const result = decodeStream(input, 0x01);

    expect(result.frames.length).toBe(0);
    expect(result.issues[0].problem).toBe('unit');
    expect(result.issues[0].offset).toBe(0);
  });

  it('unitId 匹配时正常解析', () => {
    const input = bytes('00 12 00 08 20 57 61 E4');
    const result = decodeStream(input, 0x00);

    expect(result.frames.length).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it('空输入与不足 4 字节的输入都只回 rest', () => {
    const empty = decodeStream(new Uint8Array(0));
    expect(empty.frames).toEqual([]);
    expect(empty.issues).toEqual([]);
    expect(empty.rest.length).toBe(0);

    const short = decodeStream(bytes('00 12'));
    expect(short.frames).toEqual([]);
    expect(short.issues).toEqual([]);
    expect(toHex(short.rest)).toBe('00 12');
  });

  it('A3：100 轮随机字节不抛异常，返回结构自洽', () => {
    for (let round = 0; round < 100; round += 1) {
      const length = Math.floor(Math.random() * 700);
      const input = Uint8Array.from({ length }, () => Math.floor(Math.random() * 256));
      const snapshot = toHex(input);
      const expectedUnitId = round % 2 === 0 ? 0 : undefined;

      expect(() => decodeStream(input, expectedUnitId)).not.toThrow();
      const result = decodeStream(input, expectedUnitId);

      expect(toHex(input)).toBe(snapshot);
      expect(result.rest.length).toBeLessThanOrEqual(input.length);
      for (const frame of result.frames) {
        expect(frameLength(frame)).toBeGreaterThanOrEqual(6);
        expect(frameLength(frame)).toBeLessThanOrEqual(512);
        expect(frame.data.length).toBe(frameLength(frame) - 6);
      }
      for (const issue of result.issues) {
        expect(issue.offset).toBeGreaterThanOrEqual(0);
        expect(issue.offset).toBeLessThan(input.length);
        expect(issue.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('encodeFrame / frameLength', () => {
  it('unitId 参数写进首字节并参与 CRC 校验', () => {
    const frame = encodeFrame(FUNC_RAND_READ, bytes('20 57'), 0x07);

    expect(frame[0]).toBe(0x07);
    expect(decodeStream(frame, 0x07).frames.length).toBe(1);
    expect(decodeStream(frame, 0x00).issues[0].problem).toBe('unit');
  });

  it('frameLength = data.length + 6', () => {
    expect(frameLength({ unitId: 0, func: FUNC_ACK, data: new Uint8Array(0) })).toBe(6);
    expect(frameLength({ unitId: 0, func: FUNC_RAND_WRITE, data: new Uint8Array(4) })).toBe(10);
    expect(frameLength({ unitId: 0, func: FUNC_SEQ_WRITE, data: new Uint8Array(506) })).toBe(512);
  });

  it('frame.data 是新切片，与入参缓冲不共享', () => {
    const frame = encodeFrame(FUNC_RAND_READ, bytes('20 57'));
    const result = decodeStream(frame);
    const before = toHex(result.frames[0].data);

    frame.fill(0xff);

    expect(toHex(result.frames[0].data)).toBe(before);
  });

  it('不修改入参 data', () => {
    const data = bytes('20 24 00 01');
    const snapshot = toHex(data);

    encodeFrame(FUNC_RAND_WRITE, data);

    expect(toHex(data)).toBe(snapshot);
  });
});

describe('splitFrame', () => {
  it('空输入返回空数组', () => {
    expect(splitFrame(new Uint8Array(0))).toEqual([]);
  });

  it('265 B 输入 → 5 个 63 B 载荷，最后一包只有前 13 字节是有效数据', () => {
    const input = Uint8Array.from({ length: 265 }, (_, index) => index & 0xff);
    const reports = splitFrame(input);

    expect(reports.length).toBe(5);
    expect(reports.every((report) => report.length === PAYLOAD_BYTES)).toBe(true);
    const last = reports[reports.length - 1];
    expect(Array.from(last.subarray(0, 13))).toEqual(Array.from(input.subarray(252)));
    expect(Array.from(last.subarray(13))).toEqual(new Array(50).fill(0));
    expect(toHex(concat(...reports).subarray(0, 265))).toBe(toHex(input));
  });

  it('正好 63 B → 1 个载荷，不补字节', () => {
    const input = Uint8Array.from({ length: 63 }, (_, index) => index);
    const reports = splitFrame(input);

    expect(reports.length).toBe(1);
    expect(toHex(reports[0])).toBe(toHex(input));
  });

  it('126 B → 2 个载荷，无补位', () => {
    const input = Uint8Array.from({ length: 126 }, (_, index) => index & 0xff);
    const reports = splitFrame(input);

    expect(reports.length).toBe(2);
    expect(toHex(concat(...reports))).toBe(toHex(input));
  });

  it('尾部只补 0x00（C1），不出现 0xFF / 0xC4', () => {
    const input = encodeFrame(FUNC_RAND_READ, bytes('20 57'));
    const reports = splitFrame(input);
    const tail = reports[0].subarray(input.length);

    expect(input.length).toBe(8);
    expect(tail.length).toBe(55);
    expect(Array.from(tail).every((byte) => byte === 0x00)).toBe(true);
  });

  it('payloadBytes 可覆写', () => {
    const input = Uint8Array.from({ length: 20 }, (_, index) => index);
    const reports = splitFrame(input, 8);

    expect(reports.length).toBe(3);
    expect(reports.every((report) => report.length === 8)).toBe(true);
    expect(toHex(concat(...reports).subarray(0, 20))).toBe(toHex(input));
  });

  it('载荷与入参、载荷之间都不共享缓冲', () => {
    const input = Uint8Array.from({ length: 100 }, (_, index) => index & 0xff);
    const reports = splitFrame(input);
    const firstBefore = toHex(reports[0]);
    const secondBefore = toHex(reports[1]);

    input.fill(0xff);
    expect(toHex(reports[0])).toBe(firstBefore);
    expect(toHex(reports[1])).toBe(secondBefore);

    reports[0].fill(0x00);
    expect(toHex(reports[0])).not.toBe(firstBefore);
    expect(toHex(reports[1])).toBe(secondBefore);
  });

  it('payloadBytes 非正数抛 RangeError（避免死循环）', () => {
    expect(() => splitFrame(bytes('00 02 00 08 00 00 F8 19'), 0)).toThrow(RangeError);
    expect(() => splitFrame(bytes('00 02 00 08 00 00 F8 19'), -1)).toThrow(RangeError);
  });
});
