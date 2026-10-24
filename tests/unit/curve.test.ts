import { describe, expect, it } from 'vitest';
import type { EqBand } from '../../src/renderer/src/eq/types';
import {
  bandGainDb,
  biquadGainDb,
  computeCurve,
  makeHighPass,
  makeLowPass,
  makePeak,
} from '../../src/renderer/src/eq/curve';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';

const SAMPLE_RATE = 48000;

function band(overrides: Partial<EqBand> = {}): EqBand {
  return { index: 0, type: 0, freq: 1000, gain: 0, q: 0.7, ...overrides };
}

describe('eq curve', () => {
  it('returns a flat 0 dB curve when no band is given', () => {
    const curve = computeCurve([]);
    expect(curve).toHaveLength(480);
    expect(curve.every((point) => point.gainDb === 0)).toBe(true);
  });

  it('puts a +6 dB peak exactly at its center frequency', () => {
    const peak = band({ freq: 1000, gain: 6, q: 1 });
    expect(bandGainDb(peak, 1000, SAMPLE_RATE)).toBeCloseTo(6, 2);
    expect(Math.abs(bandGainDb(peak, 20, SAMPLE_RATE))).toBeLessThan(0.2);
    expect(Math.abs(bandGainDb(peak, 20000, SAMPLE_RATE))).toBeLessThan(0.2);
  });

  it('renders the register table default bands instead of a flat curve', () => {
    expect(DEFAULT_BANDS).toHaveLength(14);
    const curve = computeCurve(DEFAULT_BANDS);
    expect(curve).toHaveLength(480);
    expect(curve.every((point) => Number.isFinite(point.gainDb))).toBe(true);
    // 第 1 段是 50 Hz HPF，20 Hz 处应明显衰减
    expect(curve[0].gainDb).toBeLessThan(-6);
    // 第 2 段是 20 kHz LPF，20 kHz 处约 −3 dB
    expect(curve[curve.length - 1].gainDb).toBeLessThan(-1.5);
    // 第 3 段 215 Hz / −3.5 dB 凹陷
    const dip = curve.reduce((best, point) =>
      (Math.abs(point.freq - 215) < Math.abs(best.freq - 215) ? point : best), curve[0]);
    expect(dip.freq).toBeGreaterThan(200);
    expect(dip.freq).toBeLessThan(230);
    expect(dip.gainDb).toBeLessThan(-3);
    expect(dip.gainDb).toBeGreaterThan(-5);
  });

  it('rolls low pass and high pass off outside the cutoff', () => {
    expect(bandGainDb(band({ type: 3, freq: 1000 }), 20000, SAMPLE_RATE)).toBeLessThan(-20);
    expect(bandGainDb(band({ type: 4, freq: 1000 }), 20, SAMPLE_RATE)).toBeLessThan(-20);
    // BLT Butterworth 在 Q = 1/√2 时截止点应为 -3 dB
    const butterworth = 1 / Math.SQRT2;
    expect(biquadGainDb(makeLowPass(1000, SAMPLE_RATE, butterworth), 1000, SAMPLE_RATE))
      .toBeCloseTo(-3.01, 1);
    expect(biquadGainDb(makeHighPass(1000, SAMPLE_RATE, butterworth), 1000, SAMPLE_RATE))
      .toBeCloseTo(-3.01, 1);
  });

  it('survives degenerate input without producing NaN', () => {
    const zeroQ = band({ freq: 1000, gain: 6, q: 0 });
    const tooLow = band({ type: 1, freq: 1, gain: 6, q: 0.7 });
    const tooHigh = band({ type: 2, freq: 30000, gain: 6, q: 0.7 });
    const curve = computeCurve([zeroQ, tooLow, tooHigh], { pointCount: 64 });
    expect(curve.every((point) => Number.isFinite(point.freq) && Number.isFinite(point.gainDb)))
      .toBe(true);
    for (const freq of [20, 100, 1000, 20000]) {
      for (const subject of [zeroQ, tooLow, tooHigh]) {
        expect(Number.isFinite(bandGainDb(subject, freq, SAMPLE_RATE))).toBe(true);
      }
    }
    expect(Number.isFinite(biquadGainDb(makePeak(1, 0, 6, 0), 1000, 0))).toBe(true);
    // 未知类型按 0 dB 处理
    const unknown = { ...band(), type: 9 as EqBand['type'] };
    expect(bandGainDb(unknown, 1000, SAMPLE_RATE)).toBe(0);
  });

  it('spaces the points logarithmically between the range ends', () => {
    const curve = computeCurve([band({ freq: 1000, gain: 3, q: 1 })], { pointCount: 480 });
    expect(curve).toHaveLength(480);
    expect(curve[0].freq).toBeCloseTo(20, 6);
    expect(curve[479].freq).toBeCloseTo(20000, 6);
    const step = Math.pow(20000 / 20, 1 / 479);
    expect(curve[1].freq / curve[0].freq).toBeCloseTo(step, 9);
  });

  it('respects a custom range and point count', () => {
    const curve = computeCurve([band({ freq: 1000, gain: 6, q: 1 })], {
      pointCount: 24,
      freqMin: 100,
      freqMax: 2000,
    });
    expect(curve).toHaveLength(24);
    expect(curve[0].freq).toBeCloseTo(100, 6);
    expect(curve[23].freq).toBeCloseTo(2000, 6);
  });

  it('falls back to a single point when pointCount < 2', () => {
    const curve = computeCurve([band({ freq: 1000, gain: 6, q: 1 })], {
      pointCount: 1,
      freqMin: 100,
      freqMax: 2000,
    });
    expect(curve).toHaveLength(1);
    expect(curve[0].freq).toBe(100);
    expect(Number.isFinite(curve[0].gainDb)).toBe(true);
  });

  it('prints sampled points for eyeball verification', () => {
    const bands: EqBand[] = [
      band({ index: 0, type: 1, freq: 100, gain: -6, q: 0.7 }),
      band({ index: 1, type: 0, freq: 1000, gain: 6, q: 1 }),
      band({ index: 2, type: 2, freq: 8000, gain: 3, q: 0.7 }),
    ];
    const curve = computeCurve(bands);
    expect(curve).toHaveLength(480);
    for (const index of [0, 120, 240, 360, 479]) {
      const point = curve[index];
      expect(Number.isFinite(point.gainDb)).toBe(true);
      console.log(
        `curve[${index}] freq=${point.freq.toFixed(1)} Hz gain=${point.gainDb.toFixed(3)} dB`,
      );
    }
  });
});
