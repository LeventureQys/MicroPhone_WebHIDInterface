import { describe, expect, it } from 'vitest';
import { findParam } from '../../src/renderer/src/domain/params';
import { clampValue, formatValue, parseInput, quantize } from '../../src/renderer/src/domain/values';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';

function must(id: string) {
  const spec = findParam(id);
  if (!spec) throw new Error('missing spec ' + id);
  return spec;
}

describe('value rules', () => {
  it('quantizes to the configured step', () => {
    expect(quantize(must('noisegate.ratio'), 0.3335)).toBe(0.333);
    expect(quantize(must('drc3.low.preGain'), 1.285)).toBe(1.28);
  });

  it('clamps out-of-range input', () => {
    expect(quantize(must('gain.Mic'), 999)).toBe(100);
    expect(quantize(must('gain.Mic'), -999)).toBe(0);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampValue(must('gain.Mic'), Number.NaN)).toBe(100);
    expect(clampValue(must('gain.Mic'), Number.POSITIVE_INFINITY)).toBe(100);
  });

  it('formats without trailing zeros', () => {
    expect(formatValue(must('comp.Attack'), 0.0005)).toBe('0.0005');
    expect(formatValue(must('comp.Release'), 0.1)).toBe('0.1');
    expect(formatValue(must('comp.Rate'), 6)).toBe('6');
    expect(formatValue(must('limit.Threshold'), -60)).toBe('-60');
    expect(formatValue(must('drc3.low.preGain'), 1.28)).toBe('1.28');
  });

  it('parses user input defensively', () => {
    expect(parseInput(must('comp.Rate'), '')).toBeNull();
    expect(parseInput(must('comp.Rate'), 'abc')).toBeNull();
    expect(parseInput(must('drc3.low.preGain'), '3.21')).toBe(3.21);
    expect(parseInput(must('gain.Mic'), '500')).toBe(100);
  });
});

describe('default bands', () => {
  it('has 14 bands with the register table defaults up front', () => {
    expect(DEFAULT_BANDS).toHaveLength(14);
    // 前 7 段来自寄存器表（HPF 50 Hz / LPF 20 kHz / 第 3 段 −3.5 dB），后 7 段保持本地平直默认
    expect(DEFAULT_BANDS.slice(0, 7).map((band) => band.type)).toEqual([4, 3, 0, 0, 0, 0, 0]);
    expect(DEFAULT_BANDS.slice(0, 7).map((band) => band.freq)).toEqual([
      50, 20000, 215, 1000, 2000, 5000, 10000,
    ]);
    expect(DEFAULT_BANDS.slice(7).map((band) => band.type)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    for (const band of DEFAULT_BANDS) {
      expect(band.gain).toBeGreaterThanOrEqual(-32);
      expect(band.gain).toBeLessThanOrEqual(12);
      expect(band.q).toBeGreaterThanOrEqual(0.1);
      expect(band.q).toBeLessThanOrEqual(12);
      expect(band.freq).toBeGreaterThanOrEqual(20);
      expect(band.freq).toBeLessThanOrEqual(20000);
    }
  });

  it('spreads the editable bands over the audio range', () => {
    const editable = DEFAULT_BANDS.slice(0, 7).map((band) => band.freq);
    expect(editable[0]).toBe(50);
    expect(editable[6]).toBe(10000);
    for (let i = 1; i < editable.length; i += 1) {
      expect(editable[i]).not.toBe(editable[i - 1]);
    }
  });
});
