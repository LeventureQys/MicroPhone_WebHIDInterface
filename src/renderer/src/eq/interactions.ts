import type { EqModel } from './model';
import { bandHasGain } from './types';

/** 坐标映射只需这四个方法，视图可在画布尺寸变化后替换实现。 */
export interface EqCoordinateMapper {
  freqToX(freq: number): number;
  gainToY(gainDb: number): number;
  xToFreq(x: number): number;
  yToGain(y: number): number;
}

export interface EqInteractionOptions {
  canvas: HTMLCanvasElement;
  model: EqModel;
  mapper: EqCoordinateMapper;
  onChange: () => void;
  hitRadius?: number;
  /** 返回 false 时曲线只展示、不响应拖拽/滚轮；缺省恒为可交互 */
  enabled?: () => boolean;
}

interface DragState {
  index: number;
  pointerId: number;
  mode: 'both' | 'freq' | 'gain';
}

function localPoint(canvas: HTMLCanvasElement, event: PointerEvent | WheelEvent): {
  x: number;
  y: number;
} {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function attachEqInteractions(options: EqInteractionOptions): () => void {
  const { canvas, model, mapper, onChange } = options;
  const hitRadius = options.hitRadius ?? 12;
  const isEnabled = (): boolean => options.enabled?.() !== false;
  let drag: DragState | null = null;
  let frame: number | null = null;
  let pending: { x: number; y: number } | null = null;

  const visibleBands = () =>
    model
      .allBands()
      .filter((band) => band.index < model.visibleCount())
      .map((band) => ({
        band,
        x: mapper.freqToX(band.freq),
        // 与 render 同一套规则：高通 / 低通的节点画在 0 dB，命中判定也得按 0 dB 算
        y: mapper.gainToY(bandHasGain(band.type) ? band.gain : 0),
      }));

  const findBand = (x: number, y: number): number | null => {
    let best: { index: number; distance: number } | null = null;
    for (const item of visibleBands()) {
      const distance = Math.hypot(item.x - x, item.y - y);
      if (distance <= hitRadius && (!best || distance < best.distance)) {
        best = { index: item.band.index, distance };
      }
    }
    return best ? best.index : null;
  };

  const applyMove = (x: number, y: number, mode: DragState['mode']): void => {
    if (!drag) return;
    const band = model.bandAt(drag.index);
    if (!band) return;
    const freq = mapper.xToFreq(x);
    const gain = mapper.yToGain(y);
    const patch: { freq?: number; gain?: number } = {};
    if (mode === 'both' || mode === 'freq') patch.freq = Math.round(freq);
    // 高通 / 低通没有增益：上下拖不动它，别把无效值写进状态（节点会一直贴在轴上）
    if ((mode === 'both' || mode === 'gain') && bandHasGain(band.type)) {
      patch.gain = Math.round(gain * 10) / 10;
    }
    model.setBand(drag.index, patch);
    onChange();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!isEnabled()) return;
    const { x, y } = localPoint(canvas, event);
    const index = findBand(x, y);
    if (index === null) {
      model.setFocused(-1);
      onChange();
      return;
    }
    model.setFocused(index);
    const mode: DragState['mode'] = event.shiftKey ? 'freq' : event.altKey ? 'gain' : 'both';
    drag = { index, pointerId: event.pointerId, mode };
    canvas.setPointerCapture(event.pointerId);
    canvas.dataset.cursor = 'grabbing';
    event.preventDefault();
    onChange();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!isEnabled()) {
      canvas.dataset.cursor = 'default';
      return;
    }
    const { x, y } = localPoint(canvas, event);
    if (!drag) {
      canvas.dataset.cursor = findBand(x, y) === null ? 'default' : 'grab';
      return;
    }
    pending = { x, y };
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!drag || !pending) return;
      applyMove(pending.x, pending.y, drag.mode);
      pending = null;
    });
  };

  const finish = (event: PointerEvent): void => {
    if (!drag) return;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    drag = null;
    pending = null;
    canvas.dataset.cursor = 'default';
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };

  const onPointerUp = (event: PointerEvent): void => finish(event);
  const onPointerCancel = (event: PointerEvent): void => finish(event);

  const onWheel = (event: WheelEvent): void => {
    if (!isEnabled()) return;
    const { x, y } = localPoint(canvas, event);
    const index = findBand(x, y);
    if (index === null) return;
    event.preventDefault();
    const band = model.bandAt(index);
    if (!band) return;
    const delta = event.deltaY < 0 ? 0.1 : -0.1;
    model.setBand(index, { q: Math.round((band.q + delta) * 10) / 10 });
    onChange();
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (!isEnabled()) return;
    const rect = canvas.getBoundingClientRect();
    const index = findBand(event.clientX - rect.left, event.clientY - rect.top);
    if (index === null) return;
    model.resetBandGain(index);
    onChange();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isEnabled()) return;
    const index = model.focusedIndex();
    if (index < 0 || index >= model.visibleCount()) return;
    const band = model.bandAt(index);
    if (!band) return;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        model.setBand(index, { freq: Math.round(band.freq / 1.02) });
        break;
      case 'ArrowRight':
        model.setBand(index, { freq: Math.round(band.freq * 1.02) });
        break;
      case 'ArrowUp':
        // 高通 / 低通没有增益：上下键对它们无效，左右键 / 滚轮照常
        if (bandHasGain(band.type)) model.setBand(index, { gain: Math.round((band.gain + 0.1) * 10) / 10 });
        break;
      case 'ArrowDown':
        if (bandHasGain(band.type)) model.setBand(index, { gain: Math.round((band.gain - 0.1) * 10) / 10 });
        break;
      case 'Delete':
      case 'Backspace':
        model.resetBandGain(index);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      onChange();
    }
  };

  canvas.tabIndex = 0;
  canvas.dataset.cursor = 'default';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDoubleClick);
    canvas.removeEventListener('keydown', onKeyDown);
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}
