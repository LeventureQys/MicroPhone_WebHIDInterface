import { DEFAULT_BANDS } from './defaults';
import type { EqBand } from '../eq/types';
import { EQ_BAND_EDITABLE } from '../eq/types';

/**
 * 「均衡器复位」的落点（2026-11-21 问题单第 12 条）。
 *
 * 注意这里**不是**参数表的出厂默认值：参数表 G 列给的是设备出厂预设
 * （Band-3 增益 285 = −3.5 dB、各段 Q = 0.8/1.5/1.0/1.0/0.7），用户要的是
 * "复位成一条平直的曲线"——7 段增益全 0、Q 全 0.7（问题单里手写的那张频段列表）。
 * 两者的差别只在增益与 Q：类型（HPF / LPF / PEAK）与频点沿用寄存器表，
 * 所以复位后的曲线与界面截图逐格一致。
 *
 * 引用关系：`DEFAULT_BANDS` 的取值来自 `device/registers.ts`（真值表），
 * 这里只覆盖增益与 Q，不复制任何地址或范围。
 */
export const EQ_RESET_GAIN_DB = 0;
export const EQ_RESET_Q = 0.7;

/** 复位后的 7 个可调段（不含设备内部段 8–14） */
export function eqResetBands(): EqBand[] {
  const bands: EqBand[] = [];
  for (let index = 0; index < EQ_BAND_EDITABLE; index += 1) {
    const band = DEFAULT_BANDS[index];
    if (!band) continue;
    bands.push({ ...band, gain: EQ_RESET_GAIN_DB, q: EQ_RESET_Q });
  }
  return bands;
}

/** 把复位值套到现有的 14 段上：可调段换成复位值，内部段原样保留 */
export function withEqReset(bands: readonly EqBand[]): EqBand[] {
  const reset = eqResetBands();
  return bands.map((band, index) => {
    const target = reset[index];
    return target ? { ...band, type: target.type, freq: target.freq, gain: target.gain, q: target.q } : { ...band };
  });
}
