import { describe, expect, it } from 'vitest';

import {
  ACK_CHECKSUM_ERR,
  ACK_DATA_ERR,
  ACK_DEV_ADDR_ERR,
  ACK_LEN_ERR,
  ACK_NO_ERR,
  ACK_READ_ONLY_ERR,
  MODE_APP,
  MODE_BOOTLOADER,
  PAYLOAD_BYTES,
  ParamStack,
  REPORT_ID_IN,
  buildFrame,
  crc16,
  defaultRegisters,
  splitReports,
} from '../../../tools/vdevice/device-stack.mjs';

/** 需求附录 A.7 的完整帧字面量：请求侧逐字节固定，回执侧才是本栈的自由度 */
const FRAME = {
  writeEncOnOff: '00 10 00 0A 20 24 00 01 43 C0',
  writeEnterDfu: '00 10 00 0A 10 08 00 01 8D 09',
  readNoiseGate: '00 12 00 0A 20 5B 20 5C 89 E1',
  readLevel: '00 12 00 08 20 57 61 E4',
  seqReadPresetHead: '00 13 00 0A 20 00 00 02 70 CA',
};

const ACK_LITERAL: Readonly<Record<number, string>> = {
  [ACK_NO_ERR]: '00 02 00 08 00 00 F8 19',
  [ACK_DEV_ADDR_ERR]: '00 02 00 08 00 01 39 D9',
  [ACK_LEN_ERR]: '00 02 00 08 00 02 79 D8',
  [ACK_CHECKSUM_ERR]: '00 02 00 08 00 03 B8 18',
  [ACK_READ_ONLY_ERR]: '00 02 00 08 00 04 F9 DA',
  [ACK_DATA_ERR]: '00 02 00 08 00 05 38 1A',
};

interface Sink {
  readonly stack: ParamStack;
  readonly reports: Uint8Array[];
}

function createSink(registers?: Map<number, number>): Sink {
  const reports: Uint8Array[] = [];
  const stack = new ParamStack({
    registers,
    onReplies: (batch) => {
      reports.push(...batch);
    },
  });
  return { stack, reports };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function bytesOf(text: string): Uint8Array {
  return Uint8Array.from(
    text
      .trim()
      .split(/\s+/)
      .map((token) => Number.parseInt(token, 16)),
  );
}

function frameHex(report: Uint8Array): string {
  const len = (report[2] << 8) | report[3];
  return hex(report.subarray(0, len));
}

function frameList(sink: Sink): string[] {
  return sink.reports.map(frameHex);
}

/** 一帧装进一条 63 B 报告（请求帧都 < 63 B） */
function oneReport(frame: Uint8Array): Uint8Array {
  const reports = splitReports(frame);
  expect(reports).toHaveLength(1);
  return reports[0];
}

/** buildFrame 固定写 UnitID=0，这里改成别的地址后再补一次 CRC */
function frameWithUnit(unit: number, func: number, data: number[]): Uint8Array {
  const frame = buildFrame(func, data);
  frame[0] = unit;
  const crc = crc16(frame.subarray(0, frame.length - 2));
  frame[frame.length - 2] = crc & 0xff;
  frame[frame.length - 1] = (crc >> 8) & 0xff;
  return frame;
}

describe('设备侧参数协议栈（SubStage 2.1）', () => {
  it('1. 黄金回执：写、随机读、连续读、读电平逐字节一致', () => {
    const write = createSink();
    write.stack.feed(oneReport(bytesOf(FRAME.writeEncOnOff)));
    expect(frameList(write)).toEqual([ACK_LITERAL[ACK_NO_ERR]]);
    expect(write.stack.readRegister(0x2024)).toBe(1);

    const randRead = createSink();
    randRead.stack.feed(oneReport(bytesOf(FRAME.readNoiseGate)));
    expect(frameList(randRead)).toEqual(['00 12 00 0E 20 5B 00 00 20 5C 00 32 D5 C0']);

    const seqRead = createSink();
    seqRead.stack.feed(oneReport(bytesOf(FRAME.seqReadPresetHead)));
    expect(frameList(seqRead)).toEqual(['00 13 00 0E 20 00 00 02 00 00 00 01 C9 FE']);

    const levelRead = createSink();
    levelRead.stack.feed(oneReport(bytesOf(FRAME.readLevel)));
    expect(frameList(levelRead)).toEqual(['00 12 00 0A 20 57 00 00 50 1B']);
    const [levelReport] = levelRead.reports;
    expect(levelReport[1]).toBe(0x12);
    expect((levelReport[6] << 8) | levelReport[7]).toBe(0);
  });

  it('2. 写只读寄存器回 0x0004 且寄存器未改动', () => {
    const sink = createSink();
    sink.stack.feed(oneReport(buildFrame(0x10, [0x20, 0x23, 0x00, 0x01])));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_READ_ONLY_ERR]]);
    expect(sink.stack.readRegister(0x2023)).toBe(100);
    expect(sink.stack.stats().rejectedReadOnly).toBe(1);
  });

  it('3. 写超范围值回 0x0005 且寄存器未改动', () => {
    const sink = createSink();
    sink.stack.feed(oneReport(buildFrame(0x10, [0x20, 0x24, 0x00, 0x02])));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_DATA_ERR]]);
    expect(sink.stack.readRegister(0x2024)).toBe(0);
    expect(sink.stack.stats().rejectedRange).toBe(1);
  });

  it('4. 同批写入含非法项时整帧不落地', () => {
    const sink = createSink();
    sink.stack.feed(oneReport(buildFrame(0x10, [0x20, 0x24, 0x00, 0x01, 0x20, 0x23, 0x00, 0x01])));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_READ_ONLY_ERR]]);
    expect(sink.stack.readRegister(0x2024)).toBe(0);
  });

  it('5. 长度字段与数据长度不符回 0x0002', () => {
    const sink = createSink();
    sink.stack.feed(oneReport(buildFrame(0x10, [0x20, 0x24, 0x01])));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_LEN_ERR]]);

    sink.reports.length = 0;
    sink.stack.feed(oneReport(buildFrame(0x11, [0x20, 0x5B, 0x00, 0x02, 0x00, 0x01])));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_LEN_ERR]]);
  });

  it('6. 未知功能码回 0x0002 并计入 unknownFunc', () => {
    const sink = createSink();
    sink.stack.feed(oneReport(buildFrame(0x7e, [])));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_LEN_ERR]]);
    expect(sink.stack.stats().unknownFunc).toBe(1);
  });

  it('7. CRC 错回 0x0003', () => {
    const sink = createSink();
    const request = buildFrame(0x12, [0x20, 0x57]);
    request[request.length - 1] ^= 0xff;
    sink.stack.feed(oneReport(request));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_CHECKSUM_ERR]]);
  });

  it('8. UnitID 非 0 回 0x0001', () => {
    const sink = createSink();
    sink.stack.feed(oneReport(frameWithUnit(0x01, 0x12, [0x20, 0x57])));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_DEV_ADDR_ERR]]);
  });

  it('9. 一帧拆成两条报告与一次喂入产生相同回执，且半帧不出回执', () => {
    const request = buildFrame(0x11, [0x20, 0x02, 0x00, 0x1e, ...new Array<number>(60).fill(0)]);
    expect(request.length).toBe(70);
    const chunks = splitReports(request);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(PAYLOAD_BYTES);

    const whole = createSink();
    whole.stack.feed(request);

    const split = createSink();
    split.stack.feed(chunks[0]);
    expect(split.reports).toEqual([]);
    split.stack.feed(chunks[1]);

    expect(split.reports.map(frameHex)).toEqual(whole.reports.map(frameHex));
    expect(whole.reports).toHaveLength(1);
    expect(frameHex(whole.reports[0])).toBe(ACK_LITERAL[ACK_NO_ERR]);
  });

  it('10. 一条报告含两帧时两条回执顺序与入站一致', () => {
    const first = buildFrame(0x12, [0x20, 0x5b]);
    const second = buildFrame(0x12, [0x20, 0x5c]);
    const payload = new Uint8Array(PAYLOAD_BYTES);
    payload.set(first, 0);
    payload.set(second, first.length);

    const sink = createSink();
    sink.stack.feed(payload);
    expect(frameList(sink)).toEqual([
      hex(buildFrame(0x12, [0x20, 0x5b, 0x00, 0x00])),
      hex(buildFrame(0x12, [0x20, 0x5c, 0x00, 0x32])),
    ]);
  });

  it('11. 写 0x1008=1 先回 0x0000 再置 dfuRequested', () => {
    const sink = createSink();
    const request = bytesOf(FRAME.writeEnterDfu);
    expect(hex(request)).toBe(FRAME.writeEnterDfu);
    sink.stack.feed(oneReport(request));
    expect(frameList(sink)).toEqual([ACK_LITERAL[ACK_NO_ERR]]);
    expect(sink.stack.dfuRequested()).toBe(true);
    expect(sink.stack.readRegister(0x1008)).toBe(1);
  });

  it('12. 默认寄存器 190 项且关键默认值固定', () => {
    const registers = defaultRegisters();
    expect(registers.size).toBe(190);
    expect(registers.get(0x2024)).toBe(0);
    expect(registers.get(0x2025)).toBe(0);
    expect(registers.get(0x205b)).toBe(0);
    expect(registers.get(0x205c)).toBe(50);
    expect(registers.get(0x2001)).toBe(1);
    expect(registers.get(0x2023)).toBe(100);
    expect(registers.get(0x205a)).toBe(100);
    expect(REPORT_ID_IN).toBe(17);
  });

  it('13. crc16/buildFrame 与需求附录 A.6 的 8 条向量一致', () => {
    const vectors = [
      { covered: '11 03 00 2B 00 01', crc: 'F6 92' },
      { covered: '00 02 00 08 00 00', crc: 'F8 19' },
      { covered: '00 02 00 08 00 05', crc: '38 1A' },
      { covered: '00 10 00 0A 20 24 00 01', crc: '43 C0' },
      { covered: '00 11 00 0E 20 5B 00 02 00 01 00 02', crc: '39 42' },
      { covered: '00 12 00 0A 20 5B 20 5C', crc: '89 E1' },
      { covered: '00 12 00 0E 20 5B 00 00 20 5C 00 32', crc: 'D5 C0' },
      { covered: '00 13 00 0A 20 00 00 02', crc: '70 CA' },
    ];
    for (const vector of vectors) {
      const covered = bytesOf(vector.covered);
      const expected = bytesOf(vector.crc);
      expect(crc16(covered), vector.covered).toBe(expected[0] | (expected[1] << 8));
      if (((covered[2] << 8) | covered[3]) === covered.length) {
        const frame = buildFrame(covered[1], covered.subarray(4));
        expect(hex(frame)).toBe(`${vector.covered} ${vector.crc}`);
        expect((frame[2] << 8) | frame[3]).toBe(frame.length);
      }
    }
  });

  it('14. hooks.onFrame 能看到解出的帧，action=drop 时不出回执', () => {
    const seen: Array<{ func: number; len: number; at: number; mode: string }> = [];
    const reports: Uint8Array[] = [];
    const stack = new ParamStack({
      now: () => 1234,
      onReplies: (batch) => {
        reports.push(...batch);
      },
      hooks: {
        onFrame: (frame) => {
          seen.push({ func: frame.func, len: frame.len, at: frame.at, mode: frame.mode });
          frame.action = 'drop';
        },
      },
    });
    stack.feed(oneReport(buildFrame(0x12, [0x20, 0x57])));
    expect(seen).toEqual([{ func: 0x12, len: 8, at: 1234, mode: MODE_APP }]);
    expect(reports).toEqual([]);
  });

  it('15. bootloader 模式不答参数帧，reset 丢弃半帧', () => {
    const sink = createSink();
    sink.stack.setMode(MODE_BOOTLOADER);
    sink.stack.feed(oneReport(bytesOf(FRAME.readLevel)));
    expect(sink.reports).toEqual([]);
    expect(sink.stack.mode).toBe(MODE_BOOTLOADER);

    sink.stack.setMode(MODE_APP);
    const chunks = splitReports(buildFrame(0x11, [0x20, 0x02, 0x00, 0x1e, ...new Array<number>(60).fill(0)]));
    sink.stack.feed(chunks[0]);
    expect(sink.reports).toEqual([]);
    sink.stack.reset();
    sink.stack.feed(oneReport(bytesOf(FRAME.readLevel)));
    expect(frameList(sink)).toEqual(['00 12 00 0A 20 57 00 00 50 1B']);
  });

  it('16. stats/snapshot/info 反映应答计数与寄存器文件', () => {
    const sink = createSink();
    sink.stack.feed(oneReport(bytesOf(FRAME.readNoiseGate)));
    expect(sink.stack.stats()).toEqual({
      framesIn: 1,
      framesOut: 1,
      byFunc: { '18': 1 },
      unknownFunc: 0,
      rejectedReadOnly: 0,
      rejectedRange: 0,
    });
    const snapshot = sink.stack.snapshot();
    expect(Object.keys(snapshot)).toHaveLength(190);
    expect(snapshot['0x2024']).toBe(0);
    expect(sink.stack.info()).toMatchObject({
      modelCode: 'JYM001',
      deviceName: 'MIC M001',
      serial: 'VHID-MIC-M001',
      vid: 0x0a67,
      pid: 0x0010,
      firmware: { x: 1, y: 0, z: 0, build: 0, type: 1 },
    });
  });
});
