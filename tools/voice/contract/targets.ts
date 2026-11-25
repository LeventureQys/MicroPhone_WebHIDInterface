/**
 * 语义目标与 paramId 白名单（Alpha v1.3.0 / SubStage 3.1）。
 *
 * 本文件**不定义任何数值或说法**，只把 `kb.ts` 的知识投影成两份列表：
 *
 * - `TUNE_TARGETS` / `TOGGLE_TARGETS`：13 + 7 个目标 id，顺序即 kb 顺序（设计文档 §3.1）；
 * - `PARAM_IDS`：执行器收 `set` 动作时的白名单（设计文档 §3.2 / §3.5）；
 * - `TARGET_WRITABLE`：每个目标能改写的 paramId（含开关动作与条件动作）。
 *
 * `PARAM_IDS` 的派生规则（**不许手抄**）：可写标量取 `domain/params.ts` 里 `readonly === false`
 * 的 44 项（`gain.Mic` / `gain.Hp` 在寄存器表里是 `access:'r'`，语音层与 `AppStore.setParam`
 * 同口径拒写，见问题清单 D7），再拼 7 段 × 4 字段的 28 个 EQ 字段 = **72**。
 *
 * > 与设计文档 §3.2 的"共 74 个"的差异：那处把 46 项标量整体计入，实际 `readonly` 的 2 项
 * > （`gain.Mic`、`gain.Hp`）按 D7 与设计文档 §3.3 的 `excluded` 表都不可写，故白名单是 72。
 * > 计数由本文件的派生代码自动得出，`emit.mjs` 打印的 `paramIds=` 即实际值。
 */

import { PARAMS } from '../../../src/renderer/src/domain/params';
import {
  DIMENSIONS,
  TOGGLE_RULES,
  TOGGLE_TARGET_IDS,
  TUNE_TARGET_IDS,
  paramIdOfAction,
  type Strength,
  type ToggleTarget,
  type TuneTarget,
} from './kb';

export type { Direction, EqField, Strength, ToggleTarget, TuneTarget } from './kb';

/** 13 个可调目标，顺序即 kb 顺序 */
export const TUNE_TARGETS: readonly TuneTarget[] = Object.freeze([...TUNE_TARGET_IDS]);

/** 7 个可开关目标 */
export const TOGGLE_TARGETS: readonly ToggleTarget[] = Object.freeze([...TOGGLE_TARGET_IDS]);

/** EQ 段字段顺序（与 `device/registers.ts` 的 `eqBandAddr` 接受的字段一致） */
export const EQ_FIELDS: readonly ('type' | 'freq' | 'gain' | 'q')[] = Object.freeze([
  'type',
  'freq',
  'gain',
  'q',
]);

/** 可写标量：`PARAMS` 里非只读的 44 项，顺序与 `PARAMS` 一致 */
function scalarParamIds(): readonly string[] {
  return PARAMS.filter((param) => !param.readonly).map((param) => param.id);
}

/** 28 个 EQ 字段 id：`eq.band1.type` … `eq.band7.q` */
function eqParamIds(): readonly string[] {
  const ids: string[] = [];
  for (let band = 1; band <= 7; band += 1) {
    for (const field of EQ_FIELDS) ids.push(`eq.band${band}.${field}`);
  }
  return ids;
}

/** 执行器 `set` 动作的白名单（44 标量 + 28 EQ 段字段 = 72） */
export const PARAM_IDS: readonly string[] = Object.freeze([...scalarParamIds(), ...eqParamIds()]);

const PARAM_ID_SET = new Set(PARAM_IDS);

/** 判断 id 是否在白名单内（执行器用；`set` 落表外的 id 直接丢弃） */
export function isParamId(id: string): boolean {
  return PARAM_ID_SET.has(id);
}

function toggleWritable(target: ToggleTarget): readonly string[] {
  const rule = TOGGLE_RULES[target];
  const ids = new Set<string>();
  for (const action of [...rule.on, ...rule.off]) ids.add(paramIdOfAction(action));
  return Object.freeze([...ids].sort());
}

function buildTargetWritable(): Readonly<Record<TuneTarget | ToggleTarget, readonly string[]>> {
  const table: Record<string, readonly string[]> = {};
  for (const dimension of DIMENSIONS) table[dimension.id] = dimension.writable;
  for (const target of TOGGLE_TARGETS) {
    const fromToggle = toggleWritable(target);
    const existing = table[target];
    if (existing === undefined) {
      table[target] = fromToggle;
      continue;
    }
    // 调参目标与开关目标同名（gate / limiter / compression / noiseFloor / rgbMode）时取并集
    table[target] = Object.freeze([...new Set([...existing, ...fromToggle])].sort());
  }
  return Object.freeze(table as Record<TuneTarget | ToggleTarget, readonly string[]>);
}

/** 每个目标允许改写的 paramId；调参与开关同名时取并集 */
export const TARGET_WRITABLE: Readonly<Record<TuneTarget | ToggleTarget, readonly string[]>> =
  buildTargetWritable();

/** 三档（顺序即 L1 的枚举顺序） */
export const STRENGTH_IDS: readonly Strength[] = Object.freeze(['slight', 'medium', 'strong']);
