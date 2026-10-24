import type { LevelFrame, Transport } from '../../device/transport';
import { findParam, type ParamSpec } from '../../domain/params';
import { matchScene, scenePatch, SCENES, type SceneId, type ScenePreset } from '../../domain/scenes';
import {
  EQ_PRESETS,
  denoiseStrengthFromThreshold,
  limitEnableOn,
  limitEnableValue,
  matchEqPreset,
  smoothnessFromThreshold,
  thresholdFromDenoiseStrength,
  thresholdFromSmoothness,
  type EqPresetId,
} from '../../domain/quick-controls';
import type { AppState, AppStore, LocalErrorDetail } from '../../domain/state';
import { LOCAL_ERROR_EVENT } from '../../domain/state';
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
  segmented,
  setSegmentedValue,
  setSwitchChecked,
  switchControl,
  type MacroSliderHandle,
} from '../controls';
import { MeterCanvas, type MeterChannelState } from '../meter';

export interface ConsoleApi {
  openDevice: () => void;
  openAdvanced: () => void;
}

const TONES: EqPresetId[] = ['flat', 'vocal', 'warm', 'bright', 'music'];
const EQ_MARGIN = { top: 14, right: 18, bottom: 30, left: 46 };

function compactCard(opts: { eyebrow?: string; title: string; tag?: string; desc?: string }): {
  root: HTMLElement;
  body: HTMLElement;
} {
  const built = card({
    eyebrow: opts.eyebrow ?? '',
    title: opts.title,
    tag: opts.tag,
    desc: opts.desc,
  });
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
  const valueNode = element('strong', 'console-gain-value', value);
  root.append(
    element('span', 'console-gain-label', label),
    valueNode,
    element('span', 'console-gain-unit', unit),
  );
  return { root, value: valueNode };
}

/**
 * 一屏工作台：电平、场景、三个常用调节、音色曲线与两个开关全部同屏，
 * 协议参数不在这里出现；需要细调时由顶栏打开「高级参数」抽屉。
 */
export function createConsoleView(
  store: AppStore,
  transport: Transport,
  api: ConsoleApi,
): HTMLElement {
  const state = store.get();

  const root = document.createElement('div');
  root.className = 'console';

  // ---- 电平 + 增益 + 设备 ------------------------------------------------
  const meterCard = compactCard({
    eyebrow: t('console.level.eyebrow'),
    title: t('console.level.title'),
    // 右上角标记随通道/相位变化：演示数据 / 同步中，ready 且真机时不显示（Q3）
    tag: t('sync.badge.demo'),
  });
  meterCard.root.classList.add('console-meter');
  const syncTag = meterCard.root.querySelector<HTMLElement>('.card-tag');

  const canvas = document.createElement('canvas');
  canvas.className = 'meter-canvas console-meter-canvas';
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

  const deviceRow = document.createElement('div');
  deviceRow.className = 'console-device-row';
  deviceRow.title = t('device.sync.note');
  const deviceText = document.createElement('div');
  deviceText.className = 'console-device-text';
  const deviceName = element('span', 'console-device-name', t('console.device.demo'));
  const deviceState = element('span', 'console-device-state', t('console.device.connected'));
  deviceText.append(deviceName, deviceState);
  const deviceButton = document.createElement('button');
  deviceButton.type = 'button';
  deviceButton.className = 'btn btn--ghost btn--small';
  deviceButton.textContent = t('console.device.short');
  deviceButton.addEventListener('click', () => api.openDevice());
  deviceRow.append(deviceText, deviceButton);

  meterCard.body.append(canvas, gainBox, deviceRow);

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
    button.append(
      element('strong', 'scene-name', t(`console.scene.${scene.id}`)),
      element('span', 'scene-desc', t(`console.scene.${scene.id}.desc`)),
    );
    button.addEventListener('click', () => applyScene(scene));
    sceneButtons.set(scene.id, button);
    sceneRow.append(button);
  }
  sceneCard.body.append(sceneRow);

  // ---- 快速调音 ------------------------------------------------------------
  const tuneCard = compactCard({ title: t('console.tune.title'), desc: t('console.tune.desc') });
  const tuneGrid = document.createElement('div');
  tuneGrid.className = 'tune-grid';

  const gateThreshold = findParam('noisegate.threshold_db');
  const compThreshold = findParam('comp.Threshold');
  let denoise: MacroSliderHandle | null = null;
  let evenness: MacroSliderHandle | null = null;

  if (gateThreshold) {
    denoise = macroSlider({
      label: t('console.denoise'),
      value: denoiseStrengthFromThreshold(state.params[gateThreshold.id] ?? gateThreshold.default),
      hint: t('console.hint.denoise'),
      onChange: (value) => store.setParam(gateThreshold.id, thresholdFromDenoiseStrength(value)),
    });
    denoise.root.dataset.macro = 'denoise';
    tuneGrid.append(denoise.root);
  }

  if (compThreshold) {
    evenness = macroSlider({
      label: t('console.evenness'),
      value: smoothnessFromThreshold(state.params[compThreshold.id] ?? compThreshold.default),
      hint: t('console.hint.evenness'),
      onChange: (value) => store.setParam(compThreshold.id, thresholdFromSmoothness(value)),
    });
    evenness.root.dataset.macro = 'evenness';
    tuneGrid.append(evenness.root);
  }

  const toneBlock = document.createElement('div');
  toneBlock.className = 'tone-block';
  const toneHead = document.createElement('div');
  toneHead.className = 'pfield-head';
  toneHead.append(element('span', 'pfield-label', t('console.tone')));
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
  tuneCard.body.append(tuneGrid);

  // ---- 音色曲线 ------------------------------------------------------------
  const eqCard = compactCard({
    eyebrow: t('console.eq.eyebrow'),
    title: t('console.eq.title'),
    tag: t('console.eq.tag'),
  });
  eqCard.root.classList.add('console-eq');
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'eq-canvas-wrap console-eq-wrap';
  const eqCanvas = document.createElement('canvas');
  eqCanvas.className = 'eq-canvas console-eq-canvas';
  canvasWrap.append(eqCanvas);
  const eqHint = element('p', 'eq-hint', t('console.eq.desc'));
  const advancedLink = document.createElement('button');
  advancedLink.type = 'button';
  advancedLink.className = 'console-link';
  advancedLink.textContent = t('console.eq.advanced');
  advancedLink.addEventListener('click', () => api.openAdvanced());
  eqCard.body.append(canvasWrap, eqHint, advancedLink);

  // ---- 快捷开关 ------------------------------------------------------------
  const switchCard = compactCard({ title: t('console.switch.title') });
  const switchGrid = document.createElement('div');
  switchGrid.className = 'switch-grid';

  const encGroup = document.createElement('div');
  encGroup.className = 'switch-item';
  const encSwitch = switchControl({
    checked: (state.params['enc.OnOff'] ?? 0) === 1,
    label: t('console.enc'),
    onChange: (checked) => store.setParam('enc.OnOff', checked ? 1 : 0),
  });
  const encLevel = segmented<number>({
    options: [0, 1, 2, 3].map((value) => ({ value, label: String(value) })),
    value: state.params['enc.Level'] ?? 1,
    onChange: (value) => store.setParam('enc.Level', value),
  });
  encLevel.classList.add('segmented--compact');
  encGroup.append(encSwitch, encLevel);

  const limitGroup = document.createElement('div');
  limitGroup.className = 'switch-item';
  // 防爆音走真实使能位 `limit.Enable`（C-15）：阈值不再被当成开关用，高级参数里可单独调
  const limitSwitch = switchControl({
    checked: limitEnableOn(state.params['limit.Enable'] ?? 0),
    label: t('console.limiter'),
    onChange: (checked) => store.setParam('limit.Enable', limitEnableValue(checked)),
  });
  const limitHint = element('p', 'macro-hint', t('console.limiter.hint'));
  limitGroup.append(limitSwitch, limitHint);

  switchGrid.append(encGroup, limitGroup);
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
  // 初始显隐交给下面的 setNoticeVisible(false)，避免两处各写一次 hidden 造成状态漂移
  noticeBar.style.cssText = [
    'position: fixed',
    'top: 74px',
    'left: 50%',
    'transform: translateX(-50%)',
    'z-index: 60',
    // 刻意不写 display：内联 display 会盖掉 [hidden]{display:none}，
    // 导致 hidden=true 时仍画出 30×18 的空胶囊。显隐一律走 setNoticeVisible。
    'align-items: center',
    'gap: 8px',
    'max-width: min(640px, 82vw)',
    'padding: 8px 14px',
    'border-radius: 10px',
    'border: 1px solid rgba(246, 154, 154, 0.55)',
    'background: rgba(32, 20, 24, 0.94)',
    'color: var(--text, #e7ebf2)',
    'font-size: 12.5px',
    'line-height: 1.35',
    'pointer-events: none',
    'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45)',
  ].join(';');
  const noticeText = element('span', 'console-notice-text', '');
  noticeBar.append(noticeText);

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
  function applyScene(scene: ScenePreset): void {
    const patch = scenePatch(scene);
    for (const [id, value] of Object.entries(patch.params)) store.setParam(id, value);
    const bands = store.get().bands;
    store.setBands(
      bands.map((band, index) =>
        index < patch.gains.length ? { ...band, gain: patch.gains[index] } : { ...band },
      ),
    );
  }

  function applyTone(id: EqPresetId): void {
    const gains = EQ_PRESETS[id];
    const bands = store.get().bands;
    store.setBands(
      bands.map((band, index) =>
        index < gains.length ? { ...band, gain: gains[index] } : { ...band },
      ),
    );
  }

  function syncScene(stateNow: ReturnType<AppStore['get']>): void {
    const active = matchScene(stateNow.params, stateNow.bands);
    for (const [id, button] of sceneButtons) {
      const on = id === active;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  function syncTone(stateNow: ReturnType<AppStore['get']>): void {
    const active = matchEqPreset(stateNow.bands, 7);
    for (const [id, button] of toneButtons) {
      const on = id === active;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
    }
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
    });
  }

  const detachEq = attachEqInteractions({
    canvas: eqCanvas,
    model,
    mapper: mapperProxy,
    onChange: () => {
      renderCanvas();
      store.setBands(model.allBands());
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
    deviceName.textContent = mock ? t('console.device.demo') : t('sync.source.device');
    deviceState.textContent = mock
      ? t('console.device.connected')
      : stateNow.transport === 'ready'
        ? t('sync.source.device')
        : t('common.unavailable');
  };

  // ---- 状态回填 ------------------------------------------------------------
  const unsubscribe = store.onChange((next) => {
    for (const [id, entry] of gainValues) {
      entry.node.textContent = formatValue(entry.spec, next.params[id] ?? entry.spec.default);
    }
    if (denoise && gateThreshold) {
      denoise.setValue(denoiseStrengthFromThreshold(next.params[gateThreshold.id] ?? gateThreshold.default));
    }
    if (evenness && compThreshold) {
      evenness.setValue(smoothnessFromThreshold(next.params[compThreshold.id] ?? compThreshold.default));
    }
    setSwitchChecked(encSwitch, (next.params['enc.OnOff'] ?? 0) === 1);
    setSegmentedValue(encLevel, next.params['enc.Level'] ?? 1);
    const guard = limitEnableOn(next.params['limit.Enable'] ?? 0);
    setSwitchChecked(limitSwitch, guard);
    limitHint.textContent = guard ? t('console.hint.limitOn') : t('console.hint.limitOff');
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
    offTransportError();
    offLevels();
    unsubscribe();
    detachEq();
    observer.disconnect();
    meter.destroy();
  };

  return root;
}
