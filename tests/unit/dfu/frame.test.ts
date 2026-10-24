import { describe, expect, it } from 'vitest';
import * as dfu from '../../../src/renderer/src/device/dfu';
import {
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  DFU_CMD_STATUS,
  MAX_SIGMA_FRAME,
  SIGMA_ACK_CHECKSUM_ERR,
  SIGMA_ACK_DEV_ADDR_ERR,
  SIGMA_CMD_ACK,
  SIGMA_CMD_DFU,
  SIGMA_START,
  decodeDfuStatus,
  decodeSigmaAck,
  decodeSigmaStream,
  encodeDfuBlockFrame,
  encodeDfuInfoFrame,
  encodeSigmaFrame,
  sigmaCrc,
} from '../../../src/renderer/src/device/dfu/frame';
import type { SigmaFrame } from '../../../src/renderer/src/device/dfu/frame';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function toHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

function frame(cmd: number, data: Uint8Array): SigmaFrame {
  return { addr: 0, cmd, data };
}

/** EnterDfu：CMD=0x03 写参数 0x1008 = 1（不是 DFU 命令，是参数写）。 */
const ENTER_DFU = bytes(0xc4, 0x0b, 0x00, 0x00, 0x03, 0x08, 0x10, 0x01, 0x00, 0x15, 0xff);
/** DFU 状态帧 CONTINUE。 */
const STATUS_CONTINUE = bytes(0xc4, 0x0a, 0x00, 0x00, 0x0b, 0x01, 0x00, 0x03, 0x23, 0xff);
/** DFU 状态帧 SUCCESS。 */
const STATUS_SUCCESS = bytes(0xc4, 0x0a, 0x00, 0x00, 0x0b, 0x01, 0x00, 0x05, 0x21, 0xff);

describe('sigmaCrc', () => {
  it('is a 16-bit add-and-negate sum, not a polynomial crc', () => {
    // EnterDfu 前 9 字节之和 0xEB → 取反加一 0xFF15，低字节先发（DFU 材料 §1.2）。
    expect(sigmaCrc(ENTER_DFU.subarray(0, 9))).toBe(0xff15);
    expect(sigmaCrc(STATUS_CONTINUE.subarray(0, 8))).toBe(0xff23);
    expect(sigmaCrc(new Uint8Array(0))).toBe(0);
  });
});

describe('encodeSigmaFrame', () => {
  it('builds the EnterDfu frame byte for byte', () => {
    const encoded = encodeSigmaFrame(0x03, bytes(0x08, 0x10, 0x01, 0x00));
    expect(encoded).toHaveLength(11);
    expect(toHex(encoded)).toBe('C4 0B 00 00 03 08 10 01 00 15 FF');
    expect(Array.from(encoded)).toEqual(Array.from(ENTER_DFU));
  });

  it('keeps LEN little endian and puts ADDR before CMD', () => {
    const encoded = encodeSigmaFrame(SIGMA_CMD_DFU, bytes(0x01, 0x00, 0x03));
    expect(encoded[0]).toBe(SIGMA_START);
    expect(encoded[1]).toBe(10);
    expect(encoded[2]).toBe(0);
    expect(encoded[3]).toBe(0);
    expect(encoded[4]).toBe(SIGMA_CMD_DFU);
  });

  it('builds the CONTINUE and SUCCESS status frames', () => {
    const continueFrame = encodeSigmaFrame(SIGMA_CMD_DFU, bytes(0x01, 0x00, 0x03));
    expect(toHex(continueFrame)).toBe('C4 0A 00 00 0B 01 00 03 23 FF');
    expect(Array.from(continueFrame)).toEqual(Array.from(STATUS_CONTINUE));

    const successFrame = encodeSigmaFrame(SIGMA_CMD_DFU, bytes(0x01, 0x00, 0x05));
    expect(toHex(successFrame)).toBe('C4 0A 00 00 0B 01 00 05 21 FF');
    expect(Array.from(successFrame)).toEqual(Array.from(STATUS_SUCCESS));
  });

  it('accepts exactly 1022 bytes and rejects 1023', () => {
    const maximal = encodeSigmaFrame(SIGMA_CMD_DFU, new Uint8Array(MAX_SIGMA_FRAME - 7).fill(0x5a));
    expect(maximal).toHaveLength(MAX_SIGMA_FRAME);
    expect(() => encodeSigmaFrame(SIGMA_CMD_DFU, new Uint8Array(MAX_SIGMA_FRAME - 6))).toThrow(RangeError);
  });
});

describe('decodeSigmaStream', () => {
  it('splits the three frames and normalises cmd with & 0x7F', () => {
    const stream = new Uint8Array(ENTER_DFU.length + STATUS_CONTINUE.length + STATUS_SUCCESS.length);
    stream.set(ENTER_DFU, 0);
    stream.set(STATUS_CONTINUE, ENTER_DFU.length);
    stream.set(STATUS_SUCCESS, ENTER_DFU.length + STATUS_CONTINUE.length);

    const result = decodeSigmaStream(stream);
    expect(result.issues).toHaveLength(0);
    expect(result.rest).toHaveLength(0);
    expect(result.frames).toHaveLength(3);

    expect(result.frames[0].cmd).toBe(0x03);
    expect(Array.from(result.frames[0].data)).toEqual([0x08, 0x10, 0x01, 0x00]);
    expect(result.frames[1].cmd).toBe(SIGMA_CMD_DFU);
    expect(Array.from(result.frames[1].data)).toEqual([0x01, 0x00, 0x03]);
    expect(result.frames[2].cmd).toBe(SIGMA_CMD_DFU);
    expect(Array.from(result.frames[2].data)).toEqual([0x01, 0x00, 0x05]);
  });

  it('ignores bit7 of cmd once the crc passed', () => {
    const encoded = encodeSigmaFrame(0x0b | 0x80, bytes(0x01, 0x00, 0x03));
    const result = decodeSigmaStream(encoded);
    expect(result.issues).toHaveLength(0);
    expect(result.frames[0].cmd).toBe(0x0b);
  });

  it('resynchronises on a leading garbage byte and still emits the frame', () => {
    const stream = new Uint8Array(2 + STATUS_CONTINUE.length);
    stream[0] = 0x00;
    stream[1] = 0x01;
    stream.set(STATUS_CONTINUE, 2);

    const result = decodeSigmaStream(stream);
    expect(result.frames).toHaveLength(1);
    expect(result.issues.map((issue) => issue.problem)).toEqual(['start', 'start']);
    expect(result.issues.map((issue) => issue.offset)).toEqual([0, 1]);
  });

  it('reports crc issues and resynchronises on the next frame', () => {
    const corrupted = Uint8Array.from(STATUS_CONTINUE);
    corrupted[7] = 0x04;
    const stream = new Uint8Array(corrupted.length + STATUS_SUCCESS.length);
    stream.set(corrupted, 0);
    stream.set(STATUS_SUCCESS, corrupted.length);

    const result = decodeSigmaStream(stream);
    expect(result.issues[0].problem).toBe('crc');
    expect(result.issues[0].offset).toBe(0);
    expect(result.frames).toHaveLength(1);
    expect(Array.from(result.frames[0].data)).toEqual([0x01, 0x00, 0x05]);
  });

  it('rejects LEN < 9 as a length problem', () => {
    const result = decodeSigmaStream(bytes(0xc4, 0x08, 0x00, 0x00, 0x0b, 0x00, 0x00, 0x00));
    expect(result.frames).toHaveLength(0);
    expect(result.issues[0].problem).toBe('length');
    expect(result.issues[0].offset).toBe(0);
  });

  it('rejects LEN > 1022 as a capacity problem', () => {
    const result = decodeSigmaStream(bytes(0xc4, 0xff, 0x03, 0x00, 0x0b));
    expect(result.frames).toHaveLength(0);
    expect(result.issues[0].problem).toBe('capacity');
    expect(result.issues[0].detail).toContain('1023');
  });

  it('drops the whole frame when ADDR is not 0', () => {
    const encoded = encodeSigmaFrame(SIGMA_CMD_DFU, bytes(0x01, 0x00, 0x03), 1);
    const result = decodeSigmaStream(encoded);
    expect(result.frames).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].problem).toBe('addr');
    expect(result.rest).toHaveLength(0);
  });

  it('returns the trailing partial frame as rest without an issue', () => {
    const partial = STATUS_CONTINUE.subarray(0, 6);
    const result = decodeSigmaStream(partial);
    expect(result.frames).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
    expect(Array.from(result.rest)).toEqual(Array.from(partial));

    const headerOnly = decodeSigmaStream(STATUS_CONTINUE.subarray(0, 2));
    expect(Array.from(headerOnly.rest)).toEqual([0xc4, 0x0a]);
    expect(headerOnly.issues).toHaveLength(0);
  });

  it('reassembles one 265 byte block frame fed in five 63 byte reports', () => {
    const payload = new Uint8Array(256);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7 + 3) & 0xff;
    const blockFrame = encodeDfuBlockFrame(payload);
    expect(blockFrame).toHaveLength(265);

    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < blockFrame.length; offset += 63) {
      chunks.push(blockFrame.subarray(offset, Math.min(offset + 63, blockFrame.length)));
    }
    expect(chunks).toHaveLength(5);
    expect(chunks.map((chunk) => chunk.length)).toEqual([63, 63, 63, 63, 13]);

    let pending = new Uint8Array(0);
    const decoded: SigmaFrame[] = [];
    const frameCounts: number[] = [];
    for (const chunk of chunks) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending, 0);
      merged.set(chunk, pending.length);
      const result = decodeSigmaStream(merged);
      expect(result.issues).toHaveLength(0);
      decoded.push(...result.frames);
      frameCounts.push(decoded.length);
      pending = result.rest;
    }

    expect(frameCounts).toEqual([0, 0, 0, 0, 1]);
    expect(pending).toHaveLength(0);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].cmd).toBe(SIGMA_CMD_DFU);
    expect(decoded[0].data[0]).toBe(DFU_CMD_BLOCK);
    expect(Array.from(decoded[0].data.subarray(2))).toEqual(Array.from(payload));
  });
});

describe('encodeDfuBlockFrame', () => {
  it('produces 265 bytes for a 256 byte block and 10 bytes for a 1 byte block', () => {
    const full = encodeDfuBlockFrame(new Uint8Array(256).fill(0xa5));
    expect(full).toHaveLength(265);
    expect(full[0]).toBe(SIGMA_START);
    expect(full[1]).toBe(0x09);
    expect(full[2]).toBe(0x01);
    expect(full[3]).toBe(0x00);
    expect(full[4]).toBe(SIGMA_CMD_DFU);
    expect(full[5]).toBe(DFU_CMD_BLOCK);
    expect(full[6]).toBe(0x00);
    expect(full[7]).toBe(0xa5);
    expect(sigmaCrc(full.subarray(0, full.length - 2))).toBe(full[263] | (full[264] << 8));

    const tiny = encodeDfuBlockFrame(bytes(0x11));
    expect(tiny).toHaveLength(10);
    expect(Array.from(tiny.subarray(5, 8))).toEqual([DFU_CMD_BLOCK, 0x00, 0x11]);
  });

  it('rejects 257 bytes and 0 bytes', () => {
    expect(() => encodeDfuBlockFrame(new Uint8Array(257))).toThrow(RangeError);
    expect(() => encodeDfuBlockFrame(new Uint8Array(0))).toThrow(RangeError);
  });
});

describe('encodeDfuInfoFrame', () => {
  it('lays out a 90 byte frame with the DFU material field offsets', () => {
    const encoded = encodeDfuInfoFrame({
      modelCode: 'Bootld',
      modelName: '000000',
      version: { x: 1, y: 2, z: 3 },
      length: 20984,
      checksum: 0x4e0621af,
    });

    expect(encoded).toHaveLength(90);
    expect(encoded[1] | (encoded[2] << 8)).toBe(90);

    const result = decodeSigmaStream(encoded);
    expect(result.issues).toHaveLength(0);
    expect(result.frames).toHaveLength(1);
    const data = result.frames[0].data;
    expect(result.frames[0].cmd).toBe(SIGMA_CMD_DFU);
    expect(data).toHaveLength(83);
    expect(data[0]).toBe(DFU_CMD_INFO);
    expect(data[1]).toBe(0x00);

    const body = data.subarray(2);
    expect(String.fromCharCode(...body.subarray(0, 6))).toBe('Bootld');
    expect(String.fromCharCode(...body.subarray(6, 12))).toBe('000000');
    expect(Array.from(body.subarray(12, 70))).toEqual(new Array(58).fill(0x00));
    expect(Array.from(body.subarray(70, 73))).toEqual([1, 2, 3]);
    expect(Array.from(body.subarray(73, 77))).toEqual([0xf8, 0x51, 0x00, 0x00]);
    expect(Array.from(body.subarray(77, 81))).toEqual([0xaf, 0x21, 0x06, 0x4e]);
  });

  it('rejects a model code longer than 6 characters', () => {
    expect(() =>
      encodeDfuInfoFrame({
        modelCode: 'TOOLONG',
        modelName: '000000',
        version: { x: 0, y: 0, z: 0 },
        length: 0,
        checksum: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('dfu barrel', () => {
  it('re-exports the frame layer and the image layer without name clashes', () => {
    expect(dfu.SIGMA_START).toBe(0xc4);
    expect(dfu.MAX_SIGMA_FRAME).toBe(1022);
    expect(dfu.GAMMA_KEY).toBe(0x1c9cbb63);
    expect(dfu.BLOCK_BYTES).toBe(256);
    for (const name of [
      'sigmaCrc',
      'encodeSigmaFrame',
      'decodeSigmaStream',
      'encodeDfuInfoFrame',
      'encodeDfuBlockFrame',
      'decodeDfuStatus',
      'decodeSigmaAck',
      'gammaDecrypt',
      'gammaEncrypt',
      'sum32LittleEndianWords',
      'parseImage',
      'encodeInfoFrame',
      'encodeBlockFrame',
    ] as const) {
      expect(typeof dfu[name]).toBe('function');
    }
  });
});

describe('decodeDfuStatus / decodeSigmaAck', () => {
  it('reads the status byte at data[2]', () => {
    const decoded = decodeSigmaStream(STATUS_CONTINUE);
    expect(decodeDfuStatus(decoded.frames[0])).toEqual({ status: 0x03 });
  });

  it('returns null for non status frames', () => {
    expect(decodeDfuStatus(frame(SIGMA_CMD_DFU, bytes(DFU_CMD_BLOCK, 0x00, 0x03)))).toBeNull();
    expect(decodeDfuStatus(frame(SIGMA_CMD_ACK, bytes(0x00, 0x00)))).toBeNull();
    expect(decodeDfuStatus(frame(SIGMA_CMD_DFU, bytes(DFU_CMD_STATUS, 0x00)))).toBeNull();
  });

  it('reads the ack error code little endian, matching the DFU material bytes', () => {
    // DFU 材料 §2.5 实测：`C4 09 00 00 02 01 00 30 FF` = DEV_ADDR_ERR 0x0001，`02 03 00` = CHECKSUM_ERR 0x0003。
    expect(decodeSigmaAck(frame(SIGMA_CMD_ACK, bytes(0x01, 0x00)))).toEqual({ err: SIGMA_ACK_DEV_ADDR_ERR });
    expect(decodeSigmaAck(frame(SIGMA_CMD_ACK, bytes(0x03, 0x00)))).toEqual({ err: SIGMA_ACK_CHECKSUM_ERR });
  });

  it('returns null for non ack frames', () => {
    expect(decodeSigmaAck(frame(SIGMA_CMD_DFU, bytes(DFU_CMD_STATUS, 0x00, 0x03)))).toBeNull();
    expect(decodeSigmaAck(frame(SIGMA_CMD_ACK, bytes(0x00)))).toBeNull();
  });

  it('decodes the documented ack frame bytes end to end', () => {
    const result = decodeSigmaStream(bytes(0xc4, 0x09, 0x00, 0x00, 0x02, 0x03, 0x00, 0x2e, 0xff));
    expect(result.issues).toHaveLength(0);
    expect(decodeSigmaAck(result.frames[0])).toEqual({ err: SIGMA_ACK_CHECKSUM_ERR });
  });
});
