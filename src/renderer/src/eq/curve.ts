/**
 * EQ 频响数学：RBJ cookbook biquad 系数 + BLT Butterworth（LPF / HPF）+ 对数等距采样。
 *
 * 数学实现移植自 AudioEQ_Visualized_Web（MIT License）的 src/core/filter/ButterworthIIR.js，
 * 本地只读副本：D:\Temp\ref-eq\AudioEQ_Visualized_Web-main。系数公式沿用上游，不自行推导。
 * 移植差异：本仓滤波类型是数字枚举 0 PEAK / 1 LS / 2 HS / 3 LPF / 4 HPF，
 * 且所有公开入口都做数值兜底（clamp / 非有限值回退），保证不抛异常、只返回有限数。
 */

import type { CurvePoint, EqBand } from './types';

export interface BiquadCoeff {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface ComputeCurveOptions {
  sampleRate?: number;
  pointCount?: number;
  freqMin?: number;
  freqMax?: number;
}

const DEFAULT_SAMPLE_RATE = 48000;
/** 低于该采样率视为非法，回退默认值 */
const MIN_VALID_SAMPLE_RATE = 40;
const FREQ_FLOOR = 20;
const FREQ_CEIL = 20000;
/** 截止频率离 Nyquist 留 0.1% 余量，tan/正弦在 Nyquist 处会退化 */
const NYQUIST_MARGIN = 0.999;
const Q_FLOOR = 0.1;
/** 反向增益的数值护栏：A = 10^(gain/40)，超过该量级会让系数溢出 */
const GAIN_LIMIT_DB = 120;
/** |H| 低于 -120 dB 视为地震级零点，按 -120 dB 截断，避免 log10(0) 变成 -Infinity */
const MAGNITUDE_FLOOR = 1e-12;
const DEFAULT_POINT_COUNT = 480;

export const EQ_TYPE_PEAK = 0;
export const EQ_TYPE_LOW_SHELF = 1;
export const EQ_TYPE_HIGH_SHELF = 2;
export const EQ_TYPE_LOW_PASS = 3;
export const EQ_TYPE_HIGH_PASS = 4;

function normalizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > MIN_VALID_SAMPLE_RATE
    ? sampleRate
    : DEFAULT_SAMPLE_RATE;
}

function normalizeQ(q: number): number {
  return Number.isFinite(q) && q > 0 ? q : Q_FLOOR;
}

function normalizeGainDb(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  return Math.min(GAIN_LIMIT_DB, Math.max(-GAIN_LIMIT_DB, gainDb));
}

function clampCutoff(
  freq: number,
  sampleRate: number,
  freqMin: number = FREQ_FLOOR,
  freqMax: number = FREQ_CEIL,
): number {
  const upper = Math.min(freqMax, (sampleRate / 2) * NYQUIST_MARGIN);
  const lower = Math.min(freqMin, upper);
  // 只有 NaN 无方向可判；±Infinity 交给 min/max 夹到边界
  if (Number.isNaN(freq)) return lower;
  return Math.min(upper, Math.max(lower, freq));
}

// 以下五个系数函数只接受已归一化的入参，避免重复校验
function peakCoeff(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff {
  const A = Math.pow(10, gainDb / 40);
  const omega = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(omega) / (2 * q);
  const cosOmega = Math.cos(omega);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosOmega) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosOmega) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

function lowShelfCoeff(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff {
  const A = Math.pow(10, gainDb / 40);
  const omega = (2 * Math.PI * freq) / sampleRate;
  const cosOmega = Math.cos(omega);
  const beta = (Math.sqrt(A) * Math.sin(omega)) / q;
  const am1 = A - 1;
  const ap1 = A + 1;
  const a0 = ap1 + am1 * cosOmega + beta;
  return {
    b0: (A * (ap1 - am1 * cosOmega + beta)) / a0,
    b1: (2 * A * (am1 - ap1 * cosOmega)) / a0,
    b2: (A * (ap1 - am1 * cosOmega - beta)) / a0,
    a1: (-2 * (am1 + ap1 * cosOmega)) / a0,
    a2: (ap1 + am1 * cosOmega - beta) / a0,
  };
}

function highShelfCoeff(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff {
  const A = Math.pow(10, gainDb / 40);
  const omega = (2 * Math.PI * freq) / sampleRate;
  const cosOmega = Math.cos(omega);
  const beta = (Math.sqrt(A) * Math.sin(omega)) / q;
  const am1 = A - 1;
  const ap1 = A + 1;
  const a0 = ap1 - am1 * cosOmega + beta;
  return {
    b0: (A * (ap1 + am1 * cosOmega + beta)) / a0,
    b1: (-2 * A * (am1 + ap1 * cosOmega)) / a0,
    b2: (A * (ap1 + am1 * cosOmega - beta)) / a0,
    a1: (2 * (am1 - ap1 * cosOmega)) / a0,
    a2: (ap1 - am1 * cosOmega - beta) / a0,
  };
}

function lowPassCoeff(freq: number, sampleRate: number, q: number): BiquadCoeff {
  const C = 1 / Math.tan((Math.PI * freq) / sampleRate);
  const d0 = C * C + C / q + 1;
  const d1 = 2 * (1 - C * C);
  const d2 = C * C - C / q + 1;
  return {
    b0: 1 / d0,
    b1: 2 / d0,
    b2: 1 / d0,
    a1: d1 / d0,
    a2: d2 / d0,
  };
}

function highPassCoeff(freq: number, sampleRate: number, q: number): BiquadCoeff {
  const C = 1 / Math.tan((Math.PI * freq) / sampleRate);
  const d0 = C * C + C / q + 1;
  const d1 = 2 * (1 - C * C);
  const d2 = C * C - C / q + 1;
  const C2 = C * C;
  return {
    b0: C2 / d0,
    b1: (-2 * C2) / d0,
    b2: C2 / d0,
    a1: d1 / d0,
    a2: d2 / d0,
  };
}

export function makePeak(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff {
  const fs = normalizeSampleRate(sampleRate);
  return peakCoeff(clampCutoff(freq, fs), normalizeQ(q), normalizeGainDb(gainDb), fs);
}

export function makeLowShelf(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff {
  const fs = normalizeSampleRate(sampleRate);
  return lowShelfCoeff(clampCutoff(freq, fs), normalizeQ(q), normalizeGainDb(gainDb), fs);
}

export function makeHighShelf(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff {
  const fs = normalizeSampleRate(sampleRate);
  return highShelfCoeff(clampCutoff(freq, fs), normalizeQ(q), normalizeGainDb(gainDb), fs);
}

export function makeLowPass(freq: number, sampleRate: number, q: number): BiquadCoeff {
  const fs = normalizeSampleRate(sampleRate);
  return lowPassCoeff(clampCutoff(freq, fs), fs, normalizeQ(q));
}

export function makeHighPass(freq: number, sampleRate: number, q: number): BiquadCoeff {
  const fs = normalizeSampleRate(sampleRate);
  return highPassCoeff(clampCutoff(freq, fs), fs, normalizeQ(q));
}

export function biquadGainDb(coeff: BiquadCoeff, freq: number, sampleRate: number): number {
  const fs = normalizeSampleRate(sampleRate);
  const limit = (fs / 2) * NYQUIST_MARGIN;
  const evaluated = Number.isNaN(freq) ? 0 : Math.min(limit, Math.max(0, freq));
  const w = (2 * Math.PI * evaluated) / fs;
  const cosW = Math.cos(w);
  const cos2W = Math.cos(2 * w);
  const sinW = Math.sin(w);
  const sin2W = Math.sin(2 * w);
  const numRe = coeff.b0 + coeff.b1 * cosW + coeff.b2 * cos2W;
  const numIm = -coeff.b1 * sinW - coeff.b2 * sin2W;
  const denRe = 1 + coeff.a1 * cosW + coeff.a2 * cos2W;
  const denIm = -coeff.a1 * sinW - coeff.a2 * sin2W;
  const num = numRe * numRe + numIm * numIm;
  const den = denRe * denRe + denIm * denIm;
  // 退化系数（全零或 NaN）按 0 dB 处理，宁可画平线也不让 NaN 进画布
  if (!Number.isFinite(num) || !Number.isFinite(den) || !(den > 0)) return 0;
  const magnitude2 = num / den;
  if (!Number.isFinite(magnitude2)) return 0;
  return 10 * Math.log10(Math.max(MAGNITUDE_FLOOR, magnitude2));
}

interface CoeffRequest {
  type: number;
  freq: number;
  gain: number;
  q: number;
  sampleRate: number;
  freqMin: number;
  freqMax: number;
}

function buildCoeff(request: CoeffRequest): BiquadCoeff | null {
  const cutoff = clampCutoff(request.freq, request.sampleRate, request.freqMin, request.freqMax);
  const q = normalizeQ(request.q);
  const gainDb = normalizeGainDb(request.gain);
  switch (request.type) {
    case EQ_TYPE_PEAK:
      return peakCoeff(cutoff, q, gainDb, request.sampleRate);
    case EQ_TYPE_LOW_SHELF:
      return lowShelfCoeff(cutoff, q, gainDb, request.sampleRate);
    case EQ_TYPE_HIGH_SHELF:
      return highShelfCoeff(cutoff, q, gainDb, request.sampleRate);
    case EQ_TYPE_LOW_PASS:
      return lowPassCoeff(cutoff, request.sampleRate, q);
    case EQ_TYPE_HIGH_PASS:
      return highPassCoeff(cutoff, request.sampleRate, q);
    default:
      return null;
  }
}

export function bandGainDb(band: EqBand, freq: number, sampleRate: number): number {
  const fs = normalizeSampleRate(sampleRate);
  const coeff = buildCoeff({
    type: band.type,
    freq: band.freq,
    gain: band.gain,
    q: band.q,
    sampleRate: fs,
    freqMin: FREQ_FLOOR,
    freqMax: FREQ_CEIL,
  });
  if (!coeff) return 0;
  return biquadGainDb(coeff, freq, fs);
}

function resolveFreqRange(freqMin: number | undefined, freqMax: number | undefined): [number, number] {
  const lo = typeof freqMin === 'number' && Number.isFinite(freqMin) && freqMin > 0 ? freqMin : FREQ_FLOOR;
  const hi = typeof freqMax === 'number' && Number.isFinite(freqMax) && freqMax > lo ? freqMax : FREQ_CEIL;
  // 区间退化（如 freqMin 反超 freqMax）时回落到默认量程，保证对数插值有意义
  return hi > lo ? [lo, hi] : [FREQ_FLOOR, FREQ_CEIL];
}

/**
 * 采样整条频响曲线。频点按对数等距：f[i] = freqMin * (freqMax/freqMin)^(i/(pointCount-1))。
 * pointCount < 2 时返回单点（契约 §8），不会抛异常。
 */
export function computeCurve(
  bands: readonly EqBand[],
  opts: ComputeCurveOptions = {},
): CurvePoint[] {
  const sampleRate = normalizeSampleRate(opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const [freqMin, freqMax] = resolveFreqRange(opts.freqMin, opts.freqMax);
  const rawCount = opts.pointCount ?? DEFAULT_POINT_COUNT;
  const pointCount = Number.isFinite(rawCount) ? Math.floor(rawCount) : DEFAULT_POINT_COUNT;
  const count = pointCount < 2 ? 1 : pointCount;
  const source = Array.isArray(bands) ? bands : [];

  // 系数与频点无关，按段预计算一次再扫频，避免 pointCount × bands 次重复三角运算
  const coeffs: BiquadCoeff[] = [];
  for (const band of source) {
    if (band.gain === 0 && band.type === EQ_TYPE_PEAK) continue;
    const coeff = buildCoeff({
      type: band.type,
      freq: band.freq,
      gain: band.gain,
      q: band.q,
      sampleRate,
      freqMin,
      freqMax,
    });
    if (coeff) coeffs.push(coeff);
  }

  const ratio = freqMax / freqMin;
  const points: CurvePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const freq = count < 2 ? freqMin : freqMin * Math.pow(ratio, i / (count - 1));
    let gainDb = 0;
    for (const coeff of coeffs) gainDb += biquadGainDb(coeff, freq, sampleRate);
    points.push({ freq, gainDb: Number.isFinite(gainDb) ? gainDb : 0 });
  }
  return points;
}
