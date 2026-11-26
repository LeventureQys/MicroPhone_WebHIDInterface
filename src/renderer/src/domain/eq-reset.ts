import { DEFAULT_BANDS } from './defaults';
import type { EqBand } from '../eq/types';
import { bandHasGain, EQ_BAND_EDITABLE } from '../eq/types';

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

/**
 * 产品默认频段（不是"平坦"）：类型 / 频点 / Q 取 `DEFAULT_BANDS`，增益由当前音色覆盖。
 *
 * 2026-11-25 起主界面在任何音色下都可编辑 EQ，「恢复默认」应该回到当前音色的默认
 * 曲线（人声增强 / 温暖 / 明亮各自那条），而不是一律拉平；只有「自定义」的默认
 * 增益才是 0。Q 也回产品默认（0.7 / 0.8 / 1.5 …），不再统一钉成 0.7。
 */
export function defaultEqBands(gains: readonly number[] = []): EqBand[] {
  const bands: EqBand[] = [];
  for (let index = 0; index < EQ_BAND_EDITABLE; index += 1) {
    const base = DEFAULT_BANDS[index];
    if (!base) continue;
    // 高通 / 低通没有增益：传进来的默认曲线前两格一律按 0 处理
    const gain = bandHasGain(base.type) ? (gains[index] ?? base.gain) : 0;
    bands.push({ ...base, gain });
  }
  return bands;
}

/** 把默认频段套到现有 14 段上：可调段回默认，内部段（8–14）原样保留 */
export function withEqDefaults(bands: readonly EqBand[], gains: readonly number[] = []): EqBand[] {
  const defaults = defaultEqBands(gains);
  return bands.map((band, index) => {
    const target = defaults[index];
    return target ? { ...band, type: target.type, freq: target.freq, gain: target.gain, q: target.q } : { ...band };
  });
}
