/**
 * 语义 → 参数的**规则表读取层**（Alpha v1.3.0 / SubStage 4.1）。
 *
 * 数值的唯一真值是 `contract/kb.ts`（SubStage 3.1），由 `emit.mjs` 导出成
 * `gen/rules.json`。本文件因此**不写任何数值**，只做三件事：
 *
 * 1. 读 `gen/rules.json`，把 13 维度 × 2 方向 × 3 档、7 个开关、`EQ_DELTAS`
 *    投影成带类型的常量，并做一次自检（数量 / id / 占位段号）——出错就抛，
 *    免得下游拿到半张表还以为规则命中不了；
 * 2. 把 L1 的 `tune` / `eq` / `toggle` 解析成 `RuleAction[]`；
 * 3. 把占位段号（`EQ_DELTA_BAND_PLACEHOLDER`）换成用户点名的那一段。
 *
 * 为什么不 `import` kb 再取值：执行器只该依赖生成物（设计文档 §2.1 的产物边界），
 * kb 是 TS 源码、还连着 `src/**`；`gen/rules.json` 是同一份数据的稳定投影，
 * 也是 5.1 训练标签用的那一份，两头读同一个文件才不会漂移。
 *
 * `eq` 的频点增量在表里叫 `freqPct`（**百分比**，+10 = +10%），落到寄存器字段是 `freq`；
 * 这个换算在 `canonicalize.ts` 做（需要当前频点），本文件只负责把格子取出来。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOGGLE_TARGETS, TUNE_TARGETS, type ToggleTarget, type TuneTarget } from './targets';

export type Strength = 'slight' | 'medium' | 'strong';
export type Direction = 'more' | 'less';
export type EqField = 'type' | 'freq' | 'gain' | 'q';

/** 规则动作（设计文档 §3.4 的联合类型，字段名与 3.1 的 `kb.ts` 一致） */
export type RuleAction =
  | { readonly kind: 'param'; readonly id: string; readonly delta: number }
  | { readonly kind: 'band'; readonly band: number; readonly field: EqField; readonly delta: number }
  | { readonly kind: 'paramSet'; readonly id: string; readonly value: number }
  | { readonly kind: 'bandSet'; readonly band: number; readonly field: EqField; readonly value: number };

export type RulesByStrength = Readonly<Record<Strength, readonly RuleAction[]>>;

export interface TargetRules {
  readonly more: RulesByStrength;
  readonly less: RulesByStrength;
}

export interface ToggleRule {
  readonly on: readonly RuleAction[];
  readonly off: readonly RuleAction[];
}

/** 条件动作：主规则套完后按"本轮目标值"再补一条（`gen/rules.json.conditionals`） */
export interface ConditionalRule {
  readonly target: TuneTarget;
  readonly direction: Direction;
  readonly when: { readonly id: string; readonly atOrBelow: number };
  readonly then: readonly RuleAction[];
}

/** 频段锚点（`eq.centerHz` → band 的就近映射，设计文档 §3.4 末段） */
export interface BandSpec {
  readonly band: number;
  readonly centerHz: number;
  readonly kind: 'hpf' | 'lpf' | 'peak';
}

/** 场景补丁（`scene` 动作用 `scene`；`scenario` 动作额外套这两条） */
export interface ScenarioRule {
  readonly id: string;
  readonly baseScene: string;
  readonly patch: readonly RuleAction[];
}

/**
 * `schema/targets.json` 的**只读片段**：本文件只需要音色与场景的枚举，
 * 其余（别名、explainOnly）留给 3.2 / 5.x。不 `import kb.ts` 是为了让执行器
 * 只依赖生成物（kb 是知识本体源码，改它要重新 emit，两处读同一个产物才不会漂移）。
 */
interface TargetsDoc {
  readonly v: number;
  readonly scenes: readonly string[];
  readonly tones: readonly string[];
  readonly bands: readonly BandSpec[];
}

interface RulesDoc {
  readonly v: number;
  readonly strengths: readonly Strength[];
  readonly directions: readonly Direction[];
  readonly dims: readonly (TargetRules & {
    readonly id: TuneTarget;
    readonly nameZh: string;
    readonly writable: readonly string[];
    readonly aliasSide: Direction;
  })[];
  readonly toggle: Readonly<Record<string, ToggleRule>>;
  readonly eqDeltas: Readonly<Record<string, Readonly<Record<Direction, RulesByStrength>>>>;
  readonly turnCaps: { readonly eqGainDb: number; readonly encLevel: number; readonly makeUpGainDb: number };
  readonly bands: readonly BandSpec[];
  readonly conditionals: readonly ConditionalRule[];
  readonly scenarios: readonly ScenarioRule[];
}

/**
 * 读一份生成物（相对 `tools/voice/` 的路径）。
 *
 * 为什么不用静态 `import './x.json'`：Node 侧要写 import attributes、vitest 侧写法又不同，
 * 两套写法会漂移。改为运行时读文件，只需处理"从哪儿定位仓库"这一件事：
 * Node 直接跑时 `import.meta.url` 是 `file:`；vitest（happy-dom 环境）下它可能是
 * `http://localhost/…`，这时退回进程工作目录（`pnpm run test` 的 cwd 就是仓库根）。
 */
function readGenerated(relativeFromToolsVoice: string): string {
  const here = import.meta.url;
  if (typeof here === 'string' && here.startsWith('file:')) {
    try {
      return readFileSync(fileURLToPath(new URL(relativeFromToolsVoice, here)), 'utf8');
    } catch {
      // 落到 cwd 兜底
    }
  }
  return readFileSync(path.resolve(process.cwd(), 'tools/voice', relativeFromToolsVoice), 'utf8');
}

const DOC = JSON.parse(readGenerated('gen/rules.json')) as RulesDoc;

const TARGETS_DOC = JSON.parse(readGenerated('schema/targets.json')) as TargetsDoc;

const STRENGTHS: readonly Strength[] = Object.freeze(['slight', 'medium', 'strong']);
const DIRECTIONS: readonly Direction[] = Object.freeze(['more', 'less']);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fail(message: string): never {
  throw new Error(`rules.ts: gen/rules.json ${message}（先跑 tools/voice/emit.mjs 重新生成）`);
}

/** 本文件内部用错（编程错误，不是生成物的问题） */
function bug(message: string): never {
  throw new Error(`E_RULE_INTERNAL: ${message}`);
}

// ---------------------------------------------------------------------------
// 自检：表结构必须与契约一致，否则下游会"规则命中但没动作"
// ---------------------------------------------------------------------------

if (DOC.v !== 1) fail(`的 v 应为 1，实际 ${String(DOC.v)}`);
if (DOC.dims.length !== TUNE_TARGETS.length) {
  fail(`的 dims 应有 ${TUNE_TARGETS.length} 项，实际 ${DOC.dims.length}`);
}
DOC.dims.forEach((dim, index) => {
  if (dim.id !== TUNE_TARGETS[index]) {
    fail(`的 dims[${index}] 应为 ${TUNE_TARGETS[index]}，实际 ${String(dim.id)}`);
  }
  for (const direction of DIRECTIONS) {
    for (const strength of STRENGTHS) {
      const cell = dim[direction][strength];
      if (!Array.isArray(cell) || cell.length === 0) fail(`的 ${dim.id}.${direction}.${strength} 为空`);
    }
  }
});
if (DOC.toggle && typeof DOC.toggle === 'object') {
  const keys = Object.keys(DOC.toggle);
  if (keys.length !== TOGGLE_TARGETS.length) {
    fail(`的 toggle 应有 ${TOGGLE_TARGETS.length} 项，实际 ${keys.length}`);
  }
  for (const target of TOGGLE_TARGETS) {
    if (!DOC.toggle[target]) fail(`的 toggle 缺少 ${target}`);
  }
}

// ---------------------------------------------------------------------------
// 表本体
// ---------------------------------------------------------------------------

/** 13 个语义维度 × 2 方向 × 3 档（设计文档 §3.4 的"语义 → 参数规则表"） */
export const RULES: Readonly<Record<TuneTarget, TargetRules>> = deepFreeze(
  Object.fromEntries(DOC.dims.map((dim) => [dim.id, { more: dim.more, less: dim.less }])),
) as Readonly<Record<TuneTarget, TargetRules>>;

/** 每个维度的中文名（preview / say 模板用） */
export const TARGET_NAME_ZH: Readonly<Record<TuneTarget, string>> = deepFreeze(
  Object.fromEntries(DOC.dims.map((dim) => [dim.id, dim.nameZh])),
) as Readonly<Record<TuneTarget, string>>;

/** 7 个开关的 on/off 动作（设计文档 §3.4 的"开关"表） */
export const TOGGLE_RULES: Readonly<Record<ToggleTarget, ToggleRule>> = deepFreeze(
  Object.fromEntries(TOGGLE_TARGETS.map((target) => [target, DOC.toggle[target]])),
) as Readonly<Record<ToggleTarget, ToggleRule>>;

/** 单轮上限（设计文档 §3.4 末段：EQ 段 6 dB、`enc.Level` 3 档、`comp.MakeUpGain` 6 dB） */
export const TURN_CAPS: { readonly eqGainDb: number; readonly encLevel: number; readonly makeUpGainDb: number } =
  deepFreeze({ ...DOC.turnCaps });

/** `eq` 动作的增量格：`EQ_DELTAS.gain|q|freqPct[direction][strength]` */
export type EqDeltaTable = Readonly<Record<'gain' | 'q' | 'freqPct', Readonly<Record<Direction, RulesByStrength>>>>;

export const EQ_DELTAS: EqDeltaTable = deepFreeze(DOC.eqDeltas) as EqDeltaTable;

/**
 * `EQ_DELTAS` 里的占位段号（`band: 0`）：表示"用户点名的那一段"。
 *
 * 值从 `gen/rules.json` 读出来而不是写死 0，并且要求 18 个格子用的是同一个段号——
 * 这样 `kb.ts` 若改了约定，这里立刻抛错，而不是静默产出 `eq.band0.gain`。
 */
export const EQ_DELTA_BAND_PLACEHOLDER: number = (() => {
  const seen = new Set<number>();
  for (const tableKey of ['gain', 'q', 'freqPct'] as const) {
    for (const direction of DIRECTIONS) {
      for (const strength of STRENGTHS) {
        for (const action of EQ_DELTAS[tableKey][direction][strength]) {
          if (action.kind !== 'band') fail(`的 eqDeltas.${tableKey} 出现非 band 动作`);
          seen.add(action.band);
        }
      }
    }
  }
  if (seen.size !== 1) fail(`的 eqDeltas 段号不唯一：${[...seen].join(',')}`);
  const [placeholder] = [...seen];
  if (placeholder !== 0) fail(`的 eqDeltas 段号应为 0（占位符），实际 ${placeholder}`);
  return placeholder;
})();

/** 条件动作（`noiseFloor.more` 到 0 关降噪、`gate.less` 到 −91 关噪声门） */
export const CONDITIONALS: readonly ConditionalRule[] = deepFreeze([...DOC.conditionals]);

/** 7 段的频点与类型（`band1/2` 是 HPF/LPF，规则表不碰它们的 gain） */
export const BANDS: readonly BandSpec[] = deepFreeze([...DOC.bands]);

/** 8 种场景说法 → 内置场景 + 补丁 */
export const SCENARIOS: readonly ScenarioRule[] = deepFreeze([...DOC.scenarios]);

/** 5 个内置场景 id（`schema/targets.json`，与 `domain/scenes.ts` 同源） */
export const SCENE_IDS: readonly string[] = Object.freeze([...TARGETS_DOC.scenes]);

/** 5 个音色 id：`flat/vocal/warm/bright/custom`（`custom` 没有固定曲线） */
export const TONE_IDS: readonly string[] = Object.freeze([...TARGETS_DOC.tones]);

// 两个生成物必须对同一件事说同一句话，否则说明 emit 只跑了一半
if (TARGETS_DOC.bands.length !== BANDS.length) {
  fail(`与 schema/targets.json 的 bands 数量不一致（${BANDS.length} vs ${TARGETS_DOC.bands.length}）`);
}
TARGETS_DOC.bands.forEach((spec, index) => {
  if (spec.band !== BANDS[index]?.band || spec.centerHz !== BANDS[index]?.centerHz) {
    fail(`与 schema/targets.json 的 band${String(spec.band)} 频点不一致`);
  }
});

// ---------------------------------------------------------------------------
// 解析：L1 动作 → RuleAction[]
// ---------------------------------------------------------------------------

function assertDirection(direction: Direction): void {
  if (!DIRECTIONS.includes(direction)) bug(`非法方向 ${String(direction)}`);
}

function assertStrength(strength: Strength): void {
  if (!STRENGTHS.includes(strength)) bug(`非法档位 ${String(strength)}`);
}

/** `tune` → 该维度该方向该档的动作列表（原样返回表里的数组） */
export function resolveTune(
  target: TuneTarget,
  direction: Direction,
  strength: Strength,
): readonly RuleAction[] {
  const rules = RULES[target];
  if (!rules) return Object.freeze([]);
  assertDirection(direction);
  assertStrength(strength);
  return rules[direction][strength];
}

/** `toggle` → on/off 的动作列表 */
export function resolveToggle(target: ToggleTarget, on: boolean): readonly RuleAction[] {
  const rule = TOGGLE_RULES[target];
  if (!rule) return Object.freeze([]);
  return on ? rule.on : rule.off;
}

/** `eq` 的增量格：`tableKey` 用 `freqPct`（`field:'freq'` 时），其余与字段同名 */
export function eqDeltaTableKey(field: EqField): 'gain' | 'q' | 'freqPct' {
  if (field === 'freq') return 'freqPct';
  if (field === 'q') return 'q';
  if (field === 'gain') return 'gain';
  // `type` 不是可增量字段（滤波器类型是枚举），`eq` 动作也不允许改它
  bug(`eq 动作不支持 field='type'：滤波器类型是枚举，不是可增量字段`);
}

/** `eq` 的单条增量动作（段号仍是占位符，调用方用 `withRealBand` 替换） */
export function resolveEqDelta(field: EqField, direction: Direction, strength: Strength): RuleAction {
  assertDirection(direction);
  assertStrength(strength);
  const actions = EQ_DELTAS[eqDeltaTableKey(field)][direction][strength];
  if (!Array.isArray(actions) || actions.length !== 1) {
    fail(`的 eqDeltas.${eqDeltaTableKey(field)}.${direction}.${strength} 应只有 1 条动作`);
  }
  return actions[0];
}

/**
 * 把占位段号换成真实段号。占位符之外的段号原样保留（`scene` / `tone` 的 `bandSet`
 * 已经是真实段号，不经过这里）。
 */
export function withRealBand(action: RuleAction, band: number): RuleAction {
  if (action.kind !== 'band' && action.kind !== 'bandSet') {
    bug(`withRealBand 只接受 band/bandSet 动作`);
  }
  if (action.band !== EQ_DELTA_BAND_PLACEHOLDER) return action;
  if (!Number.isInteger(band) || band < 3 || band > 7) {
    bug(`eq 目标段号非法：${String(band)}（只有 band3..band7 是均衡段）`);
  }
  return { ...action, band } as RuleAction;
}

/**
 * `centerHz` → 最近的 band（不论类型）：对数距离，因为频段按倍频程分布。
 * 只用于报错定位与映射的实现细节；要不要拒绝由 `bandForCenterHz` 决定。
 */
export function nearestBandOf(centerHz: number): number {
  if (!Number.isFinite(centerHz) || centerHz <= 0) return BANDS[0]?.band ?? 1;
  let best = BANDS[0]?.band ?? 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const spec of BANDS) {
    const distance = Math.abs(Math.log(centerHz / spec.centerHz));
    if (distance < bestDistance) {
      best = spec.band;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * `centerHz` → band 的就近映射（设计文档 §3.4 末段）。
 *
 * 结果落在 band1（HPF 50 Hz）或 band2（LPF 20 kHz）时返回 `'unsupported'`——
 * 那是滤波器，不是均衡段。
 */
export function bandForCenterHz(centerHz: number): number | 'unsupported' {
  if (!Number.isFinite(centerHz) || centerHz <= 0) return 'unsupported';
  const band = nearestBandOf(centerHz);
  const spec = BANDS.find((item) => item.band === band);
  if (!spec || spec.kind !== 'peak') return 'unsupported';
  return band;
}

/** 段号 → 频点（错误提示用；不在 1..7 时返回 0） */
export function centerHzOfBand(band: number): number {
  return BANDS.find((spec) => spec.band === band)?.centerHz ?? 0;
}
