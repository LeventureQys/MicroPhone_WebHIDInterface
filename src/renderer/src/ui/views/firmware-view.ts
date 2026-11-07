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
import { switchControl } from '../controls';
import { icon } from '../icons';

/** 视图只依赖这几个方法（`FirmwareController` 满足它，单测可传假实现） */
export interface FirmwareSource {
  state(): FirmwareState;
  onChange(cb: (state: FirmwareState) => void): () => void;
  selectFile(file: File): Promise<{ readonly ok: true; readonly blocks: number } | { readonly ok: false; readonly message: string }>;
  setConfirmed(confirmed: boolean): void;
  start(): Promise<void>;
  replugAndRetry(): Promise<void>;
  /** 中止（只在收尾之前有效）；不提供时界面不画中止按钮 */
  abort?(): void;
}

export interface FirmwareViewDeps {
  readonly controller: FirmwareSource;
  /** 关闭抽屉（由 shell 提供）；缺省时"关闭"按钮只隐藏结果区 */
  readonly onClose?: () => void;
}

const RUNNING_PHASES = new Set(['entering', 'probing', 'writing', 'settling', 'verifying']);
/** 可以中止的阶段：`0x05` 之后设备已经在收尾，主机打断它只会更糟 */
const ABORTABLE_PHASES = new Set(['entering', 'probing', 'writing']);
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
  row.className = 'pfield kv';
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

  // 三步：选包 → 核对并确认 → 写入。步骤只是视觉分组，节点与类名保持不变（单测与探针按类名取）
  const step = (index: number, title: string): { root: HTMLElement; body: HTMLElement } => {
    const section = document.createElement('section');
    section.className = 'fw-step';
    const head = document.createElement('header');
    head.className = 'fw-step-head';
    head.append(text('span', 'fw-step-no', String(index)), text('h3', 'fw-step-title', title));
    const stepBody = document.createElement('div');
    stepBody.className = 'fw-step-body';
    section.append(head, stepBody);
    return { root: section, body: stepBody };
  };

  const warn = document.createElement('div');
  warn.className = 'callout callout--warn';
  warn.append(icon('alert', 16), text('p', 'card-desc fw-warn', t('fw.warn.stuck')));

  // -- 文件 ---------------------------------------------------------------
  // 原生 file input 铺满整块拖放区、透明：点击与拖放都走浏览器自己的文件选择，不另写 drop 处理
  const fileRow = document.createElement('label');
  fileRow.className = 'pfield fw-drop';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.bin';
  fileInput.className = 'fw-file';
  fileInput.setAttribute('aria-label', t('fw.file.pick'));
  const dropIcon = icon('upload', 20);
  dropIcon.classList.add('fw-drop-icon');
  const dropText = document.createElement('span');
  dropText.className = 'fw-drop-text';
  const fileName = text('span', 'pfield-value fw-file-name', t('fw.file.none'));
  const fileSize = text('p', 'device-hint fw-file-size', '');
  dropText.append(fileName, text('span', 'fw-drop-hint', t('fw.file.drop')), fileSize);
  fileRow.append(dropIcon, dropText, fileInput);

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
  // 升级卡住时（设备不回执、写块反复超时）用户需要一条退路：中止后走失败收场，
  // 通道会被恢复，不必杀掉整个 app（主进程在升级期间拦关窗）
  const abortBtn = button(t('fw.abort'), 'ghost', 'fw-abort', () => controller.abort?.());
  abortBtn.hidden = true;
  const startRow = document.createElement('div');
  startRow.className = 'device-actions fw-actions';
  startRow.append(startBtn, abortBtn);

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

  const pick = step(1, t('fw.step.pick'));
  pick.body.append(fileRow);
  const check = step(2, t('fw.step.check'));
  check.body.append(infoBox, confirm);
  const flash = step(3, t('fw.step.flash'));
  flash.body.append(startRow, progressBox, resultBox, errorBox, exitRow);
  root.append(warn, pick.root, check.root, flash.root);

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
    abortBtn.hidden = !(controller.abort !== undefined && ABORTABLE_PHASES.has(state.phase));
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
