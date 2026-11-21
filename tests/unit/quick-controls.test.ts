import { describe, expect, it } from 'vitest';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';
import {
  DEFAULT_CUSTOM_GAINS,
  EQ_PRESETS,
  gainsOf,
  limitEnableOn,
  limitEnableValue,
  matchEqPreset,
  matchesGains,
} from '../../src/renderer/src/domain/quick-controls';

describe('quick controls', () => {
  it('drives the peak guard from limit.Enable (C-15)', () => {
    expect(limitEnableOn(1)).toBe(true);
    expect(limitEnableOn(0)).toBe(false);
    // 非 0/1 的脏值一律按"关"处理，避免把设备回读的越界值当成开
    expect(limitEnableOn(2)).toBe(false);
    expect(limitEnableValue(true)).toBe(1);
    expect(limitEnableValue(false)).toBe(0);
  });

  it('offers four fixed tone presets that stay inside the band gain range', () => {
    expect(Object.keys(EQ_PRESETS)).toEqual(['flat', 'vocal', 'warm', 'bright']);
    for (const gains of Object.values(EQ_PRESETS)) {
      expect(gains).toHaveLength(7);
      for (const gain of gains) {
        expect(gain).toBeGreaterThanOrEqual(-32);
        expect(gain).toBeLessThanOrEqual(12);
      }
    }
    expect(DEFAULT_CUSTOM_GAINS).toHaveLength(7);
    expect([...DEFAULT_CUSTOM_GAINS]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('detects which tone preset the current bands match', () => {
    const flat = DEFAULT_BANDS.map((band) => ({ ...band, gain: 0 }));
    expect(matchEqPreset(flat, 7)).toBe('flat');

    const vocal = flat.map((band) =>
      band.index < 7 ? { ...band, gain: EQ_PRESETS.vocal[band.index] } : { ...band },
    );
    expect(matchEqPreset(vocal, 7)).toBe('vocal');

    const tailOnly = flat.map((band) =>
      band.index === 6 ? { ...band, gain: -1 } : { ...band },
    );
    expect(matchEqPreset(tailOnly, 7)).toBeNull();
  });

  it('compares arbitrary gain sets (custom tone) and extracts the current gains', () => {
    const flat = DEFAULT_BANDS.map((band) => ({ ...band, gain: 0 }));
    expect(matchesGains(flat, [0, 0, 0, 0, 0, 0, 0])).toBe(true);
    expect(matchesGains(flat, [0, 3, 0, 0, 0, 0, 0])).toBe(false);
    expect(gainsOf(flat)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
