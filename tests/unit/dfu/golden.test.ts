import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeSigmaStream } from '../../../src/renderer/src/device/dfu/frame';
import type { SigmaDecodeResult } from '../../../src/renderer/src/device/dfu/frame';
import {
  encodeBlockFrame,
  encodeInfoFrame,
  gammaDecrypt,
  parseImage,
  sum32LittleEndianWords,
} from '../../../src/renderer/src/device/dfu/image';
import type { ParsedImage } from '../../../src/renderer/src/device/dfu/image';

/**
 * 厂商出厂包（只读引用，禁止复制到仓库）：21 823 B。
 * `MICSTUDIO_DFU_GOLDEN` 只用于验证"包缺失时 skip + warn"这条路径，正常取值不要设置。
 */
const GOLDEN_PATH = path.resolve(
  process.env.MICSTUDIO_DFU_GOLDEN ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../..',
      'Document/Protocol/Bootloader/Tools/Py/INNO SoftEmbe_Bootloader(PD100UGen2) MCU [内部使用].bin',
    ),
);
const GOLDEN_BYTES = 21823;
const GOLDEN_SHA256 = '1A1B1136D630CF32ACC982CA9C2F903E426F1C5977759C4578AF2462BD12BFED';
const GOLDEN_FRAME_COUNT = 84;
const GOLDEN_BLOCK_COUNT = 82;
const GOLDEN_FW_LENGTH = 20984;
const GOLDEN_FW_CHECKSUM = 0x4e0621af;
/** 对本包密文按同一算法累加得到的结果，只用来证明"对密文算校验和一定不符"。 */
const GOLDEN_CIPHER_CHECKSUM = 0x1390b00a;
const GOLDEN_VECTOR = { sp: 0x200041b8, reset: 0x00004265 };

const goldenExists = existsSync(GOLDEN_PATH);
if (!goldenExists) {
  console.warn(`[dfu] golden package not found, R6-1 assertions are skipped: ${GOLDEN_PATH}`);
}

interface Golden {
  readonly bytes: Uint8Array;
  readonly decoded: SigmaDecodeResult;
  readonly image: ParsedImage;
  readonly plain: Uint8Array;
}

let cached: Golden | null = null;

function loadGolden(): Golden {
  if (cached) return cached;
  const bytes = new Uint8Array(readFileSync(GOLDEN_PATH));
  const decoded = decodeSigmaStream(bytes);
  const parsed = parseImage(bytes);
  if (!parsed.ok) {
    throw new Error(`golden package rejected: ${parsed.rejection.problem} ${parsed.rejection.message}`);
  }
  const plain = gammaDecrypt(parsed.image.cipher);
  cached = { bytes, decoded, image: parsed.image, plain };
  return cached;
}

describe.skipIf(!goldenExists)('golden package (R6-1)', () => {
  it('has the recorded size and sha256', () => {
    const { bytes } = loadGolden();
    expect(bytes).toHaveLength(GOLDEN_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex').toUpperCase()).toBe(GOLDEN_SHA256);
  });

  it('splits into 84 frames with the documented length sequence', () => {
    const { decoded } = loadGolden();
    expect(decoded.issues).toHaveLength(0);
    expect(decoded.rest).toHaveLength(0);
    expect(decoded.frames).toHaveLength(GOLDEN_FRAME_COUNT);

    const lengths = decoded.frames.map((frame) => 7 + frame.data.length);
    expect(lengths).toEqual([11, 90, ...new Array(81).fill(265), 257]);
    expect(lengths.reduce((sum, value) => sum + value, 0)).toBe(GOLDEN_BYTES);

    expect(decoded.frames[0].cmd).toBe(0x03);
    expect(Array.from(decoded.frames[0].data)).toEqual([0x08, 0x10, 0x01, 0x00]);
    expect(decoded.frames[1].cmd).toBe(0x0b);
    expect(decoded.frames[1].data[0]).toBe(0x02);
  });

  it('parses the firmware info and all 82 blocks', () => {
    const { image } = loadGolden();
    expect(image.info.modelCode).toBe('Bootld');
    expect(image.info.modelName).toBe('000000');
    expect(image.info.version).toEqual({ x: 0, y: 0, z: 0 });
    expect(image.info.length).toBe(GOLDEN_FW_LENGTH);
    expect(image.info.checksum).toBe(GOLDEN_FW_CHECKSUM);

    expect(image.blocks).toHaveLength(GOLDEN_BLOCK_COUNT);
    expect(image.blocks.map((block) => block.length)).toEqual([...new Array(81).fill(256), 248]);
    expect(image.plain).toHaveLength(GOLDEN_FW_LENGTH);
    expect(image.cipher).toHaveLength(GOLDEN_FW_LENGTH);
    expect(image.frames).toHaveLength(GOLDEN_FRAME_COUNT);
  });

  it('decrypts the vector table and sums the plaintext, not the ciphertext', () => {
    const { image, plain } = loadGolden();
    expect(Array.from(plain.subarray(0, 8))).toEqual([0xb8, 0x41, 0x00, 0x20, 0x65, 0x42, 0x00, 0x00]);
    expect(Array.from(plain)).toEqual(Array.from(image.plain));
    expect(Array.from(gammaDecrypt(image.cipher))).toEqual(Array.from(plain));

    const sp = (plain[0] | (plain[1] << 8) | (plain[2] << 16) | (plain[3] << 24)) >>> 0;
    const reset = (plain[4] | (plain[5] << 8) | (plain[6] << 16) | (plain[7] << 24)) >>> 0;
    expect(sp).toBe(GOLDEN_VECTOR.sp);
    expect(reset).toBe(GOLDEN_VECTOR.reset);

    expect(sum32LittleEndianWords(plain)).toBe(GOLDEN_FW_CHECKSUM);
    expect(sum32LittleEndianWords(image.cipher)).toBe(GOLDEN_CIPHER_CHECKSUM);
    expect(sum32LittleEndianWords(image.cipher)).not.toBe(GOLDEN_FW_CHECKSUM);
  });

  it('re-encodes the info frame and every block frame byte for byte', () => {
    const { image } = loadGolden();
    expect(Array.from(encodeInfoFrame(image.info))).toEqual(Array.from(image.frames[1]));

    const mismatches: number[] = [];
    for (let i = 0; i < image.blocks.length; i += 1) {
      const encoded = encodeBlockFrame(image.blocks[i]);
      const original = image.frames[i + 2];
      const same = encoded.length === original.length && encoded.every((byte, index) => byte === original[index]);
      if (!same) mismatches.push(i);
    }
    expect(mismatches).toEqual([]);
    expect(image.blocks).toHaveLength(GOLDEN_BLOCK_COUNT);
  });

  it('keeps the EnterDfu frame verbatim', () => {
    const { image } = loadGolden();
    expect(Array.from(image.frames[0])).toEqual([0xc4, 0x0b, 0x00, 0x00, 0x03, 0x08, 0x10, 0x01, 0x00, 0x15, 0xff]);
  });
});
