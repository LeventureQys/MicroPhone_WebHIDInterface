import type { MockScene } from '../device/mock-transport';
import type { Transport, TransportState } from '../device/transport';
import type { EqBand } from '../eq/types';
import { EQ_BAND_EDITABLE } from '../eq/types';
import type { Lang } from '../i18n';
import { currentLang, setLang as setI18nLang } from '../i18n';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from './defaults';
import { findParam } from './params';
import { quantize } from './values';

export type AppModule = 'meter' | 'input' | 'eq' | 'dynamics' | 'drc' | 'device' | 'settings';

/** 事件名：'change' 携带完整快照，'param-changed' 携带 {id, value} */
export const CHANGE_EVENT = 'change';
export const PARAM_CHANGED_EVENT = 'param-changed';

export interface AppState {
  lang: Lang;
  module: AppModule;
  params: Readonly<Record<string, number>>;
  bands: readonly EqBand[];
  /** -1..6，可见（可调）段范围 */
  focusedBand: number;
  transport: TransportState;
  scene: MockScene;
}

export interface ParamChangedDetail {
  id: string;
  value: number;
}

const MIN_FOCUS = -1;
const MAX_FOCUS = EQ_BAND_EDITABLE - 1;

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

/** 对外暴露的快照：外层与 params/bands 一并冻结，调用方不得就地改 */
function snapshot(state: AppState): AppState {
  return Object.freeze({
    ...state,
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
      module: initial?.module ?? 'meter',
      params: initial?.params ? { ...initial.params } : DEFAULT_PARAMS,
      bands: initial?.bands ? copyBands(initial.bands) : DEFAULT_BANDS,
      focusedBand: initial?.focusedBand ?? MIN_FOCUS,
      transport: initial?.transport ?? transport.state(),
      scene: initial?.scene ?? 'speech',
    };
    this._snapshot = snapshot(this._state);

    transport.onStateChange((next) => {
      if (next === this._state.transport) return;
      this._state = { ...this._state, transport: next };
      this._commit();
    });
  }

  get(): AppState {
    return this._snapshot;
  }

  setParam(id: string, value: number): void {
    const spec = findParam(id);
    if (!spec || spec.readonly) return;
    const next = quantize(spec, value);
    if (next === this._state.params[id]) return;
    this._state = { ...this._state, params: { ...this._state.params, [id]: next } };
    this._snapshot = snapshot(this._state);
    this._transport.write([{ id, value: next }]);
    this._dispatchChange();
    this.dispatchEvent(
      new CustomEvent<ParamChangedDetail>(PARAM_CHANGED_EVENT, { detail: { id, value: next } }),
    );
  }

  setBands(bands: readonly EqBand[]): void {
    if (bands === this._state.bands) return;
    if (sameBands(bands, this._state.bands)) return;
    this._state = { ...this._state, bands: copyBands(bands) };
    this._commit();
  }

  setFocus(index: number): void {
    if (!Number.isFinite(index)) return;
    const next = Math.min(MAX_FOCUS, Math.max(MIN_FOCUS, Math.trunc(index)));
    if (next === this._state.focusedBand) return;
    this._state = { ...this._state, focusedBand: next };
    this._commit();
  }

  setModule(module: AppModule): void {
    if (module === this._state.module) return;
    this._state = { ...this._state, module };
    this._commit();
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
}
