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
