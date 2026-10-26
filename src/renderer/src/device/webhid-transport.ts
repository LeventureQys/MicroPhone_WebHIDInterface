import { findParam, findParamByAddr } from '../domain/params';
import { DEFAULT_REPORT_IDS, type ReportIds } from './protocol';
import { ParamSession, levelToDb } from './proto/session';
import type { WordPair } from './proto/codec';
import { defaultClock, defaultTimers, TIMING, type Clock, type Timers } from './proto/timing';
import {
  EQ_BAND_BASE,
  EQ_BAND_COUNT,
  EQ_BAND_STRIDE,
  EQ_FIELD_ORDER,
  eqBandAddr,
  findRegister,
  fromRaw,
  toRaw,
} from './registers';
import type {
  DeviceBoundTransport,
  DiagEntry,
  EqBandField,
  EqBandWrite,
  LevelFrame,
  ParamEcho,
  ParamReadResult,
  ParamWrite,
  SelfCheckResult,
  SelfCheckStep,
  SessionStats,
  SyncPhase,
  TransportError,
  TransportState,
} from './transport';
import type { WebHidDeviceHandle } from './webhid/types';

export interface WebHidTransportOptions {
  /** 设备句柄；`open()` 会按需 `device.open()`，并要求句柄带 `sendReport` */
  readonly device: WebHidDeviceHandle;
  readonly reportIds?: ReportIds;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly timing?: Partial<typeof TIMING>;
}

/**
 * 自检结果的形状在 `transport.ts` 里定义一次（`DeviceBoundTransport.selfCheck?` 要用），
 * 这里只转出，避免两处结构重复漂移。
 */
export type { SelfCheckResult, SelfCheckStep } from './transport';

/** 输出通道没有采集通路（R5-4）：`outputValid` 恒 false，两栏由界面显示 — */
const SILENT_DB = -96;
/** 峰值保持的线性回落窗口（§6.5 / 任务书 §4.3 第 5 条） */
const PEAK_DECAY_MS = 300;
/** 未开会话时的统计基线（诊断面板未连接状态用） */
const ZERO_STATS: SessionStats = Object.freeze({
  outFrames: 0,
  inFrames: 0,
  crcErrors: 0,
  timeouts: 0,
  retries: 0,
  droppedPolls: 0,
  queueDepth: 0,
});

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return null;
}

/** 会话 reject 的 `Error` 上挂着原始 `TransportError`（3.1 的口径），拿不到就归为通道错误 */
function transportErrorOf(cause: unknown): TransportError {
  const wrapped = (cause as { transportError?: TransportError } | null)?.transportError;
  if (wrapped) return wrapped;
  return { kind: 'disconnected', message: messageOf(cause) };
}

/**
 * EQ 段地址反查：`0x2027` 起每段 5 个，段内顺序 enable/type/freq/gain/q。
 *
 * 段使能（段内偏移 0）不算可回填字段——B7 规定设备不回填、上位机也不写；
 * 返回 null 表示"这条上报没有本地模型"，调用方直接忽略。
 */
function bandFieldOf(addr: number): { readonly band: number; readonly field: EqBandField } | null {
  if (addr < EQ_BAND_BASE || addr >= EQ_BAND_BASE + EQ_BAND_COUNT * EQ_BAND_STRIDE) return null;
  const offset = addr - EQ_BAND_BASE;
  const field = EQ_FIELD_ORDER[offset % EQ_BAND_STRIDE];
  if (field === 'enable') return null;
  return { band: Math.floor(offset / EQ_BAND_STRIDE) + 1, field };
}

/**
 * 真实设备的 Transport：把 `ParamSession`（纯协议）接到 WebHID 句柄上。
 *
 * 分工：超时、重试、写合并、轮询节流全在 3.1 的 `ParamSession` 里，
 * 本类只做四件事——报文出入（`sendReport` / `inputreport`）、参数 id ↔ 地址换算、
 * 电平映射与峰值保持、把会话事件翻成 `Transport` 事件。
 */
export class WebHidTransport implements DeviceBoundTransport {
  readonly kind = 'webhid' as const;
  /** 4.2 的 DFU 会话要直接 `sendReport`，因此这里公开句柄与报告号（只读） */
  readonly device: WebHidDeviceHandle;
  readonly reportIds: ReportIds;

  private readonly _clock: Clock;
  private readonly _timers: Timers;
  private readonly _timing: typeof TIMING;

  private readonly _levelListeners = new Set<(frame: LevelFrame) => void>();
  private readonly _stateListeners = new Set<(state: TransportState) => void>();
  private readonly _syncListeners = new Set<(phase: SyncPhase) => void>();
  private readonly _echoListeners = new Set<(echo: ParamEcho) => void>();
  private readonly _errorListeners = new Set<(error: TransportError) => void>();
  private readonly _diagListeners = new Set<(entry: DiagEntry) => void>();
  private readonly _inputListeners = new Set<(bytes: Uint8Array) => void>();

  private _session: ParamSession | null = null;
  private _state: TransportState = 'idle';
  private _listening = false;
  private _suspended = false;
  private _lastPeak: number | null = null;
  private _lastLevelAt: number | null = null;
  /** 最后一条 IN 报告的时刻；入站看门狗据此判"设备不说话" */
  private _lastInboundAt = 0;
  private _watchdogTimer: unknown = null;

  constructor(options: WebHidTransportOptions) {
    this.device = options.device;
    this.reportIds = options.reportIds ?? DEFAULT_REPORT_IDS;
    this._clock = options.clock ?? defaultClock();
    this._timers = options.timers ?? defaultTimers();
    this._timing = { ...TIMING, ...options.timing };
  }

  state(): TransportState {
    return this._state;
  }

  async open(): Promise<void> {
    if (this._state === 'ready' || this._state === 'connecting') return;
    this._setState('connecting');

    const device = this.device;
    try {
      if (!device.opened) await device.open();
    } catch (error) {
      this._fail({ kind: 'disconnected', message: `打开设备失败：${messageOf(error)}` });
      return;
    }

    const sendReport = device.sendReport;
    if (typeof sendReport !== 'function') {
      // 没有出站通路就无法承载参数协议：宁可整条链路报错，也不要留下"看起来已连接"的假象
      this._fail({ kind: 'disconnected', message: '设备句柄没有 sendReport，无法发送参数帧' });
      return;
    }

    this._listen(device);
    const session = new ParamSession({
      // 一帧可能被切成多包，按顺序逐包发出并等待背压（S-l）
      send: async (reports: readonly Uint8Array[]): Promise<void> => {
        for (const report of reports) await sendReport.call(device, this.reportIds.out, report);
      },
      reportIds: this.reportIds,
      clock: this._clock,
      timers: this._timers,
      timing: this._timing,
      onPhase: (phase) => this._handlePhase(phase),
      onEcho: (addr, raw) => this._handleEcho(addr, raw),
      onError: (error) => {
        // 致命错误统一由 _handlePhase('error') 派发一次 disconnected，这里只转发可恢复的本地错误
        if (this._session?.phase() === 'error') return;
        this._emit(this._errorListeners, error);
      },
      onDiag: (entry) => this._emit(this._diagListeners, entry),
      onLevel: (sample) => this._handleLevel(sample.raw, sample.at),
    });
    this._session = session;
    // 轮询在同步完成后自动开启（S-e 末尾的 startPolling 只看这个开关），
    // 因此必须在 sync() 之前置位，否则电平永远不来（R5）
    session.setPolling(true);

    try {
      await session.sync();
    } catch (error) {
      this._fail(transportErrorOf(error));
      return;
    }
    this._suspended = false;
    this._setState('ready');
    this._startWatchdog();
  }

  async close(): Promise<void> {
    this._stopWatchdog();
    this._unlisten(this.device);
    const session = this._session;
    this._session = null;
    session?.dispose();
    this._lastPeak = null;
    this._lastLevelAt = null;
    this._suspended = false;
    this._setState('idle');
  }

  write(updates: readonly ParamWrite[]): void {
    const pairs: WordPair[] = [];
    for (const update of updates ?? []) {
      const spec = findParam(update.id);
      if (!spec) {
        this._emit(this._errorListeners, {
          kind: 'len',
          id: update.id,
          message: `未知参数 id：${update.id}`,
        });
        continue;
      }
      if (spec.readonly) {
        // R2-3/R3-3：只读参数一帧都不发，错误经 onError 上报，由 store 侧提示
        this._emit(this._errorListeners, {
          kind: 'readOnly',
          id: spec.id,
          addr: spec.addr,
          message: `只读参数不接受写入：${spec.id}`,
        });
        continue;
      }
      const register = findRegister(spec.addr);
      if (!register) {
        this._emit(this._errorListeners, {
          kind: 'len',
          id: spec.id,
          message: `参数缺少寄存器定义：${spec.id}`,
        });
        continue;
      }
      pairs.push({ addr: spec.addr, raw: toRaw(register, update.value) });
    }
    const session = this._session;
    if (session === null || pairs.length === 0) return;
    if (this._suspended) return;
    session.write(pairs);
  }

  /**
   * EQ 可调段写入：段号 1..7 → `eqBandAddr(band-1, field)`，工程量经寄存器规格换算成原始值。
   * 与标量共用 `ParamSession` 的节流与合并——同段的四个字段地址相邻，会被合成一条 `0x11`。
   */
  writeBands(updates: readonly EqBandWrite[]): void {
    const pairs: WordPair[] = [];
    for (const update of updates ?? []) {
      if (!Number.isInteger(update.band) || update.band < 1 || update.band > EQ_BAND_COUNT) {
        this._emit(this._errorListeners, {
          kind: 'range',
          message: `EQ 段号越界（应为 1..${EQ_BAND_COUNT}）：${update.band}`,
        });
        continue;
      }
      const register = findRegister(eqBandAddr(update.band - 1, update.field));
      if (!register) {
        this._emit(this._errorListeners, {
          kind: 'len',
          message: `EQ 字段缺少寄存器定义：band ${update.band}.${update.field}`,
        });
        continue;
      }
      pairs.push({ addr: register.addr, raw: toRaw(register, update.value) });
    }
    const session = this._session;
    if (session === null || pairs.length === 0) return;
    if (this._suspended) return;
    session.write(pairs);
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

  /**
   * 全量回读：42 项标量按 `findParamByAddr` 换回工程量，
   * EQ 可调段另装进 `bands`（键为寄存器字段名，见 `ParamReadResult`）。
   */
  async readAll(): Promise<ParamReadResult> {
    const session = this._session;
    if (session === null) throw new Error('通道尚未打开，无法回读');
    const result = await session.sync();
    const preset: Record<string, number> = {};
    for (const [addrText, raw] of Object.entries(result.preset.values)) {
      const spec = findParamByAddr(Number(addrText));
      if (!spec) continue;
      const register = findRegister(spec.addr);
      if (!register) continue;
      preset[spec.id] = fromRaw(register, raw);
    }
    return { preset, device: result.device, bands: this._bandsFromPreset(result.preset.values) };
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

  /**
   * 原始 IN 载荷订阅（不含 report ID）。
   *
   * DFU 期间参数会话被 `suspend()` 掐断喂字节，但字节仍在这里派发；
   * 订阅方（4.2 的 DFU 会话）自己拆 SigmaBus 帧，两边互不抢流。
   */
  onInputBytes(cb: (bytes: Uint8Array) => void): () => void {
    this._inputListeners.add(cb);
    return () => {
      this._inputListeners.delete(cb);
    };
  }

  /**
   * 参数会话的统计快照。会话未建（未 open / 已 close）时给全 0，
   * 诊断面板据此在未连接时显示 0 而不是崩溃或显示上次的数字。
   */
  stats(): SessionStats {
    const session = this._session;
    if (session === null) return { ...ZERO_STATS };
    return session.stats();
  }

  /**
   * 自检（R8-2/R8-3）：回读全量 → 读 ENC 档位 → 写回原值再读比对。
   * 只写"原值"，因此无论成功失败都不改变设备状态。
   */
  async selfCheck(): Promise<SelfCheckResult> {
    const steps: SelfCheckStep[] = [];
    const session = this._session;
    const target = findParam('enc.Level');
    const register = target ? findRegister(target.addr) : undefined;
    if (session === null) {
      return { ok: false, steps: [{ name: 'session', ok: false, detail: '通道尚未打开' }] };
    }
    if (!target || !register) {
      return { ok: false, steps: [{ name: 'spec', ok: false, detail: 'enc.Level 未定义' }] };
    }

    try {
      await session.sync();
      steps.push({ name: 'sync', ok: true, detail: '回读全量完成' });
    } catch (error) {
      steps.push({ name: 'sync', ok: false, detail: messageOf(error) });
      return { ok: false, steps };
    }

    let raw = 0;
    try {
      const reply = await session.read([target.addr]);
      const entry = reply.entries.find((item) => item.addr === target.addr);
      if (!entry) throw new Error('应答里没有目标地址');
      raw = entry.raw;
      steps.push({
        name: 'read',
        ok: true,
        detail: `0x${target.addr.toString(16).toUpperCase()} = ${fromRaw(register, raw)}`,
      });
    } catch (error) {
      steps.push({ name: 'read', ok: false, detail: messageOf(error) });
      return { ok: false, steps };
    }

    try {
      session.write([{ addr: target.addr, raw }]);
      // 写走的是合并节流队列：先让它发出去，再留一次请求超时的余量等应答
      await this._wait(this._timing.writeThrottleMs + this._timing.requestTimeoutMs);
      const reply = await session.read([target.addr]);
      const entry = reply.entries.find((item) => item.addr === target.addr);
      const ok = entry !== undefined && entry.raw === raw;
      steps.push({
        name: 'writeBack',
        ok,
        detail: ok ? '写回原值并读回一致' : `写回后读回不一致（期望 ${raw}，实得 ${entry?.raw ?? '无应答'}）`,
      });
    } catch (error) {
      steps.push({ name: 'writeBack', ok: false, detail: messageOf(error) });
    }

    return { ok: steps.every((step) => step.ok), steps };
  }

  /**
   * DFU 前：停轮询、停喂参数会话、丢弃新写；不 dispose（升级结束后还要用同一个会话）。
   * 入站字节仍旧派发给 `onInputBytes` 订阅者，DFU 会话才能拿到状态帧。
   */
  async suspend(): Promise<void> {
    this._suspended = true;
    this._session?.setPolling(false);
  }

  /** DFU 后：恢复喂字节与轮询并重新同步；状态机回到 ready 由 `session.sync()` 的成功决定 */
  async resume(): Promise<void> {
    this._suspended = false;
    const session = this._session;
    if (session === null) {
      await this.open();
      return;
    }
    try {
      await session.sync();
      session.setPolling(true);
      this._setState('ready');
      this._startWatchdog();
    } catch (error) {
      this._fail(transportErrorOf(error));
    }
  }

  // ---- 入站 --------------------------------------------------------------

  private readonly _onInputReport = (event: Event): void => {
    const detail = (event as { detail?: unknown }).detail ?? event;
    const report = detail as { reportId?: unknown; data?: unknown };
    const reportId = Number(report.reportId ?? 0);
    if (reportId !== this.reportIds.in) return;
    const bytes = toBytes(report.data);
    if (bytes === null || bytes.length === 0) return;
    // 任何一条 IN 报告都算"设备还活着"，DFU 期间也算（看门狗只在 ready 且未挂起时判定）
    this._lastInboundAt = this._clock.now();
    // 一路：原始载荷——DFU 期间参数会话不说话，但字节必须照旧派发给订阅者
    this._emit(this._inputListeners, bytes);
    if (this._suspended) return;
    // 另一路：参数会话（report ID 由 HID 层剥掉，63 B 补位零由 decodeStream 消解，R-1）
    this._session?.handleBytes(bytes);
  };

  private readonly _onDisconnect = (): void => {
    // 拔线：停轮询并让整条链路进 error，DeviceLink 据此切回演示数据（R5-3）
    this._stopWatchdog();
    this._session?.setPolling(false);
    this._setState('error');
    this._emit(this._errorListeners, { kind: 'disconnected', message: '设备已断开' });
  };

  private _listen(device: WebHidDeviceHandle): void {
    if (this._listening) return;
    device.addEventListener('inputreport', this._onInputReport);
    device.addEventListener('disconnect', this._onDisconnect);
    this._listening = true;
  }

  private _unlisten(device: WebHidDeviceHandle): void {
    if (!this._listening) return;
    try {
      device.removeEventListener('inputreport', this._onInputReport);
      device.removeEventListener('disconnect', this._onDisconnect);
    } catch {
      // 设备对象已释放时移除监听会抛，忽略：这条链路本来就要废弃了
    }
    this._listening = false;
  }

  // ---- 会话事件 → Transport 事件 ------------------------------------------

  private _handlePhase(phase: SyncPhase): void {
    this._emit(this._syncListeners, phase);
    if (phase !== 'error') return;
    this._stopWatchdog();
    this._session?.setPolling(false);
    this._setState('error');
    this._emit(this._errorListeners, {
      kind: 'disconnected',
      message: '参数会话进入 error（请求超时或通道错误），请重新连接',
    });
  }

  /**
   * 设备主动上报的一条 `(addr, raw)`（协议 0x10 的设备→主机方向）。
   *
   * 地址落在三处之一：42 项标量 → `param`；EQ 可调段 → `band`；其余（预设名、保留位、
   * 设备内部段）本版本没有本地模型，直接忽略。0x2057 电平不走这里（会话先分流到 onLevel）。
   */
  private _handleEcho(addr: number, raw: number): void {
    const register = findRegister(addr);
    if (!register) return;
    const value = fromRaw(register, raw);
    const spec = findParamByAddr(addr);
    if (spec) {
      this._emit(this._echoListeners, { kind: 'param', id: spec.id, value });
      return;
    }
    const band = bandFieldOf(addr);
    if (!band) return;
    this._emit(this._echoListeners, { kind: 'band', band: band.band, field: band.field, value });
  }

  /**
   * 电平：`raw 0..256` 线性映射到 dBFS（B4 未标定），峰值保持按 300 ms 线性回落。
   * 输出通道没有采集通路，两栏固定 `-96` 且 `outputValid = false`（R5-4）。
   */
  private _handleLevel(raw: number, at: number): void {
    const rms = levelToDb(raw);
    let peak = rms;
    if (this._lastPeak !== null && this._lastLevelAt !== null) {
      const elapsed = Math.max(0, at - this._lastLevelAt);
      const decayed = this._lastPeak - (elapsed / PEAK_DECAY_MS) * (this._lastPeak - rms);
      peak = Math.max(rms, decayed);
    }
    this._lastPeak = peak;
    this._lastLevelAt = at;
    const frame: LevelFrame = {
      t: at,
      inputRms: rms,
      inputPeak: peak,
      outputRms: SILENT_DB,
      outputPeak: SILENT_DB,
      inputValid: true,
      outputValid: false,
    };
    this._emit(this._levelListeners, frame);
  }

  // ---- 内部工具 ----------------------------------------------------------

  private _bandsFromPreset(
    values: Readonly<Record<number, number>>,
  ): Readonly<Record<string, number>> | undefined {
    const bands: Record<string, number> = {};
    let found = 0;
    for (let band = 0; band < EQ_BAND_COUNT; band += 1) {
      for (const field of EQ_FIELD_ORDER) {
        // B7：段的 Enable 只回读记录、不回填也不写，界面侧保持设备原值
        if (field === 'enable') continue;
        const spec = findRegister(eqBandAddr(band, field));
        if (!spec) continue;
        const raw = values[spec.addr];
        if (raw === undefined) continue;
        bands[spec.field] = fromRaw(spec, raw);
        found += 1;
      }
    }
    return found > 0 ? bands : undefined;
  }

  private _wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this._timers.setTimeout(resolve, ms);
    });
  }

  // ---- 入站看门狗（R5-3） --------------------------------------------------

  /**
   * 从"现在"重新起算静默窗口。open/resume 成功后调用：刚同步完一定刚收到过字节，
   * 若沿用旧时间戳会把正常连接立刻判成掉线。
   */
  private _startWatchdog(): void {
    this._stopWatchdog();
    this._lastInboundAt = this._clock.now();
    this._scheduleWatchdog();
  }

  private _stopWatchdog(): void {
    if (this._watchdogTimer === null) return;
    this._timers.clearTimeout(this._watchdogTimer);
    this._watchdogTimer = null;
  }

  private _scheduleWatchdog(): void {
    this._watchdogTimer = this._timers.setTimeout(() => {
      this._watchdogTimer = null;
      this._checkWatchdog();
    }, this._timing.inboundCheckMs);
  }

  private _checkWatchdog(): void {
    // DFU 挂起或已不在 ready 时既不判定也不再排下一拍；恢复时由 open/resume 重新起表
    if (this._state !== 'ready' || this._suspended) return;
    const silentMs = this._clock.now() - this._lastInboundAt;
    if (silentMs > this._timing.inboundWatchdogMs) {
      this._handleSilentChannel(silentMs);
      return;
    }
    this._scheduleWatchdog();
  }

  /**
   * 长时间零入站：轮询超时不会报错（S-f），所以沉默只能在这里升级成通道错误，
   * 否则顶栏会一直显示"已连接/已同步"，而电平其实早就没有数据了。
   */
  private _handleSilentChannel(silentMs: number): void {
    this._stopWatchdog();
    this._session?.setPolling(false);
    this._setState('error');
    this._emit(this._errorListeners, {
      kind: 'disconnected',
      message: `连续 ${silentMs} ms 收不到任何入站报告，判定设备已断开`,
    });
  }

  private _setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    this._emit(this._stateListeners, next);
  }

  private _fail(error: TransportError): void {
    this._stopWatchdog();
    this._unlisten(this.device);
    const session = this._session;
    this._session = null;
    session?.dispose();
    this._setState('error');
    this._emit(this._errorListeners, error);
  }

  private _emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const cb of [...listeners]) cb(value);
  }
}
