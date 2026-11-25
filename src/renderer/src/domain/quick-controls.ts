import type { EqBand } from '../eq/types';

/**
 * 简易模式的“业务控件”映射：一个普通人看得懂的旋钮 → 若干协议参数。
 * 只做 UI 层换算，不改变协议范围与语义；专业模式始终能看到真实字段。
 */

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

/**
 * 内置音色只有 4 个固定曲线；`custom` 没有固定增益，曲线存在
 * `AppStore.customEq` 里（用户自己拖出来的那一条）。
 */
export type EqPresetId = 'flat' | 'vocal' | 'warm' | 'bright' | 'custom';

/** 固定音色的 7 段增益（dB）。只动增益，类型/频点/Q 保持不变。 */
export const EQ_PRESETS: Record<Exclude<EqPresetId, 'custom'>, readonly number[]> = Object.freeze({
  flat: [0, 0, 0, 0, 0, 0, 0],
  vocal: [-3, -2, -1, 1, 3, 2, 0],
  warm: [4, 3, 2, 0, -1, -2, -3],
  bright: [-2, -1, 0, 1, 2, 4, 5],
});

/** 自定义音色的初始曲线（全平），之后由用户在曲线上拖出来 */
export const DEFAULT_CUSTOM_GAINS: readonly number[] = Object.freeze([0, 0, 0, 0, 0, 0, 0]);

/**
 * 软件打开时默认选中的音色（2026-11-22 问题单第 8 条「默认处于自定义模式」）。
 * 选自定义是因为只有它能直接拖曲线，打开就能调；固定音色的曲线只读。
 */
export const DEFAULT_TONE: EqPresetId = 'custom';

/** 当前可见段是否与某个固定风格一致（用于高亮；自定义曲线由调用方另判） */
export function matchEqPreset(bands: readonly EqBand[], visibleCount: number): EqPresetId | null {
  for (const id of Object.keys(EQ_PRESETS) as Array<Exclude<EqPresetId, 'custom'>>) {
    if (matchesGains(bands, EQ_PRESETS[id], visibleCount)) return id;
  }
  return null;
}

/** 当前可见段是否等于给定的一组增益（自定义音色 / 场景高亮用） */
export function matchesGains(
  bands: readonly EqBand[],
  gains: readonly number[],
  visibleCount = 7,
): boolean {
  for (let index = 0; index < visibleCount; index += 1) {
    const band = bands[index];
    if (!band || Math.abs(band.gain - (gains[index] ?? 0)) > 0.05) return false;
  }
  return true;
}

/** 从 14 段里取前 7 段的增益，供“把当前曲线存为自定义”使用 */
export function gainsOf(bands: readonly EqBand[], visibleCount = 7): number[] {
  const out: number[] = [];
  for (let index = 0; index < visibleCount; index += 1) out.push(bands[index]?.gain ?? 0);
  return out;
}
