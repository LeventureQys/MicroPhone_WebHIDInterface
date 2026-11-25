/**
 * SubStage 5.3 §4.1：指标算法（纯函数，不碰进程、不碰网络）。
 *
 * 口径（逐条对着任务书 §4.1 写，改动前先回任务书）：
 *
 * | 指标 | 定义 |
 * |---|---|
 * | `validRate` | 输出为合法 L1 的比例（`validateL1` 按 `schema/voice-plan.schema.json` 判） |
 * | `actionSetF1` | 逐样本按 op 做集合匹配 → 每样本 P/R/F1 → **宏平均** |
 * | `refusalRecall` | 范围外（含 `explainOnly`）语料里 `status=='unsupported'` 的比例；分母 0 返回 0 |
 * | `overRefusal` | 支持类语料里被判 `unsupported` 的比例 |
 * | `strengthAcc` | `tune`/`eq` 的 `strength` 与期望一致的比例（只统计"目标命中"的 op） |
 * | `groundingAcc` | `set` 类语料里，输出里所有 `set` 的数值都能在原话里找到的比例 |
 * | `p50/p95Ms` | 单条墙钟（进程内，不含进程启动） |
 *
 * op 的匹配键（§4.1）：`tune` 用 `target`、`eq` 用 `band`（`centerHz` 先折算成 `band`）、
 * `toggle` 用 `target`、`set` 用 `param`。**宽严两处**：
 *   - `tune`/`eq` 只比 `target`+`direction`（+`strength` 单独进 `strengthAcc`），**不比 dB**；
 *   - `set` 比 `param`+`value`，`eq.band*.gain` 容差 ±0.6（其余精确相等）。
 */

/** `set` 的跨语言数值容差（§4.1：`eq.band*.gain` 容差 ±0.6） */
export const GAIN_TOLERANCE = 0.6;

export const TUNE_TARGETS = Object.freeze([
  'brightness', 'warmth', 'lowEnd', 'muddiness', 'clarity', 'sibilance', 'harshness',
  'noiseFloor', 'compression', 'loudness', 'gate', 'limiter', 'rgbMode',
]);
export const TOGGLE_TARGETS = Object.freeze([
  'noiseFloor', 'gate', 'limiter', 'compression', 'rgbMode', 'mute', 'monitor',
]);
export const DIRECTIONS = Object.freeze(['more', 'less']);
export const STRENGTHS = Object.freeze(['slight', 'medium', 'strong']);
export const EQ_FIELDS = Object.freeze(['gain', 'q', 'freq']);
export const SCENES = Object.freeze(['quiet', 'game', 'podcast', 'sing', 'custom']);
export const TONES = Object.freeze(['flat', 'vocal', 'warm', 'bright', 'custom']);
export const STATUSES = Object.freeze(['ok', 'clarify', 'unsupported']);
export const CONFIDENCES = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
export const OP_KINDS = Object.freeze(['tune', 'eq', 'toggle', 'set', 'scene', 'tone', 'undo']);
export const MAX_OPS = 4;

/** `set` 可用的 paramId（`schema/voice-plan.schema.json` 的枚举，逐字抄） */
export const SET_PARAMS = Object.freeze([
  'mic.mute', 'mic.sigMute', 'hp.OnOff', 'enc.OnOff', 'enc.Level', 'eq.mode',
  'comp.Enable', 'comp.MakeUpGain', 'comp.Threshold', 'comp.Attack', 'comp.Release', 'comp.Rate',
  'comp.KneeWidth', 'limit.Enable', 'limit.Threshold', 'limit.Attack', 'limit.Release',
  'noisegate.Enable', 'noisegate.threshold_db', 'noisegate.ratio', 'noisegate.attack_ms',
  'noisegate.release_ms', 'noisegate.knee_width_db', 'noisegate.hp_freq',
  'drc3.Enable', 'drc3.fc1', 'drc3.fc2',
  'drc3.low.preGain', 'drc3.low.threshold', 'drc3.low.attackTime', 'drc3.low.releaseTime',
  'drc3.low.ratio', 'drc3.high.preGain', 'drc3.high.threshold', 'drc3.high.attackTime',
  'drc3.high.releaseTime', 'drc3.high.ratio', 'drc3.mid.preGain', 'drc3.mid.threshold',
  'drc3.mid.attackTime', 'drc3.mid.releaseTime', 'drc3.mid.ratio',
  'rgb.OnOff', 'rgb.Mode',
  ...Array.from({ length: 7 }, (_, index) => {
    const band = index + 1;
    return [`eq.band${band}.type`, `eq.band${band}.freq`, `eq.band${band}.gain`, `eq.band${band}.q`];
  }).flat(),
]);

const SET_PARAM_SET = new Set(SET_PARAMS);
const TOP_KEYS = Object.freeze(['v', 'status', 'ops', 'say', 'confidence']);

// ---------------------------------------------------------------------------
// L1 合法性（`schema/voice-plan.schema.json` + 设计文档 §3.8 的"ops 超 4 项"）
// ---------------------------------------------------------------------------

function checkOpShape(op, index) {
  const errors = [];
  if (!op || typeof op !== 'object' || Array.isArray(op)) return [`ops[${index}] 不是对象`];
  const where = `ops[${index}]`;
  switch (op.kind) {
    case 'tune':
      for (const key of ['kind', 'target', 'direction', 'strength']) {
        if (!(key in op)) errors.push(`${where}.${key} 缺字段`);
      }
      for (const key of Object.keys(op)) {
        if (!['kind', 'target', 'direction', 'strength'].includes(key)) errors.push(`${where}.${key} 多余`);
      }
      if ('target' in op && !TUNE_TARGETS.includes(op.target)) errors.push(`${where}.target 非法`);
      if ('direction' in op && !DIRECTIONS.includes(op.direction)) errors.push(`${where}.direction 非法`);
      if ('strength' in op && !STRENGTHS.includes(op.strength)) errors.push(`${where}.strength 非法`);
      break;
    case 'eq': {
      const hasBand = typeof op.band === 'number';
      const hasHz = typeof op.centerHz === 'number';
      if (hasBand === hasHz) errors.push(`${where} 必须且只能有 band 或 centerHz 之一`);
      if (hasBand && !(Number.isInteger(op.band) && op.band >= 1 && op.band <= 7)) {
        errors.push(`${where}.band 越界`);
      }
      if (hasHz && !(op.centerHz >= 20 && op.centerHz <= 20000)) errors.push(`${where}.centerHz 越界`);
      if (!EQ_FIELDS.includes(op.field)) errors.push(`${where}.field 非法`);
      if (!DIRECTIONS.includes(op.direction)) errors.push(`${where}.direction 非法`);
      if ('strength' in op && !STRENGTHS.includes(op.strength)) errors.push(`${where}.strength 非法`);
      const allowed = ['kind', 'band', 'centerHz', 'direction', 'strength', 'field'];
      for (const key of Object.keys(op)) {
        if (!allowed.includes(key)) errors.push(`${where}.${key} 多余`);
      }
      break;
    }
    case 'toggle':
      if (!TOGGLE_TARGETS.includes(op.target)) errors.push(`${where}.target 非法`);
      if (typeof op.on !== 'boolean') errors.push(`${where}.on 不是布尔`);
      for (const key of Object.keys(op)) {
        if (!['kind', 'target', 'on'].includes(key)) errors.push(`${where}.${key} 多余`);
      }
      break;
    case 'set':
      if (!SET_PARAM_SET.has(op.param)) errors.push(`${where}.param 不在白名单`);
      if (!Number.isFinite(op.value)) errors.push(`${where}.value 不是有限数字`);
      for (const key of Object.keys(op)) {
        if (!['kind', 'param', 'value'].includes(key)) errors.push(`${where}.${key} 多余`);
      }
      break;
    case 'scene':
      if (!SCENES.includes(op.scene)) errors.push(`${where}.scene 非法`);
      break;
    case 'tone':
      if (!TONES.includes(op.tone)) errors.push(`${where}.tone 非法`);
      break;
    case 'undo':
      break;
    default:
      errors.push(`${where}.kind 非法（${op.kind}）`);
  }
  return errors;
}

/**
 * 判一个 L1 是否合法。
 *
 * 附加顶层键放行（设计文档 §3.10.1：`plan` 顶层多带 `text` 是允许的），
 * 但 `ops` 上限按设计文档 §3.8 的 `E_PLAN_INVALID` 取 4。
 */
export function validateL1(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, errors: ['plan 不是对象'] };
  }
  for (const key of TOP_KEYS) {
    if (!(key in plan)) errors.push(`缺顶层键 ${key}`);
  }
  if ('v' in plan && plan.v !== 1) errors.push(`v 应为 1（实为 ${plan.v}）`);
  if ('status' in plan && !STATUSES.includes(plan.status)) errors.push(`status 非法（${plan.status}）`);
  if ('say' in plan && typeof plan.say !== 'string') errors.push('say 不是字符串');
  if ('confidence' in plan && !CONFIDENCES.includes(plan.confidence)) {
    errors.push(`confidence 非法（${plan.confidence}）`);
  }
  if (!Array.isArray(plan.ops)) {
    errors.push('ops 不是数组');
    return { ok: false, errors };
  }
  if (plan.ops.length > MAX_OPS) errors.push(`ops 超过 ${MAX_OPS} 项（${plan.ops.length}）`);
  plan.ops.forEach((op, index) => errors.push(...checkOpShape(op, index)));
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 数字接地（与 `contract/canonicalize.ts` 的 `numberGrounded` 同规则）
// ---------------------------------------------------------------------------

function normalizeNumberText(text) {
  return String(text)
    .replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uff0e/g, '.')
    .replace(/[\uff0d\u2014\u2013\u2212]/g, '-')
    .replace(/负/g, '-');
}

/** 原话里能否找到这个数（`3` / `3.0` / `3.00` 等价；`4` 不算命中 `4.5` 或 `13`） */
export function numberGrounded(utterance, value) {
  if (!Number.isFinite(value)) return false;
  const normalized = normalizeNumberText(utterance);
  const forms = new Set([String(value)]);
  for (const digits of [1, 2, 3]) {
    const text = value.toFixed(digits);
    if (Math.abs(Number(text) - value) < 1e-9) forms.add(text);
  }
  for (const form of forms) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(normalized)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// op 匹配
// ---------------------------------------------------------------------------

/** `eq` 的 `centerHz` 折算成最近的段号（`schema/targets.json` 的 7 段中心频率） */
export const BAND_CENTERS = Object.freeze([63, 250, 1000, 4000, 8000, 10000, 12500]);

export function bandOfCenter(hz) {
  let best = 1;
  let bestDistance = Infinity;
  BAND_CENTERS.forEach((center, index) => {
    const distance = Math.abs(center - Number(hz));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index + 1;
    }
  });
  return best;
}

/** 匹配键：`kind:定位`，用于统计与审计（不参与容差判定） */
export function opKey(op) {
  if (!op || typeof op !== 'object') return 'invalid';
  switch (op.kind) {
    case 'tune':
      return `tune:${op.target}`;
    case 'eq':
      return `eq:band${typeof op.band === 'number' ? op.band : bandOfCenter(op.centerHz)}`;
    case 'toggle':
      return `toggle:${op.target}`;
    case 'set':
      return `set:${op.param}`;
    case 'scene':
      return `scene:${op.scene}`;
    case 'tone':
      return `tone:${op.tone}`;
    case 'undo':
      return 'undo';
    default:
      return `invalid:${JSON.stringify(op)}`;
  }
}

function sameValue(param, expected, actual) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  if (/^eq\.band[1-7]\.gain$/.test(String(param))) {
    return Math.abs(expected - actual) <= GAIN_TOLERANCE + 1e-9;
  }
  return Math.abs(expected - actual) < 1e-9;
}

/**
 * 两个 op 是否算"同一个动作"。
 *
 * `tune`/`eq`：只比定位 + 方向（strength 单独进 `strengthAcc`）；
 * `toggle`：比 target + on；`set`：比 param + value（gain 容差）；场景/音色/撤销：整体相等。
 */
export function sameOp(expected, actual) {
  if (!expected || !actual || expected.kind !== actual.kind) return false;
  switch (expected.kind) {
    case 'tune':
      return expected.target === actual.target && expected.direction === actual.direction;
    case 'eq': {
      const band = (op) => (typeof op.band === 'number' ? op.band : bandOfCenter(op.centerHz));
      return band(expected) === band(actual)
        && expected.field === actual.field
        && expected.direction === actual.direction;
    }
    case 'toggle':
      return expected.target === actual.target && expected.on === actual.on;
    case 'set':
      return expected.param === actual.param && sameValue(expected.param, expected.value, actual.value);
    case 'scene':
      return expected.scene === actual.scene;
    case 'tone':
      return expected.tone === actual.tone;
    case 'undo':
      return true;
    default:
      return false;
  }
}

/** 贪心一对一指派（期望在前、实际在后），返回 `{pairs, missedExpected, extraActual}` */
export function matchOps(expectedOps, actualOps, matcher = sameOp) {
  const used = new Set();
  const pairs = [];
  const missedExpected = [];
  for (const expected of expectedOps) {
    let hit = -1;
    for (let index = 0; index < actualOps.length; index += 1) {
      if (used.has(index)) continue;
      if (matcher(expected, actualOps[index])) {
        hit = index;
        break;
      }
    }
    if (hit >= 0) {
      used.add(hit);
      pairs.push([expected, actualOps[hit]]);
    } else {
      missedExpected.push(expected);
    }
  }
  const extraActual = actualOps.filter((_, index) => !used.has(index));
  return { pairs, missedExpected, extraActual };
}

/** 单样本 P/R/F1（空期望 + 空输出 = 1，§6 第 1 条） */
export function sampleF1(expectedOps, actualOps) {
  const expected = Array.isArray(expectedOps) ? expectedOps : [];
  const actual = Array.isArray(actualOps) ? actualOps : [];
  const { pairs, extraActual } = matchOps(expected, actual);
  const hit = pairs.length;
  const precision = actual.length === 0 ? (expected.length === 0 ? 1 : 0) : hit / actual.length;
  const recall = expected.length === 0 ? 1 : hit / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, hit, extra: extraActual.length, missed: expected.length - hit };
}

// ---------------------------------------------------------------------------
// 分布
// ---------------------------------------------------------------------------

/** 最近秩分位数（与 `test_student.mjs` 的 p50 同口径） */
export function percentile(values, fraction) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * finite.length));
  return finite[Math.min(finite.length - 1, rank - 1)];
}

export function p50(values) {
  return percentile(values, 0.5);
}

export function p95(values) {
  return percentile(values, 0.95);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * 一批样本的完整指标。
 *
 * `samples`：`{id, kb, text, expected, actual, ms}`，`actual` 可以是 `null`
 * （模型没吐出合法 L1 / 进程崩了）——这种样本计入 `validRate` 的分母、不计入分子。
 */
export function summarize(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const total = rows.length;
  const supported = rows.filter((row) => row.expected?.status === 'ok');
  const outOfScope = rows.filter((row) => row.expected?.status === 'unsupported');

  let valid = 0;
  let overRefusal = 0;
  let refusalHit = 0;
  let f1Sum = 0;
  let precisionSum = 0;
  let recallSum = 0;
  let strengthDenominator = 0;
  let strengthHit = 0;
  let setSamples = 0;
  let setSamplesGrounded = 0;
  let setOps = 0;
  let setOpsGrounded = 0;

  for (const row of rows) {
    const actual = row.actual && typeof row.actual === 'object' ? row.actual : null;
    const actualOps = Array.isArray(actual?.ops) ? actual.ops : [];
    if (actual && validateL1(actual).ok) valid += 1;

    const score = sampleF1(row.expected?.ops ?? [], actualOps);
    f1Sum += score.f1;
    precisionSum += score.precision;
    recallSum += score.recall;

    if (row.expected?.status === 'ok' && actual?.status === 'unsupported') overRefusal += 1;
    if (row.expected?.status === 'unsupported' && actual?.status === 'unsupported') refusalHit += 1;

    // strengthAcc：只统计"目标命中"的 op（任务书 §4.1）
    const expectedOps = Array.isArray(row.expected?.ops) ? row.expected.ops : [];
    for (const expected of expectedOps) {
      if (expected.kind !== 'tune' && expected.kind !== 'eq') continue;
      const targetKey = opKey(expected);
      const candidate = actualOps.find((op) => opKey(op) === targetKey);
      if (!candidate) continue;
      strengthDenominator += 1;
      if (candidate.strength === expected.strength) strengthHit += 1;
    }

    // groundingAcc：只看输出里真的带了 set 的样本（数字接地是"输出侧"的约束）
    const actualSets = actualOps.filter((op) => op && op.kind === 'set');
    if (actualSets.length > 0) {
      setSamples += 1;
      const utterance = row.norm_text ?? row.text ?? '';
      const grounded = actualSets.map((op) => numberGrounded(utterance, op.value));
      setOps += actualSets.length;
      setOpsGrounded += grounded.filter(Boolean).length;
      if (grounded.every(Boolean)) setSamplesGrounded += 1;
    }
  }

  const latencies = rows.map((row) => row.ms);
  return {
    samples: total,
    validRate: total === 0 ? 0 : round(valid / total),
    actionSetF1: total === 0 ? 0 : round(f1Sum / total),
    precision: total === 0 ? 0 : round(precisionSum / total),
    recall: total === 0 ? 0 : round(recallSum / total),
    refusalRecall: outOfScope.length === 0 ? 0 : round(refusalHit / outOfScope.length),
    refusalSamples: outOfScope.length,
    refusalMeasurable: outOfScope.length > 0,
    overRefusal: supported.length === 0 ? 0 : round(overRefusal / supported.length),
    overRefusalSamples: supported.length,
    strengthAcc: strengthDenominator === 0 ? 0 : round(strengthHit / strengthDenominator),
    strengthSamples: strengthDenominator,
    groundingAcc: setSamples === 0 ? 0 : round(setSamplesGrounded / setSamples),
    groundingSamples: setSamples,
    groundingOps: setOps,
    groundingOpsGrounded: setOpsGrounded,
    p50Ms: round(p50(latencies)),
    p95Ms: round(p95(latencies)),
    p99Ms: round(percentile(latencies, 0.99)),
    meanMs: round(latencies.filter(Number.isFinite).reduce((sum, value) => sum + value, 0)
      / Math.max(1, latencies.filter(Number.isFinite).length)),
    errors: rows.filter((row) => row.error).length,
  };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;
}

/**
 * 按 `kb` 键分组的方向一致性（LabelAudit 的机械证据）。
 *
 * 只统计 `tune`/`eq` 这类有方向的样本；`agree` 表示模型给的方向与期望一致，
 * `opposite` 表示恰好反过来。整组都反过来 ⇒ 更像是标签方向写反了，而不是模型笨。
 */
export function directionAudit(samples) {
  const groups = new Map();
  for (const row of samples) {
    const expectedOps = Array.isArray(row.expected?.ops) ? row.expected.ops : [];
    const directional = expectedOps.filter((op) => op.kind === 'tune' || op.kind === 'eq');
    if (directional.length === 0) continue;
    const key = row.kb ?? opKey(directional[0]);
    if (!groups.has(key)) {
      groups.set(key, {
        kb: key,
        samples: 0,
        agree: 0,
        opposite: 0,
        sameTargetOtherDirection: 0,
        noMatch: 0,
        expected: opKey(directional[0]) + `/${directional[0].direction}`,
        example: row.text,
        exampleId: row.id,
      });
    }
    const group = groups.get(key);
    group.samples += 1;
    const actualOps = Array.isArray(row.actual?.ops) ? row.actual.ops : [];
    const target = opKey(directional[0]);
    const hit = actualOps.find((op) => opKey(op) === target && op.direction === directional[0].direction);
    const flipped = actualOps.find((op) => opKey(op) === target && op.direction !== directional[0].direction);
    if (hit) group.agree += 1;
    else if (flipped) group.opposite += 1;
    else group.noMatch += 1;
  }
  return [...groups.values()].sort((a, b) => b.samples - a.samples);
}
