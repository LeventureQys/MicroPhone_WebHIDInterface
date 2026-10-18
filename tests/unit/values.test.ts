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
    expect(quantize(must('gain.Mic'), 999)).toBe(36);
    expect(quantize(must('gain.Mic'), -999)).toBe(-27);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampValue(must('gain.Mic'), Number.NaN)).toBe(5);
    expect(clampValue(must('gain.Mic'), Number.POSITIVE_INFINITY)).toBe(36);
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
    expect(parseInput(must('gain.Mic'), '500')).toBe(36);
  });
});

describe('default bands', () => {
  it('has 14 flat bands', () => {
    expect(DEFAULT_BANDS).toHaveLength(14);
    for (const band of DEFAULT_BANDS) {
      expect(band.gain).toBe(0);
      expect(band.q).toBe(0.7);
      expect(band.type).toBe(0);
      expect(band.freq).toBeGreaterThanOrEqual(20);
      expect(band.freq).toBeLessThanOrEqual(20000);
    }
  });

  it('spreads the editable bands logarithmically over the audio range', () => {
    const editable = DEFAULT_BANDS.slice(0, 7).map((band) => band.freq);
    expect(editable[0]).toBe(20);
    expect(editable[6]).toBe(20000);
    for (let i = 1; i < editable.length; i += 1) {
      expect(editable[i]).toBeGreaterThan(editable[i - 1]);
    }
  });
});
