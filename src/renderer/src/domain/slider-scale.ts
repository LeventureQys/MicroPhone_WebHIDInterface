import type { ParamSpec } from './params';

/**
 * 时间常数与频率跨数量级，线性滑块会把 99% 的行程压在无效区
 * （例：Comp.Attack 0.0001–0.2 s，默认 0.0005 只占 0.2% 行程），
 * 因此这些参数在 UI 上走对数轴；协议范围本身不变。
 */
const LOG_IDS = new Set([
  'noisegate.attack_ms',
  'noisegate.release_ms',
  'comp.Attack',
  'comp.Release',
  'comp.Rate',
  'limit.Attack',
  'limit.Release',
  'drc3.fc1',
  'drc3.fc2',
  'drc3.low.attackTime',
  'drc3.low.releaseTime',
  'drc3.mid.attackTime',
  'drc3.mid.releaseTime',
  'drc3.high.attackTime',
  'drc3.high.releaseTime',
]);

export type SliderScale = 'linear' | 'log';

/** range 输入固定 0..1000 的整数行程，便于键盘微调与测试断言 */
export const SLIDER_STEPS = 1000;

export function scaleOf(spec: ParamSpec): SliderScale {
  // 对数轴要求两端同号且为正；防御性兜底，避免新增参数时除零
  return LOG_IDS.has(spec.id) && spec.min > 0 && spec.max > spec.min ? 'log' : 'linear';
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/** 参数值 → 滑块行程 0..1000 */
export function toSliderPosition(spec: ParamSpec, value: number): number {
  const ratio =
    scaleOf(spec) === 'log'
      ? Math.log(value / spec.min) / Math.log(spec.max / spec.min)
      : (value - spec.min) / (spec.max - spec.min);
  return Math.round(clampRatio(ratio) * SLIDER_STEPS);
}

/** 滑块行程 0..1000 → 参数值（未量化，调用方负责 quantize） */
export function fromSliderPosition(spec: ParamSpec, position: number): number {
  const ratio = clampRatio(position / SLIDER_STEPS);
  if (scaleOf(spec) === 'linear') {
    return spec.min + ratio * (spec.max - spec.min);
  }
  return spec.min * Math.pow(spec.max / spec.min, ratio);
}
