import type { EqBand, EqFilterType } from '../eq/types';
import { EQ_BAND_TOTAL } from '../eq/types';
import { defaultOf, EQ_BAND_COUNT, eqBandAddr, findRegister } from '../device/registers';
import { PARAMS } from './params';

/** 42 项标量默认值，全部来自寄存器表 G 列（工程量，未连接设备时的兜底显示） */
export const DEFAULT_PARAMS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(PARAMS.map((item) => [item.id, item.default])),
);

export const DEFAULT_LANG = 'zh' as const;

const LOW_HZ = 20;
const HIGH_HZ = 20000;
// 内部段不在设备寄存器里，沿用 v1.0.0 的对数插值：插在相邻可调段之间
const INNER_POSITIONS = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 2.95];

function freqAt(exponent: number): number {
  return Math.round(LOW_HZ * Math.pow(10, exponent));
}

function registerDefault(addr: number): number {
  const spec = findRegister(addr);
  if (!spec) throw new Error(`register 0x${addr.toString(16)} missing`);
  return defaultOf(spec);
}

/** 可调段 1–7（0x2027–0x2049）的默认值直接取寄存器表，与设备首屏一致 */
function editableBand(index: number): EqBand {
  return {
    index,
    type: registerDefault(eqBandAddr(index, 'type')) as EqFilterType,
    freq: registerDefault(eqBandAddr(index, 'freq')),
    gain: registerDefault(eqBandAddr(index, 'gain')),
    q: registerDefault(eqBandAddr(index, 'q')),
  };
}

function buildDefaultBands(): EqBand[] {
  const bands: EqBand[] = [];
  for (let index = 0; index < EQ_BAND_COUNT; index += 1) {
    bands.push(editableBand(index));
  }
  INNER_POSITIONS.forEach((position, offset) => {
    const index = EQ_BAND_COUNT + offset;
    const freq = Math.min(HIGH_HZ, Math.max(LOW_HZ, freqAt(position)));
    bands.push({ index, type: 0, freq, gain: 0, q: 0.7 });
  });
  return bands.slice(0, EQ_BAND_TOTAL);
}

export const DEFAULT_BANDS: readonly EqBand[] = Object.freeze(buildDefaultBands());
