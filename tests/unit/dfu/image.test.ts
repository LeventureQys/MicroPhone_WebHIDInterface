import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  APP_MAX_BYTES,
  BLOCK_BYTES,
  BOOT_MAX_BYTES,
  BOOT_MODEL_CODE,
  GAMMA_BYTES,
  GAMMA_KEY,
  encodeBlockFrame,
  encodeInfoFrame,
  gammaDecrypt,
  gammaEncrypt,
  parseImage,
  sum32LittleEndianWords,
} from '../../../src/renderer/src/device/dfu/image';
import type { DfuInfo, ParsedImage } from '../../../src/renderer/src/device/dfu/image';
import { encodeSigmaFrame, sigmaCrc } from '../../../src/renderer/src/device/dfu/frame';

const ENTER_DFU_DATA = new Uint8Array([0x08, 0x10, 0x01, 0x00]);

function plainBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

interface BuildOptions {
  readonly modelCode?: string;
  readonly modelName?: string;
  readonly version?: { readonly x: number; readonly y: number; readonly z: number };
  /** 默认 256；末块取余数。 */
  readonly blockSize?: number;
  /** 显式给出块序列（已加密），忽略 plain/blockSize。 */
  readonly blocks?: readonly Uint8Array[];
  /** 默认取 Σ 块长。 */
  readonly lengthOverride?: number;
  readonly checksumOverride?: number;
  /** 把末块截到指定字节数，用于 notAligned 用例。 */
  readonly truncateLastBlockTo?: number;
}

function buildPackage(plain: Uint8Array, options: BuildOptions = {}): Uint8Array {
  const blockSize = options.blockSize ?? BLOCK_BYTES;
  const cipher = gammaEncrypt(plain);
  const blocks: Uint8Array[] = options.blocks ? options.blocks.map((block) => Uint8Array.from(block)) : [];
  if (!options.blocks) {
    for (let offset = 0; offset < cipher.length; offset += blockSize) {
      blocks.push(cipher.slice(offset, Math.min(offset + blockSize, cipher.length)));
    }
  }
  if (options.truncateLastBlockTo !== undefined) {
    const last = blocks[blocks.length - 1];
    blocks[blocks.length - 1] = last.slice(0, options.truncateLastBlockTo);
  }

  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const info: DfuInfo = {
    modelCode: options.modelCode ?? '000000',
    modelName: options.modelName ?? '000000',
    version: options.version ?? { x: 0, y: 0, z: 0 },
    length: options.lengthOverride ?? total,
    checksum: options.checksumOverride ?? sum32LittleEndianWords(plain),
  };

  return concat([
    encodeSigmaFrame(0x03, ENTER_DFU_DATA),
    encodeInfoFrame(info),
    ...blocks.map((block) => encodeBlockFrame(block)),
  ]);
}

interface FrameSpan {
  readonly offset: number;
  readonly length: number;
}

function frameSpans(bytes: Uint8Array): FrameSpan[] {
  const spans: FrameSpan[] = [];
  let pos = 0;
  while (pos + 2 < bytes.length) {
    const length = bytes[pos + 1] | (bytes[pos + 2] << 8);
    if (length === 0) break;
    spans.push({ offset: pos, length });
    pos += length;
  }
  return spans;
}

function reseal(bytes: Uint8Array, span: FrameSpan): void {
  const crc = sigmaCrc(bytes.subarray(span.offset, span.offset + span.length - 2));
  bytes[span.offset + span.length - 2] = crc & 0xff;
  bytes[span.offset + span.length - 1] = (crc >>> 8) & 0xff;
}

function expectImage(result: ReturnType<typeof parseImage>): ParsedImage {
  if (!result.ok) throw new Error(`expected a parsed image, got ${result.rejection.problem}: ${result.rejection.message}`);
  return result.image;
}

describe('gamma cipher', () => {
  it('round trips 1024 bytes with the little endian key bytes', () => {
    const plain = plainBytes(1024);
    const cipher = gammaEncrypt(plain);
    expect(Array.from(gammaDecrypt(cipher))).toEqual(Array.from(plain));

    // 密钥 0x1C9CBB63 的小端字节序：i%4 = 0 异或 0x63，1 → 0xBB，2 → 0x9C，3 → 0x1C。
    expect(GAMMA_KEY).toBe(0x1c9cbb63);
    expect([GAMMA_KEY & 0xff, (GAMMA_KEY >> 8) & 0xff, (GAMMA_KEY >> 16) & 0xff, (GAMMA_KEY >> 24) & 0xff]).toEqual([
      0x63, 0xbb, 0x9c, 0x1c,
    ]);

    // 手算向量：p[0]=7 → (7^0x63)=0x64 → nibbleSwap=0x46 → +0xA3=0xE9；
    // p[5]=162 → (162^0xBB)=0x19 → nibbleSwap=0x91 → +0xA3=0x34。
    expect(cipher[0]).toBe(0xe9);
    expect(cipher[5]).toBe(0x34);
    expect(gammaDecrypt(cipher)).toHaveLength(1024);
  });

  it('round trips 9000 bytes and leaves everything past 8192 untouched', () => {
    const plain = plainBytes(9000);
    const cipher = gammaEncrypt(plain);
    expect(Array.from(gammaDecrypt(cipher))).toEqual(Array.from(plain));
    expect(GAMMA_BYTES).toBe(8192);
    expect(Array.from(cipher.subarray(GAMMA_BYTES))).toEqual(Array.from(plain.subarray(GAMMA_BYTES)));
  });

  it('only processes whole 4 byte words', () => {
    const plain = plainBytes(13);
    const cipher = gammaEncrypt(plain);
    // 12 = 13 & ~3：尾部 1 字节既不加密也不解密。
    expect(Array.from(cipher.subarray(12))).toEqual([plain[12]]);
    expect(gammaDecrypt(cipher)[12]).toBe(plain[12]);
  });
});

describe('sum32LittleEndianWords', () => {
  it('adds little endian words and ignores the tail', () => {
    expect(sum32LittleEndianWords(new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]))).toBe(3);
    expect(sum32LittleEndianWords(new Uint8Array([0x01, 0x02, 0x03]))).toBe(0);
    expect(sum32LittleEndianWords(new Uint8Array(0))).toBe(0);
  });

  it('wraps modulo 2^32', () => {
    const bytes = new Uint8Array(8);
    bytes.set([0xff, 0xff, 0xff, 0xff, 0x02, 0x00, 0x00, 0x00]);
    expect(sum32LittleEndianWords(bytes)).toBe(1);
  });
});

describe('parseImage', () => {
  it('accepts a synthetic package and returns the cipher blocks plus the decrypted image', () => {
    const plain = plainBytes(1024);
    const bytes = buildPackage(plain);
    const image = expectImage(parseImage(bytes));

    expect(image.blocks).toHaveLength(4);
    expect(image.cipher).toHaveLength(1024);
    expect(Array.from(image.plain)).toEqual(Array.from(plain));
    expect(image.frames).toHaveLength(6);
    expect(image.info.modelCode).toBe('000000');
    expect(image.info.modelName).toBe('000000');
    expect(image.info.version).toEqual({ x: 0, y: 0, z: 0 });
    expect(image.info.length).toBe(1024);
    expect(image.info.checksum).toBe(sum32LittleEndianWords(plain));

    // blocks 是密文形态：拼起来等于 cipher，且和包内块帧载荷逐字节一致。
    expect(Array.from(concat(image.blocks))).toEqual(Array.from(gammaEncrypt(plain)));
    const spans = frameSpans(bytes);
    for (let i = 0; i < image.blocks.length; i += 1) {
      const span = spans[i + 2];
      expect(Array.from(image.blocks[i])).toEqual(
        Array.from(bytes.subarray(span.offset + 7, span.offset + span.length - 2)),
      );
    }
  });

  it('rejects a single flipped byte as a crc failure', () => {
    const bytes = buildPackage(plainBytes(1024));
    const spans = frameSpans(bytes);
    bytes[spans[2].offset + 100] ^= 0xff;
    expect(parseImage(bytes)).toEqual({
      ok: false,
      rejection: { problem: 'crc', message: expect.any(String), detail: { offset: spans[2].offset } },
    });
  });

  it('rejects a resealed tamper as a checksum failure, because the sum runs over the plaintext', () => {
    const bytes = buildPackage(plainBytes(1024));
    const spans = frameSpans(bytes);
    bytes[spans[2].offset + 100] ^= 0xff;
    reseal(bytes, spans[2]);

    const result = parseImage(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.problem).toBe('checksumMismatch');
    expect(result.rejection.detail?.actual).not.toBe(result.rejection.detail?.expected);
  });

  it('rejects a checksum taken over the ciphertext as a checksum failure', () => {
    const plain = plainBytes(8192);
    const cipher = gammaEncrypt(plain);
    const sumOverCipher = sum32LittleEndianWords(cipher);
    expect(sumOverCipher).not.toBe(sum32LittleEndianWords(plain));
    const bytes = buildPackage(plain, { checksumOverride: sumOverCipher });
    const result = parseImage(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.problem).toBe('checksumMismatch');
  });

  it('rejects a real over-limit image (FwLength = 0x40000) before touching the device', () => {
    const plain = plainBytes(APP_MAX_BYTES + 0x10000);
    const bytes = buildPackage(plain);
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('limitExceeded');
    expect(image.rejection.detail).toMatchObject({ length: 0x40000, limit: APP_MAX_BYTES, modelCode: '000000' });
    expect(image.rejection.message).toContain('262144');
  });

  it('rejects a Bootld image above 0x8000 even though the app limit would allow it', () => {
    const bytes = buildPackage(plainBytes(BOOT_MAX_BYTES + 4), { modelCode: BOOT_MODEL_CODE });
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('limitExceeded');
    expect(image.rejection.detail).toMatchObject({ length: BOOT_MAX_BYTES + 4, limit: BOOT_MAX_BYTES, modelCode: BOOT_MODEL_CODE });
  });

  it('rejects a forged FwLength of 0x40000 as limitExceeded even though the blocks stay at 1024 bytes', () => {
    // R6-3 的字面用例：只改 Info 帧里的声明长度（块不变，encodeInfoFrame 会重算 Info 帧 CRC）。
    // 上界检查先于长度一致性，所以声明就超界时立刻拒绝，不必等收齐块。
    const bytes = buildPackage(plainBytes(1024), { lengthOverride: 0x40000 });
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('limitExceeded');
    expect(image.rejection.detail).toMatchObject({ length: 0x40000, limit: APP_MAX_BYTES });
  });

  it('applies the Bootld limit to a forged FwLength as well', () => {
    const bytes = buildPackage(plainBytes(1024), { modelCode: BOOT_MODEL_CODE, lengthOverride: 0x40000 });
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('limitExceeded');
    expect(image.rejection.detail).toMatchObject({ length: 0x40000, limit: BOOT_MAX_BYTES });
  });

  it('reports lengthMismatch when FwLength disagrees with the blocks but stays inside the limit', () => {
    const bytes = buildPackage(plainBytes(2048), { lengthOverride: 1024 });
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('lengthMismatch');
    expect(image.rejection.detail).toMatchObject({ length: 1024, actual: 2048 });
  });

  it('rejects a last block that is not 4 byte aligned', () => {
    const bytes = buildPackage(plainBytes(1024), { truncateLastBlockTo: 254 });
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('notAligned');
    expect(image.rejection.detail).toEqual({ index: 3, size: 254 });
  });

  it('rejects a short block that is not the last one', () => {
    const plain = plainBytes(512);
    const cipher = gammaEncrypt(plain);
    const blocks = [cipher.slice(0, 256), cipher.slice(256, 384), cipher.slice(384, 512)];
    const bytes = buildPackage(plain, { blocks });
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('blockSize');
    expect(image.rejection.detail).toEqual({ index: 1, size: 128, expected: BLOCK_BYTES });
  });

  it('rejects a package whose info frame was moved behind the blocks', () => {
    const bytes = buildPackage(plainBytes(1024));
    const spans = frameSpans(bytes);
    const raw = spans.map((span) => bytes.slice(span.offset, span.offset + span.length));
    const reordered = concat([raw[0], ...raw.slice(2), raw[1]]);
    const image = parseImage(reordered);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('frame');
    expect(image.rejection.detail).toEqual({ index: 5 });
  });

  it('rejects a package with two info frames', () => {
    const bytes = buildPackage(plainBytes(1024));
    const spans = frameSpans(bytes);
    const raw = spans.map((span) => bytes.slice(span.offset, span.offset + span.length));
    const duplicated = concat([raw[0], raw[1], raw[1], ...raw.slice(2)]);
    const image = parseImage(duplicated);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('infoCount');
    expect(image.rejection.detail).toEqual({ count: 2 });
  });

  it('rejects an info frame with the wrong payload length', () => {
    const bytes = buildPackage(plainBytes(1024));
    const spans = frameSpans(bytes);
    const info = bytes.slice(spans[1].offset, spans[1].offset + spans[1].length);
    // 砍掉 info 帧最后一个数据字节并重封 LEN/CRC：结构合法，但载荷缺 1 字节。
    const short = new Uint8Array(info.length - 1);
    short.set(info.subarray(0, info.length - 3), 0);
    const length = short.length;
    short[1] = length & 0xff;
    short[2] = (length >> 8) & 0xff;
    reseal(short, { offset: 0, length });
    const patched = concat([bytes.slice(0, spans[1].offset), short, bytes.slice(spans[1].offset + spans[1].length)]);
    const image = parseImage(patched);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('infoCount');
    expect(image.rejection.detail).toEqual({ length: 80 });
  });

  it('rejects a model code with non printable bytes', () => {
    const bytes = buildPackage(plainBytes(1024), { modelCode: '\u0000\u0000\u0000\u0000\u0000\u0000' });
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('modelMissing');
  });

  it('rejects a stream that does not start with EnterDfu', () => {
    const bytes = buildPackage(plainBytes(1024));
    const spans = frameSpans(bytes);
    const withoutEnter = concat([bytes.slice(spans[1].offset, spans[1].offset + spans[1].length), bytes.slice(0, spans[0].length), ...spans.slice(2).map((span) => bytes.slice(span.offset, span.offset + span.length))]);
    const image = parseImage(withoutEnter);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('frame');
  });

  it('rejects an empty package and an EnterDfu only package', () => {
    const empty = parseImage(new Uint8Array(0));
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.rejection.problem).toBe('frame');

    const onlyEnter = parseImage(encodeSigmaFrame(0x03, ENTER_DFU_DATA));
    expect(onlyEnter.ok).toBe(false);
    if (onlyEnter.ok) return;
    expect(onlyEnter.rejection.problem).toBe('infoCount');
  });

  it('rejects a truncated package and a package with leading garbage', () => {
    const bytes = buildPackage(plainBytes(1024));
    const truncated = parseImage(bytes.slice(0, bytes.length - 40));
    expect(truncated.ok).toBe(false);
    if (truncated.ok) return;
    expect(truncated.rejection.problem).toBe('frame');

    const garbage = concat([new Uint8Array([0x00, 0x01]), bytes]);
    const prefixed = parseImage(garbage);
    expect(prefixed.ok).toBe(false);
    if (prefixed.ok) return;
    expect(prefixed.rejection.problem).toBe('frame');
  });

  it('rejects a package with no data block', () => {
    const bytes = concat([encodeSigmaFrame(0x03, ENTER_DFU_DATA), encodeInfoFrame({
      modelCode: '000000',
      modelName: '000000',
      version: { x: 0, y: 0, z: 0 },
      length: 0,
      checksum: 0,
    })]);
    const image = parseImage(bytes);
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('frame');
  });

  it('copies its input so blocks never alias the caller buffer', () => {
    const bytes = buildPackage(plainBytes(1024));
    const buffer = Buffer.from(bytes);
    const image = expectImage(parseImage(buffer));
    const blockBefore = Array.from(image.blocks[0]);
    const frameBefore = Array.from(image.frames[2]);

    buffer[frameSpans(bytes)[2].offset + 8] ^= 0xff;

    expect(Array.from(image.blocks[0])).toEqual(blockBefore);
    expect(Array.from(image.frames[2])).toEqual(frameBefore);
    expect(Buffer.isBuffer(image.blocks[0])).toBe(false);
    expect(Buffer.isBuffer(image.frames[0])).toBe(false);
  });

  it('never throws, whatever the input shape is', () => {
    const inputs: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array(1),
      new Uint8Array([0xc4]),
      new Uint8Array([0xc4, 0x0b]),
      new Uint8Array([0xc4, 0xff, 0x03]),
      new Uint8Array(2048).fill(0xc4),
      new Uint8Array(2048).fill(0x00),
      buildPackage(plainBytes(1024)).slice(0, 33),
    ];
    for (const input of inputs) {
      expect(() => parseImage(input)).not.toThrow();
      expect(parseImage(input).ok).toBe(false);
    }
  });
});

/**
 * 《DFU固件升级通讯协议说明_20261026》§3.1：2026-10-26 起打包脚本把包首的「进入 DFU」帧
 * 从 SigmaBus 换成参数协议帧 `00 10 00 0A 10 08 00 01 8D 09`。两种形态都要能解析。
 */
const MODBUS_ENTER_DFU = new Uint8Array([0x00, 0x10, 0x00, 0x0a, 0x10, 0x08, 0x00, 0x01, 0x8d, 0x09]);

function buildPackageWithHeader(header: Uint8Array, infoHeaderBytes: number = 81): Uint8Array {
  const plain = plainBytes(1024);
  const cipher = gammaEncrypt(plain);
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < cipher.length; offset += BLOCK_BYTES) {
    blocks.push(cipher.slice(offset, Math.min(offset + BLOCK_BYTES, cipher.length)));
  }
  const info = encodeInfoFrame({
    modelCode: 'JYM001',
    modelName: 'MIC M001',
    version: { x: 1, y: 2, z: 3 },
    length: cipher.length,
    checksum: sum32LittleEndianWords(plain),
  });
  let infoFrame = info;
  if (infoHeaderBytes !== 81) {
    // 把 81 B 的固件头扩到 infoHeaderBytes 字节（尾部补 0），再按新长度重封 LEN/CRC
    const length = 7 + 2 + infoHeaderBytes;
    const enlarged = new Uint8Array(length);
    enlarged.set(info.subarray(0, 5), 0);
    enlarged.set(info.subarray(5, info.length - 2), 5);
    enlarged[1] = length & 0xff;
    enlarged[2] = (length >> 8) & 0xff;
    const crc = sigmaCrc(enlarged.subarray(0, length - 2));
    enlarged[length - 2] = crc & 0xff;
    enlarged[length - 1] = (crc >> 8) & 0xff;
    infoFrame = enlarged;
  }
  return concat([header, infoFrame, ...blocks.map((block) => encodeBlockFrame(block))]);
}

describe('package header forms (协议 1026 §3.1)', () => {
  it('accepts the new Modbus EnterDfu header and keeps it as frames[0]', () => {
    const bytes = buildPackageWithHeader(MODBUS_ENTER_DFU);
    const image = expectImage(parseImage(bytes));
    expect(image.headerKind).toBe('modbus');
    expect(Array.from(image.frames[0])).toEqual(Array.from(MODBUS_ENTER_DFU));
    expect(image.frames).toHaveLength(6); // 头 + info + 4 块
    expect(image.info.modelCode).toBe('JYM001');
    expect(image.info.version).toEqual({ x: 1, y: 2, z: 3 });
    expect(image.blocks).toHaveLength(4);
    expect(Array.from(image.plain)).toEqual(Array.from(plainBytes(1024)));
  });

  it('still accepts the legacy SigmaBus EnterDfu header', () => {
    const bytes = buildPackageWithHeader(encodeSigmaFrame(0x03, ENTER_DFU_DATA));
    const image = expectImage(parseImage(bytes));
    expect(image.headerKind).toBe('sigma');
    expect(Array.from(image.frames[0])).toEqual(Array.from(encodeSigmaFrame(0x03, ENTER_DFU_DATA)));
  });

  it('rejects a Modbus header with a bad crc instead of scanning past it', () => {
    const broken = Uint8Array.from(MODBUS_ENTER_DFU);
    broken[broken.length - 1] ^= 0xff;
    const image = parseImage(buildPackageWithHeader(broken));
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('frame');
    expect(image.rejection.message).toContain('EnterDfu header');
  });

  it('accepts the 85 byte info body the protocol doc describes (firmware only reads 81)', () => {
    const bytes = buildPackageWithHeader(MODBUS_ENTER_DFU, 85);
    const image = expectImage(parseImage(bytes));
    expect(image.info.modelCode).toBe('JYM001');
    expect(image.info.length).toBe(1024);
    expect(image.blocks).toHaveLength(4);
  });

  it('still rejects an info body that is neither 81 nor 85 bytes', () => {
    const image = parseImage(buildPackageWithHeader(MODBUS_ENTER_DFU, 79));
    expect(image.ok).toBe(false);
    if (image.ok) return;
    expect(image.rejection.problem).toBe('infoCount');
    expect(image.rejection.detail).toEqual({ length: 79 });
  });
});
