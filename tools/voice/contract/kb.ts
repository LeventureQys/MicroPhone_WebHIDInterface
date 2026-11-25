/**
 * 语音调参助手的**知识本体**（Alpha v1.3.0 / SubStage 3.1）。
 *
 * 唯一真值：本文的 `DIMENSIONS` / `TOGGLE_RULES` / `EQ_DELTAS` / `SCENARIOS` / `BANDS`
 * 同时喂给四个消费面（设计文档 R-11）：
 *
 * | 消费面 | 消费者 | 产物 |
 * |---|---|---|
 * | 运行时映射（语义动作 → 参数写入） | 执行器（Node） | `gen/rules.json` |
 * | 规则解析词表（中文说法 → 语义动作） | `parser.py` | `lexicons/zh.json` |
 * | 训练标签 | SubStage 5.1 | `data/*.jsonl` 的 `plan` 字段 |
 * | 评测期望 | SubStage 5.3 | 评测用例的 `expect` |
 *
 * 因此**不许**在 `lexicons/zh.json`、`rules.ts`、数据生成脚本里再写一份说法或数值；
 * 要加说法就改这里的 `aliases` / `directionWord`，再 `emit.mjs` 重新生成，`emit --check` 会抓漂移。
 *
 * 数值来源：设计文档 §3.4 的两张表（13 维度 × 2 方向 × 3 档）与 `EQ_DELTAS` 表。
 * 表里已经是"相对增量 × 档位系数"之后**乘完的成品**，这里逐格照抄，不做系数乘法——
 * 重算会引入 0.1 级舍入差（例：1.5×3 与表里的 4.5 必须都是字面量 4.5）。
 *
 * 频段锚点：band1–band7 的频点来自 `domain/defaults.ts` 的 `PRODUCT_BAND_FREQS`
 * （50 / 20000 / 63 / 250 / 1000 / 4000 / 12500），band1 是 HPF、band2 是 LPF，
 * **规则表不碰这两段的增益**（设计文档 §3.1.1、SubStage 4.1 §4.1）。
 */

import { PRODUCT_BAND_FREQS } from '../../../src/renderer/src/domain/defaults';
import { EQ_PRESETS } from '../../../src/renderer/src/domain/quick-controls';
import { SCENES } from '../../../src/renderer/src/domain/scenes';

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

/** 幅度档位（设计文档 §3.4：slight=1、medium=2、strong=3，但表里给的是成品数值） */
export type Strength = 'slight' | 'medium' | 'strong';
export const STRENGTHS: readonly Strength[] = Object.freeze(['slight', 'medium', 'strong']);

/** 方向：描述**用户感知属性**的强弱，不是参数值的方向（设计文档 §3.1.1） */
export type Direction = 'more' | 'less';
export const DIRECTIONS: readonly Direction[] = Object.freeze(['more', 'less']);

/** EQ 段字段。L1 的 `eq.field` 只有前三项；`type` 只出现在规则动作里 */
export type EqField = 'type' | 'freq' | 'gain' | 'q';

/** 13 个可调语义维度（设计文档 §3.1） */
export const TUNE_TARGET_IDS = [
  'brightness',
  'warmth',
  'lowEnd',
  'muddiness',
  'clarity',
  'sibilance',
  'harshness',
  'noiseFloor',
  'compression',
  'loudness',
  'gate',
  'limiter',
  'rgbMode',
] as const;
export type TuneTarget = (typeof TUNE_TARGET_IDS)[number];

/** 7 个可开关目标（设计文档 §3.1） */
export const TOGGLE_TARGET_IDS = [
  'noiseFloor',
  'gate',
  'limiter',
  'compression',
  'rgbMode',
  'mute',
  'monitor',
] as const;
export type ToggleTarget = (typeof TOGGLE_TARGET_IDS)[number];

/** 规则动作（设计文档 §3.4；字段名与 SubStage 4.1 的 `RuleAction` 一致） */
export type RuleAction =
  | { readonly kind: 'param'; readonly id: string; readonly delta: number }
  | { readonly kind: 'band'; readonly band: number; readonly field: EqField; readonly delta: number }
  | { readonly kind: 'paramSet'; readonly id: string; readonly value: number }
  | { readonly kind: 'bandSet'; readonly band: number; readonly field: EqField; readonly value: number };

/** 三档动作表 */
export type RulesByStrength = Readonly<Record<Strength, readonly RuleAction[]>>;

export interface KbDimension {
  readonly id: TuneTarget;
  /** 中文名，用于 preview 与 say 模板（SubStage 3.2 的播报文案） */
  readonly nameZh: string;
  /** 说法种子；进 `lexicons/zh.json` 的 `entries`（同一个 `|` 拼接） */
  readonly aliases: readonly string[];
  /** 方向词：`more` 侧与 `less` 侧各自的说法，进词表时与 `aliases` 合并 */
  readonly directionWord: { readonly more: readonly string[]; readonly less: readonly string[] };
  /** 允许改写的 paramId（由 `rules` / `TOGGLE_RULES` / `CONDITIONAL_ACTIONS` 自动派生） */
  readonly writable: readonly string[];
  readonly rules: { readonly more: RulesByStrength; readonly less: RulesByStrength };
  /** 命中但不可执行时的解释（本版 13 个维度都可执行，保留字段给词表扩展） */
  readonly explain?: string;
}

/** 频段寻址锚点（`eq` 动作按 centerHz 就近映射到 band） */
export interface KbBand {
  readonly band: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly centerHz: number;
  readonly kind: 'hpf' | 'lpf' | 'peak';
}

/** 场景映射：8 种用户说法 → 内置 5 场景 + 额外补丁（设计文档 §3.1） */
export type ScenarioId = 'live' | 'meeting' | 'sing' | 'game' | 'podcast' | 'record' | 'dub' | 'asmr';
export type SceneId = (typeof SCENES)[number]['id'];

export interface KbScenario {
  readonly id: ScenarioId;
  readonly nameZh: string;
  readonly aliases: readonly string[];
  /** 映射到内置场景；整包写入由 SubStage 4.1 的 `scenePatch()` 完成 */
  readonly baseScene: SceneId;
  /** 额外补丁（可为空） */
  readonly patch: readonly RuleAction[];
}

/** 只识别、不执行的维度（设计文档 §3.1 末段：回 `unsupported` + 一句解释，不写参数） */
export interface KbExplainOnly {
  readonly id: string;
  readonly nameZh: string;
  readonly aliases: readonly string[];
  readonly explain: string;
}

/** 条件动作：规则格表达不了的"到某个端点再顺手关掉"（设计文档 §3.4 表内括注） */
export interface KbConditional {
  readonly target: TuneTarget;
  readonly direction: Direction;
  readonly when: { readonly id: string; readonly atOrBelow: number };
  readonly then: readonly RuleAction[];
}

// ---------------------------------------------------------------------------
// 动作构造 helper（数字一律字面量，见文件头的"不做系数乘法"）
// ---------------------------------------------------------------------------

function bandGain(band: number, delta: number): RuleAction {
  return { kind: 'band', band, field: 'gain', delta };
}

function paramDelta(id: string, delta: number): RuleAction {
  return { kind: 'param', id, delta };
}

function paramSet(id: string, value: number): RuleAction {
  return { kind: 'paramSet', id, value };
}

type Triple = readonly [number, number, number];

/** 每段一个三档增量：`[[7,[1.5,3,5]],[6,[1,2,3]]]` = 段 7 增益 +1.5/+3/+5、段 6 增益 +1/+2/+3 */
function gainRules(pairs: ReadonlyArray<readonly [number, Triple]>): RulesByStrength {
  const build = (index: 0 | 1 | 2): RuleAction[] =>
    pairs.map(([band, deltas]) => bandGain(band, deltas[index]));
  return { slight: build(0), medium: build(1), strong: build(2) };
}

/** 单参数增量，可附加固定动作（`enc.OnOff=1` 这类"顺手打开"） */
function paramRules(id: string, deltas: Triple, extra: readonly RuleAction[] = []): RulesByStrength {
  const build = (index: 0 | 1 | 2): RuleAction[] => [paramDelta(id, deltas[index]), ...extra];
  return { slight: build(0), medium: build(1), strong: build(2) };
}

/** 两个参数同时增量（compression：Threshold 与 Rate 一起动） */
function twoParamRules(a: readonly [string, Triple], b: readonly [string, Triple]): RulesByStrength {
  const build = (index: 0 | 1 | 2): RuleAction[] => [
    paramDelta(a[0], a[1][index]),
    paramDelta(b[0], b[1][index]),
  ];
  return { slight: build(0), medium: build(1), strong: build(2) };
}

// ---------------------------------------------------------------------------
// 开关规则（设计文档 §3.4 "开关（toggle）"表，7 行逐行照抄）
// ---------------------------------------------------------------------------

export const TOGGLE_RULES: Readonly<
  Record<ToggleTarget, { readonly on: readonly RuleAction[]; readonly off: readonly RuleAction[] }>
> = Object.freeze({
  noiseFloor: Object.freeze({ on: [paramSet('enc.OnOff', 1)], off: [paramSet('enc.OnOff', 0)] }),
  gate: Object.freeze({ on: [paramSet('noisegate.Enable', 1)], off: [paramSet('noisegate.Enable', 0)] }),
  limiter: Object.freeze({ on: [paramSet('limit.Enable', 1)], off: [paramSet('limit.Enable', 0)] }),
  compression: Object.freeze({ on: [paramSet('comp.Enable', 1)], off: [paramSet('comp.Enable', 0)] }),
  rgbMode: Object.freeze({ on: [paramSet('rgb.OnOff', 1)], off: [paramSet('rgb.OnOff', 0)] }),
  mute: Object.freeze({ on: [paramSet('mic.mute', 1)], off: [paramSet('mic.mute', 0)] }),
  monitor: Object.freeze({ on: [paramSet('hp.OnOff', 1)], off: [paramSet('hp.OnOff', 0)] }),
});

// ---------------------------------------------------------------------------
// 条件动作（设计文档 §3.4 表内两处括注：RuleAction 表达不了"到端点再关"）
// ---------------------------------------------------------------------------

export const CONDITIONAL_ACTIONS: readonly KbConditional[] = Object.freeze([
  Object.freeze({
    target: 'noiseFloor' as const,
    direction: 'more' as const,
    // 「`enc.Level` −1/−2/−3（夹紧 0..3），到 0 时同时 `enc.OnOff=0`」
    when: Object.freeze({ id: 'enc.Level', atOrBelow: 0 }),
    then: Object.freeze([paramSet('enc.OnOff', 0)]),
  }),
  Object.freeze({
    target: 'gate' as const,
    direction: 'less' as const,
    // 「同值 −3/−6/−9 dB（更松），到 −91 时 `noisegate.Enable=0`」
    when: Object.freeze({ id: 'noisegate.threshold_db', atOrBelow: -91 }),
    then: Object.freeze([paramSet('noisegate.Enable', 0)]),
  }),
]);

// ---------------------------------------------------------------------------
// 13 个维度（设计文档 §3.1 的顺序 + §3.4 的数值表）
// ---------------------------------------------------------------------------

/**
 * `aliases` 里的说法落在哪个方向。
 *
 * 为什么需要这张表：同一个词在不同方向上都成立（"闷" 可以说成"更闷"也可以说成"太闷了"），
 * 而词表条目是 `(pattern, target, direction)` 三元组。约定是：**`aliases` 描述用户抱怨的
 * 那个状态，方向取"能把它修好的那一侧"**（"有点闷" → `muddiness.less`，"声音太薄了" →
 * `warmth.more`）；要表达相反意图得用 `directionWord` 里的说法（"再闷一点" → `muddiness.more`）。
 * `emit.mjs` 据此生成词表：非主方向的 `directionWord` 单独成条并排在前面，
 * 这样"闷一点"不会被"闷"抢先命中。
 */
export const ALIAS_SIDE: Readonly<Record<TuneTarget, Direction>> = Object.freeze({
  brightness: 'more',
  warmth: 'more',
  lowEnd: 'more',
  muddiness: 'less',
  clarity: 'more',
  sibilance: 'less',
  harshness: 'less',
  noiseFloor: 'less',
  compression: 'more',
  loudness: 'more',
  gate: 'less',
  limiter: 'more',
  rgbMode: 'more',
});

const DIMENSION_SEEDS: readonly Omit<KbDimension, 'writable'>[] = [
  {
    id: 'brightness',
    nameZh: '明亮度',
    aliases: [
      '亮',
      '明亮',
      '清亮',
      '通透',
      '发亮',
      '亮堂',
      '声音发亮',
      '高音多',
      '不够亮',
      '听着清亮',
    ],
    directionWord: {
      more: ['再亮一点', '亮一些', '提亮一点', '多一点高频', '亮起来'],
      less: ['暗', '发暗', '变暗', '压暗一点', '高音少', '没有光泽', '声音发暗'],
    },
    rules: {
      // band7.gain +1.5/+3/+5；band6.gain +1/+2/+3
      more: gainRules([
        [7, [1.5, 3, 5]],
        [6, [1, 2, 3]],
      ]),
      // band7.gain −1.5/−3/−5；band6.gain −1/−2/−3
      less: gainRules([
        [7, [-1.5, -3, -5]],
        [6, [-1, -2, -3]],
      ]),
    },
  },
  {
    id: 'warmth',
    nameZh: '温暖度',
    aliases: ['暖', '温暖', '厚', '厚实', '圆润', '饱满', '醇厚', '有厚度', '声音发暖', '不够厚'],
    directionWord: {
      more: ['再暖一点', '暖一些', '厚一点', '加一点厚度', '暖和点'],
      less: ['冷', '发冷', '薄', '单薄', '干', '干瘪', '声音太薄了', '声音发干', '太冷了'],
    },
    rules: {
      // band3.gain +1.5/+3/+4.5；band7.gain −1/−2/−3
      more: gainRules([
        [3, [1.5, 3, 4.5]],
        [7, [-1, -2, -3]],
      ]),
      // band3.gain −1.5/−3/−4.5；band7.gain +1/+2/+3
      less: gainRules([
        [3, [-1.5, -3, -4.5]],
        [7, [1, 2, 3]],
      ]),
    },
  },
  {
    id: 'lowEnd',
    nameZh: '低频量感',
    aliases: ['低音', '低频', '重低音', '下潜', '轰', '发轰', '低频足', '低音多', '隆隆的', '低音轰隆'],
    directionWord: {
      more: ['再加点低音', '低音多一点', '低频再足一点', '轰鸣一点'],
      less: ['低音少', '低频少', '不够低', '把低音收一收', '别那么轰'],
    },
    rules: {
      // band3.gain +2/+4/+6
      more: gainRules([[3, [2, 4, 6]]]),
      // band3.gain −2/−4/−6
      less: gainRules([[3, [-2, -4, -6]]]),
    },
  },
  {
    id: 'muddiness',
    nameZh: '浑浊',
    aliases: [
      '闷',
      '浑浊',
      '浑',
      '糊',
      '箱音',
      '鼻音',
      '有点闷',
      '听着发糊',
      '蒙了一层',
      '堵得慌',
      '声音发闷',
      '闷得慌',
    ],
    directionWord: {
      more: ['更闷', '再闷一点', '闷一点', '糊一点', '浑一点', '加点箱音'],
      less: ['把闷的收一收', '化开一点', '去掉箱音', '把浑浊收一收', '别闷在里面'],
    },
    rules: {
      // band4.gain +1.5/+3/+4.5；band7.gain −1/−2/−3
      more: gainRules([
        [4, [1.5, 3, 4.5]],
        [7, [-1, -2, -3]],
      ]),
      // band4.gain −1.5/−3/−4.5；band7.gain +1/+2/+3
      less: gainRules([
        [4, [-1.5, -3, -4.5]],
        [7, [1, 2, 3]],
      ]),
    },
  },
  {
    id: 'clarity',
    nameZh: '清晰度',
    aliases: [
      '清楚',
      '清晰',
      '人声突出',
      '靠前',
      '解析力',
      '声音清楚',
      '听得清',
      '扎实',
      '声音不虚',
      '人声不够靠前',
    ],
    directionWord: {
      more: ['再清楚一点', '清楚一点', '人声靠前', '多一点清晰度', '声音再实一点'],
      less: ['发虚', '不清楚', '人声太靠后', '细节不够', '声音不实'],
    },
    rules: {
      // band5.gain +1/+2/+3；band6.gain +1/+1.5/+2
      more: gainRules([
        [5, [1, 2, 3]],
        [6, [1, 1.5, 2]],
      ]),
      // band5.gain −1/−2/−3；band6.gain −1/−1.5/−2
      less: gainRules([
        [5, [-1, -2, -3]],
        [6, [-1, -1.5, -2]],
      ]),
    },
  },
  {
    id: 'sibilance',
    nameZh: '齿音',
    aliases: [
      '齿音',
      '尖',
      'si音',
      '嘶',
      '齿音重',
      '太尖了',
      '刺啦声',
      '嘶嘶声',
      '齿音太多',
      '高频刺',
      // 裸"刺"不能加：harshness 的「刺耳 / 毛刺 / 刺刺的」会被本维度先命中，
      // 3.2 自检第 7 条（"有点刺耳" 只出 harshness）与第 35 条会直接退化。
      // 所以补的是带"刺"但不与 harshness 说法重叠的整句形态；「又刺」负责接住"又闷又刺"。
      '有刺',
      '刺得慌',
      '刺一下',
      '又刺',
      // ASR 同音错例（SubStage 2.2 实测："齿音"被听成"齿因"），不补会整句掉到 LLM 兜底
      '齿因',
    ],
    directionWord: {
      more: ['齿音重一点', '再刺一点', '高音再加一点', '齿音再多点'],
      less: ['齿音压一压', '别那么尖', '收一点齿音', '把嘶声去掉'],
    },
    rules: {
      // band7.gain +1.5/+3/+5；band6.gain +1/+1.5/+2
      more: gainRules([
        [7, [1.5, 3, 5]],
        [6, [1, 1.5, 2]],
      ]),
      // band7.gain −1.5/−3/−5；band6.gain −1/−1.5/−2
      less: gainRules([
        [7, [-1.5, -3, -5]],
        [6, [-1, -1.5, -2]],
      ]),
    },
  },
  {
    id: 'harshness',
    nameZh: '毛刺',
    aliases: [
      '毛刺',
      '刺耳',
      '扎耳朵',
      '刮',
      '发硬',
      '刺刺的',
      '太扎耳',
      '声音扎耳朵',
      '刺耳难受',
      '毛刺感重',
    ],
    directionWord: {
      more: ['毛刺多一点', '再刺耳一点', '更硬一点'],
      less: ['柔一点', '别那么刺', '软化一下', '把毛刺削掉', '听着不扎耳'],
    },
    rules: {
      // band6.gain +1.5/+3/+4.5；band5.gain +0.5/+1/+1.5
      more: gainRules([
        [6, [1.5, 3, 4.5]],
        [5, [0.5, 1, 1.5]],
      ]),
      // band6.gain −1.5/−3/−4.5；band5.gain −0.5/−1/−1.5
      less: gainRules([
        [6, [-1.5, -3, -4.5]],
        [5, [-0.5, -1, -1.5]],
      ]),
    },
  },
  {
    id: 'noiseFloor',
    nameZh: '底噪',
    aliases: [
      '底噪',
      '噪音',
      '噪声',
      '呼呼声',
      '环境声',
      '底噪大',
      '背景噪音',
      '沙沙声',
      '噪声大',
      '底噪明显',
    ],
    directionWord: {
      more: ['底噪多一点', '别降那么狠', '降噪弱一点', '让环境声进来'],
      less: ['降噪强一点', '把底噪压下去', '安静一点', '噪音小一点', '降噪开大'],
    },
    rules: {
      // enc.Level −1/−2/−3（夹紧 0..3），到 0 时同时 enc.OnOff=0 → 见 CONDITIONAL_ACTIONS
      more: paramRules('enc.Level', [-1, -2, -3]),
      // enc.Level +1/+2/+3（夹紧 0..3），同时 enc.OnOff=1
      less: paramRules('enc.Level', [1, 2, 3], [paramSet('enc.OnOff', 1)]),
    },
  },
  {
    id: 'compression',
    nameZh: '压缩强度',
    aliases: [
      '压缩',
      '忽大忽小',
      '声音不稳',
      '太平',
      '压得死',
      '动态小',
      '忽高忽低',
      '音量不稳',
      '被压扁了',
      '没起伏',
    ],
    directionWord: {
      more: ['压缩重一点', '再压一点', '压得更平', '动态再小一点'],
      less: ['压缩轻一点', '别压那么狠', '动态大一点', '别压得太死', '起伏多一点'],
    },
    rules: {
      // comp.Threshold −3/−6/−10 dB；comp.Rate +1/+2/+3
      more: twoParamRules(
        ['comp.Threshold', [-3, -6, -10]],
        ['comp.Rate', [1, 2, 3]],
      ),
      // comp.Threshold +3/+6/+10 dB；comp.Rate −1/−2/−3
      less: twoParamRules(
        ['comp.Threshold', [3, 6, 10]],
        ['comp.Rate', [-1, -2, -3]],
      ),
    },
  },
  {
    id: 'loudness',
    nameZh: '响度',
    aliases: [
      '声音小',
      '大声',
      '音量',
      '响度',
      '听不清',
      '太小了',
      '声音大',
      '音量高',
      '声音太轻',
      '不够响',
      // "有点 / 太" 插在中间会打断「声音小 / 声音大」，这两类必须补成整句说法（SubStage 3.2 实测缺口）
      '声音有点小',
      '声音太小',
      '声音太小了',
      '音量有点小',
    ],
    directionWord: {
      more: ['响一点', '大声一点', '音量提一点', '再响一点', '声音大一点'],
      // 抱怨"太响"是要往小调，所以落在 less 侧（emit 对非主方向先出条目，先命中）
      less: [
        '声音小一点',
        '轻一点',
        '音量降一点',
        '别那么大声',
        '小声点',
        '声音有点大',
        '声音太大',
        '声音太大了',
        '音量有点大',
      ],
    },
    rules: {
      // comp.MakeUpGain +1.5/+3/+6 dB
      more: paramRules('comp.MakeUpGain', [1.5, 3, 6]),
      // comp.MakeUpGain −1.5/−3/−6 dB
      less: paramRules('comp.MakeUpGain', [-1.5, -3, -6]),
    },
  },
  {
    id: 'gate',
    nameZh: '噪声门',
    aliases: [
      '气口',
      '呼吸声',
      '杂音',
      '断断续续',
      '吞字',
      '说话断续',
      '气声太多',
      '字被吃掉',
      '尾音没了',
      '一顿一顿',
    ],
    directionWord: {
      more: ['门严一点', '切得狠一点', '弱声切掉', '门限高一点'],
      less: ['门松一点', '别切那么狠', '保留气口', '门限低一点', '让我小声也能过'],
    },
    rules: {
      // noisegate.threshold_db +3/+6/+9 dB（更严）
      more: paramRules('noisegate.threshold_db', [3, 6, 9]),
      // 同值 −3/−6/−9 dB（更松），到 −91 时 noisegate.Enable=0 → 见 CONDITIONAL_ACTIONS
      less: paramRules('noisegate.threshold_db', [-3, -6, -9]),
    },
  },
  {
    id: 'limiter',
    nameZh: '防爆音',
    aliases: [
      '爆音',
      '破音',
      '削顶',
      '过载',
      '声音炸了',
      '一喊就破',
      '爆了',
      '失真',
      '噼啪声',
      '炸麦',
    ],
    directionWord: {
      more: ['防爆音强一点', '保护多一点', '别爆'],
      less: ['防爆音弱一点', '保护少一点', '别削那么狠'],
    },
    rules: {
      // limit.Threshold −1/−2/−3 dB（更早限幅）
      more: paramRules('limit.Threshold', [-1, -2, -3]),
      // limit.Threshold +1/+2/+3 dB
      less: paramRules('limit.Threshold', [1, 2, 3]),
    },
  },
  {
    id: 'rgbMode',
    nameZh: '灯效模式',
    aliases: ['灯效', '灯', '颜色', '氛围灯', '灯的颜色', '灯光', '换灯效', '灯效模式', '灯光模式', '彩灯'],
    directionWord: {
      // `rgb.Mode` 循环 ±1/±2/±3（0..7 取模）：取模由 SubStage 4.1 的 canonicalize 做
      more: ['灯效下一个', '换个颜色', '切下一个灯效', '灯效换一换'],
      less: ['灯效上一个', '上一个颜色', '切回上一个灯效', '退一个灯效'],
    },
    rules: {
      more: paramRules('rgb.Mode', [1, 2, 3]),
      less: paramRules('rgb.Mode', [-1, -2, -3]),
    },
  },
];

/** 动作涉及的 paramId（band 类动作折算成 `eq.bandN.<field>`） */
export function paramIdOfAction(action: RuleAction): string {
  if (action.kind === 'param' || action.kind === 'paramSet') return action.id;
  return `eq.band${action.band}.${action.field}`;
}

/**
 * 派生 `writable`：该维度在**任何方向任何档位**真正会写的 paramId，
 * 加上它的开关动作与条件动作。手写这张表必然与 `rules` 漂移，所以一律算出来。
 */
function deriveWritable(dimension: Omit<KbDimension, 'writable'>): readonly string[] {
  const ids = new Set<string>();
  for (const direction of DIRECTIONS) {
    for (const strength of STRENGTHS) {
      for (const action of dimension.rules[direction][strength]) ids.add(paramIdOfAction(action));
    }
  }
  const toggle = TOGGLE_RULES[dimension.id as ToggleTarget];
  if (toggle) {
    for (const action of [...toggle.on, ...toggle.off]) ids.add(paramIdOfAction(action));
  }
  for (const conditional of CONDITIONAL_ACTIONS) {
    if (conditional.target !== dimension.id) continue;
    for (const action of conditional.then) ids.add(paramIdOfAction(action));
  }
  return Object.freeze([...ids].sort());
}

/** 13 个语义维度，顺序即设计文档 §3.1 / §3.4 的表序 */
export const DIMENSIONS: readonly KbDimension[] = Object.freeze(
  DIMENSION_SEEDS.map((seed) => Object.freeze({ ...seed, writable: deriveWritable(seed) })),
);

// ---------------------------------------------------------------------------
// 只识别、不执行（设计文档 §3.1 末段）
// ---------------------------------------------------------------------------

export const EXPLAIN_ONLY: readonly KbExplainOnly[] = Object.freeze([
  Object.freeze({
    id: 'echo',
    nameZh: '回音',
    aliases: ['回音', '有回声', '像在桶里', '房间太空', '声音空', '回荡'],
    explain: '这是房间声学问题，调 EQ 只会更糟：建议加吸音或靠近麦说话',
  }),
  Object.freeze({
    id: 'plosive',
    nameZh: '喷麦',
    aliases: ['喷麦', 'p音爆', '噗噗声', '扑扑声', '口水音'],
    explain: '这是离麦太近与气流：建议加防喷罩或偏 30 度说话',
  }),
  Object.freeze({
    id: 'hum',
    nameZh: '电流声',
    aliases: ['电流声', '嗡嗡', '50赫兹哼声', '嗡声', '低频哼声'],
    explain: '这是接地/电源干扰：先换 USB 口或加地环路隔离',
  }),
  Object.freeze({
    id: 'bgm',
    nameZh: '背景音乐',
    aliases: ['背景音乐串', '耳机漏音', '串音', '听到音乐', '伴奏串进来'],
    explain: '这是串音：建议戴封闭式耳机并把音量降下来',
  }),
]);

// ---------------------------------------------------------------------------
// 场景映射（设计文档 §3.1 的 8 行表）
// ---------------------------------------------------------------------------

/** 内置场景 id（顺序与界面一致），由 `domain/scenes.ts` 派生 */
export const SCENE_IDS: readonly SceneId[] = Object.freeze(SCENES.map((scene) => scene.id));

/** 固定音色 id（`custom` 没有固定曲线，由用户自己拖） */
export const TONE_IDS: readonly string[] = Object.freeze([...Object.keys(EQ_PRESETS), 'custom']);

export const SCENARIOS: readonly KbScenario[] = Object.freeze([
  Object.freeze({
    id: 'live',
    nameZh: '直播',
    aliases: ['直播', '带货', '直播带货', '开直播'],
    baseScene: 'podcast',
    // 直播要压噪：降噪 +1 档、门限 +3 dB
    patch: Object.freeze([paramDelta('enc.Level', 1), paramDelta('noisegate.threshold_db', 3)]),
  }),
  Object.freeze({
    id: 'meeting',
    nameZh: '会议',
    aliases: ['会议', '开会', '网课', '上课'],
    baseScene: 'podcast',
    // 不额外压噪，避免切字
    patch: Object.freeze([]),
  }),
  Object.freeze({
    id: 'sing',
    nameZh: '唱歌',
    aliases: ['唱歌', 'k歌', '录歌'],
    baseScene: 'sing',
    patch: Object.freeze([]),
  }),
  Object.freeze({
    id: 'game',
    nameZh: '游戏',
    aliases: ['游戏', '开黑', '打游戏', '战队语音'],
    baseScene: 'game',
    patch: Object.freeze([]),
  }),
  Object.freeze({
    id: 'podcast',
    nameZh: '播客',
    aliases: ['播客', '录播客', '访谈'],
    baseScene: 'podcast',
    patch: Object.freeze([]),
  }),
  Object.freeze({
    id: 'record',
    nameZh: '录课',
    aliases: ['录课', '试音', '录音'],
    baseScene: 'quiet',
    // 要原声：降噪关掉
    patch: Object.freeze([paramSet('enc.OnOff', 0)]),
  }),
  Object.freeze({
    id: 'dub',
    nameZh: '配音',
    aliases: ['配音', '旁白', '有声书'],
    baseScene: 'podcast',
    // 低频 +1.5 dB（band3）
    patch: Object.freeze([bandGain(3, 1.5)]),
  }),
  Object.freeze({
    id: 'asmr',
    nameZh: 'ASMR',
    aliases: ['asmr', '轻声', '耳语'],
    baseScene: 'quiet',
    // 别切气声：门限 −6 dB
    patch: Object.freeze([paramDelta('noisegate.threshold_db', -6)]),
  }),
]);

// ---------------------------------------------------------------------------
// 开关 / 场景 / 音色的说法（`lexicons/zh.json` 的 `switches` / `scenes` / `tones`）
// ---------------------------------------------------------------------------

/** 7 个开关目标的正反说法（每侧 ≥ 2 条，含"打开/关掉"这类动词，SubStage 3.2 按此判 toggle） */
export const SWITCH_WORDS: Readonly<
  Record<ToggleTarget, { readonly on: readonly string[]; readonly off: readonly string[] }>
> = Object.freeze({
  noiseFloor: Object.freeze({
    on: ['打开降噪', '开降噪', '启用降噪'],
    off: ['关掉降噪', '关闭降噪', '关降噪', '不要降噪'],
  }),
  gate: Object.freeze({
    on: ['打开噪声门', '开噪声门'],
    off: ['关掉噪声门', '关噪声门'],
  }),
  limiter: Object.freeze({
    on: ['打开防爆音', '开防爆音', '开限幅'],
    off: ['关掉防爆音', '关防爆音', '关限幅'],
  }),
  compression: Object.freeze({
    on: ['打开压缩', '开压缩'],
    off: ['关掉压缩', '关压缩'],
  }),
  rgbMode: Object.freeze({
    on: ['打开灯效', '开灯效', '把灯打开'],
    off: ['关闭灯效', '关灯效', '把灯关掉'],
  }),
  mute: Object.freeze({
    // "麦克风"是用户最常用的说法（"关闭麦克风"原来只靠"闭麦"子串侥幸命中，3.2 实测「麦克风关掉」未命中）
    on: ['静音', '闭麦', '关麦', '别收音了', '关麦克风', '关闭麦克风', '把麦克风关掉', '麦克风关掉'],
    off: ['取消静音', '开麦', '解除静音'],
  }),
  monitor: Object.freeze({
    on: ['打开监听', '开监听'],
    off: ['关掉监听', '关监听', '不要监听'],
  }),
});

/** 5 个内置场景的说法（`scenes` 条目） */
export const SCENE_WORDS: Readonly<Record<SceneId, readonly string[]>> = Object.freeze({
  quiet: ['安静房间', '安静模式'],
  game: ['游戏模式', '打游戏'],
  podcast: ['播客模式', '录播客'],
  sing: ['唱歌模式', '唱歌'],
  custom: ['自定义模式'],
});

/** 5 个音色的说法（`tones` 条目；`custom` 也收，否则"自定义音色"落不进来） */
export const TONE_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  flat: ['原声', '原声模式'],
  vocal: ['人声增强', '人声模式'],
  warm: ['温暖模式', '温暖音色'],
  bright: ['明亮模式', '明亮音色'],
  custom: ['自定义音色', '自定义模式'],
});

// ---------------------------------------------------------------------------
// 频段寻址（设计文档 §3.1.1 / §3.4 末段）
// ---------------------------------------------------------------------------

/** band1 = HPF 50 Hz、band2 = LPF 20 kHz，其余是 5 个可调峰段 */
function bandKind(index: number): KbBand['kind'] {
  if (index === 0) return 'hpf';
  if (index === 1) return 'lpf';
  return 'peak';
}

export const BANDS: readonly KbBand[] = Object.freeze(
  PRODUCT_BAND_FREQS.map((centerHz, index) =>
    Object.freeze({ band: (index + 1) as KbBand['band'], centerHz, kind: bandKind(index) }),
  ),
);

/**
 * `EQ_DELTAS`：`eq` 动作作用在**用户点名的那一段**上时的增量
 * （设计文档 §3.4 的 `gain` / `q` / `freq` 三行）。
 *
 * `band: 0` 是占位符：由 SubStage 4.1 的 canonicalize 换成用户点名的段号
 * （`EQ_DELTA_BAND_PLACEHOLDER`）。`freqPct` 的 delta 是**百分比**（+10 表示 +10%），
 * 因此字段名用 `freq`、单位是"相对当前值的百分比"，不是 Hz。
 */
export const EQ_DELTA_BAND_PLACEHOLDER = 0;

function eqDeltaRules(field: EqField, deltas: Triple): RulesByStrength {
  const build = (index: 0 | 1 | 2): RuleAction[] => [
    { kind: 'band', band: EQ_DELTA_BAND_PLACEHOLDER, field, delta: deltas[index] },
  ];
  return { slight: build(0), medium: build(1), strong: build(2) };
}

/** `EQ_DELTAS` 的形状：字段 → 方向 → 三档（`EQ_DELTAS[field][direction][strength]`） */
export interface EqDeltaTable {
  readonly gain: Readonly<Record<Direction, RulesByStrength>>;
  readonly q: Readonly<Record<Direction, RulesByStrength>>;
  readonly freqPct: Readonly<Record<Direction, RulesByStrength>>;
}

export const EQ_DELTAS: EqDeltaTable = Object.freeze({
  // gain：+1/+2/+3 dB，反向 −1/−2/−3 dB
  gain: Object.freeze({
    more: eqDeltaRules('gain', [1, 2, 3]),
    less: eqDeltaRules('gain', [-1, -2, -3]),
  }),
  // q：+0.5/+1/+2（夹紧 0.1..12），反向 −0.5/−1/−2
  q: Object.freeze({
    more: eqDeltaRules('q', [0.5, 1, 2]),
    less: eqDeltaRules('q', [-0.5, -1, -2]),
  }),
  // freq：+10%/+20%/+30%（相对当前值，夹紧 20..20000 Hz），反向 −10%/−20%/−30%
  freqPct: Object.freeze({
    more: eqDeltaRules('freq', [10, 20, 30]),
    less: eqDeltaRules('freq', [-10, -20, -30]),
  }),
});

// ---------------------------------------------------------------------------
// 单轮上限、档位词、唤醒词、控制词、两类数字正则
// ---------------------------------------------------------------------------

/** 单轮总量上限（设计文档 §3.4 末段）：超出按上限截断并在 preview 里标 clamped */
export const TURN_CAPS: { readonly eqGainDb: number; readonly encLevel: number; readonly makeUpGainDb: number } =
  Object.freeze({ eqGainDb: 6, encLevel: 3, makeUpGainDb: 6 });

/** 档位词（进 `lexicons/zh.json` 的 `strengthWords`；缺省是 medium） */
export const STRENGTH_WORDS: { readonly slight: readonly string[]; readonly strong: readonly string[] } =
  Object.freeze({
    slight: Object.freeze(['一点', '稍微', '有点儿', '略微', '小一点']),
    strong: Object.freeze(['很', '特别', '非常', '太', '超']),
  });

/**
 * 唤醒词前缀（SubStage 3.2 的 `parse` 先剔除句首命中项；它按长度倒序匹配，顺序不影响结果）。
 *
 * `小糖` 系列是 ASR 同音错例（SubStage 2.2 实测：KWS 命中"小唐小唐"，SenseVoice 常转成
 * "小糖小糖"）；不补的话这个词会留在文本里，3.2 剔不掉，后面按别名匹配时就多一坨噪声。
 */
export const WAKE_PREFIXES: readonly string[] = Object.freeze([
  '小唐小唐',
  '小糖小糖',
  '小唐',
  '小糖',
]);

/** 撤销说法（`parse_control` 用） */
export const UNDO_WORDS: readonly string[] = Object.freeze([
  '撤销',
  '撤消',
  '回到上一步',
  '刚才那个不要了',
  '恢复原样',
]);

/** 确认说法（二次确认握手用） */
export const CONFIRM_WORDS: readonly string[] = Object.freeze([
  '确认',
  '确定',
  '好',
  '可以',
  '行',
  '没问题',
  '是的',
  '对',
]);

/** "第六段增益" 这类频段寻址说法（含 1–7 的中文数字） */
export const BAND_PARAM_PATTERN = '第(?P<band>[1-7一二三四五六七])段(?P<field>增益|频率|q值|带宽)?';

/** "250 赫兹" / "三 k" 这类频点说法 */
export const HZ_PATTERN = '(?P<hz>\\d+(?:\\.\\d+)?)\\s*(?:赫兹|hz|k|千赫)';

/**
 * 校验失败时抛的错误类型。`emit.mjs` 用它区分"知识本体自身不自洽"（退出码 1）
 * 与"文件读写失败"（也退出码 1，但打印原始错误）。
 */
export class KbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbError';
  }
}
