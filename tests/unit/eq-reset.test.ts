import { describe, expect, it } from 'vitest';
import { EQ_RESET_GAIN_DB, EQ_RESET_Q, eqResetBands, withEqReset } from '../../src/renderer/src/domain/eq-reset';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';
import { EQ_BAND_EDITABLE, EQ_BAND_TOTAL, EQ_TYPE_LABEL } from '../../src/renderer/src/eq/types';

/**
 * 「均衡器复位」的落点固定为 2026-11-21 问题单第 12 条那张频段列表：
 * 1 HPF 50 / 2 LPF 20000 / 3–7 PEAK 215·1000·2000·5000·10000，增益全 0、Q 全 0.7。
 * 这**不是**参数表的出厂默认值（那条是 Band-3 −3.5 dB、Q 0.8/1.5/1.0/1.0），所以单独锁住。
 */
describe('eq reset preset (buglist 2026-11-21 #12)', () => {
  it('resets all seven editable bands to 0 dB and Q 0.7', () => {
    const bands = eqResetBands();
    expect(bands).toHaveLength(EQ_BAND_EDITABLE);
    for (const band of bands) {
      expect(band.gain).toBe(EQ_RESET_GAIN_DB);
      expect(band.q).toBe(EQ_RESET_Q);
      expect(band.q).toBe(0.7);
    }
  });

  it('keeps the register types and frequencies from the parameter table', () => {
    const bands = eqResetBands();
    expect(bands.map((band) => EQ_TYPE_LABEL[band.type])).toEqual(['HPF', 'LPF', 'PEAK', 'PEAK', 'PEAK', 'PEAK', 'PEAK']);
    expect(bands.map((band) => band.freq)).toEqual([50, 20000, 215, 1000, 2000, 5000, 10000]);
    expect(bands.map((band) => band.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('differs from the factory defaults exactly where the buglist asked', () => {
    const reset = eqResetBands();
    const factory = DEFAULT_BANDS.slice(0, EQ_BAND_EDITABLE);
    const changed = factory
      .map((band, index) => ({
        band: index + 1,
        gain: band.gain !== reset[index].gain,
        q: band.q !== reset[index].q,
      }))
      .filter((entry) => entry.gain || entry.q);
    expect(changed).toEqual([
      { band: 3, gain: true, q: true },
      { band: 4, gain: false, q: true },
      { band: 5, gain: false, q: true },
      { band: 6, gain: false, q: true },
    ]);
  });

  it('applies to the whole 14-band curve without touching the internal bands', () => {
    const current = DEFAULT_BANDS.map((band, index) => ({
      ...band,
      gain: index * 0.5,
      q: 2 + index,
      freq: index < EQ_BAND_EDITABLE ? band.freq : 12345,
    }));
    const next = withEqReset(current);
    expect(next).toHaveLength(EQ_BAND_TOTAL);
    for (const band of next.slice(0, EQ_BAND_EDITABLE)) {
      expect(band.gain).toBe(EQ_RESET_GAIN_DB);
      expect(band.q).toBe(EQ_RESET_Q);
    }
    for (let index = EQ_BAND_EDITABLE; index < EQ_BAND_TOTAL; index += 1) {
      expect(next[index]).toEqual(current[index]);
    }
    // 不改原数组
    expect(current[0].gain).toBe(0);
    expect(current[1].gain).toBe(0.5);
  });
});
