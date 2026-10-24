import type { MockScene } from '../device/mock-transport';
import { EQ_BAND_COUNT, eqBandAddr, findRegister, fromRaw, toRaw } from '../device/registers';
import type { EqBandField, EqBandWrite, SyncPhase, Transport, TransportState } from '../device/transport';
import type { EqBand } from '../eq/types';
import type { Lang } from '../i18n';
import { currentLang, setLang as setI18nLang } from '../i18n';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from './defaults';
import { findParam } from './params';
import { quantize } from './values';

/** 事件名：'change' 携带完整快照，'param-changed' 携带 {id, value} */
export const CHANGE_EVENT = 'change';
export const PARAM_CHANGED_EVENT = 'param-changed';
/** 本地拦截：参数没有出站（只读 / 未同步），detail 为 { kind, id } */
export const LOCAL_ERROR_EVENT = 'local-error';

export type LocalErrorKind = 'readOnly' | 'notSynced';

export interface LocalErrorDetail {
  readonly kind: LocalErrorKind;
  readonly id: string;
}

export interface AppState {
  lang: Lang;
  params: Readonly<Record<string, number>>;
  bands: readonly EqBand[];
  transport: TransportState;
  scene: MockScene;
  /** 参数链路相位；只有 'ready' 时才允许往设备写出站帧（C4） */
  sync: SyncPhase;
}

export interface ParamChangedDetail {
  id: string;
  value: number;
}

function copyBands(bands: readonly EqBand[]): EqBand[] {
  return bands.map((band) => ({ ...band }));
}

function sameBands(a: readonly EqBand[], b: readonly EqBand[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((band, i) => {
    const other = b[i];
    return (
      band === other ||
      (band.index === other.index &&
        band.type === other.type &&
        band.freq === other.freq &&
        band.gain === other.gain &&
        band.q === other.q)
    );
  });
}

/** EQ 数组下标的段号是 1..7；8..14 是设备内部段，既不量化也不下发（R2-4 / B7） */
function isEditableBand(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < EQ_BAND_COUNT;
}

/**
 * 工程量按寄存器表量化：走 `toRaw` 再 `fromRaw` 回来，本地值与即将下发的原始值就不会差一档。
 * （`domain/values.ts` 的 `quantize` 只吃 `ParamSpec`，EQ 段没有 paramId，只能借道寄存器规格。）
 */
function quantizeBandField(bandIndex: number, field: EqBandField, value: number): number {
  const register = findRegister(eqBandAddr(bandIndex, field));
  if (!register) return value;
  return fromRaw(register, toRaw(register, value));
}

function normalizeBand(band: EqBand): EqBand {
  if (!isEditableBand(band.index)) return { ...band };
  return {
    index: band.index,
    type: quantizeBandField(band.index, 'type', band.type) as EqBand['type'],
    freq: quantizeBandField(band.index, 'freq', band.freq),
    gain: quantizeBandField(band.index, 'gain', band.gain),
    q: quantizeBandField(band.index, 'q', band.q),
  };
}

/** 逐段逐字段比较，只把真正变化的字段交给通道层（段号 1 起，与 `band1`…`band7` 对齐） */
function diffBands(previous: readonly EqBand[], next: readonly EqBand[]): EqBandWrite[] {
  const updates: EqBandWrite[] = [];
  for (let index = 0; index < EQ_BAND_COUNT; index += 1) {
    const after = next[index];
    if (!after || !isEditableBand(after.index)) continue;
    const before = previous[index];
    const band = index + 1;
    if (!before || before.type !== after.type) updates.push({ band, field: 'type', value: after.type });
    if (!before || before.freq !== after.freq) updates.push({ band, field: 'freq', value: after.freq });
    if (!before || before.gain !== after.gain) updates.push({ band, field: 'gain', value: after.gain });
    if (!before || before.q !== after.q) updates.push({ band, field: 'q', value: after.q });
  }
  return updates;
}

/** 对外暴露的快照：外层与 params/bands 一并冻结，调用方不得就地改 */
function snapshot(state: AppState): AppState {
  return Object.freeze({    ...state,
    params: Object.freeze({ ...state.params }),
    bands: Object.freeze(state.bands.map((band) => Object.freeze({ ...band }))),
  });
}

/**
 * 状态唯一写入口：所有 UI 改动经 setter 进来，参数改动经 transport 出站。
 * 无变化的 setter 不派发事件，避免渲染层空转。
 */
export class AppStore extends EventTarget {
  private readonly _transport: Transport;
  private _state: AppState;
  private _snapshot: AppState;

  constructor(transport: Transport, initial?: Partial<AppState>) {
    super();
    this._transport = transport;
    this._state = {
      lang: initial?.lang ?? currentLang(),
      params: initial?.params ? { ...initial.params } : DEFAULT_PARAMS,
      bands: initial?.bands ? copyBands(initial.bands) : DEFAULT_BANDS,
      transport: initial?.transport ?? transport.state(),
      scene: initial?.scene ?? 'speech',
      sync: initial?.sync ?? 'idle',
    };
    this._snapshot = snapshot(this._state);

    transport.onStateChange((next) => {
      if (next === this._state.transport) return;
      this._state = { ...this._state, transport: next };
      this._commit();
    });
    // store 与 transport 同生命周期（main.ts 各建一次），因此不保存退订函数
    transport.onSync((phase) => this.setSync(phase));
  }

  get(): AppState {
    return this._snapshot;
  }

  /** 当前通道类型：顶栏据此区分"演示数据"与"已连接"（AppState 里不冗余存一份） */
  channelKind(): 'mock' | 'webhid' {
    return this._transport.kind;
  }

  /** 同步相位：有变化才派发，避免 50Hz 电平把顶栏刷成空转 */
  setSync(phase: SyncPhase): void {
    if (phase === this._state.sync) return;
    this._state = { ...this._state, sync: phase };
    this._commit();
  }

  setParam(id: string, value: number): void {
    const spec = findParam(id);
    if (!spec || spec.readonly) {
      // R2-3：只读参数拒绝得更早——连本地值都不改，由界面提示"只读"
      this._dispatchLocalError({ kind: 'readOnly', id });
      return;
    }
    const next = quantize(spec, value);
    if (next === this._state.params[id]) return;
    this._state = { ...this._state, params: { ...this._state.params, [id]: next } };
    this._snapshot = snapshot(this._state);
    if (this._state.sync !== 'ready' && this._transport.kind === 'webhid') {
      // C4：回读未完成前设备值未知，出站写会被回读覆盖，先只在本地生效
      this._dispatchChange();
      this._dispatchLocalError({ kind: 'notSynced', id });
      return;
    }
    this._transport.write([{ id, value: next }]);
    this._dispatchChange();
    this.dispatchEvent(
      new CustomEvent<ParamChangedDetail>(PARAM_CHANGED_EVENT, { detail: { id, value: next } }),
    );
  }

  /**
   * 设备回读回填：量化后直接覆盖本地值，**不发帧**（否则形成写环）。
   * 不是用户操作，因此不派发 PARAM_CHANGED_EVENT。
   */
  applyEcho(id: string, value: number): void {
    const spec = findParam(id);
    if (!spec) return;
    const next = quantize(spec, value);
    if (next === this._state.params[id]) return;
    this._state = { ...this._state, params: { ...this._state.params, [id]: next } };
    this._commit();
  }

  /**
   * 设备回读回填 EQ 段：覆盖本地值但**不发帧**。
   *
   * 与 `applyEcho` 同一语义。连接时 `session.sync()` 结束就会把相位推到 ready，
   * 回填发生在那一刻之后——若走 `setBands` 的差异写路径，连接动作本身就会把本地 EQ 值
   * 写回设备，等于用界面默认值覆盖设备预设（违反 R4-1"回读覆盖界面"）。
   */
  applyBands(bands: readonly EqBand[]): void {
    if (bands === this._state.bands) return;
    const next = bands.map((band) => normalizeBand(band));
    if (sameBands(next, this._state.bands)) return;
    this._state = { ...this._state, bands: next };
    this._commit();
  }

  /**
   * EQ 段更新：本地量化后落盘，再把**与上一版不同的字段**交给通道层（R2-5 的写半边）。
   *
   * 只写差异而不是整段：拖一次节点只会动 gain，没必要把该段 4 个字段重发一遍；
   * 同段多字段的地址相邻，`ParamSession` 会把它们合成一条 `0x11`（§6.4）。
   */
  setBands(bands: readonly EqBand[]): void {
    if (bands === this._state.bands) return;
    if (sameBands(bands, this._state.bands)) return;
    const next = bands.map((band) => normalizeBand(band));
    const updates = diffBands(this._state.bands, next);
    this._state = { ...this._state, bands: next };
    this._commit();
    if (updates.length === 0) return;
    // C4：回读未完成前设备值未知，写下去会被回读覆盖，先只在本地生效（与 setParam 同一门控）
    if (this._state.sync !== 'ready' && this._transport.kind === 'webhid') return;
    this._transport.writeBands?.(updates);
  }

  setLang(lang: Lang): void {
    setI18nLang(lang);
    if (lang === this._state.lang) return;
    this._state = { ...this._state, lang };
    this._commit();
  }

  setScene(scene: MockScene): void {
    if (scene === this._state.scene) return;
    // Transport 接口不含 setScene：MockTransport 才有，WebHID 联调后由设备回读确认
    const target = this._transport as Transport & { setScene?: (next: MockScene) => void };
    target.setScene?.(scene);
    this._state = { ...this._state, scene };
    this._commit();
  }

  /** 便捷订阅，语义等价于 subscribe('change', cb) */
  onChange(cb: (state: AppState) => void): () => void {
    const handler = (event: Event): void => {
      cb((event as CustomEvent<AppState>).detail);
    };
    this.addEventListener(CHANGE_EVENT, handler);
    return () => {
      this.removeEventListener(CHANGE_EVENT, handler);
    };
  }

  subscribe(_ev: typeof CHANGE_EVENT, cb: (state: AppState) => void): () => void {
    return this.onChange(cb);
  }

  private _commit(): void {
    this._snapshot = snapshot(this._state);
    this._dispatchChange();
  }

  private _dispatchChange(): void {
    this.dispatchEvent(new CustomEvent<AppState>(CHANGE_EVENT, { detail: this._snapshot }));
  }

  private _dispatchLocalError(detail: LocalErrorDetail): void {
    this.dispatchEvent(new CustomEvent<LocalErrorDetail>(LOCAL_ERROR_EVENT, { detail }));
  }
}
