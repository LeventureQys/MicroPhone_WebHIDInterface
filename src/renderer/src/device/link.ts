import { t } from '../i18n';
import { loadChannelConfig } from '../domain/channel-config';
import type { AppStore } from '../domain/state';
import type { EqBand, EqFilterType } from '../eq/types';
import type { ChannelTransport } from './channel-transport';
import type { MockTransport } from './mock-transport';
import type { ReportIds } from './protocol';
import type { Clock, Timers } from './proto/timing';
import { EQ_BAND_COUNT, eqBandAddr, findRegister } from './registers';
import type {
  DeviceSnapshot,
  DeviceBoundTransport,
  ParamEcho,
  ParamReadResult,
  SyncPhase,
  Transport,
} from './transport';
import { WebHidTransport } from './webhid-transport';
import { errorKeyOf } from './webhid/session';
import type { WebHidSession } from './webhid/session';
import type { WebHidDeviceHandle, WebHidErrorCode, WebHidMode, WebHidUsageFilter } from './webhid/types';

export type LinkStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'dfu';

/**
 * 待翻译文案：只存 i18n 键与变量，不存译文。
 *
 * 理由：`t()` 取的是全局当前语言，若在 `DeviceLink` 里翻译，切语言后这些字符串会停在旧语言；
 * 由视图层在渲染时调 `formatLinkText()` 才是"文案只经 t() 出口"。
 */
export interface LinkText {
  readonly key: string;
  readonly vars?: Readonly<Record<string, string | number>>;
}

export interface LinkState {
  readonly status: LinkStatus;
  readonly mode: WebHidMode;
  readonly deviceId: string | null;
  readonly sync: SyncPhase;
  /** 失败文案的键（`device.error.<code>`）；视图层用 `formatLinkText()` 渲染 */
  readonly error: LinkText | null;
  readonly errorCode: WebHidErrorCode | null;
  readonly device: DeviceSnapshot | null;
  /** 软告警：型号码不匹配、升级后版本未变等，不阻断连接 */
  readonly warning: LinkText | null;
}

export interface DeviceLinkOptions {
  readonly session: WebHidSession;
  readonly channel: ChannelTransport;
  readonly mock: MockTransport;
  readonly store: AppStore;
  /** DFU 流程（4.2）注入用：等待/超时按它们走，单测可换假时钟 */
  readonly timers?: Timers;
  readonly clock?: Clock;
  /** 单测注入：给定设备句柄返回 Transport，缺省构造 WebHidTransport */
  readonly createTransport?: (device: WebHidDeviceHandle) => Transport;
}

export const LINK_CHANGE_EVENT = 'change';

/** 设备信息的型号码；不一致只告警不阻断（R4-3） */
export const EXPECTED_MODEL_CODE = 'JYM001';

function sameFirmware(
  left: DeviceSnapshot['firmware'],
  right: DeviceSnapshot['firmware'],
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z && left.build === right.build;
}

function sameText(left: LinkText | null, right: LinkText | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.key === right.key && JSON.stringify(left.vars ?? {}) === JSON.stringify(right.vars ?? {});
}

function sameState(left: LinkState, right: LinkState): boolean {
  return (
    left.status === right.status &&
    left.mode === right.mode &&
    left.deviceId === right.deviceId &&
    left.sync === right.sync &&
    sameText(left.error, right.error) &&
    left.errorCode === right.errorCode &&
    left.device === right.device &&
    sameText(left.warning, right.warning)
  );
}

/** 视图层渲染入口：把 `LinkText` 变成当前语言的字符串（`t()` 只在视图层调用） */
export function formatLinkText(text: LinkText | null): string | null {
  return text === null ? null : t(text.key, text.vars);
}

/**
 * 设备连接编排：把 WebHID 会话、通道门面、AppStore 串成一条链路。
 *
 * 只做"什么时候切通道、什么时候回读、失败怎么退"这三件事；
 * 报文怎么编、超时怎么算在 3.1 的 `ParamSession`，设备怎么开关在 `WebHidSession`。
 * 订阅方（顶栏 / 设备抽屉 / 固件抽屉）只看 `LinkState`。
 */
export class DeviceLink extends EventTarget {
  private readonly _session: WebHidSession;
  private readonly _channel: ChannelTransport;
  private readonly _mock: MockTransport;
  private readonly _store: AppStore;
  private readonly _createTransport?: (device: WebHidDeviceHandle) => Transport;

  private _state: LinkState;
  private _transport: Transport | null = null;
  private _detachers: Array<() => void> = [];
  private _firmwareBeforeDfu: DeviceSnapshot['firmware'] | null = null;

  constructor(options: DeviceLinkOptions) {
    super();
    this._session = options.session;
    this._channel = options.channel;
    this._mock = options.mock;
    this._store = options.store;
    this._createTransport = options.createTransport;
    this._state = Object.freeze({
      status: 'idle',
      mode: options.session.getState().mode,
      deviceId: null,
      sync: 'idle',
      error: null,
      errorCode: null,
      device: null,
      warning: null,
    });
    // 会话被整体拆掉（用户点断开 / 桥接失败）时也要降级：句柄已失效，链路不能继续装作 ready
    options.session.onChange((sessionState) => {
      if (sessionState.status !== 'idle' && sessionState.status !== 'error') return;
      if (this._state.status === 'ready' || this._state.status === 'dfu') this._handleDrop();
    });
  }

  getState(): LinkState {
    return this._state;
  }

  onChange(cb: (state: LinkState) => void): () => void {
    const handler = (event: Event): void => {
      cb((event as CustomEvent<LinkState>).detail);
    };
    this.addEventListener(LINK_CHANGE_EVENT, handler);
    return () => {
      this.removeEventListener(LINK_CHANGE_EVENT, handler);
    };
  }

  /**
   * 打开设备并接管参数链路：open → channel.use(webhid) → 回读 → 回填 store → ready。
   * 失败一律降级回 Mock 并保留可读文案，不向调用方抛出（界面只关心状态）。
   */
  async attach(deviceId: string): Promise<void> {
    if (this._state.status === 'connecting') return;
    this._patch({
      status: 'connecting',
      mode: this._session.getState().mode,
      deviceId,
      sync: 'syncing',
      error: null,
      errorCode: null,
      warning: null,
    });
    this._store.setSync('syncing');

    const handle = this._session.handleOf(deviceId);
    if (handle === null) {
      this._fail('device');
      return;
    }

    try {
      if (!handle.opened) await this._session.openDevice(deviceId);
      const transport = this._createTransport
        ? this._createTransport(handle)
        : new WebHidTransport({ device: handle, reportIds: reportIdsFromConfig() });
      this._transport = transport;
      // 先接上通道与监听再 open()：`open()` 里要做全量回读，失败时 `ParamSession.failFatal`
      // 会留下解释原因的诊断帧。若等 open() 之后再 `use()`，这些帧就没有订阅者，
      // 联调时诊断卡是空的（真机联调实测）。写请求不受影响——回读期间在途请求占着队列，
      // 写只能排队等它结束。
      this._listen(transport);
      this._channel.use(transport);
      await transport.open();
      if (transport.state() !== 'ready') {
        this._fail('device');
        return;
      }
      this._store.setSync('syncing');
      this._patch({ sync: 'syncing' });

      const result = await transport.readAll();
      this._applyReadback(result);
      this._store.setSync('ready');
      this._patch({
        status: 'ready',
        sync: 'ready',
        device: result.device,
        warning: this._mismatchWarning(result.device),
      });
    } catch {
      this._fail('device');
    }
  }

  /**
   * 当前活动的设备通道；mock 或未连接时返回 null。
   * 4.2 的 DFU 会话用它直接收发报告（`device` / `reportIds` / `onInputBytes`）。
   */
  transport(): DeviceBoundTransport | null {
    const transport = this._transport;
    return transport instanceof WebHidTransport ? transport : null;
  }

  /** 断开设备并回到演示数据；`store.sync` 回 idle，顶栏随即显示"演示数据" */
  async detach(): Promise<void> {
    const deviceId = this._state.deviceId;
    this._channel.use(this._mock);
    this._store.setSync('idle');
    this._disposeTransport();
    if (deviceId !== null) void this._session.closeDevice(deviceId);
    this._patch({
      status: 'idle',
      deviceId: null,
      device: null,
      sync: 'idle',
      error: null,
      errorCode: null,
      warning: null,
    });
  }

  /**
   * 真机通道：把白名单里的 usage 过滤交给 `requestDevice({ filters })`。
   * 不传 filters 时读当前通道配置（`micstudio.whitelist`），保证界面按钮与设置页同源。
   */
  async requestNativeDevice(filters?: readonly WebHidUsageFilter[]): Promise<void> {
    const entries =
      filters ??
      loadChannelConfig().whitelist.map((entry) => ({
        usagePage: entry.usagePage,
        usage: entry.usage,
      }));
    await this._session.requestNativeDevice(entries);
  }

  /** DFU 前：停轮询、停写队列；状态置 dfu，参数卡据此提示"升级中" */
  async suspendForDfu(): Promise<void> {
    this._firmwareBeforeDfu = this._state.device?.firmware ?? null;
    this._patch({ status: 'dfu' });
    const transport = this._transport;
    if (transport instanceof WebHidTransport) await transport.suspend();
  }

  /** DFU 后：恢复会话并全量回读；版本号没变时给软告警（R4-7） */
  async resumeAfterDfu(): Promise<void> {
    const transport = this._transport;
    if (transport === null) {
      this._fail('device');
      return;
    }
    const before = this._firmwareBeforeDfu;
    try {
      if (transport instanceof WebHidTransport) await transport.resume();
      else await transport.open();
      if (transport.state() !== 'ready') {
        this._fail('device');
        return;
      }
      const result = await transport.readAll();
      this._applyReadback(result);
      this._store.setSync('ready');
      const firmware = result.device?.firmware ?? null;
      const unchanged = firmware !== null && before !== null && sameFirmware(firmware, before);
      this._patch({
        status: 'ready',
        sync: 'ready',
        device: result.device ?? this._state.device,
        warning: unchanged ? { key: 'fw.warn.versionUnchanged' } : null,
      });
    } catch {
      this._fail('device');
    } finally {
      this._firmwareBeforeDfu = null;
    }
  }

  // ---- 回读回填 ----------------------------------------------------------

  private _applyReadback(result: ParamReadResult): void {
    for (const [id, value] of Object.entries(result.preset)) this._store.applyEcho(id, value);
    if (result.bands) this._applyBands(result.bands);
  }

  /**
   * 设备主动上报回填：与回读同一语义（覆盖本地值、不发帧），只是可以发生在任意时刻。
   *
   * 走 `applyEcho` / `applyBands` 而不是 `setParam` / `setBands`——后两者是用户改动的入口，
   * 会差异对比后写回设备，设备上报再触发写帧就成了写环。
   */
  private _applyEcho(echo: ParamEcho): void {
    if (echo.kind === 'param') {
      this._store.applyEcho(echo.id, echo.value);
      return;
    }
    // `_applyBands` 认的是寄存器字段名（`band1.gain`），与回读同一条路径
    this._applyBands({ [`band${echo.band}.${echo.field}`]: echo.value });
  }

  /** EQ 可调段 1–7 覆盖本地段；7–13 是设备内部段，保持本地值（B7） */
  private _applyBands(values: Readonly<Record<string, number>>): void {
    const next: EqBand[] = this._store.get().bands.map((band) => ({ ...band }));
    for (let index = 0; index < EQ_BAND_COUNT; index += 1) {
      const band = next[index];
      if (!band) continue;
      const type = readBandField(values, index, 'type');
      const freq = readBandField(values, index, 'freq');
      const gain = readBandField(values, index, 'gain');
      const q = readBandField(values, index, 'q');
      if (type !== undefined) band.type = type as EqFilterType;
      if (freq !== undefined) band.freq = freq;
      if (gain !== undefined) band.gain = gain;
      if (q !== undefined) band.q = q;
    }
    this._store.applyBands(next);
  }

  private _mismatchWarning(device: DeviceSnapshot | null): LinkText | null {
    if (device === null) return null;
    // 信息区为空时 modelCode 是空串：真机 V0.0.2 就是这样，此时说「不匹配」会在界面上
    // 挂一句没有型号的警告，用户与现场都无从判断，所以单独给一条「未返回型号」。
    if (device.modelCode.trim() === '') return { key: 'device.warn.modelMissing' };
    if (device.modelCode === EXPECTED_MODEL_CODE) return null;
    return { key: 'device.warn.modelMismatch', vars: { code: device.modelCode } };
  }

  // ---- 通道监听与失败降级 ------------------------------------------------

  private _listen(transport: Transport): void {
    this._detachers = [
      transport.onSync((phase) => this._patch({ sync: phase })),
      // 设备主动上报（协议 0x10 设备→主机）：按键 / Mute / 预设切换等设备侧改动要能回到界面
      transport.onParamEcho((echo) => this._applyEcho(echo)),
      transport.onError((error) => {
        if (error.kind === 'disconnected') this._handleDrop();
      }),
    ];
  }

  private _detachListeners(): void {
    for (const off of this._detachers) off();
    this._detachers = [];
  }

  /**
   * 设备断开（拔线 / 请求连续超时 → 会话 error）：切回 Mock 让界面继续有数据，
   * 但状态留 error 并保留文案；不自动重连，等用户再点连接（任务书 §4.5 第 5 条）。
   */
  private _handleDrop(): void {
    if (this._state.status !== 'ready' && this._state.status !== 'dfu') return;
    this._channel.use(this._mock);
    this._disposeTransport();
    this._store.setSync('error');
    this._patch({
      status: 'error',
      sync: 'error',
      error: this._state.error ?? { key: errorKeyOf('device') },
      errorCode: this._state.errorCode ?? 'device',
    });
  }

  /** 失败统一入口：切回 Mock、停链路、置 error 文案键（code → `device.error.<code>`） */
  private _fail(code: WebHidErrorCode): void {
    this._channel.use(this._mock);
    this._disposeTransport();
    this._store.setSync('error');
    this._patch({
      status: 'error',
      sync: 'error',
      error: { key: errorKeyOf(code) },
      errorCode: code,
    });
  }

  private _disposeTransport(): void {
    this._detachListeners();
    const transport = this._transport;
    this._transport = null;
    if (transport === null) return;
    void transport.close().catch(() => {
      // 设备已消失时 close 失败没有意义，也不该盖住原始错误
    });
  }

  private _patch(partial: Partial<LinkState>): void {
    const next: LinkState = Object.freeze({ ...this._state, ...partial });
    if (sameState(next, this._state)) return;
    this._state = next;
    this.dispatchEvent(new CustomEvent<LinkState>(LINK_CHANGE_EVENT, { detail: this._state }));
  }
}

/** 通道配置里存的 report ID（`micstudio.reportId.out/in`，§5.15）；读不到走协议默认值 */
function reportIdsFromConfig(): ReportIds {
  const config = loadChannelConfig();
  return { out: config.reportIdOut, in: config.reportIdIn };
}

/** 取某段某字段的回读工程量（键为寄存器字段名，如 `band3.gain`） */
function readBandField(
  values: Readonly<Record<string, number>>,
  band: number,
  field: 'type' | 'freq' | 'gain' | 'q',
): number | undefined {
  const spec = findRegister(eqBandAddr(band, field));
  return spec ? values[spec.field] : undefined;
}
