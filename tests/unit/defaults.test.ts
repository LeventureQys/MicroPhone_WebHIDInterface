import { describe, expect, it } from 'vitest';
import { DEFAULT_BANDS, DEFAULT_LANG, DEFAULT_PARAMS } from '../../src/renderer/src/domain/defaults';
import { PARAMS } from '../../src/renderer/src/domain/params';
import { findRegister, fromRaw, eqBandAddr } from '../../src/renderer/src/device/registers';
import { EQ_BAND_TOTAL } from '../../src/renderer/src/eq/types';

/** 设计文档 §5.3 的 EQ 默认表：type / freq / gain(dB) / q */
const EDITABLE_DEFAULTS = [
  { type: 4, freq: 50, gain: 0, q: 0.7 },
  { type: 3, freq: 20000, gain: 0, q: 0.7 },
  { type: 0, freq: 215, gain: -3.5, q: 0.8 },
  { type: 0, freq: 1000, gain: 0, q: 1.5 },
  { type: 0, freq: 2000, gain: 0, q: 1.0 },
  { type: 0, freq: 5000, gain: 0, q: 1.0 },
  { type: 0, freq: 10000, gain: 0, q: 0.7 },
] as const;

/** 内部段沿用 v1.0.0 的对数插值频点（round(20 × 10^position)） */
const INNER_FREQS = [36, 112, 356, 1125, 3557, 11247, 17825];

describe('default params', () => {
  it('is a frozen record with one entry per parameter', () => {
    expect(Object.isFrozen(DEFAULT_PARAMS)).toBe(true);
    expect(Object.keys(DEFAULT_PARAMS)).toHaveLength(42);
    for (const spec of PARAMS) {
      expect(DEFAULT_PARAMS[spec.id]).toBe(spec.default);
    }
  });

  it('takes the register table defaults that used to conflict with the old sheet', () => {
    expect(DEFAULT_PARAMS['drc3.low.ratio']).toBe(1);
    expect(DEFAULT_PARAMS['drc3.mid.ratio']).toBe(1);
    expect(DEFAULT_PARAMS['drc3.high.ratio']).toBe(1);
    expect(DEFAULT_PARAMS['comp.Threshold']).toBe(-2);
    expect(DEFAULT_PARAMS['limit.Threshold']).toBe(-2);
    expect(DEFAULT_PARAMS['noisegate.threshold_db']).toBe(-91);
    expect(DEFAULT_PARAMS['noisegate.ratio']).toBe(0.05);
    expect(DEFAULT_PARAMS['noisegate.attack_ms']).toBe(5);
    expect(DEFAULT_PARAMS['noisegate.release_ms']).toBe(5);
    expect(DEFAULT_PARAMS['noisegate.knee_width_db']).toBe(6);
    expect(DEFAULT_PARAMS['noisegate.hp_freq']).toBe(60);
    expect(DEFAULT_PARAMS['comp.KneeWidth']).toBe(1);
    expect(DEFAULT_PARAMS['comp.Rate']).toBe(6);
    expect(DEFAULT_PARAMS['enc.Level']).toBe(0);
    expect(DEFAULT_PARAMS['gain.Mic']).toBe(100);
    expect(DEFAULT_PARAMS['gain.Hp']).toBe(100);
    expect(DEFAULT_PARAMS['drc3.fc1']).toBe(50);
    expect(DEFAULT_PARAMS['drc3.fc2']).toBe(50);
    expect(DEFAULT_PARAMS['drc3.low.preGain']).toBe(0);
    expect(DEFAULT_PARAMS['drc3.low.attackTime']).toBe(1);
    expect(DEFAULT_PARAMS['drc3.low.releaseTime']).toBe(5);
    expect(DEFAULT_PARAMS['hp.OnOff']).toBe(1);
    expect(DEFAULT_LANG).toBe('zh');
  });
});

describe('default eq bands', () => {
  it('has 14 bands', () => {
    expect(DEFAULT_BANDS).toHaveLength(EQ_BAND_TOTAL);
    expect(DEFAULT_BANDS.map((band) => band.index)).toEqual(
      Array.from({ length: EQ_BAND_TOTAL }, (_, index) => index),
    );
  });

  it('takes the first 7 bands from the register defaults', () => {
    EDITABLE_DEFAULTS.forEach((expected, index) => {
      const band = DEFAULT_BANDS[index];
      expect(band.index, `band ${index + 1} index`).toBe(index);
      expect(band.type, `band ${index + 1} type`).toBe(expected.type);
      expect(band.freq, `band ${index + 1} freq`).toBe(expected.freq);
      expect(band.gain, `band ${index + 1} gain`).toBeCloseTo(expected.gain, 6);
      expect(band.q, `band ${index + 1} q`).toBeCloseTo(expected.q, 6);
    });
    // 逐段核对确实来自寄存器表 G 列，而不是另写一份字面量
    for (let band = 0; band < 7; band += 1) {
      const gainSpec = findRegister(eqBandAddr(band, 'gain'));
      const qSpec = findRegister(eqBandAddr(band, 'q'));
      expect(gainSpec).toBeDefined();
      expect(qSpec).toBeDefined();
      if (!gainSpec || !qSpec) continue;
      expect(DEFAULT_BANDS[band].gain).toBe(fromRaw(gainSpec, gainSpec.defaultRaw));
      expect(DEFAULT_BANDS[band].q).toBe(fromRaw(qSpec, qSpec.defaultRaw));
      expect(DEFAULT_BANDS[band].type).toBe(findRegister(eqBandAddr(band, 'type'))?.defaultRaw);
      expect(DEFAULT_BANDS[band].freq).toBe(findRegister(eqBandAddr(band, 'freq'))?.defaultRaw);
    }
  });

  it('keeps the inner 7 bands on the local logarithmic defaults', () => {
    for (let offset = 0; offset < 7; offset += 1) {
      const band = DEFAULT_BANDS[7 + offset];
      expect(band.index).toBe(7 + offset);
      expect(band.type).toBe(0);
      expect(band.freq).toBe(INNER_FREQS[offset]);
      expect(band.gain).toBe(0);
      expect(band.q).toBe(0.7);
    }
  });
});
