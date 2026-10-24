import { describe, expect, it } from 'vitest';
import type { BandChangeDetail, FocusChangeDetail } from '../../src/renderer/src/eq/model';
import { EqModel } from '../../src/renderer/src/eq/model';
import type { EqBand } from '../../src/renderer/src/eq/types';

function listenBand(model: EqModel): BandChangeDetail[] {
  const details: BandChangeDetail[] = [];
  model.addEventListener('band-changed', (event) => {
    details.push((event as CustomEvent<BandChangeDetail>).detail);
  });
  return details;
}

function listenFocus(model: EqModel): FocusChangeDetail[] {
  const details: FocusChangeDetail[] = [];
  model.addEventListener('focus-changed', (event) => {
    details.push((event as CustomEvent<FocusChangeDetail>).detail);
  });
  return details;
}

function requireBand(model: EqModel, index: number): EqBand {
  const band = model.bandAt(index);
  if (!band) throw new Error(`band ${index} is missing`);
  return band;
}

describe('eq model', () => {
  it('starts with the 14 default bands and 7 editable segments', () => {
    const model = new EqModel();
    const bands = model.allBands();
    expect(bands).toHaveLength(14);
    expect(model.visibleCount()).toBe(7);
    expect(bands.map((band) => band.index)).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(requireBand(model, 0).freq).toBe(50);
    expect(requireBand(model, 0).q).toBe(0.7);
  });

  it('clamps gain to the parameter ceiling', () => {
    const model = new EqModel();
    model.setBand(0, { gain: 100 });
    expect(requireBand(model, 0).gain).toBe(12);
    model.setBand(0, { gain: -100 });
    expect(requireBand(model, 0).gain).toBe(-32);
  });

  it('quantizes every field to its step', () => {
    const model = new EqModel();
    model.setBand(1, {
      freq: 1234.5678,
      gain: 3.14159,
      q: 0.3333,
      type: 9.7 as EqBand['type'],
    });
    const band = requireBand(model, 1);
    expect(band.freq).toBe(1235);
    expect(band.gain).toBe(3.1);
    expect(band.q).toBe(0.3);
    expect(band.type).toBe(4);
  });

  it('ignores an out-of-range index without throwing', () => {
    const model = new EqModel();
    const before = model.allBands();
    expect(() => model.setBand(99, { gain: 6, type: 2 })).not.toThrow();
    expect(() => model.resetBandGain(99)).not.toThrow();
    expect(model.allBands()).toEqual(before);
    expect(model.bandAt(99)).toBeUndefined();
  });

  it('emits one band-changed per effective change', () => {
    const model = new EqModel();
    const events = listenBand(model);
    model.setBand(0, { gain: 3 });
    expect(events).toHaveLength(1);
    expect(events[0].index).toBe(0);
    expect(events[0].band.gain).toBe(3);
    // detail 里必须是副本，调用方改动不能回写模型
    events[0].band.gain = 9;
    expect(requireBand(model, 0).gain).toBe(3);
    model.setBand(0, { gain: 3 });
    expect(events).toHaveLength(1);
  });

  it('does not emit for a non-finite patch', () => {
    const model = new EqModel();
    const events = listenBand(model);
    model.setBand(2, { gain: Number.NaN, freq: Number.POSITIVE_INFINITY });
    expect(events).toHaveLength(0);
    expect(requireBand(model, 2).gain).toBe(-3.5);
    expect(requireBand(model, 2).freq).toBe(215);
  });

  it('resets gain and q on resetBandGain', () => {
    const model = new EqModel();
    model.setBand(3, { gain: -9, q: 4 });
    const events = listenBand(model);
    model.resetBandGain(3);
    expect(requireBand(model, 3).gain).toBe(0);
    expect(requireBand(model, 3).q).toBe(0.7);
    expect(events).toHaveLength(1);
    model.resetBandGain(3);
    expect(events).toHaveLength(1);
  });

  it('tracks focus and falls back to -1', () => {
    const model = new EqModel();
    const focus = listenFocus(model);
    expect(model.focusedIndex()).toBe(-1);
    model.setFocused(5);
    expect(model.focusedIndex()).toBe(5);
    expect(focus).toHaveLength(1);
    expect(focus[0].index).toBe(5);
    model.setFocused(5);
    expect(focus).toHaveLength(1);
    model.setFocused(99);
    expect(model.focusedIndex()).toBe(-1);
    expect(focus).toHaveLength(2);
    expect(focus[1].index).toBe(-1);
  });

  it('hands out copies so callers cannot mutate the model', () => {
    const model = new EqModel();
    const band = requireBand(model, 0);
    band.gain = 9;
    expect(requireBand(model, 0).gain).toBe(0);
    const bands = model.allBands() as EqBand[];
    bands[0].freq = 12345;
    expect(requireBand(model, 0).freq).toBe(50);
  });

  it('normalizes bands supplied by a caller', () => {
    const model = new EqModel([
      { index: 3, type: 2, freq: 99999, gain: 40, q: 0 },
      { index: 1, type: 0, freq: 1, gain: -40, q: 99 },
    ]);
    expect(model.allBands().map((band) => band.index)).toEqual([1, 3]);
    expect(requireBand(model, 3).freq).toBe(20000);
    expect(requireBand(model, 3).gain).toBe(12);
    expect(requireBand(model, 3).q).toBe(0.1);
    expect(requireBand(model, 1).freq).toBe(20);
    expect(requireBand(model, 1).gain).toBe(-32);
    expect(requireBand(model, 1).q).toBe(12);
  });
});
