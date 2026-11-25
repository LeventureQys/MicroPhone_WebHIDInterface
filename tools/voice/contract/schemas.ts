/**
 * L1 / L2 的 JSON Schema 构造器（Alpha v1.3.0 / SubStage 3.1）。
 *
 * 约束（设计文档 §3.2、任务书 §4.6）：llama.cpp 的 `json_schema → GBNF` 转换只认识
 * 一小撮关键字，遇到 `$ref` / `format` / `allOf` 会**静默降级**（生成不受约束的语法，
 * 模型于是能吐出任意字段）。所以这里只用：
 *
 *   type / properties / required / additionalProperties / items / enum / const / oneOf
 *
 * 再补两个数值边界 `minimum` / `maximum`（band 号、centerHz）。**不用 `pattern`**，
 * 也不用 `type: array` 形式的可空写法之外的花样；每个 object 都写 `additionalProperties: false`。
 *
 * `ops` 的 8 种 `kind` 用**扁平 `oneOf`**（8 个并列分支，靠 `const` 判别的近似）：
 * tune / eq(band) / eq(centerHz) / toggle / set / scene / tone / undo。
 * 判别不严（`eq` 的两个分支只能靠 required 字段区分）是刻意的：GBNF 不支持 if/then，
 * 真正的校验在 `canonicalize.ts` 里做（非法 op 丢弃并记 `danger`）。
 *
 * 枚举值全部来自 `kb.ts` / `targets.ts`，本文件不写字面量清单。
 */

import { SCENE_IDS, TONE_IDS } from './kb';
import { PARAM_IDS, STRENGTH_IDS, TOGGLE_TARGETS, TUNE_TARGETS } from './targets';

export type JsonSchema = Readonly<Record<string, unknown>>;

/** `eq` 动作可改的字段（L1 只有这三项；`type` 只在规则动作里出现） */
const EQ_OP_FIELDS = Object.freeze(['gain', 'q', 'freq'] as const);

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...required],
    properties,
  };
}

function enumOf(values: readonly (string | number | null)[]): JsonSchema {
  return { enum: [...values] };
}

function stringEnum(values: readonly string[]): JsonSchema {
  return { type: 'string', enum: [...values] };
}

function arrayOf(items: JsonSchema): JsonSchema {
  return { type: 'array', items };
}

/** 8 种 op 的扁平 oneOf（顺序即设计文档 §3.2 的列举顺序） */
export function voiceOpVariants(): readonly JsonSchema[] {
  const direction = stringEnum(['more', 'less']);
  const strength = stringEnum(STRENGTH_IDS);
  return [
    objectSchema(
      {
        kind: { const: 'tune' },
        target: stringEnum(TUNE_TARGETS),
        direction,
        strength,
      },
      ['kind', 'target', 'direction', 'strength'],
    ),
    objectSchema(
      {
        kind: { const: 'eq' },
        band: { type: 'number', minimum: 1, maximum: 7 },
        direction,
        strength,
        field: stringEnum(EQ_OP_FIELDS),
      },
      ['kind', 'band', 'direction', 'field'],
    ),
    objectSchema(
      {
        kind: { const: 'eq' },
        centerHz: { type: 'number', minimum: 20, maximum: 20000 },
        direction,
        strength,
        field: stringEnum(EQ_OP_FIELDS),
      },
      ['kind', 'centerHz', 'direction', 'field'],
    ),
    objectSchema(
      {
        kind: { const: 'toggle' },
        target: stringEnum(TOGGLE_TARGETS),
        on: { type: 'boolean' },
      },
      ['kind', 'target', 'on'],
    ),
    objectSchema(
      {
        kind: { const: 'set' },
        param: stringEnum(PARAM_IDS),
        value: { type: 'number' },
      },
      ['kind', 'param', 'value'],
    ),
    objectSchema(
      {
        kind: { const: 'scene' },
        scene: stringEnum(SCENE_IDS),
      },
      ['kind', 'scene'],
    ),
    objectSchema(
      {
        kind: { const: 'tone' },
        tone: stringEnum(TONE_IDS),
      },
      ['kind', 'tone'],
    ),
    objectSchema({ kind: { const: 'undo' } }, ['kind']),
  ];
}

/** L1 `VoicePlan`（设计文档 §3.2 的字段表） */
export function voicePlanSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['v', 'status', 'ops', 'say', 'confidence'],
    properties: {
      v: { const: 1 },
      status: stringEnum(['ok', 'clarify', 'unsupported']),
      // `ops` 的 1..4 项上限不受 GBNF 约束（没有 minItems/maxItems），由 canonicalize 校验
      ops: arrayOf({ oneOf: [...voiceOpVariants()] }),
      question: { type: 'string' },
      say: { type: 'string' },
      confidence: enumOf([0, 0.25, 0.5, 0.75, 1]),
    },
  };
}

/** L2 `VoiceCommand`（设计文档 §3.3 的字段表） */
export function voiceCommandSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'v',
      'turn',
      'status',
      'writes',
      'bandWrites',
      'scene',
      'tone',
      'say',
      'undoTurn',
      'danger',
      'confirmToken',
      'preview',
    ],
    properties: {
      v: { const: 1 },
      turn: { type: 'string' },
      status: stringEnum(['applied', 'needs_confirm', 'rejected', 'dry-run']),
      writes: arrayOf(
        objectSchema(
          {
            param: stringEnum(PARAM_IDS),
            value: { type: 'number' },
          },
          ['param', 'value'],
        ),
      ),
      bandWrites: arrayOf(
        objectSchema(
          {
            band: { type: 'number', minimum: 1, maximum: 7 },
            field: stringEnum(['type', 'freq', 'gain', 'q']),
            value: { type: 'number' },
          },
          ['band', 'field', 'value'],
        ),
      ),
      scene: enumOf([...SCENE_IDS, null]),
      tone: enumOf([...TONE_IDS, null]),
      say: { type: 'string' },
      undoTurn: { type: ['string', 'null'] },
      danger: arrayOf(
        objectSchema(
          {
            param: { type: 'string' },
            reason: stringEnum(['confirm-required', 'excluded', 'ungrounded-number']),
          },
          ['param', 'reason'],
        ),
      ),
      confirmToken: { type: ['string', 'null'] },
      preview: arrayOf({ type: 'string' }),
    },
  };
}
