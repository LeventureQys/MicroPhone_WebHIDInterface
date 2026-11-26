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
 * 顺序即界面顺序：安静房间 → 游戏 → 播客 → 唱歌 → 自定义（用户指定）。
 * 「会议」在 2026-11-22 问题单第 7 条改名为「游戏」：只换名字与说明，
 * 处理链参数（压噪 + 稳人声）沿用上一版的会议预设，没有依据时不自造另一套数值。
 *
 * 2026-11-22 问题单第 6 条：三分频动态默认关闭，因此所有场景都不再打开 `drc3.Enable`。
 * 每个场景的参数改动由 `domain/scene-presets.ts` 单独保存（同一问题单第 9 条）。
 */
export type SceneId = 'quiet' | 'game' | 'podcast' | 'sing' | 'custom';

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
  /** 三分频动态使能位（`0x2075`）；默认关闭，场景也不再打开 */
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
    drc3On: false,
  },
  {
    id: 'game',
    gateThreshold: -41,
    gateOn: true,
    compThreshold: -36,
    tone: 'vocal',
    encOn: true,
    encLevel: 2,
    limiterOn: true,
    drc3On: false,
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
    drc3On: false,
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
    drc3On: false,
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
    drc3On: false,
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
 * 场景拥有的协议参数集合（快速调音链 + 环境降噪 + 防爆音使能）。
 *
 * 2026-11-25 起「自动保存」只记这些项和音色曲线：麦克风静音 / 监听 / 灯效是
 * **全局开关**，不应该因为"在哪个场景里动过"就变成某个场景的私有值。
 * 从所有场景的 `scenePatch` 取并集而不是手抄，避免预设加减字段后这里漏改。
 */
function collectSceneParamIds(): string[] {
  const ids = new Set<string>();
  for (const scene of SCENES) {
    for (const id of Object.keys(scenePatch(scene).params)) ids.add(id);
  }
  return [...ids];
}

export const SCENE_PARAM_IDS: readonly string[] = Object.freeze(collectSceneParamIds());

/**
 * 快速调音面板里展示、但**不属于任何场景预设**的参数。
 *
 * - `limit.Threshold`：R-19 明确场景不写它（点一次场景不该悄悄改掉用户调好的限幅阈值）；
 * - `comp.Enable`：场景只写压缩器阈值，开关一直是全局的。
 *
 * 两者都摆在快速调音里，用户改了它们、场景「复位」却不亮，看起来就是按钮坏了
 * （2026-11-25 反馈）。所以它们参与"调乱了没有"的判定，复位时退回**应用场景时**的基准值，
 * 但仍不写进场景预设：切场景不会换掉它们。
 */
export const SCENE_BASELINE_ONLY_IDS: readonly string[] = Object.freeze([
  'limit.Threshold',
  'comp.Enable',
]);

/** 判断「这个场景被调乱了没有」时要看的参数：场景拥有的 + 上面那几个基准撤销项 */
export const SCENE_DIRTY_PARAM_IDS: readonly string[] = Object.freeze([
  ...SCENE_PARAM_IDS,
  ...SCENE_BASELINE_ONLY_IDS,
]);

/**
 * 当前参数是否仍然完整匹配某个场景（用于高亮）。
 *
 * 2026-11-22 起场景可以逐项微调并自动保存，因此界面高亮优先用「显式选中的场景」
 * （`domain/scene-presets.ts`），只有没有显式选择时才退回这里按参数反推。
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
