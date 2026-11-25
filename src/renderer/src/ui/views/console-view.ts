import type { DeviceSnapshot, LevelFrame, Transport } from '../../device/transport';
import { withEqReset } from '../../domain/eq-reset';
import { findParam, type ParamSpec } from '../../domain/params';
import { matchScene, SCENES, type SceneId, type ScenePreset } from '../../domain/scenes';
import {
  clearSceneOverride,
  defaultSceneGains,
  forgetSceneGains,
  forgetSceneParams,
  hasSceneOverride,
  loadCustomEq,
  loadSceneOverrides,
  recordSceneGains,
  recordSceneParams,
  saveCustomEq,
  saveSceneOverrides,
  sceneGains,
  sceneParams,
  type SceneOverrides,
} from '../../domain/scene-presets';
import {
  DEFAULT_CUSTOM_GAINS,
  EQ_PRESETS,
  gainsOf,
  matchEqPreset,
  matchesGains,
  type EqPresetId,
} from '../../domain/quick-controls';
import type { AppState, AppStore, LocalErrorDetail, ParamChangedDetail } from '../../domain/state';
import { LOCAL_ERROR_EVENT, PARAM_CHANGED_EVENT, SCENES_CLEARED_EVENT } from '../../domain/state';
import { formatValue } from '../../domain/values';
import { computeCurve } from '../../eq/curve';
import { attachEqInteractions } from '../../eq/interactions';
import { FreqMapper } from '../../eq/mapper';
import { EqModel } from '../../eq/model';
import { drawEq } from '../../eq/render';
import type { EqBand, Viewport } from '../../eq/types';
import { t } from '../../i18n';
import {
  card,
  macroSlider,
  resetControl,
  segmented,
  setSegmentedValue,
  setSwitchChecked,
  switchControl,
  setResetDisabled,
  type MacroSliderHandle,
} from '../controls';
import { icon, type IconName } from '../icons';
import { MeterCanvas, type MeterChannelState } from '../meter';
import type { AdvancedSectionId } from './advanced-view';

export interface ConsoleApi {
  openDevice: () => void;
  /** `section` 给定时直接滚到高级参数里的那一节（「逐段精调」→ 均衡） */
  openAdvanced: (section?: AdvancedSectionId) => void;
  /** 场景恢复前的确认；未注入时使用 Electron 原生 confirm。 */
  confirm?: (message: string) => boolean;
}

/** 设备摘要的数据源（`DeviceLink`）：工作台只读名字和固件版本，不碰链路 */
export interface ConsoleDeviceInfo {
  snapshot: () => DeviceSnapshot | null;
  onChange: (cb: () => void) => () => void;
}

const TONES: EqPresetId[] = ['flat', 'vocal', 'warm', 'bright', 'custom'];
/** 映射器与 drawEq 必须用同一套边距，否则网格和曲线会错开 */
const EQ_MARGIN = { top: 26, right: 32, bottom: 28, left: 40 };
const SCENE_ICON: Record<SceneId, IconName> = {
  game: 'game',
  podcast: 'podcast',
  sing: 'sing',
  quiet: 'quiet',
  custom: 'sliders',
};

function compactCard(opts: { title: string; tag?: string; desc?: string }): {
  root: HTMLElement;
  body: HTMLElement;
} {
  const built = card({ title: opts.title, tag: opts.tag, desc: opts.desc });
  built.root.classList.add('card--compact');
  return built;
}

function element(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * 增益读数：值节点单独返回，连接后要按回读值刷新（R4-1）。
 * 这两项在协议上只读，界面上不提供控件，但数值必须跟设备走。
 */
function gainItem(label: string, value: string, unit: string): { root: HTMLElement; value: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'console-gain-item';
  root.title = t('common.readonly');
  const valueNode = element('strong', 'console-gain-value', value);
  const labelRow = document.createElement('span');
  labelRow.className = 'console-gain-label';
  labelRow.append(element('span', '', label), icon('lock', 11));
  const valueRow = document.createElement('span');
  valueRow.className = 'console-gain-readout';
  valueRow.append(valueNode, element('span', 'console-gain-unit', unit));
  root.append(labelRow, valueRow);
  return { root, value: valueNode };
}

function firmwareText(device: DeviceSnapshot): string {
  const { x, y, z, build } = device.firmware;
  return `${x}.${y}.${z}.${build}`;
}

/**
 * 一屏工作台：电平、场景、三个常用调节、音色曲线与两个开关全部同屏，
 * 协议参数不在这里出现；需要细调时由顶栏打开「高级参数」抽屉。
 */
export function createConsoleView(
  store: AppStore,
  transport: Transport,
  api: ConsoleApi,
  deviceInfo?: ConsoleDeviceInfo,
): HTMLElement {
  /**
   * 软件打开默认停在「自定义」音色（2026-11-22 问题单第 8 条）：把上次存下来的曲线套上，
   * 一进来看到的、能拖的就是用户自己那条。连上设备后仍由回读值接管
   * （`applyBands` 不发帧，不会把本地曲线写回设备）。
   */
  const storedCustomEq = loadCustomEq();
  if (storedCustomEq) {
    store.setCustomEq(storedCustomEq);
    const base = store.get().bands;
    store.setBands(
      base.map((band, index) =>
        index < storedCustomEq.length ? { ...band, gain: storedCustomEq[index] } : { ...band },
      ),
    );
  }
  const state = store.get();

  const root = document.createElement('div');
  root.className = 'console';

  // ---- 电平 + 增益 + 设备 ------------------------------------------------
  const meterCard = compactCard({
    title: t('console.level.title'),
    // 右上角标记随通道/相位变化：演示数据 / 同步中，ready 且真机时不显示（Q3）
    tag: t('sync.badge.demo'),
  });
  meterCard.root.classList.add('console-meter');
  const syncTag = meterCard.root.querySelector<HTMLElement>('.card-tag');

  // 电平画在一块"屏幕"里：凹槽底色由外层 div 提供，canvas 只画刻度与 LED 段
  const meterScreen = document.createElement('div');
  meterScreen.className = 'meter-screen';
  const canvas = document.createElement('canvas');
  canvas.className = 'meter-canvas console-meter-canvas';
  meterScreen.append(canvas);
  const meter = new MeterCanvas(canvas, {
    minDb: -60,
    rmsLabel: t('meter.rms'),
    peakLabel: t('meter.peak'),
  });

  const gainBox = document.createElement('div');
  gainBox.className = 'console-gain';
  const micGain = findParam('gain.Mic');
  const hpGain = findParam('gain.Hp');
  const gainValues = new Map<string, { spec: ParamSpec; node: HTMLElement }>();
  if (micGain) {
    const item = gainItem(t('param.gain.Mic.label'), formatValue(micGain, state.params['gain.Mic'] ?? micGain.default), micGain.unit);
    gainBox.append(item.root);
    gainValues.set(micGain.id, { spec: micGain, node: item.value });
  }
  if (hpGain) {
    const item = gainItem(t('param.gain.Hp.label'), formatValue(hpGain, state.params['gain.Hp'] ?? hpGain.default), hpGain.unit);
    gainBox.append(item.root);
    gainValues.set(hpGain.id, { spec: hpGain, node: item.value });
  }

  // 设备摘要：整行可点（打开设备抽屉），右侧按钮保留给键盘与旧探针
  const deviceRow = document.createElement('div');
  deviceRow.className = 'console-device-row';
  deviceRow.title = t('device.sync.note');
  deviceRow.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    api.openDevice();
  });
  const deviceIcon = icon('usb', 16);
  deviceIcon.classList.add('console-device-icon');
  const deviceText = document.createElement('div');
  deviceText.className = 'console-device-text';
  const deviceName = element('span', 'console-device-name', t('console.device.demo'));
  const deviceState = element('span', 'console-device-state', t('console.device.connected'));
  deviceText.append(deviceName, deviceState);
  const deviceButton = document.createElement('button');
  deviceButton.type = 'button';
  deviceButton.className = 'btn btn--ghost btn--small';
  deviceButton.append(element('span', '', t('console.device.short')), icon('chevronRight', 14));
  deviceButton.addEventListener('click', () => api.openDevice());
  deviceRow.append(deviceIcon, deviceText, deviceButton);

  meterCard.body.append(meterScreen, gainBox, deviceRow);

  // ---- 一键场景 ------------------------------------------------------------
  const sceneCard = compactCard({
    title: t('console.scene.title'),
    desc: t('console.scene.desc'),
  });
  sceneCard.root.classList.add('console-scene');
  const sceneRow = document.createElement('div');
  sceneRow.className = 'scene-row';
  const sceneButtons = new Map<SceneId, HTMLButtonElement>();
  for (const scene of SCENES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-btn';
    button.dataset.scene = scene.id;
    button.setAttribute('aria-pressed', 'false');
    const glyph = icon(SCENE_ICON[scene.id] ?? 'podcast', 18);
    glyph.classList.add('scene-icon');
    const textBox = document.createElement('span');
    textBox.className = 'scene-text';
    textBox.append(
      element('strong', 'scene-name', t(`console.scene.${scene.id}`)),
      element('span', 'scene-desc', t(`console.scene.${scene.id}.desc`)),
    );
    button.append(glyph, textBox);
    button.addEventListener('click', () => applyScene(scene));
    sceneButtons.set(scene.id, button);
    sceneRow.append(button);
  }
  // 场景复位（2026-11-22 问题单第 9 条）：只复位当前选中的那个场景，
  // 清掉它自动保存过的改动，回到 `SCENES` 里的出厂预设；复位会覆盖微调，先问一句
  const sceneReset = document.createElement('button');
  sceneReset.type = 'button';
  sceneReset.className = 'scene-reset';
  sceneReset.append(icon('reset', 14), element('span', '', t('console.scene.reset')));
  sceneReset.title = t('console.scene.resetHint');
  sceneReset.setAttribute('aria-label', t('console.scene.resetHint'));
  sceneReset.disabled = true;
  sceneReset.setAttribute('aria-disabled', 'true');
  sceneReset.addEventListener('click', () => resetScene());
  sceneRow.append(sceneReset);
  sceneCard.body.append(sceneRow);

  // ---- 快速调音 ------------------------------------------------------------
  const tuneCard = compactCard({ title: t('console.tune.title'), desc: t('console.tune.desc') });
  const tuneGrid = document.createElement('div');
  tuneGrid.className = 'tune-grid';

  /**
   * 三个阈值（噪声门 / 压缩器 / 限幅器）各带一个模块开关（2026-11-21 问题单 3、4）。
   *
   * 开关与阈值写的都是**高级参数里同一个参数 id**（`noisegate.Enable` / `comp.Enable` /
   * `limit.Enable`），所以两处天然联动：改哪边都会经 `store` 广播给另一边，
   * 这里不需要额外的同步逻辑，只要在回填时把开关状态一起写回去。
   *
   * 2026-11-13 起不再用 0..100 的抽象强度，显示的数值就是协议阈值本身。
   */
  interface ThresholdRow {
    readonly slider: MacroSliderHandle;
    readonly threshold: ParamSpec;
    readonly enableId: string | null;
  }
  const thresholdRows: ThresholdRow[] = [];

  const thresholdRow = (
    key: string,
    label: string,
    thresholdId: string,
    enableId: string | null,
    hint: string,
  ): void => {
    const threshold = findParam(thresholdId);
    if (!threshold) return;
    const enable = enableId ? findParam(enableId) : undefined;
    const slider = macroSlider({
      label,
      value: state.params[threshold.id] ?? threshold.default,
      min: threshold.min,
      max: threshold.max,
      step: threshold.step,
      format: (value) => `${formatValue(threshold, value)} ${t('common.unit.dB')}`,
      hint,
      onChange: (value) => store.setParam(threshold.id, value),
      reset: {
        onClick: () => store.restoreParam(threshold.id),
        disabled: store.isParamAtSceneTarget(threshold.id),
      },
      toggle: enable
        ? {
            checked: (state.params[enable.id] ?? 0) === 1,
            label: t(`param.${enable.id}.label`),
            onChange: (checked) => store.setParam(enable.id, checked ? 1 : 0),
            reset: {
              onClick: () => store.restoreParam(enable.id),
              disabled: store.isParamAtSceneTarget(enable.id),
            },
          }
        : undefined,
    });
    slider.root.dataset.macro = key;
    const sliderHead = slider.root.querySelector<HTMLElement>('.pfield-head');
    const sliderReset = Array.from(sliderHead?.children ?? []).find(
      (child): child is HTMLButtonElement =>
        child instanceof HTMLButtonElement && child.classList.contains('param-reset'),
    );
    sliderReset?.setAttribute('data-reset-param', threshold.id);
    const toggleNode = slider.root.querySelector<HTMLElement>('.macro-toggle');
    if (enable && toggleNode) {
      // 开关也带 data-param / data-enable：探针与验收脚本按参数 id 定位，不靠文案
      toggleNode.dataset.param = enable.id;
      toggleNode.dataset.enable = key;
      toggleNode.querySelector<HTMLButtonElement>('.param-reset')?.setAttribute('data-reset-param', enable.id);
    }
    thresholdRows.push({ slider, threshold, enableId: enable?.id ?? null });
    tuneGrid.append(slider.root);
  };

  thresholdRow(
    'denoise',
    t('console.denoise'),
    'noisegate.threshold_db',
    'noisegate.Enable',
    t('console.hint.denoise'),
  );
  thresholdRow('evenness', t('console.evenness'), 'comp.Threshold', 'comp.Enable', t('console.hint.evenness'));
  // 主界面沿用产品叫法「防爆音」（高级参数里仍是「限幅器」）：2026-11-21 夜里把它改名成
  // 「限幅器阈值」后用户反馈"界面上的防爆音没了"，这里恢复文案；开关与阈值仍在同一行。
  thresholdRow('limiter', t('console.limiter'), 'limit.Threshold', 'limit.Enable', t('console.limiter.hint'));

  const toneBlock = document.createElement('div');
  toneBlock.className = 'tone-block';
  const toneHead = document.createElement('div');
  toneHead.className = 'pfield-head';
  toneHead.append(element('span', 'pfield-label', t('console.tone')));
  const toneReset = resetControl({
    onClick: () => restoreTone(),
    disabled: true,
  });
  toneReset.dataset.resetParam = 'tone';
  toneHead.append(toneReset);
  const toneChips = document.createElement('div');
  toneChips.className = 'tone-chips';
  const toneButtons = new Map<EqPresetId, HTMLButtonElement>();
  for (const id of TONES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tone-chip';
    button.dataset.tone = id;
    button.textContent = t(`console.preset.${id}`);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => applyTone(id));
    toneButtons.set(id, button);
    toneChips.append(button);
  }
  toneBlock.append(toneHead, toneChips);
  tuneGrid.append(toneBlock);

  // 增益选项卡从高级参数移除后，三个输入开关放到主界面「快速调音」里（2026-11-13）
  const inputSwitches = document.createElement('div');
  inputSwitches.className = 'tune-switches';
  const inputHead = document.createElement('div');
  inputHead.className = 'pfield-head';
  inputHead.append(element('span', 'pfield-label', t('console.tune.input')));
  const tuneSwitchGrid = document.createElement('div');
  tuneSwitchGrid.className = 'tune-switch-grid';
  const inputSwitchById = new Map<string, HTMLElement>();
  const inputSwitchLabel: Record<string, string> = {
    'mic.mute': t('param.mic.mute.label'),
    'hp.OnOff': t('param.hp.OnOff.label'),
    // 三列布局里"电平信号静音"会省略号；控制台只显示"电平信号"，完整名在高级参数里
    'mic.sigMute': t('console.input.sigMute'),
  };
  for (const id of ['mic.mute', 'hp.OnOff', 'mic.sigMute']) {
    const spec = findParam(id);
    if (!spec) continue;
    const node = switchControl({
      checked: (state.params[id] ?? 0) === 1,
      label: inputSwitchLabel[id] ?? t(`param.${id}.label`),
      onChange: (checked) => store.setParam(id, checked ? 1 : 0),
      reset: {
        onClick: () => store.restoreParam(id),
        disabled: store.isParamAtSceneTarget(id),
      },
    });
    node.dataset.param = id;
    node.querySelector<HTMLButtonElement>('.param-reset')?.setAttribute('data-reset-param', id);
    inputSwitchById.set(id, node);
    tuneSwitchGrid.append(node);
  }
  inputSwitches.append(inputHead, tuneSwitchGrid);
  tuneGrid.append(inputSwitches);
  tuneCard.body.append(tuneGrid);

  // ---- 音色曲线 ------------------------------------------------------------
  const eqCard = compactCard({
    title: t('console.eq.title'),
    desc: t('console.eq.desc'),
  });
  eqCard.root.classList.add('console-eq');
  const eqDesc = eqCard.root.querySelector<HTMLElement>('.card-desc');
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'eq-canvas-wrap console-eq-wrap';
  const eqCanvas = document.createElement('canvas');
  eqCanvas.className = 'eq-canvas console-eq-canvas';
  canvasWrap.append(eqCanvas);

  // 卡头右侧两个动作：「复位」只在自定义音色下可用（问题单 13）、
  // 「逐段精调」直接跳到高级参数的均衡一节，不再落到抽屉最上面（问题单 5）
  const eqActions = document.createElement('div');
  eqActions.className = 'console-eq-actions';
  const eqReset = document.createElement('button');
  eqReset.type = 'button';
  eqReset.className = 'console-link console-link--plain console-eq-reset';
  eqReset.textContent = t('console.eq.reset');
  eqReset.title = t('console.eq.resetHint');
  eqReset.disabled = true;
  eqReset.addEventListener('click', () => resetEq());
  const advancedLink = document.createElement('button');
  advancedLink.type = 'button';
  advancedLink.className = 'console-link';
  advancedLink.append(element('span', '', t('console.eq.advanced')), icon('chevronRight', 14));
  advancedLink.addEventListener('click', () => api.openAdvanced('eq'));
  eqActions.append(eqReset, advancedLink);
  eqCard.root.querySelector('.card-head')?.append(eqActions);
  eqCard.body.append(canvasWrap);

  // ---- 快捷开关 ------------------------------------------------------------
  // 限幅器（防爆音）的开关跟着阈值一起挪到「快速调音」了（问题单 4）：
  // 一个模块只留一个开关，同屏两处开关只会互相打架
  const switchCard = compactCard({ title: t('console.switch.title') });
  const switchGrid = document.createElement('div');
  switchGrid.className = 'switch-grid';

  const encGroup = document.createElement('div');
  encGroup.className = 'switch-item';
  const encSwitch = switchControl({
    checked: (state.params['enc.OnOff'] ?? 0) === 1,
    label: t('console.enc'),
    onChange: (checked) => store.setParam('enc.OnOff', checked ? 1 : 0),
    reset: {
      onClick: () => store.restoreParam('enc.OnOff'),
      disabled: store.isParamAtSceneTarget('enc.OnOff'),
    },
  });
  // 与三个输入开关一致：带 data-param，探针/验收按参数 id 定位，不靠文案
  encSwitch.dataset.param = 'enc.OnOff';
  encSwitch.querySelector<HTMLButtonElement>('.param-reset')?.setAttribute('data-reset-param', 'enc.OnOff');
  const encLevel = segmented<number>({
    options: [0, 1, 2, 3].map((value) => ({ value, label: String(value) })),
    value: state.params['enc.Level'] ?? 1,
    onChange: (value) => store.setParam('enc.Level', value),
  });
  encLevel.classList.add('segmented--compact');
  const encLevelRow = document.createElement('div');
  encLevelRow.className = 'switch-sub';
  const encLevelLabel = element('span', 'switch-sub-label', t('console.enc.level'));
  const encLevelReset = resetControl({
    onClick: () => store.restoreParam('enc.Level'),
    disabled: store.isParamAtSceneTarget('enc.Level'),
  });
  encLevelReset.dataset.resetParam = 'enc.Level';
  encLevelRow.append(encLevelLabel, encLevel, encLevelReset);
  encGroup.append(encSwitch, encLevelRow);

  /**
   * 灯效搬上主界面（2026-11-22 问题单第 5 条）：开关 + 0–7 模式。
   *
   * 两项与高级参数里的「灯效」是同一个参数 id（`rgb.OnOff` / `rgb.Mode`），
   * 因此两处天然联动，不需要额外同步；8 个模式按钮等宽铺满一行，
   * 弯道比一根滑杆少一步（演示时直接点数字）。
   */
  const lightGroup = document.createElement('div');
  lightGroup.className = 'switch-item switch-item--light';
  const lightSwitch = switchControl({
    checked: (state.params['rgb.OnOff'] ?? 0) === 1,
    label: t('console.lighting'),
    onChange: (checked) => store.setParam('rgb.OnOff', checked ? 1 : 0),
  });
  lightSwitch.dataset.param = 'rgb.OnOff';
  const lightMode = segmented<number>({
    options: Array.from({ length: 8 }, (_, value) => ({ value, label: String(value) })),
    value: state.params['rgb.Mode'] ?? 0,
    onChange: (value) => store.setParam('rgb.Mode', value),
  });
  lightMode.classList.add('segmented--modes');
  lightMode.dataset.param = 'rgb.Mode';
  const lightModeRow = document.createElement('div');
  lightModeRow.className = 'switch-sub';
  lightModeRow.append(element('span', 'switch-sub-label', t('console.lighting.mode')), lightMode);
  lightGroup.append(lightSwitch, lightModeRow);

  switchGrid.append(encGroup, lightGroup);
  switchCard.body.append(switchGrid);

  const middle = document.createElement('div');
  middle.className = 'console-middle';
  middle.append(tuneCard.root, switchCard.root);

  // ---- 提示条（只读 / 超范围 / 链路错误）------------------------------------
  /**
   * 参数被本地拦下时只有这里能看见：`local-error` 与 `transport.onError` 原本没有订阅者，
   * 用户写完超范围或写了只读参数只会"什么都没发生"（验收 A15）。
   * 用 fixed 定位而不是塞进网格：`.console` 的 grid-template-areas 只有两行，
   * 多一个子元素会破坏三栏布局，而本次不允许改 styles/*.css。
   */
  const noticeBar = document.createElement('div');
  noticeBar.className = 'console-notice';
  noticeBar.setAttribute('role', 'status');
  noticeBar.setAttribute('aria-live', 'polite');
  // 外观在 components.css 的 .console-notice（fixed 定位，不进三栏网格）；
  // 初始显隐交给下面的 setNoticeVisible(false)，避免两处各写一次 hidden 造成状态漂移
  const noticeText = element('span', 'console-notice-text', '');
  noticeBar.append(icon('alert', 15), noticeText);

  /** 显隐的唯一开关：同时设 hidden 与内联 display，任何一条被覆盖都不会露出空条 */
  const setNoticeVisible = (visible: boolean): void => {
    noticeBar.hidden = !visible;
    noticeBar.style.display = visible ? 'flex' : 'none';
  };
  setNoticeVisible(false);

  /** 临时提示（只读 / 超范围 / 未同步）3 s 自动消失；链路类提示常驻到恢复 */
  const NOTICE_LIFETIME_MS = 3000;
  const PERSISTENT_NOTICES = new Set(['timeout', 'disconnected']);
  let noticeTimer: number | null = null;
  /** 当前提示条是否属于"常驻到恢复"那类（超时 / 断开） */
  let noticePersistent = false;

  const clearNoticeTimer = (): void => {
    if (noticeTimer === null) return;
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  };

  const hideNotice = (): void => {
    clearNoticeTimer();
    setNoticeVisible(false);
    noticeText.textContent = '';
    noticePersistent = false;
  };

  const showNotice = (message: string, persistent: boolean): void => {
    clearNoticeTimer();
    if (noticeText.textContent === message && !noticeBar.hidden) {
      // 同一句话重复触发（拖拽时连续超范围）不重置计时器，避免提示条永远不消失
      noticePersistent = noticePersistent || persistent;
      if (!noticePersistent) {
        noticeTimer = window.setTimeout(hideNotice, NOTICE_LIFETIME_MS);
      }
      return;
    }
    noticeText.textContent = message;
    setNoticeVisible(true);
    noticePersistent = persistent;
    if (!persistent) noticeTimer = window.setTimeout(hideNotice, NOTICE_LIFETIME_MS);
  };

  const labelOf = (id: string): string => {
    const spec = findParam(id);
    return spec ? t(`param.${spec.id}.label`) : id;
  };

  const onLocalError = (event: Event): void => {
    const detail = (event as CustomEvent<LocalErrorDetail>).detail;
    if (!detail) return;
    if (detail.kind === 'readOnly') {
      showNotice(t('param.error.readOnly', { label: labelOf(detail.id) }), false);
      return;
    }
    showNotice(t('param.error.notSynced', { label: labelOf(detail.id) }), false);
  };
  store.addEventListener(LOCAL_ERROR_EVENT, onLocalError);

  const offTransportError = transport.onError((error) => {
    if (error.kind === 'readOnly') {
      showNotice(t('param.error.readOnly', { label: error.id ? labelOf(error.id) : '—' }), false);
      return;
    }
    if (error.kind === 'range') {
      showNotice(t('param.error.range', { label: error.id ? labelOf(error.id) : '—' }), false);
      return;
    }
    if (PERSISTENT_NOTICES.has(error.kind)) {
      // 超时 / 断开必须常驻：用户得知道"参数没写进去"，直到链路恢复
      showNotice(t('param.error.timeout'), true);
    }
  });

  root.append(sceneCard.root, meterCard.root, middle, eqCard.root, noticeBar);

  // ---- 场景 / 音色 应用与高亮 ---------------------------------------------
  /** 当前高亮的音色；只有「自定义」允许直接拖曲线（2026-11-13 需求） */
  let activeTone: EqPresetId | null = null;
  /** 场景自己正在写 store：这时的 setParam 是"应用预设"，不能被当成用户改动存起来 */
  let applyingScene = false;
  let sceneOverrides: SceneOverrides = loadSceneOverrides();
  /** 上一次对齐过的频段表：换掉才需要重算「自定义」曲线的场景覆盖值 */
  let lastBands = store.get().bands;

  /**
   * 应用一个场景：写出它保存过的参数与曲线（没改过的项就是出厂预设），
   * 并把它设为当前场景。整个过程用 `applyingScene` 压住自动保存，避免把预设
   * 当成"用户刚改的值"再存一遍（那样复位后就再也回不到出厂值）。
   */
  function applySceneValues(id: SceneId, opts: { resetCustomCurve?: boolean } = {}): void {
    const scene = SCENES.find((item) => item.id === id);
    if (!scene) return;
    applyingScene = true;
    try {
      if (opts.resetCustomCurve && id === 'custom') {
        // 「自定义」场景的默认曲线就是那条平直线：复位连用户拖过的曲线一起清掉
        store.setCustomEq(DEFAULT_CUSTOM_GAINS);
        saveCustomEq(DEFAULT_CUSTOM_GAINS);
      }
      const params = sceneParams(id, sceneOverrides);
      const gains = sceneGains(id, sceneOverrides, store.get().customEq);
      store.setTone(scene.tone);
      for (const [paramId, value] of Object.entries(params)) store.setParam(paramId, value);
      const bands = store.get().bands;
      store.setBands(
        bands.map((band, index) =>
          index < gains.length ? { ...band, gain: gains[index] } : { ...band },
        ),
      );
      if (scene.tone === 'custom') store.setCustomEq(gains);
    } finally {
      applyingScene = false;
    }
    store.setActiveScene(id);
    syncScene(store.get());
  }

  function applyScene(scene: ScenePreset): void {
    applySceneValues(scene.id);
  }

  /**
   * 场景复位（问题单第 9 条）：清掉这个场景自动保存的改动，再按出厂预设应用一遍。
   *
   * 会覆盖用户已经做好的微调，因此先问一句；`api.confirm` 没注入时退回浏览器原生
   * confirm，两者都没有（无弹窗能力的环境）才直接执行，免得按钮点了没反应。
   */
  function resetScene(): void {
    const id = store.get().activeScene;
    if (!id || !hasSceneOverride(sceneOverrides, id)) return;
    const message = t('console.scene.resetConfirm', { scene: t(`console.scene.${id}`) });
    const confirmed = api.confirm
      ? api.confirm(message)
      : typeof window.confirm === 'function'
        ? window.confirm(message)
        : true;
    if (!confirmed) return;
    sceneOverrides = clearSceneOverride(sceneOverrides, id);
    saveSceneOverrides(sceneOverrides);
    applySceneValues(id, { resetCustomCurve: true });
  }

  function toneGains(id: EqPresetId): readonly number[] {
    return id === 'custom' ? store.get().customEq : EQ_PRESETS[id];
  }

  function applyTone(id: EqPresetId): void {
    // 手动换音色就是离开场景：场景的曲线由场景自己管，这里不再往场景里记
    store.setActiveScene(null);
    store.setTone(id);
    const gains = toneGains(id);
    const bands = store.get().bands;
    store.setBands(
      bands.map((band, index) =>
        index < gains.length ? { ...band, gain: gains[index] } : { ...band },
      ),
    );
    syncScene(store.get());
  }

  /** 音色恢复：回到当前场景的出厂音色；没有场景上下文时回「原声」 */
  function restoreTone(): void {
    const sceneId = store.get().activeScene;
    const scene = sceneId ? SCENES.find((item) => item.id === sceneId) : undefined;
    const id: EqPresetId = scene?.tone ?? 'flat';
    const gains = toneGains(id);
    store.setTone(id);
    store.setBands(
      store.get().bands.map((band, index) =>
        index < gains.length ? { ...band, gain: gains[index] } : { ...band },
      ),
    );
    syncScene(store.get());
  }

  /**
   * 「均衡器复位」：只允许在「自定义」音色下用（问题单 13），
   * 复位后的频段值按问题单手写的那张表——7 段增益全 0、Q 全 0.7（问题单 12），
   * 频点取产品默认（2026-11-22 问题单第 2、3 条：3–7 段 63/250/1k/4k/12.5k）。
   * 曲线/段值的刷新走 `store` → `syncBands`，这里不直接动 model。
   */
  function resetEq(): void {
    if (activeTone !== 'custom') return;
    const bands = withEqReset(store.get().bands);
    store.setTone('custom');
    store.setBands(bands);
    store.setCustomEq(gainsOf(bands));
    persistCustomGains(bands);
  }

  /**
   * 用户拖过的自定义曲线要跨重启保留，并且记到当前场景名下（问题单第 9 条）。
   *
   * 改回出厂曲线时反过来把这条记录摘掉，这样「复位」按钮只在这个场景真有改动时可用。
   */
  function persistCustomGains(bands: readonly EqBand[]): void {
    if (activeTone !== 'custom') return;
    const gains = gainsOf(bands);
    if (applyingScene) return;
    saveCustomEq(gains);
    const sceneId = store.get().activeScene;
    if (!sceneId) return;
    const factory = defaultSceneGains(sceneId);
    const same =
      factory.length === gains.length && factory.every((value, index) => value === gains[index]);
    const next = same
      ? forgetSceneGains(sceneOverrides, sceneId)
      : recordSceneGains(sceneOverrides, sceneId, gains);
    if (next === sceneOverrides) return;
    sceneOverrides = next;
    saveSceneOverrides(sceneOverrides);
  }

  /**
   * 主界面/高级参数改过的参数都记在当前场景名下：复位一次就全回到出厂预设。
   * 某一项被「恢复」按钮写回目标值时把它从记录里摘掉，否则复位按钮永远亮着。
   */
  const onParamChanged = (event: Event): void => {
    const sceneId = store.get().activeScene;
    if (applyingScene || !sceneId) return;
    const detail = (event as CustomEvent<ParamChangedDetail>).detail;
    if (!detail || typeof detail.id !== 'string') return;
    const target = store.sceneTargetParam(detail.id);
    const next =
      target !== undefined && detail.value === target
        ? forgetSceneParams(sceneOverrides, sceneId, [detail.id])
        : recordSceneParams(sceneOverrides, sceneId, { [detail.id]: detail.value });
    if (next === sceneOverrides) return;
    sceneOverrides = next;
    saveSceneOverrides(sceneOverrides);
    // setParam 先发 'change' 再发 'param-changed'，上面那轮回填看到的还是旧覆盖表，
    // 这里补一次，场景按钮的 is-dirty / 复位可用态才跟得上。
    syncScene(store.get());
  };
  store.addEventListener(PARAM_CHANGED_EVENT, onParamChanged);

  /** 设置页「复位全部参数」把场景覆盖表也清了：这里跟着重读，别拿旧值再写回设备 */
  const onScenesCleared = (): void => {
    sceneOverrides = loadSceneOverrides();
    syncScene(store.get());
  };
  store.addEventListener(SCENES_CLEARED_EVENT, onScenesCleared);

  function sceneIsDirty(): boolean {
    const sceneId = store.get().activeScene;
    return sceneId !== null && hasSceneOverride(sceneOverrides, sceneId);
  }

  function syncScene(stateNow: ReturnType<AppStore['get']>): void {
    // 显式选中的场景优先（它可能已经被微调过，参数不再与出厂值一致）；
    // 没选场景（用户手动换了音色）时才按参数反推
    const active = stateNow.activeScene ?? matchScene(stateNow.params, stateNow.bands, stateNow.customEq, stateNow.tone);
    const selected = stateNow.activeScene;
    const dirty = sceneIsDirty();
    for (const [id, button] of sceneButtons) {
      // 选中场景是稳定的工作上下文；`active` 只用于首次加载时从已有参数推断。
      // 手调后仍保留按钮高亮，并用 is-dirty 边框说明这个场景已经有保存过的改动。
      const on = id === active;
      button.classList.toggle('is-active', on);
      button.classList.toggle('is-selected', id === selected);
      button.classList.toggle('is-dirty', id === selected && dirty);
      button.setAttribute('aria-pressed', String(on));
    }
    // 没有保存过的改动就没什么可复位的，按钮此时不该亮
    const canReset = selected !== null && dirty;
    if (sceneReset.disabled !== !canReset) sceneReset.disabled = !canReset;
    sceneReset.setAttribute('aria-disabled', String(!canReset));
  }

  function syncTone(stateNow: ReturnType<AppStore['get']>): void {
    // 显式选择优先；没选过才按曲线反推（自定义全平曲线不会抢走「原声」的高亮）
    const active: EqPresetId | null =
      stateNow.tone ??
      matchEqPreset(stateNow.bands, 7) ??
      (matchesGains(stateNow.bands, stateNow.customEq, 7) ? 'custom' : null);
    activeTone = active;
    for (const [id, button] of toneButtons) {
      const on = id === active;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
    }
    // 音色恢复目标 = 当前场景的出厂音色；不在场景里（用户手选了音色）时回「原声」
    const sceneId = stateNow.activeScene;
    const scene = sceneId ? SCENES.find((item) => item.id === sceneId) : undefined;
    const targetTone: EqPresetId = scene?.tone ?? 'flat';
    const targetGains = targetTone === 'custom' ? stateNow.customEq : EQ_PRESETS[targetTone];
    const atTarget = active === targetTone && matchesGains(stateNow.bands, targetGains, 7);
    toneReset.disabled = atTarget;
    toneReset.setAttribute('aria-disabled', String(atTarget));
    if (eqDesc) {
      eqDesc.textContent = active === 'custom' ? t('console.eq.desc') : t('console.eq.locked');
    }
    // 复位按钮只在自定义音色下可用（问题单 13）：其它音色的曲线由音色表决定，复位没有意义
    const customOn = active === 'custom';
    if (eqReset.disabled === customOn) eqReset.disabled = !customOn;
    eqReset.setAttribute('aria-disabled', String(!customOn));
    if (active !== 'custom') eqCanvas.dataset.cursor = 'default';
  }

  function syncBands(stateNow: ReturnType<AppStore['get']>): void {
    const current = model.allBands();
    const changed = stateNow.bands.some((band: EqBand, index: number) => {
      const mine = current[index];
      return (
        !mine ||
        mine.freq !== band.freq ||
        mine.gain !== band.gain ||
        mine.q !== band.q ||
        mine.type !== band.type
      );
    });
    if (!changed) return;
    for (const band of stateNow.bands) {
      model.setBand(band.index, { freq: band.freq, gain: band.gain, q: band.q, type: band.type });
    }
    renderCanvas();
  }

  // ---- EQ 曲线 -------------------------------------------------------------
  const model = new EqModel(state.bands);
  const ctx = eqCanvas.getContext('2d');
  let mapper = new FreqMapper({ x: EQ_MARGIN.left, y: EQ_MARGIN.top, width: 1, height: 1 });
  const mapperProxy = {
    freqToX: (freq: number) => mapper.freqToX(freq),
    gainToY: (gain: number) => mapper.gainToY(gain),
    xToFreq: (x: number) => mapper.xToFreq(x),
    yToGain: (y: number) => mapper.yToGain(y),
  };

  function renderCanvas(): void {
    if (!ctx) return;
    const rect = eqCanvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;
    if (cssWidth < 10 || cssHeight < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const pxWidth = Math.round(cssWidth * dpr);
    const pxHeight = Math.round(cssHeight * dpr);
    if (eqCanvas.width !== pxWidth || eqCanvas.height !== pxHeight) {
      eqCanvas.width = pxWidth;
      eqCanvas.height = pxHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const viewport: Viewport = {
      x: EQ_MARGIN.left,
      y: EQ_MARGIN.top,
      width: Math.max(10, cssWidth - EQ_MARGIN.left - EQ_MARGIN.right),
      height: Math.max(10, cssHeight - EQ_MARGIN.top - EQ_MARGIN.bottom),
    };
    mapper = new FreqMapper(viewport);

    const bands = model.allBands();
    const ticks = FreqMapper.freqTicks(20, 20000);
    // 窄栏里全量刻度会叠字，隔一个画一个
    const freqTicks = cssWidth < 400 ? ticks.filter((_tick, index) => index % 2 === 0) : ticks;
    drawEq(ctx, {
      width: cssWidth,
      height: cssHeight,
      freqTicks,
      gainTicks: FreqMapper.gainTicks(-24, 12, 6),
      bands,
      visibleCount: model.visibleCount(),
      focusedIndex: model.focusedIndex(),
      curve: computeCurve(bands, { pointCount: Math.min(1200, Math.max(240, Math.round(cssWidth))) }),
      freqToX: mapperProxy.freqToX,
      gainToY: mapperProxy.gainToY,
      xToFreq: mapperProxy.xToFreq,
      yToGain: mapperProxy.yToGain,
      theme: { margin: EQ_MARGIN },
    });
  }

  const detachEq = attachEqInteractions({
    canvas: eqCanvas,
    model,
    mapper: mapperProxy,
    // 只有「自定义」音色允许直接改曲线；其它音色只展示，细调走高级参数（2026-11-13）
    enabled: () => activeTone === 'custom',
    onChange: () => {
      renderCanvas();
      const bands = model.allBands();
      store.setBands(bands);
      if (activeTone === 'custom') {
        store.setCustomEq(gainsOf(bands));
        persistCustomGains(bands);
      }
    },
  });
  const observer = new ResizeObserver(() => renderCanvas());
  observer.observe(canvasWrap);

  // ---- 电平刷新 ------------------------------------------------------------
  /** 设备通道断流判定窗口：超过这么久没有电平帧就认为拔线（R5-3） */
  const LEVEL_STALE_MS = 1000;
  const STALE_CHECK_MS = 250;

  let latest: LevelFrame | null = null;
  let frameId: number | null = null;
  let disposed = false;
  let stale = false;
  let lastLevelAt = 0;

  /** 通道是否有数据：未连接 / 同步未完成 / 断流时两栏都画 —（R5-5） */
  const connected = (stateNow: AppState): boolean =>
    stateNow.sync === 'ready' || stateNow.transport === 'ready';

  const channelState = (stateNow: AppState, valid: boolean | undefined): MeterChannelState =>
    connected(stateNow) && !stale && valid !== false ? 'live' : 'unavailable';

  const paint = (): void => {
    if (disposed) return;
    frameId = null;
    const stateNow = store.get();
    const frame = latest;
    meter.render([
      {
        label: t('meter.input'),
        rms: frame?.inputRms ?? -96,
        peak: frame?.inputPeak ?? -96,
        state: channelState(stateNow, frame?.inputValid),
      },
      {
        label: t('meter.output'),
        rms: frame?.outputRms ?? -96,
        peak: frame?.outputPeak ?? -96,
        state: channelState(stateNow, frame?.outputValid),
        // 输出峰值不再显示（2026-11-21 问题单第 10 条：演示时说不清它是什么）
        showPeak: false,
      },
    ]);
  };
  const schedulePaint = (): void => {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(paint);
  };
  const offLevels = transport.onLevels((frame) => {
    latest = frame;
    stale = false;
    lastLevelAt = Date.now();
    schedulePaint();
  });

  /**
   * 设备静默不会自己报错（轮询超时只丢本次，S-f），因此用电平帧的新鲜度兜底：
   * 真机通道超过 1 s 没有电平就把两栏清成 —，用户据此判断"设备没说话了"（R5-3）。
   * Mock 通道 50Hz 常供，这个看门狗对它无影响。
   */
  const staleTimer = window.setInterval(() => {
    if (disposed) return;
    if (store.channelKind() !== 'webhid') return;
    if (lastLevelAt === 0 || Date.now() - lastLevelAt <= LEVEL_STALE_MS) return;
    if (stale) return;
    stale = true;
    schedulePaint();
  }, STALE_CHECK_MS);

  /** 右上角标记 + 设备行：通道一变（连上 / 断开）就更新，不等到下一帧电平 */
  const syncChannelBadge = (): void => {
    const mock = store.channelKind() === 'mock';
    const stateNow = store.get();
    const badgeText = mock
      ? t('sync.badge.demo')
      : stateNow.sync === 'syncing'
        ? t('sync.badge.syncing')
        : stateNow.sync === 'error'
          ? t('sync.phase.error')
          : '';
    if (syncTag) {
      syncTag.textContent = badgeText;
      syncTag.hidden = badgeText.length === 0;
    }
    // 真机：名字取设备信息区（为空时退回型号码 / "已连接"），副标题写固件版本 + 同步相位，
    // 不再出现"已连接 / 已连接"这种两行说同一件事
    const snapshot = mock ? null : (deviceInfo?.snapshot() ?? null);
    const named = snapshot?.deviceName.trim() || snapshot?.modelCode.trim() || '';
    deviceName.textContent = mock ? t('console.device.demo') : named || t('sync.source.device');
    const phase = t(`sync.phase.${stateNow.sync}`);
    deviceState.textContent = mock
      ? t('console.device.connected')
      : stateNow.transport !== 'ready'
        ? t('common.unavailable')
        : snapshot
          ? `${t('console.device.firmware', { version: firmwareText(snapshot) })} · ${phase}`
          : phase;
    let tone = 'idle';
    if (mock) tone = 'demo';
    else if (stateNow.transport === 'error' || stateNow.sync === 'error') tone = 'error';
    else if (stateNow.transport === 'ready' && stateNow.sync === 'ready') tone = 'ok';
    deviceRow.dataset.tone = tone;
  };
  const offDeviceInfo = deviceInfo?.onChange(() => syncChannelBadge());

  // ---- 状态回填 ------------------------------------------------------------
  const unsubscribe = store.onChange((next) => {
    for (const [id, entry] of gainValues) {
      entry.node.textContent = formatValue(entry.spec, next.params[id] ?? entry.spec.default);
    }
    for (const row of thresholdRows) {
      row.slider.setValue(next.params[row.threshold.id] ?? row.threshold.default);
      setResetDisabled(row.slider.root, store.isParamAtSceneTarget(row.threshold.id), row.threshold.id);
      if (row.enableId) {
        row.slider.setToggle?.((next.params[row.enableId] ?? 0) === 1);
        const toggle = row.slider.root.querySelector<HTMLElement>('.macro-toggle');
        if (toggle) setResetDisabled(toggle, store.isParamAtSceneTarget(row.enableId), row.enableId);
      }
    }
    for (const [id, node] of inputSwitchById) {
      setSwitchChecked(node, (next.params[id] ?? 0) === 1);
      setResetDisabled(node, store.isParamAtSceneTarget(id));
    }
    setSwitchChecked(encSwitch, (next.params['enc.OnOff'] ?? 0) === 1);
    setSegmentedValue(encLevel, next.params['enc.Level'] ?? 1);
    // 灯效与高级参数共用同一参数：两边任改一处，这里都要跟着回填
    setSwitchChecked(lightSwitch, (next.params['rgb.OnOff'] ?? 0) === 1);
    setSegmentedValue(lightMode, next.params['rgb.Mode'] ?? 0);
    setResetDisabled(encSwitch, store.isParamAtSceneTarget('enc.OnOff'));
    setResetDisabled(encLevelRow, store.isParamAtSceneTarget('enc.Level'));
    // 拖曲线 / 单段恢复 / 均衡器复位都会换掉 bands，统一经这里对齐场景覆盖表
    if (next.bands !== lastBands) {
      lastBands = next.bands;
      persistCustomGains(next.bands);
    }
    syncScene(next);
    syncTone(next);
    syncBands(next);
    syncChannelBadge();
    schedulePaint();
    // 链路恢复（sync 回到 ready）就把"超时/断开"那条常驻提示收起来
    if (noticePersistent && next.sync === 'ready') hideNotice();
  });

  syncScene(state);
  syncTone(state);
  syncChannelBadge();
  paint();
  window.requestAnimationFrame(() => renderCanvas());

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    disposed = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    window.clearInterval(staleTimer);
    clearNoticeTimer();
    store.removeEventListener(LOCAL_ERROR_EVENT, onLocalError);
    store.removeEventListener(PARAM_CHANGED_EVENT, onParamChanged);
    store.removeEventListener(SCENES_CLEARED_EVENT, onScenesCleared);
    offTransportError();
    offDeviceInfo?.();
    offLevels();
    unsubscribe();
    detachEq();
    observer.disconnect();
    meter.destroy();
  };

  return root;
}
