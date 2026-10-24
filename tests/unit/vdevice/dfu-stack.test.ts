import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BLOCK_BYTES,
  CMD_DFU,
  DFU_STATUS_CODE_ERR,
  DFU_STATUS_CONTINUE,
  DFU_STATUS_FAIL,
  DFU_STATUS_INFO_ERR,
  DFU_STATUS_SUCCESS,
  DfuStack,
  GAMMA_BYTES,
  SIGMA_ACK_CHECKSUM_ERR,
  SIGMA_ACK_DEV_ADDR_ERR,
  SIGMA_ACK_LEN_ERR,
  buildSigmaFrame,
  decodeSigmaFrames,
  gammaDecrypt,
  splitReports,
  sum32Words,
} from '../../../tools/vdevice/dfu-stack.mjs';
import { buildPackage, readInfoFields, syntheticImage, tamperByte } from '../../../tools/vdevice/package.mjs';

/** 出厂黄金包：Bootld / 21823 B / 84 帧 / FwLength 20984 / FwChecksum 0x4E0621AF */
const GOLDEN_RELATIVE = path.join(
  'Document',
  'Protocol',
  'Bootloader',
  'Tools',
  'Py',
  'INNO SoftEmbe_Bootloader(PD100UGen2) MCU [内部使用].bin',
);
const GOLDEN_PATH = path.resolve(process.cwd(), GOLDEN_RELATIVE);
const GOLDEN_PRESENT = existsSync(GOLDEN_PATH);

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

const STATUS_LITERAL: Readonly<Record<number, string>> = {
  [DFU_STATUS_INFO_ERR]: 'C4 0A 00 00 0B 01 00 01 25 FF',
  [DFU_STATUS_CODE_ERR]: 'C4 0A 00 00 0B 01 00 02 24 FF',
  [DFU_STATUS_CONTINUE]: 'C4 0A 00 00 0B 01 00 03 23 FF',
  [DFU_STATUS_FAIL]: 'C4 0A 00 00 0B 01 00 04 22 FF',
  [DFU_STATUS_SUCCESS]: 'C4 0A 00 00 0B 01 00 05 21 FF',
};

const ACK_LITERAL: Readonly<Record<number, string>> = {
  0x0000: 'C4 09 00 00 02 00 00 31 FF',
  [SIGMA_ACK_DEV_ADDR_ERR]: 'C4 09 00 00 02 01 00 30 FF',
  [SIGMA_ACK_LEN_ERR]: 'C4 09 00 00 02 02 00 2F FF',
  [SIGMA_ACK_CHECKSUM_ERR]: 'C4 09 00 00 02 03 00 2E FF',
};

interface Sink {
  readonly stack: DfuStack;
  readonly reports: Uint8Array[];
}

function createSink(opts: { modelCode?: string; allowBootld?: boolean } = {}): Sink {
  const reports: Uint8Array[] = [];
  const stack = new DfuStack({
    modelCode: opts.modelCode,
    allowBootld: opts.allowBootld,
    onReplies: (batch) => {
      reports.push(...batch);
    },
  });
  return { stack, reports };
}

/** 主机侧行为：一条帧切成 63 B 报告逐条发 */
function feedFrame(sink: Sink, frame: Uint8Array): void {
  for (const report of splitReports(frame)) sink.stack.feed(report);
}

/** 取出并清空回执；本栈回执最长 10 B，因此每条报告恰好一帧 */
function takeFrames(sink: Sink): string[] {
  const frames = sink.reports.map((report) => {
    expect(report[0]).toBe(0xc4);
    const length = report[1] | (report[2] << 8);
    return hex(report.subarray(0, length));
  });
  sink.reports.length = 0;
  return frames;
}

function packageFrames(bytes: Uint8Array): Uint8Array[] {
  return decodeSigmaFrames(bytes);
}

const SMALL_IMAGE = syntheticImage(1024);

describe('设备侧 DFU 协议栈（SubStage 2.2）', () => {
  it('1. 信息帧回 0x03，状态帧逐字节一致', () => {
    const built = buildPackage({ image: SMALL_IMAGE, modelCode: 'JYM001' });
    const frames = packageFrames(built.bytes);
    expect(hex(frames[0])).toBe('C4 0B 00 00 03 08 10 01 00 15 FF');
    expect(hex(bytesOf('C4 0B 00 00 03 08 10 01 00 15 FF'))).toBe(hex(frames[0]));

    const sink = createSink();
    feedFrame(sink, frames[0]);
    expect(takeFrames(sink)).toEqual([ACK_LITERAL[0x0000]]);

    feedFrame(sink, frames[1]);
    expect(takeFrames(sink)).toEqual(['C4 0A 00 00 0B 01 00 03 23 FF']);
    expect(sink.stack.state()).toBe('infoAccepted');
    expect(sink.stack.lastStatus()).toBe(DFU_STATUS_CONTINUE);
  });

  it('2. 82 块完整升级：除末块外全 0x03，末块 0x05', () => {
    const image = syntheticImage(BLOCK_BYTES * 81 + 128);
    const built = buildPackage({ image, modelCode: 'JYM001', version: { x: 1, y: 2, z: 3 } });
    expect(built.info.blocks).toBe(82);
    const frames = packageFrames(built.bytes);
    expect(frames).toHaveLength(2 + 82);

    const sink = createSink();
    feedFrame(sink, frames[0]);
    takeFrames(sink);
    feedFrame(sink, frames[1]);
    expect(takeFrames(sink)).toEqual([STATUS_LITERAL[DFU_STATUS_CONTINUE]]);

    const statuses: string[] = [];
    for (const frame of frames.slice(2)) {
      feedFrame(sink, frame);
      statuses.push(...takeFrames(sink));
    }
    expect(statuses).toHaveLength(82);
    expect(statuses.slice(0, 81)).toEqual(new Array<string>(81).fill(STATUS_LITERAL[DFU_STATUS_CONTINUE]));
    expect(statuses[81]).toBe('C4 0A 00 00 0B 01 00 05 21 FF');
    expect(sink.stack.state()).toBe('done');
    expect(sink.stack.completed()).toBe(true);
    expect(sink.stack.flash()).toEqual({ bytes: image.length, checksum: built.info.checksum, blocks: 82 });
  });

  it('3. 篡改 1 个数据字节后末块回 0x04', () => {
    const built = buildPackage({ image: SMALL_IMAGE, modelCode: 'JYM001' });
    const frames = packageFrames(tamperByte(built.bytes, 3));
    const sink = createSink();
    feedFrame(sink, frames[0]);
    feedFrame(sink, frames[1]);
    takeFrames(sink);
    const statuses: string[] = [];
    for (const frame of frames.slice(2)) {
      feedFrame(sink, frame);
      statuses.push(...takeFrames(sink));
    }
    expect(statuses[statuses.length - 1]).toBe(STATUS_LITERAL[DFU_STATUS_FAIL]);
    expect(sink.stack.state()).toBe('failed');
    expect(sink.stack.completed()).toBe(false);
  });

  it('4. ModelCode 不匹配回 0x01，后续块帧回 0x02', () => {
    const frames = packageFrames(buildPackage({ image: SMALL_IMAGE, modelCode: 'P0JY04' }).bytes);
    const sink = createSink({ modelCode: 'JYM001' });
    feedFrame(sink, frames[1]);
    expect(takeFrames(sink)).toEqual([STATUS_LITERAL[DFU_STATUS_INFO_ERR]]);
    expect(sink.stack.state()).toBe('idle');

    feedFrame(sink, frames[2]);
    expect(takeFrames(sink)).toEqual([STATUS_LITERAL[DFU_STATUS_CODE_ERR]]);
    expect(sink.stack.flash().bytes).toBe(0);
  });

  it('5. Bootld 包在 allowBootld 缺省时回 0x01，置 true 后回 0x03', () => {
    const frames = packageFrames(buildPackage({ image: SMALL_IMAGE, modelCode: 'Bootld' }).bytes);

    const strict = createSink({ modelCode: 'JYM001' });
    feedFrame(strict, frames[1]);
    expect(takeFrames(strict)).toEqual([STATUS_LITERAL[DFU_STATUS_INFO_ERR]]);
    expect(strict.stack.state()).toBe('idle');

    const relaxed = createSink({ modelCode: 'JYM001', allowBootld: true });
    feedFrame(relaxed, frames[1]);
    expect(takeFrames(relaxed)).toEqual([STATUS_LITERAL[DFU_STATUS_CONTINUE]]);
    expect(relaxed.stack.state()).toBe('infoAccepted');
  });

  it('6. 未发信息帧直接发块帧回 0x02', () => {
    const frames = packageFrames(buildPackage({ image: SMALL_IMAGE, modelCode: 'JYM001' }).bytes);
    const sink = createSink();
    feedFrame(sink, frames[2]);
    expect(takeFrames(sink)).toEqual([STATUS_LITERAL[DFU_STATUS_CODE_ERR]]);
    expect(sink.stack.flash().bytes).toBe(0);
  });

  it('7. 重发信息帧后指针归零，同一包可整轮重来并成功', () => {
    const frames = packageFrames(buildPackage({ image: SMALL_IMAGE, modelCode: 'JYM001' }).bytes);
    const sink = createSink();
    feedFrame(sink, frames[0]);
    feedFrame(sink, frames[1]);
    feedFrame(sink, frames[2]);
    expect(sink.stack.flash().bytes).toBe(BLOCK_BYTES);
    takeFrames(sink);

    feedFrame(sink, frames[1]);
    expect(takeFrames(sink)).toEqual([STATUS_LITERAL[DFU_STATUS_CONTINUE]]);
    expect(sink.stack.flash()).toEqual({ bytes: 0, checksum: 0, blocks: 0 });

    const statuses: string[] = [];
    for (const frame of frames.slice(2)) {
      feedFrame(sink, frame);
      statuses.push(...takeFrames(sink));
    }
    expect(statuses[statuses.length - 1]).toBe(STATUS_LITERAL[DFU_STATUS_SUCCESS]);
    expect(sink.stack.completed()).toBe(true);
  });

  it('8. ADDR 非 0 回 DEV_ADDR_ERR，SigmaCRC 错回 CHECKSUM_ERR 且指针不前进', () => {
    const frames = packageFrames(buildPackage({ image: SMALL_IMAGE, modelCode: 'JYM001' }).bytes);

    const badAddr = createSink();
    const infoData = frames[1].subarray(5, frames[1].length - 2);
    feedFrame(badAddr, buildSigmaFrame(CMD_DFU, infoData, 1));
    expect(takeFrames(badAddr)).toEqual(['C4 09 00 00 02 01 00 30 FF']);
    expect(badAddr.stack.state()).toBe('idle');

    const badCrc = createSink();
    feedFrame(badCrc, frames[0]);
    feedFrame(badCrc, frames[1]);
    feedFrame(badCrc, frames[2]);
    takeFrames(badCrc);
    expect(badCrc.stack.flash().bytes).toBe(BLOCK_BYTES);

    const broken = Uint8Array.from(frames[3]);
    broken[broken.length - 1] ^= 0xff;
    feedFrame(badCrc, broken);
    expect(takeFrames(badCrc)).toEqual(['C4 09 00 00 02 03 00 2E FF']);
    expect(badCrc.stack.flash().bytes).toBe(BLOCK_BYTES);
    expect(badCrc.stack.state()).toBe('infoAccepted');
  });

  it('9. LEN=2000 的伪帧回 LEN_ERR 且累积器被清空', () => {
    const sink = createSink();
    const fake = new Uint8Array(63);
    fake[0] = 0xc4;
    fake[1] = 2000 & 0xff;
    fake[2] = (2000 >> 8) & 0xff;
    fake[3] = 0x00;
    fake[4] = CMD_DFU;
    sink.stack.feed(fake);
    expect(takeFrames(sink)).toEqual([ACK_LITERAL[SIGMA_ACK_LEN_ERR]]);
    expect(sink.stack.state()).toBe('idle');

    const frames = packageFrames(buildPackage({ image: SMALL_IMAGE, modelCode: 'JYM001' }).bytes);
    feedFrame(sink, frames[1]);
    expect(takeFrames(sink)).toEqual([STATUS_LITERAL[DFU_STATUS_CONTINUE]]);
  });

  const goldenTest = GOLDEN_PRESENT ? it : it.skip;
  if (!GOLDEN_PRESENT) console.warn(`skip 10: golden package missing: ${GOLDEN_RELATIVE}`);

  goldenTest('10. 出厂包密文经 gammaDecrypt + sum32Words 得到向量表与 0x4E0621AF', () => {
    const bytes = new Uint8Array(readFileSync(GOLDEN_PATH));
    const frames = packageFrames(bytes);
    expect(bytes.length).toBe(21823);
    expect(frames).toHaveLength(84);
    expect(readInfoFields(bytes)).toMatchObject({ modelCode: 'Bootld', length: 20984, checksum: 0x4e0621af });

    const cipher = new Uint8Array(20984);
    let offset = 0;
    for (const frame of frames.slice(2)) {
      const payload = frame.subarray(7, frame.length - 2);
      cipher.set(payload, offset);
      offset += payload.length;
    }
    expect(offset).toBe(20984);
    expect(offset).toBeGreaterThan(GAMMA_BYTES);

    const plain = gammaDecrypt(cipher);
    expect(hex(plain.subarray(0, 8))).toBe('B8 41 00 20 65 42 00 00');
    expect(hex(plain.subarray(GAMMA_BYTES, GAMMA_BYTES + 8))).toBe(hex(cipher.subarray(GAMMA_BYTES, GAMMA_BYTES + 8)));
    expect(sum32Words(plain)).toBe(0x4e0621af);
  });
});
