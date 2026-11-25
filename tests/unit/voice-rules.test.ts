import { describe, expect, it } from 'vitest';

import {
  BANDS,
  CONDITIONALS,
  EQ_DELTAS,
  EQ_DELTA_BAND_PLACEHOLDER,
  RULES,
  SCENARIOS,
  SCENE_IDS,
  TARGET_NAME_ZH,
  TONE_IDS,
  TOGGLE_RULES,
  TURN_CAPS,
  bandForCenterHz,
  nearestBandOf,
  resolveEqDelta,
  resolveToggle,
  resolveTune,
  withRealBand,
} from '../../tools/voice/contract/rules';
import { PARAM_IDS, TOGGLE_TARGETS, TUNE_TARGETS } from '../../tools/voice/contract/targets';

/**
 * 规则表的**第二份真值**：期望值抄自设计文档 §3.4 的两张表与 `EQ_DELTAS` 表。
 *
 * 从 `gen/rules.json` 读出来再跟它自己比是没用的（永远绿）；这里的字面量是独立来源，
 * 它的唯一职责是当 `kb.ts` 或 `emit.mjs` 漂移时把差异吼出来（E1 门禁：
 * 72 格（12×3×2）+ 7 toggle；本版有 13 个维度，故 78 格）。
 */

type Cell = readonly Record<string, unknown>[];

function bg(band: number, delta: number): Record<string, unknown> {
  return { kind: 'band', band, field: 'gain', delta };
}

function p(id: string, delta: number): Record<string, unknown> {
  return { kind: 'param', id, delta };
}

function ps(id: string, value: number): Record<string, unknown> {
  return { kind: 'paramSet', id, value };
}

interface ExpectedRules {
  more: readonly Cell[];
  less: readonly Cell[];
}

/** 每格顺序即设计文档表里的书写顺序（slight / medium / strong） */
const EXPECTED: Record<string, ExpectedRules> = {
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
  // enc.Level −1/−2/−3（`less` 侧同时 enc.OnOff=1）
  noiseFloor: {
    more: [[p('enc.Level', -1)], [p('enc.Level', -2)], [p('enc.Level', -3)]],
    less: [
      [p('enc.Level', 1), ps('enc.OnOff', 1)],
      [p('enc.Level', 2), ps('enc.OnOff', 1)],
      [p('enc.Level', 3), ps('enc.OnOff', 1)],
    ],
  },
  // comp.Threshold −3/−6/−10；comp.Rate +1/+2/+3 ／ 反向
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
  // comp.MakeUpGain +1.5/+3/+6 ／ 反向
  loudness: {
    more: [[p('comp.MakeUpGain', 1.5)], [p('comp.MakeUpGain', 3)], [p('comp.MakeUpGain', 6)]],
    less: [[p('comp.MakeUpGain', -1.5)], [p('comp.MakeUpGain', -3)], [p('comp.MakeUpGain', -6)]],
  },
  // noisegate.threshold_db +3/+6/+9 ／ −3/−6/−9（到 −91 由条件动作关门）
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
  // limit.Threshold −1/−2/−3 ／ +1/+2/+3
  limiter: {
    more: [[p('limit.Threshold', -1)], [p('limit.Threshold', -2)], [p('limit.Threshold', -3)]],
    less: [[p('limit.Threshold', 1)], [p('limit.Threshold', 2)], [p('limit.Threshold', 3)]],
  },
  // rgb.Mode 循环 +1/+2/+3 ／ −1/−2/−3（取模在 canonicalize 做）
  rgbMode: {
    more: [[p('rgb.Mode', 1)], [p('rgb.Mode', 2)], [p('rgb.Mode', 3)]],
    less: [[p('rgb.Mode', -1)], [p('rgb.Mode', -2)], [p('rgb.Mode', -3)]],
  },
};

const STRENGTHS = ['slight', 'medium', 'strong'] as const;
const DIRECTIONS = ['more', 'less'] as const;

describe('规则表 13 维度 × 2 方向 × 3 档 = 78 格', () => {
  for (const target of TUNE_TARGETS) {
    for (const direction of DIRECTIONS) {
      STRENGTHS.forEach((strength, index) => {
        it(`${target}.${direction}.${strength}`, () => {
          expect(RULES[target][direction][strength]).toEqual(EXPECTED[target]?.[direction][index]);
        });
      });
    }
  }

  it('13 个维度齐备且中文名非空', () => {
    expect(TUNE_TARGETS).toHaveLength(13);
    expect(Object.keys(RULES)).toHaveLength(13);
    for (const target of TUNE_TARGETS) {
      expect(TARGET_NAME_ZH[target]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

/** `EQ_DELTAS` 的 18 格：3 字段 × 2 方向 × 3 档 */
const EXPECTED_EQ_DELTAS: Record<string, { more: readonly number[]; less: readonly number[] }> = {
  // +1/+2/+3 dB ／ −1/−2/−3 dB
  gain: { more: [1, 2, 3], less: [-1, -2, -3] },
  // +0.5/+1/+2（夹紧 0.1..12）／ 反向
  q: { more: [0.5, 1, 2], less: [-0.5, -1, -2] },
  // +10%/+20%/+30%（相对当前频点）／ 反向
  freqPct: { more: [10, 20, 30], less: [-10, -20, -30] },
};

const EQ_FIELD_OF_TABLE: Record<string, string> = { gain: 'gain', q: 'q', freqPct: 'freq' };

describe('EQ_DELTAS 3 字段 × 2 方向 × 3 档 = 18 格', () => {
  for (const tableKey of Object.keys(EXPECTED_EQ_DELTAS)) {
    for (const direction of DIRECTIONS) {
      STRENGTHS.forEach((strength, index) => {
        it(`${tableKey}.${direction}.${strength}`, () => {
          const expected = [
            {
              kind: 'band',
              band: EQ_DELTA_BAND_PLACEHOLDER,
              field: EQ_FIELD_OF_TABLE[tableKey],
              delta: EXPECTED_EQ_DELTAS[tableKey]?.[direction][index],
            },
          ];
          expect(EQ_DELTAS[tableKey as 'gain' | 'q' | 'freqPct'][direction][strength]).toEqual(expected);
        });
      });
    }
  }

  it('8 个格子全部用同一个占位段号（绝不产出 eq.band0.*）', () => {
    expect(EQ_DELTA_BAND_PLACEHOLDER).toBe(0);
    for (const tableKey of ['gain', 'q', 'freqPct'] as const) {
      for (const direction of DIRECTIONS) {
        for (const strength of STRENGTHS) {
          for (const action of EQ_DELTAS[tableKey][direction][strength]) {
            expect(action.kind).toBe('band');
            if (action.kind !== 'band') continue;
            expect(action.band).toBe(EQ_DELTA_BAND_PLACEHOLDER);
          }
        }
      }
    }
  });
});

describe('centerHz → band 的就近映射（设计文档 §3.4 末段）', () => {
  it('250→band4、3000→band6、12500→band7、63→band3、1000→band5、4000→band6', () => {
    expect(bandForCenterHz(250)).toBe(4);
    expect(bandForCenterHz(3000)).toBe(6);
    expect(bandForCenterHz(12500)).toBe(7);
    expect(bandForCenterHz(63)).toBe(3);
    expect(bandForCenterHz(1000)).toBe(5);
    expect(bandForCenterHz(4000)).toBe(6);
  });

  it('落在 HPF/LPF 段（band1 50 Hz / band2 20 kHz）时返回 unsupported', () => {
    expect(bandForCenterHz(50)).toBe('unsupported');
    expect(bandForCenterHz(20)).toBe('unsupported');
    expect(bandForCenterHz(20000)).toBe('unsupported');
    expect(nearestBandOf(50)).toBe(1);
    expect(nearestBandOf(20000)).toBe(2);
  });

  it('BANDS 的 7 段频点与类型', () => {
    expect(BANDS.map((band) => band.centerHz)).toEqual([50, 20000, 63, 250, 1000, 4000, 12500]);
    expect(BANDS.map((band) => band.kind)).toEqual(['hpf', 'lpf', 'peak', 'peak', 'peak', 'peak', 'peak']);
  });
});

describe('7 个开关的 on/off', () => {
  const EXPECTED_TOGGLE: Record<string, { on: Cell; off: Cell }> = {
    noiseFloor: { on: [ps('enc.OnOff', 1)], off: [ps('enc.OnOff', 0)] },
    gate: { on: [ps('noisegate.Enable', 1)], off: [ps('noisegate.Enable', 0)] },
    limiter: { on: [ps('limit.Enable', 1)], off: [ps('limit.Enable', 0)] },
    compression: { on: [ps('comp.Enable', 1)], off: [ps('comp.Enable', 0)] },
    rgbMode: { on: [ps('rgb.OnOff', 1)], off: [ps('rgb.OnOff', 0)] },
    mute: { on: [ps('mic.mute', 1)], off: [ps('mic.mute', 0)] },
    monitor: { on: [ps('hp.OnOff', 1)], off: [ps('hp.OnOff', 0)] },
  };

  for (const target of TOGGLE_TARGETS) {
    it(`${target} on`, () => {
      expect(TOGGLE_RULES[target].on).toEqual(EXPECTED_TOGGLE[target]?.on);
      expect(resolveToggle(target, true)).toEqual(EXPECTED_TOGGLE[target]?.on);
    });
    it(`${target} off`, () => {
      expect(TOGGLE_RULES[target].off).toEqual(EXPECTED_TOGGLE[target]?.off);
      expect(resolveToggle(target, false)).toEqual(EXPECTED_TOGGLE[target]?.off);
    });
  }
});

describe('单轮上限与条件动作', () => {
  it('TURN_CAPS = eqGainDb 6 / encLevel 3 / makeUpGainDb 6', () => {
    expect(TURN_CAPS).toEqual({ eqGainDb: 6, encLevel: 3, makeUpGainDb: 6 });
  });

  it('两条条件动作（noiseFloor.more → enc.OnOff=0；gate.less → noisegate.Enable=0）', () => {
    expect(CONDITIONALS).toEqual([
      {
        target: 'noiseFloor',
        direction: 'more',
        when: { id: 'enc.Level', atOrBelow: 0 },
        then: [ps('enc.OnOff', 0)],
      },
      {
        target: 'gate',
        direction: 'less',
        when: { id: 'noisegate.threshold_db', atOrBelow: -91 },
        then: [ps('noisegate.Enable', 0)],
      },
    ]);
  });

  it('8 个场景说法映射到 5 个内置场景', () => {
    expect(SCENARIOS).toHaveLength(8);
    for (const scenario of SCENARIOS) {
      expect(SCENE_IDS).toContain(scenario.baseScene);
    }
    expect(TONE_IDS).toEqual(['flat', 'vocal', 'warm', 'bright', 'custom']);
  });
});

describe('解析入口', () => {
  it('resolveTune 原样返回表里的格子', () => {
    expect(resolveTune('brightness', 'more', 'medium')).toEqual(EXPECTED.brightness?.more[1]);
  });

  it('resolveEqDelta + withRealBand 替换占位段号', () => {
    const delta = resolveEqDelta('gain', 'more', 'strong');
    expect(delta).toEqual({ kind: 'band', band: EQ_DELTA_BAND_PLACEHOLDER, field: 'gain', delta: 3 });
    expect(withRealBand(delta, 5)).toEqual({ kind: 'band', band: 5, field: 'gain', delta: 3 });
  });

  it('规则动作里的 paramId 全部在 72 个白名单内', () => {
    const ids = new Set<string>();
    for (const target of TUNE_TARGETS) {
      for (const direction of DIRECTIONS) {
        for (const strength of STRENGTHS) {
          for (const action of RULES[target][direction][strength]) {
            ids.add(
              action.kind === 'param' || action.kind === 'paramSet'
                ? String(action.id)
                : `eq.band${String(action.band)}.${String(action.field)}`,
            );
          }
        }
      }
    }
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(PARAM_IDS).toContain(id);
  });
});
