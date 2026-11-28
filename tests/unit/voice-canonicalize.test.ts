import { describe, expect, it } from 'vitest';

import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';
import { EQ_PRESETS } from '../../src/renderer/src/domain/quick-controls';
import {
  MUTE_SAY,
  numberGrounded,
  planToCommand,
  quantizeValue,
  specOfParamId,
  tierOfParam,
  type CanonResult,
  type VoiceState,
} from '../../tools/voice/contract/canonicalize';
import { PARAM_IDS } from '../../tools/voice/contract/targets';

/**
 * `planToCommand` 的行为测试（SubStage 4.1 §6 的 1c–10 + §7.3 的夹紧 20 例）。
 *
 * 所有 L1 样例都写成字面量 JSON：它们既是测试输入，也是 4.3 编排与 5.3 评测要复用的口径。
 */

function state(params: Record<string, number> = {}, bands: number[] = [0, 0, 0, 0, 0, 0, 0]): VoiceState {
  return { params, bands };
}

function plan(ops: readonly Record<string, unknown>[], say = '好'): Record<string, unknown> {
  return { v: 1, status: 'ok', say, confidence: 1, ops };
}

function tune(target: string, direction: string, strength: string): Record<string, unknown> {
  return { kind: 'tune', target, direction, strength };
}

function bandValues(result: CanonResult): number[] {
  return result.bandWrites.map((write) => write.value);
}

function writeOf(result: CanonResult, param: string): number | undefined {
  return result.writes.find((write) => write.param === param)?.value;
}

const TURN = { turnId: 't-0001' };

describe('规则表落地：样例 1（设计文档 §3.2 / 验收 7.1）', () => {
  it('"亮一点" → band7.gain 0→1.5、band6.gain 0→1', () => {
    const result = planToCommand(
      plan([tune('brightness', 'more', 'slight')], '亮一点'),
      state(),
      TURN,
    );
    expect(result.bandWrites).toEqual([
      { band: 7, field: 'gain', value: 1.5 },
      { band: 6, field: 'gain', value: 1 },
    ]);
    expect(result.writes).toEqual([]);
    expect(result.tier).toBe('immediate');
    expect(result.say).toBe('亮一点');
  });
});

describe('1c 数字接地（`set` 的数值必须在用户原话里出现）', () => {
  const setOp = { kind: 'set', param: 'eq.band6.gain', value: 3 };

  it('原话里能找到 3 → 保留写入', () => {
    const result = planToCommand(plan([setOp]), state(), {
      turnId: 't-0002',
      utterance: '第六段增益提到3dB',
    });
    expect(result.danger).toEqual([]);
    expect(result.bandWrites).toEqual([{ band: 6, field: 'gain', value: 3 }]);
  });

  it('原话里找不到 3 → 丢弃并记 ungrounded-number', () => {
    const result = planToCommand(plan([setOp]), state(), {
      turnId: 't-0003',
      utterance: '声音太闷了',
    });
    expect(result.bandWrites).toEqual([]);
    expect(result.danger).toEqual([{ param: 'eq.band6.gain', reason: 'ungrounded-number' }]);
  });

  it('负数与小数：-18 / 4.5 都能匹配（「负18」「4.5」）', () => {
    expect(numberGrounded('压缩阈值负18', -18)).toBe(true);
    expect(numberGrounded('把第四段调到4.5', 4.5)).toBe(true);
    expect(numberGrounded('把第四段调到4.5', 4)).toBe(false);
    expect(numberGrounded('13dB', 3)).toBe(false);
  });
});

describe('1d 条件动作（端点上顺手关模块）', () => {
  it('noiseFloor.more.strong 在 enc.Level=3 时 → enc.Level=0 且 enc.OnOff=0', () => {
    const result = planToCommand(
      plan([tune('noiseFloor', 'more', 'strong')]),
      state({ 'enc.Level': 3, 'enc.OnOff': 1 }),
      TURN,
    );
    expect(writeOf(result, 'enc.Level')).toBe(0);
    expect(writeOf(result, 'enc.OnOff')).toBe(0);
  });

  it('gate.less.strong 在 noisegate.threshold_db=-85 时 → 阈值夹到 -91 且 noisegate.Enable=0', () => {
    const result = planToCommand(
      plan([tune('gate', 'less', 'strong')]),
      state({ 'noisegate.threshold_db': -85, 'noisegate.Enable': 1 }),
      TURN,
    );
    expect(writeOf(result, 'noisegate.threshold_db')).toBe(-91);
    expect(writeOf(result, 'noisegate.Enable')).toBe(0);
  });

  it('没到端点时不追加条件动作（enc.Level=3 减 1 只到 2）', () => {
    const result = planToCommand(
      plan([tune('noiseFloor', 'more', 'slight')]),
      state({ 'enc.Level': 3, 'enc.OnOff': 1 }),
      TURN,
    );
    expect(writeOf(result, 'enc.Level')).toBe(2);
    expect(writeOf(result, 'enc.OnOff')).toBeUndefined();
  });
});

describe('1e rgb.Mode 按 0..6 取模（不是夹紧）', () => {
  it('rgb.Mode=6 + more/slight → 0', () => {
    const result = planToCommand(plan([tune('rgbMode', 'more', 'slight')]), state({ 'rgb.Mode': 6 }), TURN);
    expect(result.writes).toEqual([{ param: 'rgb.Mode', value: 0 }]);
  });

  it('rgb.Mode=0 + less/slight → 6', () => {
    const result = planToCommand(plan([tune('rgbMode', 'less', 'slight')]), state({ 'rgb.Mode': 0 }), TURN);
    expect(result.writes).toEqual([{ param: 'rgb.Mode', value: 6 }]);
  });

  it('rgb.Mode=6 + more/strong（+3）→ 2', () => {
    const result = planToCommand(plan([tune('rgbMode', 'more', 'strong')]), state({ 'rgb.Mode': 6 }), TURN);
    expect(result.writes).toEqual([{ param: 'rgb.Mode', value: 2 }]);
  });
});

describe('1f eq 占位段号必须替换成真实段号', () => {
  it('eq band4 gain more medium → 落在 band4，且不出现 eq.band0.*', () => {
    const result = planToCommand(
      plan([{ kind: 'eq', band: 4, direction: 'more', strength: 'medium', field: 'gain' }]),
      state(),
      TURN,
    );
    expect(result.bandWrites).toEqual([{ band: 4, field: 'gain', value: 2 }]);
    expect(result.preview.join('|')).not.toContain('band0');
    expect(result.writes.some((write) => write.param.includes('band0'))).toBe(false);
  });

  it('eq centerHz=3000 → band6；centerHz=250 → band4', () => {
    const high = planToCommand(
      plan([{ kind: 'eq', centerHz: 3000, direction: 'less', strength: 'slight' }]),
      state(),
      TURN,
    );
    expect(high.bandWrites).toEqual([{ band: 6, field: 'gain', value: -1 }]);

    const low = planToCommand(
      plan([{ kind: 'eq', centerHz: 250, direction: 'more', strength: 'slight' }]),
      state(),
      TURN,
    );
    expect(low.bandWrites).toEqual([{ band: 4, field: 'gain', value: 1 }]);
  });

  it('eq centerHz=50（HPF 段）→ 丢弃并记 excluded', () => {
    const result = planToCommand(
      plan([{ kind: 'eq', centerHz: 50, direction: 'more', strength: 'slight' }]),
      state(),
      TURN,
    );
    expect(result.bandWrites).toEqual([]);
    expect(result.danger).toEqual([{ param: 'eq.band1.gain', reason: 'excluded' }]);
    expect(result.tier).toBe('excluded');
  });

  it('eq 的 q / freq 字段：q 增量 0.1 步进、freq 按百分比换算', () => {
    const q = planToCommand(
      plan([{ kind: 'eq', band: 5, field: 'q', direction: 'more', strength: 'medium' }]),
      state({ 'eq.band5.q': 1 }),
      TURN,
    );
    expect(q.bandWrites).toEqual([{ band: 5, field: 'q', value: 2 }]);

    const freq = planToCommand(
      plan([{ kind: 'eq', band: 6, field: 'freq', direction: 'more', strength: 'slight' }]),
      state({ 'eq.band6.freq': 4000 }),
      TURN,
    );
    expect(freq.bandWrites).toEqual([{ band: 6, field: 'freq', value: 4400 }]);
  });
});

describe('3 夹紧：已在端点上不再增加，且 preview 标 clamped', () => {
  it('brightness.more.strong 在 band7=12 / band6=12 时无写入', () => {
    const result = planToCommand(
      plan([tune('brightness', 'more', 'strong')]),
      state({}, [0, 0, 0, 0, 0, 12, 12]),
      TURN,
    );
    expect(result.bandWrites).toEqual([]);
    expect(result.preview.join('|')).toContain('clamped');
  });
});

describe('4 量化：目标值按 step 吸附', () => {
  it('eq.band6.gain 目标 2.34 → 2.3（步进 0.1）', () => {
    const result = planToCommand(
      plan([{ kind: 'set', param: 'eq.band6.gain', value: 2.34 }]),
      state(),
      { turnId: 't-0004', utterance: '第六段调到2.34' },
    );
    expect(result.bandWrites).toEqual([{ band: 6, field: 'gain', value: 2.3 }]);
  });

  it('quantizeValue 对 q / freq 同样吸附', () => {
    const qSpec = specOfParamId('eq.band4.q');
    const freqSpec = specOfParamId('eq.band4.freq');
    expect(qSpec && quantizeValue(qSpec, 1.234)).toBe(1.2);
    expect(freqSpec && quantizeValue(freqSpec, 250.6)).toBe(251);
  });
});

describe('5 单轮上限 TURN_CAPS', () => {
  it('同一轮里两次 brightness.more.strong：band7 累计 10 → 截到 6（第二次只加 1）', () => {
    const result = planToCommand(
      plan([tune('brightness', 'more', 'strong'), tune('brightness', 'more', 'strong')]),
      state(),
      TURN,
    );
    expect(result.bandWrites).toEqual([
      { band: 7, field: 'gain', value: 6 },
      { band: 6, field: 'gain', value: 6 },
    ]);
    expect(result.preview.join('|')).toContain('单轮上限');
  });

  it('跨轮不共享上限：第二个 turn 从 band7=5 再加 5 → 10（每轮独立计算）', () => {
    // 任务书 §6 第 5 条的括注暗示"第二次 state 已 +5 → 只加 1"，那是把单轮上限
    // 说成了绝对值上限；设计文档 §3.4 原文是"任一 EQ 段单轮累计 |Δgain| ≤ 6 dB"，
    // 这里按"每轮独立"实现（跨轮累计由 4.2 的撤销栈与本轮日志负责）。
    const result = planToCommand(
      plan([tune('brightness', 'more', 'strong')]),
      state({}, [0, 0, 0, 0, 0, 3, 5]),
      TURN,
    );
    expect(result.bandWrites).toEqual([
      { band: 7, field: 'gain', value: 10 },
      { band: 6, field: 'gain', value: 6 },
    ]);
  });

  it('loudness.more.strong 在两轮之间同样受 6 dB 约束（单轮内叠加 12 → 6）', () => {
    const result = planToCommand(
      plan([tune('loudness', 'more', 'strong'), tune('loudness', 'more', 'strong')]),
      state({ 'comp.MakeUpGain': 10 }),
      TURN,
    );
    expect(result.writes).toEqual([{ param: 'comp.MakeUpGain', value: 16 }]);
  });

  it('enc.Level 单轮上限 3：两次 noiseFloor.less.strong（+3+3）→ +3', () => {
    const result = planToCommand(
      plan([tune('noiseFloor', 'less', 'strong'), tune('noiseFloor', 'less', 'strong')]),
      state({ 'enc.Level': 0, 'enc.OnOff': 1 }),
      TURN,
    );
    expect(writeOf(result, 'enc.Level')).toBe(3);
  });
});

describe('6 tier 原子性：含 confirm 项则整轮不写', () => {
  it('mic.mute=1 → tier=confirm、writes 只剩 confirm 项、immediate 项进 danger', () => {
    const result = planToCommand(
      plan([tune('brightness', 'more', 'slight'), { kind: 'toggle', target: 'mute', on: true }]),
      state({ 'mic.mute': 0 }),
      TURN,
    );
    expect(result.tier).toBe('confirm');
    expect(result.writes).toEqual([{ param: 'mic.mute', value: 1 }]);
    expect(result.bandWrites).toEqual([]);
    expect(result.danger).toEqual([
      { param: 'eq.band7.gain', reason: 'confirm-required' },
      { param: 'eq.band6.gain', reason: 'confirm-required' },
    ]);
    expect(result.say).toBe(MUTE_SAY);
  });

  it('tierOfParam：mic.mute / mic.sigMute / hp.OnOff 是 confirm，gain.Mic 是 excluded', () => {
    expect(tierOfParam('mic.mute')).toBe('confirm');
    expect(tierOfParam('mic.sigMute')).toBe('confirm');
    expect(tierOfParam('hp.OnOff')).toBe('confirm');
    expect(tierOfParam('enc.Level')).toBe('immediate');
    expect(tierOfParam('eq.band7.gain')).toBe('immediate');
    expect(tierOfParam('gain.Mic')).toBe('excluded');
    expect(tierOfParam('micLevel')).toBe('excluded');
  });
});

describe('7 excluded：只读参数被丢弃', () => {
  it('set gain.Mic=50 → danger 含 excluded、writes 为空、tier=excluded', () => {
    const result = planToCommand(
      plan([{ kind: 'set', param: 'gain.Mic', value: 50 }]),
      state(),
      { turnId: 't-0005', utterance: '麦克风增益50' },
    );
    expect(result.danger).toEqual([{ param: 'gain.Mic', reason: 'excluded' }]);
    expect(result.writes).toEqual([]);
    expect(result.tier).toBe('excluded');
  });

  it('excluded 与 immediate 混在一轮：excluded 丢弃，其余照常写', () => {
    const result = planToCommand(
      plan([
        { kind: 'set', param: 'gain.Hp', value: 80 },
        { kind: 'toggle', target: 'gate', on: false },
      ]),
      state({ 'noisegate.Enable': 1 }),
      { turnId: 't-0006', utterance: '监听80' },
    );
    expect(result.tier).toBe('immediate');
    expect(result.writes).toEqual([{ param: 'noisegate.Enable', value: 0 }]);
    expect(result.danger).toEqual([{ param: 'gain.Hp', reason: 'excluded' }]);
  });
});

describe('8 场景整包写入', () => {
  it('scene=quiet → noisegate -82 / comp.Threshold -18 / 7 段增益全 0', () => {
    const result = planToCommand(
      plan([{ kind: 'scene', scene: 'quiet' }]),
      state({}, [1, 2, 3, 4, 5, 6, 7]),
      TURN,
    );
    expect(result.scene).toBe('quiet');
    expect(writeOf(result, 'noisegate.threshold_db')).toBe(-82);
    expect(writeOf(result, 'comp.Threshold')).toBe(-18);
    expect(result.bandWrites).toHaveLength(7);
    expect(result.bandWrites.map((write) => write.band)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(bandValues(result)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('scene=custom 不覆盖 7 段增益（取当前值）', () => {
    const result = planToCommand(
      plan([{ kind: 'scene', scene: 'custom' }]),
      state({}, [1, 2, 3, 4, 5, 6, 7]),
      TURN,
    );
    expect(result.bandWrites).toEqual([]);
  });

  it('scenario=live（8 种说法）→ 场景 podcast + 补丁 enc.Level+1、门限+3', () => {
    const result = planToCommand(
      plan([{ kind: 'scene', scenario: 'live' }]),
      state({ 'enc.Level': 0, 'noisegate.threshold_db': -40 }),
      TURN,
    );
    expect(result.scene).toBe('podcast');
    // podcast 自带 enc.Level=1、门限 −59，补丁再 +1 档 / +3 dB
    expect(writeOf(result, 'enc.Level')).toBe(2);
    expect(writeOf(result, 'noisegate.threshold_db')).toBe(-56);
  });
});

describe('9 音色：7 段增益整包写入', () => {
  it('tone=warm → bandWrites 的 7 个 gain 等于 EQ_PRESETS.warm', () => {
    const result = planToCommand(plan([{ kind: 'tone', tone: 'warm' }]), state({}, [1, 1, 1, 1, 1, 1, 1]), TURN);
    expect(result.tone).toBe('warm');
    expect(result.bandWrites).toHaveLength(7);
    expect(bandValues(result)).toEqual([...EQ_PRESETS.warm]);
  });

  it('tone=custom → 不写增益，preview 标 no-op', () => {
    const result = planToCommand(plan([{ kind: 'tone', tone: 'custom' }]), state({}, [1, 1, 1, 1, 1, 1, 1]), TURN);
    expect(result.tone).toBe('custom');
    expect(result.bandWrites).toEqual([]);
    expect(result.preview.join('|')).toContain('no-op');
  });
});

describe('10 只写变化项', () => {
  it('state 已经是目标值时零写入', () => {
    const result = planToCommand(
      plan([{ kind: 'set', param: 'eq.band6.gain', value: 3 }]),
      state({}, [0, 0, -3.5, 0, 0, 3, 0]),
      { turnId: 't-0007', utterance: '第六段3' },
    );
    expect(result.bandWrites).toEqual([]);
    expect(result.writes).toEqual([]);
    expect(result.preview.join('|')).not.toContain('clamped');
  });

  it('toggle 到同值时零写入', () => {
    const result = planToCommand(
      plan([{ kind: 'toggle', target: 'gate', on: true }]),
      state({ 'noisegate.Enable': 1 }),
      TURN,
    );
    expect(result.writes).toEqual([]);
  });
});

describe('L1 校验（E_PLAN_INVALID）', () => {
  const cases: { name: string; input: Record<string, unknown>; hit: string }[] = [
    { name: '缺 status', input: { v: 1, ops: [], say: '好', confidence: 1 }, hit: 'status' },
    {
      name: 'ops 超过 4 项',
      input: {
        v: 1,
        status: 'ok',
        say: '好',
        confidence: 1,
        ops: [tune('brightness', 'more', 'slight'), tune('brightness', 'more', 'slight'), tune('brightness', 'more', 'slight'), tune('brightness', 'more', 'slight'), tune('brightness', 'more', 'slight')],
      },
      hit: 'ops 最多 4 项',
    },
    { name: 'status=ok 但 ops 为空', input: { v: 1, status: 'ok', say: '好', confidence: 1, ops: [] }, hit: 'ops 不能为空' },
    { name: 'target 越界', input: plan([tune('loudnesss', 'more', 'slight')]), hit: 'target 非法' },
    { name: 'direction 越界', input: plan([tune('brightness', 'up', 'slight')]), hit: 'direction 非法' },
    { name: 'strength 越界', input: plan([tune('brightness', 'more', 'huge')]), hit: 'strength 非法' },
    { name: 'confidence 非离散值', input: { v: 1, status: 'ok', say: '好', confidence: 0.6, ops: [tune('brightness', 'more', 'slight')] }, hit: 'confidence' },
    { name: 'clarify 缺 question', input: { v: 1, status: 'clarify', say: '', confidence: 0.25, ops: [] }, hit: 'question' },
    { name: 'kind 未知', input: plan([{ kind: 'shutdown' }]), hit: 'kind 非法' },
    { name: 'eq 缺 band/centerHz', input: plan([{ kind: 'eq', direction: 'more', strength: 'slight' }]), hit: 'band 或 centerHz' },
  ];

  for (const item of cases) {
    it(item.name, () => {
      expect(() => planToCommand(item.input, state(), TURN)).toThrow(/E_PLAN_INVALID/);
      expect(() => planToCommand(item.input, state(), TURN)).toThrow(item.hit);
    });
  }

  it('clarify / unsupported 不产生写入', () => {
    const clarify = planToCommand(
      { v: 1, status: 'clarify', say: '', confidence: 0.25, ops: [], question: '想调哪一块？' },
      state(),
      TURN,
    );
    expect(clarify.writes).toEqual([]);
    expect(clarify.bandWrites).toEqual([]);
    expect(clarify.tier).toBe('immediate');

    const unsupported = planToCommand(
      { v: 1, status: 'unsupported', say: '我只管调麦克风音色', confidence: 1, ops: [] },
      state(),
      TURN,
    );
    expect(unsupported.writes).toEqual([]);
    expect(unsupported.say).toBe('我只管调麦克风音色');
  });

  it('undo 只透出意图，不产生写入（撤销栈在 4.2）', () => {
    const result = planToCommand(plan([{ kind: 'undo' }]), state(), TURN);
    expect(result.undo).toBe(true);
    expect(result.writes).toEqual([]);
  });
});

interface DrySinkLike {
  readonly name: string;
  readState(): Promise<VoiceState>;
  write(cmd: {
    writes: readonly { param: string; value: number }[];
    bandWrites: readonly { band: number; field: string; value: number }[];
  }): Promise<void>;
  reset(): void;
}

/**
 * 加载 `sinks/dry.mjs`。
 *
 * `sinks/*.mjs` 没有类型声明（`tsconfig` 不开 `allowJs`），所以用变量说明符动态 import：
 * TS 不做静态解析（不会报 TS7016），运行时由 vitest 按本文件的相对路径解析 `.mjs`。
 */
async function loadDrySink(): Promise<{ createDrySink: () => DrySinkLike }> {
  const specifier = '../../tools/voice/sinks/dry.mjs';
  return (await import(specifier)) as { createDrySink: () => DrySinkLike };
}

describe('dry sink：72 项 params 与 7 项 bands 由同一份状态派生', () => {
  it('初值 = 46 标量 + 28 EQ 字段，键集合等于 PARAM_IDS', async () => {
    const { createDrySink } = await loadDrySink();
    const initial = await createDrySink().readState();
    expect(Object.keys(initial.params)).toHaveLength(72);
    expect(Object.keys(initial.params).sort()).toEqual([...PARAM_IDS].sort());
    // 前 7 段取 DEFAULT_BANDS 的 type/freq/gain/q（8..14 段是界面插值，没有寄存器）
    expect(initial.params['eq.band1.type']).toBe(DEFAULT_BANDS[0]?.type);
    expect(initial.params['eq.band1.freq']).toBe(DEFAULT_BANDS[0]?.freq);
    expect(initial.params['eq.band3.gain']).toBe(DEFAULT_BANDS[2]?.gain);
    expect(initial.bands).toEqual([0, 0, -3.5, 0, 0, 0, 0]);
  });

  it('写入后 bands 恒等于 params 里的 eq.bandN.gain（含非 gain 字段的写入）', async () => {
    const { createDrySink } = await loadDrySink();
    const sink = createDrySink();
    await sink.write({
      writes: [{ param: 'enc.Level', value: 2 }],
      bandWrites: [
        { band: 6, field: 'gain', value: 2.5 },
        { band: 4, field: 'q', value: 3 },
        { band: 5, field: 'freq', value: 1200 },
      ],
    });
    const after = await sink.readState();
    expect(Object.keys(after.params)).toHaveLength(72);
    expect(after.params['enc.Level']).toBe(2);
    expect(after.params['eq.band6.gain']).toBe(2.5);
    expect(after.params['eq.band4.q']).toBe(3);
    expect(after.params['eq.band5.freq']).toBe(1200);
    for (let band = 1; band <= 7; band += 1) {
      expect(after.bands[band - 1]).toBe(after.params[`eq.band${band}.gain`]);
    }
    expect(after.bands).toEqual([0, 0, -3.5, 0, 0, 2.5, 0]);
  });

  it('reset() 回到 72 项默认值', async () => {
    const { createDrySink } = await loadDrySink();
    const sink = createDrySink();
    await sink.write({ writes: [{ param: 'enc.Level', value: 3 }], bandWrites: [] });
    sink.reset();
    const after = await sink.readState();
    expect(Object.keys(after.params)).toHaveLength(72);
    expect(after.params['enc.Level']).toBe(0);
    expect(after.bands).toEqual([0, 0, -3.5, 0, 0, 0, 0]);
  });
});

interface ClampCase {
  readonly label: string;
  readonly input: Record<string, unknown>;
  readonly current: VoiceState;
  readonly utterance?: string;
}

/** 20 条越界 plan（验收 E2：0 例越界、preview 均含 clamped） */
const CLAMP_CASES: readonly ClampCase[] = [
  { label: 'brightness.more.strong @ band7=12/band6=12', input: plan([tune('brightness', 'more', 'strong')]), current: state({}, [0, 0, 0, 0, 0, 12, 12]) },
  { label: 'brightness.less.strong @ band7=-32/band6=-32', input: plan([tune('brightness', 'less', 'strong')]), current: state({}, [0, 0, 0, 0, 0, -32, -32]) },
  { label: 'lowEnd.more.strong @ band3=12', input: plan([tune('lowEnd', 'more', 'strong')]), current: state({}, [0, 0, 12, 0, 0, 0, 0]) },
  { label: 'lowEnd.less.strong @ band3=-32', input: plan([tune('lowEnd', 'less', 'strong')]), current: state({}, [0, 0, -32, 0, 0, 0, 0]) },
  { label: 'warmth.more.strong @ band3=12', input: plan([tune('warmth', 'more', 'strong')]), current: state({}, [0, 0, 12, 0, 0, 0, 0]) },
  { label: 'muddiness.more.strong @ band4=12', input: plan([tune('muddiness', 'more', 'strong')]), current: state({}, [0, 0, 0, 12, 0, 0, 0]) },
  { label: 'clarity.more.strong @ band5=12/band6=12', input: plan([tune('clarity', 'more', 'strong')]), current: state({}, [0, 0, 0, 0, 12, 12, 0]) },
  { label: 'sibilance.more.strong @ band7=12', input: plan([tune('sibilance', 'more', 'strong')]), current: state({}, [0, 0, 0, 0, 0, 0, 12]) },
  { label: 'harshness.less.strong @ band5=-32/band6=-32', input: plan([tune('harshness', 'less', 'strong')]), current: state({}, [0, 0, 0, 0, -32, -32, 0]) },
  { label: 'eq band4 gain more strong @ 11', input: plan([{ kind: 'eq', band: 4, field: 'gain', direction: 'more', strength: 'strong' }]), current: state({}, [0, 0, 0, 11, 0, 0, 0]) },
  { label: 'eq band4 q more strong @ 11.5', input: plan([{ kind: 'eq', band: 4, field: 'q', direction: 'more', strength: 'strong' }]), current: state({ 'eq.band4.q': 11.5 }) },
  { label: 'eq band4 q less strong @ 0.2', input: plan([{ kind: 'eq', band: 4, field: 'q', direction: 'less', strength: 'strong' }]), current: state({ 'eq.band4.q': 0.2 }) },
  { label: 'eq band6 freq more strong @ 18000 Hz', input: plan([{ kind: 'eq', band: 6, field: 'freq', direction: 'more', strength: 'strong' }]), current: state({ 'eq.band6.freq': 18000 }) },
  { label: 'eq band3 freq less strong @ 25 Hz', input: plan([{ kind: 'eq', band: 3, field: 'freq', direction: 'less', strength: 'strong' }]), current: state({ 'eq.band3.freq': 25 }) },
  { label: 'gate.more.strong @ noisegate=0 dB', input: plan([tune('gate', 'more', 'strong')]), current: state({ 'noisegate.threshold_db': 0 }) },
  { label: 'gate.less.strong @ noisegate=-85 dB', input: plan([tune('gate', 'less', 'strong')]), current: state({ 'noisegate.threshold_db': -85, 'noisegate.Enable': 1 }) },
  { label: 'loudness.more.strong @ comp.MakeUpGain=57', input: plan([tune('loudness', 'more', 'strong')]), current: state({ 'comp.MakeUpGain': 57 }) },
  { label: 'loudness.less.strong @ comp.MakeUpGain=2', input: plan([tune('loudness', 'less', 'strong')]), current: state({ 'comp.MakeUpGain': 2 }) },
  { label: 'compression.more.strong @ comp.Threshold=-55', input: plan([tune('compression', 'more', 'strong')]), current: state({ 'comp.Threshold': -55 }) },
  { label: 'set eq.band7.gain=20（原话含 20）', input: plan([{ kind: 'set', param: 'eq.band7.gain', value: 20 }]), current: state(), utterance: '第七段增益提到20' },
];

describe('7.3 夹紧 20 例（0 例越界，preview 均含 clamped）', () => {
  for (const item of CLAMP_CASES) {
    it(item.label, () => {
      const result = planToCommand(item.input, item.current, {
        turnId: 't-0100',
        utterance: item.utterance ?? '',
      });
      const produced: { id: string; value: number }[] = [
        ...result.writes.map((write) => ({ id: write.param, value: write.value })),
        ...result.bandWrites.map((write) => ({
          id: `eq.band${write.band}.${write.field}`,
          value: write.value,
        })),
      ];
      for (const write of produced) {
        const spec = specOfParamId(write.id);
        expect(spec).not.toBeNull();
        if (!spec) continue;
        expect(write.value).toBeGreaterThanOrEqual(spec.min);
        expect(write.value).toBeLessThanOrEqual(spec.max);
        if (spec.step > 0) {
          const steps = (write.value - spec.min) / spec.step;
          expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
        }
      }
      expect(result.preview.join('|')).toContain('clamped');
    });
  }

  it('20 条全部覆盖（防止有人删用例）', () => {
    expect(CLAMP_CASES).toHaveLength(20);
  });
});

/** 把 20 例的输入/输出对照打到测试输出里（完成报告直接引用） */
describe('7.3 对照表（打印用）', () => {
  it('打印输入 → 输出', () => {
    const lines: string[] = [];
    for (const item of CLAMP_CASES) {
      const result = planToCommand(item.input, item.current, {
        turnId: 't-0100',
        utterance: item.utterance ?? '',
      });
      const produced = [
        ...result.writes.map((write) => `${write.param}=${String(write.value)}`),
        ...result.bandWrites.map((write) => `eq.band${write.band}.${write.field}=${String(write.value)}`),
      ];
      lines.push(`${item.label} -> ${produced.join(', ') || '(无写入，clamped)'}`);
    }
    console.log(`\n[clamp-20]\n${lines.join('\n')}\n`);
    expect(lines).toHaveLength(20);
    // 默认状态里 band3 的增益是 -3.5：没被夹紧过的用例本来就不会出现 clamped
    expect(DEFAULT_BANDS[2]?.gain).toBe(-3.5);
  });
});
