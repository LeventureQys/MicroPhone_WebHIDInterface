export type ModuleId = 'gain' | 'noisegate' | 'comp' | 'limit' | 'eq' | 'enc' | 'drc3';

export type ParamUnit = 'dB' | 'Hz' | 'ms' | 's' | '';

export interface ParamSpec {
  /** 形如 'noisegate.threshold_db'，全局唯一 */
  id: string;
  module: ModuleId;
  /** 协议字段名，原样展示，不翻译成语义标签 */
  field: string;
  unit: ParamUnit;
  min: number;
  max: number;
  step: number;
  default: number;
  /** true = 只读展示，不提供控件 */
  readonly: boolean;
}

function spec(
  id: string,
  module: ModuleId,
  field: string,
  unit: ParamUnit,
  min: number,
  max: number,
  step: number,
  def: number,
  readonly = false,
): ParamSpec {
  return { id, module, field, unit, min, max, step, default: def, readonly };
}

/** 36 项标量参数，来源 Document/Protocol/效果器参数范围.xlsx */
export const PARAMS: readonly ParamSpec[] = Object.freeze([
  spec('gain.Mic', 'gain', 'Mic', 'dB', -27, 36, 1, 5, true),
  spec('gain.Hp', 'gain', 'Hp', 'dB', -40, 0, 1, 0, true),

  spec('noisegate.threshold_db', 'noisegate', 'threshold_db', 'dB', -91, 0, 1, -70),
  spec('noisegate.ratio', 'noisegate', 'ratio', '', 0.05, 0.999, 0.001, 0.333),
  spec('noisegate.attack_ms', 'noisegate', 'attack_ms', 'ms', 5, 500, 1, 10),
  spec('noisegate.release_ms', 'noisegate', 'release_ms', 'ms', 5, 500, 1, 200),
  spec('noisegate.knee_width_db', 'noisegate', 'knee_width_db', 'dB', 6, 12, 1, 12),
  spec('noisegate.hp_freq', 'noisegate', 'hp_freq', 'Hz', 60, 200, 1, 150),

  spec('comp.MakeUpGain', 'comp', 'MakeUpGain', 'dB', 0, 60, 0.1, 0),
  spec('comp.Threshold', 'comp', 'Threshold', 'dB', -60, 0, 0.1, -60),
  spec('comp.Attack', 'comp', 'Attack', 's', 0.0001, 0.2, 0.0001, 0.0005),
  spec('comp.Release', 'comp', 'Release', 's', 0.005, 2, 0.0001, 0.1),
  spec('comp.Rate', 'comp', 'Rate', '', 1, 100, 0.1, 6),
  spec('comp.KneeWidth', 'comp', 'KneeWidth', 'dB', 0, 60, 0.1, 1),

  spec('limit.Threshold', 'limit', 'Threshold', 'dB', -60, 0, 0.1, -60),
  spec('limit.Attack', 'limit', 'Attack', 's', 0.0001, 0.2, 0.0001, 0.0005),
  spec('limit.Release', 'limit', 'Release', 's', 0.005, 2, 0.0001, 0.05),

  spec('enc.OnOff', 'enc', 'OnOff', '', 0, 1, 1, 0),
  spec('enc.Level', 'enc', 'Level', '', 0, 3, 1, 1),

  spec('drc3.fc1', 'drc3', 'fc1', 'Hz', 50, 10000, 1, 1000),
  spec('drc3.fc2', 'drc3', 'fc2', 'Hz', 50, 10000, 1, 3000),

  spec('drc3.low.preGain', 'drc3', 'preGain', '', 0, 4, 0.01, 1.28),
  spec('drc3.low.threshold', 'drc3', 'threshold', 'dB', -80, 0, 0.1, 0),
  spec('drc3.low.attackTime', 'drc3', 'attackTime', 'ms', 1, 400, 1, 10),
  spec('drc3.low.releaseTime', 'drc3', 'releaseTime', 'ms', 5, 680, 1, 20),
  spec('drc3.low.ratio', 'drc3', 'ratio', '', 1, 20, 0.1, 10),

  spec('drc3.mid.preGain', 'drc3', 'preGain', '', 0, 4, 0.01, 1.28),
  spec('drc3.mid.threshold', 'drc3', 'threshold', 'dB', -80, 0, 0.1, 0),
  spec('drc3.mid.attackTime', 'drc3', 'attackTime', 'ms', 1, 400, 1, 10),
  spec('drc3.mid.releaseTime', 'drc3', 'releaseTime', 'ms', 5, 680, 1, 20),
  spec('drc3.mid.ratio', 'drc3', 'ratio', '', 1, 20, 0.1, 10),

  spec('drc3.high.preGain', 'drc3', 'preGain', '', 0, 4, 0.01, 1.28),
  spec('drc3.high.threshold', 'drc3', 'threshold', 'dB', -80, 0, 0.1, 0),
  spec('drc3.high.attackTime', 'drc3', 'attackTime', 'ms', 1, 400, 1, 10),
  spec('drc3.high.releaseTime', 'drc3', 'releaseTime', 'ms', 5, 680, 1, 20),
  spec('drc3.high.ratio', 'drc3', 'ratio', '', 1, 20, 0.1, 10),
]);

const BY_ID = new Map(PARAMS.map((item) => [item.id, item]));

export function findParam(id: string): ParamSpec | undefined {
  return BY_ID.get(id);
}

export function paramsOf(module: ModuleId): readonly ParamSpec[] {
  return PARAMS.filter((item) => item.module === module);
}
