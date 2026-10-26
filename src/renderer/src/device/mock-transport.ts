import { DEFAULT_PARAMS } from '../domain/defaults';
import type {
  DiagEntry,
  EqBandWrite,
  LevelFrame,
  ParamEcho,
  ParamReadResult,
  ParamWrite,
  SyncPhase,
  Transport,
  TransportError,
  TransportState,
} from './transport';

export type MockScene = 'silence' | 'speech' | 'music';

export interface MockTransportOptions {
  /** 出帧频率，默认 50Hz */
  hz?: number;
  /** 初始场景，默认 'speech' */
  scene?: MockScene;
}

const DEFAULT_HZ = 50;
const MIN_DB = -96;
const MAX_DB = 0;
// 输入与输出的固定 3dB 差，模拟设备内部处理链的固定增益
const OUTPUT_OFFSET_DB = -3;
const PEAK_HEADROOM_DB = 3;

const SILENCE_FLOOR_DB = -72;
const SILENCE_JITTER_DB = 1;
const SPEECH_SILENT_DB = -68;
const SPEECH_ACTIVE_MIN_MS = 600;
const SPEECH_ACTIVE_MAX_MS = 3000;
const SPEECH_ACTIVE_MIN_DB = -14;
const SPEECH_ACTIVE_MAX_DB = -3;
const SPEECH_SILENT_MIN_MS = 1000;
const SPEECH_SILENT_MAX_MS = 3000;
// 一阶平滑：next = prev * 0.7 + target * 0.3
const SMOOTH_OLD_WEIGHT = 0.7;
const MUSIC_CENTER_DB = -14;
const MUSIC_SWING_DB = 8;
const MUSIC_PHASE_STEP = 0.15;
const MUSIC_JITTER_DB = 0.6;

/** 任务的回读时延：本类本来就有定时器，模拟一次"设备答复"的往返 */
const READ_ALL_DELAY_MS = 20;
/** 写回显时延：与真实设备一问答的量级对齐，单测用假定时器推进 */
const ECHO_DELAY_MS = 5;

function clampDb(value: number): number {
  return Math.min(MAX_DB, Math.max(MIN_DB, value));
}

function jitter(amplitude: number): number {
  return (Math.random() * 2 - 1) * amplitude;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Alpha 阶段的设备替身：按场景合成电平帧，写入只进缓冲不回包。
 * 定时器与随机数都留在本类内部，上层只依赖 Transport 接口。
 *
 * 3.2 起它同时是 `ChannelTransport` 的兜底通道：设备断开后 AppStore 仍要有数据可画，
 * 因此补齐了 `Transport` 的 5 个新方法（回读 / 同步相位 / 回显 / 错误 / 诊断），
 * 但它们只做"看起来像设备"的最小动作——回读返回 `DEFAULT_PARAMS`、`device` 恒为 null。
 */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;

  private readonly _intervalMs: number;
  private readonly _levelListeners = new Set<(frame: LevelFrame) => void>();
  private readonly _stateListeners = new Set<(state: TransportState) => void>();
  private readonly _syncListeners = new Set<(phase: SyncPhase) => void>();
  private readonly _echoListeners = new Set<(echo: ParamEcho) => void>();
  private readonly _errorListeners = new Set<(error: TransportError) => void>();
  private readonly _diagListeners = new Set<(entry: DiagEntry) => void>();
  private readonly _writes: ParamWrite[] = [];
  private readonly _echoTimers = new Set<ReturnType<typeof setTimeout>>();

  private _scene: MockScene;
  private _state: TransportState = 'idle';
  private _sync: SyncPhase = 'idle';
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _frame: LevelFrame | null = null;

  private _smoothed: number | null = null;
  private _segmentLeftMs = 0;
  private _segmentActive = false;
  private _segmentTargetDb = SPEECH_SILENT_DB;
  private _phase = 0;

  constructor(options?: MockTransportOptions) {
    const hz = options?.hz && options.hz > 0 ? options.hz : DEFAULT_HZ;
    this._intervalMs = Math.max(1, Math.round(1000 / hz));
    this._scene = options?.scene ?? 'speech';
  }

  state(): TransportState {
    return this._state;
  }

  async open(): Promise<void> {
    if (this._state === 'ready' || this._state === 'connecting') return;
    this._setState('connecting');
    try {
      this._resetScene();
      this._timer = setInterval(() => this._tick(), this._intervalMs);
      this._setState('ready');
      // 同步相位在微任务里派发：调用方通常先 open() 再订阅，同栈派发会漏掉首个订阅者
      queueMicrotask(() => {
        if (this._state !== 'ready') return;
        this._setSync('syncing');
        this._setSync('ready');
      });
    } catch (error) {
      this._clearTimer();
      this._setState('error');
      console.warn('[mock-transport] open failed', error);
    }
  }

  async close(): Promise<void> {
    try {
      this._clearTimer();
      this._clearEchoTimers();
      this._setState('idle');
      this._setSync('idle');
    } catch (error) {
      this._setState('error');
      console.warn('[mock-transport] close failed', error);
    }
  }

  write(updates: readonly ParamWrite[]): void {
    try {
      if (!updates) return;
      let last: ParamWrite | null = null;
      for (const update of updates) {
        if (!update || typeof update.id !== 'string') continue;
        const entry = { id: update.id, value: update.value };
        this._writes.push(entry);
        last = entry;
      }
      if (last === null) return;
      const echoed: ParamWrite = last;
      // 每批只回显最后一项：界面回填以"批"为单位，逐项回显会和用户刚拨到值打架
      this._emitDiag(`mock 写 ${echoed.id}=${echoed.value}`);
      this._scheduleEcho(echoed);
    } catch (error) {
      // write 永不抛：写失败只记录，UI 线程不接受异常
      console.warn('[mock-transport] write failed', error);
    }
  }

  /**
   * Mock 没有设备可写：EQ 段改动只记诊断（每字段一条），让自动化能确认"改动确实到达通道层"。
   */
  writeBands(updates: readonly EqBandWrite[]): void {
    try {
      for (const update of updates ?? []) {
        if (!update || typeof update.band !== 'number') continue;
        this._emitDiag(`mock 写 band ${update.band}.${update.field}=${update.value}`);
      }
    } catch (error) {
      console.warn('[mock-transport] writeBands failed', error);
    }
  }

  onLevels(cb: (frame: LevelFrame) => void): () => void {
    this._levelListeners.add(cb);
    return () => {
      this._levelListeners.delete(cb);
    };
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    this._stateListeners.add(cb);
    return () => {
      this._stateListeners.delete(cb);
    };
  }

  /** 20 ms 后交差：Mock 没有设备可读，回读值就是寄存器默认值，`device` 为 null */
  async readAll(): Promise<ParamReadResult> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, READ_ALL_DELAY_MS);
    });
    return { preset: DEFAULT_PARAMS, device: null };
  }

  onSync(cb: (phase: SyncPhase) => void): () => void {
    this._syncListeners.add(cb);
    return () => {
      this._syncListeners.delete(cb);
    };
  }

  onParamEcho(cb: (echo: ParamEcho) => void): () => void {
    this._echoListeners.add(cb);
    return () => {
      this._echoListeners.delete(cb);
    };
  }

  /** 只维护订阅集合：Mock 不会失败，但契约里这些方法必须存在且可退订 */
  onError(cb: (error: TransportError) => void): () => void {
    this._errorListeners.add(cb);
    return () => {
      this._errorListeners.delete(cb);
    };
  }

  onDiag(cb: (entry: DiagEntry) => void): () => void {
    this._diagListeners.add(cb);
    return () => {
      this._diagListeners.delete(cb);
    };
  }

  setScene(scene: MockScene): void {
    if (scene === this._scene) return;
    this._scene = scene;
    this._resetScene();
  }

  /** 累计写入记录，供单测与调试读取（外部拿到的是一份只读快照） */
  writtenBuffer(): readonly ParamWrite[] {
    return Object.freeze(this._writes.map((item) => ({ ...item })));
  }

  lastFrame(): LevelFrame | null {
    return this._frame ? { ...this._frame } : null;
  }

  private _setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    for (const cb of [...this._stateListeners]) cb(next);
  }

  private _setSync(next: SyncPhase): void {
    if (this._sync === next) return;
    this._sync = next;
    for (const cb of [...this._syncListeners]) cb(next);
  }

  private _emitDiag(summary: string): void {
    if (this._diagListeners.size === 0) return;
    const record: DiagEntry = {
      at: Date.now(),
      dir: 'out',
      hex: '',
      summary,
      level: 'info',
    };
    for (const cb of [...this._diagListeners]) cb(record);
  }

  private _scheduleEcho(entry: ParamWrite): void {
    if (this._echoListeners.size === 0) return;
    const timer = setTimeout(() => {
      this._echoTimers.delete(timer);
      for (const cb of [...this._echoListeners]) cb({ kind: 'param', id: entry.id, value: entry.value });
    }, ECHO_DELAY_MS);
    this._echoTimers.add(timer);
  }

  private _clearTimer(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  private _clearEchoTimers(): void {
    for (const timer of this._echoTimers) clearTimeout(timer);
    this._echoTimers.clear();
  }

  private _resetScene(): void {
    this._smoothed = null;
    this._segmentLeftMs = 0;
    this._segmentActive = false;
    this._segmentTargetDb = SPEECH_SILENT_DB;
    this._phase = 0;
  }

  private _tick(): void {
    const inputRms = this._nextInputRms();
    const inputPeak = clampDb(inputRms + PEAK_HEADROOM_DB);
    const frame: LevelFrame = {
      t: Date.now(),
      inputRms,
      inputPeak,
      // Mock 的两个通道都是"有效数据"：它代表的是演示数据源，不是设备断流
      inputValid: true,
      outputValid: true,
      outputRms: clampDb(inputRms + OUTPUT_OFFSET_DB),
      outputPeak: clampDb(inputPeak + OUTPUT_OFFSET_DB),
    };
    this._frame = frame;
    for (const cb of [...this._levelListeners]) cb(frame);
  }

  private _nextInputRms(): number {
    if (this._scene === 'silence') {
      return clampDb(SILENCE_FLOOR_DB + jitter(SILENCE_JITTER_DB));
    }
    if (this._scene === 'music') {
      this._phase += MUSIC_PHASE_STEP;
      const wave = MUSIC_CENTER_DB + MUSIC_SWING_DB * Math.sin(this._phase);
      return clampDb(wave + jitter(MUSIC_JITTER_DB));
    }
    return this._nextSpeechRms();
  }

  private _nextSpeechRms(): number {
    if (this._segmentLeftMs <= 0) this._advanceSpeechSegment();
    this._segmentLeftMs -= this._intervalMs;
    const target = this._segmentActive ? this._segmentTargetDb : SPEECH_SILENT_DB;
    const next =
      this._smoothed === null
        ? target
        : this._smoothed * SMOOTH_OLD_WEIGHT + target * (1 - SMOOTH_OLD_WEIGHT);
    this._smoothed = next;
    return clampDb(next);
  }

  private _advanceSpeechSegment(): void {
    this._segmentActive = !this._segmentActive;
    if (this._segmentActive) {
      this._segmentLeftMs = randomBetween(SPEECH_ACTIVE_MIN_MS, SPEECH_ACTIVE_MAX_MS);
      this._segmentTargetDb = randomBetween(SPEECH_ACTIVE_MIN_DB, SPEECH_ACTIVE_MAX_DB);
    } else {
      this._segmentLeftMs = randomBetween(SPEECH_SILENT_MIN_MS, SPEECH_SILENT_MAX_MS);
      this._segmentTargetDb = SPEECH_SILENT_DB;
    }
  }
}
