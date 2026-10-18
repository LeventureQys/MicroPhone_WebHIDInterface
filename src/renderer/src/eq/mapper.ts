/**
 * EQ 坐标映射：对数频率轴（20 Hz–20 kHz）+ 线性增益轴（-24…+12 dB）。
 *
 * 移植自 AudioEQ_Visualized_Web（MIT License）的 src/core/CoordinateMapper.js，
 * 本地只读副本：D:\Temp\ref-eq\AudioEQ_Visualized_Web-main。
 * 移植差异：增加 viewport / 量程的数值兜底（退化区间、零宽高、非有限输入），
 * 去掉本仓不需要的 setFreqRange / setGainRange（量程构造期固定）。
 */

import type { Viewport } from './types';

const FREQ_FLOOR = 20;
const FREQ_CEIL = 20000;
const GAIN_FLOOR = -24;
const GAIN_CEIL = 12;
const DEFAULT_GAIN_STEP = 6;
/** 1-2-5 刻度序列 */
const TICK_FACTORS = [1, 2, 5];

function toFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** 抹掉 k * step 的浮点尾巴（0.30000000000000004 → 0.3） */
function roundTick(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeViewport(viewport: Viewport): Viewport {
  const source: Viewport = viewport ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: toFinite(source.x, 0),
    y: toFinite(source.y, 0),
    width: Math.max(0, toFinite(source.width, 0)),
    height: Math.max(0, toFinite(source.height, 0)),
  };
}

function normalizeFreqRange(freqMin: number, freqMax: number): [number, number] {
  const lo = Number.isFinite(freqMin) && freqMin > 0 ? freqMin : FREQ_FLOOR;
  const hi = Number.isFinite(freqMax) && freqMax > lo ? freqMax : FREQ_CEIL;
  return hi > lo ? [lo, hi] : [FREQ_FLOOR, FREQ_CEIL];
}

function normalizeGainRange(gainMin: number, gainMax: number): [number, number] {
  const lo = Number.isFinite(gainMin) ? gainMin : GAIN_FLOOR;
  const hi = Number.isFinite(gainMax) ? gainMax : GAIN_CEIL;
  return hi > lo ? [lo, hi] : [GAIN_FLOOR, GAIN_CEIL];
}

export class FreqMapper {
  private _viewport: Viewport;

  private readonly _freqMin: number;

  private readonly _freqMax: number;

  private readonly _gainMin: number;

  private readonly _gainMax: number;

  private readonly _logFreqRatio: number;

  constructor(
    viewport: Viewport,
    freqMin = FREQ_FLOOR,
    freqMax = FREQ_CEIL,
    gainMin = GAIN_FLOOR,
    gainMax = GAIN_CEIL,
  ) {
    this._viewport = normalizeViewport(viewport);
    const [lo, hi] = normalizeFreqRange(freqMin, freqMax);
    this._freqMin = lo;
    this._freqMax = hi;
    this._logFreqRatio = Math.log(hi / lo);
    const [gainLo, gainHi] = normalizeGainRange(gainMin, gainMax);
    this._gainMin = gainLo;
    this._gainMax = gainHi;
  }

  get freqMin(): number {
    return this._freqMin;
  }

  get freqMax(): number {
    return this._freqMax;
  }

  get gainMin(): number {
    return this._gainMin;
  }

  get gainMax(): number {
    return this._gainMax;
  }

  freqToX(freq: number): number {
    const clamped = this.clampFreq(freq);
    return this._viewport.x
      + (this._viewport.width * Math.log(clamped / this._freqMin)) / this._logFreqRatio;
  }

  xToFreq(x: number): number {
    const ratio = this._viewport.width > 0 && !Number.isNaN(x)
      ? (x - this._viewport.x) / this._viewport.width
      : 0;
    return this.clampFreq(this._freqMin * Math.exp(ratio * this._logFreqRatio));
  }

  gainToY(gainDb: number): number {
    const clamped = this.clampGain(gainDb);
    return this._viewport.y
      + (this._viewport.height * (this._gainMax - clamped)) / (this._gainMax - this._gainMin);
  }

  yToGain(y: number): number {
    const ratio = this._viewport.height > 0 && !Number.isNaN(y)
      ? (y - this._viewport.y) / this._viewport.height
      : 0;
    return this.clampGain(this._gainMax - ratio * (this._gainMax - this._gainMin));
  }

  setViewport(viewport: Viewport): void {
    this._viewport = normalizeViewport(viewport);
  }

  /** 1-2-5 序列中落在 [freqMin, freqMax] 内的刻度，严格递增 */
  static freqTicks(freqMin: number, freqMax: number): number[] {
    // 非法区间返回空刻度，交给调用方决定不画网格
    if (!Number.isFinite(freqMin) || !Number.isFinite(freqMax)) return [];
    if (!(freqMin > 0) || !(freqMax > freqMin)) return [];
    const lo = freqMin;
    const hi = freqMax;
    const ticks: number[] = [];
    const firstDecade = Math.floor(Math.log10(lo));
    const lastDecade = Math.ceil(Math.log10(hi));
    for (let exponent = firstDecade; exponent <= lastDecade; exponent += 1) {
      for (const factor of TICK_FACTORS) {
        const value = roundTick(factor * Math.pow(10, exponent));
        const previous = ticks.length > 0 ? ticks[ticks.length - 1] : Number.NEGATIVE_INFINITY;
        if (value >= lo && value <= hi && value > previous) ticks.push(value);
      }
    }
    return ticks;
  }

  /** 等步长增益刻度，步长缺省 6 dB */
  static gainTicks(gainMin: number, gainMax: number, step: number = DEFAULT_GAIN_STEP): number[] {
    if (!Number.isFinite(gainMin) || !Number.isFinite(gainMax)) return [];
    if (!(gainMax > gainMin)) return [];
    const stride = Number.isFinite(step) && step > 0 ? step : DEFAULT_GAIN_STEP;
    const ticks: number[] = [];
    const firstIndex = Math.ceil(gainMin / stride);
    const lastIndex = Math.floor(gainMax / stride);
    for (let k = firstIndex; k <= lastIndex; k += 1) ticks.push(roundTick(k * stride));
    return ticks;
  }

  private clampFreq(freq: number): number {
    // 只有 NaN 无方向可判；±Infinity 交给 min/max 夹到边界
    if (Number.isNaN(freq)) return this._freqMin;
    return Math.min(this._freqMax, Math.max(this._freqMin, freq));
  }

  private clampGain(gainDb: number): number {
    if (Number.isNaN(gainDb)) return this._gainMin;
    return Math.min(this._gainMax, Math.max(this._gainMin, gainDb));
  }
}
