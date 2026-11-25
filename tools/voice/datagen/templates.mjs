/**
 * 核心句模板 + kb 标签工厂（SubStage 5.1）。
 *
 * 三条纪律的落点：
 * 1. **标签只来自 kb**：本文件不写任何 dB / Hz / 档位数值，只从 3.1 的三份生成物
 *    （`lexicons/zh.json` 的说法、`gen/rules.json` 的维度与频段、`schema/targets.json` 的白名单）
 *    组装 `plan`；教师模型只改 `text`，永远拿不到 `plan` 的写权限。
 * 2. **改写句必须被 `parser.py` 命中同一条目**：`verify.mjs` 用真解析器回测；
 *    本文件只负责把"该说什么"造出来。
 * 3. **按 kb 键分组切分**：每个核心句都带 `kb`（分组键）与 `leakKeys`（多意图取全部 op 的键）。
 *
 * 为什么读 JSON 而不是 `import ../contract/kb.ts`：任务书 §4.3 / §6 给的命令没有
 * `--import ./tools/voice/register-loader.mjs`，`kb.ts` 里是无扩展名的相对导入，
 * 裸 Node 解析不了。JSON 是 `emit.mjs` 从 kb 导出的同一份真值（`emit --check` 保证一致），
 * `build.mjs` 再用 kb 本体做一次交叉校验（见 `assertArtifactsMatchKb`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VOICE_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(VOICE_DIR, '..', '..');
export const DATAGEN_DIR = path.join(REPO_ROOT, 'artifacts', 'voice', 'datagen');
export const DATA_DIR = path.join(VOICE_DIR, 'data');

export const DEFAULT_SEED = 20261124;
export const DEFAULT_PER_CORE = 8;

/** 8 个内容类别（对抗样本是叠加标记，不是第 9 类） */
export const CLASSES = Object.freeze([
  'tune',
  'eq',
  'toggle',
  'scene',
  'set',
  'unsupported',
  'explain',
  'clarify',
]);

export const ARTIFACT_FILES = Object.freeze({
  lexicon: path.join(VOICE_DIR, 'lexicons', 'zh.json'),
  rules: path.join(VOICE_DIR, 'gen', 'rules.json'),
  targets: path.join(VOICE_DIR, 'schema', 'targets.json'),
  planSchema: path.join(VOICE_DIR, 'schema', 'voice-plan.schema.json'),
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 读三份生成物并派生出生成核心句需要的全部索引。
 * `wordsByDim` 是从词表 pattern 拆出来的（emit 保证数组顺序 = 首命中顺序）。
 */
export function loadArtifacts(files = ARTIFACT_FILES) {
  const lexicon = readJson(files.lexicon);
  const rules = readJson(files.rules);
  const targets = readJson(files.targets);

  const wordsByDim = new Map();
  for (const entry of lexicon.entries) {
    const bucket = wordsByDim.get(entry.target) ?? {};
    bucket[entry.direction] = entry.pattern.split('|').filter(Boolean);
    wordsByDim.set(entry.target, bucket);
  }

  const rulesById = new Map(rules.dims.map((dim) => [dim.id, dim]));
  const explainById = new Map(targets.explainOnly.map((item) => [item.id, item]));
  const scenarioById = new Map(targets.scenarios.map((item) => [item.id, item]));

  return {
    files,
    lexicon,
    rules,
    targets,
    dims: rules.dims,
    rulesById,
    wordsByDim,
    explainById,
    scenarioById,
    paramIds: new Set(targets.paramIds),
    tuneTargets: new Set(targets.tuneTargets),
    toggleTargets: new Set(targets.toggleTargets),
    scenes: targets.scenes,
    tones: targets.tones,
    bands: targets.bands,
    directions: targets.directions,
    strengths: targets.strengths,
  };
}

// ---------------------------------------------------------------------------
// 播报文案（say）。文案只影响"设备说什么"，不影响标签；词一律取自生成物。
// ---------------------------------------------------------------------------

const FIELD_ZH = Object.freeze({ gain: '增益', freq: '频率', q: 'Q值' });
const CN_BAND = Object.freeze(['一', '二', '三', '四', '五', '六', '七']);

function directionVerb(direction) {
  return direction === 'less' ? '收一收' : '提一提';
}

/** `规则值 → 段`：段名取 `第N段`，N 用中文数字（与用户口语一致） */
export function bandZh(band) {
  return `第${CN_BAND[band - 1]}段`;
}

/** 场景名取词表第一条说法去掉「模式」后缀（安静房间 / 游戏 / 播客 / 唱歌 / 自定义） */
function sceneNameOf(art, scene) {
  const pattern = art.lexicon.scenes.find((item) => item.scene === scene)?.pattern ?? scene;
  return pattern.split('|')[0].replace(/模式$/, '');
}

function toneNameOf(art, tone) {
  const pattern = art.lexicon.tones.find((item) => item.tone === tone)?.pattern ?? tone;
  return pattern.split('|')[0].replace(/(模式|音色)$/, '');
}

function switchWordOf(art, target, on) {
  const entry = art.lexicon.switches.find((item) => item.target === target && item.on === on);
  return (entry?.pattern ?? '').split('|')[0] || (on ? `打开${target}` : `关掉${target}`);
}

export const UNSUPPORTED_SAY = '我只管调麦克风音色，比如声音亮一点';
export const CLARIFY_QUESTION = '想调哪一块？比如声音太闷、齿音太重';

// ---------------------------------------------------------------------------
// plan 构造（L1 VoicePlan，设计文档 §3.2）
// ---------------------------------------------------------------------------

export function tunePlan(art, { target, direction, strength }) {
  const name = art.rulesById.get(target)?.nameZh ?? target;
  return {
    v: 1,
    status: 'ok',
    say: `把${name}${directionVerb(direction)}`,
    confidence: 1,
    ops: [{ kind: 'tune', target, direction, strength }],
  };
}

export function eqPlan(art, { band, centerHz, field, direction, strength }) {
  const op = band === undefined
    ? { kind: 'eq', centerHz, field, direction, strength }
    : { kind: 'eq', band, field, direction, strength };
  const where = band === undefined ? `${centerHz}Hz 附近` : bandZh(band);
  return {
    v: 1,
    status: 'ok',
    say: `把${where}${FIELD_ZH[field]}${directionVerb(direction)}`,
    confidence: 1,
    ops: [op],
  };
}

export function togglePlan(art, { target, on }) {
  return {
    v: 1,
    status: 'ok',
    say: switchWordOf(art, target, on),
    confidence: 1,
    ops: [{ kind: 'toggle', target, on }],
  };
}

export function setPlan(art, { param, value, band, field }) {
  return {
    v: 1,
    status: 'ok',
    say: `${bandZh(band)}${FIELD_ZH[field]}设为 ${value}`,
    confidence: 1,
    ops: [{ kind: 'set', param, value }],
  };
}

export function scenePlan(art, { scene }) {
  return {
    v: 1,
    status: 'ok',
    say: `切到${sceneNameOf(art, scene)}`,
    confidence: 1,
    ops: [{ kind: 'scene', scene }],
  };
}

export function tonePlan(art, { tone }) {
  return {
    v: 1,
    status: 'ok',
    say: `切到${toneNameOf(art, tone)}音色`,
    confidence: 1,
    ops: [{ kind: 'tone', tone }],
  };
}

export function explainPlan(art, { id }) {
  const item = art.explainById.get(id);
  return { v: 1, status: 'unsupported', ops: [], say: item.explain, confidence: 1 };
}

export function unsupportedPlan() {
  return { v: 1, status: 'unsupported', ops: [], say: UNSUPPORTED_SAY, confidence: 1 };
}

export function clarifyPlan() {
  return {
    v: 1,
    status: 'clarify',
    question: CLARIFY_QUESTION,
    say: '',
    confidence: 0.25,
    ops: [],
  };
}

/** 多意图（对抗样本）：ops 按词表条目顺序排列，与 `parser._parse_tune` 的产出顺序一致 */
export function multiPlan(art, ops) {
  const order = new Map();
  for (const entry of art.lexicon.entries) {
    if (!order.has(entry.target)) order.set(entry.target, order.size);
  }
  const sorted = [...ops].sort((a, b) => (order.get(a.target) ?? 99) - (order.get(b.target) ?? 99));
  const directions = new Set(sorted.map((op) => op.direction));
  const names = sorted.map((op) => art.rulesById.get(op.target)?.nameZh ?? op.target);
  const verb = directions.size === 1
    ? directionVerb(sorted[0].direction)
    : '调一调';
  const say = names.length === 1
    ? `把${names[0]}${directionVerb(sorted[0].direction)}`
    : `把${names.join('、')}的地方一起${verb}`;
  return {
    v: 1,
    status: 'ok',
    say,
    confidence: 1,
    ops: sorted.map((op) => ({ kind: 'tune', target: op.target, direction: op.direction, strength: op.strength })),
  };
}

// ---------------------------------------------------------------------------
// 分组键（kb 键）。格式：`<类>:<定位>:<档位|null>`（任务书 §4.1）
// eq 的定位写成 `band4.gain` / `hz250.gain`（段 + 字段两段信息，仍是一个冒号分隔字段）。
// tone / clarify 是任务书清单外的两个前缀，用于把音色与追问样本单独分组（见报告的偏离说明）。
// ---------------------------------------------------------------------------

export function kbKeyOfOp(op) {
  switch (op.kind) {
    case 'tune':
      return `${op.target}:${op.direction}:${op.strength}`;
    case 'eq':
      return op.band === undefined
        ? `eq:hz${op.centerHz}.${op.field}:${op.strength}`
        : `eq:band${op.band}.${op.field}:${op.strength}`;
    case 'toggle':
      return `switch:${op.target}:${op.on ? 'on' : 'off'}`;
    case 'set':
      return `set:${op.param}:null`;
    case 'scene':
      return `scene:${op.scene}:null`;
    case 'tone':
      return `tone:${op.tone}:null`;
    case 'undo':
      return 'undo:undo:null';
    default:
      return `${op.kind}:unknown:null`;
  }
}

/** 单个 op 的语义签名（回测时逐字段比对，比 kb 键更严） */
export function opSignature(op) {
  switch (op.kind) {
    case 'tune':
      return `tune|${op.target}|${op.direction}|${op.strength}`;
    case 'eq':
      return op.band === undefined
        ? `eq|centerHz:${op.centerHz}|${op.field}|${op.direction}|${op.strength}`
        : `eq|band:${op.band}|${op.field}|${op.direction}|${op.strength}`;
    case 'toggle':
      return `toggle|${op.target}|${op.on ? 'on' : 'off'}`;
    case 'set':
      return `set|${op.param}|${op.value}`;
    case 'scene':
      return `scene|${op.scene}`;
    case 'tone':
      return `tone|${op.tone}`;
    case 'undo':
      return 'undo';
    default:
      return `unknown|${op.kind}`;
  }
}

// ---------------------------------------------------------------------------
// plan 结构自检（SubStage 3.3 §4.3 的 1–7 条，手写、不引依赖）
// ---------------------------------------------------------------------------

const TOP_KEYS = new Set(['v', 'status', 'ops', 'say', 'confidence']);
const STATUSES = new Set(['ok', 'clarify', 'unsupported']);
const STRENGTH_SET = new Set(['slight', 'medium', 'strong']);
const DIRECTION_SET = new Set(['more', 'less']);
const EQ_FIELDS = new Set(['gain', 'q', 'freq']);
const CONFIDENCES = new Set([0, 0.25, 0.5, 0.75, 1]);
const SAY_MAX = 30;
const OP_KINDS = new Set(['tune', 'eq', 'toggle', 'set', 'scene', 'tone', 'undo']);

/**
 * @returns {{ok: boolean, errors: string[]}}
 * `allowLongSay`：explainOnly 的 `say` 是 kb 的整句解释（3.2 §10 第 5 条定案"不截断"），
 * 其余情形按 3.3 §4.3 第 5 条卡 30 字。
 */
export function validatePlan(plan, art, { allowLongSay = false } = {}) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['plan 不是对象'] };

  // 1. 顶层键集合
  const keys = Object.keys(plan);
  const extra = keys.filter((key) => !TOP_KEYS.has(key) && key !== 'question');
  if (extra.length > 0) errors.push(`多余顶层键 ${extra.join(',')}`);
  for (const key of TOP_KEYS) {
    if (!(key in plan)) errors.push(`缺少顶层键 ${key}`);
  }
  if (plan.status === 'clarify') {
    if (typeof plan.question !== 'string' || plan.question.length === 0) errors.push('clarify 缺 question');
    if (plan.question && plan.question.length > 20) errors.push(`question 超 20 字（${plan.question.length}）`);
  } else if ('question' in plan) {
    errors.push('非 clarify 不应带 question');
  }

  // 2. 版本与状态
  if (plan.v !== 1) errors.push(`v 应为 1（实为 ${plan.v}）`);
  if (!STATUSES.has(plan.status)) errors.push(`status 非法（${plan.status}）`);

  // 3. ops 数量
  if (!Array.isArray(plan.ops)) {
    errors.push('ops 不是数组');
    return { ok: false, errors };
  }
  if (plan.status === 'ok') {
    if (plan.ops.length < 1 || plan.ops.length > 4) errors.push(`status=ok 时 ops 应为 1..4（实为 ${plan.ops.length}）`);
  } else if (plan.ops.length !== 0) {
    errors.push(`status=${plan.status} 时 ops 应为空（实为 ${plan.ops.length}）`);
  }

  // 4. 每个 op 的 kind 与取值都在白名单内
  plan.ops.forEach((op, index) => {
    const where = `ops[${index}]`;
    if (!op || typeof op !== 'object') {
      errors.push(`${where} 不是对象`);
      return;
    }
    if (!OP_KINDS.has(op.kind)) {
      errors.push(`${where}.kind 非法（${op.kind}）`);
      return;
    }
    if (op.kind === 'tune') {
      if (!art.tuneTargets.has(op.target)) errors.push(`${where}.target 不在白名单（${op.target}）`);
      if (!DIRECTION_SET.has(op.direction)) errors.push(`${where}.direction 非法（${op.direction}）`);
      if (!STRENGTH_SET.has(op.strength)) errors.push(`${where}.strength 非法（${op.strength}）`);
    } else if (op.kind === 'eq') {
      const hasBand = typeof op.band === 'number';
      const hasHz = typeof op.centerHz === 'number';
      if (hasBand === hasHz) errors.push(`${where} 必须且只能有 band 或 centerHz 之一`);
      if (hasBand && !(Number.isInteger(op.band) && op.band >= 1 && op.band <= 7)) {
        errors.push(`${where}.band 越界（${op.band}）`);
      }
      if (hasHz && !(op.centerHz >= 20 && op.centerHz <= 20000)) {
        errors.push(`${where}.centerHz 越界（${op.centerHz}）`);
      }
      if (!EQ_FIELDS.has(op.field)) errors.push(`${where}.field 非法（${op.field}）`);
      if (!DIRECTION_SET.has(op.direction)) errors.push(`${where}.direction 非法（${op.direction}）`);
      if (!STRENGTH_SET.has(op.strength)) errors.push(`${where}.strength 非法（${op.strength}）`);
    } else if (op.kind === 'toggle') {
      if (!art.toggleTargets.has(op.target)) errors.push(`${where}.target 不在白名单（${op.target}）`);
      if (typeof op.on !== 'boolean') errors.push(`${where}.on 不是布尔`);
    } else if (op.kind === 'set') {
      if (!art.paramIds.has(op.param)) errors.push(`${where}.param 不在 72 个 id 内（${op.param}）`);
      if (!Number.isFinite(op.value)) errors.push(`${where}.value 非有限数`);
    } else if (op.kind === 'scene') {
      if (!art.scenes.includes(op.scene)) errors.push(`${where}.scene 不在白名单（${op.scene}）`);
    } else if (op.kind === 'tone') {
      if (!art.tones.includes(op.tone)) errors.push(`${where}.tone 不在白名单（${op.tone}）`);
    } else if (op.kind === 'undo') {
      const extraKeys = Object.keys(op).filter((key) => key !== 'kind');
      if (extraKeys.length > 0) errors.push(`${where} undo 不应带 ${extraKeys.join(',')}`);
    }
  });

  // 5. say 长度（超长按 3.3 §4.3 截断记 warn；本层要求模板自己就合规）
  if (typeof plan.say !== 'string') {
    errors.push('say 不是字符串');
  } else if (!allowLongSay && plan.say.length > SAY_MAX) {
    errors.push(`say 超 ${SAY_MAX} 字（${plan.say.length}）`);
  }

  // 6. confidence 必须是离散档
  if (!CONFIDENCES.has(plan.confidence)) errors.push(`confidence 非法（${plan.confidence}）`);

  // 7. clarify 之外的 status 不应带 question（已在第 1 条覆盖），此处只断言 confidence 关系
  if (plan.confidence < 0.5 && plan.status === 'ok') errors.push('confidence<0.5 不应是 ok');

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 核心句生成
// ---------------------------------------------------------------------------

function filled(template, base) {
  return template.replace('{}', base);
}

/**
 * 一个维度一个方向下的候选说法。
 * `words` 是词表里该 (target, direction) 条目的说法，顺序即首命中顺序。
 */
function poolFor(art, target, direction) {
  const bucket = art.wordsByDim.get(target) ?? {};
  const words = [...(bucket[direction] ?? [])];
  return words
    .filter((word) => word.length >= 1 && word.length <= 6)
    .filter((word) => !/[0-9０-９]/.test(word))
    .filter((word, index) => words.indexOf(word) === index);
}

/**
 * 档位装饰：parser 的档位判据是"句子里有没有档位词"（`一点/稍微/有点儿/略微/小一点` → slight；
 * `很/特别/非常/太/超` → strong；都没有 → medium），所以各档的表述必须在词面上带/不带这些词。
 */
const DECOR = Object.freeze({
  medium: ['{}', '听着{}', '感觉{}', '现在{}', '我说{}'],
  slight: ['有点{}', '稍微{}', '有点儿{}', '略微{}', '{}一点'],
  strong: ['很{}', '特别{}', '非常{}', '太{}了', '超级{}'],
});

/** 词表自带的档位词 + parser 硬编码的「有点」 */
function markerWordsOf(art) {
  const words = art.lexicon.strengthWords ?? {};
  return {
    slight: [...(words.slight ?? []), '有点'].filter(Boolean),
    strong: [...(words.strong ?? [])].filter(Boolean),
  };
}

function markerOf(text, markers) {
  if (markers.strong.some((word) => text.includes(word))) return 'strong';
  if (markers.slight.some((word) => text.includes(word))) return 'slight';
  return null;
}

/**
 * 词表里有些说法会串到别的维度（"压缩轻一点"里的"轻一点"是 loudness 的说法、
 * "人声太靠后"自带 strong 档词）。这些说法当核心句会造出双 op 或错档的标签，
 * 因此按"核心句族"显式排除，原因写在旁边。
 */
const TUNE_EXCLUDE = Object.freeze({
  // "轻一点/小一点/大一点/小声点" 同时是 loudness 的说法 → 解析出两个 op
  'compression.less': ['压缩轻一点', '动态大一点', '起伏多一点'],
  'compression.more': ['动态小一点'],
  // "太"在句子里 → 档位恒 strong，做不了 medium/slight 的核心句
  'clarity.less': ['人声太靠后'],
  'muddiness.less': ['声音太薄了'],
  // "闷" 的说法里带"一点"，medium 档用不了（slight 档仍可用）
  'gate.more': ['门严一点', '切得狠一点', '门限高一点'],
  // "空气感/通透" 类说法与 brightness 重叠
  'warmth.more': [],
});

/**
 * 词表没法表达的格子：`harshness.more` 的三条说法（毛刺多一点 / 再刺耳一点 / 更硬一点）
 * 全都自带"一点"，解析器必判 slight；medium 档在这个方向上不可表达（不是漏做，见报告）。
 */
export const UNEXPRESSIBLE_TUNE_CELLS = Object.freeze(['tune.harshness.more.medium']);

/** manifest 里去掉 `tune.` 前缀的写法（验收按 `<target>.<direction>.<strength>` 核） */
export function unexpressedCellKeys() {
  return UNEXPRESSIBLE_TUNE_CELLS.map((key) => key.replace(/^tune\./u, ''));
}

/**
 * 数字口径（任务书"数据里不许留含阿拉伯数字的改写句"的落地方式）。
 *
 * 冲突点：`parser._grounded` 与 `lexicon.hzParam` 只认阿拉伯数字，而 `set`（数字接地）与
 * `eq` 的频点寻址必须让数字出现在句子里，否则解析器给不出对应标签。裁决（2026-11-24）：
 * - 教师改写的行（`src:'teacher'`）**一律不含阿拉伯数字**，含则按 `has-digit` 丢弃；
 * - `set` 与频点寻址两类**整类不走教师**，用 kb 词表拼出来的模板句（`src:'template'`）保留数字。
 * 写进 `data/manifest.json` 的 `digitPolicy`，便于验收复核。
 */
export const DIGIT_POLICY = Object.freeze({
  teacher: 'no-arabic-digits',
  set: 'template-only',
  eqCenterHz: 'template-only',
});

const TUNE_PER_CELL = 5;

function tuneTextsFor(art, target, direction, strength) {
  const markers = markerWordsOf(art);
  const excluded = new Set(TUNE_EXCLUDE[`${target}.${direction}`] ?? []);
  const pool = poolFor(art, target, direction).filter((word) => !excluded.has(word));
  if (pool.length === 0) return [];
  const usable = pool.filter((base) => {
    const marker = markerOf(base, markers);
    if (strength === 'medium') return marker === null;
    if (strength === 'slight') return marker !== 'strong';
    return true;
  });
  if (usable.length === 0) return [];

  const texts = [];
  const decor = DECOR[strength];
  for (let index = 0; texts.length < TUNE_PER_CELL && index < TUNE_PER_CELL * usable.length; index += 1) {
    const base = usable[index % usable.length];
    const carrier = decor[Math.floor(index / usable.length) % decor.length];
    const text = filled(carrier, base);
    if ([...text].length < 3) continue; // 任务书 §5：长度 < 3 字的一律丢弃，核心句也别造
    const marker = markerOf(text, markers);
    // 装饰词与基础词的档位必须与目标档一致（strong 优先判，所以 slight 里不许残留 strong 词）
    if (strength === 'medium' && marker !== null) continue;
    if (strength === 'slight' && marker !== 'slight') continue;
    if (strength === 'strong' && marker !== 'strong') continue;
    if (!texts.includes(text)) texts.push(text);
  }
  return texts;
}


function core(spec) {
  return {
    id: '',
    cls: spec.cls,
    family: spec.family,
    kb: spec.kb,
    plan: spec.plan,
    texts: spec.texts,
    rewrite: spec.rewrite !== false,
    adversarial: Boolean(spec.adversarial),
    leakKeys: spec.leakKeys ?? [spec.kb],
  };
}

function buildTuneCores(art) {
  const cores = [];
  for (const dim of art.dims) {
    for (const direction of art.directions) {
      for (const strength of art.strengths) {
        const family = `tune.${dim.id}.${direction}.${strength}`;
        const texts = tuneTextsFor(art, dim.id, direction, strength);
        if (texts.length === 0 && UNEXPRESSIBLE_TUNE_CELLS.includes(family)) continue;
        const plan = tunePlan(art, { target: dim.id, direction, strength });
        texts.forEach((text) => {
          cores.push(core({
            cls: 'tune',
            family,
            kb: kbKeyOfOp(plan.ops[0]),
            plan,
            texts: [text],
          }));
        });
      }
    }
  }
  return cores;
}

// 频段寻址：band1/band2 是 HPF/LPF，只点频率；band3–band7 可点增益与 Q。
const EQ_BAND_FIELDS = Object.freeze({
  1: ['freq'],
  2: ['freq'],
  3: ['gain', 'q'],
  4: ['gain', 'q'],
  5: ['gain', 'q'],
  6: ['gain', 'q'],
  7: ['gain', 'q'],
});

const EQ_CARRIERS = Object.freeze({
  more: {
    slight: ['{}提一点', '把{}抬一点', '{}加一点儿'],
    medium: ['{}提一提', '把{}抬一抬', '{}往上提'],
    strong: ['{}提得特别狠', '把{}抬得非常明显', '{}很需要提'],
  },
  less: {
    slight: ['{}压一点', '把{}收一点', '{}降一点儿'],
    medium: ['{}压一压', '把{}收一收', '{}往下压'],
    strong: ['{}压得特别狠', '把{}削得非常明显', '{}很需要压'],
  },
});

/** 各格用哪个档：三个档轮着覆盖，24 个 (band, field, direction) 摊开三种档位 */
function eqStrengthOf(band, field) {
  const index = (band + (field === 'q' ? 1 : 0)) % 3;
  return ['slight', 'medium', 'strong'][index];
}

function buildEqBandCores(art) {
  const cores = [];
  for (const band of [1, 2, 3, 4, 5, 6, 7]) {
    for (const field of EQ_BAND_FIELDS[band]) {
      for (const direction of ['more', 'less']) {
        const strength = eqStrengthOf(band, field);
        const subject = `${bandZh(band)}${FIELD_ZH[field]}`;
        const carriers = EQ_CARRIERS[direction][strength];
        const text = filled(carriers[band % carriers.length], subject);
        const plan = eqPlan(art, { band, field, direction, strength });
        cores.push(core({
          cls: 'eq',
          family: `eq.band${band}.${field}.${direction}`,
          kb: kbKeyOfOp(plan.ops[0]),
          plan,
          texts: [text],
        }));
      }
    }
  }
  return cores;
}

// 频点寻址：锚点都是"用户会说出口"的形式（含阿拉伯数字，见报告 §偏离说明 D2）
const HZ_ANCHORS = Object.freeze([
  { centerHz: 63, spelling: '63赫兹' },
  { centerHz: 250, spelling: '250赫兹' },
  { centerHz: 1000, spelling: '1000赫兹' },
  { centerHz: 4000, spelling: '4000赫兹' },
  { centerHz: 12500, spelling: '12.5k' },
  { centerHz: 3000, spelling: '3k' },
  { centerHz: 800, spelling: '800赫兹' },
  { centerHz: 200, spelling: '200赫兹' },
]);

const HZ_CARRIERS = Object.freeze({
  more: {
    slight: ['{}附近提一点', '{}这里稍微抬一点', '{}给我加一点儿', '{}那儿稍微提一点儿', '{}这一点点抬一下'],
    medium: ['{}的地方提一提', '把{}抬一抬', '{}这里往上提', '{}那儿抬一抬', '{}给我提一提'],
    strong: ['{}这里特别想提', '{}附近非常需要抬', '{}给我提得特别狠', '{}这儿特别要抬', '{}那里非常想加'],
  },
  less: {
    slight: ['{}附近压一点', '{}这里稍微收一点', '{}给我削一点儿', '{}那儿稍微压一点儿', '{}这一点点收一下'],
    medium: ['{}的地方压一压', '把{}收一收', '{}这里往下压', '{}那儿压一压', '{}给我收一收'],
    strong: ['{}这里特别想削', '{}附近非常需要压', '{}给我压得特别狠', '{}这儿特别要削', '{}那里非常想降'],
  },
});

function buildEqHzCores(art) {
  const cores = [];
  for (const anchor of HZ_ANCHORS) {
    for (const direction of ['more', 'less']) {
      for (const strength of ['slight', 'medium', 'strong']) {
        const carriers = HZ_CARRIERS[direction][strength];
        const texts = carriers.map((carrier) => filled(carrier, anchor.spelling));
        const plan = eqPlan(art, {
          centerHz: anchor.centerHz,
          field: 'gain',
          direction,
          strength,
        });
        cores.push(core({
          cls: 'eq',
          family: `eq.hz${anchor.centerHz}.${direction}.${strength}`,
          kb: kbKeyOfOp(plan.ops[0]),
          plan,
          texts,
          rewrite: false,
        }));
      }
    }
  }
  return cores;
}

function buildToggleCores(art) {
  const cores = [];
  for (const target of art.targets.toggleTargets) {
    for (const on of [true, false]) {
      const entry = art.lexicon.switches.find((item) => item.target === target && item.on === on);
      const words = (entry?.pattern ?? '').split('|').filter(Boolean).slice(0, 2);
      for (const word of words) {
        const plan = togglePlan(art, { target, on });
        cores.push(core({
          cls: 'toggle',
          family: `toggle.${target}.${on ? 'on' : 'off'}`,
          kb: kbKeyOfOp(plan.ops[0]),
          plan,
          texts: [word],
        }));
      }
    }
  }
  return cores;
}

/**
 * 场景 / 音色句：教师改写这类句子很容易把「模式 / 音色」这种护栏词丢掉（丢了就解析不出来，
 * 实测 scene 类的语义一致率只有 ~43%），所以每条核心句自带 5 条模板说法，把条数补足。
 * 五条都满足 `_preset_allowed`：`_skeleton` 剥掉"换成 / 切到 / 我想用 / 切换成 / 帮我换成"
 * 之后正好等于词表说法（`切成` 不在 `_LEAD_FILLERS` 里，不能用）。
 */
function sceneTexts(word) {
  return [`换成${word}`, `切到${word}`, `我想用${word}`, `切换成${word}`, `帮我换成${word}`];
}

function buildSceneCores(art) {
  const cores = [];
  for (const scene of art.scenes) {
    const entry = art.lexicon.scenes.find((item) => item.scene === scene);
    const word = (entry?.pattern ?? '').split('|')[0];
    if (!word) continue;
    const plan = scenePlan(art, { scene });
    cores.push(core({
      cls: 'scene',
      family: `scene.${scene}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: sceneTexts(word),
    }));
  }
  for (const scenario of art.targets.scenarios) {
    const word = scenario.aliases[0];
    if (!word) continue;
    const plan = scenePlan(art, { scene: scenario.baseScene });
    cores.push(core({
      cls: 'scene',
      family: `scenario.${scenario.id}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: sceneTexts(word),
    }));
  }
  for (const tone of art.tones) {
    const entry = art.lexicon.tones.find((item) => item.tone === tone);
    const word = (entry?.pattern ?? '').split('|')[0];
    if (!word) continue;
    const plan = tonePlan(art, { tone });
    cores.push(core({
      cls: 'scene',
      family: `tone.${tone}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: sceneTexts(word),
    }));
  }
  return cores;
}

/**
 * set（显式数值 / 数字接地）：文本必须带阿拉伯数字，`parser._grounded` 才认；
 * 因此这一类**不走教师**（教师被要求不输出数字，改写后必然丢掉接地，见报告 §偏离说明 D2）。
 */
const SET_SPECS = Object.freeze([
  { band: 4, field: 'gain', value: 3 },
  { band: 4, field: 'gain', value: -1.5 },
  { band: 5, field: 'gain', value: 2 },
  { band: 5, field: 'gain', value: 4 },
  { band: 6, field: 'gain', value: -2 },
  { band: 6, field: 'gain', value: 1.5 },
  { band: 7, field: 'gain', value: -3 },
  { band: 7, field: 'gain', value: 2.5 },
  { band: 3, field: 'gain', value: 6 },
  { band: 3, field: 'gain', value: -4 },
  { band: 4, field: 'q', value: 1.5 },
  { band: 5, field: 'q', value: 2 },
  { band: 5, field: 'q', value: 0.8 },
  { band: 6, field: 'q', value: -1 },
  { band: 7, field: 'q', value: 3 },
  { band: 4, field: 'freq', value: 250 },
  { band: 5, field: 'freq', value: 1000 },
  { band: 6, field: 'freq', value: 3500 },
  { band: 7, field: 'freq', value: 12000 },
  { band: 3, field: 'freq', value: 80 },
]);

const SET_CARRIERS = Object.freeze([
  '把{}调到{}',
  '{}调到{}',
  '{}改成{}',
  '{}设成{}',
  '帮我把{}设成{}',
  '{}给到{}',
  '我要{}是{}',
  '{}弄成{}',
  '{}调成{}',
  '麻烦把{}调到{}',
]);

function buildSetCores(art) {
  const cores = [];
  for (const spec of SET_SPECS) {
    const param = `eq.band${spec.band}.${spec.field}`;
    const subject = `${bandZh(spec.band)}${FIELD_ZH[spec.field]}`;
    const texts = SET_CARRIERS.map((carrier) => carrier.replace('{}', subject).replace('{}', String(spec.value)));
    const plan = setPlan(art, { param, value: spec.value, band: spec.band, field: spec.field });
    cores.push(core({
      cls: 'set',
      family: `set.${param}.${spec.value}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts,
      rewrite: false,
    }));
  }
  return cores;
}

/** 范围外（音乐 / 天气 / 闲聊 / 别的硬件）：解析器必须一个都不命中 */
const UNSUPPORTED_TEXTS = Object.freeze([
  '放一首周杰伦的歌',
  '我想听点摇滚',
  '帮我切到下一首歌',
  '暂停一下音乐',
  '今天天气怎么样',
  '明天会下雨吗',
  '现在几点了',
  '给我定个半小时的闹钟',
  '提醒我十点开会',
  '你叫什么名字',
  '你能陪我聊聊天吗',
  '讲个笑话吧',
  '帮我算一下三加五',
  '把这段话翻译成英文',
  '帮我订一份外卖',
  '打开客厅的空调',
  '帮我把窗帘拉上',
  '给手机充上电',
  '把键盘的背光关掉',
  '我的鼠标不太灵敏',
  '打印一份文件',
  '帮我叫一辆车',
  '查一下到公司的路线',
  '给我妈发个消息',
  '拍张照片',
  '录一段视频',
  '帮我写一封邮件',
  '搜索一下附近的餐馆',
  '帮我查一下快递到哪了',
  '帮我把闹钟关了',
  '帮我充个会员',
  '删掉刚才那条记录',
  '关掉这个窗口',
  '重启一下系统',
]);

function buildUnsupportedCores(art) {
  return UNSUPPORTED_TEXTS.map((text, index) => {
    const plan = unsupportedPlan();
    return core({
      cls: 'unsupported',
      family: `unsupported.${String(index + 1).padStart(2, '0')}`,
      kb: 'outofscope:generic:null',
      plan,
      texts: [text],
    });
  });
}

const EXPLAIN_CARRIERS = Object.freeze([
  '{}怎么办',
  '最近总是{}',
  '房间里听到{}',
  '我说话时{}很重',
  '老是{}，很难受',
  '这个{}能消掉吗',
  '{}是不是设备坏了',
  '帮我处理一下{}',
]);

function buildExplainCores(art) {
  const cores = [];
  for (const item of art.targets.explainOnly) {
    EXPLAIN_CARRIERS.forEach((carrier, index) => {
      const word = item.aliases[index % item.aliases.length];
      const plan = explainPlan(art, { id: item.id });
      cores.push(core({
        cls: 'explain',
        family: `explain.${item.id}`,
        kb: `outofscope:${item.id}:null`,
        plan,
        texts: [filled(carrier, word)],
      }));
    });
  }
  return cores;
}

/**
 * 模糊句（该追问，不该猜）：解析器必须一个都不命中。
 * 「帮我调一下」「随便调调」这类是 SubStage 3.3 实测的失败面（LLM 层会硬给一个动作），
 * 所以按 2026-11-24 的指示多放几条"该问不该猜"的句子。
 */
const CLARIFY_TEXTS = Object.freeze([
  '帮我调一下',
  '这个声音不太对',
  '你看着办吧',
  '感觉怪怪的',
  '弄得更好听一点',
  '随便调调',
  '再试试看',
  '好像哪里有点问题',
  '不太行啊',
  '麻烦你了，弄一下',
  '有没有更好的方案',
  '我也不知道该怎么弄',
  '帮我看看哪里不对',
  '整体感觉不太好',
  '你说该怎么弄才好',
  '帮我优化一下吧',
]);

function buildClarifyCores(art) {
  return CLARIFY_TEXTS.map((text, index) => {
    const plan = clarifyPlan();
    return core({
      cls: 'clarify',
      family: `clarify.${String(index + 1).padStart(2, '0')}`,
      kb: 'clarify:generic:null',
      plan,
      texts: [text],
    });
  });
}

/**
 * 对抗样本：多意图 / 否定 / "别…了" / 超长句 / 中英混。
 * 标签仍由 kb 拼出来（多意图取每个 op 的键），不靠教师。
 */
function buildAdversarialCores(art) {
  const cores = [];
  const sideOf = (target) => art.rulesById.get(target).aliasSide;
  const aliasOf = (target, direction) => poolFor(art, target, direction)[0];

  // 1) 多意图（2 个 op）
  const pairs = [
    ['muddiness', 'sibilance'],
    ['brightness', 'lowEnd'],
    ['clarity', 'noiseFloor'],
    ['warmth', 'harshness'],
    ['loudness', 'gate'],
    ['compression', 'limiter'],
    ['muddiness', 'brightness'],
    ['sibilance', 'warmth'],
  ];
  pairs.forEach(([a, b], index) => {
    const ops = [
      { target: a, direction: sideOf(a), strength: index % 2 === 0 ? 'medium' : 'slight' },
      { target: b, direction: sideOf(b), strength: index % 2 === 0 ? 'medium' : 'slight' },
    ];
    const marker = index % 2 === 0 ? '' : '有点';
    const text = `${marker}${aliasOf(a, sideOf(a))}，还有${marker}${aliasOf(b, sideOf(b))}，一起弄一下`;
    const plan = multiPlan(art, ops);
    cores.push(core({
      cls: 'tune',
      family: `adversarial.multi2.${a}.${b}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: [text],
      adversarial: true,
      leakKeys: plan.ops.map(kbKeyOfOp),
    }));
  });

  // 多意图的"单侧双目标"（同一条对话里连着抱怨两件事，语气词不同）
  const loosePairs = [
    ['lowEnd', 'muddiness'],
    ['harshness', 'noiseFloor'],
    ['compression', 'loudness'],
    ['limiter', 'brightness'],
  ];
  loosePairs.forEach(([a, b], index) => {
    const ops = [
      { target: a, direction: sideOf(a), strength: index % 2 === 0 ? 'strong' : 'medium' },
      { target: b, direction: sideOf(b), strength: index % 2 === 0 ? 'strong' : 'medium' },
    ];
    const marker = index % 2 === 0 ? '很' : '';
    const text = `听着${marker}${aliasOf(a, sideOf(a))}，另外还有${aliasOf(b, sideOf(b))}`;
    const plan = multiPlan(art, ops);
    cores.push(core({
      cls: 'tune',
      family: `adversarial.loose2.${a}.${b}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: [text],
      adversarial: true,
      leakKeys: plan.ops.map(kbKeyOfOp),
    }));
  });

  // 2) 多意图（3 个 op）
  const triples = [
    ['muddiness', 'sibilance', 'loudness'],
    ['brightness', 'lowEnd', 'clarity'],
    ['warmth', 'harshness', 'compression'],
    ['muddiness', 'brightness', 'limiter'],
    ['sibilance', 'muddiness', 'noiseFloor'],
    ['gate', 'clarity', 'warmth'],
    ['loudness', 'lowEnd', 'sibilance'],
    ['harshness', 'muddiness', 'loudness'],
    ['lowEnd', 'muddiness', 'harshness'],
    ['clarity', 'sibilance', 'gate'],
    ['limiter', 'loudness', 'muddiness'],
    ['noiseFloor', 'compression', 'brightness'],
  ];
  triples.forEach((ids, index) => {
    const strength = index % 3 === 0 ? 'strong' : 'medium';
    const ops = ids.map((target) => ({ target, direction: sideOf(target), strength }));
    const marker = strength === 'strong' ? '特别' : '';
    const text = `${marker}${aliasOf(ids[0], sideOf(ids[0]))}，${marker}${aliasOf(ids[1], sideOf(ids[1]))}，还有${marker}${aliasOf(ids[2], sideOf(ids[2]))}`;
    const plan = multiPlan(art, ops);
    cores.push(core({
      cls: 'tune',
      family: `adversarial.multi3.${ids.join('.')}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: [text],
      adversarial: true,
      leakKeys: plan.ops.map(kbKeyOfOp),
    }));
  });

  // 3) 否定（"不要那么…"）与 4) "别…了"：极性不变，仍落在词表那一条
  const negTargets = art.dims.map((dim) => dim.id);
  negTargets.forEach((target, index) => {
    const direction = sideOf(target);
    const alias = aliasOf(target, direction);
    const carrier = index % 2 === 0 ? '不要那么{}' : '别那么{}';
    const strength = 'medium';
    const plan = tunePlan(art, { target, direction, strength });
    cores.push(core({
      cls: 'tune',
      family: `adversarial.neg.${target}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: [filled(carrier, alias)],
      adversarial: true,
    }));
  });

  ['brightness', 'warmth', 'muddiness', 'clarity', 'sibilance', 'harshness', 'noiseFloor', 'gate',
    'lowEnd', 'compression', 'limiter']
    .forEach((target, index) => {
      const direction = sideOf(target);
      const alias = aliasOf(target, direction);
      const carrier = index % 2 === 0 ? '别太{}了' : '别再{}了';
      const strength = index % 2 === 0 ? 'strong' : 'medium';
      const plan = tunePlan(art, { target, direction, strength });
      cores.push(core({
        cls: 'tune',
        family: `adversarial.bie.${target}`,
        kb: kbKeyOfOp(plan.ops[0]),
        plan,
        texts: [filled(carrier, alias)],
        adversarial: true,
      }));
    });

  // 5) 超长句
  const longPrefixes = [
    '刚才用手机录了一段在家说话的音频，回放给朋友听了一下',
    '我这边开会的时候同事一直说我声音听起来不舒服',
    '昨天直播的时候有观众在弹幕里提醒我说话的感觉不对',
    '我换了一个新的话筒支架重新摆了一下位置之后',
    '晚上准备录一版有声书，试听的时候发现自己',
  ];
  ['muddiness', 'brightness', 'sibilance', 'warmth', 'clarity'].forEach((target, index) => {
    const direction = sideOf(target);
    const alias = aliasOf(target, direction);
    const prefix = longPrefixes[index % longPrefixes.length];
    const plan = tunePlan(art, { target, direction, strength: 'medium' });
    cores.push(core({
      cls: 'tune',
      family: `adversarial.long.${target}`,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: [`${prefix}，感觉声音${alias}，你帮我调一下`],
      adversarial: true,
    }));
  });

  // 6) 中英混
  const mixedPrefixes = ['emm', 'OK', 'hello', '嗯哼', 'sorry', 'well', 'hi'];
  ['muddiness', 'brightness', 'loudness', 'sibilance', 'lowEnd', 'warmth', 'clarity', 'gate']
    .forEach((target, index) => {
      const direction = sideOf(target);
      const alias = aliasOf(target, direction);
      const prefix = mixedPrefixes[index % mixedPrefixes.length];
      const strength = index % 2 === 0 ? 'slight' : 'medium';
      const marker = index % 2 === 0 ? '有点' : '';
      const plan = tunePlan(art, { target, direction, strength });
      cores.push(core({
        cls: 'tune',
        family: `adversarial.mixed.${target}`,
        kb: kbKeyOfOp(plan.ops[0]),
        plan,
        texts: [`${prefix}，这个声音${marker}${alias}`],
        adversarial: true,
      }));
    });

  // 7) 追加的边界 / 跨类对抗样本。**只能加在这里**：id 按生成顺序编号，
  //    插到前面会让已有 raw.jsonl 里的 coreId 指错核心句。
  const appended = [
    {
      family: 'adversarial.appended.bright-harsh',
      ops: [
        { target: 'brightness', direction: 'more', strength: 'slight' },
        { target: 'harshness', direction: sideOf('harshness'), strength: 'slight' },
      ],
      text: '声音有点亮，还有点刺耳',
    },
    {
      family: 'adversarial.appended.rgb-muddy',
      ops: [
        { target: 'rgbMode', direction: 'more', strength: 'slight' },
        { target: 'muddiness', direction: sideOf('muddiness'), strength: 'slight' },
      ],
      text: '灯效换一换，声音也有点闷',
    },
    {
      family: 'adversarial.appended.low-clarity-sib',
      ops: [
        { target: 'lowEnd', direction: sideOf('lowEnd'), strength: 'medium' },
        // "人声不清楚"是 clarity 的 less 侧说法（非主方向条目排在前面，先命中）
        { target: 'clarity', direction: 'less', strength: 'medium' },
        { target: 'sibilance', direction: sideOf('sibilance'), strength: 'medium' },
      ],
      text: '低音轰，人声不清楚，齿音也重',
    },
    {
      family: 'adversarial.appended.gate-limiter-loud',
      ops: [
        { target: 'gate', direction: sideOf('gate'), strength: 'strong' },
        { target: 'limiter', direction: sideOf('limiter'), strength: 'strong' },
        { target: 'loudness', direction: sideOf('loudness'), strength: 'strong' },
      ],
      text: '气口太多，还老破音，声音太小',
    },
    {
      family: 'adversarial.appended.thin-sib',
      ops: [
        { target: 'warmth', direction: 'less', strength: 'slight' },
        { target: 'sibilance', direction: sideOf('sibilance'), strength: 'slight' },
      ],
      text: '声音有点薄，齿音也重',
    },
    {
      family: 'adversarial.appended.noise-low-clarity',
      ops: [
        { target: 'noiseFloor', direction: sideOf('noiseFloor'), strength: 'medium' },
        { target: 'lowEnd', direction: sideOf('lowEnd'), strength: 'medium' },
        { target: 'clarity', direction: sideOf('clarity'), strength: 'medium' },
      ],
      text: '底噪大，低音也轰，人声不够靠前',
    },
    {
      family: 'adversarial.appended.limiter-muddy',
      ops: [
        { target: 'limiter', direction: sideOf('limiter'), strength: 'medium' },
        { target: 'muddiness', direction: sideOf('muddiness'), strength: 'medium' },
      ],
      text: '一喊就破，声音还闷',
    },
    {
      family: 'adversarial.appended.comp-harsh',
      ops: [
        { target: 'compression', direction: sideOf('compression'), strength: 'medium' },
        { target: 'harshness', direction: sideOf('harshness'), strength: 'medium' },
      ],
      text: '声音忽大忽小，还挺刺耳',
    },
  ];
  for (const item of appended) {
    const plan = multiPlan(art, item.ops);
    cores.push(core({
      cls: 'tune',
      family: item.family,
      kb: kbKeyOfOp(plan.ops[0]),
      plan,
      texts: [item.text],
      adversarial: true,
      leakKeys: plan.ops.map(kbKeyOfOp),
    }));
  }

  return cores;
}

/**
 * 造全部核心句。顺序固定（tune → eq → toggle → scene → set → unsupported → explain → clarify →
 * adversarial），`id` 按该顺序编号，保证两次生成逐字节一致。
 */
export function buildCores(art) {
  const all = [
    ...buildTuneCores(art),
    ...buildEqBandCores(art),
    ...buildEqHzCores(art),
    ...buildToggleCores(art),
    ...buildSceneCores(art),
    ...buildSetCores(art),
    ...buildUnsupportedCores(art),
    ...buildExplainCores(art),
    ...buildClarifyCores(art),
    ...buildAdversarialCores(art),
  ];

  // 同一句核心话可能同时落在两个格子里（例："齿音重一点" 既像 sibilance.more 的中性说法，
  // 又是 sibilance.less 的轻微说法）。这类句子本身有歧义，只保留先出现的那一格。
  const seen = new Map();
  const cores = [];
  for (const item of all) {
    const texts = [];
    for (const text of item.texts) {
      if (seen.has(text)) continue;
      seen.set(text, item.family);
      texts.push(text);
    }
    if (texts.length === 0) continue;
    item.texts = texts;
    cores.push(item);
  }

  const tuneCells = new Map();
  cores.forEach((item, index) => {
    item.id = `c${String(index + 1).padStart(4, '0')}`;
    if (item.cls === 'tune' && item.family.startsWith('tune.')) {
      const key = item.family;
      tuneCells.set(key, (tuneCells.get(key) ?? 0) + item.texts.length);
    }
    const check = validatePlan(item.plan, art, { allowLongSay: item.cls === 'explain' });
    if (!check.ok) throw new Error(`核心句 ${item.id} 的 plan 不合法：${check.errors.join('; ')}`);
  });

  for (const [key, count] of tuneCells) {
    if (UNEXPRESSIBLE_TUNE_CELLS.includes(key)) continue;
    if (count < 3) throw new Error(`tune 格 ${key} 只有 ${count} 条不同表述（任务书 §4.2 要求 ≥3）`);
  }

  return cores;
}


/** 核心句统计：按类别、是否可改写、是否对抗 */
export function coreStats(cores) {
  const byClass = {};
  let rewriteable = 0;
  let templateTexts = 0;
  let adversarial = 0;
  for (const item of cores) {
    byClass[item.cls] = (byClass[item.cls] ?? 0) + 1;
    templateTexts += item.texts.length;
    if (item.rewrite) rewriteable += 1;
    if (item.adversarial) adversarial += 1;
  }
  return {
    cores: cores.length,
    rewriteable,
    templateTexts,
    adversarialCores: adversarial,
    byClass,
  };
}

/** 核心句落盘格式：一行一个（coreId, cls, family, kb, kb keys, plan, texts, rewrite, adversarial） */
export function serializeCores(cores) {
  return cores
    .map((item) => JSON.stringify({
      id: item.id,
      cls: item.cls,
      family: item.family,
      kb: item.kb,
      leakKeys: item.leakKeys,
      plan: item.plan,
      texts: item.texts,
      rewrite: item.rewrite,
      adversarial: item.adversarial,
    }))
    .join('\n') + '\n';
}

export function parseCores(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const item = JSON.parse(line);
      return {
        id: item.id,
        cls: item.cls,
        family: item.family,
        kb: item.kb,
        leakKeys: item.leakKeys ?? [item.kb],
        plan: item.plan,
        texts: item.texts ?? [],
        rewrite: item.rewrite !== false,
        adversarial: Boolean(item.adversarial),
      };
    });
}
