import type { EqBand } from '../eq/types';
import { EQ_BAND_TOTAL } from '../eq/types';
import { PARAMS } from './params';

/** 36 项标量默认值，来源于参数表 */
export const DEFAULT_PARAMS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(PARAMS.map((item) => [item.id, item.default])),
);

export const DEFAULT_LANG = 'zh' as const;

const EDITABLE_COUNT = 7;
const LOW_HZ = 20;
const HIGH_HZ = 20000;
// 可调段在对数轴上每 0.5 个数量级落一个点；内部段插在相邻可调段之间
const INNER_POSITIONS = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 2.95];

function freqAt(exponent: number): number {
  return Math.round(LOW_HZ * Math.pow(10, exponent));
}

function buildDefaultBands(): EqBand[] {
  const bands: EqBand[] = [];
  for (let index = 0; index < EDITABLE_COUNT; index += 1) {
    bands.push({ index, type: 0, freq: freqAt(0.5 * index), gain: 0, q: 0.7 });
  }
  INNER_POSITIONS.forEach((position, offset) => {
    const index = EDITABLE_COUNT + offset;
    const freq = Math.min(HIGH_HZ, Math.max(LOW_HZ, freqAt(position)));
    bands.push({ index, type: 0, freq, gain: 0, q: 0.7 });
  });
  return bands.slice(0, EQ_BAND_TOTAL);
}

export const DEFAULT_BANDS: readonly EqBand[] = Object.freeze(buildDefaultBands());
