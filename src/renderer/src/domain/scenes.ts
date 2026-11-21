import type { EqBand } from '../eq/types';
import {
  EQ_PRESETS,
  limitEnableOn,
  limitEnableValue,
  matchEqPreset,
  matchesGains,
  type EqPresetId,
} from './quick-controls';

/**
 * 一键场景：普通用户不需要理解 36 个协议参数，只需要选"我在干什么"。
 *
 * 「自定义」场景只换音色曲线，不替用户改压缩/降噪——那条曲线是用户自己在主界面拖出来的
 * （2026-11-13 需求：场景里增加自定义，且只有自定义曲线和高级参数里的 EQ 值可调）。
 *
 * 顺序即界面顺序：安静房间 → 会议 → 播客 → 唱歌 → 自定义（用户指定）。
 */
export type SceneId = 'quiet' | 'meeting' | 'podcast' | 'sing' | 'custom';

export interface ScenePreset {
  readonly id: SceneId;
  /** 噪声门阈值（dB，直接写 `noisegate.threshold_db`，不再是 0..100 的抽象强度） */
  readonly gateThreshold?: number;
  /** 噪声门使能位（`0x2074`）：场景要压噪，得先把门打开 */
  readonly gateOn?: boolean;
  /** 压缩器阈值（dB，直接写 `comp.Threshold`） */
  readonly compThreshold?: number;
  readonly tone: EqPresetId;
  readonly encOn?: boolean;
  readonly encLevel?: number;
  readonly limiterOn?: boolean;
  /** 三分频动态使能位（`0x2075`） */
  readonly drc3On?: boolean;
}

export const SCENES: readonly ScenePreset[] = Object.freeze([
  {
    id: 'quiet',
    gateThreshold: -82,
    gateOn: true,
    compThreshold: -18,
    tone: 'flat',
    encOn: false,
    encLevel: 1,
    limiterOn: true,
    drc3On: true,
  },
  {
    id: 'meeting',
    gateThreshold: -41,
    gateOn: true,
    compThreshold: -36,
    tone: 'vocal',
    encOn: true,
    encLevel: 2,
    limiterOn: true,
    drc3On: true,
  },
  {
    id: 'podcast',
    gateThreshold: -59,
    gateOn: true,
    compThreshold: -42,
    tone: 'warm',
    encOn: true,
    encLevel: 1,
    limiterOn: true,
    drc3On: true,
  },
  {
    id: 'sing',
    gateThreshold: -73,
    gateOn: true,
    compThreshold: -21,
    tone: 'bright',
    encOn: false,
    encLevel: 1,
    limiterOn: true,
    drc3On: true,
  },
  {
    id: 'custom',
    // 「自定义」只负责音色；处理链给中性值（门不压、压缩器最低灵敏度），
    // 这样它也能和「安静房间」区分开（后者的音色是固定的原声曲线）。
    gateThreshold: -91,
    gateOn: true,
    compThreshold: -60,
    tone: 'custom',
    encOn: false,
    encLevel: 1,
    limiterOn: true,
    drc3On: true,
  },
]);

export interface ScenePatch {
  params: Record<string, number>;
  gains: readonly number[];
}

export function scenePatch(scene: ScenePreset, customGains: readonly number[] = []): ScenePatch {
  const params: Record<string, number> = {};
  if (scene.gateThreshold !== undefined) params['noisegate.threshold_db'] = scene.gateThreshold;
  if (scene.gateOn !== undefined) params['noisegate.Enable'] = scene.gateOn ? 1 : 0;
  if (scene.compThreshold !== undefined) params['comp.Threshold'] = scene.compThreshold;
  if (scene.encOn !== undefined) params['enc.OnOff'] = scene.encOn ? 1 : 0;
  if (scene.encLevel !== undefined) params['enc.Level'] = scene.encLevel;
  if (scene.limiterOn !== undefined) {
    // 防爆音只写使能位（C-15）：阈值归用户在高级参数里自己调，场景不许替用户改阈值
    params['limit.Enable'] = limitEnableValue(scene.limiterOn);
  }
  if (scene.drc3On !== undefined) params['drc3.Enable'] = scene.drc3On ? 1 : 0;
  const gains =
    scene.tone === 'custom'
      ? customGains.slice(0, 7)
      : EQ_PRESETS[scene.tone as Exclude<EqPresetId, 'custom'>];
  return { params, gains };
}

/**
 * 当前参数是否仍然完整匹配某个场景（用于高亮；用户手调后自动取消高亮）。
 *
 * `tone` 由调用方从 `AppState.tone` 传入：自定义曲线默认全平，只靠波形反推会和
 * 固定「原声」混为一谈，因此显式选择优先；传 `null` 时才按曲线反推。
 */
export function matchScene(
  params: Readonly<Record<string, number>>,
  bands: readonly EqBand[],
  customGains: readonly number[] = [],
  tone: EqPresetId | null = null,
): SceneId | null {
  const gate = params['noisegate.threshold_db'];
  const gateOn = (params['noisegate.Enable'] ?? 0) === 1;
  const comp = params['comp.Threshold'];
  const encOn = (params['enc.OnOff'] ?? 0) === 1;
  const encLevel = params['enc.Level'] ?? 1;
  const limiter = limitEnableOn(params['limit.Enable'] ?? 0);
  const drc3On = (params['drc3.Enable'] ?? 0) === 1;
  const activeTone =
    tone ??
    matchEqPreset(bands, 7) ??
    (customGains.length >= 7 && matchesGains(bands, customGains, 7) ? 'custom' : null);

  for (const scene of SCENES) {
    if (scene.tone !== activeTone) continue;
    if (scene.gateThreshold !== undefined && gate !== scene.gateThreshold) continue;
    if (scene.gateOn !== undefined && gateOn !== scene.gateOn) continue;
    if (scene.compThreshold !== undefined && comp !== scene.compThreshold) continue;
    if (scene.encOn !== undefined && encOn !== scene.encOn) continue;
    if (scene.encLevel !== undefined && encLevel !== scene.encLevel) continue;
    if (scene.limiterOn !== undefined && limiter !== scene.limiterOn) continue;
    if (scene.drc3On !== undefined && drc3On !== scene.drc3On) continue;
    return scene.id;
  }
  return null;
}
