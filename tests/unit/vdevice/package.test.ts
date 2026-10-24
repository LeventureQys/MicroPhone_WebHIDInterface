import { describe, expect, it } from 'vitest';

import {
  APP_MAX_BYTES,
  BLOCK_BYTES,
  CMD_DFU,
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  DFU_STATUS_FAIL,
  DfuStack,
  SIGMA_OVERHEAD,
  decodeSigmaFrames,
  splitReports,
  sum32Words,
} from '../../../tools/vdevice/dfu-stack.mjs';
import {
  buildPackage,
  overrideLength,
  readInfoFields,
  syntheticImage,
  tamperByte,
  verifyFrames,
} from '../../../tools/vdevice/package.mjs';

const IMAGE_1024 = syntheticImage(1024);
const IMAGE_SHORT_TAIL = syntheticImage(1000);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function feedAll(bytes: Uint8Array): string[] {
  const replies: Uint8Array[] = [];
  const stack = new DfuStack({ modelCode: 'JYM001', onReplies: (batch) => replies.push(...batch) });
  for (const frame of decodeSigmaFrames(bytes)) {
    for (const report of splitReports(frame)) stack.feed(report);
  }
  const statuses = replies.map((report) => {
    const length = report[1] | (report[2] << 8);
    return hex(report.subarray(0, length));
  });
  return statuses;
}

describe('厂商格式升级包生成器（SubStage 2.2 / R6-4）', () => {
  it('1. 帧序列形状：EnterDfu → Info(90) → Block(265，末块可短)', () => {
    const built = buildPackage({ image: IMAGE_1024, modelCode: 'JYM001', version: { x: 1, y: 2, z: 3 } });
    const frames = decodeSigmaFrames(built.bytes);

    expect(hex(frames[0])).toBe('C4 0B 00 00 03 08 10 01 00 15 FF');
    expect(frames[1]).toHaveLength(90);
    expect(frames[1][4]).toBe(CMD_DFU);
    expect(frames[1][5]).toBe(DFU_CMD_INFO);

    const blocks = frames.slice(2);
    expect(blocks).toHaveLength(4);
    for (const block of blocks) {
      expect(block[4]).toBe(CMD_DFU);
      expect(block[5]).toBe(DFU_CMD_BLOCK);
      // 帧头 7（含 CRC）+ DFU_CMD/CHIP_ID 2 + 数据 256
      expect(block).toHaveLength(SIGMA_OVERHEAD + 2 + BLOCK_BYTES);
    }

    const shortTail = decodeSigmaFrames(buildPackage({ image: IMAGE_SHORT_TAIL, modelCode: 'JYM001' }).bytes);
    const tailBlocks = shortTail.slice(2);
    expect(tailBlocks).toHaveLength(4);
    expect(tailBlocks.slice(0, 3).map((frame) => frame.length)).toEqual([265, 265, 265]);
    expect(tailBlocks[3]).toHaveLength(SIGMA_OVERHEAD + 2 + 232);
  });

  it('2. 全帧 SigmaCRC 通过，FwLength 与 FwChecksum 对明文算', () => {
    const built = buildPackage({ image: IMAGE_1024, modelCode: 'JYM001', version: { x: 1, y: 2, z: 3 } });
    expect(() => verifyFrames(built.bytes)).not.toThrow();
    expect(built.info).toEqual({ length: 1024, checksum: sum32Words(IMAGE_1024), blocks: 4 });

    const fields = readInfoFields(built.bytes);
    expect(fields).toMatchObject({ modelCode: 'JYM001', version: { x: 1, y: 2, z: 3 }, length: 1024 });
    expect(fields.checksum).toBe(sum32Words(IMAGE_1024));
  });

  it('3. tamperByte 后设备侧末块回 0x04', () => {
    const built = buildPackage({ image: IMAGE_1024, modelCode: 'JYM001' });
    const tampered = tamperByte(built.bytes, 5);
    expect(tampered).toHaveLength(built.bytes.length);
    expect(() => verifyFrames(tampered)).not.toThrow();

    const statuses = feedAll(tampered);
    expect(statuses[statuses.length - 1]).toBe('C4 0A 00 00 0B 01 00 04 22 FF');
    // 帧 CRC 已重算，回执里不该出现 CHECKSUM_ERR（否则测的是另一条路径）
    expect(statuses.filter((frame) => frame === 'C4 09 00 00 02 03 00 2E FF')).toEqual([]);
    expect(DFU_STATUS_FAIL).toBe(4);
  });

  it('4. overrideLength(0x40000) 后帧仍全合法，只有 FwLength 字段被改', () => {
    const built = buildPackage({ image: IMAGE_1024, modelCode: 'JYM001' });
    const overridden = overrideLength(built.bytes, 0x40000);
    expect(overridden).toHaveLength(built.bytes.length);
    expect(() => verifyFrames(overridden)).not.toThrow();
    expect(readInfoFields(overridden).length).toBe(0x40000);
    expect(readInfoFields(overridden).checksum).toBe(sum32Words(IMAGE_1024));
    expect(decodeSigmaFrames(overridden)[1]).toHaveLength(90);
  });

  it('5. 镜像超过 0x30000 抛 RangeError', () => {
    expect(() => buildPackage({ image: syntheticImage(APP_MAX_BYTES + 1), modelCode: 'JYM001' })).toThrow(RangeError);
    expect(() => buildPackage({ image: new Uint8Array(0), modelCode: 'JYM001' })).toThrow(RangeError);
    expect(() => buildPackage({ image: IMAGE_1024, modelCode: 'TOO-LONG' })).toThrow(RangeError);
  });

  it('6. 不足 4 字节对齐的镜像右补 0x00 并计入 FwLength', () => {
    const built = buildPackage({ image: syntheticImage(1023), modelCode: 'JYM001' });
    expect(built.info.length).toBe(1024);
    expect(readInfoFields(built.bytes).length).toBe(1024);
    const padded = new Uint8Array(1024);
    padded.set(syntheticImage(1023), 0);
    expect(built.info.checksum).toBe(sum32Words(padded));
  });
});
