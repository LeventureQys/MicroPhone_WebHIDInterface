import { describe, expect, it } from 'vitest';
import { FreqMapper } from '../../src/renderer/src/eq/mapper';

const VIEWPORT = { x: 40, y: 12, width: 900, height: 300 };

function createMapper(): FreqMapper {
  return new FreqMapper(VIEWPORT);
}

describe('freq mapper', () => {
  it('anchors 20 Hz and 20 kHz to the viewport edges', () => {
    const mapper = createMapper();
    expect(mapper.freqToX(20)).toBeCloseTo(VIEWPORT.x, 6);
    expect(mapper.freqToX(20000)).toBeCloseTo(VIEWPORT.x + VIEWPORT.width, 6);
  });

  it('round-trips frequency through the log axis', () => {
    const mapper = createMapper();
    for (const freq of [20, 100, 1000, 20000]) {
      const back = mapper.xToFreq(mapper.freqToX(freq));
      expect(Math.abs(back - freq) / freq).toBeLessThan(1e-6);
    }
  });

  it('anchors the gain axis to the viewport edges', () => {
    const mapper = createMapper();
    expect(mapper.gainToY(12)).toBeCloseTo(VIEWPORT.y, 6);
    expect(mapper.gainToY(-24)).toBeCloseTo(VIEWPORT.y + VIEWPORT.height, 6);
    expect(mapper.yToGain(VIEWPORT.y)).toBeCloseTo(12, 6);
    expect(mapper.yToGain(VIEWPORT.y + VIEWPORT.height)).toBeCloseTo(-24, 6);
  });

  it('clamps out-of-range input to the axis limits', () => {
    const mapper = createMapper();
    expect(mapper.xToFreq(-9999)).toBe(20);
    expect(mapper.xToFreq(99999)).toBe(20000);
    expect(mapper.yToGain(-9999)).toBe(12);
    expect(mapper.yToGain(99999)).toBe(-24);
    expect(mapper.freqToX(1)).toBeCloseTo(VIEWPORT.x, 6);
    expect(mapper.freqToX(30000)).toBeCloseTo(VIEWPORT.x + VIEWPORT.width, 6);
  });

  it('produces the 1-2-5 frequency ticks in increasing order', () => {
    const ticks = FreqMapper.freqTicks(20, 20000);
    for (const expected of [20, 50, 100, 1000, 10000, 20000]) {
      expect(ticks).toContain(expected);
    }
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });

  it('steps the gain ticks from the lower bound', () => {
    expect(FreqMapper.gainTicks(-24, 12)).toEqual([-24, -18, -12, -6, 0, 6, 12]);
    expect(FreqMapper.gainTicks(-24, 12, 12)).toEqual([-24, -12, 0, 12]);
  });

  it('remaps after the viewport changes', () => {
    const mapper = createMapper();
    mapper.setViewport({ x: 0, y: 0, width: 100, height: 100 });
    expect(mapper.freqToX(20)).toBe(0);
    expect(mapper.freqToX(20000)).toBe(100);
    expect(mapper.gainToY(-24)).toBe(100);
  });

  it('exposes the configured axis ranges', () => {
    const mapper = new FreqMapper(VIEWPORT, 30, 16000, -18, 6);
    expect(mapper.freqMin).toBe(30);
    expect(mapper.freqMax).toBe(16000);
    expect(mapper.gainMin).toBe(-18);
    expect(mapper.gainMax).toBe(6);
  });

  it('stays finite for a degenerate viewport', () => {
    const mapper = new FreqMapper({ x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(mapper.xToFreq(500))).toBe(true);
    expect(Number.isFinite(mapper.freqToX(1000))).toBe(true);
    expect(Number.isFinite(mapper.gainToY(-24))).toBe(true);
    expect(Number.isFinite(mapper.yToGain(120))).toBe(true);
  });
});
