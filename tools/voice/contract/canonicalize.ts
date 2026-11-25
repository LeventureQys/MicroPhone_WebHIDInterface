/**
 * L1 `VoicePlan` → L2 `VoiceCommand` 的写入集（Alpha v1.3.0 / SubStage 4.1）。
 *
 * 本文件是**唯一产生 dB / Hz / 档位数值的地方**（设计文档 §3.4 的 R-2：模型与 ASR 都不产出数值）：
 * 规则表（`gen/rules.json`）给相对增量，这里负责
 *
 *   1. 校验 L1（不合法抛 `Error('E_PLAN_INVALID: …')`，由执行器映射成 400）；
 *   2. 把 `tune` / `eq` / `toggle` / `set` / `scene` / `tone` / `undo` 解析成 `RuleAction[]`；
 *   3. 套在当前状态上（delta 累加、绝对值覆盖）、按单轮上限截断（`TURN_CAPS`）、
 *      按 `registers.ts` 夹紧并量化（`toRaw` → `fromRaw` 往返，设计文档 §3.5）；
 *   4. 套条件动作（`conditionals`：降噪到 0 关降噪、噪声门到 −91 关门）；
 *   5. 按 tier 表（设计文档 §3.3）分层：`excluded` 丢弃、`confirm` 整轮不写（原子性）；
 *   6. 只保留真正变化的项，并生成 `preview`（人类可读）与 `say` 覆盖（静音话术）。
 *
 * `rgb.Mode` 是唯一不走夹紧的参数：它按 `(current + delta) mod 8` 循环（设计文档 §3.1 表）。
 *
 * `turnId` 只用于 4.2 的日志关联，本 SubStage 不外显（L2 的 `undoTurn` / `confirmToken` 恒为 `null`）。
 */

import {
  eqBandAddr,
  findRegister,
  fromRaw,
  toRaw,
  type RegisterSpec,
} from '../../../src/renderer/src/device/registers';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from '../../../src/renderer/src/domain/defaults';
import { findParam } from '../../../src/renderer/src/domain/params';
import { EQ_PRESETS } from '../../../src/renderer/src/domain/quick-controls';
import { SCENES, scenePatch } from '../../../src/renderer/src/domain/scenes';
import {
  CONDITIONALS,
  EQ_DELTA_BAND_PLACEHOLDER,
  SCENARIOS,
  TARGET_NAME_ZH,
  TONE_IDS,
  TURN_CAPS,
  bandForCenterHz,
  centerHzOfBand,
  nearestBandOf,
  resolveEqDelta,
  resolveToggle,
  resolveTune,
  withRealBand,
  type Direction,
  type EqField,
  type RuleAction,
  type Strength,
} from './rules';
import { TOGGLE_TARGETS, TUNE_TARGETS, isParamId } from './targets';

export type { Direction, EqField, Strength } from './rules';

// ---------------------------------------------------------------------------
// 契约类型（SubStage 4.1 §4.2）
// ---------------------------------------------------------------------------

/** 当前状态：46 项标量工程量 + 7 段增益（dB）。缺失项用 `DEFAULT_PARAMS` / `DEFAULT_BANDS` 兜底 */
export interface VoiceState {
  readonly params: Readonly<Record<string, number>>;
  readonly bands: readonly number[];
}

export interface VoiceWrite {
  readonly param: string;
  readonly value: number;
}

export interface VoiceBandWrite {
  readonly band: number;
  readonly field: EqField;
  readonly value: number;
}

/**
 * 被降级/丢弃的项。
 *
 * `ungrounded-number` 来自设计文档 §3.5 的"数字接地"：`set` 的数值必须在用户原话里出现。
 * 任务书 §4.2 的类型声明只写了前两种原因，但同一节的步骤 2 与 §6 的 1c 都要求这一种，
 * 以 3.1 交付的 `voiceCommandSchema()`（`danger.reason` 的三个枚举值）为准。
 */
export type DangerReason = 'confirm-required' | 'excluded' | 'ungrounded-number';

export interface VoiceDanger {
  readonly param: string;
  readonly reason: DangerReason;
}

export type Tier = 'immediate' | 'confirm' | 'excluded';

export interface CanonResult {
  readonly writes: VoiceWrite[];
  readonly bandWrites: VoiceBandWrite[];
  readonly scene: string | null;
  readonly tone: string | null;
  readonly danger: VoiceDanger[];
  readonly preview: string[];
  /** 整轮的最高层（见设计文档 §3.3 的 tier 表） */
  readonly tier: Tier;
  /** 播报话术：来自 L1，可能被规则表覆盖（静音话术） */
  readonly say: string;
  /**
   * 本轮是否请求了撤销（`{"kind":"undo"}`）。
   * 撤销栈属 SubStage 4.2，这里只把意图透出去，绝不落盘任何写入。
   */
  readonly undo: boolean;
}

export interface CanonContext {
  readonly turnId: string;
  /** 用户原话（数字接地用）；缺省时退到 `plan.text` / `plan.utterance` */
  readonly utterance?: string;
}

/** 静音那一轮的播报话术（设计文档 §3.7 第 1 条：模型不知道后果，话术由规则表覆盖） */
export const MUTE_SAY = '已静音，请用界面上的开关恢复';

const EPS = 1e-9;
/** `rgb.Mode` 的循环区间（0..7），来自寄存器表而不是写死 */
const RGB_MODE_ID = 'rgb.Mode';
/** `confirm` 层：会切断助手自己的耳朵或用户的听觉反馈（设计文档 §3.3） */
const CONFIRM_PARAMS: readonly string[] = Object.freeze(['mic.mute', 'mic.sigMute', 'hp.OnOff']);
/** `excluded` 层里可能被 `set` 点到的只读参数（其余 excluded 项不在 72 个 paramId 内） */
const EXCLUDED_PARAMS: readonly string[] = Object.freeze(['gain.Mic', 'gain.Hp', 'micLevel']);

const BAND_ID_RE = /^eq\.band([1-7])\.(type|freq|gain|q)$/;

// ---------------------------------------------------------------------------
// paramId ↔ 寄存器
// ---------------------------------------------------------------------------

/** `paramId` → 寄存器行；`eq.bandN.field`（N 为 1..7）折算成 `eqBandAddr(N-1, field)` */
export function specOfParamId(id: string): RegisterSpec | null {
  const bandMatch = BAND_ID_RE.exec(id);
  if (bandMatch) {
    const band = Number(bandMatch[1]);
    const field = bandMatch[2] as EqField;
    return findRegister(eqBandAddr(band - 1, field)) ?? null;
  }
  const param = findParam(id);
  if (!param) return null;
  return findRegister(param.addr) ?? null;
}

function specOrThrow(id: string): RegisterSpec {
  const spec = specOfParamId(id);
  if (!spec) throw new Error(`E_PARAM_UNKNOWN: 未知 paramId ${id}`);
  return spec;
}

/** 按 `registers.ts` 夹紧 + 量化（`toRaw` → `fromRaw` 往返，设计文档 §3.5） */
export function quantizeValue(spec: RegisterSpec, value: number): number {
  return fromRaw(spec, toRaw(spec, value));
}

/** 工程量 → 寄存器原始值（sink 写设备用） */
export function toRawById(id: string, value: number): number {
  return toRaw(specOrThrow(id), value);
}

/** 寄存器原始值 → 工程量（sink 回读用） */
export function fromRawById(id: string, raw: number): number {
  return fromRaw(specOrThrow(id), raw);
}

/** 逐参数 tier（设计文档 §3.3 的判定表） */
export function tierOfParam(id: string): Tier {
  if (CONFIRM_PARAMS.includes(id)) return 'confirm';
  if (EXCLUDED_PARAMS.includes(id)) return 'excluded';
  if (isParamId(id)) return 'immediate';
  return 'excluded';
}

function currentValueOf(id: string, state: VoiceState): number {
  const bandMatch = BAND_ID_RE.exec(id);
  if (bandMatch) {
    const band = Number(bandMatch[1]);
    const field = bandMatch[2] as EqField;
    // 增益以 `state.bands` 为准（它是 sink 回读的 7 段增益）；其余字段只有 params 里有
    if (field === 'gain') {
      const fromBands = state.bands[band - 1];
      if (typeof fromBands === 'number' && Number.isFinite(fromBands)) return fromBands;
    }
    const fromParams = state.params[id];
    if (typeof fromParams === 'number' && Number.isFinite(fromParams)) return fromParams;
    const fallback = DEFAULT_BANDS[band - 1];
    if (fallback) {
      if (field === 'type') return fallback.type;
      if (field === 'freq') return fallback.freq;
      if (field === 'q') return fallback.q;
      return fallback.gain;
    }
    return 0;
  }
  const fromParams = state.params[id];
  if (typeof fromParams === 'number' && Number.isFinite(fromParams)) return fromParams;
  const spec = specOfParamId(id);
  if (spec) return DEFAULT_PARAMS[id] ?? fromRaw(spec, spec.defaultRaw);
  return DEFAULT_PARAMS[id] ?? 0;
}

function capOfId(id: string): number {
  if (/^eq\.band[1-7]\.gain$/.test(id)) return TURN_CAPS.eqGainDb;
  if (id === 'enc.Level') return TURN_CAPS.encLevel;
  if (id === 'comp.MakeUpGain') return TURN_CAPS.makeUpGainDb;
  return Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// L1 校验（SubStage 3.3 §4.3 的 1–7 条）
// ---------------------------------------------------------------------------

type PlanStatus = 'ok' | 'clarify' | 'unsupported';

interface TuneOp {
  readonly kind: 'tune';
  readonly target: string;
  readonly direction: Direction;
  readonly strength: Strength;
}
interface EqOp {
  readonly kind: 'eq';
  readonly band?: number;
  readonly centerHz?: number;
  readonly field: EqField;
  readonly direction: Direction;
  readonly strength: Strength;
}
interface ToggleOp {
  readonly kind: 'toggle';
  readonly target: string;
  readonly on: boolean;
}
interface SetOp {
  readonly kind: 'set';
  readonly param: string;
  readonly value: number;
}
interface SceneOp {
  readonly kind: 'scene';
  readonly scene?: string;
  readonly scenario?: string;
}
interface ToneOp {
  readonly kind: 'tone';
  readonly tone: string;
}
interface UndoOp {
  readonly kind: 'undo';
}
type ValidOp = TuneOp | EqOp | ToggleOp | SetOp | SceneOp | ToneOp | UndoOp;

interface ValidPlan {
  readonly status: PlanStatus;
  readonly ops: readonly ValidOp[];
  readonly say: string;
  readonly confidence: number;
  readonly text: string;
}

function failPlan(reason: string): never {
  throw new Error(`E_PLAN_INVALID: ${reason}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failPlan(`${what} 必须是对象`);
  return value as Record<string, unknown>;
}

function asDirection(value: unknown): Direction {
  if (value === 'more' || value === 'less') return value;
  failPlan(`direction 非法：${JSON.stringify(value)}`);
}

function asStrength(value: unknown): Strength {
  if (value === 'slight' || value === 'medium' || value === 'strong') return value;
  failPlan(`strength 非法：${JSON.stringify(value)}`);
}

const CONFIDENCE_VALUES: readonly number[] = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
const MAX_OPS = 4;

function validateOp(raw: unknown, index: number): ValidOp {
  const op = asRecord(raw, `ops[${index}]`);
  const kind = op.kind;
  switch (kind) {
    case 'tune': {
      if (typeof op.target !== 'string' || !(TUNE_TARGETS as readonly string[]).includes(op.target)) {
        failPlan(`ops[${index}].target 非法：${JSON.stringify(op.target)}`);
      }
      return {
        kind: 'tune',
        target: op.target as string,
        direction: asDirection(op.direction),
        strength: asStrength(op.strength),
      };
    }
    case 'eq': {
      const hasBand = typeof op.band === 'number';
      const hasHz = typeof op.centerHz === 'number';
      if (!hasBand && !hasHz) failPlan(`ops[${index}] 缺少 band 或 centerHz`);
      if (hasBand && (!Number.isInteger(op.band) || (op.band as number) < 1 || (op.band as number) > 7)) {
        failPlan(`ops[${index}].band 必须是 1..7 的整数，实际 ${JSON.stringify(op.band)}`);
      }
      if (hasHz && !Number.isFinite(op.centerHz)) {
        failPlan(`ops[${index}].centerHz 必须是有限数`);
      }
      const field = op.field ?? 'gain';
      if (field !== 'gain' && field !== 'q' && field !== 'freq') {
        failPlan(`ops[${index}].field 非法：${JSON.stringify(op.field)}`);
      }
      return {
        kind: 'eq',
        band: hasBand ? (op.band as number) : undefined,
        centerHz: hasHz ? (op.centerHz as number) : undefined,
        field: field as EqField,
        direction: asDirection(op.direction),
        strength: asStrength(op.strength),
      };
    }
    case 'toggle': {
      if (typeof op.target !== 'string' || !(TOGGLE_TARGETS as readonly string[]).includes(op.target)) {
        failPlan(`ops[${index}].target 非法：${JSON.stringify(op.target)}`);
      }
      if (typeof op.on !== 'boolean') failPlan(`ops[${index}].on 必须是布尔`);
      return { kind: 'toggle', target: op.target as string, on: op.on };
    }
    case 'set': {
      if (typeof op.param !== 'string' || op.param === '') {
        failPlan(`ops[${index}].param 缺失`);
      }
      if (typeof op.value !== 'number') failPlan(`ops[${index}].value 必须是数字`);
      // 非有限数不判非法：按设计文档 §3.5 丢弃该 op 并记 danger（JSON 里其实表达不出来）
      return { kind: 'set', param: op.param as string, value: op.value };
    }
    case 'scene': {
      if (typeof op.scene === 'string') return { kind: 'scene', scene: op.scene };
      if (typeof op.scenario === 'string') return { kind: 'scene', scenario: op.scenario };
      return failPlan(`ops[${index}] 缺少 scene 或 scenario`);
    }
    case 'tone': {
      if (typeof op.tone !== 'string' || !TONE_IDS.includes(op.tone)) {
        failPlan(`ops[${index}].tone 非法：${JSON.stringify(op.tone)}`);
      }
      return { kind: 'tone', tone: op.tone as string };
    }
    case 'undo':
      return { kind: 'undo' };
    default:
      failPlan(`ops[${index}].kind 非法：${JSON.stringify(kind)}`);
  }
}

/** 校验并规整 L1（第一条违规即抛出，消息含定位） */
export function validatePlan(plan: unknown): ValidPlan {
  const record = asRecord(plan, 'plan');
  // 顶层键集合不做"严格等于"校验：`/apply` 允许在 L1 之外再带 `confirmToken`（设计文档 §3.8）
  if (record.v !== 1) failPlan(`v 必须为 1，实际 ${JSON.stringify(record.v)}`);
  const status = record.status;
  if (status !== 'ok' && status !== 'clarify' && status !== 'unsupported') {
    failPlan(`status 非法：${JSON.stringify(status)}`);
  }
  if (typeof record.say !== 'string') failPlan('缺少 say');
  const confidence = record.confidence;
  if (typeof confidence !== 'number' || !CONFIDENCE_VALUES.includes(confidence)) {
    failPlan(`confidence 必须是 ${CONFIDENCE_VALUES.join('/')} 之一，实际 ${JSON.stringify(confidence)}`);
  }
  if (status === 'clarify' && (typeof record.question !== 'string' || record.question === '')) {
    failPlan('clarify 必须带 question');
  }
  const rawOps = record.ops === undefined ? (status === 'ok' ? undefined : []) : record.ops;
  if (!Array.isArray(rawOps)) failPlan('ops 必须是数组');
  if (status === 'ok' && rawOps.length === 0) failPlan('status=ok 时 ops 不能为空');
  if (rawOps.length > MAX_OPS) failPlan(`ops 最多 ${MAX_OPS} 项，实际 ${rawOps.length}`);
  const ops = rawOps.map((raw, index) => validateOp(raw, index));
  const text =
    typeof record.text === 'string'
      ? record.text
      : typeof record.utterance === 'string'
        ? record.utterance
        : '';
  return { status, ops, say: record.say, confidence, text };
}

// ---------------------------------------------------------------------------
// 数字接地（设计文档 §3.2 / §3.5：`set` 的数值必须在用户原话里出现）
// ---------------------------------------------------------------------------

function normalizeNumberText(text: string): string {
  return text
    .replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uff0e/g, '.')
    .replace(/[\uff0d\u2014\u2013\u2212]/g, '-')
    .replace(/负/g, '-');
}

/** 原话里能否找到这个数（允许 3 / 3.0 / 3.00；负数允许 `-3` 与「负 3」） */
export function numberGrounded(utterance: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const normalized = normalizeNumberText(utterance);
  const forms = new Set<string>([String(value)]);
  for (const digits of [1, 2, 3]) {
    const text = value.toFixed(digits);
    // 只收"数值相等"的写法：4.5 不能退化成 5（toFixed(0) 会四舍五入）
    if (Math.abs(Number(text) - value) < 1e-9) forms.add(text);
  }
  for (const form of forms) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 两侧都不能挨着数字或小数点：「4」不算命中「4.5」，「3」不算命中「13」
    if (new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(normalized)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 动作累积
// ---------------------------------------------------------------------------

interface Entry {
  readonly id: string;
  readonly spec: RegisterSpec;
  readonly current: number;
  /** 顺序套用后的目标值（未截断、未夹紧） */
  value: number;
  /** 本轮相对当前值的累计 delta（只统计 delta 类动作，单轮上限用） */
  deltaSum: number;
  /** 本轮是否出现过绝对值动作（`paramSet` / `bandSet`：场景、音色、开关、点名的 set） */
  absUsed: boolean;
  final: number;
  changed: boolean;
  clamped: boolean;
  capped: boolean;
}

function actionId(action: RuleAction): string {
  if (action.kind === 'param' || action.kind === 'paramSet') return action.id;
  return `eq.band${action.band}.${action.field}`;
}

function entryFor(entries: Map<string, Entry>, id: string, state: VoiceState): Entry | null {
  const cached = entries.get(id);
  if (cached) return cached;
  const spec = specOfParamId(id);
  if (!spec) return null;
  const current = currentValueOf(id, state);
  const entry: Entry = {
    id,
    spec,
    current,
    value: current,
    deltaSum: 0,
    absUsed: false,
    final: current,
    changed: false,
    clamped: false,
    capped: false,
  };
  entries.set(id, entry);
  return entry;
}

function applyActions(entries: Map<string, Entry>, actions: readonly RuleAction[], state: VoiceState): void {
  for (const action of actions) {
    if (action.kind === 'band' || action.kind === 'bandSet') {
      if (action.band === EQ_DELTA_BAND_PLACEHOLDER) {
        throw new Error(`E_RULE_PLACEHOLDER: 占位段号没有替换成真实段号（${actionId(action)}）`);
      }
    }
    const entry = entryFor(entries, actionId(action), state);
    if (!entry) continue;
    if (action.kind === 'param' || action.kind === 'band') {
      entry.value += action.delta;
      entry.deltaSum += action.delta;
    } else {
      entry.value = action.value;
      entry.absUsed = true;
    }
  }
}

/** 单轮上限 → `rgb.Mode` 取模 → 夹紧量化；返回最终工程量（幂等，可重复调用） */
function finalizeEntry(entry: Entry): number {
  const spec = entry.spec;
  let requested = entry.value;
  let capped = false;
  if (!entry.absUsed && entry.deltaSum !== 0) {
    const cap = capOfId(entry.id);
    if (Number.isFinite(cap) && Math.abs(entry.deltaSum) > cap + EPS) {
      requested = entry.current + Math.sign(entry.deltaSum) * cap;
      capped = true;
    }
  }
  if (!entry.absUsed && entry.id === RGB_MODE_ID) {
    // 0..7 循环，不是夹紧（设计文档 §3.1 的 rgbMode 行）
    const span = Math.round(spec.max - spec.min) + 1;
    requested = (((requested - spec.min) % span) + span) % span + spec.min;
  }
  const quantized = quantizeValue(spec, requested);
  const currentQuantized = quantizeValue(spec, entry.current);
  entry.final = quantized;
  entry.changed = Math.abs(quantized - currentQuantized) > EPS;
  entry.capped = capped;
  entry.clamped = capped || Math.abs(quantized - requested) > spec.step + 1e-6;
  return quantized;
}

function formatValue(value: number, spec: RegisterSpec): string {
  const step = spec.step > 0 ? spec.step : 1;
  const decimals = step >= 1 ? 0 : Math.min(4, Math.max(0, Math.round(-Math.log10(step))));
  return value.toFixed(decimals);
}

function previewLine(entry: Entry, dropped: DangerReason | null): string {
  const unit = entry.spec.unit ? ` ${entry.spec.unit}` : '';
  const notes: string[] = [];
  if (entry.capped) notes.push('clamped: 单轮上限');
  else if (entry.clamped) notes.push('clamped');
  if (dropped === 'excluded') notes.push('excluded');
  if (dropped === 'confirm-required') notes.push('confirm-required');
  if (!entry.changed) notes.push('无变化，不写入');
  const note = notes.length > 0 ? `（${notes.join('；')}）` : '';
  return `${entry.id} ${formatValue(entry.current, entry.spec)} → ${formatValue(entry.final, entry.spec)}${unit}${note}`;
}

const DANGER_TEXT: Readonly<Record<DangerReason, string>> = Object.freeze({
  'confirm-required': '需整轮二次确认（confirm）',
  excluded: '不支持语音调整（excluded）',
  'ungrounded-number': '数值未在用户原话中出现（ungrounded-number）',
});

// ---------------------------------------------------------------------------
// 场景 / 音色
// ---------------------------------------------------------------------------

function sceneAbsActions(sceneId: string, state: VoiceState): RuleAction[] {
  const scene = SCENES.find((item) => item.id === sceneId);
  if (!scene) return [];
  const patch = scenePatch(scene, state.bands);
  const actions: RuleAction[] = [];
  for (const [id, value] of Object.entries(patch.params)) actions.push({ kind: 'paramSet', id, value });
  patch.gains.slice(0, 7).forEach((gain, index) => {
    actions.push({ kind: 'bandSet', band: index + 1, field: 'gain', value: gain });
  });
  return actions;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export function planToCommand(plan: object, state: VoiceState, ctx: CanonContext): CanonResult {
  const valid = validatePlan(plan);
  const utterance = (() => {
    if (ctx && typeof ctx.utterance === 'string' && ctx.utterance.trim() !== '') return ctx.utterance;
    return valid.text;
  })();

  const preview: string[] = [];
  const danger: VoiceDanger[] = [];
  const entries = new Map<string, Entry>();
  const seenDirections: { target: string; direction: Direction }[] = [];
  let scene: string | null = null;
  let tone: string | null = null;
  let undo = false;

  const base = {
    writes: [] as VoiceWrite[],
    bandWrites: [] as VoiceBandWrite[],
    scene: null as string | null,
    tone: null as string | null,
    danger,
    preview,
    tier: 'immediate' as Tier,
    say: valid.say,
    undo: false,
  };

  if (valid.status !== 'ok') {
    preview.push(`status=${valid.status}：本轮不产生写入`);
    return base;
  }

  valid.ops.forEach((op, index) => {
    const label = `op${index + 1} ${op.kind}`;
    switch (op.kind) {
      case 'tune': {
        const target = op.target as (typeof TUNE_TARGETS)[number];
        const actions = resolveTune(target, op.direction, op.strength);
        applyActions(entries, actions, state);
        seenDirections.push({ target: op.target, direction: op.direction });
        preview.push(
          `${label} ${TARGET_NAME_ZH[target] ?? op.target} ${op.direction}/${op.strength}：${actions.length} 条动作`,
        );
        break;
      }
      case 'eq': {
        let band: number;
        if (typeof op.band === 'number') {
          band = op.band;
        } else {
          const mapped = bandForCenterHz(op.centerHz ?? 0);
          if (mapped === 'unsupported') {
            const near = nearestBandOf(op.centerHz ?? 0);
            const param = `eq.band${near}.${op.field}`;
            danger.push({ param, reason: 'excluded' });
            preview.push(
              `${label} ${op.centerHz} Hz 落在第 ${near} 段（${centerHzOfBand(near)} Hz，滤波器不是均衡段）：已丢弃（excluded）`,
            );
            break;
          }
          band = mapped;
        }
        const delta = resolveEqDelta(op.field, op.direction, op.strength);
        if (op.field === 'freq') {
          // `freqPct` 的 delta 是百分比：按当前频点换算成 Hz 的增量，再交给夹紧（20..20000）
          const percent = delta.kind === 'band' ? delta.delta : 0;
          const currentHz = currentValueOf(`eq.band${band}.freq`, state);
          const deltaHz = Math.round((currentHz * percent) / 100);
          const action: RuleAction = { kind: 'band', band, field: 'freq', delta: deltaHz };
          applyActions(entries, [action], state);
          preview.push(`${label} 第 ${band} 段频点 ${percent >= 0 ? '+' : ''}${percent}%（≈${deltaHz} Hz）`);
          break;
        }
        applyActions(entries, [withRealBand(delta, band)], state);
        preview.push(`${label} 第 ${band} 段 ${op.field} ${op.direction}/${op.strength}`);
        break;
      }
      case 'toggle': {
        const target = op.target as (typeof TOGGLE_TARGETS)[number];
        const actions = resolveToggle(target, op.on);
        applyActions(entries, actions, state);
        preview.push(`${label} ${op.target} ${op.on ? 'on' : 'off'}：${actions.length} 条动作`);
        break;
      }
      case 'set': {
        if (!isParamId(op.param)) {
          danger.push({ param: op.param, reason: 'excluded' });
          preview.push(`${label} ${op.param}：不在 72 个可写 paramId 内，已丢弃（excluded）`);
          break;
        }
        if (!Number.isFinite(op.value)) {
          danger.push({ param: op.param, reason: 'excluded' });
          preview.push(`${label} ${op.param}：数值不是有限数，已丢弃（excluded）`);
          break;
        }
        if (!numberGrounded(utterance, op.value)) {
          danger.push({ param: op.param, reason: 'ungrounded-number' });
          preview.push(`${label} ${op.param}=${op.value}：用户原话里找不到这个数值，已丢弃（ungrounded-number）`);
          break;
        }
        applyActions(entries, [{ kind: 'paramSet', id: op.param, value: op.value }], state);
        preview.push(`${label} ${op.param} := ${op.value}`);
        break;
      }
      case 'scene': {
        if (op.scenario !== undefined) {
          const scenario = SCENARIOS.find((item) => item.id === op.scenario);
          if (!scenario) {
            danger.push({ param: 'scene', reason: 'excluded' });
            preview.push(`${label} 未知场景说法 ${op.scenario}：已丢弃（excluded）`);
            break;
          }
          applyActions(entries, sceneAbsActions(scenario.baseScene, state), state);
          applyActions(entries, scenario.patch, state);
          scene = scenario.baseScene;
          preview.push(
            `${label} ${scenario.id} → 场景 ${scenario.baseScene}（含 ${scenario.patch.length} 条补丁）`,
          );
          break;
        }
        const sceneId = op.scene ?? '';
        if (!SCENES.some((item) => item.id === sceneId)) {
          danger.push({ param: 'scene', reason: 'excluded' });
          preview.push(`${label} 未知场景 ${sceneId}：已丢弃（excluded）`);
          break;
        }
        applyActions(entries, sceneAbsActions(sceneId, state), state);
        scene = sceneId;
        preview.push(`${label} 场景 ${sceneId}（整包写入参数 + 7 段增益）`);
        break;
      }
      case 'tone': {
        tone = op.tone;
        if (op.tone === 'custom') {
          preview.push(`${label} custom：自定义曲线由用户拖拽，不写增益（no-op）`);
          break;
        }
        const gains = EQ_PRESETS[op.tone as keyof typeof EQ_PRESETS];
        if (!gains) {
          danger.push({ param: 'tone', reason: 'excluded' });
          preview.push(`${label} 未知音色 ${op.tone}：已丢弃（excluded）`);
          break;
        }
        gains.forEach((gain, bandIndex) => {
          applyActions(entries, [{ kind: 'bandSet', band: bandIndex + 1, field: 'gain', value: gain }], state);
        });
        preview.push(`${label} ${op.tone}：7 段增益整包写入`);
        break;
      }
      case 'undo': {
        undo = true;
        preview.push(`${label}：撤销由 SubStage 4.2 提供，本层不写`);
        break;
      }
    }
  });

  // 条件动作：主规则套完后，按**本轮目标值**判断是否已到端点（设计文档 §3.4 表内括注）
  for (const conditional of CONDITIONALS) {
    const hit = seenDirections.some(
      (item) => item.target === conditional.target && item.direction === conditional.direction,
    );
    if (!hit) continue;
    const whenId = conditional.when.id;
    const entry = entries.get(whenId);
    const value = entry ? finalizeEntry(entry) : currentValueOf(whenId, state);
    if (!(value <= conditional.when.atOrBelow + EPS)) continue;
    applyActions(entries, conditional.then, state);
    preview.push(
      `条件动作：${conditional.target}.${conditional.direction} 使 ${whenId}=${value}（≤ ${conditional.when.atOrBelow}）→ 追加 ${conditional.then.length} 条`,
    );
  }

  const tiers = new Map<string, Tier>();
  for (const entry of entries.values()) {
    finalizeEntry(entry);
    tiers.set(entry.id, tierOfParam(entry.id));
  }
  const needsConfirm = [...entries.values()].some(
    (entry) => entry.changed && tiers.get(entry.id) === 'confirm',
  );
  const dropped = new Map<string, DangerReason>();
  const kept: Entry[] = [];
  for (const entry of entries.values()) {
    const tier = tiers.get(entry.id) ?? 'immediate';
    if (tier === 'excluded') {
      dropped.set(entry.id, 'excluded');
      danger.push({ param: entry.id, reason: 'excluded' });
      continue;
    }
    if (!entry.changed) continue;
    if (needsConfirm && tier === 'immediate') {
      // 原子性：只要有一个 confirm 项，整轮都不写（设计文档 §3.3）
      dropped.set(entry.id, 'confirm-required');
      danger.push({ param: entry.id, reason: 'confirm-required' });
      continue;
    }
    kept.push(entry);
  }

  const writes: VoiceWrite[] = [];
  const bandWrites: VoiceBandWrite[] = [];
  for (const entry of kept) {
    const bandMatch = BAND_ID_RE.exec(entry.id);
    if (bandMatch) {
      bandWrites.push({
        band: Number(bandMatch[1]),
        field: bandMatch[2] as EqField,
        value: entry.final,
      });
    } else {
      writes.push({ param: entry.id, value: entry.final });
    }
  }

  for (const entry of entries.values()) {
    const reason = dropped.get(entry.id) ?? null;
    if (!entry.changed && !entry.clamped && reason === null) continue;
    preview.push(previewLine(entry, reason));
  }
  for (const item of danger) {
    if (dropped.has(item.param)) continue;
    preview.push(`${item.param}：${DANGER_TEXT[item.reason]}`);
  }

  let tier: Tier = 'immediate';
  if (needsConfirm) tier = 'confirm';
  else if (kept.length === 0 && danger.some((item) => item.reason === 'excluded')) tier = 'excluded';

  let say = valid.say;
  const mutes = writes.some(
    (write) => (write.param === 'mic.mute' || write.param === 'mic.sigMute') && write.value === 1,
  );
  if (mutes) {
    say = MUTE_SAY;
    preview.push(`静音：播报话术被规则表覆盖为「${MUTE_SAY}」`);
  }
  if (writes.length === 0 && bandWrites.length === 0 && danger.length === 0) {
    preview.push('无写入（本轮没有可执行动作）');
  }

  return { writes, bandWrites, scene, tone, danger, preview, tier, say, undo };
}
