import { describe, expect, it } from 'vitest';
import { ReadonlyGainFilter } from '../../src/renderer/src/device/gain-filter';

describe('ReadonlyGainFilter', () => {
  it('shows the first sample immediately', () => {
    const filter = new ReadonlyGainFilter();
    expect(filter.accept('gain.Hp', 88)).toBe(88);
  });

  it('absorbs ±2 ADC noise instead of following every sample', () => {
    const filter = new ReadonlyGainFilter();
    const seen = new Set<number>();
    for (const value of [100, 101, 99, 102, 98, 100, 101, 99, 100, 101]) {
      seen.add(filter.accept('gain.Hp', value));
    }
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  it('follows a real level change after the window settles', () => {
    const filter = new ReadonlyGainFilter();
    for (let index = 0; index < 5; index += 1) filter.accept('gain.Hp', 100);
    for (let index = 0; index < 4; index += 1) filter.accept('gain.Hp', 92);
    expect(filter.accept('gain.Hp', 92)).toBe(92);
  });

  it('keeps two ids independent and forgets them on reset', () => {
    const filter = new ReadonlyGainFilter();
    filter.accept('gain.Hp', 80);
    filter.accept('gain.Mic', 60);
    expect(filter.accept('gain.Hp', 80)).toBe(80);
    expect(filter.accept('gain.Mic', 60)).toBe(60);

    filter.reset();
    expect(filter.accept('gain.Hp', 40)).toBe(40);
  });
});
