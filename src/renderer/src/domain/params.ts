import type { RegisterRegion, RegisterScale } from '../device/registers';
import { defaultOf, findRegister } from '../device/registers';

export type ModuleId = 'gain' | 'noisegate' | 'comp' | 'limit' | 'eq' | 'enc' | 'drc3';

export type ParamUnit = 'dB' | 'Hz' | 'ms' | 's' | '';

export interface ParamSpec {
  /** 形如 'noisegate.threshold_db'，全局唯一 */
  readonly id: string;
  readonly module: ModuleId;
  /** 协议字段名，原样展示，不翻译成语义标签 */
  readonly field: string;
  readonly unit: ParamUnit;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 工程量默认值，= defaultOf(寄存器) */
  readonly default: number;
  /** true = 只读展示，不提供控件 */
  readonly readonly: boolean;
  /** 寄存器地址（真值源：M001参数表V0.1.xlsx） */
  readonly addr: number;
  /** 工程量 ↔ 寄存器原始值的标定式 */
  readonly scale: RegisterScale;
  /** 所属寄存器区段 */
  readonly block: RegisterRegion;
}

interface ParamSeed {
  readonly id: string;
  readonly module: ModuleId;
  readonly addr: number;
}

/**
 * 42 项参数的 id → 地址映射。范围 / 步进 / 单位 / 默认值 / 权限 / 标定全部由
 * `device/registers.ts` 按地址查表得到，这里不复制任何数值（需求 R2-2）。
 * 顺序按设计文档 §5.3 定稿表，便于逐行人工比对。
 */
const SEEDS: readonly ParamSeed[] = Object.freeze([
  { id: 'gain.Mic', module: 'gain', addr: 0x2023 },
  { id: 'gain.Hp', module: 'gain', addr: 0x205a },
  { id: 'mic.mute', module: 'gain', addr: 0x2022 },
  { id: 'mic.sigMute', module: 'gain', addr: 0x2058 },
  { id: 'hp.OnOff', module: 'gain', addr: 0x2059 },

  { id: 'enc.OnOff', module: 'enc', addr: 0x2024 },
  { id: 'enc.Level', module: 'enc', addr: 0x2025 },

  { id: 'eq.mode', module: 'eq', addr: 0x2026 },

  { id: 'comp.Enable', module: 'comp', addr: 0x204a },
  { id: 'comp.MakeUpGain', module: 'comp', addr: 0x204b },
  { id: 'comp.Threshold', module: 'comp', addr: 0x204c },
  { id: 'comp.Attack', module: 'comp', addr: 0x204d },
  { id: 'comp.Release', module: 'comp', addr: 0x204e },
  { id: 'comp.Rate', module: 'comp', addr: 0x204f },
  { id: 'comp.KneeWidth', module: 'comp', addr: 0x2050 },

  { id: 'limit.Enable', module: 'limit', addr: 0x2051 },
  { id: 'limit.Threshold', module: 'limit', addr: 0x2053 },
  { id: 'limit.Attack', module: 'limit', addr: 0x2054 },
  { id: 'limit.Release', module: 'limit', addr: 0x2055 },

  { id: 'noisegate.threshold_db', module: 'noisegate', addr: 0x205b },
  { id: 'noisegate.ratio', module: 'noisegate', addr: 0x205c },
  { id: 'noisegate.attack_ms', module: 'noisegate', addr: 0x205d },
  { id: 'noisegate.release_ms', module: 'noisegate', addr: 0x205e },
  { id: 'noisegate.knee_width_db', module: 'noisegate', addr: 0x205f },
  { id: 'noisegate.hp_freq', module: 'noisegate', addr: 0x2060 },

  { id: 'drc3.fc1', module: 'drc3', addr: 0x2061 },
  { id: 'drc3.fc2', module: 'drc3', addr: 0x2062 },
  { id: 'drc3.low.preGain', module: 'drc3', addr: 0x2063 },
  { id: 'drc3.low.threshold', module: 'drc3', addr: 0x2064 },
  { id: 'drc3.low.attackTime', module: 'drc3', addr: 0x2065 },
  { id: 'drc3.low.releaseTime', module: 'drc3', addr: 0x2066 },
  { id: 'drc3.low.ratio', module: 'drc3', addr: 0x2067 },
  { id: 'drc3.high.preGain', module: 'drc3', addr: 0x2068 },
  { id: 'drc3.high.threshold', module: 'drc3', addr: 0x2069 },
  { id: 'drc3.high.attackTime', module: 'drc3', addr: 0x206a },
  { id: 'drc3.high.releaseTime', module: 'drc3', addr: 0x206b },
  { id: 'drc3.high.ratio', module: 'drc3', addr: 0x206c },
  { id: 'drc3.mid.preGain', module: 'drc3', addr: 0x206d },
  { id: 'drc3.mid.threshold', module: 'drc3', addr: 0x206e },
  { id: 'drc3.mid.attackTime', module: 'drc3', addr: 0x206f },
  { id: 'drc3.mid.releaseTime', module: 'drc3', addr: 0x2070 },
  { id: 'drc3.mid.ratio', module: 'drc3', addr: 0x2071 },
]);

function toParam(seed: ParamSeed): ParamSpec {
  const register = findRegister(seed.addr);
  if (!register) {
    throw new Error(`register 0x${seed.addr.toString(16)} missing for param ${seed.id}`);
  }
  return Object.freeze({
    id: seed.id,
    module: seed.module,
    field: seed.id.slice(seed.id.lastIndexOf('.') + 1),
    unit: register.unit,
    min: register.min,
    max: register.max,
    step: register.step,
    default: defaultOf(register),
    readonly: register.access === 'r',
    addr: register.addr,
    scale: register.scale,
    block: register.region,
  });
}

/** 42 项标量参数，全部由 `REGISTERS` 派生 */
export const PARAMS: readonly ParamSpec[] = Object.freeze(SEEDS.map(toParam));

const BY_ID = new Map(PARAMS.map((item) => [item.id, item]));
const BY_ADDR = new Map(PARAMS.map((item) => [item.addr, item]));

export function findParam(id: string): ParamSpec | undefined {
  return BY_ID.get(id);
}

export function findParamByAddr(addr: number): ParamSpec | undefined {
  return BY_ADDR.get(addr);
}

export function paramsOf(module: ModuleId): readonly ParamSpec[] {
  return PARAMS.filter((item) => item.module === module);
}
