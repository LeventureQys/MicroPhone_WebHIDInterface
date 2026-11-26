import { describe, expect, it } from 'vitest';
import {
  EQ_RESET_GAIN_DB,
  EQ_RESET_Q,
  defaultEqBands,
  eqResetBands,
  withEqDefaults,
  withEqReset,
} from '../../src/renderer/src/domain/eq-reset';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';
import { EQ_BAND_EDITABLE, EQ_BAND_TOTAL, EQ_TYPE_LABEL } from '../../src/renderer/src/eq/types';

/**
 * 「均衡器复位」的落点：2026-11-21 问题单第 12 条那张频段列表 +
 * 2026-11-22 问题单第 2、3 条改过的默认频点（3–7 段 63 / 250 / 1k / 4k / 12.5k）。
 * 7 段增益全 0、Q 全 0.7；这**不是**参数表的出厂默认值
 * （那条是 Band-3 −3.5 dB、Q 0.8/1.5/1.0/1.0/0.7，频点 215/1000/2000/5000/10000），所以单独锁住。
 */
describe('eq reset preset (buglist 2026-11-21 #12 + 2026-11-22 #2/#3)', () => {
  it('resets all seven editable bands to 0 dB and Q 0.7', () => {
    const bands = eqResetBands();
    expect(bands).toHaveLength(EQ_BAND_EDITABLE);
    for (const band of bands) {
      expect(band.gain).toBe(EQ_RESET_GAIN_DB);
      expect(band.q).toBe(EQ_RESET_Q);
      expect(band.q).toBe(0.7);
    }
  });

  it('keeps the types and the product default frequencies', () => {
    const bands = eqResetBands();
    expect(bands.map((band) => EQ_TYPE_LABEL[band.type])).toEqual(['HPF', 'LPF', 'PEAK', 'PEAK', 'PEAK', 'PEAK', 'PEAK']);
    expect(bands.map((band) => band.freq)).toEqual([50, 20000, 63, 250, 1000, 4000, 12500]);
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

  it('restores the current tone default (not flat) with product Q/frequencies', () => {
    // 旧预设给前两格也塞过增益（-3 / -2）：第 1、2 段是 HPF / LPF，必须落成 0
    const gains = [-3, -2, -1, 1, 3, 2, 0];
    const expected = [0, 0, -1, 1, 3, 2, 0];
    const bands = defaultEqBands(gains);
    expect(bands.map((band) => band.gain)).toEqual(expected);
    // Q / 频点取产品默认，不是旧的 Q=0.7 平坦复位
    expect(bands.map((band) => band.q)).toEqual([0.7, 0.7, 0.8, 1.5, 1, 1, 0.7]);
    expect(bands.map((band) => band.freq)).toEqual([50, 20000, 63, 250, 1000, 4000, 12500]);

    const current = DEFAULT_BANDS.map((band, index) => ({
      ...band,
      gain: 9,
      q: 3,
      freq: index < EQ_BAND_EDITABLE ? 123 : band.freq,
    }));
    const next = withEqDefaults(current, gains);
    expect(next.slice(0, EQ_BAND_EDITABLE).map((band) => band.gain)).toEqual(expected);
    for (let index = EQ_BAND_EDITABLE; index < EQ_BAND_TOTAL; index += 1) {
      expect(next[index]).toEqual(current[index]);
    }
  });
});
