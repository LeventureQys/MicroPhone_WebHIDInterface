import type { EqBand } from '../eq/types';

/**
 * 简易模式的“业务控件”映射：一个普通人看得懂的旋钮 → 若干协议参数。
 * 只做 UI 层换算，不改变协议范围与语义；专业模式始终能看到真实字段。
 */

export const STRENGTH_MIN = 0;
export const STRENGTH_MAX = 100;

const GATE_MIN_DB = -91;
const GATE_MAX_DB = 0;
const COMP_MIN_DB = -60;
const COMP_MAX_DB = 0;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 降噪强度 0..100 ↔ NoiseGate.threshold_db -91..0 */
export function denoiseStrengthFromThreshold(threshold: number): number {
  const clamped = Math.min(GATE_MAX_DB, Math.max(GATE_MIN_DB, threshold));
  return clamp(((clamped - GATE_MIN_DB) / (GATE_MAX_DB - GATE_MIN_DB)) * 100, STRENGTH_MIN, STRENGTH_MAX);
}

export function thresholdFromDenoiseStrength(strength: number): number {
  const ratio = clamp(strength, STRENGTH_MIN, STRENGTH_MAX) / 100;
  return Math.round(GATE_MIN_DB + ratio * (GATE_MAX_DB - GATE_MIN_DB));
}

/** 平稳度 0..100 ↔ Comp.Threshold 0..-60（越大压得越多） */
export function smoothnessFromThreshold(threshold: number): number {
  const clamped = Math.min(COMP_MAX_DB, Math.max(COMP_MIN_DB, threshold));
  return clamp(((COMP_MAX_DB - clamped) / (COMP_MAX_DB - COMP_MIN_DB)) * 100, STRENGTH_MIN, STRENGTH_MAX);
}

export function thresholdFromSmoothness(strength: number): number {
  const ratio = clamp(strength, STRENGTH_MIN, STRENGTH_MAX) / 100;
  const raw = COMP_MAX_DB + ratio * (COMP_MIN_DB - COMP_MAX_DB);
  // 阈值步进 0.1
  return Math.round(raw * 10) / 10;
}

/**
 * 防爆音开关 ↔ `limit.Enable`（`0x2051`）。C-15 起开关走真实使能位，
 * 阈值 `limit.Threshold` 独立保留（高级参数里可单独调，场景不再写它）。
 */
export function limitEnableOn(enable: number): boolean {
  return enable === 1;
}

export function limitEnableValue(enabled: boolean): number {
  return enabled ? 1 : 0;
}

export type EqPresetId = 'flat' | 'vocal' | 'warm' | 'bright' | 'music';

/** 五个风格的 7 段增益（dB）。只动增益，类型/频点/Q 保持不变。 */
export const EQ_PRESETS: Record<EqPresetId, readonly number[]> = Object.freeze({
  flat: [0, 0, 0, 0, 0, 0, 0],
  vocal: [-3, -2, -1, 1, 3, 2, 0],
  warm: [4, 3, 2, 0, -1, -2, -3],
  bright: [-2, -1, 0, 1, 2, 4, 5],
  music: [3, 2, 0, -1, 2, 3, 2],
});

export function eqPresetGains(id: EqPresetId): readonly number[] {
  return EQ_PRESETS[id];
}

/** 当前可见段是否与某个风格一致（用于高亮） */
export function matchEqPreset(bands: readonly EqBand[], visibleCount: number): EqPresetId | null {
  for (const id of Object.keys(EQ_PRESETS) as EqPresetId[]) {
    const gains = EQ_PRESETS[id];
    let matched = true;
    for (let index = 0; index < visibleCount; index += 1) {
      const band = bands[index];
      if (!band || Math.abs(band.gain - (gains[index] ?? 0)) > 0.05) {
        matched = false;
        break;
      }
    }
    if (matched) return id;
  }
  return null;
}
