import type { EqBand, EqFilterType } from '../eq/types';
import { EQ_BAND_TOTAL } from '../eq/types';
import { defaultOf, EQ_BAND_COUNT, eqBandAddr, findRegister } from '../device/registers';
import { PARAMS } from './params';

/**
 * 产品默认值覆盖：**不等于**参数表 G 列的出厂值。
 *
 * 参数表（`device/registers.ts`）是协议真值，这里只放"上位机认为的默认状态"：
 * 未连接设备时的显示、模拟通道的回读、设置页「复位全部参数」、场景预设都取这里。
 * 每次覆盖都必须写清来源，否则排查时会以为寄存器表漏改。
 *
 * - `drc3.Enable`：2026-11-22 问题单第 6 条「三分频动态处理器默认先关闭」。
 *   参数表 V0.3 的 0x2075 默认是 1，固件上电预设也按 1 加载；上位机只能保证
 *   自己下发的默认值（复位全部参数 / 场景）是 0，设备自身那份要固件侧改。
 */
const PRODUCT_PARAM_DEFAULTS: Readonly<Record<string, number>> = Object.freeze({
  'drc3.Enable': 0,
});

/** 46 项标量默认值：寄存器表 G 列 + 产品覆盖（未连接设备时的兜底显示） */
export const DEFAULT_PARAMS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(PARAMS.map((item) => [item.id, PRODUCT_PARAM_DEFAULTS[item.id] ?? item.default])),
);

export const DEFAULT_LANG = 'zh' as const;

/**
 * 可调段 1–7 的默认频点（2026-11-22 问题单第 2、3 条）。
 *
 * 问题单原话：「均衡器的默认频率需要修改，其中 3 到 7 段的默认频点参考下图」，
 * 图里给的 5 个频点是 63 Hz / 250 Hz / 1 kHz / 4 kHz / 12.5 kHz（按听觉特性近似
 * 倍频程分布，不是等间隔）。第 1、2 段分别是 HPF 50 Hz、LPF 20 kHz，不变。
 *
 * 参数表 V0.3 G 列仍是上一版的 215 / 1000 / 2000 / 5000 / 10000，所以这里单独列一份
 * 产品默认：类型 / 增益 / Q 继续取值表，只把频点换成问题单要的这 5 个。
 */
export const PRODUCT_BAND_FREQS: readonly number[] = Object.freeze([
  50, 20000, 63, 250, 1000, 4000, 12500,
]);

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

/** 可调段 1–7（0x2027–0x2049）：类型 / 增益 / Q 取值表，频点取产品默认表 */
function editableBand(index: number): EqBand {
  return {
    index,
    type: registerDefault(eqBandAddr(index, 'type')) as EqFilterType,
    freq: PRODUCT_BAND_FREQS[index] ?? registerDefault(eqBandAddr(index, 'freq')),
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
