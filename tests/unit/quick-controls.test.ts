import { describe, expect, it } from 'vitest';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';
import {
  EQ_PRESETS,
  denoiseStrengthFromThreshold,
  limitEnableOn,
  limitEnableValue,
  matchEqPreset,
  smoothnessFromThreshold,
  thresholdFromDenoiseStrength,
  thresholdFromSmoothness,
} from '../../src/renderer/src/domain/quick-controls';

describe('quick controls', () => {
  it('maps denoise strength onto the gate threshold', () => {
    expect(thresholdFromDenoiseStrength(0)).toBe(-91);
    expect(thresholdFromDenoiseStrength(100)).toBe(0);
    expect(thresholdFromDenoiseStrength(50)).toBe(-45);

    for (const threshold of [-91, -70, -45, -12, 0]) {
      expect(thresholdFromDenoiseStrength(denoiseStrengthFromThreshold(threshold))).toBe(threshold);
    }
  });

  it('maps evenness onto the compressor threshold', () => {
    expect(thresholdFromSmoothness(0)).toBe(0);
    expect(thresholdFromSmoothness(100)).toBe(-60);
    expect(thresholdFromSmoothness(50)).toBe(-30);

    for (const threshold of [-60, -30, -6, 0]) {
      expect(thresholdFromSmoothness(smoothnessFromThreshold(threshold))).toBe(threshold);
    }
  });

  it('keeps the simple mappings monotonic', () => {
    let previousGate = -Infinity;
    let previousComp = Infinity;
    for (let strength = 0; strength <= 100; strength += 5) {
      const gate = thresholdFromDenoiseStrength(strength);
      const comp = thresholdFromSmoothness(strength);
      expect(gate).toBeGreaterThan(previousGate);
      expect(comp).toBeLessThan(previousComp);
      previousGate = gate;
      previousComp = comp;
    }
  });

  it('drives the peak guard from limit.Enable (C-15)', () => {
    expect(limitEnableOn(1)).toBe(true);
    expect(limitEnableOn(0)).toBe(false);
    // 非 0/1 的脏值一律按"关"处理，避免把设备回读的越界值当成开
    expect(limitEnableOn(2)).toBe(false);
    expect(limitEnableValue(true)).toBe(1);
    expect(limitEnableValue(false)).toBe(0);
  });

  it('offers five tone presets that stay inside the band gain range', () => {
    for (const gains of Object.values(EQ_PRESETS)) {
      expect(gains).toHaveLength(7);
      for (const gain of gains) {
        expect(gain).toBeGreaterThanOrEqual(-32);
        expect(gain).toBeLessThanOrEqual(12);
      }
    }
  });

  it('detects which tone preset the current bands match', () => {
    // 设备默认段含 HPF/LPF 与 −3.5 dB 凹陷，先把增益抹平再比对风格
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
});
