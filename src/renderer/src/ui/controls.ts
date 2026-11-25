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

/**
 * 滑杆已走过的那段轨道用 CSS 变量 `--fill` 着色：原生 range 在 Chromium 里没有
 * "已填充"伪元素，每次值变化（拖动 / 外部回填）都要重算一次。
 */
export function paintRange(range: HTMLInputElement): void {
  const min = Number(range.min || 0);
  const max = Number(range.max || 100);
  const value = Number(range.value);
  const ratio = max > min && Number.isFinite(value) ? (value - min) / (max - min) : 0;
  range.style.setProperty('--fill', `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(2)}%`);
}

export interface ResetControlOptions {
  /** 点击“恢复”时执行的动作 */
  onClick: () => void;
  /** 当前值已经是目标值时禁用按钮 */
  disabled?: boolean;
  /** 覆盖按钮文案；默认使用统一的“恢复” */
  label?: string;
}

/** 参数控件共用的轻量恢复按钮，避免每个视图重复拼 DOM 和无障碍属性。 */
export function resetControl(opts: ResetControlOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'param-reset';
  button.dataset.reset = 'true';
  button.textContent = opts.label ?? t('common.restore');
  button.title = t('common.restoreHint');
  button.setAttribute('aria-label', button.title);
  button.disabled = opts.disabled ?? false;
  button.setAttribute('aria-disabled', String(button.disabled));
  // switchControl 的根节点是 label，按钮嵌在 label 内时必须阻止默认激活，
  // 否则点击“恢复”会先恢复又切换一次开关。
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    opts.onClick();
  });
  return button;
}

/** 外部状态回填时同步恢复按钮的可用状态。 */
export function setResetDisabled(root: HTMLElement, disabled: boolean, resetParam?: string): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.param-reset'));
  const button = resetParam
    ? buttons.find((candidate) => candidate.dataset.resetParam === resetParam)
    : buttons[0];
  if (!button) return;
  button.disabled = disabled;
  button.setAttribute('aria-disabled', String(disabled));
}

export function paramSlider(
  spec: ParamSpec,
  opts: { value: number; onInput: (value: number) => void; reset?: ResetControlOptions },
): HTMLElement {
  const root = document.createElement('div');
  // pfield--slider：标签 + 数字框一行、滑杆一行（布局见 components.css）
  root.className = 'pfield pfield--slider';
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

  head.append(label, unit);
  if (opts.reset) {
    const reset = resetControl(opts.reset);
    reset.dataset.resetParam = spec.id;
    head.append(reset);
  }
  head.append(readout);

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
  paintRange(range);

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
    paintRange(range);
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
  /** 可见文案；省略时只画开关本体（放进滑杆标题行那种位置用） */
  label?: string;
  /** 无障碍名：没有可见文案时必须给，否则屏幕阅读器只念"复选框" */
  ariaLabel?: string;
  onChange: (value: boolean) => void;
  reset?: ResetControlOptions;
}): HTMLElement {
  const accessibleName = opts.ariaLabel ?? opts.label;
  const root = document.createElement('label');
  root.className = 'switch-row';
  // 中栏三列布局里长标签会省略号，悬停能看到全称
  if (accessibleName) root.title = accessibleName;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = opts.checked;
  input.addEventListener('change', () => opts.onChange(input.checked));
  if (accessibleName) input.setAttribute('aria-label', accessibleName);

  const track = document.createElement('span');
  track.className = 'switch-track';

  const shell = document.createElement('span');
  shell.className = 'switch';
  shell.append(input, track);

  if (opts.label) {
    const label = document.createElement('span');
    label.className = 'switch-label';
    label.textContent = opts.label;
    root.append(label, shell);
  } else {
    root.classList.add('switch-row--bare');
    root.append(shell);
  }
  if (opts.reset) {
    const reset = resetControl(opts.reset);
    root.append(reset);
  }
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
  /** 同行开关的回填（外部状态变化时用，不触发 onChange） */
  setToggle?: (checked: boolean) => void;
}

/**
 * 简易模式的业务旋钮：只有一个 0..100 的滑杆和一句人话说明，
 * 不暴露单位、协议字段名与数字输入框。
 *
 * `toggle` 把模块开关放到标题行右侧（2026-11-21 需求：快速调音的每个阈值都要带开关，
 * 且与高级参数里同一参数联动）。
 */
export function macroSlider(opts: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  scale?: [string, string];
  hint?: string;
  onChange: (value: number) => void;
  reset?: ResetControlOptions;
  toggle?: {
    checked: boolean;
    label: string;
    onChange: (checked: boolean) => void;
    reset?: ResetControlOptions;
  };
}): MacroSliderHandle {
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const step = opts.step && opts.step > 0 ? opts.step : 1;
  const format = opts.format ?? ((value: number): string => String(Math.round(value)));

  const snap = (value: number): number => {
    const clamped = Math.min(max, Math.max(min, value));
    const steps = Math.round((clamped - min) / step);
    return Math.min(max, Math.max(min, Number((min + steps * step).toFixed(6))));
  };

  const root = document.createElement('div');
  root.className = 'pfield pfield--macro';

  const head = document.createElement('div');
  head.className = 'pfield-head';
  const label = document.createElement('span');
  label.className = 'pfield-label';
  label.textContent = opts.label;
  const readout = document.createElement('span');
  readout.className = 'pfield-value pfield-value--macro';
  readout.textContent = format(snap(opts.value));
  head.append(label, readout);

  let toggle: HTMLElement | null = null;
  let setToggle: ((checked: boolean) => void) | undefined;
  if (opts.toggle) {
    const spec = opts.toggle;
    toggle = switchControl({
      checked: spec.checked,
      ariaLabel: spec.label,
      onChange: (checked) => spec.onChange(checked),
      reset: spec.reset,
    });
    toggle.classList.add('macro-toggle');
    // 标题行里开关紧贴读数：读数原本靠 margin-left:auto 顶到右边，有开关时让开关顶
    head.insertBefore(toggle, readout);
    root.classList.add('pfield--toggle');
    setToggle = (checked: boolean) => setSwitchChecked(toggle as HTMLElement, checked);
  }

  if (opts.reset) head.append(resetControl(opts.reset));

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'pfield-range macro-range';
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(snap(opts.value));
  range.setAttribute('aria-label', opts.label);
  paintRange(range);

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
    const next = snap(value);
    if (range.value !== String(next)) range.value = String(next);
    paintRange(range);
    readout.textContent = format(next);
  };

  range.addEventListener('input', () => {
    const value = snap(Number(range.value));
    paintRange(range);
    readout.textContent = format(value);
    opts.onChange(value);
  });

  return { root, setValue, setToggle };
}

export function card(opts: {
  /** 小标题；空串不渲染（抽屉与工作台的卡片都不再用等宽大写小标） */
  eyebrow?: string;
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

  if (opts.eyebrow) {
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = opts.eyebrow;
    textBox.append(eyebrow);
  }

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = opts.title;

  textBox.append(title);

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
  if (range) paintRange(range);
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
