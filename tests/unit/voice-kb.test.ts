import { describe, expect, it } from 'vitest';
import { PRODUCT_BAND_FREQS } from '../../src/renderer/src/domain/defaults';
import { PARAMS } from '../../src/renderer/src/domain/params';
import {
  ALIAS_SIDE,
  BANDS,
  CONDITIONAL_ACTIONS,
  DIMENSIONS,
  EQ_DELTAS,
  EQ_DELTA_BAND_PLACEHOLDER,
  EXPLAIN_ONLY,
  SCENE_IDS,
  SCENARIOS,
  STRENGTHS,
  TOGGLE_RULES,
  TOGGLE_TARGET_IDS,
  TUNE_TARGET_IDS,
  TURN_CAPS,
  WAKE_PREFIXES,
} from '../../tools/voice/contract/kb';
import {
  PARAM_IDS,
  TARGET_WRITABLE,
  TOGGLE_TARGETS,
  TUNE_TARGETS,
  isParamId,
} from '../../tools/voice/contract/targets';
import { voiceCommandSchema, voicePlanSchema } from '../../tools/voice/contract/schemas';

/**
 * 防漂移单测：**期望值在测试里再抄一份**（抄自设计文档 §3.4 的表格）。
 *
 * 如果从 kb 读出来再跟 kb 比，测试永远绿也永远没用；这里的字面量是第二个来源，
 * 它的作用就是当 kb 被改动时把差异吼出来。
 */

type Cell = readonly Record<string, unknown>[];

/** `band` 增益动作 */
function bg(band: number, delta: number): Record<string, unknown> {
  return { kind: 'band', band, field: 'gain', delta };
}

function p(id: string, delta: number): Record<string, unknown> {
  return { kind: 'param', id, delta };
}

function ps(id: string, value: number): Record<string, unknown> {
  return { kind: 'paramSet', id, value };
}

/** 设计文档 §3.4「语义 → 参数规则表」逐格：每维度 2 方向 × 3 档（slight/medium/strong） */
const EXPECTED_RULES: Record<string, { more: readonly Cell[]; less: readonly Cell[] }> = {
  // band7.gain +1.5/+3/+5；band6.gain +1/+2/+3 ／ 反向
  brightness: {
    more: [[bg(7, 1.5), bg(6, 1)], [bg(7, 3), bg(6, 2)], [bg(7, 5), bg(6, 3)]],
    less: [[bg(7, -1.5), bg(6, -1)], [bg(7, -3), bg(6, -2)], [bg(7, -5), bg(6, -3)]],
  },
  // band3.gain +1.5/+3/+4.5；band7.gain −1/−2/−3 ／ 反向
  warmth: {
    more: [[bg(3, 1.5), bg(7, -1)], [bg(3, 3), bg(7, -2)], [bg(3, 4.5), bg(7, -3)]],
    less: [[bg(3, -1.5), bg(7, 1)], [bg(3, -3), bg(7, 2)], [bg(3, -4.5), bg(7, 3)]],
  },
  // band3.gain +2/+4/+6 ／ 反向
  lowEnd: {
    more: [[bg(3, 2)], [bg(3, 4)], [bg(3, 6)]],
    less: [[bg(3, -2)], [bg(3, -4)], [bg(3, -6)]],
  },
  // band4.gain +1.5/+3/+4.5；band7.gain −1/−2/−3 ／ 反向
  muddiness: {
    more: [[bg(4, 1.5), bg(7, -1)], [bg(4, 3), bg(7, -2)], [bg(4, 4.5), bg(7, -3)]],
    less: [[bg(4, -1.5), bg(7, 1)], [bg(4, -3), bg(7, 2)], [bg(4, -4.5), bg(7, 3)]],
  },
  // band5.gain +1/+2/+3；band6.gain +1/+1.5/+2 ／ 反向
  clarity: {
    more: [[bg(5, 1), bg(6, 1)], [bg(5, 2), bg(6, 1.5)], [bg(5, 3), bg(6, 2)]],
    less: [[bg(5, -1), bg(6, -1)], [bg(5, -2), bg(6, -1.5)], [bg(5, -3), bg(6, -2)]],
  },
  // band7.gain +1.5/+3/+5；band6.gain +1/+1.5/+2 ／ 反向
  sibilance: {
    more: [[bg(7, 1.5), bg(6, 1)], [bg(7, 3), bg(6, 1.5)], [bg(7, 5), bg(6, 2)]],
    less: [[bg(7, -1.5), bg(6, -1)], [bg(7, -3), bg(6, -1.5)], [bg(7, -5), bg(6, -2)]],
  },
  // band6.gain +1.5/+3/+4.5；band5.gain +0.5/+1/+1.5 ／ 反向
  harshness: {
    more: [[bg(6, 1.5), bg(5, 0.5)], [bg(6, 3), bg(5, 1)], [bg(6, 4.5), bg(5, 1.5)]],
    less: [[bg(6, -1.5), bg(5, -0.5)], [bg(6, -3), bg(5, -1)], [bg(6, -4.5), bg(5, -1.5)]],
  },
  // enc.Level −1/−2/−3；less 侧同时 enc.OnOff=1
  noiseFloor: {
    more: [[p('enc.Level', -1)], [p('enc.Level', -2)], [p('enc.Level', -3)]],
    less: [
      [p('enc.Level', 1), ps('enc.OnOff', 1)],
      [p('enc.Level', 2), ps('enc.OnOff', 1)],
      [p('enc.Level', 3), ps('enc.OnOff', 1)],
    ],
  },
  // comp.Threshold −3/−6/−10 dB；comp.Rate +1/+2/+3 ／ 反向
  compression: {
    more: [
      [p('comp.Threshold', -3), p('comp.Rate', 1)],
      [p('comp.Threshold', -6), p('comp.Rate', 2)],
      [p('comp.Threshold', -10), p('comp.Rate', 3)],
    ],
    less: [
      [p('comp.Threshold', 3), p('comp.Rate', -1)],
      [p('comp.Threshold', 6), p('comp.Rate', -2)],
      [p('comp.Threshold', 10), p('comp.Rate', -3)],
    ],
  },
  // comp.MakeUpGain +1.5/+3/+6 dB ／ 反向
  loudness: {
    more: [[p('comp.MakeUpGain', 1.5)], [p('comp.MakeUpGain', 3)], [p('comp.MakeUpGain', 6)]],
    less: [[p('comp.MakeUpGain', -1.5)], [p('comp.MakeUpGain', -3)], [p('comp.MakeUpGain', -6)]],
  },
  // noisegate.threshold_db +3/+6/+9 dB ／ −3/−6/−9 dB
  gate: {
    more: [
      [p('noisegate.threshold_db', 3)],
      [p('noisegate.threshold_db', 6)],
      [p('noisegate.threshold_db', 9)],
    ],
    less: [
      [p('noisegate.threshold_db', -3)],
      [p('noisegate.threshold_db', -6)],
      [p('noisegate.threshold_db', -9)],
    ],
  },
  // limit.Threshold −1/−2/−3 dB ／ +1/+2/+3 dB
  limiter: {
    more: [[p('limit.Threshold', -1)], [p('limit.Threshold', -2)], [p('limit.Threshold', -3)]],
    less: [[p('limit.Threshold', 1)], [p('limit.Threshold', 2)], [p('limit.Threshold', 3)]],
  },
  // rgb.Mode 循环 ±1/±2/±3
  rgbMode: {
    more: [[p('rgb.Mode', 1)], [p('rgb.Mode', 2)], [p('rgb.Mode', 3)]],
    less: [[p('rgb.Mode', -1)], [p('rgb.Mode', -2)], [p('rgb.Mode', -3)]],
  },
};

function expectSchemaWalkableKeys(schema: unknown, path: string): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => expectSchemaWalkableKeys(item, `${path}[${index}]`));
    return;
  }
  if (schema === null || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    expect(['$ref', 'pattern', 'allOf', 'format', 'anyOf', 'definitions', '$defs'], `${path}.${key}`).not.toContain(
      key,
    );
    if (key === 'type' && value === 'object') {
      expect((schema as Record<string, unknown>).additionalProperties, `${path} 缺 additionalProperties:false`).toBe(
        false,
      );
    }
    expectSchemaWalkableKeys(value, `${path}.${key}`);
  }
}

describe('kb.ts 知识本体', () => {
  it('1. DIMENSIONS 为 13 条、id 唯一、顺序与设计文档 §3.1 一致', () => {
    expect(DIMENSIONS).toHaveLength(13);
    expect(DIMENSIONS.map((dimension) => dimension.id)).toEqual([
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
    ]);
    // id 唯一 + 与 targets.ts 的枚举一致
    expect(new Set(DIMENSIONS.map((dimension) => dimension.id)).size).toBe(13);
    expect(TUNE_TARGETS).toEqual(DIMENSIONS.map((dimension) => dimension.id));
    expect(TUNE_TARGET_IDS).toEqual(TUNE_TARGETS);
    expect(TOGGLE_TARGETS).toEqual([
      'noiseFloor',
      'gate',
      'limiter',
      'compression',
      'rgbMode',
      'mute',
      'monitor',
    ]);
    expect(TOGGLE_TARGET_IDS).toEqual(TOGGLE_TARGETS);
    for (const dimension of DIMENSIONS) {
      expect(dimension.nameZh.length, `${dimension.id} 缺中文名`).toBeGreaterThan(0);
      expect(dimension.writable.length, `${dimension.id} 的 writable 为空`).toBeGreaterThan(0);
      expect(ALIAS_SIDE[dimension.id]).toMatch(/^(more|less)$/);
    }
  });

  it('2. 13×2×3 的 rules 与设计文档 §3.4 逐格相等', () => {
    for (const dimension of DIMENSIONS) {
      const expected = EXPECTED_RULES[dimension.id];
      expect(expected, `${dimension.id} 在设计文档表里没有对应行`).toBeDefined();
      for (const direction of ['more', 'less'] as const) {
        STRENGTHS.forEach((strength, index) => {
          expect(
            dimension.rules[direction][strength],
            `${dimension.id}.${direction}.${strength}`,
          ).toEqual(expected[direction][index]);
        });
      }
    }
    // 表里没有第 14 个维度
    expect(Object.keys(EXPECTED_RULES)).toHaveLength(13);
  });

  it('3. EQ_DELTAS 的 gain/q/freqPct 三档与设计文档 §3.4 逐格相等', () => {
    const expected = {
      gain: { more: [1, 2, 3], less: [-1, -2, -3] },
      q: { more: [0.5, 1, 2], less: [-0.5, -1, -2] },
      freqPct: { more: [10, 20, 30], less: [-10, -20, -30] },
    } as const;
    const fields = { gain: 'gain', q: 'q', freqPct: 'freq' } as const;
    for (const field of ['gain', 'q', 'freqPct'] as const) {
      for (const direction of ['more', 'less'] as const) {
        STRENGTHS.forEach((strength, index) => {
          expect(EQ_DELTAS[field][direction][strength], `EQ_DELTAS.${field}.${direction}.${strength}`).toEqual([
            {
              kind: 'band',
              band: EQ_DELTA_BAND_PLACEHOLDER,
              field: fields[field],
              delta: expected[field][direction][index],
            },
          ]);
        });
      }
    }
    // 单轮上限（设计文档 §3.4 末段）
    expect(TURN_CAPS).toEqual({ eqGainDb: 6, encLevel: 3, makeUpGainDb: 6 });
  });

  it('4. 每维度 aliases ≥ 6 条、全库去重后 ≥ 100 条', () => {
    for (const dimension of DIMENSIONS) {
      expect(dimension.aliases.length, `${dimension.id} 的 aliases 少于 6 条`).toBeGreaterThanOrEqual(6);
      for (const alias of dimension.aliases) {
        expect(typeof alias).toBe('string');
        expect(alias.length).toBeGreaterThan(0);
        // pattern 用 `|` 拼接，说法里不能出现 `|`，否则词表会被切成两条错误的正则分支
        expect(alias).not.toContain('|');
      }
    }
    const allAliases = new Set(DIMENSIONS.flatMap((dimension) => [...dimension.aliases]));
    expect(allAliases.size).toBeGreaterThanOrEqual(100);
    // 说法跨维度重复会让词表出现歧义（同一条说法落到两个 target）
    const owner = new Map<string, string>();
    for (const dimension of DIMENSIONS) {
      for (const alias of dimension.aliases) {
        const previous = owner.get(alias);
        if (previous !== undefined) expect(previous, `说法 "${alias}" 重复`).toBe(dimension.id);
        owner.set(alias, dimension.id);
      }
    }
    // 只识别不执行：≥ 4 条，且每条都有解释话术
    expect(EXPLAIN_ONLY.length).toBeGreaterThanOrEqual(4);
    for (const item of EXPLAIN_ONLY) {
      expect(item.aliases.length).toBeGreaterThan(0);
      expect(item.explain.length).toBeGreaterThan(0);
    }
    // 两组中文说法 / 唤醒词常量
    expect(WAKE_PREFIXES[0]).toBe('小唐小唐');
  });

  it('7. 场景 8 个、baseScene 属于内置 5 场景、patch 只碰白名单内的参数', () => {
    expect(SCENARIOS).toHaveLength(8);
    expect(SCENE_IDS).toEqual(['quiet', 'game', 'podcast', 'sing', 'custom']);
    expect(SCENARIOS.map((scenario) => scenario.id).sort()).toEqual([
      'asmr',
      'dub',
      'game',
      'live',
      'meeting',
      'podcast',
      'record',
      'sing',
    ]);
    for (const scenario of SCENARIOS) {
      expect(SCENE_IDS).toContain(scenario.baseScene);
      expect(scenario.aliases.length).toBeGreaterThan(0);
      for (const action of scenario.patch) {
        const id =
          action.kind === 'param' || action.kind === 'paramSet'
            ? action.id
            : `eq.band${action.band}.${action.field}`;
        expect(isParamId(id), `场景 ${scenario.id} 的补丁写了白名单外的 ${id}`).toBe(true);
      }
    }
    // 8 种说法 → 内置场景的映射与设计文档 §3.1 的表一致
    const baseScenes = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, scenario.baseScene]));
    expect(baseScenes).toEqual({
      live: 'podcast',
      meeting: 'podcast',
      sing: 'sing',
      game: 'game',
      podcast: 'podcast',
      record: 'quiet',
      dub: 'podcast',
      asmr: 'quiet',
    });
  });

  it('8. BANDS 的 centerHz 等于 PRODUCT_BAND_FREQS、kind 为 hpf/lpf/peak×5', () => {
    expect(PRODUCT_BAND_FREQS).toEqual([50, 20000, 63, 250, 1000, 4000, 12500]);
    expect(BANDS).toHaveLength(7);
    expect(BANDS.map((band) => band.centerHz)).toEqual([...PRODUCT_BAND_FREQS]);
    expect(BANDS.map((band) => band.band)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(BANDS.map((band) => band.kind)).toEqual(['hpf', 'lpf', 'peak', 'peak', 'peak', 'peak', 'peak']);
    // 开关与条件动作：7 个开关各给 on/off，条件动作只指向已存在的维度
    expect(Object.keys(TOGGLE_RULES)).toEqual([...TOGGLE_TARGETS]);
    for (const target of TOGGLE_TARGETS) {
      expect(TOGGLE_RULES[target].on.length).toBeGreaterThan(0);
      expect(TOGGLE_RULES[target].off.length).toBeGreaterThan(0);
    }
    for (const conditional of CONDITIONAL_ACTIONS) {
      expect(DIMENSIONS.map((dimension) => dimension.id)).toContain(conditional.target);
      expect(conditional.then.length).toBeGreaterThan(0);
    }
  });

  it('9. schema 不含 $ref/pattern/allOf，且两次构造完全一致', () => {
    const plan = voicePlanSchema();
    const command = voiceCommandSchema();
    expectSchemaWalkableKeys(plan, 'plan');
    expectSchemaWalkableKeys(command, 'command');
    expect(JSON.stringify(voicePlanSchema())).toBe(JSON.stringify(plan));
    expect(JSON.stringify(voiceCommandSchema())).toBe(JSON.stringify(command));
    const properties = plan.properties as Record<string, Record<string, unknown>>;
    expect(properties.confidence.enum).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const ops = properties.ops as { items: { oneOf: unknown[] } };
    expect(ops.items.oneOf).toHaveLength(8);
    expect(PARAMS.length).toBe(46);
    expect(PARAM_IDS).toContain('eq.band7.q');
    expect(TARGET_WRITABLE.brightness).toEqual(['eq.band6.gain', 'eq.band7.gain']);
  });
});
