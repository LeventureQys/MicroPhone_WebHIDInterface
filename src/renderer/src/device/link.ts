import { t } from '../i18n';
import { loadChannelConfig } from '../domain/channel-config';
import type { AppStore } from '../domain/state';
import type { EqBand, EqFilterType } from '../eq/types';
import { audioErrorKind } from './audio-meter';
import type { AudioInputDevice, AudioMeterErrorKind, AudioMeterInfo } from './audio-meter';
import type { ChannelTransport } from './channel-transport';
import { ReadonlyGainFilter } from './gain-filter';
import type { MockTransport } from './mock-transport';
import type { ReportIds } from './protocol';
import { TIMING, defaultClock, defaultTimers, type Clock, type Timers } from './proto/timing';
import { EQ_BAND_COUNT, eqBandAddr, findRegister } from './registers';
import type {
  DeviceSnapshot,
  DeviceBoundTransport,
  LevelFrame,
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
  /** 电平来源：真实固件不上报 `0x2057`，改成采同一台设备的音频输入 */
  readonly audio?: LinkAudioState | null;
}

/**
 * 电平来源状态。
 *
 * `source: 'audio'` 表示正在用设备音频输入算电平；`'device'` 表示退回设备上报的 `0x2057`
 * （权限被拒 / 设备确实不在系统里）；`'retrying'` 表示**设备还在**、只是音频端点或采集
 * 正被重新打开（拔插 / 驱动重载后的自愈状态）。只有 `'device'` 会打开设备轮询。
 */
export interface LinkAudioState {
  readonly label: string | null;
  readonly source: 'audio' | 'device' | 'retrying';
  /** 是否按提示词命中同一台声卡；false 表示退回系统默认输入 */
  readonly matched?: boolean;
  readonly error?: AudioMeterErrorKind;
}

/**
 * 外部电平源（`AudioLevelMeter` 满足它）：`start()` 打开音频输入并开始出帧，
 * `stop()` 关掉，`onLevels()` 与 `Transport` 同形。
 *
 * 后四个方法是可选的"自愈"能力：拔插后音频端点会先消失再回来，`DeviceLink` 靠它们判断
 * "系统里还有没有这台设备的音频输入"，以及"现在这一路采集是不是已经死了"。
 */
export interface AudioLevelSource {
  start(
    hints: readonly string[],
    options?: { readonly strict?: boolean },
  ): Promise<AudioMeterInfo>;
  stop(): void;
  onLevels(cb: (frame: LevelFrame) => void): () => void;
  /** 采集被系统断开时通知（拔线 / 驱动重载） */
  onLost?(cb: () => void): () => void;
  /** 当前采集是否还活着；缺省按"活着"处理（只依赖 `onLost`） */
  healthy?(): boolean;
  /** 系统里现在有没有这台设备的音频端点（只读枚举） */
  find?(hints: readonly string[]): Promise<AudioInputDevice | null>;
  /** 系统音频设备表变化（插拔 / 驱动重载） */
  watchDevices?(cb: () => void): () => void;
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
  /**
   * 外部电平源：真机固件不上报 `0x2057` 时，用同一台设备的音频输入算电平。
   * 缺省不启用（单测与无麦克风环境退化成设备上报）。
   */
  readonly audioLevels?: AudioLevelSource;
  /**
   * 音频输入自检周期（默认 2 s）：设备还在系统里就重新打开采集，别停在"没电平"上。
   * 只在连接就绪时运行；插拔事件（`devicechange`）会额外立刻触发一次。
   */
  readonly audioWatchMs?: number;
  /** 音频输入打开失败后的首次重试间隔（默认 300 ms，之后指数退避、封顶 5 s） */
  readonly audioRetryMs?: number;
  /** 诊断日志出口（音频输入断开 / 重开的过程）；缺省静默 */
  readonly onEvent?: (message: string) => void;
}

export const LINK_CHANGE_EVENT = 'change';

/** 设备信息的型号码；不一致只告警不阻断（R4-3） */
export const EXPECTED_MODEL_CODE = 'JYM001';
/** M001 的 USB 身份：后台自动连接只认这一对 */
export const EXPECTED_VENDOR_ID = 0x0a67;
export const EXPECTED_PRODUCT_ID = 0x0010;

/**
 * 只读增益（设备 ADC 检出）回填前先去抖：不受控的采样噪声只影响显示，
 * 不该让工作台的数字持续跳动（2026-11-13 反馈）。
 */
const READONLY_GAIN_IDS = new Set(['gain.Mic', 'gain.Hp']);

/** 音频输入自检周期：设备还在时发现采集断了就重开 */
const AUDIO_WATCH_MS = 2000;
/** 音频输入打开失败后的首次重试间隔；之后翻倍，封顶 `AUDIO_RETRY_MAX_MS` */
const AUDIO_RETRY_MS = 300;
const AUDIO_RETRY_MAX_MS = 5000;
/** 一次拔插会连发多条 `devicechange`：合并成一拍再查，避免连着开两路采集 */
const AUDIO_DEVICE_SETTLE_MS = 300;

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

function sameAudio(
  left: LinkAudioState | null | undefined,
  right: LinkAudioState | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.label === b.label && a.source === b.source && a.matched === b.matched && a.error === b.error;
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
    sameText(left.warning, right.warning) &&
    sameAudio(left.audio, right.audio)
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
  private readonly _audioLevels?: AudioLevelSource;
  private readonly _audioWatchMs: number;
  private readonly _audioRetryMs: number;
  private readonly _onEvent?: (message: string) => void;
  /** 只读增益（ADC 检出）显示去抖；重连时清空，不带上一台设备的采样 */
  private readonly _gainFilter = new ReadonlyGainFilter();

  private _state: LinkState;
  private _transport: Transport | null = null;
  private _detachers: Array<() => void> = [];
  private _firmwareBeforeDfu: DeviceSnapshot['firmware'] | null = null;
  /** 重枚举轮询与超时走注入时钟，单测可把 8 s 压成毫秒 */
  private readonly _timers: Timers;
  private readonly _clock: Clock;
  /**
   * 正在 attach：这期间参数会话超时派发的 `disconnected` 不能当成"设备掉了"，
   * 由 `attach()` 自己决定是彻底失败还是保留句柄给 DFU（设备可能停在 Bootloader）。
   */
  private _attaching = false;
  private _factoryReset: Promise<void> | null = null;

  // ---- 音频电平自愈：设备还在系统里就重开音频输入，不退回恒 0 的 0x2057 ----------
  /** 音频输入自检 / 重试定时器（只排一个，到点前有更早的请求会重排） */
  private _audioTimer: unknown = null;
  private _audioDueAt: number | null = null;
  /** 正在异步打开音频输入：并发调用合并，完成后按 `_audioAgain` 再补一拍 */
  private _audioBusy = false;
  private _audioAgain = false;
  /** 连续打开失败次数（退避用）；成功或重新 attach 归零 */
  private _audioAttempts = 0;
  /** 权限被拒是硬失败：不再空转重试，等设备重新连接 / 音频设备表变化 */
  private _audioParked = false;
  /** 断开 / 换设备时递增：晚到的打开结果不能再接到新链路上 */
  private _audioGeneration = 0;
  /** 当前采集命中的端点 id：设备端点被系统重建（id 变了）时据此换采集 */
  private _audioInputId: string | null = null;
  private _audioWatchBound = false;
  private _audioLostOff: (() => void) | null = null;
  private _audioDevicesOff: (() => void) | null = null;

  constructor(options: DeviceLinkOptions) {
    super();
    this._session = options.session;
    this._channel = options.channel;
    this._mock = options.mock;
    this._store = options.store;
    this._createTransport = options.createTransport;
    this._audioLevels = options.audioLevels;
    this._audioWatchMs = Math.max(50, options.audioWatchMs ?? AUDIO_WATCH_MS);
    this._audioRetryMs = Math.max(20, options.audioRetryMs ?? AUDIO_RETRY_MS);
    this._onEvent = options.onEvent;
    this._timers = options.timers ?? defaultTimers();
    this._clock = options.clock ?? defaultClock();
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
    // 音频采集自己断了（track ended）与音频设备表变化都要立刻查一次；
    // 不依赖 2 s 的自检周期，拔插后能马上重开
    this._bindAudioWatch();
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
   * 打不开设备时降级回 Mock；打开成功但参数同步失败时保留原始通道（设备可能停在 Bootloader，
   * 固件升级还要用它），参数链路按 error 降级，不向调用方抛出。
   */
  async attach(deviceId: string): Promise<void> {
    if (this._state.status === 'connecting' || this._state.status === 'dfu' || this._factoryReset !== null) return;
    this._attaching = true;
    // 重连期间先把旧的电平采集停掉：不然拔插后会同时开着两路麦克风
    this._stopAudioLevels();
    // 上一轮设备/上一次连接的 ADC 采样不能带进新一轮，否则首帧会被旧中位数拖住
    this._gainFilter.reset();
    try {
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

      const handle = await this._openHandle(deviceId);
      if (handle === null) {
        this._fail('device');
        return;
      }

      try {
        const transport = this._prepareTransport(handle);
        // 先接上通道与监听再 open()：`open()` 里要做全量回读，失败时 `ParamSession.failFatal`
        // 会留下解释原因的诊断帧。若等 open() 之后再 `use()`，这些帧就没有订阅者，
        // 联调时诊断卡是空的（真机联调实测）。写请求不受影响——回读期间在途请求占着队列，
        // 写只能排队等它结束。
        await transport.open();
        if (transport.state() !== 'ready') {
          // 句柄已经打开、只是参数协议没人答：设备很可能停在 Bootloader（升级失败/首刷中断）。
          // 这时把句柄丢掉就再也救不回来——保留原始通道，固件抽屉仍能继续升级。
          if (transport instanceof WebHidTransport && transport.device.opened) this._failSync();
          else this._fail('device');
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
        // 真机固件不上报 0x2057：连接成功后开始采同一台设备的音频输入（异步，不阻塞 ready）
        void this._startAudioLevels();
      } catch {
        const current = this._transport;
        if (current instanceof WebHidTransport && current.device.opened) this._failSync();
        else this._fail('device');
      }
    } finally {
      this._attaching = false;
    }
  }

  /**
   * 取一根能用的句柄：会话表里那根打不开时（拔线后旧 `HIDDevice` 已随设备销毁）刷新一次
   * 设备表再试。真机拔插后系统给的是**新的** `HIDDevice`，不刷新就会一直"打开失败"，
   * 用户只能重开 app（真机 2026-11 反馈）。
   *
   * 刷新后 id 若漂移（真机 id 带枚举序位），按 VID/PID 找同一台并把 link 的 deviceId 改过去。
   */
  private async _openHandle(deviceId: string): Promise<WebHidDeviceHandle | null> {
    const first = this._session.handleOf(deviceId);
    if (first === null) return null;
    if (first.opened) return first;
    await this._session.openDevice(deviceId);
    if (first.opened) return first;

    await this._session.refresh();
    const direct = this._session.handleOf(deviceId);
    if (direct !== null && direct !== first) {
      if (!direct.opened) await this._session.openDevice(deviceId);
      if (direct.opened) return direct;
    }

    const moved = this._locateDevice(first);
    if (moved === null) return null;
    if (!moved.handle.opened) await this._session.openDevice(moved.id);
    if (!moved.handle.opened) return null;
    if (moved.id !== deviceId) this._patch({ deviceId: moved.id });
    return moved.handle;
  }

  /**
   * 当前活动的设备通道；mock 或未连接时返回 null。
   * 4.2 的 DFU 会话用它直接收发报告（`device` / `reportIds` / `onInputBytes`）。
   */
  transport(): DeviceBoundTransport | null {
    const transport = this._transport;
    return transport instanceof WebHidTransport ? transport : null;
  }

  async factoryReset(): Promise<void> {
    const transport = this._transport;
    if (
      this._state.status !== 'ready' ||
      !(transport instanceof WebHidTransport) ||
      this._factoryReset !== null
    ) {
      throw new Error('设备参数通道尚未就绪');
    }
    this._factoryReset = transport.factoryReset().then((result) => {
      if (this._transport !== transport || this._state.status !== 'ready') {
        throw new Error('设备已断开');
      }
      this._gainFilter.reset();
      this._applyReadback(result);
      this._store.applyBypass('eq', false);
      this._patch({ device: result.device, warning: this._mismatchWarning(result.device) });
    });
    try {
      await this._factoryReset;
    } finally {
      this._factoryReset = null;
    }
  }

  /** 断开设备并回到演示数据；`store.sync` 回 idle，顶栏随即显示"演示数据" */
  async detach(): Promise<void> {
    const deviceId = this._state.deviceId;
    this._stopAudioLevels();
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

  /** 拆掉后台音频监听并停采集：应用退出 / 单测收尾用（不改变链路状态） */
  dispose(): void {
    this._stopAudioLevels();
    this._audioLostOff?.();
    this._audioLostOff = null;
    this._audioDevicesOff?.();
    this._audioDevicesOff = null;
    this._audioWatchBound = false;
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
    if (this._factoryReset !== null) {
      await this._factoryReset.catch(() => undefined);
      if (this._transport === null) throw new Error('设备已断开');
    }
    this._firmwareBeforeDfu = this._state.device?.firmware ?? null;
    this._patch({ status: 'dfu' });
    this._stopAudioLevels();
    const transport = this._transport;
    if (transport instanceof WebHidTransport) await transport.suspend();
  }

  /**
   * 等设备复位后重新枚举，并把 transport 的句柄换成新出现的那个。
   *
   * 协议事实（DFU 协议 1026 §1/§6）：写 `0x1008=1` 后约 200 ms 设备复位，1–3 s 重新枚举；
   * 旧 `HIDDevice` 已失效，必须重开句柄才能发信息帧 / 回读版本。
   * 虚拟通道的设备表是桥启动时一次性建好的（没有注册/注销接口），不会真重枚举，直接返回。
   */
  async awaitReenumeration(): Promise<void> {
    const session = this._session;
    const deviceId = this._state.deviceId;
    const transport = this._transport;
    if (session === null || deviceId === null || transport === null) {
      throw new Error('设备尚未连接，无法等待升级模式重新枚举');
    }
    if (session.getState().mode === 'virtual' || !(transport instanceof WebHidTransport)) return;

    const previous = transport.device;
    const deadline = this._clock.now() + TIMING.dfuReenumTimeoutMs;
    while (this._clock.now() < deadline) {
      await this._delay(TIMING.dfuReenumPollMs);
      await session.refresh();
      const replacement = this._findReplacement(deviceId, previous);
      if (replacement === null) continue;
      if (!replacement.handle.opened) await session.openDevice(replacement.id);
      if (!replacement.handle.opened) continue;
      await transport.reopen(replacement.handle);
      if (transport.state() !== 'ready') {
        throw new Error(`重新打开设备 ${replacement.id} 失败`);
      }
      this._patch({ deviceId: replacement.id });
      return;
    }
    throw new Error(`设备 ${deviceId} 在 ${TIMING.dfuReenumTimeoutMs} ms 内没有重新枚举`);
  }

  /**
   * 收尾后：换新句柄并全量回读；版本号没变时给软告警（R4-7）。
   *
   * 返回值 = **这一轮有没有真的从设备读到摘要**。调用方必须据此决定要不要做版本比对：
   * 设备停在 Bootloader / 新固件没起来时回读会失败，此时 `state().device` 里只有升级前的旧快照，
   * 拿它比版本就会得出"升级已完成、版本未变、设备已回到正常模式"这种与事实相反（2026-11-21 真机刷砖现场）。
   */
  async resumeAfterDfu(): Promise<boolean> {
    const transport = this._transport;
    if (transport === null) {
      this._fail('device');
      return false;
    }
    const before = this._firmwareBeforeDfu;
    try {
      if (transport instanceof WebHidTransport) {
        await this.awaitReenumeration();
        await transport.resume();
      } else {
        await transport.open();
      }
      if (transport.state() !== 'ready') {
        this._fail('device');
        return false;
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
      // 音频端点比 HID 晚枚举，先等真机端点回来，避免接到系统默认麦克风。
      void this._startAudioLevels({ strict: this._state.mode === 'native' });
      return true;
    } catch {
      this._fail('device');
      return false;
    } finally {
      this._firmwareBeforeDfu = null;
    }
  }

  /**
   * 升级失败 / 中止后的收场：把链路从"升级中"拉回一个用户还能继续操作的状态。
   *
   * 失败路径不会走 `resumeAfterDfu()`（设备可能停在 Bootloader，等重枚举只会白等），
   * 但 `suspendForDfu()` 已经挂起了通道：不在这里清掉，写入会被静默丢弃、拔线也不再上报，
   * 界面还会一直停在"已同步"——只能重开 app 才能恢复（真机 2026-11 反馈）。
   *
   * 能重新同步就回 ready；不能（设备在 Bootloader / 已拔出）就保留裸通道并给出
   * `device.warn.bootloader`，让固件抽屉接着刷、用户知道下一步该干什么。
   */
  async recoverAfterDfuFailure(resync = true): Promise<void> {
    this._firmwareBeforeDfu = null;
    const transport = this._transport;
    if (resync && transport instanceof WebHidTransport) {
      await transport.resume();
      if (transport.state() === 'ready') {
        try {
          const result = await transport.readAll();
          this._applyReadback(result);
          this._store.setSync('ready');
          this._patch({
            status: 'ready',
            sync: 'ready',
            device: result.device ?? this._state.device,
            warning: this._mismatchWarning(result.device),
          });
          void this._startAudioLevels();
          return;
        } catch {
          // 回读失败：落到下面的 error 收场，但通道继续留着
        }
      }
    }
    this._store.setSync('error');
    this._patch({
      status: 'error',
      sync: 'error',
      // 回读没成功，旧的设备摘要不能继续当真值用（否则预检会拿上一次的型号做判断）
      device: null,
      error: { key: 'device.error.sync' },
      errorCode: 'sync',
      warning: { key: 'device.warn.bootloader' },
    });
  }

  /**
   * 重试前重新取通道：升级失败 / 拔线 / 复位重枚举之后，句柄与挂起状态都可能已经失效。
   *
   * 1. 句柄还活着（设备没掉）→ 只清 DFU 挂起，参数会话照旧；
   * 2. 句柄没了但会话设备表里有同一台的新句柄 → `refresh()` 后 `reopen()` 换过去
   *    （同一个 transport 实例，DFU 的 `onInputBytes` 订阅不断）；
   * 3. 通道之前被 `_fail()` 丢掉了 → 新建一条只开句柄的裸通道。
   *
   * 返回 false 表示设备确实不在了：调用方应提示"插回后在设备页重新连接"，不要继续发帧。
   */
  async reacquire(): Promise<boolean> {
    const existing = this._transport;
    if (existing instanceof WebHidTransport && !existing.handleLost() && existing.device.opened) {
      existing.cancelDfu();
      return true;
    }

    // 句柄已失效：重新枚举一次设备表（拔插后系统给的是新的 HIDDevice，旧对象打不开）
    try {
      await this._session.refresh();
    } catch {
      // 刷新失败仍按现有句柄试一次，失败由下面的 openDevice / reopen 判定
    }
    const found = this._locateDevice(existing instanceof WebHidTransport ? existing.device : null);
    if (found === null) return false;
    if (!found.handle.opened) {
      await this._session.openDevice(found.id);
      if (!found.handle.opened) return false;
    }

    if (existing instanceof WebHidTransport) {
      await existing.reopen(found.handle);
      if (existing.state() !== 'ready') return false;
      existing.cancelDfu();
      this._patch({ deviceId: found.id });
      return true;
    }

    const transport = this._prepareTransport(found.handle);
    if (transport instanceof WebHidTransport) {
      await transport.reopen(found.handle);
      if (transport.state() !== 'ready') return false;
      transport.cancelDfu();
    } else {
      await transport.open();
      if (transport.state() !== 'ready') return false;
    }
    this._patch({ deviceId: found.id });
    return true;
  }

  // ---- 电平来源（音频输入） ----------------------------------------------

  /**
   * 打开"同一台设备"的音频输入并把它的电平接到通道出口。
   *
   * 提示词取 HID 的 productName（真机是 "USB Audio Device"）+ 型号码：Windows 的音频端点
   * 名字里带得上这些词就能匹配到同一台设备；匹配不到就退回系统默认输入（`matched=false`）。
   *
   * 音频电平一旦接管，就把设备侧的 `0x2057` 轮询关掉：真机固件本来就不上报电平（恒 0），
   * 这条 50 Hz 的读全是空转流量，长期压着下位机（2026-11 用户反馈：怕把设备卡死）。
   *
   * 失败时**不能**一拔插就退回设备上报：Windows 重新枚举音频端点比 HID 慢，上位机这边刚
   * ready 时 `getUserMedia` 常报 `NotFound/NotReadable`，而 `0x2057` 恒 0——退回去电平条就
   * 一直躺底，用户看到的是"重插后监听失效"（2026-11-14 反馈）。所以只要设备还在系统里
   * （HID 句柄活着），就进入 `retrying` 并按退避重开；只有权限被拒或设备真的不在了才退回。
   */
  private async _startAudioLevels(options: { readonly strict?: boolean } = {}): Promise<void> {
    const meter = this._audioLevels;
    if (meter === undefined) return;
    const transport = this._transport;
    if (!(transport instanceof WebHidTransport) || this._state.status !== 'ready') return;
    if (this._audioBusy) {
      // 正在打开：记一笔，完成后补一拍（插拔事件常连发）
      this._audioAgain = true;
      return;
    }
    const generation = this._audioGeneration;
    this._audioBusy = true;
    try {
      const info = await meter.start(this._audioHints(), { strict: options.strict === true });
      // 采集期间可能已经断开 / 换了设备：晚到的那一路立刻收回
      if (generation !== this._audioGeneration || this._transport !== transport) {
        meter.stop();
        return;
      }
      if (this._state.status !== 'ready') {
        meter.stop();
        return;
      }
      this._audioInputId = info.id;
      this._audioAttempts = 0;
      this._audioParked = false;
      this._channel.useLevelSource(meter);
      transport.setLevelPolling(false);
      this._patch({ audio: { label: info.label, source: 'audio', matched: info.matched } });
      this._log(`电平来源：音频输入 ${info.label || '（系统默认输入）'}`);
      this._scheduleAudio();
    } catch (error) {
      if (generation !== this._audioGeneration) return;
      if (this._transport !== transport || this._state.status !== 'ready') return;
      this._onAudioFailure(transport, audioErrorKind(error));
    } finally {
      this._audioBusy = false;
      if (this._audioAgain) {
        this._audioAgain = false;
        this._scheduleAudio(0);
      }
    }
  }

  /**
   * 音频输入打开失败：设备还在就继续重开，设备/权限真的不可用才退回设备上报。
   *
   * 重试期间保持 `setLevelPolling(false)`——这时退回 `0x2057` 只会多出 50 Hz 空转，
   * 电平条却不会因此活过来（固件恒 0）。
   */
  private _onAudioFailure(transport: WebHidTransport, kind: AudioMeterErrorKind): void {
    const present = this._devicePresent();
    if (present && kind !== 'denied') {
      this._audioAttempts += 1;
      this._audioInputId = null;
      this._channel.useLevelSource(null);
      transport.setLevelPolling(false);
      this._patch({ audio: { label: null, source: 'retrying', matched: false, error: kind } });
      const delay = this._audioBackoff();
      this._log(`音频输入打开失败（${kind}），设备还在系统里，${delay} ms 后重开`);
      this._scheduleAudio(delay);
      return;
    }
    // 权限被拒 / 设备确实不在了：这时只有设备上报能兜底（诊断里仍能看到原因）
    this._audioParked = kind === 'denied';
    this._audioInputId = null;
    this._channel.useLevelSource(null);
    transport.setLevelPolling(true);
    this._patch({ audio: { label: null, source: 'device', error: kind } });
    this._log(kind === 'denied' ? '麦克风权限被拒：电平退回设备上报' : '设备不在系统里：停止音频采集');
    if (!this._audioParked) this._scheduleAudio();
  }

  /** 停采集并摘掉外部电平源：设备断开 / 切回 Mock / 停在 Bootloader 时都要调 */
  private _stopAudioLevels(): void {
    if (this._audioLevels === undefined) return;
    // 晚到的异步打开结果不能接到新链路上；定时器与退避状态一并归零
    this._audioGeneration += 1;
    this._cancelAudioTimer();
    this._audioAttempts = 0;
    this._audioParked = false;
    this._audioAgain = false;
    this._audioInputId = null;
    this._audioLevels.stop();
    this._channel.useLevelSource(null);
    if (this._state.audio != null) this._patch({ audio: null });
  }

  /** 音频采集断了（track ended / AudioContext 关闭）：设备还在就重开 */
  private _onAudioLost(): void {
    if (this._audioLevels === undefined || this._state.status !== 'ready') return;
    if (this._audioBusy) return; // 正在开了：打开结果会落定状态，别再排一次
    this._audioInputId = null;
    this._audioAttempts = 0;
    if (this._state.audio?.source === 'audio') {
      this._patch({ audio: { label: null, source: 'retrying', matched: false } });
    }
    this._log('音频输入被系统断开，检查设备是否还在并重开');
    // 留一点时间给系统收拾端点：拔插瞬间立刻重开常是"开起来又立刻结束"
    this._scheduleAudio(this._audioRetryMs);
  }

  /** 音频设备表变化（拔插 / 驱动重载）：合并连发事件后立刻查一次 */
  private _onAudioDevicesChanged(): void {
    if (this._audioLevels === undefined || this._state.status !== 'ready' || this._audioParked) return;
    this._audioAttempts = 0;
    this._scheduleAudio(AUDIO_DEVICE_SETTLE_MS);
  }

  /**
   * 自检一拍：保证"设备还在系统里时，电平一定来自它的音频输入"。
   *
   * 三种情况要动手：①采集已经死了；②采集活着但采的是系统默认输入，而设备端点已经回来；
   * ③处于 `retrying` / 设备上报，设备端点又出现了。设备端点没回来时只等不打开——重试时
   * `strict=true`，一旦退回默认输入就会把别的麦克风当成这台设备的电平。
   */
  private async _ensureAudio(): Promise<void> {
    const meter = this._audioLevels;
    if (meter === undefined || this._audioBusy) return;
    const audio = this._state.audio;
    const healthy = meter.healthy === undefined ? audio?.source === 'audio' : meter.healthy();
    if (healthy && audio?.source === 'audio') {
      if (audio.matched === true) return;
      // 采的是系统默认输入：设备的端点回来就换过去（以设备驱动监听为准）
      const target = await this._probeAudioEndpoint();
      if (target === null || target === undefined) return;
      if (target.id === this._audioInputId) return;
      if (this._state.status !== 'ready') return;
      this._log(`发现设备音频输入 ${target.label}，改从它取电平`);
      await this._startAudioLevels({ strict: true });
      return;
    }
    if (this._state.status !== 'ready' || !this._devicePresent()) return;
    // 采集已经死了（track 结束 / 上下文关闭）也算重开：这时绝不能退回默认输入
    const retrying =
      (audio?.source === 'audio' && !healthy) ||
      audio?.source === 'retrying' ||
      this._audioAttempts > 0;
    if (retrying) {
      const target = await this._probeAudioEndpoint();
      if (target === null) return; // 端点还没枚举回来：等下一拍，别打开默认输入
    }
    await this._startAudioLevels({ strict: retrying });
  }

  /** 音频设备表里现找这台设备的端点；`undefined` = 当前音频源不支持只读探测 */
  private async _probeAudioEndpoint(): Promise<AudioInputDevice | null | undefined> {
    const meter = this._audioLevels;
    if (meter?.find === undefined) return undefined;
    try {
      return await meter.find(this._audioHints());
    } catch {
      return undefined;
    }
  }

  private _audioHints(): string[] {
    const transport = this._transport;
    const productName = transport instanceof WebHidTransport ? transport.device.productName ?? '' : '';
    return [productName, EXPECTED_MODEL_CODE, 'M001'];
  }

  /** 设备还在系统里：HID 句柄打开着、没被判掉线（物理拔线由 HID `disconnect` 立即上报） */
  private _devicePresent(): boolean {
    const transport = this._transport;
    if (transport === null) return false;
    if (transport.state() !== 'ready') return false;
    if (transport instanceof WebHidTransport) return !transport.handleLost() && transport.device.opened;
    return true;
  }

  /** 打开失败后的退避：`audioRetryMs` 起步，翻倍到 5 s 封顶 */
  private _audioBackoff(): number {
    const base = Math.max(20, this._audioRetryMs);
    const grown = base * 2 ** Math.max(0, this._audioAttempts - 1);
    return Math.min(grown, Math.max(base, AUDIO_RETRY_MAX_MS));
  }

  /** 排下一次自检；已有更早的排程时保留它（重试不能被 2 s 的周期拖住） */
  private _scheduleAudio(delayMs: number = this._audioWatchMs): void {
    if (this._audioLevels === undefined || this._audioParked) return;
    if (this._state.status !== 'ready' || this._transport === null) return;
    const delay = Math.max(0, delayMs);
    const due = this._clock.now() + delay;
    if (this._audioTimer !== null) {
      if (this._audioDueAt !== null && this._audioDueAt <= due) return;
      this._timers.clearTimeout(this._audioTimer);
      this._audioTimer = null;
      this._audioDueAt = null;
    }
    this._audioDueAt = due;
    this._audioTimer = this._timers.setTimeout(() => {
      this._audioTimer = null;
      this._audioDueAt = null;
      void this._audioStep();
    }, delay);
  }

  private _cancelAudioTimer(): void {
    if (this._audioTimer === null) return;
    this._timers.clearTimeout(this._audioTimer);
    this._audioTimer = null;
    this._audioDueAt = null;
  }

  private async _audioStep(): Promise<void> {
    if (this._audioLevels === undefined || this._state.status !== 'ready' || this._audioParked) return;
    try {
      await this._ensureAudio();
    } catch (error) {
      // 自愈循环不允许把链路带走：记一笔，下一拍再来
      this._log(`音频输入检查失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this._state.status === 'ready' && !this._audioParked) this._scheduleAudio();
    }
  }

  private _bindAudioWatch(): void {
    const meter = this._audioLevels;
    if (meter === undefined || this._audioWatchBound) return;
    this._audioWatchBound = true;
    this._audioLostOff = meter.onLost?.(() => this._onAudioLost()) ?? null;
    this._audioDevicesOff = meter.watchDevices?.(() => this._onAudioDevicesChanged()) ?? null;
  }

  private _log(message: string): void {
    this._onEvent?.(message);
  }

  // ---- 回读回填 ----------------------------------------------------------

  private _applyReadback(result: ParamReadResult): void {
    for (const [id, value] of Object.entries(result.preset)) this._store.applyEcho(id, this._displayValue(id, value));
    if (result.bands) this._applyBands(result.bands);
  }

  /** 只读增益过一道去抖；其它参数原样回填 */
  private _displayValue(id: string, value: number): number {
    return READONLY_GAIN_IDS.has(id) ? this._gainFilter.accept(id, value) : value;
  }

  /**
   * 设备主动上报回填：与回读同一语义（覆盖本地值、不发帧），只是可以发生在任意时刻。
   *
   * 走 `applyEcho` / `applyBands` 而不是 `setParam` / `setBands`——后两者是用户改动的入口，
   * 会差异对比后写回设备，设备上报再触发写帧就成了写环。
   */
  private _applyEcho(echo: ParamEcho): void {
    if (echo.kind === 'param') {
      this._store.applyEcho(echo.id, this._displayValue(echo.id, echo.value));
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
    const code = device.modelCode.trim();
    if (code === EXPECTED_MODEL_CODE) return null;
    // 信息区没烧（真机 V0.0.2/V0.0.4 的 0x39000 全 0）不是"型号不匹配"，
    // 显示"未上报型号"才不会把用户引到错误的排查方向（升级由 Bootloader 兜底校验）。
    if (code.length === 0 || code === '000000') return { key: 'device.warn.modelMissing' };
    return { key: 'device.warn.modelMismatch', vars: { code } };
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
    // 升级中设备复位重枚举是预期动作，DFU 会话自己会等新句柄；这里丢掉通道就把升级打断了
    if (this._state.status === 'dfu') return;
    // attach 期间的超时由 attach 判定（可能是 Bootloader 不说参数协议，句柄还要留着升级）
    if (this._attaching) return;
    if (this._state.status !== 'ready') return;
    this._stopAudioLevels();
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

  /**
   * 取本次 attach 用的通道。
   *
   * 同一句柄再次 attach（"重插后再试"没真拔、或 Bootloader 恢复流程）直接复用旧 transport：
   * 它的入站监听还在，`open()` 在 error 状态下会重建参数会话，不会把正在用的句柄先关掉。
   * 句柄换了（真重枚举/重新枚举）才丢弃旧通道，避免两套监听同时挂在一台设备上。
   */
  private _prepareTransport(handle: WebHidDeviceHandle): Transport {
    const existing = this._transport;
    if (existing instanceof WebHidTransport && existing.device === handle) return existing;
    if (existing !== null) this._disposeTransport();

    const transport = this._createTransport
      ? this._createTransport(handle)
      : new WebHidTransport({ device: handle, reportIds: reportIdsFromConfig() });
    this._transport = transport;
    this._listen(transport);
    this._channel.use(transport);
    return transport;
  }

  /**
   * 参数同步失败但句柄仍活着：设备最可能停在 Bootloader（升级中断后它每次复位都留在那里）。
   *
   * 不切回 Mock、也不 dispose 通道——`link.transport()` 继续可用，固件抽屉才能接着刷。
   * 参数链路按 error 降级（`store.sync = error`），避免界面把"没读到设备值"当成已同步。
   */
  private _failSync(): void {
    this._stopAudioLevels();
    this._store.setSync('error');
    this._patch({
      status: 'error',
      sync: 'error',
      // 回读没成功，旧的设备摘要不能继续当真值用（否则预检会拿上一次的型号做判断）
      device: null,
      error: { key: 'device.error.sync' },
      errorCode: 'sync',
      warning: { key: 'device.warn.bootloader' },
    });
  }

  /** 失败统一入口：切回 Mock、停链路、置 error 文案键（code → `device.error.<code>`） */
  private _fail(code: WebHidErrorCode): void {
    this._stopAudioLevels();
    this._channel.use(this._mock);
    this._disposeTransport();
    this._store.setSync('error');
    this._patch({
      status: 'error',
      sync: 'error',
      // 通道都没了，这台设备的摘要就是过期数据：留着会让升级后的版本比对读到升级前那一份
      // （2026-11-21 真机刷砖现场：回读失败却报出"设备 0.0.5 与镜像 0.0.6 不一致"）
      device: null,
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

  /**
   * 找重枚举后的新句柄。优先按原 id（真机 id = `native-VID-PID-序号`，Bootloader 的 VID/PID
   * 不变时 id 也不变）；枚举顺序变了导致 id 漂移时，退回按 VID/PID 找"不是旧句柄"的那台。
   */
  private _findReplacement(
    deviceId: string,
    previous: WebHidDeviceHandle,
  ): { readonly id: string; readonly handle: WebHidDeviceHandle } | null {
    const direct = this._session.handleOf(deviceId);
    if (direct !== null && direct !== previous) return { id: deviceId, handle: direct };
    for (const summary of this._session.getState().devices) {
      if (summary.vendorId !== previous.vendorId || summary.productId !== previous.productId) continue;
      const candidate = this._session.handleOf(summary.id);
      if (candidate !== null && candidate !== previous) return { id: summary.id, handle: candidate };
    }
    return null;
  }

  /**
   * `reacquire()` 的候选句柄：优先"原 id + 新对象"（复位重枚举），其次同 VID/PID 的另一台，
   * 最后接受原 id 的同一个对象（通道被丢掉后重建时，设备可能从头到尾没断过）。
   *
   * 与 `_findReplacement()` 的差别只在最后一条：等重枚举时必须拿到新对象，重新取通道时
   * 同一台活着的设备也是合法结果。
   */
  private _locateDevice(
    previous: WebHidDeviceHandle | null,
  ): { readonly id: string; readonly handle: WebHidDeviceHandle } | null {
    const deviceId = this._state.deviceId;
    if (deviceId !== null) {
      const direct = this._session.handleOf(deviceId);
      if (direct !== null && direct !== previous) return { id: deviceId, handle: direct };
    }
    if (previous !== null) {
      for (const summary of this._session.getState().devices) {
        if (summary.vendorId !== previous.vendorId || summary.productId !== previous.productId) continue;
        const candidate = this._session.handleOf(summary.id);
        if (candidate !== null && candidate !== previous) return { id: summary.id, handle: candidate };
      }
    }
    if (deviceId !== null) {
      const direct = this._session.handleOf(deviceId);
      if (direct !== null) return { id: deviceId, handle: direct };
    }
    return null;
  }

  private _delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this._timers.setTimeout(resolve, ms);
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
