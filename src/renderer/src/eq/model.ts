/**
 * EQ 段模型：14 段固定（7 段上位机可调 + 7 段内部段），继承 EventTarget 派发变更事件。
 *
 * 纯数据模型：不引用 DOM / Canvas / Electron。写入口只有 setBand / resetBandGain / setFocused，
 * 所有数值在入口按 params 契约夹紧并量化，因此下游渲染永远拿到合法值。
 */

import type { EqBand, EqFilterType } from './types';
import { EQ_BAND_EDITABLE, EQ_BAND_TOTAL } from './types';
import { DEFAULT_BANDS } from '../domain/defaults';

export interface BandChangeDetail {
  index: number;
  band: EqBand;
}

export interface FocusChangeDetail {
  index: number;
}

export const BAND_CHANGED = 'band-changed';
export const FOCUS_CHANGED = 'focus-changed';

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const FREQ_STEP = 1;
const GAIN_MIN = -32;
const GAIN_MAX = 12;
const GAIN_STEP = 0.1;
const Q_MIN = 0.1;
const Q_MAX = 12;
const Q_STEP = 0.1;
const TYPE_MIN = 0;
const TYPE_MAX = 4;
const TYPE_STEP = 1;
/** 段落默认状态：平坦 PEAK，Q = 0.7（与 defaults.ts / 参数表一致） */
const DEFAULT_GAIN = 0;
const DEFAULT_Q = 0.7;
const NO_FOCUS = -1;

function snap(raw: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, raw));
  const snapped = min + Math.round((clamped - min) / step) * step;
  // 浮点误差修正：0.1 + 6 * 0.1 = 0.7000000000000001 不能原样进 UI
  const fixed = Number(snapped.toFixed(6));
  return Math.min(max, Math.max(min, fixed));
}

/** 非有限输入返回 null，交由调用方保留旧值（不产生 NaN，也不派发事件） */
function snapOptional(
  raw: number | undefined,
  min: number,
  max: number,
  step: number,
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return snap(raw, min, max, step);
}

function resolveIndex(band: EqBand, position: number): number {
  if (Number.isInteger(band.index) && band.index >= 0 && band.index < EQ_BAND_TOTAL) {
    return band.index;
  }
  return Math.min(EQ_BAND_TOTAL - 1, Math.max(0, position));
}

function normalizeBand(band: EqBand, position: number): EqBand {
  return {
    index: resolveIndex(band, position),
    type: snap(band.type, TYPE_MIN, TYPE_MAX, TYPE_STEP) as EqFilterType,
    freq: snap(band.freq, FREQ_MIN, FREQ_MAX, FREQ_STEP),
    gain: snap(band.gain, GAIN_MIN, GAIN_MAX, GAIN_STEP),
    q: snap(band.q, Q_MIN, Q_MAX, Q_STEP),
  };
}

export class EqModel extends EventTarget {
  private readonly _bands = new Map<number, EqBand>();

  private _focused = NO_FOCUS;

  constructor(bands: readonly EqBand[] = DEFAULT_BANDS) {
    super();
    // 空数组按"未传"处理：Alpha 固定 14 段，不存在零段模型
    const source = Array.isArray(bands) && bands.length > 0 ? bands : DEFAULT_BANDS;
    source.forEach((band, position) => {
      const normalized = normalizeBand(band, position);
      this._bands.set(normalized.index, normalized);
    });
  }

  bandAt(index: number): EqBand | undefined {
    const band = this._bands.get(index);
    return band ? { ...band } : undefined;
  }

  allBands(): readonly EqBand[] {
    return Array.from(this._bands.values())
      .sort((left, right) => left.index - right.index)
      .map((band) => ({ ...band }));
  }

  setBand(index: number, patch: Partial<Pick<EqBand, 'type' | 'freq' | 'gain' | 'q'>>): void {
    const current = this._bands.get(index);
    if (!current) return;
    const next: EqBand = { ...current };
    const type = snapOptional(patch?.type, TYPE_MIN, TYPE_MAX, TYPE_STEP);
    if (type !== null) next.type = type as EqFilterType;
    const freq = snapOptional(patch?.freq, FREQ_MIN, FREQ_MAX, FREQ_STEP);
    if (freq !== null) next.freq = freq;
    const gain = snapOptional(patch?.gain, GAIN_MIN, GAIN_MAX, GAIN_STEP);
    if (gain !== null) next.gain = gain;
    const q = snapOptional(patch?.q, Q_MIN, Q_MAX, Q_STEP);
    if (q !== null) next.q = q;
    // 量化后无变化则静默返回，避免渲染层因同值事件空转
    if (
      next.type === current.type
      && next.freq === current.freq
      && next.gain === current.gain
      && next.q === current.q
    ) {
      return;
    }
    this._bands.set(index, next);
    this.emit(BAND_CHANGED, { index, band: { ...next } } satisfies BandChangeDetail);
  }

  resetBandGain(index: number): void {
    this.setBand(index, { gain: DEFAULT_GAIN, q: DEFAULT_Q });
  }

  focusedIndex(): number {
    return this._focused;
  }

  setFocused(index: number): void {
    const next = Number.isInteger(index) && index >= 0 && index < EQ_BAND_TOTAL ? index : NO_FOCUS;
    if (next === this._focused) return;
    this._focused = next;
    this.emit(FOCUS_CHANGED, { index: next } satisfies FocusChangeDetail);
  }

  visibleCount(): number {
    return EQ_BAND_EDITABLE;
  }

  private emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
