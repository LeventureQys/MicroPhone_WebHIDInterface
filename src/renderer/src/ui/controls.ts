import type { ParamSpec } from '../domain/params';
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
  range.min = String(spec.min);
  range.max = String(spec.max);
  range.step = String(spec.step);
  range.value = String(opts.value);

  const number = document.createElement('input');
  number.type = 'number';
  number.className = 'pfield-number';
  number.min = String(spec.min);
  number.max = String(spec.max);
  number.step = String(spec.step);
  number.value = valueText(spec, opts.value);

  const commit = (raw: number): void => {
    const next = quantize(spec, raw);
    range.value = String(next);
    number.value = valueText(spec, next);
    readout.textContent = valueText(spec, next);
    opts.onInput(next);
  };

  range.addEventListener('input', () => {
    commit(Number(range.value));
  });

  const commitText = (): void => {
    const parsed = parseInput(spec, number.value);
    if (parsed === null) {
      number.value = valueText(spec, Number(range.value));
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
    if (option.value === current) button.classList.add('is-active');
    button.addEventListener('click', () => {
      if (option.value === current) return;
      current = option.value;
      for (const item of buttons) {
        item.classList.toggle('is-active', item.dataset.value === String(current));
      }
      opts.onChange(option.value);
    });
    return button;
  });

  root.append(...buttons);
  return root;
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
  if (range && range.value !== String(value)) range.value = String(value);
  if (number) number.value = valueText(spec, value);
  if (readout) readout.textContent = valueText(spec, value);
}
