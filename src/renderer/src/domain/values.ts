import type { ParamSpec } from './params';

function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  if (step >= 0.001) return 3;
  return 4;
}

export function clampValue(spec: ParamSpec, raw: number): number {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return spec.default;
  if (raw === Number.POSITIVE_INFINITY) return spec.max;
  if (raw === Number.NEGATIVE_INFINITY) return spec.min;
  if (!Number.isFinite(raw)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, raw));
}

export function quantize(spec: ParamSpec, value: number): number {
  const clamped = clampValue(spec, value);
  const ratio = (clamped - spec.min) / spec.step;
  // 中点向下：0.3335（step 0.001）落到 0.333 而不是 0.334，同时吸收浮点误差
  const steps = Math.round(ratio - 1e-9);
  const snapped = spec.min + steps * spec.step;
  // 浮点误差修正，避免 0.30000000000000004 之类进入 UI
  const fixed = Number(snapped.toFixed(6));
  return Math.min(spec.max, Math.max(spec.min, fixed));
}

export function formatValue(spec: ParamSpec, value: number): string {
  const quantized = quantize(spec, value);
  const text = quantized.toFixed(decimalsFor(spec.step));
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

export function parseInput(spec: ParamSpec, text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return quantize(spec, parsed);
}
