import { findParam } from './params';
import { DEFAULT_CUSTOM_GAINS, EQ_PRESETS, type EqPresetId } from './quick-controls';
import { SCENES, scenePatch, type SceneId, type ScenePreset } from './scenes';
import { quantize } from './values';

/**
 * 场景的可编辑值（2026-11-22 问题单第 9 条）：
 * 「5 种场景模式下面，参数都可以单独调节，调节之后自动保存。并增加一个复位按钮，
 * 调乱了可以直接复位为默认值。」
 *
 * 因此每个场景两套值：
 * - **默认值**：`domain/scenes.ts` 的 `SCENES`（点「复位」回到这一套）；
 * - **用户改过的值**：本模块按场景 id 存在 localStorage 里，改一项存一项。
 *
 * 只存"用户真的动过"的字段（sparse），这样场景默认值随版本调整时，
 * 没动过的项会跟着一起变，不会把旧版本的一整份参数冻在配置里。
 */

export interface SceneOverride {
  /** 用户改过的参数（id → 工程量），只存差异 */
  readonly params?: Readonly<Record<string, number>>;
  /** 用户改过的 7 段增益；只对「自定义」音色有意义 */
  readonly gains?: readonly number[];
}

export type SceneOverrides = Readonly<Partial<Record<SceneId, SceneOverride>>>;

/** 场景参数（可编辑值）的存储键；与通道配置分开，坏掉一个不影响另一个 */
export const SCENES_STORAGE_KEY = 'micstudio.scenes';
/** 「自定义」音色的曲线：软件重开后还要是用户上次拖出来的那条 */
export const CUSTOM_EQ_STORAGE_KEY = 'micstudio.customEq';

const EDITABLE_GAIN_MIN = -32;
const EDITABLE_GAIN_MAX = 12;
const EDITABLE_GAIN_COUNT = 7;

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 隐私模式 / 沙箱下访问 localStorage 本身就可能抛错
    return null;
  }
}

function readJson(storage: StorageReader | null, key: string): unknown {
  if (!storage) return null;
  let text: string | null = null;
  try {
    text = storage.getItem(key);
  } catch {
    return null;
  }
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function writeJson(storage: StorageWriter | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额耗尽 / 隐私模式：改动退化成会话内有效，不抛给界面
  }
}

export function findScene(id: SceneId): ScenePreset | undefined {
  return SCENES.find((scene) => scene.id === id);
}

/** 场景的出厂参数（噪声门 / 压缩器 / 环境降噪 / 防爆音 / 三分频使能） */
export function defaultSceneParams(id: SceneId): Record<string, number> {
  const scene = findScene(id);
  if (!scene) return {};
  return { ...scenePatch(scene, DEFAULT_CUSTOM_GAINS).params };
}

/** 场景的出厂曲线：固定音色取音色表，「自定义」取传入的那条曲线 */
export function defaultSceneGains(id: SceneId, customGains: readonly number[] = DEFAULT_CUSTOM_GAINS): number[] {
  const scene = findScene(id);
  const tone: EqPresetId = scene?.tone ?? 'flat';
  if (tone === 'custom') return normalizeGains(customGains) ?? [...DEFAULT_CUSTOM_GAINS];
  return [...EQ_PRESETS[tone]];
}

function normalizeGains(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const gains: number[] = [];
  for (let index = 0; index < EDITABLE_GAIN_COUNT; index += 1) {
    const value = raw[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const clamped = Math.min(EDITABLE_GAIN_MAX, Math.max(EDITABLE_GAIN_MIN, value));
    gains.push(Number(clamped.toFixed(1)));
  }
  return gains;
}

/** 只留真实存在、可写的参数，并按寄存器步进量化（存储里可能有旧版本或手改的脏数据） */
function normalizeParams(raw: unknown): Record<string, number> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const params: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = findParam(id);
    if (!spec || spec.readonly) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    params[id] = quantize(spec, value);
  }
  return params;
}

function normalizeOverride(raw: unknown): SceneOverride | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as { params?: unknown; gains?: unknown };
  const params = normalizeParams(source.params);
  const gains = normalizeGains(source.gains);
  if (!params && !gains) return null;
  const override: { params?: Record<string, number>; gains?: number[] } = {};
  if (params && Object.keys(params).length > 0) override.params = params;
  if (gains) override.gains = gains;
  return Object.keys(override).length > 0 ? override : null;
}

/** 读场景覆盖表；任何坏字段都丢弃，绝不因为配置坏掉而让界面打不开 */
export function loadSceneOverrides(storage?: StorageReader): SceneOverrides {
  const raw = readJson(storage ?? defaultStorage(), SCENES_STORAGE_KEY);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const overrides: { [key in SceneId]?: SceneOverride } = {};
  for (const scene of SCENES) {
    const override = normalizeOverride(source[scene.id]);
    if (override) overrides[scene.id] = override;
  }
  return overrides;
}

export function saveSceneOverrides(overrides: SceneOverrides, storage?: StorageWriter): void {
  writeJson(storage ?? defaultStorage(), SCENES_STORAGE_KEY, overrides);
}

/** 场景完整参数 = 出厂值 + 用户改过的项（后者优先） */
export function sceneParams(id: SceneId, overrides: SceneOverrides = {}): Record<string, number> {
  return { ...defaultSceneParams(id), ...(overrides[id]?.params ?? {}) };
}

/** 场景曲线 = 用户改过的那条，没有就用出厂曲线（「自定义」用当前用户曲线） */
export function sceneGains(
  id: SceneId,
  overrides: SceneOverrides = {},
  customGains: readonly number[] = DEFAULT_CUSTOM_GAINS,
): number[] {
  const saved = overrides[id]?.gains;
  return saved ? [...saved] : defaultSceneGains(id, customGains);
}

/** 记下用户在本场景改的参数（返回新表，调用方负责落盘） */
export function recordSceneParams(
  overrides: SceneOverrides,
  id: SceneId,
  patch: Readonly<Record<string, number>>,
): SceneOverrides {
  const clean = normalizeParams(patch);
  if (!clean || Object.keys(clean).length === 0) return overrides;
  const current = overrides[id] ?? {};
  return {
    ...overrides,
    [id]: {
      ...current,
      params: { ...(current.params ?? {}), ...clean },
    },
  };
}

/** 记下用户在本场景改过的曲线（7 段增益） */
export function recordSceneGains(
  overrides: SceneOverrides,
  id: SceneId,
  gains: readonly number[],
): SceneOverrides {
  const clean = normalizeGains(gains);
  if (!clean) return overrides;
  const current = overrides[id] ?? {};
  return { ...overrides, [id]: { ...current, gains: clean } };
}

/** 复位：删掉这个场景的全部覆盖值，下次应用就回到出厂预设 */
export function clearSceneOverride(overrides: SceneOverrides, id: SceneId): SceneOverrides {
  if (!(id in overrides)) return overrides;
  const next = { ...overrides };
  delete next[id];
  return next;
}

/** 读用户上次的「自定义」曲线；没有或坏掉时返回 null（调用方退回默认平直曲线） */
export function loadCustomEq(storage?: StorageReader): number[] | null {
  return normalizeGains(readJson(storage ?? defaultStorage(), CUSTOM_EQ_STORAGE_KEY));
}

export function saveCustomEq(gains: readonly number[], storage?: StorageWriter): void {
  const clean = normalizeGains(gains);
  if (!clean) return;
  writeJson(storage ?? defaultStorage(), CUSTOM_EQ_STORAGE_KEY, clean);
}
