import type { MockScene } from '../device/mock-transport';
import { EQ_BAND_COUNT, eqBandAddr, findRegister, fromRaw, toRaw } from '../device/registers';
import type { EqBandField, EqBandWrite, SyncPhase, Transport, TransportState } from '../device/transport';
import type { EqBand } from '../eq/types';
import { bandHasGain } from '../eq/types';
import type { Lang } from '../i18n';
import { currentLang, setLang as setI18nLang } from '../i18n';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from './defaults';
import { findParam } from './params';
import { DEFAULT_CUSTOM_GAINS, DEFAULT_TONE, type EqPresetId } from './quick-controls';
import { defaultSceneParams } from './scene-presets';
import type { SceneId } from './scenes';
import { quantize } from './values';

/** 事件名：'change' 携带完整快照，'param-changed' 携带 {id, value} */
export const CHANGE_EVENT = 'change';
export const PARAM_CHANGED_EVENT = 'param-changed';
/** 本地拦截：参数没有出站（只读 / 未同步），detail 为 { kind, id } */
export const LOCAL_ERROR_EVENT = 'local-error';
/** 场景的自动保存值被整体清空（设置页复位全部参数），视图层据此重读 localStorage */
export const SCENES_CLEARED_EVENT = 'scenes-cleared';

export type LocalErrorKind = 'readOnly' | 'notSynced';

export interface LocalErrorDetail {
  readonly kind: LocalErrorKind;
  readonly id: string;
}

/**
 * 需要「旁通」但协议没有全局使能位的模块只剩均衡器：
 * 打开时把 7 段 `enable` 全写 0，关闭时写回 1（0x2027 起的段使能位就是真正的旁通）。
 *
 * 噪声门与三分频动态在参数表 V0.3 补了使能位（`0x2074` / `0x2075`），
 * 它们和压缩器 / 限制器 / 环境降噪一样，直接用参数开关，不再用「中性参数」近似。
 */
export type BypassModule = 'eq';
export type BypassState = Readonly<Record<BypassModule, boolean>>;

export const BYPASS_MODULES: readonly BypassModule[] = Object.freeze(['eq']);

const DEFAULT_BYPASS: BypassState = Object.freeze({ eq: false });

export interface AppState {
  lang: Lang;
  params: Readonly<Record<string, number>>;
  bands: readonly EqBand[];
  transport: TransportState;
  scene: MockScene;
  /** 参数链路相位；只有 'ready' 时才允许往设备写出站帧（C4） */
  sync: SyncPhase;
  /** 「自定义」音色的 7 段增益（dB），由主界面曲线拖拽保存 */
  customEq: readonly number[];
  /**
   * 用户显式选中的音色（`null` = 还没选过，界面按曲线反推高亮）。
   * 不能只靠曲线反推：自定义曲线默认全平，会和固定「原声」撞成同一条。
   */
  tone: EqPresetId | null;
  /**
   * 当前选中的场景（2026-11-22 起场景可逐项微调并自动保存）：
   * 参数改动记到这个场景名下；`null` = 用户手动换过音色、离开了场景。
   * 放在 store 里是为了语言切换重建工作台后选择不丢（与 `tone` 同一个理由）。
   */
  activeScene: SceneId | null;
  /** 均衡器旁通状态（噪声门 / 三分频动态改用各自的使能位参数） */
  bypass: BypassState;
}

export interface ParamChangedDetail {
  id: string;
  value: number;
}

/**
 * 场景基准：最近一次「应用场景 / 启动对齐」时的完整快照。
 *
 * 恢复按钮的语义是「撤销到场景刚应用时的值」，不是「回到寄存器默认值」：
 * 设备回读、上一次会话保存的微调都可能不是默认值，拿默认值当目标会让按钮
 * 一打开就亮着。场景「复位」仍然回出厂预设，两者是不同的动作。
 */
export interface SceneBaseline {
  readonly scene: SceneId | null;
  readonly params: Readonly<Record<string, number>>;
  readonly bands: readonly EqBand[];
  readonly tone: EqPresetId | null;
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
  const type = quantizeBandField(band.index, 'type', band.type) as EqBand['type'];
  return {
    index: band.index,
    type,
    freq: quantizeBandField(band.index, 'freq', band.freq),
    // 高通 / 低通没有增益：音色预设 / 旧场景覆盖里带进来的值在这里就地归零，
    // 否则它会写进 `bandN.gain` 寄存器、却对曲线毫无影响（2026-11-25 用户反馈）
    gain: bandHasGain(type) ? quantizeBandField(band.index, 'gain', band.gain) : 0,
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
  return Object.freeze({
    ...state,
    params: Object.freeze({ ...state.params }),
    bands: Object.freeze(state.bands.map((band) => Object.freeze({ ...band }))),
    customEq: Object.freeze([...state.customEq]),
    bypass: Object.freeze({ ...state.bypass }),
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
  private _baseline: SceneBaseline | null = null;
  /** 设备回读 / 主动上报正在写 store：视图层据此区分「设备改的」和「用户改的」 */
  private _echoing = false;

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
      customEq: initial?.customEq ? [...initial.customEq] : DEFAULT_CUSTOM_GAINS,
      // 没传就按产品默认：软件打开时停在「自定义」音色（2026-11-22 问题单第 8 条）
      tone: initial?.tone ?? DEFAULT_TONE,
      // 与音色配套：打开即「自定义」场景，场景条也是这个高亮
      activeScene: initial?.activeScene ?? 'custom',
      bypass: initial?.bypass ?? DEFAULT_BYPASS,
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

  /** 最近一次「应用场景 / 启动对齐」的完整快照；恢复按钮以它为基准 */
  sceneBaseline(): SceneBaseline | null {
    return this._baseline;
  }

  /**
   * 记录场景基准。`dispatch=false` 用于设备回读期间的就地对齐：
   * 此时正在派发 change，再派发一次会重入同一个监听器。
   */
  setSceneBaseline(scene: SceneId | null = this._state.activeScene, dispatch = true): void {
    this._baseline = {
      scene,
      params: { ...this._state.params },
      bands: this._state.bands.map((band) => ({ ...band })),
      tone: this._state.tone,
    };
    if (dispatch) this._commit();
  }

  /**
   * 场景作用域内的值是否还等于基准（不看保存的覆盖值，覆盖值决定「复位」是否可点）。
   * `paramIds` 给定时只比这些参数——全局开关（静音 / 监听 / 灯效）不属于场景。
   * 频段只比 7 段增益：场景只覆盖增益，频点 / Q 的编辑不该点亮场景复位。
   */
  isAtSceneBaseline(paramIds?: readonly string[]): boolean {
    const baseline = this._baseline;
    if (!baseline) return true;
    const ids = paramIds ?? Object.keys(baseline.params);
    for (const id of ids) {
      if (this._state.params[id] !== baseline.params[id]) return false;
    }
    for (let index = 0; index < EQ_BAND_COUNT; index += 1) {
      if (this._state.bands[index]?.gain !== baseline.bands[index]?.gain) return false;
    }
    return this._state.tone === baseline.tone;
  }

  /** 设备回读 / 主动上报正在写 store：不要把它当成用户改动记进场景 */
  isApplyingEcho(): boolean {
    return this._echoing;
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
    this._echoing = true;
    try {
      this._commit();
    } finally {
      this._echoing = false;
    }
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
    this._echoing = true;
    try {
      this._commit();
    } finally {
      this._echoing = false;
    }
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

  /** 记录用户显式选择的音色（不下发；曲线本身由 `setBands` 写） */
  setTone(tone: EqPresetId | null): void {
    if (this._state.tone === tone) return;
    this._state = { ...this._state, tone };
    this._commit();
  }

  /** 记录当前场景（不下发；场景的参数由调用方经 `setParam` 写） */
  setActiveScene(scene: SceneId | null): void {
    if (this._state.activeScene === scene) return;
    this._state = { ...this._state, activeScene: scene };
    this._commit();
  }

  /**
   * 保存「自定义」音色的 7 段增益。
   *
   * 只是记住用户拖出来的曲线（下一次点「自定义」时还原），不单独下发：
   * 曲线本身已经经 `setBands` 写进设备了。
   */
  setCustomEq(gains: readonly number[]): void {
    const next: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const value = gains[index];
      next.push(
        Number.isFinite(value)
          ? Number(Math.min(12, Math.max(-32, Math.round(value * 10) / 10)).toFixed(1))
          : 0,
      );
    }
    if (next.every((value, index) => value === this._state.customEq[index])) return;
    this._state = { ...this._state, customEq: next };
    this._commit();
  }

  /**
   * 单项「恢复」的目标值：场景基准里这一项的值（撤销到场景刚应用时的状态）。
   *
   * 不是寄存器默认值：设备回读 / 上次会话的微调都可能不等于默认值，拿默认值当目标
   * 会让按钮一打开就亮着。没有基准（还没应用过场景）时才退回场景出厂值 / 寄存器默认值。
   */
  sceneTargetParam(id: string): number | undefined {
    const baseline = this._baseline?.params[id];
    if (baseline !== undefined) return baseline;
    const scene = this._state.activeScene;
    const factory = scene ? defaultSceneParams(scene)[id] : undefined;
    return factory ?? findParam(id)?.default;
  }

  isParamAtSceneTarget(id: string): boolean {
    const target = this.sceneTargetParam(id);
    return target === undefined || this._state.params[id] === target;
  }

  restoreParam(id: string): void {
    const target = this.sceneTargetParam(id);
    if (target === undefined) return;
    this.setParam(id, target);
  }

  /** EQ 单段恢复目标：场景基准里的频段（频点 / Q / 类型 / 增益） */
  sceneTargetBand(index: number): EqBand | undefined {
    const baseline = this._baseline?.bands[index];
    if (baseline) return { ...baseline };
    const factory = DEFAULT_BANDS[index];
    return factory ? { ...factory } : undefined;
  }

  isBandAtSceneTarget(index: number): boolean {
    const current = this._state.bands[index];
    const target = this.sceneTargetBand(index);
    if (!current || !target) return true;
    return (
      current.type === target.type &&
      current.freq === target.freq &&
      current.gain === target.gain &&
      current.q === target.q
    );
  }

  restoreBand(index: number): void {
    const current = this._state.bands[index];
    const target = this.sceneTargetBand(index);
    if (!current || !target) return;
    this.setBands(
      this._state.bands.map((band, bandIndex) =>
        bandIndex === index ? { ...band, type: target.type, freq: target.freq, gain: target.gain, q: target.q } : band,
      ),
    );
    if (this._state.tone === 'custom') {
      const gains = this._state.bands.slice(0, EQ_BAND_COUNT).map((band) => band.gain);
      this.setCustomEq(gains);
    }
  }

  /**
   * 通知视图层：所有场景的自动保存值已被清空（设置页「复位全部参数」）。
   *
   * 覆盖值存在 localStorage、由工作台视图持有，store 只负责广播；监听方据此重读，
   * 否则复位之后再点场景会把复位前的微调又写回去。
   */
  notifySceneOverridesCleared(): void {
    this.dispatchEvent(new CustomEvent(SCENES_CLEARED_EVENT));
  }

  /**
   * 均衡器旁通：协议没有全局 enable，用 7 段自带的段使能位实现真正的直通。
   *
   * 噪声门与三分频动态自参数表 V0.3 起有了模块使能位（`0x2074` / `0x2075`），
   * 与压缩器 / 限制器 / 环境降噪一样直接走 `setParam`，不在这里。
   */
  setBypass(module: BypassModule, enabled: boolean): void {
    if (this._state.bypass[module] === enabled) return;
    this.applyBypass(module, enabled);

    const updates: EqBandWrite[] = Array.from({ length: EQ_BAND_COUNT }, (_, index) => ({
      band: index + 1,
      field: 'enable',
      value: enabled ? 0 : 1,
    }));
    this._writeOrKeepLocal(updates);
  }

  /** 回读或固件复位只更新本地旁通状态。 */
  applyBypass(module: BypassModule, enabled: boolean): void {
    if (this._state.bypass[module] === enabled) return;
    this._state = { ...this._state, bypass: { ...this._state.bypass, [module]: enabled } };
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

  /** EQ 段 enable 写入：与 `setBands` 一样，回读未完成时只改本地 */
  private _writeOrKeepLocal(updates: readonly EqBandWrite[]): void {
    if (this._state.sync === 'ready' || this._transport.kind !== 'webhid') {
      this._transport.writeBands?.(updates);
    }
  }

  private _dispatchChange(): void {
    this.dispatchEvent(new CustomEvent<AppState>(CHANGE_EVENT, { detail: this._snapshot }));
  }

  private _dispatchLocalError(detail: LocalErrorDetail): void {
    this.dispatchEvent(new CustomEvent<LocalErrorDetail>(LOCAL_ERROR_EVENT, { detail }));
  }
}
