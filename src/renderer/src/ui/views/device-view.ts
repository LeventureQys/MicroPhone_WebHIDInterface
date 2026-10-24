import { ENTRY_EVENT, STATS_EVENT, type DiagnosticsHub } from '../../device/diagnostics';
import { formatLinkText, type DeviceLink } from '../../device/link';
import type { DeviceSnapshot, DiagEntry, SessionStats } from '../../device/transport';
import { errorKeyOf } from '../../device/webhid/session';
import type { WebHidSession } from '../../device/webhid/session';
import type { WebHidDeviceSummary, WebHidMode, WebHidReportSample, WebHidSessionState } from '../../device/webhid/types';
import { t } from '../../i18n';
import { card, segmented } from '../controls';

const KIT_PATH = 'third_party/web_hid_utils';
/** 报告高频推送时最多 15 fps 重绘，避免每条报告都碰 DOM */
const REPORT_RENDER_MS = 66;
/** 诊断日志只在 DOM 里保留最近 200 条（R8-4：内存与渲染成本），复制导出全量 */
const DIAG_RENDER_LIMIT = 200;
/** 单条日志里 hex 的显示上限（长帧会撑破布局，完整 hex 见复制文本） */
const DIAG_HEX_CHARS = 47;
/** 诊断导出里"设备"行的未连接占位：与 `diagnostics.ts` 的默认值保持一致 */
const UNKNOWN_DEVICE = '未连接';

const MODE_KEY: Record<WebHidMode, string> = {
  virtual: 'device.mode.virtual',
  native: 'device.mode.native',
};

const ZERO_STATS: SessionStats = Object.freeze({
  outFrames: 0,
  inFrames: 0,
  crcErrors: 0,
  timeouts: 0,
  retries: 0,
  droppedPolls: 0,
  queueDepth: 0,
});

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, '0');
}

/** 日志行时间戳（本地时间，贴进问题单时最好对表） */
function clockText(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--.---';
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function fieldRow(label: string, value: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pfield';
  const head = document.createElement('div');
  head.className = 'pfield-head';
  head.append(text('span', 'pfield-label', label), value);
  row.append(head);
  return row;
}

function actionButton(label: string, variant: 'primary' | 'ghost', onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${variant === 'primary' ? 'btn--primary' : 'btn--ghost'}`;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

export interface DeviceViewOptions {
  /**
   * 真机请求要带 usage 过滤：Electron 33 的 `HIDDevice` 不含 collections，
   * 只能在渲染进程 `requestDevice({ filters })` 里过滤（设计 §5.13.5 / R-9）。
   * 传了 link 就由它把白名单翻成 filters；不传退回无过滤的旧行为。
   */
  readonly link?: DeviceLink;
  /** 诊断数据面（B4/B5 的计划：R8）；不传时诊断卡显示空态，不抛错 */
  readonly hub?: DiagnosticsHub;
  /** 「固件升级」按钮：交给 shell 打开固件抽屉（4.2） */
  readonly onOpenFirmware?: () => void;
  /** 「通道设置」按钮：交给 shell 打开设置抽屉（5.1） */
  readonly onOpenSettings?: () => void;
}

/**
 * 设备页：webhid-kit 的界面组件。
 *
 * 只负责把 WebHidSession 的状态画出来，不持设备、不碰 navigator.hid；
 * 视图销毁时退订，会话（连接）由 main.ts 持有，切路由不断线。
 */
export function createDeviceView(session: WebHidSession, options?: DeviceViewOptions): HTMLElement {
  const root = document.createElement('div');
  const layout = document.createElement('div');
  layout.className = 'device-layout';
  const main = document.createElement('div');
  main.className = 'device-main';
  const side = document.createElement('div');
  side.className = 'device-side';

  let mode: WebHidMode = session.getState().mode;

  // -- 连接 -----------------------------------------------------------------

  const connection = card({
    eyebrow: 'WEBHID',
    title: t('device.title'),
    tag: 'LINK',
    desc: t('device.subtitle'),
  });

  const modeRow = document.createElement('div');
  modeRow.className = 'pfield';
  const modeHead = document.createElement('div');
  modeHead.className = 'pfield-head';
  modeHead.append(text('span', 'pfield-label', t('device.mode')));
  const modeControl = segmented<WebHidMode>({
    options: [
      { value: 'virtual', label: t('device.mode.virtual') },
      { value: 'native', label: t('device.mode.native') },
    ],
    value: mode,
    onChange: (next) => {
      mode = next;
      syncTransportField();
      if (session.getState().status === 'ready') void session.disconnect();
      render();
    },
  });
  modeRow.append(modeHead, modeControl);

  const urlRow = document.createElement('div');
  urlRow.className = 'pfield';
  const urlHead = document.createElement('div');
  urlHead.className = 'pfield-head';
  urlHead.append(text('span', 'pfield-label', t('device.bridgeUrl')));
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'device-input';
  urlInput.spellcheck = false;
  urlInput.value = session.getState().bridgeUrl;
  urlInput.addEventListener('change', () => session.setBridgeUrl(urlInput.value));
  const urlHint = text('p', 'device-hint', t('device.bridgeHint'));
  urlRow.append(urlHead, urlInput, urlHint);

  const actions = document.createElement('div');
  actions.className = 'device-actions';
  const connectBtn = actionButton(t('device.connect'), 'primary', () => {
    void session.connect(mode);
  });
  const disconnectBtn = actionButton(t('device.disconnect'), 'ghost', () => {
    void session.disconnect();
  });
  const refreshBtn = actionButton(t('device.refresh'), 'ghost', () => {
    void session.refresh();
  });
  const requestBtn = actionButton(t('device.request'), 'ghost', () => {
    const link = options?.link;
    if (link) void link.requestNativeDevice();
    else void session.requestNativeDevice();
  });
  actions.append(connectBtn, disconnectBtn, refreshBtn, requestBtn);

  const statusValue = text('span', 'pfield-value', t('device.status.idle'));
  const statusRow = fieldRow(t('device.status'), statusValue);

  const errorBox = document.createElement('div');
  errorBox.className = 'device-error';
  errorBox.hidden = true;
  const errorTitle = text('p', 'device-error-title', '');
  const errorDetail = text('p', 'device-error-detail', '');
  errorBox.append(errorTitle, errorDetail);

  connection.body.append(modeRow, urlRow, actions, statusRow, errorBox);

  // -- 入口：固件升级 / 通道设置（4.2 / 5.1）--------------------------------

  const entries = document.createElement('div');
  entries.className = 'device-actions';
  const firmwareBtn = actionButton(t('fw.open'), 'primary', () => options?.onOpenFirmware?.());
  firmwareBtn.classList.add('fw-open');
  const settingsBtn = actionButton(t('settings.channel.title'), 'ghost', () => options?.onOpenSettings?.());
  settingsBtn.classList.add('device-settings-open');
  entries.append(firmwareBtn, settingsBtn);
  connection.body.append(entries);
  // Q4 定案：写入语义要在界面上写死，不然"改了没保存/掉电丢不丢"全靠猜（A42）
  connection.body.append(text('p', 'card-desc device-save-note', t('device.saveNote')));
  // -- 设备列表 --------------------------------------------------------------

  const devices = card({ eyebrow: 'DEVICES', title: t('device.devices'), tag: 'HID' });
  const deviceList = document.createElement('div');
  deviceList.className = 'device-list';
  devices.body.append(deviceList);

  // -- 报告监视 --------------------------------------------------------------

  const reports = card({ eyebrow: 'MONITOR', title: t('device.reports'), tag: 'INPUT' });
  const reportBox = document.createElement('div');
  reportBox.className = 'device-report';
  reports.body.append(reportBox);

  // -- 套件信息 --------------------------------------------------------------

  const kit = card({ eyebrow: 'VENDOR', title: t('device.kit'), tag: 'SUB' });
  const kitRows: Array<[string, string]> = [
    [t('device.kit.version'), session.kitVersion],
    [t('device.kit.protocol'), session.bridgeProtocol],
    [t('device.kit.path'), KIT_PATH],
  ];
  for (const [label, value] of kitRows) {
    const row = document.createElement('div');
    row.className = 'pfield';
    const head = document.createElement('div');
    head.className = 'pfield-head';
    head.append(text('span', 'pfield-label', label), text('span', 'pfield-value', value));
    row.append(head);
    kit.body.append(row);
  }
  kit.body.append(text('p', 'card-desc', t('device.kit.note')));
  kit.body.append(text('p', 'card-desc', t('device.alphaNotice')));

  // -- 诊断（R8：帧日志 / 统计 / 设备摘要 / 自检 / 复制）---------------------
  const diag = createDiagSection(options?.hub, options?.link);

  main.append(devices.root, reports.root, diag.root);
  side.append(connection.root, kit.root);
  layout.append(main, side);
  root.append(layout);

  // -- 渲染 ------------------------------------------------------------------

  function renderStatus(state: WebHidSessionState): void {
    statusValue.textContent = t(`device.status.${state.status}`);
    statusValue.classList.toggle('is-error', state.status === 'error');
    connectBtn.disabled = state.status === 'connecting';
    disconnectBtn.disabled = state.status !== 'ready';
    refreshBtn.disabled = state.status !== 'ready';
    requestBtn.disabled = state.status !== 'ready' || mode !== 'native';
    requestBtn.hidden = mode !== 'native';

    if (state.error && state.errorCode) {
      errorBox.hidden = false;
      errorTitle.textContent = t(errorKeyOf(state.errorCode));
      errorDetail.textContent = state.error;
    } else {
      errorBox.hidden = true;
      errorTitle.textContent = '';
      errorDetail.textContent = '';
    }
  }

  function deviceRow(device: WebHidDeviceSummary): HTMLElement {
    const row = document.createElement('div');
    row.className = 'device-row';

    const box = document.createElement('div');
    box.className = 'device-row-main';
    box.append(text('span', 'device-row-name', device.productName));
    box.append(text('span', 'device-row-id', `VID ${hex(device.vendorId)} · PID ${hex(device.productId)}`));

    const sideBox = document.createElement('div');
    sideBox.className = 'device-row-actions';
    sideBox.append(text('span', `device-badge device-badge--${device.mode}`, t(MODE_KEY[device.mode])));
    if (device.opened) sideBox.append(text('span', 'device-badge device-badge--open', t('device.devices.opened')));
    sideBox.append(
      actionButton(device.opened ? t('device.devices.close') : t('device.devices.open'), 'ghost', () => {
        const link = options?.link;
        // 有 DeviceLink 时开关设备走 link：它负责切参数通道、全量回读与失败降级；
        // 没有 link（单测/旧装配）才退回只开关句柄
        if (link) {
          if (device.opened) void link.detach();
          else void link.attach(device.id);
          return;
        }
        if (device.opened) void session.closeDevice(device.id);
        else void session.openDevice(device.id);
      }),
    );

    row.append(box, sideBox);
    return row;
  }

  function renderDevices(state: WebHidSessionState): void {
    deviceList.replaceChildren();
    if (state.status !== 'ready') {
      deviceList.append(text('p', 'device-empty', t('device.devices.idle')));
      return;
    }
    if (state.devices.length === 0) {
      deviceList.append(text('p', 'device-empty', t('device.devices.empty')));
      return;
    }
    for (const device of state.devices) deviceList.append(deviceRow(device));
  }

  function renderReport(sample: WebHidReportSample | null): void {
    reportBox.replaceChildren();
    if (!sample) {
      reportBox.append(text('p', 'device-empty', t('device.reports.empty')));
      return;
    }

    const head = document.createElement('div');
    head.className = 'device-report-head';
    const bytes = sample.hex.length === 0 ? 0 : sample.hex.split(' ').length;
    head.append(
      text('span', '', `${t('device.reports.latest')} · ID ${sample.reportId}`),
      text('span', '', `${bytes} B`),
    );

    reportBox.append(head, text('p', 'device-hex', sample.hex || '—'));

    const entries = Object.entries(sample.values);
    if (entries.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'device-fields';
      for (const [key, value] of entries.slice(0, 16)) {
        const cell = document.createElement('div');
        cell.className = 'device-field';
        cell.append(text('span', 'device-field-key', key), text('span', 'device-field-value', String(value)));
        grid.append(cell);
      }
      reportBox.append(grid);
    }
  }

  function syncTransportField(): void {
    urlInput.disabled = mode === 'native';
    urlHint.textContent = mode === 'native' ? t('device.nativeHint') : t('device.bridgeHint');
  }

  function render(): void {
    const state = session.getState();
    renderStatus(state);
    renderDevices(state);
    renderReport(state.lastReport);
  }

  // -- 订阅 ------------------------------------------------------------------

  let reportTimer: ReturnType<typeof setTimeout> | null = null;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReport = (): void => {
    if (reportTimer !== null) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      renderReport(session.getState().lastReport);
    }, REPORT_RENDER_MS);
  };

  const scheduleChange = (): void => {
    if (changeTimer !== null) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      render();
    }, 0);
  };

  const offChange = session.onChange(scheduleChange);
  const offReport = session.onReport(scheduleReport);

  syncTransportField();
  render();

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    offChange();
    offReport();
    diag.destroy();
    if (reportTimer !== null) clearTimeout(reportTimer);
    if (changeTimer !== null) clearTimeout(changeTimer);
  };

  return root;
}

interface DiagSection {
  readonly root: HTMLElement;
  destroy: () => void;
}

/**
 * 诊断卡（R8）：设备摘要 / 统计 / 一键自检 / 帧日志 / 复制与清空。
 *
 * 整卡是 `<details>`，默认折叠（R8-1/R8-4：不占屏、不新增路由）。
 * 统计优先取通道会话的快照（`transport.stats()`，连接时才准），
 * 没有通道时退回 hub 里的聚合值，于是未连接也能看到最后一次同步的计数。
 */
function createDiagSection(hub: DiagnosticsHub | undefined, link: DeviceLink | undefined): DiagSection {
  const shell = card({ eyebrow: 'DIAGNOSTICS', title: t('diag.title'), tag: 'LOG', desc: t('diag.subtitle') });

  const details = document.createElement('details');
  details.className = 'eq-internal diag-details';
  const summary = document.createElement('summary');
  const summaryLabel = text('span', '', t('diag.log.title'));
  const summaryCount = text('span', 'diag-count', '0');
  summary.append(summaryLabel, summaryCount);
  const body = document.createElement('div');
  body.className = 'eq-internal-body';
  details.append(summary, body);
  shell.body.append(details);

  // -- 设备摘要 -------------------------------------------------------------
  const deviceRows: Record<string, HTMLElement> = {};
  const deviceBox = document.createElement('div');
  deviceBox.className = 'diag-device';
  const deviceFields: Array<[string, string]> = [
    ['model', t('diag.device.model')],
    ['name', t('diag.device.name')],
    ['firmware', t('diag.device.firmware')],
    ['vidpid', t('diag.device.vidpid')],
    ['serial', t('diag.device.serial')],
    ['comErr', t('diag.device.comErr')],
  ];
  for (const [field, label] of deviceFields) {
    const row = document.createElement('div');
    row.className = 'pfield';
    const head = document.createElement('div');
    head.className = 'pfield-head';
    const value = text('span', 'pfield-value', t('diag.device.none'));
    value.dataset.diag = field;
    head.append(text('span', 'pfield-label', label), value);
    row.append(head);
    deviceRows[field] = value;
    deviceBox.append(row);
  }
  const warningText = text('p', 'card-desc diag-warning', '');
  warningText.hidden = true;

  // -- 统计 -----------------------------------------------------------------
  const statsBox = document.createElement('div');
  statsBox.className = 'device-fields diag-stats';
  const statValues: Record<string, HTMLElement> = {};
  const statFields: Array<[string, string]> = [
    ['out', t('diag.stats.out')],
    ['in', t('diag.stats.in')],
    ['crc', t('diag.stats.crc')],
    ['timeout', t('diag.stats.timeout')],
    ['retry', t('diag.stats.retry')],
    ['dropped', t('diag.stats.dropped')],
    ['queue', t('diag.stats.queue')],
  ];
  for (const [field, label] of statFields) {
    const cell = document.createElement('div');
    cell.className = 'device-field';
    const value = text('span', 'device-field-value', '0');
    value.dataset.stat = field;
    cell.append(text('span', 'device-field-key', label), value);
    statValues[field] = value;
    statsBox.append(cell);
  }

  // -- 自检 -----------------------------------------------------------------
  // 卡片里不用 `.device-actions`：那个类名是连接卡按钮组的既有选择器（旧用例按它在取"连接"按钮）
  const selfCheckRow = document.createElement('div');
  selfCheckRow.className = 'diag-actions';
  const selfCheckBtn = actionButton(t('diag.selfcheck.run'), 'ghost', () => {
    void runSelfCheck();
  });
  selfCheckBtn.classList.add('diag-selfcheck');
  const selfCheckList = document.createElement('div');
  selfCheckList.className = 'diag-selfcheck-steps';
  selfCheckRow.append(selfCheckBtn);

  // -- 日志与操作 -----------------------------------------------------------
  const logBox = document.createElement('div');
  logBox.className = 'diag-log';
  const actionsRow = document.createElement('div');
  actionsRow.className = 'diag-actions';
  const copyBtn = actionButton(t('diag.copy'), 'ghost', () => {
    void copyLog();
  });
  copyBtn.classList.add('diag-copy');
  const clearBtn = actionButton(t('diag.clear'), 'ghost', () => {
    hub?.clear();
    renderLog();
    renderStats();
  });
  clearBtn.classList.add('diag-clear');
  const statusText = text('p', 'device-hint diag-status', '');
  const fallbackBox = document.createElement('div');
  fallbackBox.className = 'diag-fallback';
  actionsRow.append(copyBtn, clearBtn);
  body.append(deviceBox, warningText, statsBox, selfCheckRow, selfCheckList, logBox, actionsRow, statusText, fallbackBox);

  function transport() {
    return link?.transport() ?? null;
  }

  /**
   * 诊断导出里的"设备"行（设计 §5.12 第 2 行）。
   *
   * `DiagnosticsHub.toText()` 只认 `deviceSummary` 这个字符串，而它不会自己去看设备状态，
   * 所以每次连接信息变化都要回灌一次，否则贴进问题单的日志永远写着"未连接"（A37）。
   */
  function hubSummary(device: DeviceSnapshot | null): string {
    if (device === null) return UNKNOWN_DEVICE;
    return [
      `${device.modelCode} ${device.deviceName}`,
      `固件 ${device.firmware.x}.${device.firmware.y}.${device.firmware.z}.${device.firmware.build}`,
      `VID ${hex(device.vid)} PID ${hex(device.pid)}`,
      `SN ${device.serial === '' ? '—' : device.serial}`,
    ].join(' / ');
  }

  function renderSummary(): void {
    const device: DeviceSnapshot | null = link?.getState().device ?? null;
    const values: Record<string, string> = {
      model: device?.modelCode ?? t('diag.device.none'),
      name: device?.deviceName ?? t('diag.device.none'),
      firmware:
        device === null
          ? t('diag.device.none')
          : `${device.firmware.x}.${device.firmware.y}.${device.firmware.z}.${device.firmware.build}`,
      vidpid: device === null ? t('diag.device.none') : `${hex(device.vid)} / ${hex(device.pid)}`,
      serial: device?.serial === undefined || device.serial === '' ? t('diag.device.none') : device.serial,
      comErr: device === null ? t('diag.device.none') : String(device.comErrAck),
    };
    for (const [field, value] of Object.entries(values)) {
      const node = deviceRows[field];
      if (node !== undefined) node.textContent = value;
    }
    const warning = formatLinkText(link?.getState().warning ?? null);
    warningText.hidden = warning === null;
    warningText.textContent = warning ?? '';
    hub?.update({ deviceSummary: hubSummary(device) });
  }

  function currentStats(): SessionStats {
    const channel = transport();
    if (channel !== null) return channel.stats();
    return hub?.stats() ?? { ...ZERO_STATS };
  }

  function renderStats(): void {
    const stats = currentStats();
    const values: Record<string, number> = {
      out: stats.outFrames,
      in: stats.inFrames,
      crc: stats.crcErrors,
      timeout: stats.timeouts,
      retry: stats.retries,
      dropped: stats.droppedPolls,
      queue: stats.queueDepth,
    };
    for (const [field, value] of Object.entries(values)) {
      const node = statValues[field];
      if (node !== undefined) node.textContent = String(value);
    }
  }

  function logRow(entry: DiagEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'device-hex diag-log-row';
    if (entry.level === 'error') row.classList.add('is-error');
    const arrow = entry.dir === 'out' ? '→' : '←';
    const shortHex = entry.hex.length > DIAG_HEX_CHARS ? `${entry.hex.slice(0, DIAG_HEX_CHARS)} …` : entry.hex;
    row.textContent = `${clockText(entry.at)} ${arrow} ${shortHex} ${entry.summary}`.trim();
    return row;
  }

  function renderLog(): void {
    const entries = hub?.entries() ?? [];
    const visible = entries.slice(Math.max(0, entries.length - DIAG_RENDER_LIMIT));
    logBox.replaceChildren();
    if (visible.length === 0) {
      logBox.append(text('p', 'device-empty diag-log-empty', t('diag.log.empty')));
    } else {
      for (const entry of visible) logBox.append(logRow(entry));
    }
    summaryCount.textContent = String(entries.length);
  }

  async function copyLog(): Promise<void> {
    // toText() 读的是 hub 自己的计数，而实时计数在 transport 上；导出前先灌一次，
    // 否则复制出来的「统计」行永远全 0（验收 D2）。
    const live = currentStats();
    if (hub && live) hub.update(live);
    const payload = hub?.toText() ?? '';
    try {
      await navigator.clipboard.writeText(payload);
      statusText.textContent = t('diag.copied');
      fallbackBox.replaceChildren();
    } catch {
      // 剪贴板不可用（权限 / 非安全上下文 / 单测环境）：给一个可手动复制的只读框
      const area = document.createElement('textarea');
      area.className = 'device-input diag-fallback-text';
      area.readOnly = true;
      area.rows = 8;
      area.value = payload;
      fallbackBox.replaceChildren(area);
      area.select();
      statusText.textContent = t('diag.copyFallback');
    }
  }

  async function runSelfCheck(): Promise<void> {
    const channel = transport();
    const run = channel?.selfCheck;
    if (channel === null || run === undefined) {
      statusText.textContent = t('diag.selfcheck.disabled');
      return;
    }
    selfCheckBtn.disabled = true;
    const result = await run.call(channel);
    selfCheckList.replaceChildren();
    for (const step of result.steps) {
      const row = document.createElement('div');
      row.className = `diag-selfcheck-step ${step.ok ? 'is-ok' : 'is-error'}`;
      row.textContent = `${step.ok ? t('diag.selfcheck.ok') : t('diag.selfcheck.fail')} · ${step.name} · ${step.detail}`;
      selfCheckList.append(row);
    }
    statusText.textContent = result.ok ? t('diag.selfcheck.ok') : t('diag.selfcheck.fail');
    selfCheckBtn.disabled = transport() === null;
  }

  // -- 订阅 -----------------------------------------------------------------
  const onEntry = (): void => {
    renderLog();
    renderStats();
  };
  const onStats = (): void => renderStats();
  const offLink = link?.onChange(() => {
    renderSummary();
    renderStats();
    selfCheckBtn.disabled = transport() === null || transport()?.selfCheck === undefined;
  });
  hub?.addEventListener(ENTRY_EVENT, onEntry);
  hub?.addEventListener(STATS_EVENT, onStats);

  renderSummary();
  renderStats();
  renderLog();
  selfCheckBtn.disabled = transport() === null || transport()?.selfCheck === undefined;

  return {
    root: shell.root,
    destroy: () => {
      hub?.removeEventListener(ENTRY_EVENT, onEntry);
      hub?.removeEventListener(STATS_EVENT, onStats);
      offLink?.();
    },
  };
}
