import type { HidWhitelist } from '../../../../shared/types';
import {
  createChannelConfigStore,
  DEFAULT_BRIDGE_URL,
  DIAG_LIMIT_MAX,
  DIAG_LIMIT_MIN,
  formatIdList,
  formatReportId,
  formatWhitelistText,
  normalizeChannelConfig,
  parseReportId,
  parseVidPidList,
  parseWhitelistText,
  toHidWhitelist,
  type ChannelConfig,
  type ChannelConfigStore,
  type ChannelKind,
} from '../../domain/channel-config';
import { EQ_BAND_COUNT } from '../../device/registers';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from '../../domain/defaults';
import { PARAMS } from '../../domain/params';
import { DEFAULT_CUSTOM_GAINS } from '../../domain/quick-controls';
import { saveSceneOverrides } from '../../domain/scene-presets';
import { BYPASS_MODULES, type AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card, segmented, switchControl } from '../controls';

export interface SettingsViewOptions {
  readonly configStore?: ChannelConfigStore;
}

interface ChannelCardHandle {
  root: HTMLElement;
  destroy: () => void;
}

function textNode(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function fieldRow(control: string, label: string, trailing?: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pfield';
  row.dataset.channelControl = control;
  const head = document.createElement('div');
  head.className = 'pfield-head';
  head.append(textNode('span', 'pfield-label', label));
  if (trailing) head.append(trailing);
  row.append(head);
  return row;
}

function textInput(field: string, value: string, placeholder?: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'device-input';
  input.spellcheck = false;
  input.dataset.field = field;
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

/** 边框要立刻变红：`.is-error` 只在 `.pfield-value` 上有样式，输入框用行内色 */
function markInvalid(node: HTMLElement, invalid: boolean): void {
  node.classList.toggle('is-error', invalid);
  node.setAttribute('aria-invalid', String(invalid));
  node.style.borderColor = invalid ? 'var(--danger)' : '';
}

function createChannelCard(configStore: ChannelConfigStore): ChannelCardHandle {
  let config = configStore.get();

  const view = card({
    title: t('settings.channel.title'),
    desc: t('settings.channel.desc'),
  });

  const status = document.createElement('p');
  status.className = 'card-desc channel-status';
  status.hidden = true;
  let statusTimer: number | null = null;

  const flash = (message: string, isError = false): void => {
    status.textContent = message;
    status.hidden = false;
    status.style.color = isError ? 'var(--danger)' : '';
    if (statusTimer !== null) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.hidden = true;
      status.style.color = '';
    }, 4000);
  };

  const pushWhitelist = (): void => {
    const payload: HidWhitelist = toHidWhitelist(configStore.get());
    // 主进程可能还没实现该 IPC（5.2 在途）：缺失或拒绝都不影响本地持久化
    const pending = window.micstudio?.setHidWhitelist?.(payload);
    if (pending) void pending.catch(() => undefined);
  };

  const commit = (patch: Partial<ChannelConfig>, message: string): void => {
    configStore.set(patch);
    config = configStore.get();
    pushWhitelist();
    flash(message);
  };

  // -- 通道类型 --------------------------------------------------------------

  const kindRow = fieldRow('kind', t('settings.channel.kind'));
  kindRow.append(
    segmented<ChannelKind>({
      options: [
        { value: 'mock', label: t('settings.channel.kind.mock') },
        { value: 'virtual', label: t('settings.channel.kind.virtual') },
        { value: 'native', label: t('settings.channel.kind.native') },
      ],
      value: config.kind,
      onChange: (value) => commit({ kind: value }, t('settings.channel.reconnect')),
    }),
  );

  // -- 桥接地址 --------------------------------------------------------------

  const bridgeRow = fieldRow('bridge', t('settings.channel.bridgeUrl'));
  const bridgeInput = textInput('bridgeUrl', config.bridgeUrl, DEFAULT_BRIDGE_URL);
  bridgeInput.addEventListener('change', () => {
    const next = bridgeInput.value.trim();
    if (!/^wss?:\/\//i.test(next)) {
      markInvalid(bridgeInput, true);
      flash(t('settings.channel.invalid'), true);
      return;
    }
    markInvalid(bridgeInput, false);
    bridgeInput.value = next;
    commit({ bridgeUrl: next }, t('settings.channel.saved'));
  });
  bridgeRow.append(bridgeInput);

  // -- 报告 ID ---------------------------------------------------------------

  const reportRow = fieldRow('report', t('settings.channel.reportId'));
  const outInput = textInput('reportIdOut', formatReportId(config.reportIdOut), '0x51');
  const inInput = textInput('reportIdIn', formatReportId(config.reportIdIn), '0x11');
  const reportBody = document.createElement('div');
  reportBody.className = 'pfield-body settings-pair';
  reportBody.append(
    textNode('span', 'pfield-unit', 'OUT'),
    outInput,
    textNode('span', 'pfield-unit', 'IN'),
    inInput,
  );
  reportRow.append(reportBody);

  const commitReportId = (input: HTMLInputElement, key: 'reportIdOut' | 'reportIdIn'): void => {
    const parsed = parseReportId(input.value);
    if (parsed === null) {
      markInvalid(input, true);
      flash(t('settings.channel.invalid'), true);
      return;
    }
    markInvalid(input, false);
    input.value = formatReportId(parsed);
    commit(key === 'reportIdOut' ? { reportIdOut: parsed } : { reportIdIn: parsed }, t('settings.channel.saved'));
  };

  outInput.addEventListener('change', () => commitReportId(outInput, 'reportIdOut'));
  inInput.addEventListener('change', () => commitReportId(inInput, 'reportIdIn'));

  // -- 白名单 ----------------------------------------------------------------

  const whitelistCount = document.createElement('span');
  whitelistCount.className = 'pfield-value';
  whitelistCount.dataset.field = 'whitelistCount';
  const whitelistRow = fieldRow('whitelist', t('settings.channel.whitelist'), whitelistCount);

  const whitelistInput = document.createElement('textarea');
  whitelistInput.className = 'device-input device-input--area';
  whitelistInput.dataset.field = 'whitelist';
  whitelistInput.spellcheck = false;
  whitelistInput.rows = 3;
  whitelistInput.placeholder = '0xFF01:0x01';
  whitelistInput.value = formatWhitelistText(config.whitelist);

  const renderWhitelistCount = (): void => {
    whitelistCount.textContent =
      config.whitelist.length === 0 ? t('common.none') : String(config.whitelist.length);
  };

  whitelistInput.addEventListener('change', () => {
    const parsed = parseWhitelistText(whitelistInput.value);
    // 整段都非法时保留旧值，避免一次手滑把白名单清成"全部拒绝"
    if (parsed.invalid > 0 && parsed.entries.length === 0) {
      markInvalid(whitelistInput, true);
      flash(t('settings.channel.invalid'), true);
      return;
    }
    markInvalid(whitelistInput, false);
    whitelistInput.value = formatWhitelistText(parsed.entries);
    commit({ whitelist: parsed.entries }, t('settings.channel.saved'));
    renderWhitelistCount();
  });
  whitelistRow.append(whitelistInput);

  // -- VID / PID -------------------------------------------------------------

  // 占位符只作格式提示：Bootloader 的 VID 已经统一到 0x0A67（2026-11-21 问题单 8/9），
  // 不再出现旧的 0x352F，免得用户以为要按它填
  const vidRow = fieldRow('vidpid', t('settings.channel.vidpid'));
  const vidsInput = textInput('vids', formatIdList(config.vids), '0x0A67');
  const pidsInput = textInput('pids', formatIdList(config.pids), '0x0010');

  const applyIdLists = (): void => {
    const vids = parseVidPidList(vidsInput.value);
    const pids = parseVidPidList(pidsInput.value);
    vidsInput.value = formatIdList(vids);
    pidsInput.value = formatIdList(pids);
    commit({ vids, pids }, t('settings.channel.saved'));
  };
  vidsInput.addEventListener('change', applyIdLists);
  pidsInput.addEventListener('change', applyIdLists);

  const vidBody = document.createElement('div');
  vidBody.className = 'pfield-body settings-pair';
  vidBody.append(
    textNode('span', 'pfield-unit', 'VID'),
    vidsInput,
    textNode('span', 'pfield-unit', 'PID'),
    pidsInput,
  );

  const vidSwitch = switchControl({
    checked: config.useVidPid,
    label: t('settings.channel.vidpidSwitch'),
    onChange: (checked) => commit({ useVidPid: checked }, t('settings.channel.saved')),
  });
  vidSwitch.classList.add('settings-grow');

  const clearIds = document.createElement('button');
  clearIds.type = 'button';
  clearIds.className = 'btn btn--ghost';
  clearIds.textContent = t('common.clear');
  clearIds.addEventListener('click', () => {
    vidsInput.value = '';
    pidsInput.value = '';
    commit({ vids: [], pids: [] }, t('settings.channel.saved'));
  });

  // 开关与清空同一行：通道卡要在一屏里放下 6 个控件
  const vidActions = document.createElement('div');
  vidActions.className = 'settings-inline-actions';
  vidActions.append(vidSwitch, clearIds);

  vidRow.append(vidBody, vidActions);

  // -- 诊断上限 --------------------------------------------------------------

  const diagRow = fieldRow('diagLimit', t('settings.channel.diagLimit'));
  const diagInput = document.createElement('input');
  diagInput.type = 'number';
  diagInput.className = 'device-input';
  diagInput.dataset.field = 'diagLimit';
  diagInput.min = String(DIAG_LIMIT_MIN);
  diagInput.max = String(DIAG_LIMIT_MAX);
  diagInput.step = '1';
  diagInput.value = String(config.diagLimit);
  diagInput.classList.add('device-input--short');
  diagInput.addEventListener('change', () => {
    if (diagInput.value.trim().length === 0) {
      diagInput.value = String(config.diagLimit);
      return;
    }
    // 超范围夹到边界并回写输入框，用户能直接看到被夹后的值
    const next = normalizeChannelConfig({ diagLimit: diagInput.value }).diagLimit;
    diagInput.value = String(next);
    markInvalid(diagInput, false);
    commit({ diagLimit: next }, t('settings.channel.saved'));
  });
  diagRow.append(diagInput);

  // -- 自动连接 --------------------------------------------------------------

  const autoRow = fieldRow('autoConnect', t('settings.channel.autoConnect'));
  const autoSwitch = switchControl({
    checked: config.autoConnect,
    label: t('settings.channel.autoConnectHint'),
    onChange: (checked) => commit({ autoConnect: checked }, t('settings.channel.saved')),
  });
  autoSwitch.classList.add('settings-grow');
  autoRow.append(autoSwitch);

  renderWhitelistCount();
  view.body.append(kindRow, bridgeRow, reportRow, whitelistRow, vidRow, diagRow, autoRow, status);

  return {
    root: view.root,
    destroy: () => {
      if (statusTimer !== null) window.clearTimeout(statusTimer);
      statusTimer = null;
    },
  };
}

export function createSettingsView(store: AppStore, options?: SettingsViewOptions): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  const state = store.get();

  // 通道配置比参数活得久（设备页与设置页共享）：没注入就自建一份，读的是同一个 localStorage
  const channelCard = createChannelCard(options?.configStore ?? createChannelConfigStore());

  const uiCard = card({ title: t('settings.ui') });

  const langRow = document.createElement('div');
  langRow.className = 'pfield';
  const langHead = document.createElement('div');
  langHead.className = 'pfield-head';
  const langLabel = document.createElement('span');
  langLabel.className = 'pfield-label';
  langLabel.textContent = t('settings.language');
  langHead.append(langLabel);
  langRow.append(
    langHead,
    segmented<'zh' | 'en'>({
      options: [
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
      ],
      value: state.lang,
      onChange: (value) => store.setLang(value),
    }),
  );

  const sceneRow = document.createElement('div');
  sceneRow.className = 'pfield';
  const sceneHead = document.createElement('div');
  sceneHead.className = 'pfield-head';
  const sceneLabel = document.createElement('span');
  sceneLabel.className = 'pfield-label';
  sceneLabel.textContent = t('settings.scene');
  sceneHead.append(sceneLabel);
  sceneRow.append(
    sceneHead,
    segmented<string>({
      options: [
        { value: 'silence', label: t('meter.scene.silence') },
        { value: 'speech', label: t('meter.scene.speech') },
        { value: 'music', label: t('meter.scene.music') },
      ],
      value: state.scene,
      onChange: (value) => store.setScene(value as typeof state.scene),
    }),
  );

  uiCard.body.append(langRow, sceneRow);

  const dataCard = card({ title: t('settings.data'), desc: t('settings.data.desc') });
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'btn btn--ghost btn--danger btn--block';
  resetButton.textContent = t('settings.resetAll');

  // 复位会一次性覆盖 36 个参数与 14 段 EQ，加一道二次确认，避免误触
  let armed = false;
  let armedTimer: number | null = null;
  let doneTimer: number | null = null;
  let resetting = false;

  const disarm = (): void => {
    armed = false;
    if (armedTimer !== null) window.clearTimeout(armedTimer);
    armedTimer = null;
    resetButton.classList.remove('is-armed');
    if (!resetting) {
      resetButton.textContent = t('settings.resetAll');
      resetButton.disabled = false;
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });

  /**
   * 分批写默认值（2026-11-22 真机实测）：真机每写一项都可能落 Flash，
   * 46 项挤在一帧里发出去会把固件压住——整帧跨两个 USB 报告，设备还来不及 ACK 下一条。
   * 因此按 `RESET_BATCH` 项一批、批间隔大于写合并窗口，让每批单独成一帧；
   * 7 段 EQ 同样一段一次。模拟通道没有真实设备，不做等待（保持原来的瞬时复位）。
   */
  const RESET_BATCH = 6;
  const RESET_BATCH_GAP_MS = 320;

  const runReset = async (): Promise<void> => {
    resetting = true;
    resetButton.disabled = true;
    resetButton.textContent = t('settings.resetRunning');
    const gap = store.channelKind() === 'webhid' ? RESET_BATCH_GAP_MS : 0;
    try {
      // 先取消旁通：旁通模块的参数要按快照恢复，若放在复位之后会把刚写回的默认值覆盖掉
      for (const module of BYPASS_MODULES) store.setBypass(module, false);
      const writable = PARAMS.filter((spec) => !spec.readonly);
      for (let index = 0; index < writable.length; index += RESET_BATCH) {
        for (const spec of writable.slice(index, index + RESET_BATCH)) {
          const value = DEFAULT_PARAMS[spec.id];
          if (value === undefined) {
            console.warn('[settings] missing default for', spec.id);
            continue;
          }
          store.setParam(spec.id, value);
        }
        // 设备已经不应答时别继续压：再发只会把链路彻底打成 error
        if (store.get().sync === 'error') break;
        if (gap > 0) await sleep(gap);
      }
      if (store.get().sync !== 'error') {
        for (let band = 0; band < EQ_BAND_COUNT; band += 1) {
          const target = DEFAULT_BANDS[band];
          if (!target) continue;
          store.setBands(
            store.get().bands.map((item, index) => (index === band ? { ...target } : { ...item })),
          );
          if (gap > 0) await sleep(gap);
        }
        store.setCustomEq(DEFAULT_CUSTOM_GAINS);
        // 场景的自动保存值也要一起清：留着的话再点场景会把复位前的微调写回来
        saveSceneOverrides({});
        store.notifySceneOverridesCleared();
        // 复位后的值就是新的场景基准：否则工作台上每个「恢复」都会亮着
        store.setSceneBaseline(store.get().activeScene);
      }
      resetButton.textContent = t('settings.resetDone');
    } finally {
      resetting = false;
      doneTimer = window.setTimeout(() => {
        resetButton.disabled = false;
        resetButton.textContent = t('settings.resetAll');
      }, 1500);
    }
  };

  resetButton.addEventListener('click', () => {
    if (resetting) return;
    if (!armed) {
      armed = true;
      resetButton.classList.add('is-armed');
      resetButton.textContent = t('settings.resetConfirm');
      armedTimer = window.setTimeout(disarm, 4000);
      return;
    }
    disarm();
    void runReset();
  });

  dataCard.body.append(resetButton);

  const aboutCard = card({ title: t('settings.about') });
  // 版本号只由主进程 app.getVersion() 提供，渲染进程不再写死兜底值
  const rows: Array<[string, string]> = [
    [t('settings.version'), window.micstudio?.appVersion ?? '—'],
    [t('settings.platform'), window.micstudio?.platform ?? 'browser'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'pfield kv';
    const head = document.createElement('div');
    head.className = 'pfield-head';
    const name = document.createElement('span');
    name.className = 'pfield-label';
    name.textContent = label;
    const readout = document.createElement('span');
    readout.className = 'pfield-value';
    readout.textContent = value;
    head.append(name, readout);
    row.append(head);
    aboutCard.body.append(row);
  }
  const notice = document.createElement('p');
  notice.className = 'card-desc';
  notice.textContent = t('settings.alphaNotice');
  aboutCard.body.append(notice);

  // 两栏：左边是又高又密的通道配置，右边三张小卡叠成一列，避免四卡自动换行后高低不齐
  const side = document.createElement('div');
  side.className = 'settings-side';
  side.append(uiCard.root, dataCard.root, aboutCard.root);
  grid.append(channelCard.root, side);
  root.append(grid);

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    channelCard.destroy();
    if (armedTimer !== null) window.clearTimeout(armedTimer);
    if (doneTimer !== null) window.clearTimeout(doneTimer);
  };

  return root;
}
