export type EqFilterType = 0 | 1 | 2 | 3 | 4; // 0 PEAK, 1 LS, 2 HS, 3 LPF, 4 HPF

export interface EqBand {
  index: number;
  type: EqFilterType;
  freq: number;
  gain: number;
  q: number;
}

export interface CurvePoint {
  freq: number;
  gainDb: number;
}

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EQ_BAND_TOTAL = 14;
export const EQ_BAND_EDITABLE = 7;
export const EQ_TYPE_LABEL: Record<EqFilterType, string> = {
  0: 'PEAK',
  1: 'LS',
  2: 'HS',
  3: 'LPF',
  4: 'HPF',
};

/** 高低通没有增益：曲线只用截止频率与 Q（`curve.ts` 的 BLT 分支不读 gain） */
const GAINLESS_TYPES: readonly EqFilterType[] = [3, 4];

/**
 * 这一段有没有增益参数。
 *
 * 2026-11-25 用户反馈「HPF / LPF 的点应该在横轴上」：节点原来按 `band.gain` 画，
 * 而音色预设给 7 段都塞了增益（warm 的前两格是 +4 / +3），于是 1、2 两个节点飘在
 * 0 dB 上面。高通 / 低通是 Butterworth 型，没有增益这个自由度，界面、拖动、写入
 * 三处都按"增益恒为 0"对待。
 */
export function bandHasGain(type: EqFilterType): boolean {
  return !GAINLESS_TYPES.includes(type);
}
