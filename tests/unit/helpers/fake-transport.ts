import type {
  DiagEntry,
  EqBandWrite,
  LevelFrame,
  ParamReadResult,
  ParamWrite,
  SyncPhase,
  Transport,
  TransportError,
  TransportState,
} from '../../../src/renderer/src/device/transport';

/**
 * 单测用 Transport：`kind` 可指定，`write` / `writeBands` / `readAll` 的调用次数与入参全部留下，
 * 状态与相位由测试用 `emit*` 直接推。3.2 的 ChannelTransport / DeviceLink / AppStore 用例共用它。
 */
export class FakeTransport implements Transport {
  readonly kind: 'mock' | 'webhid';
  readonly writes: ParamWrite[][] = [];
  readonly bandWrites: EqBandWrite[][] = [];

  openCalls = 0;
  closeCalls = 0;
  readAllCalls = 0;
  /** `readAll()` 的返回值；测试按需替换 */
  readResult: ParamReadResult = { preset: {}, device: null };
  /** 置 true 时 `open()` 直接把状态推到 error，用于验证降级路径 */
  failOpen = false;

  private _state: TransportState = 'idle';
  private readonly _levelListeners = new Set<(frame: LevelFrame) => void>();
  private readonly _stateListeners = new Set<(state: TransportState) => void>();
  private readonly _syncListeners = new Set<(phase: SyncPhase) => void>();
  private readonly _echoListeners = new Set<(echo: { readonly id: string; readonly value: number }) => void>();
  private readonly _errorListeners = new Set<(error: TransportError) => void>();
  private readonly _diagListeners = new Set<(entry: DiagEntry) => void>();

  constructor(kind: 'mock' | 'webhid' = 'webhid') {
    this.kind = kind;
  }

  state(): TransportState {
    return this._state;
  }

  async open(): Promise<void> {
    this.openCalls += 1;
    this.emitState(this.failOpen ? 'error' : 'ready');
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.emitState('idle');
  }

  write(updates: readonly ParamWrite[]): void {
    this.writes.push(updates.map((item) => ({ ...item })));
  }

  writeBands(updates: readonly EqBandWrite[]): void {
    this.bandWrites.push(updates.map((item) => ({ ...item })));
  }

  readAll(): Promise<ParamReadResult> {
    this.readAllCalls += 1;
    return Promise.resolve(this.readResult);
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

  onParamEcho(cb: (echo: { readonly id: string; readonly value: number }) => void): () => void {
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

  // ---- 测试侧推事件 ------------------------------------------------------

  emitLevels(frame: LevelFrame): void {
    for (const cb of [...this._levelListeners]) cb(frame);
  }

  emitState(state: TransportState): void {
    if (this._state === state) return;
    this._state = state;
    for (const cb of [...this._stateListeners]) cb(state);
  }

  emitSync(phase: SyncPhase): void {
    for (const cb of [...this._syncListeners]) cb(phase);
  }

  emitEcho(echo: { readonly id: string; readonly value: number }): void {
    for (const cb of [...this._echoListeners]) cb(echo);
  }

  emitError(error: TransportError): void {
    for (const cb of [...this._errorListeners]) cb(error);
  }

  emitDiag(entry: DiagEntry): void {
    for (const cb of [...this._diagListeners]) cb(entry);
  }

  /** 当前各事件集合的订阅数，用于断言"切通道后旧通道不再有转发监听" */
  listenerCounts(): Record<string, number> {
    return {
      levels: this._levelListeners.size,
      state: this._stateListeners.size,
      sync: this._syncListeners.size,
      echo: this._echoListeners.size,
      error: this._errorListeners.size,
      diag: this._diagListeners.size,
    };
  }
}
