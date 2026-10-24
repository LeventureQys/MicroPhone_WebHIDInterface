import type { EqBand } from '../eq/types';
import {
  EQ_PRESETS,
  denoiseStrengthFromThreshold,
  limitEnableOn,
  limitEnableValue,
  matchEqPreset,
  smoothnessFromThreshold,
  thresholdFromDenoiseStrength,
  thresholdFromSmoothness,
  type EqPresetId,
} from './quick-controls';

/**
 * 一键场景：普通用户不需要理解 36 个协议参数，只需要选"我在干什么"。
 * 场景只写 5 个业务上相关的字段 + 7 段 EQ，其余参数保持用户当前设置。
 */
export type SceneId = 'meeting' | 'podcast' | 'sing' | 'quiet';

export interface ScenePreset {
  id: SceneId;
  denoise: number;
  evenness: number;
  tone: EqPresetId;
  encOn: boolean;
  encLevel: number;
  limiterOn: boolean;
}

export const SCENES: readonly ScenePreset[] = Object.freeze([
  {
    id: 'meeting',
    denoise: 55,
    evenness: 60,
    tone: 'vocal',
    encOn: true,
    encLevel: 2,
    limiterOn: true,
  },
  {
    id: 'podcast',
    denoise: 35,
    evenness: 70,
    tone: 'warm',
    encOn: true,
    encLevel: 1,
    limiterOn: true,
  },
  {
    id: 'sing',
    denoise: 20,
    evenness: 35,
    tone: 'bright',
    encOn: false,
    encLevel: 1,
    limiterOn: true,
  },
  {
    id: 'quiet',
    denoise: 10,
    evenness: 30,
    tone: 'flat',
    encOn: false,
    encLevel: 1,
    limiterOn: true,
  },
]);

export interface ScenePatch {
  params: Record<string, number>;
  gains: readonly number[];
}

export function scenePatch(scene: ScenePreset): ScenePatch {
  return {
    params: {
      'noisegate.threshold_db': thresholdFromDenoiseStrength(scene.denoise),
      'comp.Threshold': thresholdFromSmoothness(scene.evenness),
      'enc.OnOff': scene.encOn ? 1 : 0,
      'enc.Level': scene.encLevel,
      // 防爆音只写使能位（C-15）：阈值归用户在高级参数里自己调，场景不许替用户改阈值
      'limit.Enable': limitEnableValue(scene.limiterOn),
    },
    gains: EQ_PRESETS[scene.tone],
  };
}

/** 当前参数是否仍然完整匹配某个场景（用于高亮；用户手调后自动取消高亮） */
export function matchScene(
  params: Readonly<Record<string, number>>,
  bands: readonly EqBand[],
): SceneId | null {
  const gate = params['noisegate.threshold_db'] ?? -70;
  const comp = params['comp.Threshold'] ?? -60;
  const encOn = (params['enc.OnOff'] ?? 0) === 1;
  const encLevel = params['enc.Level'] ?? 1;
  const limiter = limitEnableOn(params['limit.Enable'] ?? 0);
  const tone = matchEqPreset(bands, 7);

  for (const scene of SCENES) {
    if (denoiseStrengthFromThreshold(gate) !== scene.denoise) continue;
    if (smoothnessFromThreshold(comp) !== scene.evenness) continue;
    if (tone !== scene.tone) continue;
    if (encOn !== scene.encOn) continue;
    if (encLevel !== scene.encLevel) continue;
    if (limiter !== scene.limiterOn) continue;
    return scene.id;
  }
  return null;
}
