/**
 * 音频电平表：真机固件不上报 `0x2057`（消息里恒 0），所以电平改由**同一台设备的音频输入**算。
 *
 * 链路：`navigator.mediaDevices.getUserMedia`（M001 的 USB 声卡）→ `AudioContext` →
 * `AnalyserNode.getFloatTimeDomainData` → 本模块算 RMS / 峰值 → `LevelFrame`（与设备上报同构），
 * 交给 `ChannelTransport` 的外部电平源出口，界面侧完全不用改。
 *
 * Web Audio 与 mediaDevices 都藏在 `AudioMedia` / `AudioCapture` 注入面后面：单测用假的采样源
 * 与假定时器，happy-dom 里不需要真的声卡。
 *
 * 采集会"自己坏掉"：USB 重新枚举、音频驱动重载、系统把设备从"默认输入"里摘掉时，track 会结束
 * 或停在静音上。本模块只负责**发现**（`healthy()` / `onLost()`）并把"系统里现在有没有这台设备
 * 的端点"（`find()`）如实报出来；要不要重开、什么时候重开是 `DeviceLink` 的策略。
 */
import type { Clock, Timers } from './proto/timing';
import { defaultClock, defaultTimers } from './proto/timing';
import type { LevelFrame } from './transport';

/** 输出通道没有采集通路（R5-4）：与 `WebHidTransport` 保持一致 */
const SILENT_DB = -96;
/** 峰值保持的线性回落窗口（与传输层的 300 ms 同口径） */
const PEAK_DECAY_MS = 300;
/** 采样窗口：33 ms ≈ 30 fps，够电平条看着连续 */
const DEFAULT_WINDOW_MS = 33;
/** 短于这个长度的提示词容易误伤（例如 "USB" 会匹配所有 USB 声卡） */
const MIN_HINT_LENGTH = 3;

export interface AudioInputDevice {
  readonly id: string;
  readonly label: string;
}

/** 一次打开的音频输入：`read()` 返回一帧时域样本（-1..1），没有数据时返回 null */
export interface AudioCapture {
  readonly label: string;
  read(): Float32Array | null;
  close(): void;
  /** 采集是否还活着（track 未 ended、`AudioContext` 未关闭）；缺省按"活着"处理 */
  alive?(): boolean;
  /** 采集被系统断开（拔线 / 驱动重载）时回调；返回退订函数 */
  onEnded?(cb: () => void): () => void;
}

/** 注入面：只有默认实现才碰 `navigator.mediaDevices` / `AudioContext` */
export interface AudioMedia {
  listInputs(): Promise<readonly AudioInputDevice[]>;
  /** `inputId = null` 表示系统默认输入设备 */
  open(inputId: string | null): Promise<AudioCapture>;
  /** 系统音频设备表变化（插拔 / 驱动重载）；环境不支持时缺省 */
  watch?(cb: () => void): () => void;
}

export type AudioMeterErrorKind = 'denied' | 'unavailable' | 'unknown';

export interface AudioMeterInfo {
  /** 正在采集的音频输入名（浏览器给的名字，通常带 "(USB Audio Device)"） */
  readonly label: string;
  /** 命中的音频端点 id（null = 退回系统默认输入）；端点被系统重建后 id 会变 */
  readonly id: string | null;
  /** 是否按设备型号提示词命中了同一个声卡；false 表示退回系统默认输入 */
  readonly matched: boolean;
}

export class AudioMeterError extends Error {
  readonly kind: AudioMeterErrorKind;

  constructor(kind: AudioMeterErrorKind, message: string) {
    super(message);
    this.name = 'AudioMeterError';
    this.kind = kind;
  }
}

/** 把 `getUserMedia` / `AudioContext` 的异常收敛成界面能说清楚的三种原因 */
export function audioErrorKind(error: unknown): AudioMeterErrorKind {
  if (error instanceof AudioMeterError) return error.kind;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return 'unavailable';
  return 'unknown';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Chrome 把"系统默认 / 通讯设备"这类别名也列成一条，名字前缀是 `Default - ` / `Communications - ` */
const ALIAS_LABEL = /^(default|communications)\s*-\s*/i;

/**
 * 从音频输入里挑"同一台设备"：按提示词（HID 的 productName / 型号名）做大小写无关的子串匹配，
 * 越靠前的提示词优先；同分时优先具体端点而不是 `Default - ` 别名（别名会跟着系统默认走）。
 * labels 在首次授权前是空串，那种情况返回 null 由调用方退回默认输入。
 */
export function pickAudioInput(
  devices: readonly AudioInputDevice[],
  hints: readonly string[],
): AudioInputDevice | null {
  const wanted: string[] = [];
  for (const hint of hints ?? []) {
    const text = hint.trim().toLowerCase();
    if (text.length < MIN_HINT_LENGTH) continue;
    if (!wanted.includes(text)) wanted.push(text);
  }
  if (wanted.length === 0) return null;

  let best: AudioInputDevice | null = null;
  let bestScore = 0;
  let bestIsAlias = true;
  for (const device of devices) {
    const label = device.label.trim().toLowerCase();
    if (label.length === 0) continue;
    let score = 0;
    for (let index = 0; index < wanted.length; index += 1) {
      if (label.includes(wanted[index])) {
        score = wanted.length - index; // 前面的提示词更可信
        break;
      }
    }
    if (score <= 0) continue;
    const isAlias = ALIAS_LABEL.test(label);
    if (score > bestScore || (score === bestScore && bestIsAlias && !isAlias)) {
      best = device;
      bestScore = score;
      bestIsAlias = isAlias;
    }
  }
  return best;
}

/** 一帧时域样本的 RMS 与绝对值峰值（0..1） */
export function measureLevel(samples: Float32Array): { readonly rms: number; readonly peak: number } {
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  return { rms: samples.length === 0 ? 0 : Math.sqrt(sum / samples.length), peak };
}

/** 线性幅度 → dBFS，夹到 -96..0（与 `levelToDb` 的下限一致） */
export function amplitudeToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return SILENT_DB;
  return Math.max(SILENT_DB, Math.min(0, 20 * Math.log10(value)));
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * 默认实现：浏览器 / Electron 渲染进程里的真实 Web Audio。
 *
 * 关掉 `echoCancellation / noiseSuppression / autoGainControl` 是有意的——浏览器默认会做 DSP，
 * 那样电平条反映的是"调过音的"信号，与设备真实输入对不上。
 */
export function createWebAudioMedia(): AudioMedia {
  return {
    async listInputs(): Promise<readonly AudioInputDevice[]> {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'audioinput').map((device) => ({
        id: device.deviceId,
        label: device.label,
      }));
    },

    watch(cb: () => void): () => void {
      const devices = navigator.mediaDevices;
      if (devices === undefined || typeof devices.addEventListener !== 'function') return () => undefined;
      devices.addEventListener('devicechange', cb);
      return () => devices.removeEventListener('devicechange', cb);
    },

    async open(inputId: string | null): Promise<AudioCapture> {
      const Ctor = audioContextCtor();
      if (Ctor === null) throw new AudioMeterError('unavailable', '当前环境没有 Web Audio');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(inputId === null ? {} : { deviceId: { exact: inputId } }),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      const context = new Ctor();
      // 自动播放策略可能把 AudioContext 建在 suspended 上，那样 AnalyserNode 不推进
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024; // ≈21 ms @48 kHz，30 fps 采样不会重复同一段
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const track = stream.getAudioTracks()[0] ?? null;
      // 设备被拔掉 / 驱动重载时 Chrome 只结束 track，不会抛错；不盯这个标记就会一直读旧缓冲
      let ended = track === null;
      const markEnded = (): void => {
        ended = true;
      };
      track?.addEventListener('ended', markEnded);
      context.addEventListener('statechange', () => {
        if (context.state === 'closed') markEnded();
      });
      return {
        label: track?.label ?? '',
        read: () => {
          analyser.getFloatTimeDomainData(buffer);
          return buffer;
        },
        alive: () => !ended && context.state !== 'closed' && (track === null || track.readyState === 'live'),
        onEnded: (cb: () => void): (() => void) => {
          const handler = (): void => {
            markEnded();
            cb();
          };
          track?.addEventListener('ended', handler);
          const stateHandler = (): void => {
            if (context.state === 'closed') handler();
          };
          context.addEventListener('statechange', stateHandler);
          return () => {
            track?.removeEventListener('ended', handler);
            context.removeEventListener('statechange', stateHandler);
          };
        },
        close: () => {
          for (const item of stream.getTracks()) item.stop();
          void context.close();
        },
      };
    },
  };
}

export interface AudioLevelMeterOptions {
  readonly media?: AudioMedia;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly windowMs?: number;
  readonly peakDecayMs?: number;
}

/**
 * 音频电平表：`start()` 打开输入并开始按 `windowMs` 出帧，`stop()` 关掉。
 * 与 `WebHidTransport` 的 `LevelFrame` 完全同构（输出通道恒 `-96`、`outputValid=false`）。
 */
export class AudioLevelMeter {
  private readonly media: AudioMedia;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly windowMs: number;
  private readonly peakDecayMs: number;

  private readonly _listeners = new Set<(frame: LevelFrame) => void>();
  private readonly _lostListeners = new Set<() => void>();
  private _capture: AudioCapture | null = null;
  /** `_capture.onEnded()` 的退订函数；换采集 / stop 时必须摘掉 */
  private _captureOff: (() => void) | null = null;
  private _timer: unknown = null;
  private _info: AudioMeterInfo | null = null;
  private _lastPeak: number | null = null;
  private _lastAt: number | null = null;
  /** start/stop 计数器：异步打开期间被 stop() 取代时，晚到的流要立刻关掉 */
  private _generation = 0;

  constructor(options: AudioLevelMeterOptions = {}) {
    this.media = options.media ?? createWebAudioMedia();
    this.clock = options.clock ?? defaultClock();
    this.timers = options.timers ?? defaultTimers();
    this.windowMs = Math.max(10, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.peakDecayMs = Math.max(1, options.peakDecayMs ?? PEAK_DECAY_MS);
  }

  onLevels(cb: (frame: LevelFrame) => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  /** 采集被系统断开（拔线 / 驱动重载 / track 结束）时通知；由上层决定是否重开 */
  onLost(cb: () => void): () => void {
    this._lostListeners.add(cb);
    return () => {
      this._lostListeners.delete(cb);
    };
  }

  /** 正在采集的输入（null = 没在采）；诊断面板据此显示"电平来源" */
  active(): AudioMeterInfo | null {
    return this._info;
  }

  /** 当前采集是否还活着：没开、track 已结束、`AudioContext` 已关闭都是 false */
  healthy(): boolean {
    const capture = this._capture;
    if (capture === null) return false;
    if (capture.alive === undefined) return true;
    try {
      return capture.alive();
    } catch {
      return false;
    }
  }

  /**
   * 系统里现在能不能找到这台设备的音频端点（只读枚举，不打开采集）。
   * 返回 null 表示没匹配到——插拔 / 驱动重载期间端点会先消失再回来。
   */
  async find(hints: readonly string[]): Promise<AudioInputDevice | null> {
    try {
      return pickAudioInput(await this.media.listInputs(), hints);
    } catch {
      return null;
    }
  }

  /** 系统音频设备表变化；环境不支持事件时返回空退订函数 */
  watchDevices(cb: () => void): () => void {
    try {
      return this.media.watch?.(cb) ?? (() => undefined);
    } catch {
      return () => undefined;
    }
  }

  /**
   * 打开音频输入。`hints` 是设备身份提示词（HID 的 productName、型号名），
   * 命中就采同一个声卡，命中不了退回系统默认输入（`matched=false`）。
   *
   * `strict=true` 用于"重开已经采过的设备"：匹配不到就报 `unavailable`，绝不退回默认输入——
   * 否则拔插后一重试就可能把笔记本自带麦克风当成这台设备的电平（2026-11-14 反馈）。
   */
  async start(
    hints: readonly string[],
    options: { readonly strict?: boolean } = {},
  ): Promise<AudioMeterInfo> {
    this.stop();
    const generation = this._generation;
    try {
      let inputs = await this.media.listInputs();
      let target = pickAudioInput(inputs, hints);
      if (target === null && inputs.length > 0 && inputs.every((item) => item.label.trim().length === 0)) {
        // 首次授权前 label 全是空的：先开一次默认输入把权限与真实名字拿到，再按型号重挑
        const probe = await this.media.open(null);
        probe.close();
        inputs = await this.media.listInputs();
        target = pickAudioInput(inputs, hints);
      }
      if (target === null && options.strict === true) {
        throw new AudioMeterError('unavailable', '设备的音频输入还没就绪');
      }
      const capture = await this.media.open(target?.id ?? null);
      if (generation !== this._generation) {
        capture.close();
        throw new AudioMeterError('unknown', '已被新的采集请求取代');
      }
      this._capture = capture;
      this._captureOff = capture.onEnded?.(() => this._captureLost()) ?? null;
      const label = capture.label.trim() || (target?.label ?? '').trim();
      this._info = { label, id: target?.id ?? null, matched: target !== null };
      this._lastPeak = null;
      this._lastAt = null;
      this._schedule();
      return this._info;
    } catch (error) {
      this.stop();
      if (error instanceof AudioMeterError) throw error;
      throw new AudioMeterError(audioErrorKind(error), messageOf(error));
    }
  }

  stop(): void {
    this._generation += 1;
    if (this._timer !== null) {
      this.timers.clearTimeout(this._timer);
      this._timer = null;
    }
    this._captureOff?.();
    this._captureOff = null;
    const capture = this._capture;
    this._capture = null;
    capture?.close();
    this._info = null;
    this._lastPeak = null;
    this._lastAt = null;
  }

  // ---- 采样与出帧 ---------------------------------------------------------

  private _schedule(): void {
    this._timer = this.timers.setTimeout(() => {
      this._timer = null;
      try {
        this._tick();
      } finally {
        // 无论这一帧发生什么都要续上：电平条"静默停摆"比丢一帧严重得多
        if (this._capture !== null) this._schedule();
      }
    }, this.windowMs);
  }

  /**
   * 采集自己断了：关掉并通知上层。
   *
   * 走 `stop()` 而不是只清字段，是因为 `stop()` 会把 generation 推进一位——
   * 之后晚到的 `start()` 完成回调不会把已经死掉的 capture 又装回来。
   */
  private _captureLost(): void {
    if (this._capture === null) return;
    this.stop();
    for (const cb of [...this._lostListeners]) cb();
  }

  private _tick(): void {
    const capture = this._capture;
    if (capture === null) return;
    // 每次出帧顺手验一下采集还活着：拔线时 track 可能只结束、不抛错
    if (!this.healthy()) {
      this._captureLost();
      return;
    }
    let samples: Float32Array | null = null;
    try {
      samples = capture.read();
    } catch {
      this._captureLost();
      return;
    }
    if (samples === null || samples.length === 0) return;

    const now = this.clock.now();
    const { rms, peak } = measureLevel(samples);
    const rmsDb = amplitudeToDb(rms);
    let peakDb = amplitudeToDb(peak);
    if (this._lastPeak !== null && this._lastAt !== null) {
      const elapsed = Math.max(0, now - this._lastAt);
      const decayed = this._lastPeak - (elapsed / this.peakDecayMs) * (this._lastPeak - rmsDb);
      peakDb = Math.max(peakDb, decayed);
    }
    this._lastPeak = peakDb;
    this._lastAt = now;

    const frame: LevelFrame = {
      t: now,
      inputRms: rmsDb,
      inputPeak: peakDb,
      outputRms: SILENT_DB,
      outputPeak: SILENT_DB,
      inputValid: true,
      outputValid: false,
    };
    for (const cb of [...this._listeners]) {
      try {
        cb(frame);
      } catch {
        // 订阅方（视图 / 通道门面）出错不能把采集循环带走：吞掉这一帧的异常，下一帧照常
      }
    }
  }
}
