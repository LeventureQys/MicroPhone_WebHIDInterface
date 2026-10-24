import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findParam, type ParamSpec } from '../../src/renderer/src/domain/params';
import {
  macroSlider,
  paramSlider,
  segmented,
  setSegmentedValue,
  setSliderValue,
  switchControl,
  setSwitchChecked,
} from '../../src/renderer/src/ui/controls';

function spec(id: string): ParamSpec {
  const found = findParam(id);
  if (!found) throw new Error(`unknown parameter ${id}`);
  return found;
}

describe('parameter controls', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('maps the normalized travel back to a quantized parameter value', () => {
    const item = spec('comp.Attack');
    const onInput = vi.fn();
    const node = paramSlider(item, { value: item.default, onInput });
    const range = node.querySelector<HTMLInputElement>('.pfield-range')!;
    expect(range.max).toBe('1000');

    range.value = '500';
    range.dispatchEvent(new Event('input'));
    // 对数轴中点 = 几何中点 sqrt(0.0001 * 0.2) ≈ 0.00447，量化后 0.0045
    expect(onInput).toHaveBeenCalledWith(0.0045);
    expect(node.querySelector<HTMLInputElement>('.pfield-number')!.value).toBe('0.0045');
  });

  it('restores the current value when the number input is not a number', () => {
    const item = spec('comp.Attack');
    const node = paramSlider(item, { value: 0.0005, onInput: vi.fn() });
    const number = node.querySelector<HTMLInputElement>('.pfield-number')!;
    number.value = 'not-a-number';
    number.dispatchEvent(new Event('change'));
    expect(number.value).toBe('0.0005');
  });

  it('double-clicking the slider restores the protocol default', () => {
    const item = spec('noisegate.attack_ms');
    const onInput = vi.fn();
    const node = paramSlider(item, { value: 200, onInput });
    const range = node.querySelector<HTMLInputElement>('.pfield-range')!;
    range.dispatchEvent(new Event('dblclick'));
    expect(onInput).toHaveBeenCalledWith(item.default);
  });

  it('syncs an externally changed value without firing onInput', () => {
    const item = spec('drc3.fc1');
    const onInput = vi.fn();
    const node = paramSlider(item, { value: 1000, onInput });
    setSliderValue(node, item, 3000);
    expect(onInput).not.toHaveBeenCalled();
    expect(node.querySelector<HTMLInputElement>('.pfield-number')!.value).toBe('3000');
    expect(Number(node.querySelector<HTMLInputElement>('.pfield-range')!.value)).toBeGreaterThan(500);
  });

  it('reflects external switch and segmented state', () => {
    const toggle = switchControl({ checked: false, label: 'x', onChange: () => {} });
    setSwitchChecked(toggle, true);
    expect(toggle.querySelector<HTMLInputElement>('input')!.checked).toBe(true);

    const group = segmented<number>({
      options: [0, 1, 2, 3].map((value) => ({ value, label: String(value) })),
      value: 1,
      onChange: () => {},
    });
    setSegmentedValue(group, 3);
    expect(group.querySelector('.seg-btn[data-value="3"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(group.querySelector('.seg-btn[data-value="1"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('drives the business knob through the macro slider', () => {
    const onChange = vi.fn();
    const macro = macroSlider({
      label: '降噪强度',
      value: 40,
      hint: '0 为关闭',
      onChange,
    });
    const range = macro.root.querySelector<HTMLInputElement>('.macro-range')!;
    expect(range.value).toBe('40');
    expect(macro.root.querySelector('.pfield-value')!.textContent).toBe('40');

    range.value = '72';
    range.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith(72);
    expect(macro.root.querySelector('.pfield-value')!.textContent).toBe('72');

    macro.setValue(15);
    expect(range.value).toBe('15');
    expect(macro.root.querySelector('.pfield-value')!.textContent).toBe('15');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
