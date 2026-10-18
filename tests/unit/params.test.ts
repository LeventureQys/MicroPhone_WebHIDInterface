import { describe, expect, it } from 'vitest';
import { PARAMS, findParam, paramsOf } from '../../src/renderer/src/domain/params';

describe('params table', () => {
  it('has 36 scalar parameters', () => {
    expect(PARAMS.length).toBe(36);
  });

  it('uses unique ids', () => {
    const ids = PARAMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every spec inside a self-consistent range', () => {
    for (const spec of PARAMS) {
      expect(spec.min).toBeLessThanOrEqual(spec.default);
      expect(spec.default).toBeLessThanOrEqual(spec.max);
      expect(spec.step).toBeGreaterThan(0);
      const steps = (spec.max - spec.min) / spec.step;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
  });

  it('splits modules as specified', () => {
    expect(paramsOf('gain')).toHaveLength(2);
    expect(paramsOf('noisegate')).toHaveLength(6);
    expect(paramsOf('comp')).toHaveLength(6);
    expect(paramsOf('limit')).toHaveLength(3);
    expect(paramsOf('enc')).toHaveLength(2);
    expect(paramsOf('drc3')).toHaveLength(17);
  });

  it('marks only mic and headphone gain as readonly', () => {
    const readonly = PARAMS.filter((item) => item.readonly).map((item) => item.id);
    expect(readonly.sort()).toEqual(['gain.Hp', 'gain.Mic']);
  });

  it('resolves specs by id', () => {
    const spec = findParam('noisegate.threshold_db');
    expect(spec?.min).toBe(-91);
    expect(spec?.max).toBe(0);
    expect(spec?.default).toBe(-70);
    expect(findParam('nope')).toBeUndefined();
  });
});
