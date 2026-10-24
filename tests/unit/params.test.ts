import { describe, expect, it } from 'vitest';
import type { ParamUnit } from '../../src/renderer/src/domain/params';
import { findParam, findParamByAddr, PARAMS, paramsOf } from '../../src/renderer/src/domain/params';
import { findRegister } from '../../src/renderer/src/device/registers';

/** id / addr / min / max / step / unit / readonly / default —— 手抄设计文档 §5.3 定稿表 */
type Expected = readonly [string, number, number, number, number, ParamUnit, boolean, number];

const EXPECTED: readonly Expected[] = [
  ['gain.Mic', 0x2023, 0, 100, 1, '', true, 100],
  ['gain.Hp', 0x205a, 0, 100, 1, '', true, 100],
  ['mic.mute', 0x2022, 0, 1, 1, '', false, 0],
  ['mic.sigMute', 0x2058, 0, 1, 1, '', false, 0],
  ['hp.OnOff', 0x2059, 0, 1, 1, '', false, 1],

  ['enc.OnOff', 0x2024, 0, 1, 1, '', false, 0],
  ['enc.Level', 0x2025, 0, 3, 1, '', false, 0],

  ['eq.mode', 0x2026, 0, 4, 1, '', false, 1],

  ['comp.Enable', 0x204a, 0, 1, 1, '', false, 0],
  ['comp.MakeUpGain', 0x204b, 0, 60, 0.1, 'dB', false, 0],
  ['comp.Threshold', 0x204c, -60, 0, 0.1, 'dB', false, -2],
  ['comp.Attack', 0x204d, 0.0001, 0.2, 0.0001, 's', false, 0.0005],
  ['comp.Release', 0x204e, 0.005, 2, 0.0001, 's', false, 0.1],
  ['comp.Rate', 0x204f, 1, 100, 0.1, '', false, 6],
  ['comp.KneeWidth', 0x2050, 0, 60, 0.1, 'dB', false, 1],

  ['limit.Enable', 0x2051, 0, 1, 1, '', false, 0],
  ['limit.Threshold', 0x2053, -60, 0, 0.1, 'dB', false, -2],
  ['limit.Attack', 0x2054, 0.0001, 0.2, 0.0001, 's', false, 0.0005],
  ['limit.Release', 0x2055, 0.005, 2, 0.0001, 's', false, 0.05],

  ['noisegate.threshold_db', 0x205b, -91, 0, 1, 'dB', false, -91],
  ['noisegate.ratio', 0x205c, 0.05, 0.999, 0.001, '', false, 0.05],
  ['noisegate.attack_ms', 0x205d, 5, 500, 1, 'ms', false, 5],
  ['noisegate.release_ms', 0x205e, 5, 500, 1, 'ms', false, 5],
  ['noisegate.knee_width_db', 0x205f, 6, 12, 1, 'dB', false, 6],
  ['noisegate.hp_freq', 0x2060, 60, 200, 1, 'Hz', false, 60],

  ['drc3.fc1', 0x2061, 50, 10000, 1, 'Hz', false, 50],
  ['drc3.fc2', 0x2062, 50, 10000, 1, 'Hz', false, 50],
  ['drc3.low.preGain', 0x2063, 0, 4, 0.01, '', false, 0],
  ['drc3.low.threshold', 0x2064, -80, 0, 0.1, 'dB', false, -80],
  ['drc3.low.attackTime', 0x2065, 1, 400, 1, 'ms', false, 1],
  ['drc3.low.releaseTime', 0x2066, 5, 680, 1, 'ms', false, 5],
  ['drc3.low.ratio', 0x2067, 1, 20, 0.1, '', false, 1],
  ['drc3.high.preGain', 0x2068, 0, 4, 0.01, '', false, 0],
  ['drc3.high.threshold', 0x2069, -80, 0, 0.1, 'dB', false, -80],
  ['drc3.high.attackTime', 0x206a, 1, 400, 1, 'ms', false, 1],
  ['drc3.high.releaseTime', 0x206b, 5, 680, 1, 'ms', false, 5],
  ['drc3.high.ratio', 0x206c, 1, 20, 0.1, '', false, 1],
  ['drc3.mid.preGain', 0x206d, 0, 4, 0.01, '', false, 0],
  ['drc3.mid.threshold', 0x206e, -80, 0, 0.1, 'dB', false, -80],
  ['drc3.mid.attackTime', 0x206f, 1, 400, 1, 'ms', false, 1],
  ['drc3.mid.releaseTime', 0x2070, 5, 680, 1, 'ms', false, 5],
  ['drc3.mid.ratio', 0x2071, 1, 20, 0.1, '', false, 1],
];

describe('params table', () => {
  it('has 42 scalar parameters', () => {
    expect(PARAMS.length).toBe(42);
    expect(EXPECTED).toHaveLength(42);
  });

  it('uses unique ids and unique addresses', () => {
    const ids = PARAMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const addrs = PARAMS.map((item) => item.addr);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it('splits modules as specified', () => {
    expect(paramsOf('gain')).toHaveLength(5);
    expect(paramsOf('enc')).toHaveLength(2);
    expect(paramsOf('eq')).toHaveLength(1);
    expect(paramsOf('comp')).toHaveLength(7);
    expect(paramsOf('limit')).toHaveLength(4);
    expect(paramsOf('noisegate')).toHaveLength(6);
    expect(paramsOf('drc3')).toHaveLength(17);
    expect(paramsOf('gain').map((item) => item.id)).toEqual([
      'gain.Mic',
      'gain.Hp',
      'mic.mute',
      'mic.sigMute',
      'hp.OnOff',
    ]);
  });

  it('matches the design table row by row', () => {
    for (const [id, addr, min, max, step, unit, readonly, def] of EXPECTED) {
      const spec = findParam(id);
      expect(spec, `missing ${id}`).toBeDefined();
      if (!spec) continue;
      expect(spec.addr, `${id} addr`).toBe(addr);
      expect(spec.min, `${id} min`).toBe(min);
      expect(spec.max, `${id} max`).toBe(max);
      expect(spec.step, `${id} step`).toBe(step);
      expect(spec.unit, `${id} unit`).toBe(unit);
      expect(spec.readonly, `${id} readonly`).toBe(readonly);
      expect(spec.default, `${id} default`).toBeCloseTo(def, 6);
      expect(spec.block, `${id} block`).toBe('preset');
      expect(spec.field, `${id} field`).toBe(id.slice(id.lastIndexOf('.') + 1));
    }
    expect(EXPECTED.map((row) => row[0]).sort()).toEqual(PARAMS.map((item) => item.id).sort());
  });

  it('derives range and default from the register table instead of restating them', () => {
    for (const spec of PARAMS) {
      const register = findRegister(spec.addr);
      expect(register, `missing register for ${spec.id}`).toBeDefined();
      if (!register) continue;
      expect(spec.min).toBe(register.min);
      expect(spec.max).toBe(register.max);
      expect(spec.step).toBe(register.step);
      expect(spec.unit).toBe(register.unit);
      expect(spec.scale).toEqual(register.scale);
      expect(spec.readonly).toBe(register.access === 'r');
    }
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

  it('marks only mic and headphone volume as readonly', () => {
    const readonly = PARAMS.filter((item) => item.readonly).map((item) => item.id);
    expect(readonly.sort()).toEqual(['gain.Hp', 'gain.Mic']);
  });

  it('resolves specs by id and by address', () => {
    const spec = findParam('noisegate.threshold_db');
    expect(spec?.min).toBe(-91);
    expect(spec?.max).toBe(0);
    expect(spec?.default).toBe(-91);
    expect(findParam('nope')).toBeUndefined();
    expect(findParamByAddr(0x9999)).toBeUndefined();
    for (const item of PARAMS) {
      expect(findParamByAddr(item.addr)).toBe(item);
    }
  });

  it('pins the addresses required by the acceptance list', () => {
    expect(findParam('gain.Mic')?.addr).toBe(0x2023);
    expect(findParam('gain.Mic')?.readonly).toBe(true);
    expect(findParam('gain.Mic')?.unit).toBe('');
    expect(findParam('gain.Hp')?.addr).toBe(0x205a);
    expect(findParam('limit.Enable')?.addr).toBe(0x2051);
    expect(findParam('comp.Enable')?.addr).toBe(0x204a);
  });

  it('carries the calibration of the underlying register', () => {
    expect(findParam('comp.Threshold')?.scale).toEqual({ kind: 'linear', mul: 0.1, add: -60 });
    expect(findParam('noisegate.threshold_db')?.scale).toEqual({ kind: 'linear', mul: 1, add: -91 });
    expect(findParam('drc3.low.preGain')?.scale).toEqual({ kind: 'linear', mul: 0.01, add: 0 });
    expect(findParam('drc3.mid.ratio')?.scale).toEqual({ kind: 'linear', mul: 0.1, add: 0 });
    expect(findParam('gain.Mic')?.scale).toEqual({ kind: 'raw' });
  });
});
