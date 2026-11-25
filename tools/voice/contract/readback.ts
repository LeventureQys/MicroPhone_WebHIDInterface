/**
 * 回读比对（Alpha v1.3.0 / SubStage 4.2 §4.3，设计文档 §3.9 最后一行）。
 *
 * 写完立刻读回来逐项比对，不一致就由执行器回滚并报 `E_READBACK_MISMATCH`——
 * "设备接受了写入"与"设备上真的是这个值"是两件事（真机固件有过只读/范围不校验、
 * 预设区偏移的历史，见 AGENTS.md 已知坑 24/26/27），所以判据只能是回读。
 *
 * **容差按参数类型区分**（§4.3 的表格），不能一律 0：
 *
 * | 参数 | 容差 | 为什么 |
 * |---|---|---|
 * | 整数枚举（`enc.Level`、`rgb.Mode`、各 `Enable`/`OnOff`、`mic.mute`…） | 0 | 1 就是 1，差一档就是选错了档位 |
 * | `eq.band*.gain` | 0.1 dB | 步进 0.1，raw↔工程量往返可能有末位抖动 |
 * | 其它带小数的工程量（阈值、时间常数、Q、频率） | 一个 `spec.step` | 步进来自 `registers.ts`，不在这里复制 |
 * | 整数字段（`step >= 1`，如 `noisegate.attack_ms`） | 0 | 没有小数可抖 |
 * | `actual` 为 `null`（读不到） | 记 mismatch，`delta` 为 `null` | 读不到≠对得上 |
 */

import { fromRaw } from '../../../src/renderer/src/device/registers';
import { DEFAULT_PARAMS } from '../../../src/renderer/src/domain/defaults';
import { specOfParamId, type EqField, type VoiceState } from './canonicalize';

export type { EqField, VoiceState };

export interface Mismatch {
  /** `paramId`（EQ 段字段折成 `eq.bandN.<field>`，与 L2 的 `bandWrites` 同一命名） */
  param: string;
  expected: number;
  actual: number | null;
  /** `expected - actual`；`actual` 为 `null` 时也是 `null` */
  delta: number | null;
}

/** 要比对的期望写入：标量写入或 EQ 段写入（L2 的 `writes` / `bandWrites`） */
export type ExpectedWrite =
  | { readonly param: string; readonly value: number }
  | { readonly band: number; readonly field: EqField; readonly value: number };

/** `eq.band*.gain` 的容差（步进 0.1 dB） */
export const EQ_GAIN_TOLERANCE = 0.1;

const EQ_GAIN_RE = /^eq\.band([1-7])\.gain$/;
const BAND_ID_RE = /^eq\.band([1-7])\.(type|freq|gain|q)$/;
const EPS = 1e-9;

/** 期望写入 → `paramId` */
export function paramIdOf(write: ExpectedWrite): string {
  return 'param' in write ? write.param : `eq.band${write.band}.${write.field}`;
}

/** 该参数的容差（见文件头表格） */
export function toleranceOf(paramId: string): number {
  if (EQ_GAIN_RE.test(paramId)) return EQ_GAIN_TOLERANCE;
  const spec = specOfParamId(paramId);
  if (!spec) return 0;
  return spec.step > 0 && spec.step < 1 ? spec.step : 0;
}

/**
 * 从回读状态里取一项；取不到返回 `null`（**不做默认值兜底**——兜底会让"读不到"变成"对得上"）。
 *
 * `eq.bandN.gain` 先看 `params`，再看 `bands`：`bands` 只是 7 段增益的便捷视图，
 * 两种 sink 都由 `params` 派生；万一某个 sink 只回 `bands`，这里也能取到。
 */
export function actualValueOf(paramId: string, actual: VoiceState): number | null {
  const fromParams = actual?.params?.[paramId];
  if (typeof fromParams === 'number' && Number.isFinite(fromParams)) return fromParams;
  const gainMatch = EQ_GAIN_RE.exec(paramId);
  if (gainMatch) {
    const band = Number(gainMatch[1]);
    const bands = actual?.bands;
    if (Array.isArray(bands)) {
      const fromBands = bands[band - 1];
      if (typeof fromBands === 'number' && Number.isFinite(fromBands)) return fromBands;
    }
  }
  return null;
}

/**
 * 当前值（**带兜底**）：撤销快照要用"设备上现在是多少"，读不到时退到产品默认值，
 * 不能退成 0——否则撤销会把参数写成 0。
 */
export function currentValueOf(paramId: string, state: VoiceState): number {
  const value = actualValueOf(paramId, state);
  if (value !== null) return value;
  const fromDefaults = DEFAULT_PARAMS[paramId];
  if (typeof fromDefaults === 'number' && Number.isFinite(fromDefaults)) return fromDefaults;
  const bandMatch = BAND_ID_RE.exec(paramId);
  if (bandMatch) {
    const fallback = DEFAULT_PARAMS[`eq.band${bandMatch[1]}.gain`];
    if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  }
  const spec = specOfParamId(paramId);
  if (spec) return fromRaw(spec, spec.defaultRaw);
  return 0;
}

/** 逐项比对；返回顺序与 `expected` 一致（便于把 mismatch 直接塞进日志与响应） */
export function compare(expected: ReadonlyArray<ExpectedWrite>, actual: VoiceState): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const write of expected) {
    const param = paramIdOf(write);
    const value = actualValueOf(param, actual);
    if (value === null) {
      mismatches.push({ param, expected: write.value, actual: null, delta: null });
      continue;
    }
    const delta = write.value - value;
    const tolerance = toleranceOf(param);
    if (Math.abs(delta) > tolerance + EPS) {
      mismatches.push({ param, expected: write.value, actual: value, delta });
    }
  }
  return mismatches;
}
