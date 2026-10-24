import type { ParamSpec } from '../domain/params';
import { fromSliderPosition, scaleOf, SLIDER_STEPS, toSliderPosition } from '../domain/slider-scale';
import { formatValue, parseInput, quantize } from '../domain/values';
import { t } from '../i18n';

function unitText(spec: ParamSpec): string {
  return spec.unit ? t(`common.unit.${spec.unit}`) : '';
}

function labelText(spec: ParamSpec): string {
  return t(`param.${spec.id}.label`);
}

function valueText(spec: ParamSpec, value: number): string {
  return formatValue(spec, value);
}

export function paramSlider(
  spec: ParamSpec,
  opts: { value: number; onInput: (value: number) => void },
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pfield';
  root.dataset.param = spec.id;

  const head = document.createElement('div');
  head.className = 'pfield-head';

  const label = document.createElement('span');
  label.className = 'pfield-label';
  label.textContent = labelText(spec);

  const unit = document.createElement('span');
  unit.className = 'pfield-unit';
  unit.textContent = unitText(spec);

  const readout = document.createElement('span');
  readout.className = 'pfield-value';
  readout.textContent = valueText(spec, opts.value);

  head.append(label, unit, readout);

  const body = document.createElement('div');
  body.className = 'pfield-body';

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'pfield-range';
  range.dataset.scale = scaleOf(spec);
  range.setAttribute('aria-label', labelText(spec));
  range.min = '0';
  range.max = String(SLIDER_STEPS);
  range.step = '1';
  range.value = String(toSliderPosition(spec, opts.value));

  const number = document.createElement('input');
  number.type = 'number';
  number.className = 'pfield-number';
  number.min = String(spec.min);
  number.max = String(spec.max);
  number.step = String(spec.step);
  number.value = valueText(spec, opts.value);

  const commit = (raw: number): void => {
    const next = quantize(spec, raw);
    range.value = String(toSliderPosition(spec, next));
    number.value = valueText(spec, next);
    readout.textContent = valueText(spec, next);
    opts.onInput(next);
  };

  range.addEventListener('input', () => {
    commit(fromSliderPosition(spec, Number(range.value)));
  });

  const commitText = (): void => {
    const parsed = parseInput(spec, number.value);
    if (parsed === null) {
      // range.value 是归一化行程，回填前要换算回参数值
      const current = quantize(spec, fromSliderPosition(spec, Number(range.value)));
      number.value = valueText(spec, current);
      return;
    }
    commit(parsed);
  };

  number.addEventListener('change', commitText);
  number.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitText();
    }
  });

  const resetToDefault = (): void => commit(spec.default);
  range.addEventListener('dblclick', resetToDefault);

  body.append(range, number);
  root.append(head, body);
  return root;
}

export function readonlyField(spec: ParamSpec, value: number): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pfield pfield--readonly';
  root.dataset.param = spec.id;

  const head = document.createElement('div');
  head.className = 'pfield-head';

  const label = document.createElement('span');
  label.className = 'pfield-label';
  label.textContent = labelText(spec);

  const badge = document.createElement('span');
  badge.className = 'pfield-badge';
  badge.textContent = t('common.readonly');

  head.append(label, badge);

  const readout = document.createElement('div');
  readout.className = 'pfield-readout';

  const strong = document.createElement('strong');
  strong.textContent = valueText(spec, value);

  const unit = document.createElement('span');
  unit.className = 'pfield-unit';
  unit.textContent = unitText(spec);

  readout.append(strong, unit);
  root.append(head, readout);
  return root;
}

export function switchControl(opts: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}): HTMLElement {
  const root = document.createElement('label');
  root.className = 'switch-row';

  const label = document.createElement('span');
  label.className = 'switch-label';
  label.textContent = opts.label;

  const shell = document.createElement('span');
  shell.className = 'switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = opts.checked;
  input.addEventListener('change', () => opts.onChange(input.checked));

  const track = document.createElement('span');
  track.className = 'switch-track';

  shell.append(input, track);
  root.append(label, shell);
  return root;
}

export function segmented<T extends string | number>(opts: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}): HTMLElement {
  const root = document.createElement('div');
  root.className = 'segmented';
  root.setAttribute('role', 'group');

  let current = opts.value;

  const buttons = opts.options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seg-btn';
    button.dataset.value = String(option.value);
    button.textContent = option.label;
    const active = option.value === current;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      if (option.value === current) return;
      current = option.value;
      setSegmentedValue(root, current);
      opts.onChange(option.value);
    });
    return button;
  });

  root.append(...buttons);
  return root;
}

export interface MacroSliderHandle {
  root: HTMLElement;
  setValue: (value: number) => void;
}

/**
 * 简易模式的业务旋钮：只有一个 0..100 的滑杆和一句人话说明，
 * 不暴露单位、协议字段名与数字输入框。
 */
export function macroSlider(opts: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  format?: (value: number) => string;
  scale?: [string, string];
  hint?: string;
  onChange: (value: number) => void;
}): MacroSliderHandle {
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const format = opts.format ?? ((value: number): string => String(Math.round(value)));

  const root = document.createElement('div');
  root.className = 'pfield pfield--macro';

  const head = document.createElement('div');
  head.className = 'pfield-head';
  const label = document.createElement('span');
  label.className = 'pfield-label';
  label.textContent = opts.label;
  const readout = document.createElement('span');
  readout.className = 'pfield-value pfield-value--macro';
  readout.textContent = format(opts.value);
  head.append(label, readout);

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'pfield-range macro-range';
  range.min = String(min);
  range.max = String(max);
  range.step = '1';
  range.value = String(opts.value);
  range.setAttribute('aria-label', opts.label);

  root.append(head, range);

  if (opts.scale) {
    const scale = document.createElement('div');
    scale.className = 'macro-scale';
    const left = document.createElement('span');
    left.textContent = opts.scale[0];
    const right = document.createElement('span');
    right.textContent = opts.scale[1];
    scale.append(left, right);
    root.append(scale);
  }

  if (opts.hint) {
    const hint = document.createElement('p');
    hint.className = 'macro-hint';
    hint.textContent = opts.hint;
    root.append(hint);
  }

  const setValue = (value: number): void => {
    const next = Math.min(max, Math.max(min, Math.round(value)));
    if (range.value !== String(next)) range.value = String(next);
    readout.textContent = format(next);
  };

  range.addEventListener('input', () => {
    const value = Number(range.value);
    readout.textContent = format(value);
    opts.onChange(value);
  });

  return { root, setValue };
}

export function card(opts: {
  eyebrow: string;
  title: string;
  tag?: string;
  desc?: string;
}): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement('section');
  root.className = 'card';

  const head = document.createElement('header');
  head.className = 'card-head';

  const textBox = document.createElement('div');
  textBox.className = 'card-heading';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = opts.eyebrow;

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = opts.title;

  textBox.append(eyebrow, title);

  if (opts.desc) {
    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = opts.desc;
    textBox.append(desc);
  }

  head.append(textBox);

  if (opts.tag) {
    const tag = document.createElement('span');
    tag.className = 'card-tag';
    tag.textContent = opts.tag;
    head.append(tag);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  root.append(head, body);
  return { root, body };
}

export function setSliderValue(root: HTMLElement, spec: ParamSpec, value: number): void {
  const range = root.querySelector<HTMLInputElement>('.pfield-range');
  const number = root.querySelector<HTMLInputElement>('.pfield-number');
  const readout = root.querySelector<HTMLElement>('.pfield-value');
  const position = String(toSliderPosition(spec, value));
  if (range && range.value !== position) range.value = position;
  if (number) number.value = valueText(spec, value);
  if (readout) readout.textContent = valueText(spec, value);
}

/** 外部状态变化时回填开关（复位默认值等场景），不触发 onChange */
export function setSwitchChecked(root: HTMLElement, checked: boolean): void {
  const input = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (input && input.checked !== checked) input.checked = checked;
}

/** 外部状态变化时回填分段选择，不触发 onChange */
export function setSegmentedValue(root: HTMLElement, value: string | number): void {
  const target = String(value);
  for (const button of root.querySelectorAll<HTMLButtonElement>('.seg-btn')) {
    const active = button.dataset.value === target;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}
