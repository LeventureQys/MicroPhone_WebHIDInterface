import { describe, expect, it } from 'vitest';
import { findParam, type ParamSpec } from '../../src/renderer/src/domain/params';
import {
  fromSliderPosition,
  scaleOf,
  SLIDER_STEPS,
  toSliderPosition,
} from '../../src/renderer/src/domain/slider-scale';
import { quantize } from '../../src/renderer/src/domain/values';

function spec(id: string): ParamSpec {
  const found = findParam(id);
  if (!found) throw new Error(`unknown parameter ${id}`);
  return found;
}

describe('slider scale', () => {
  it('uses a log axis only for wide-range time/frequency parameters', () => {
    expect(scaleOf(spec('comp.Attack'))).toBe('log');
    expect(scaleOf(spec('limit.Release'))).toBe('log');
    expect(scaleOf(spec('noisegate.attack_ms'))).toBe('log');
    expect(scaleOf(spec('drc3.fc1'))).toBe('log');
    expect(scaleOf(spec('drc3.high.attackTime'))).toBe('log');
    expect(scaleOf(spec('noisegate.threshold_db'))).toBe('linear');
    expect(scaleOf(spec('comp.Threshold'))).toBe('linear');
    expect(scaleOf(spec('drc3.low.preGain'))).toBe('linear');
  });

  it('maps the endpoints of both scales to the full travel', () => {
    for (const id of ['noisegate.threshold_db', 'comp.Attack', 'drc3.fc1']) {
      const item = spec(id);
      expect(toSliderPosition(item, item.min)).toBe(0);
      expect(toSliderPosition(item, item.max)).toBe(SLIDER_STEPS);
      expect(fromSliderPosition(item, 0)).toBeCloseTo(item.min, 6);
      expect(fromSliderPosition(item, SLIDER_STEPS)).toBeCloseTo(item.max, 6);
    }
  });

  it('keeps the linear midpoint at the arithmetic center', () => {
    const item = spec('noisegate.threshold_db');
    expect(fromSliderPosition(item, SLIDER_STEPS / 2)).toBeCloseTo(-45.5, 6);
  });

  it('puts the logarithmic midpoint at the geometric center', () => {
    const item = spec('comp.Attack');
    const middle = fromSliderPosition(item, SLIDER_STEPS / 2);
    expect(middle).toBeCloseTo(Math.sqrt(item.min * item.max), 10);
  });

  it('gives low defaults a usable share of travel', () => {
    // 线性轴下 0.0005 只占 Comp.Attack 全程的 0.2%，手柄会贴在最左端
    expect(toSliderPosition(spec('comp.Attack'), 0.0005)).toBeGreaterThan(150);
    expect(toSliderPosition(spec('limit.Attack'), 0.0005)).toBeGreaterThan(150);
    expect(toSliderPosition(spec('noisegate.attack_ms'), 10)).toBeGreaterThan(100);
    expect(toSliderPosition(spec('drc3.fc1'), 1000)).toBeGreaterThan(400);
  });

  it('round-trips stably through quantization', () => {
    for (const id of ['comp.Attack', 'noisegate.attack_ms', 'drc3.fc1', 'comp.Threshold']) {
      const item = spec(id);
      for (const position of [0, 125, 300, 500, 750, 950, SLIDER_STEPS]) {
        const value = quantize(item, fromSliderPosition(item, position));
        const back = toSliderPosition(item, value);
        // 步进在轴底端可能比单个行程更粗（如 comp.Attack 的 0.0001 s），
        // 因此只要求再映射回来仍落在同一个量化值上，且不跑出整个行程
        const again = quantize(item, fromSliderPosition(item, back));
        expect(again).toBeCloseTo(value, 6);
        expect(Math.abs(back - position)).toBeLessThanOrEqual(25);
      }
    }
  });

  it('clamps positions outside the travel', () => {
    const item = spec('comp.Release');
    expect(fromSliderPosition(item, -100)).toBeCloseTo(item.min, 6);
    expect(fromSliderPosition(item, 5000)).toBeCloseTo(item.max, 6);
    expect(toSliderPosition(item, 0)).toBe(0);
    expect(toSliderPosition(item, 10)).toBe(SLIDER_STEPS);
  });
});
