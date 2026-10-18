import { errorKeyOf } from '../../device/webhid/session';
import type { WebHidSession } from '../../device/webhid/session';
import type { WebHidDeviceSummary, WebHidMode, WebHidReportSample, WebHidSessionState } from '../../device/webhid/types';
import { t } from '../../i18n';
import { card, segmented } from '../controls';

const KIT_PATH = 'third_party/web_hid_utils';
/** 报告高频推送时最多 15 fps 重绘，避免每条报告都碰 DOM */
const REPORT_RENDER_MS = 66;

const MODE_KEY: Record<WebHidMode, string> = {
  virtual: 'device.mode.virtual',
  native: 'device.mode.native',
};

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
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

/**
 * 设备页：webhid-kit 的界面组件。
 *
 * 只负责把 WebHidSession 的状态画出来，不持设备、不碰 navigator.hid；
 * 视图销毁时退订，会话（连接）由 main.ts 持有，切路由不断线。
 */
export function createDeviceView(session: WebHidSession): HTMLElement {
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
    void session.requestNativeDevice();
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

  main.append(devices.root, reports.root);
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
    if (reportTimer !== null) clearTimeout(reportTimer);
    if (changeTimer !== null) clearTimeout(changeTimer);
  };

  return root;
}
