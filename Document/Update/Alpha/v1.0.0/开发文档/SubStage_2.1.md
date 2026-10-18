# SubStage 2.1 — 参数规格、数值规则与默认值

- 所属 Stage：Stage 2
- 依赖前置：SubStage 1.1（需要 `tsconfig.json` 路径别名、`vitest.config.ts`）
- 并行状态：可与 SubStage 2.2、2.3 并行（文件不重叠）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

全部可调参数的唯一真值源。范围、步进、默认值来自 `Document/Protocol/效果器参数范围.xlsx`，任何模块不得重写这些字面量。本 SubStage 只产出纯数据与纯函数 + 单测，不含任何 DOM。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/domain/params.ts` | `ParamSpec` 类型、`PARAMS`、`findParam`、`paramsOf` |
| `src/renderer/src/domain/values.ts` | `clampValue`、`quantize`、`formatValue`、`parseInput` |
| `src/renderer/src/domain/defaults.ts` | `DEFAULT_PARAMS`（id→默认值）、`DEFAULT_BANDS`（14 段 EQ）、`DEFAULT_LANG` |
| `tests/unit/params.test.ts` | 规格表完整性 |
| `tests/unit/values.test.ts` | 数值规则 |

## 3. 契约

### 3.1 `PARAMS` 完整清单（36 项，按此顺序声明）

格式：`id | module | field | unit | min | max | step | default | readonly`

```
gain.Mic            | gain      | Mic            | dB | -27    | 36    | 1      | 5      | true
gain.Hp             | gain      | Hp             | dB | -40    | 0     | 1      | 0      | true
noisegate.threshold_db | noisegate | threshold_db | dB | -91   | 0     | 1      | -70    | false
noisegate.ratio     | noisegate | ratio          | '' | 0.05   | 0.999 | 0.001  | 0.333  | false
noisegate.attack_ms | noisegate | attack_ms      | ms | 5      | 500   | 1      | 10     | false
noisegate.release_ms| noisegate | release_ms     | ms | 5      | 500   | 1      | 200    | false
noisegate.knee_width_db | noisegate | knee_width_db | dB | 6  | 12    | 1      | 12     | false
noisegate.hp_freq   | noisegate | hp_freq        | Hz | 60     | 200   | 1      | 150    | false
comp.MakeUpGain     | comp      | MakeUpGain     | dB | 0      | 60    | 0.1    | 0      | false
comp.Threshold      | comp      | Threshold      | dB | -60    | 0     | 0.1    | -60    | false
comp.Attack         | comp      | Attack         | s  | 0.0001 | 0.2   | 0.0001 | 0.0005 | false
comp.Release        | comp      | Release        | s  | 0.005  | 2     | 0.0001 | 0.1    | false
comp.Rate           | comp      | Rate           | '' | 1      | 100   | 0.1    | 6      | false
comp.KneeWidth      | comp      | KneeWidth      | dB | 0      | 60    | 0.1    | 1      | false
limit.Threshold     | limit     | Threshold      | dB | -60    | 0     | 0.1    | -60    | false
limit.Attack        | limit     | Attack         | s  | 0.0001 | 0.2   | 0.0001 | 0.0005 | false
limit.Release       | limit     | Release        | s  | 0.005  | 2     | 0.0001 | 0.05   | false
enc.OnOff           | enc       | OnOff          | '' | 0      | 1     | 1      | 0      | false
enc.Level           | enc       | Level          | '' | 0      | 3     | 1      | 1      | false
drc3.fc1            | drc3      | fc1            | Hz | 50     | 10000 | 1      | 1000   | false
drc3.fc2            | drc3      | fc2            | Hz | 50     | 10000 | 1      | 3000   | false
drc3.low.preGain    | drc3      | preGain        | '' | 0      | 4     | 0.01   | 1.28   | false
drc3.low.threshold  | drc3      | threshold      | dB | -80    | 0     | 0.1    | 0      | false
drc3.low.attackTime | drc3      | attackTime     | ms | 1      | 400   | 1      | 10     | false
drc3.low.releaseTime| drc3      | releaseTime    | ms | 5      | 680   | 1      | 20     | false
drc3.low.ratio      | drc3      | ratio          | '' | 1      | 20    | 0.1    | 10     | false
drc3.mid.preGain    | drc3      | preGain        | '' | 0      | 4     | 0.01   | 1.28   | false
drc3.mid.threshold  | drc3      | threshold      | dB | -80    | 0     | 0.1    | 0      | false
drc3.mid.attackTime | drc3      | attackTime     | ms | 1      | 400   | 1      | 10     | false
drc3.mid.releaseTime| drc3      | releaseTime    | ms | 5      | 680   | 1      | 20     | false
drc3.mid.ratio      | drc3      | ratio          | '' | 1      | 20    | 0.1    | 10     | false
drc3.high.preGain   | drc3      | preGain        | '' | 0      | 4     | 0.01   | 1.28   | false
drc3.high.threshold | drc3      | threshold      | dB | -80    | 0     | 0.1    | 0      | false
drc3.high.attackTime| drc3      | attackTime     | ms | 1      | 400   | 1      | 10     | false
drc3.high.releaseTime | drc3    | releaseTime    | ms | 5      | 680   | 1      | 20     | false
drc3.high.ratio     | drc3      | ratio          | '' | 1      | 20    | 0.1    | 10     | false
```

`ParamSpec`/`ModuleId` 类型定义见设计文档 §5.1（此处照抄，不得增删字段）：

```ts
export type ModuleId = 'gain' | 'noisegate' | 'comp' | 'limit' | 'eq' | 'enc' | 'drc3';
export interface ParamSpec {
  id: string; module: ModuleId; field: string;
  unit: 'dB' | 'Hz' | 'ms' | 's' | '';
  min: number; max: number; step: number; default: number; readonly: boolean;
}
```

`unit` 为 `''` 的参数在 UI 不显示单位后缀（`Comp.Rate`、`NoiseGate.ratio`、`ENC.*`、`3BandDrc.preGain/ratio`）。

### 3.2 数值函数

```ts
export function clampValue(spec: ParamSpec, raw: number): number;
// NaN / ±Infinity / 非数 → 返回 spec.default；否则 clamp 到 [min,max]

export function quantize(spec: ParamSpec, value: number): number;
// 先 clampValue，再 Math.round((v - min) / step) * step + min，结果按 1e6 精度修正浮点误差后再 clamp 一次
// 例：noisegate.ratio 输入 0.3335 → 0.333（step 0.001）；drc3.low.preGain 输入 1.285 → 1.28

export function formatValue(spec: ParamSpec, value: number): string;
// 量化后用"最短表示"：先 toFixed(按 step 推导的位数)，再去除尾部 0 与孤立的 '.'
// 0.1 → "0.1"；0.0005 → "0.0005"；6 → "6"；1.28 → "1.28"；-60 → "-60"
// 位推导：step >= 1 → 0 位；>=0.1 → 1；>=0.01 → 2；>=0.001 → 3；否则 4

export function parseInput(spec: ParamSpec, text: string): number | null;
// trim 后为空、NaN → null；否则返回 quantize(spec, Number(text))（不做本地化小数点处理）
```

### 3.3 `defaults.ts`

```ts
export const DEFAULT_PARAMS: Readonly<Record<string, number>>;  // 36 项 id → spec.default
export const DEFAULT_BANDS: readonly EqBand[];                  // 14 段
export const DEFAULT_LANG: 'zh';
```

`DEFAULT_BANDS`：14 段，`type = 0`（PEAK），`gain = 0`，`q = 0.7`，段号 0..13。

- 可调段 `0..6` 在对数轴上等距铺满 20–20000 Hz：`freq[k] = Math.round(20 * Math.pow(10, 0.5 * k))`，k = 0..6 → 20 / 63 / 200 / 632 / 2000 / 6325 / 20000。
- 内部段 `7..13` 插在可调段之间，对数轴位置 `[0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 2.95]`：`freq[7 + j] = Math.round(20 * Math.pow(10, pos[j]))` → 36 / 112 / 356 / 1122 / 3556 / 11220 / 17825。

实现必须由公式生成（位置序列可以写成常量数组），不得把最终频率值手填成 14 个魔法数。`EqBand` 按 index 升序排列，`freq` 允许交错（不同段是独立滤波器）。

`EqBand` 类型定义见设计文档 §5.3（此处照抄）：

```ts
export type EqFilterType = 0 | 1 | 2 | 3 | 4;
export interface EqBand { index: number; type: EqFilterType; freq: number; gain: number; q: number }
```

`defaults.ts` 需要 import `EqBand` 类型，但不得 import `eq/model.ts`（避免循环依赖）；把 `EqBand`/`EqFilterType` 声明在 `src/renderer/src/eq/types.ts`，供两处引用。

## 4. 单元测试（`tests/unit/`）

`params.test.ts` 必须覆盖：

1. `PARAMS.length === 36`。
2. 所有 `id` 唯一。
3. 每个 spec 满足 `min <= default <= max`、`step > 0`、`(max-min)/step` 为近似整数（误差 <1e-6）。
4. 逐模块计数：gain 2、noisegate 6、comp 6、limit 3、enc 2、drc3 17。
5. `gain.Mic` 与 `gain.Hp` 的 `readonly === true`，其余全部 `false`。
6. `findParam('noisegate.threshold_db')` 返回对应规格；`findParam('nope')` 返回 `undefined`。

`values.test.ts` 必须覆盖：

1. `quantize` 正常路径：`noisegate.ratio` 0.3335 → 0.333。
2. 边界：低于 min、高于 max 都被夹紧（如 `gain.Mic` 999 → 36）。
3. 异常：`clampValue(spec, NaN)` → `spec.default`；`clampValue(spec, Infinity)` → `spec.max`。
4. `formatValue`：`comp.Attack` 0.0005 → `'0.0005'`；`comp.Release` 0.1 → `'0.1'`；`comp.Rate` 6 → `'6'`；`limit.Threshold` -60 → `'-60'`。
5. `parseInput`：空串 → `null`；`'abc'` → `null`；`'12.34'`（`drc3.low.preGain`）→ 1.28 之外的合法值如 `'3.21'` → 3.21。
6. `DEFAULT_BANDS.length === 14`，全部 `gain === 0`、`q === 0.7`、`type === 0`；可调段 `0..6` 的 `freq` 严格递增、首段 20、末段 20000；全部 14 段 `freq` 落在 `[20, 20000]`。

## 5. 输入输出

- 输入：本任务书 §3 的表格。
- 输出：三个 `.ts` 模块 + 两个测试文件；被 SubStage 2.3、3.1、3.4 引用。

## 6. 验收标准

1. `pnpm run test` 中 `params.test.ts`、`values.test.ts` 全绿，贴真实输出。
2. `pnpm run typecheck` 通过。
3. `grep -c "min:" src/renderer/src/domain/params.ts` 之类抽查数量与 36 一致（可用 `PARAMS.length` 断言代替）。

## 7. 禁止事项

- 不得把范围/默认值写进 UI 或其他模块。
- 不得给 `Comp.Rate`、`NoiseGate.ratio` 添加中文语义标签或做倒数换算。
- 不得在 `params.ts` 里引入 DOM / Electron 依赖。
- 不得修改 `Document/` 下任何文件。

## 8. 错误处理契约

- 本 SubStage 的函数**不抛异常**（除编程错误）：非法数值一律回落到 `default` 或 `null`。
- 测试失败必须修到通过；若发现任务书表格与 `效果器参数范围.xlsx` 不一致，以 xlsx 为准并在完成报告里指出差异（不要私自改表格）。

## 9. 依赖前置

需等待 SubStage 1.1 完成，从 `tsconfig.json` 与 `vitest.config.ts` 获取路径别名与测试环境配置。1.1 完成后即可开工，与 2.2、2.3 并行。
