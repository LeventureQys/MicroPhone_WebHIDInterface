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

/** 外部电平源：真机固件不上报电平时的替代数据源（`AudioLevelMeter` 满足它） */
export interface LevelSource {
  onLevels(cb: (frame: LevelFrame) => void): () => void;
}

/**
 * 单一 Transport 门面：内部在 Mock 与真实设备之间切换，`AppStore` 只认这一个对象。
 *
 * 订阅者集合由本类维护：切换通道时先摘掉旧通道的转发监听、再挂新的，
 * 于是 UI（顶栏 / 电平 / 控制台）不需要因为换通道而重新订阅（任务书 §4.4）。
 */
export class ChannelTransport implements Transport {
  private _active: Transport;
  private _state: TransportState;
  private _detachers: Array<() => void> = [];
  private _levelSource: LevelSource | null = null;
  private _levelSourceOff: (() => void) | null = null;

  private readonly _levelListeners = new Set<(frame: LevelFrame) => void>();
  private readonly _stateListeners = new Set<(state: TransportState) => void>();
  private readonly _syncListeners = new Set<(phase: SyncPhase) => void>();
  private readonly _echoListeners = new Set<(echo: ParamEcho) => void>();
  private readonly _errorListeners = new Set<(error: TransportError) => void>();
  private readonly _diagListeners = new Set<(entry: DiagEntry) => void>();

  constructor(initial: Transport) {
    this._active = initial;
    this._state = initial.state();
    this._attach(initial);
  }

  get kind(): 'mock' | 'webhid' {
    return this._active.kind;
  }

  active(): Transport {
    return this._active;
  }

  /**
   * 挂 / 摘外部电平源；挂着时通道自身的电平帧让位。
   *
   * 真机固件不上报 `0x2057`（消息里恒 0），电平改由同一台设备的音频输入算；
   * 对界面来说数据源换了，但订阅出口（`onLevels`）与 `LevelFrame` 形状不变。
   */
  useLevelSource(source: LevelSource | null): void {
    if (this._levelSource === source) return;
    this._levelSourceOff?.();
    this._levelSourceOff = null;
    this._levelSource = source;
    if (source === null) return;
    this._levelSourceOff = source.onLevels((frame) => this._emit(this._levelListeners, frame));
  }

  /** 当前是否有外部电平源（诊断 / 单测用） */
  levelSource(): LevelSource | null {
    return this._levelSource;
  }

  /**
   * 切换内部通道。不重建订阅者；切换后立即用新通道的 `state()` 与既有订阅者对齐，
   * 使顶栏在换通道那一刻就能反映"已就绪 / 未连接"。
   */
  use(next: Transport): void {
    if (next === this._active) {
      this._alignState();
      return;
    }
    this._detach();
    this._active = next;
    this._attach(next);
    this._alignState();
  }

  state(): TransportState {
    return this._state;
  }

  async open(): Promise<void> {
    await this._active.open();
    this._alignState();
  }

  async close(): Promise<void> {
    await this._active.close();
    this._alignState();
  }

  write(updates: readonly ParamWrite[]): void {
    this._active.write(updates);
  }

  /** EQ 段写入也要穿过门面：`AppStore` 只认这一个对象，漏转发等于 EQ 改动出不去 */
  writeBands(updates: readonly EqBandWrite[]): void {
    this._active.writeBands?.(updates);
  }

  readAll(): Promise<ParamReadResult> {
    return this._active.readAll();
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

  private _attach(target: Transport): void {
    this._detachers = [
      target.onLevels((frame) => {
        // 音频输入在采时，设备上报的 0x2057 恒 0 只会把电平条压到最低，直接让位
        if (this._levelSource !== null) return;
        this._emit(this._levelListeners, frame);
      }),
      target.onStateChange((state) => {
        this._state = state;
        this._emit(this._stateListeners, state);
      }),
      target.onSync((phase) => this._emit(this._syncListeners, phase)),
      target.onParamEcho((echo) => this._emit(this._echoListeners, echo)),
      target.onError((error) => this._emit(this._errorListeners, error)),
      target.onDiag((entry) => this._emit(this._diagListeners, entry)),
    ];
  }

  private _detach(): void {
    for (const off of this._detachers) off();
    this._detachers = [];
  }

  /** `use()` 后对齐：只有真的变了才派发，避免重复刷新 */
  private _alignState(): void {
    const next = this._active.state();
    if (next === this._state) return;
    this._state = next;
    this._emit(this._stateListeners, next);
  }

  private _emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const cb of [...listeners]) cb(value);
  }
}
