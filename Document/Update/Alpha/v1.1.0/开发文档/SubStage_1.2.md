# SubStage 1.2 — 寄存器真值表与参数映射

> **所属 Stage**：Stage 1（协议真值层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：无代码依赖。**必须已读**：`Document/Protocol/M001参数表V0.1.xlsx`（寄存器表三张工作表）、需求文档附录 A.5/B、问题清单 Q2 定案。
> **并行状态**：**可并行**（与 SubStage 1.1 无文件重叠；1.1 只碰 `device/protocol.ts` 与 `device/proto/**`）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

参数层现在有两处硬伤：

1. `src/renderer/src/domain/params.ts` 的 36 项**没有寄存器地址**，也没有标定式，无法把界面值变成寄存器原始值；
2. `src/renderer/src/domain/defaults.ts` 的默认值来自 `效果器参数范围.xlsx`，与寄存器表大面积冲突（问题清单 Q2）。

问题清单 Q2 已定案：**地址 / 标定 / 权限 / 默认值一律以寄存器表为准**。本 SubStage 把寄存器表落成一张结构化真值表，并让 `params.ts` 由它派生（R2-1：表格由代码生成并与寄存器表逐行比对一致）。

做完之后：给一个参数 `id` 能拿到它的地址、范围、步进、权限、标定式；给一个 `value` 能算出寄存器 `raw`，反之亦然；3BandDrc 段序是 low→high→mid；EQ 7 段的地址可由公式算出。

---

## 2. 当前代码状态

| 文件 | 现状（已读） |
|---|---|
| `src/renderer/src/domain/params.ts` | 90 行；`ParamSpec` 8 个字段；`spec()` 工厂；36 项常量（`gain.Mic`/`gain.Hp` 用 dB 范围；3BandDrc 顺序 low→mid→high）；`findParam` / `paramsOf` |
| `src/renderer/src/domain/defaults.ts` | `DEFAULT_PARAMS` = `PARAMS.map(p => [p.id, p.default])`；`DEFAULT_LANG`；`DEFAULT_BANDS`（7 段对数等距 + 7 内部段） |
| `src/renderer/src/domain/values.ts` | `clampValue` / `quantize` / `formatValue` / `parseInput`，全部按 `ParamSpec.min/max/step` 工作，本任务不改 |
| `src/renderer/src/domain/slider-scale.ts` | `LOG_IDS` 列了 15 个 id（含 `noisegate.attack_ms` 等），本任务不改，但**必须核对**新增/改判的 id 是否需要在 `LOG_IDS` 里 |
| `tests/unit/params.test.ts` | 断言 36 项与范围/默认值 —— 本任务必须同步改 |
| `tests/unit/values.test.ts`、`tests/unit/slider-scale.test.ts`、`tests/unit/state.test.ts`、`tests/unit/integration.test.ts`、`tests/unit/quick-controls.test.ts` | 可能引用被改判的 id/默认值 —— 逐条核对，**只改因真值变更而失效的断言**，不得放宽断言 |

---

## 3. 本 SubStage 产出文件

```
src/renderer/src/device/registers.ts        新建（190 项寄存器真值表 + 标定 + 字符串编解码）
src/renderer/src/domain/params.ts           改写（42 项，由 REGISTERS 派生，新增 addr/scale/block）
src/renderer/src/domain/defaults.ts         改写（默认值改取寄存器表；EQ 7 段默认改取寄存器表）
tests/unit/registers.test.ts                新建
tests/unit/params.test.ts                   改写（对齐 42 项与寄存器表）
tests/unit/defaults.test.ts                 新建
```

其它文件只在"因真值变更导致既有断言失效"时修改，改动清单必须在完成报告里列出。

---

## 4. 完整契约

契约原文见 `设计文档.md` §5.2、§5.3。下面复述必须实现的要点。

### 4.1 `device/registers.ts`

```ts
export type RegisterAccess = 'r' | 'rw' | 'none';
export type RegisterRegion = 'info' | 'config' | 'preset';
export type RegisterKind = 'scalar' | 'string' | 'reserved' | 'live' | 'checksum';
export type RegisterScale =
  | { readonly kind: 'raw' }
  | { readonly kind: 'linear'; readonly mul: number; readonly add: number };

export interface RegisterSpec {
  readonly addr: number;
  readonly field: string;
  readonly name: string;
  readonly region: RegisterRegion;
  readonly kind: RegisterKind;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: 'dB' | 'Hz' | 'ms' | 's' | '';
  readonly defaultRaw: number;
  readonly access: RegisterAccess;
  readonly scale: RegisterScale;
}

export const REGISTERS: readonly RegisterSpec[];    // 恰好 190 项
export function findRegister(addr: number): RegisterSpec | undefined;
export function toRaw(spec: RegisterSpec, value: number): number;
export function fromRaw(spec: RegisterSpec, raw: number): number;
export function defaultOf(spec: RegisterSpec): number;

export const PRESET_START = 0x2000;
export const PRESET_COUNT = 114;
export const LEVEL_ADDR = 0x2057;
export const VALID_FLAG_ADDR = 0x2001;
export const CHECKSUM_ADDR = 0x2000;
export const DEV_INFO: Readonly<{ modelCode: {addr:number;words:number}; deviceName: ...; firmware: ...; fwType: ...; vid: ...; pid: ...; serial: ... }>;
export const CONFIG: Readonly<{ heartbeat:number; unitAddr:number; presetCount:number; startupNo:number; saveNo:number; loadNo:number; deleteNo:number; comErrAck:number; enterDfu:number; reinit:number; factoryReset:number; syncFlag:number; sysErr1:number; sysErr2:number }>;

export const EQ_BAND_BASE = 0x2027;
export const EQ_BAND_STRIDE = 5;
export const EQ_BAND_COUNT = 7;
export type EqField = 'enable' | 'type' | 'freq' | 'gain' | 'q';
export const EQ_FIELD_ORDER: readonly EqField[];
export function eqBandAddr(band: number, field: EqField): number;   // band 0..6

export type Drc3SectionId = 'low' | 'high' | 'mid';
export const DRC3_SECTIONS: readonly { readonly id: Drc3SectionId; readonly base: number }[];
export type Drc3Field = 'preGain' | 'threshold' | 'attackTime' | 'releaseTime' | 'ratio';
export const DRC3_FIELD_ORDER: readonly Drc3Field[];
export function drc3Addr(section: Drc3SectionId, field: Drc3Field): number;

export function decodeAsciiWords(words: readonly number[]): string;
export function encodeAsciiWords(text: string, wordCount: number): number[];
```

### 4.2 表内容（真值，必须逐行照抄寄存器表）

**设备信息区 62 项（`0x0000`–`0x003D`，全部 `access:'r'`）**：`modelCode` 3 词（6 字符，`kind:'string'`）、`deviceName` 8 词（16 字符，`'string'`）、`firmware X/Y/Z` 3 词 + `build` 1 词、`fwType` 1 词（0 Demo / 1 Release）、`dsp1 X/Y/Z` 3 词、`dsp2 X/Y/Z` 3 词、`vid` 1 词、`pid` 1 词、`date Y/M/D` 3 词、`time h/m/s` 3 词、`serial` 32 词（`'string'`）。`field` 取值：`mc1..mc3`、`dn1..dn8`、`fwX/fwY/fwZ/fwBuild`、`fwType`、`dsp1X..dsp1Z`、`dsp2X..dsp2Z`、`vid`、`pid`、`dateY/dateM/dateD`、`timeH/timeM/timeS`、`sn1..sn32`。`defaultRaw` 取寄存器表 G 列（大部分为 0，`fwX=1`、`fwType=1`、`dsp1X=1`、`dsp2X=1`、`vyear=2027`），`min=0`、`max` 按位宽（1 词填 `0xFFFF`，`kind:'string'` 也填 `0xFFFF`）、`step=1`、`unit=''`、`scale:{kind:'raw'}`。

**设备配置区 14 项（`0x1000`–`0x100D`）**：见寄存器表「设备配置」页；`0x1000` heartbeat（`defaultRaw:700`，`access:'none'`，本版本不用）、`0x1001` unitAddr（0，`'rw'`，本版本固定 0 不写）、`0x1002` presetCount（1，`'none'`）、`0x1003` startupNo（1，`'none'`）、`0x1004` saveNo（1，`'none'`）、`0x1005` loadNo（1，`'none'`）、`0x1006` deleteNo（0，`'none'`）、`0x1007` comErrAck（0，`'r'`）、`0x1008` enterDfu（0，`'rw'`，只经 DFU 流程写）、`0x1009` reinit（0，`'none'`）、`0x100A` factoryReset（0，`'none'`）、`0x100B` syncFlag（0，`'none'`）、`0x100C`/`0x100D` sysErr1/2（0，`'r'`）。范围按寄存器表 H 列，无范围的填 `min:0,max:0xFFFF,step:1`。

**当前预设区 114 项（`0x2000`–`0x2071`）**：`0x2000` checksum（`kind:'checksum'`，`access:'r'`）、`0x2001` validFlag（`'rw'`，范围 `[0,1]`）、`0x2002`–`0x2021` presetName 32 词（`kind:'string'`，`'rw'`）、`0x2022` mute、`0x2023` micGain（`'r'`）、`0x2024` encOnOff、`0x2025` encLevel、`0x2026` eqMode、`0x2027`–`0x2049` EQ 7 段 ×（enable/type/freq/gain/q）、`0x204A` compEnable、`0x204B`–`0x2050` comp 六项、`0x2051` limitEnable、`0x2052` limitPreGain（`kind:'reserved'`，`access:'none'`，`min=max=step=0`）、`0x2053`–`0x2055` limit 三项、`0x2056` limitRate（`'reserved'`、`'none'`、范围全 0）、`0x2057` micLevel（`kind:'live'`，`'r'`，范围 `[0,256]`）、`0x2058` micSigMute、`0x2059` hpOnOff、`0x205A` hpGain（`'r'`）、`0x205B`–`0x2060` noisegate 六项、`0x2061` fc1、`0x2062` fc2、`0x2063`–`0x2067` 低区五项、`0x2068`–`0x206C` 高区五项、`0x206D`–`0x2071` 中区五项。

标定式（`scale`）与范围/步进/默认原始值**必须**照寄存器表：

| 域 | `scale` | 范围（工程量） | 步进 | `defaultRaw` |
|---|---|---|---|---|
| EQ gain | `{linear, mul:0.1, add:-32}` | −32…12 | 0.1 | 320（每段） |
| EQ q | `{linear, mul:0.1, add:0}` | 0.1…12 | 0.1 | 7 / 7 / 8 / 15 / 10 / 10 / 7 |
| EQ freq | `raw` | 20…20000 | 1 | 50 / 20000 / 215 / 1000 / 2000 / 5000 / 10000 |
| EQ type | `raw` | 0…4 | 1（注意：寄存器表写 step=0，枚举按 1 处理，见 §5 决策 D3） | 4 / 3 / 0 / 0 / 0 / 0 / 0 |
| EQ enable | `raw` | 0…1 | 1 | 1 |
| comp MakeUpGain / Rate / KneeWidth | `{mul:0.1}` | 0…60 / 1…100 / 0…60 | 0.1 | 0 / 60 / 10 |
| comp/limit Threshold | `{mul:0.1, add:-60}` | −60…0 | 0.1 | 580 |
| comp/limit Attack、Release | `{mul:0.0001}` | 0.0001…0.2 / 0.005…2 | 0.0001 | 5 / 1000（comp Release）、5 / 500（limit） |
| noisegate threshold_db | `{mul:1, add:-91}` | −91…0 | 1 | 0 |
| noisegate ratio | `{mul:0.001}` | 0.05…0.999 | 0.001 | 50 |
| drc3 threshold | `{mul:0.1, add:-80}` | −80…0 | 0.1 | 0 |
| drc3 preGain | `{mul:0.01}` | 0…4 | 0.01 | 0 |
| drc3 ratio | `{mul:0.1}` | 1…20 | 0.1 | 1（工程量 0.1 越界，`defaultOf` 夹紧到 1） |
| noisegate attack/release、knee、hp_freq、drc3 fc1/fc2/attackTime/releaseTime、enc/开关类、micGain/hpGain、micLevel、eqMode | `raw` | 见寄存器表 | 见寄存器表 | 见寄存器表 |

`toRaw` / `fromRaw` 必须按 `设计文档.md` §6.3 实现（含量化与 `toFixed(6)` 归一、raw 上下界夹紧）。`defaultOf(spec) = clamp(fromRaw(spec, spec.defaultRaw), spec.min, spec.max)`。

`decodeAsciiWords`：每词取高低两字节拼两个字符（高字节在前），遇 `0x00` 停止，去尾部空白。`encodeAsciiWords`：右补 `0x00`，超长截断。

### 4.3 `domain/params.ts`

42 项、`id` 与地址/范围/步进/权限/标定见 `设计文档.md` §5.3 表格（**逐行照抄，不得自行改判**）。`PARAMS` 由 `REGISTERS` 派生：

```ts
// 每一项 = REGISTERS.find(r => r.addr === addr) 的 min/max/step/unit/default/access/scale
// readonly = register.access === 'r'
```

`ParamSpec` 在既有 8 字段后追加 `addr: number`、`scale: RegisterScale`、`block: RegisterRegion`；追加 `findParamByAddr(addr)`。`paramsOf` / `findParam` 签名不变。

### 4.4 `domain/defaults.ts`

- `DEFAULT_PARAMS`：由 `PARAMS` 派生（结构与 v1.0.0 一致）。
- `DEFAULT_BANDS`：`bands[0..6]` 取 `设计文档.md` §5.3 的 EQ 默认表；`bands[7..13]` 保持 v1.0.0 的 `INNER_POSITIONS` 对数插值（PEEK、gain 0、q 0.7），实现方式可保留现有 `buildDefaultBands()` 结构，只替换前 7 段的来源。

---

## 5. 自制决策（本任务书授权范围）

| # | 决策 | 理由 |
|---|---|---|
| D1 | `REGISTERS` 放 `src/renderer/src/device/registers.ts` 而不是 `domain/` | 它描述协议地址空间，供 `device/**` 与 `domain/**` 共用；`registers.ts` 不 import 任何其它模块，无循环依赖 |
| D2 | 42 项之外的寄存器（EQ 7 段、电平、保留项、预设头、设备信息/配置）**不进 `PARAMS`** | `PARAMS` 的消费方是 UI（`paramsOf`），协议可寻址寄存器由 `REGISTERS` 承担，两层职责分离 |
| D3 | EQ `type` 的步进按 `1` 处理（寄存器表写 `0`） | `domain/values.ts:quantize` 用 `step` 做取整，`step=0` 会除零；枚举字段按 1 处理 |
| D4 | 保留项（`0x2052`/`0x2056`）在 `REGISTERS` 里 `min=max=step=0`、`access:'none'`、`kind:'reserved'` | 需求 R2-7 要求"保留占位、标为不读写" |
| D5 | `mic.mute`/`mic.sigMute`/`hp.OnOff` 归入 `module:'gain'` | 现有 5 个视图按 `paramsOf(module)` 渲染，新增 `module` 会要求每个视图改布局；归入 `gain` 让 input-view 自然展示它们 |
| D6 | 字符串字段 `max` 填 `0xFFFF`、`min=0`、`step=1` | 与数值字段共用 `RegisterSpec`；不参与量化计算 |

---

## 6. 测试要求

```powershell
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node $pnpm run test
& $node $pnpm run typecheck
```

`tests/unit/registers.test.ts` 必须包含：

1. `REGISTERS.length === 190`；info 62 / config 14 / preset 114 三段计数分别断言。
2. `REGISTERS.map(r => r.addr)` 在预设区严格连续：`REGISTERS.filter(r => r.region==='preset').every((r,i) => r.addr === 0x2000 + i)`。
3. 每个 `region` 内 `field` 唯一（用 `Set` 断言长度相等）。
4. **附录 B 逐行比对**（R2-1）：把 `Document/Update/Alpha/v1.1.0/需求文档.md` §9 附录 B 里"地址 / 名称 / 范围 / 步进 / 单位 / 默认原始值 / 标定 / 权限"抄成一张测试常量表（至少覆盖 §B.3 的全部标量行 + EQ 汇总行 + 3BandDrc 三区地址表），逐行与 `REGISTERS` 比对。允许任一方向缺项（文档没写的字段不比）。
5. `toRaw`/`fromRaw`（R2-2）：对每个可写寄存器，在 `[min,max]` 上取 100 个等距点，断言 `Math.abs(fromRaw(toRaw(v)) - v) <= step / 2 + 1e-9`；并对 `raw` 边界（`toRawRaw(min)`、`toRawRaw(max)`）断言夹紧。
6. 3BandDrc 三区地址（R2-5）：`drc3Addr('low','preGain')===0x2063`、`drc3Addr('high','preGain')===0x2068`、`drc3Addr('mid','preGain')===0x206D`，且 `DRC3_SECTIONS` 顺序为 low→high→mid。
7. `eqBandAddr(0,'enable')===0x2027`、`eqBandAddr(6,'q')===0x2049`、`eqBandAddr(7,'enable')` 抛 `RangeError`。
8. `defaultOf` 对 `drc3.low.ratio` 返回 `1`（夹紧）且不抛错。
9. 字符串：`decodeAsciiWords(encodeAsciiWords('JYM001', 3)) === 'JYM001'`；`decodeAsciiWords([0x4A59,0x4D30,0x3031]) === 'JYM001'`（需求 A.4 的示例）；`encodeAsciiWords('M001', 8)` 长度为 8 且第 3、4 词为 0。

`tests/unit/params.test.ts` 必须包含：

1. `PARAMS.length === 42`；按 module 计数 `gain 5 / enc 2 / eq 1 / comp 7 / limit 4 / noisegate 6 / drc3 17`。
2. 每个 `id` 唯一、每个 `addr` 唯一；`findParamByAddr(spec.addr)` 回同一个 spec。
3. 逐项断言 `addr/min/max/step/unit/readonly/default`（用一张内联期望表，**逐行写死**，不要从 `PARAMS` 里读自己）。
4. `gain.Mic.addr === 0x2023 && gain.Mic.readonly === true && gain.Mic.unit === ''`、`gain.Hp.addr === 0x205A`。
5. `limit.Enable.addr === 0x2051`、`comp.Enable.addr === 0x204A`。

`tests/unit/defaults.test.ts` 必须包含：

1. `isDeepFrozen` 断言（`Object.isFrozen(DEFAULT_PARAMS)`）。
2. `DEFAULT_BANDS.length === 14`；前 7 段逐段断言 type/freq/gain/q 与设计文档 §5.3 的 EQ 默认表一致（`gain` 为工程量：−3.5 用 `toBeCloseTo`）；后 7 段 type 全 0、gain 全 0、q 全 0.7。
3. `DEFAULT_PARAMS['drc3.low.ratio'] === 1`、`DEFAULT_PARAMS['comp.Threshold'] === -2`、`DEFAULT_PARAMS['noisegate.threshold_db'] === -91`。

既有测试的处置：

- `tests/unit/params.test.ts` 里旧的 36 项断言**全部重写**（真值变了）。
- `tests/unit/state.test.ts` / `integration.test.ts` / `quick-controls.test.ts` / `slider-scale.test.ts`：只修改因默认值或范围变化而失效的期望值；**不允许**改成 `expect.any(Number)` 之类的放宽。
- `tests/unit/slider-scale.test.ts` 需要核对 `LOG_IDS`：新增的 `drc3.low/high/mid.attackTime` 已在 `LOG_IDS` 里（原 id 未变），`mic.*`/`hp.OnOff` 不入对数轴。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| B1 | `pnpm run test` 全绿（含既有 19 个用例文件） | 命令输出 |
| B2 | `pnpm run typecheck` 全绿 | 命令输出 |
| B3 | `REGISTERS` 190 项、`PARAMS` 42 项、地址连续、字段唯一 | 单测 |
| B4 | 附录 B 逐行比对表通过（R2-1） | 单测名里带 `appendix B` |
| B5 | 100 点 `toRaw/fromRaw` 往返（R2-2） | 单测 |
| B6 | 3BandDrc 三区地址 low `0x2063` / high `0x2068` / mid `0x206D` | 单测 |
| B7 | `device/registers.ts` 不 import 任何模块（`grep -c "^import" == 0`） | grep 取证 |
| B8 | 全仓 `grep -n "1.28\|1000, 3000\|-27, 36" src/renderer/src/domain` 只剩注释/无匹配 | grep 取证 |

---

## 8. 禁止事项

1. 不得修改 `third_party/web_hid_utils`、不得修改需求文档与寄存器表 xlsx。
2. 不得在 `params.ts` 里手写范围/默认值（必须从 `REGISTERS` 派生）；不得保留两份真值。
3. 不得把 `效果器参数范围.xlsx` 的 dB 范围写回 `gain.Mic`/`gain.Hp`（Q2 定案）。
4. 不得修改 `domain/values.ts`、`domain/slider-scale.ts` 的算法（只允许增删 `LOG_IDS` 条目并说明理由）。
5. 不得为通过测试而放宽既有断言；不得删掉既有测试文件。
6. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `REGISTERS` 三段计数与 `PARAMS` 42 项的地址表（贴出生成后的完整表格）。
3. `pnpm run test` 与 `pnpm run typecheck` 的完整输出。
4. 因真值变更而修改的既有测试清单（文件 + 用例名 + 改前/改后期望值）。
5. B1–B8 逐条结论与取证位置。
6. 与设计文档的偏差（无则写"无偏差"）。
