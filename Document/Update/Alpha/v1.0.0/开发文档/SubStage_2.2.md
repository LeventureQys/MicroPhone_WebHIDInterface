# SubStage 2.2 — EQ 频响数学、坐标映射与段模型

- 所属 Stage：Stage 2
- 依赖前置：SubStage 1.1（构建与测试环境）；需要 `src/renderer/src/eq/types.ts`（若 2.1 已创建则复用，否则本 SubStage 创建，见 §3.1）
- 并行状态：可与 SubStage 2.1、2.3 并行（文件不重叠）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

EQ 曲线是本次 UI 的核心视觉。本 SubStage 只产出纯计算与数据模型：滤波器频响、曲线采样、对数坐标映射、14 段模型。**不含任何 DOM、Canvas 或事件绑定到界面**。

数学实现参照 MIT 许可项目 `AudioEQ_Visualized_Web`（本地只读副本 `D:\Temp\ref-eq\AudioEQ_Visualized_Web-main`，关键文件 `src/core/filter/ButterworthIIR.js`、`src/core/CoordinateMapper.js`）。移植时在文件头写明来源与 MIT 归属。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/eq/types.ts` | `EqFilterType`、`EqBand`、`CurvePoint`、`Viewport` 类型 |
| `src/renderer/src/eq/curve.ts` | biquad 系数、频响求值、`computeCurve` |
| `src/renderer/src/eq/mapper.ts` | `FreqMapper` |
| `src/renderer/src/eq/model.ts` | `EqModel`（EventTarget） |
| `tests/unit/curve.test.ts` | 频响与曲线采样 |
| `tests/unit/mapper.test.ts` | 坐标映射与刻度 |
| `tests/unit/eq-model.test.ts` | 段模型行为与事件 |

## 3. 契约

### 3.1 `types.ts`

```ts
export type EqFilterType = 0 | 1 | 2 | 3 | 4;   // 0 PEAK, 1 LS, 2 HS, 3 LPF, 4 HPF
export interface EqBand { index: number; type: EqFilterType; freq: number; gain: number; q: number }
export interface CurvePoint { freq: number; gainDb: number }
export interface Viewport { x: number; y: number; width: number; height: number }
```

若 SubStage 2.1 已创建同内容文件，以其为准；`eq/types.ts` 的所有权归 SubStage 2.1，本 SubStage 只 import，不得重建第二份。若 2.1 尚未落盘又必须先跑测试，可临时创建该文件（内容必须与本节逐字一致），并在完成报告里注明"待 2.1 复用"，集成时只保留一份。

### 3.2 `curve.ts`

```ts
export interface BiquadCoeff { b0: number; b1: number; b2: number; a1: number; a2: number }

export function makePeak(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff;
export function makeLowShelf(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff;
export function makeHighShelf(freq: number, q: number, gainDb: number, sampleRate: number): BiquadCoeff;
export function makeLowPass(freq: number, sampleRate: number, q: number): BiquadCoeff;
export function makeHighPass(freq: number, sampleRate: number, q: number): BiquadCoeff;
export function biquadGainDb(coeff: BiquadCoeff, freq: number, sampleRate: number): number;

export function bandGainDb(band: EqBand, freq: number, sampleRate: number): number;
// type 0 → PEAK，1 → low shelf，2 → high shelf，3 → low pass，4 → high pass；未知 type 返回 0

export function computeCurve(
  bands: readonly EqBand[],
  opts?: { sampleRate?: number; pointCount?: number; freqMin?: number; freqMax?: number },
): CurvePoint[];
// 默认 sampleRate 48000、pointCount 480、freqMin 20、freqMax 20000
// 频率点按对数等距：f[i] = freqMin * (freqMax/freqMin)^(i/(pointCount-1))
// 每个点 = Σ bandGainDb(band, f, sampleRate)；gain===0 且 type===0 的段直接跳过
```

数值安全：所有截止频率在使用前 clamp 到 `[freqMin, min(freqMax, sampleRate/2 * 0.999)]`；`q <= 0` 时按 0.1 处理；`sampleRate <= 40` 时视为 48000。

参照实现的系数公式（RBJ cookbook + BLT Butterworth）直接沿用，不自行推导。

### 3.3 `mapper.ts`

```ts
export class FreqMapper {
  constructor(viewport: Viewport, freqMin = 20, freqMax = 20000, gainMin = -24, gainMax = 12);
  freqToX(freq: number): number;
  xToFreq(x: number): number;
  gainToY(gainDb: number): number;
  yToGain(y: number): number;
  setViewport(v: Viewport): void;
  get freqMin(): number; get freqMax(): number;
  get gainMin(): number; get gainMax(): number;
  static freqTicks(freqMin: number, freqMax: number): number[];      // 1-2-5 序列，落在区间内
  static gainTicks(gainMin: number, gainMax: number, step?: number): number[];  // 默认 step 6
}
```

映射为对数频率轴 + 线性增益轴；`xToFreq`/`yToGain` 结果夹紧到各自范围。

### 3.4 `model.ts`

```ts
export class EqModel extends EventTarget {
  constructor(bands?: readonly EqBand[]);
  bandAt(index: number): EqBand | undefined;     // 副本
  allBands(): readonly EqBand[];                 // 副本，index 升序
  setBand(index: number, patch: Partial<Pick<EqBand, 'type' | 'freq' | 'gain' | 'q'>>): void;
  resetBandGain(index: number): void;            // gain → 0，q → 0.7
  focusedIndex(): number;
  setFocused(index: number): void;
  visibleCount(): number;                        // 常量 7
}
```

行为规则：

1. `setBand` 对 `freq` 夹紧到 `[20, 20000]` 并按 step 1 取整；`gain` 夹紧到 `[-32, 12]`、step 0.1；`q` 夹紧到 `[0.1, 12]`、step 0.1；`type` 夹紧到 `0..4` 取整。浮点误差按 1e6 修正。
2. 越界 `index` 静默忽略（不抛异常）。
3. 值无变化时不派发事件。
4. 每次有效变更派发 `new CustomEvent('band-changed', { detail: { index, band } })`，`band` 为变更后的副本。
5. `setFocused(index)`：`index` 不在 `0..13` 且不是 `-1` 时视为 `-1`；变化时派发 `new CustomEvent('focus-changed', { detail: { index } })`。
6. 构造时未传 `bands` → 使用 `defaults.ts` 的 `DEFAULT_BANDS`（若 `defaults.ts` 尚不存在，则内置同样的 14 段生成逻辑并加注释，等 2.1 落盘后改为引用）。

## 4. 单元测试

`curve.test.ts`：

1. 无任何段时 `computeCurve` 全为 0 dB。
2. PEAK 段（1000 Hz, +6 dB, Q 1）在 1000 Hz 处增益 ≈ 6 dB（误差 < 0.01），在 20 Hz 与 20000 Hz 处 |gain| < 0.2。
3. 14 段全零 → 曲线全零。
4. LPF（1000 Hz）在 20000 Hz 处增益 < -20 dB；HPF（1000 Hz）在 20 Hz 处增益 < -20 dB。
5. 边界：`q = 0` 不产生 NaN；`freq = 1` 或 `freq = 30000` 不产生 NaN（clamp 生效）。断言 `Number.isFinite` 覆盖所有返回点。
6. `computeCurve` 返回长度等于 `pointCount`，且首点频率 = freqMin、末点 = freqMax。

`mapper.test.ts`：

1. `freqToX(20) === viewport.x`，`freqToX(20000) === viewport.x + viewport.width`（误差 < 1e-6）。
2. `xToFreq(freqToX(f)) ≈ f`（取 20/100/1000/20000，相对误差 < 1e-6）。
3. `gainToY(12) === viewport.y`，`gainToY(-24) === viewport.y + viewport.height`。
4. 越界输入被夹紧：`xToFreq(-9999)` → 20，`xToFreq(99999)` → 20000。
5. `freqTicks(20, 20000)` 包含 20/50/100/1000/10000/20000 且严格递增。
6. `gainTicks(-24, 12)` 为 `[-24,-18,-12,-6,0,6,12]`。

`eq-model.test.ts`：

1. 构造后 `allBands().length === 14`，`visibleCount() === 7`。
2. `setBand(0, { gain: 100 })` → `bandAt(0).gain === 12`。
3. `setBand(99, {...})` 不抛异常且模型不变。
4. 有效变更派发一次 `band-changed`；同值再设一次不派发。
5. `resetBandGain(3)` 后 `gain === 0 && q === 0.7`。
6. `setFocused(5)` 派发 `focus-changed` 且 `focusedIndex() === 5`；`setFocused(99)` → `-1`。

## 5. 输入输出

- 输入：本任务书的公式与签名。
- 输出：`eq/` 下四个模块；被 SubStage 3.3（渲染/交互）与 4.2（截图验证）引用。

## 6. 验收标准

1. `pnpm run test` 中三个测试文件全绿，贴真实输出。
2. `pnpm run typecheck` 通过。
3. 用 node 直接跑 `computeCurve`（可在测试里）输出 480 个点，`console.log` 抽样第 0/120/240/360/479 点，肉眼确认无 NaN、形状合理。

## 7. 禁止事项

- 不得引入第三方 DSP/图表库。
- 不得在 `eq/` 内引用 DOM、Canvas、Electron。
- 不得修改 `params.ts` / `values.ts`（SubStage 2.1 的文件）。
- 不得修改 `Document/` 下任何文件。

## 8. 错误处理契约

- 所有函数**不抛异常**；非法输入按 §3.2、§3.4 的夹紧规则处理，返回有限数值。
- `computeCurve` 若 `pointCount < 2`，返回单点数组 `[{ freq: freqMin, gainDb: <该点增益> }]`。
- 测试失败必须修到通过；若发现参考实现与本契约冲突，以本契约为准并记录差异。

## 9. 依赖前置

需等待 SubStage 1.1 完成（构建与测试可用）。完成后可与 2.1、2.3 并行开工。
