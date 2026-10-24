/**
 * 固件升级抽屉（设计 §5.13.4）：文件 → 预检 → 不可取消确认 → 进度 → 结果/出口。
 *
 * 只画 `FirmwareState`，不发帧、不判断能不能升级；所有判定在 `FirmwareController`。
 * 文案全部走 `t()`，阶段名用会话发来的 `fw.phase.*` 键。
 */
import type { FirmwareState } from '../../device/dfu/controller';
import { CLOSE_BLOCKED_DETAIL } from '../../device/dfu/controller';
import type { DfuError } from '../../device/dfu/session';
import { t } from '../../i18n';
import { card, switchControl } from '../controls';

/** 视图只依赖这几个方法（`FirmwareController` 满足它，单测可传假实现） */
export interface FirmwareSource {
  state(): FirmwareState;
  onChange(cb: (state: FirmwareState) => void): () => void;
  selectFile(file: File): Promise<{ readonly ok: true; readonly blocks: number } | { readonly ok: false; readonly message: string }>;
  setConfirmed(confirmed: boolean): void;
  start(): Promise<void>;
  replugAndRetry(): Promise<void>;
}

export interface FirmwareViewDeps {
  readonly controller: FirmwareSource;
  /** 关闭抽屉（由 shell 提供）；缺省时"关闭"按钮只隐藏结果区 */
  readonly onClose?: () => void;
}

const ACCENT = '#f0a65b';
const RUNNING_PHASES = new Set(['entering', 'probing', 'writing', 'settling', 'verifying']);
const EXIT_PHASES = new Set(['failed', 'aborted']);

function hex2(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

function versionText(version: { readonly x: number; readonly y: number; readonly z: number }): string {
  return `${version.x}.${version.y}.${version.z}`;
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function infoRow(label: string, field: string): { row: HTMLElement; value: HTMLElement } {
  const row = document.createElement('div');
  row.className = 'pfield';
  const head = document.createElement('div');
  head.className = 'pfield-head';
  head.append(text('span', 'pfield-label', label));
  const value = text('span', 'pfield-value', '—');
  value.dataset.field = field;
  head.append(value);
  row.append(head);
  return { row, value };
}

function button(label: string, variant: 'primary' | 'ghost', className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `btn ${variant === 'primary' ? 'btn--primary' : 'btn--ghost'} ${className}`;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

export function createFirmwareView(deps: FirmwareViewDeps): HTMLElement {
  const controller = deps.controller;
  const root = document.createElement('div');
  root.className = 'device-main fw-view';

  const shell = card({
    eyebrow: 'DFU',
    title: t('fw.flow'),
    tag: 'FLASH',
  });
  const body = shell.body;

  body.append(text('p', 'card-desc fw-warn', t('fw.warn.stuck')));

  // -- 文件 ---------------------------------------------------------------
  const fileRow = document.createElement('div');
  fileRow.className = 'pfield';
  const fileHead = document.createElement('div');
  fileHead.className = 'pfield-head';
  fileHead.append(text('span', 'pfield-label', t('fw.file.pick')));
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.bin';
  fileInput.className = 'device-input fw-file';
  const fileName = text('span', 'pfield-value fw-file-name', t('fw.file.none'));
  const fileSize = text('p', 'device-hint fw-file-size', '');
  fileRow.append(fileHead, fileInput, fileName, fileSize);

  // -- 预检摘要 -----------------------------------------------------------
  const infoBox = document.createElement('div');
  infoBox.className = 'fw-info';
  infoBox.hidden = true;
  const rows = {
    model: infoRow(t('fw.info.model'), 'model'),
    modelName: infoRow(t('fw.info.modelName'), 'modelName'),
    version: infoRow(t('fw.info.version'), 'version'),
    length: infoRow(t('fw.info.length'), 'length'),
    blocks: infoRow(t('fw.info.blocks'), 'blocks'),
    checksum: infoRow(t('fw.info.checksum'), 'checksum'),
  };
  infoBox.append(
    rows.model.row,
    rows.modelName.row,
    rows.version.row,
    rows.length.row,
    rows.blocks.row,
    rows.checksum.row,
  );

  // -- 确认与开始 ---------------------------------------------------------
  const confirm = switchControl({
    checked: false,
    label: t('fw.confirm.check'),
    onChange: (value) => controller.setConfirmed(value),
  });
  confirm.classList.add('fw-confirm');
  const startBtn = button(t('fw.start'), 'primary', 'fw-start', () => {
    void controller.start().catch(() => undefined);
  });
  startBtn.disabled = true;
  const startRow = document.createElement('div');
  startRow.className = 'device-actions fw-actions';
  startRow.append(startBtn);

  // -- 进度 ---------------------------------------------------------------
  const progressBox = document.createElement('div');
  progressBox.className = 'fw-progress';
  progressBox.hidden = true;
  const phaseText = text('p', 'fw-phase', '');
  const blockText = text('p', 'fw-block', '');
  const percentText = text('span', 'pfield-value fw-percent', '');
  const bar = document.createElement('progress');
  bar.className = 'fw-bar';
  bar.max = 100;
  bar.value = 0;
  // 组件样式表不在本任务的改动范围，进度条只调这两处内联样式
  bar.style.width = '100%';
  bar.style.accentColor = ACCENT;
  const progressHead = document.createElement('div');
  progressHead.className = 'pfield-head';
  progressHead.append(phaseText, percentText);
  progressBox.append(progressHead, bar, blockText);

  // -- 结果 ---------------------------------------------------------------
  const resultBox = document.createElement('div');
  resultBox.className = 'fw-result';
  resultBox.hidden = true;
  const doneText = text('p', 'card-desc fw-done', '');

  // -- 错误 ---------------------------------------------------------------
  const errorBox = document.createElement('div');
  errorBox.className = 'device-error fw-error';
  errorBox.hidden = true;
  const errorTitle = text('p', 'device-error-title fw-error-title', '');
  const errorDetail = text('p', 'device-error-detail fw-error-detail', '');
  errorBox.append(errorTitle, errorDetail);

  // -- 出口 ---------------------------------------------------------------
  const exitRow = document.createElement('div');
  exitRow.className = 'device-actions fw-exit';
  const retryBtn = button(t('fw.retry'), 'primary', 'fw-retry', () => {
    void controller.start().catch(() => undefined);
  });
  const replugBtn = button(t('fw.replug'), 'ghost', 'fw-replug', () => {
    void controller.replugAndRetry().catch(() => undefined);
  });
  const closeBtn = button(t('fw.close'), 'ghost', 'fw-close', () => deps.onClose?.());
  exitRow.append(retryBtn, replugBtn, closeBtn);
  resultBox.append(doneText);

  body.append(fileRow, infoBox, confirm, startRow, progressBox, resultBox, errorBox, exitRow);
  root.append(shell.root);

  // -- 本地状态 -----------------------------------------------------------

  /** selectFile 直接返回的文案键（Bootld / 未连设备 / 包不合法），优先于 state.error */
  let selectionMessage: string | null = null;
  let selectionSize: number | null = null;
  let selectionBlocks: number | null = null;

  function errorKey(error: DfuError): string {
    if (error.detail === CLOSE_BLOCKED_DETAIL) return 'fw.error.closeBlocked';
    if (error.kind === 'statusCode' && error.status !== undefined) return 'fw.error.statusCode';
    return `fw.error.${error.kind}`;
  }

  function errorVars(error: DfuError): Record<string, string | number> | undefined {
    if (error.kind === 'statusCode' && error.status !== undefined) return { status: hex2(error.status) };
    return undefined;
  }

  function errorTitleText(state: FirmwareState): string | null {
    if (selectionMessage !== null) return t(selectionMessage);
    const error = state.error;
    if (error === null) return null;
    return t(errorKey(error), errorVars(error));
  }

  function renderFile(state: FirmwareState): void {
    fileName.textContent = state.fileName ?? t('fw.file.none');
    fileSize.textContent = selectionSize === null ? '' : t('fw.file.size', { size: selectionSize });
    fileInput.disabled = RUNNING_PHASES.has(state.phase);
  }

  function renderInfo(state: FirmwareState): void {
    const info = state.info;
    infoBox.hidden = info === null;
    if (info === null) return;
    const blocks = state.progress?.blockTotal ?? selectionBlocks;
    rows.model.value.textContent = info.modelCode;
    rows.modelName.value.textContent = info.modelName === '' ? t('diag.device.none') : info.modelName;
    rows.version.value.textContent = versionText(info.version);
    rows.length.value.textContent = `${info.length} B`;
    rows.blocks.value.textContent = blocks === null || blocks === undefined ? '—' : String(blocks);
    rows.checksum.value.textContent = `0x${(info.checksum >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  }

  function renderControls(state: FirmwareState): void {
    const running = RUNNING_PHASES.has(state.phase);
    startBtn.disabled = !(state.info !== null && state.confirmed && !running);
    const input = confirm.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (input !== null) {
      input.disabled = running;
      // 控制器可能在别处改 confirmed（重试时自动置 true），开关要跟着状态走
      if (input.checked !== state.confirmed) input.checked = state.confirmed;
    }
    retryBtn.hidden = !EXIT_PHASES.has(state.phase);
    replugBtn.hidden = !EXIT_PHASES.has(state.phase);
    // 收尾期正在等设备重启：这时候关掉抽屉会让人以为升级结束了（§4.4）
    closeBtn.disabled = state.phase === 'settling';
  }

  function renderProgress(state: FirmwareState): void {
    const progress = state.progress;
    const visible = progress !== null && (RUNNING_PHASES.has(state.phase) || state.phase === 'done');
    progressBox.hidden = !visible;
    if (progress === null) return;
    phaseText.textContent = t(`fw.phase.${state.phase}`);
    percentText.textContent = t('fw.percent', { percent: progress.percent });
    blockText.textContent = t('fw.block', {
      index: Math.min(progress.blockIndex + 1, Math.max(progress.blockTotal, 1)),
      total: progress.blockTotal,
    });
    bar.value = progress.percent;
  }

  function renderResult(state: FirmwareState): void {
    const done = state.phase === 'done';
    resultBox.hidden = !done;
    if (!done) return;
    const version = state.info === null ? '' : versionText(state.info.version);
    doneText.textContent = t('fw.done.version', { version });
  }

  function renderError(state: FirmwareState): void {
    const title = errorTitleText(state);
    errorBox.hidden = title === null;
    errorTitle.textContent = title ?? '';
    const error = state.error;
    const detail =
      selectionMessage === null && error !== null && error.detail !== undefined && error.detail !== CLOSE_BLOCKED_DETAIL
        ? error.detail
        : '';
    errorDetail.textContent = detail;
  }

  function render(): void {
    const state = controller.state();
    renderFile(state);
    renderInfo(state);
    renderControls(state);
    renderProgress(state);
    renderResult(state);
    renderError(state);
  }

  // -- 交互 ---------------------------------------------------------------

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    selectionMessage = null;
    selectionSize = file.size;
    void controller.selectFile(file).then((result) => {
      if (result.ok) selectionBlocks = result.blocks;
      else selectionMessage = result.message;
      render();
    });
  });

  const off = controller.onChange(() => render());
  render();

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    off();
  };

  return root;
}
