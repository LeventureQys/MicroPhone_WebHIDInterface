# SubStage 4.1 — 语义→参数映射、夹紧与执行器

> **所属 Stage**：Stage 4（执行层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 3.1（`targets.ts`、loader）、SubStage 3.2（`lexicons/zh.json` 里已有 target 语义，用于生成 `preview` 文案）
> **并行状态**：与 SubStage 3.3 **可并行**；SubStage 4.2 依赖本 SubStage
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §3.3（L2 与 tier 表）、§3.4（规则表数值）、§3.5（夹紧）、§3.8（HTTP API）、§4.2

---

## 1. 背景与目标

L1 只有"要更亮/更闷"，**数值在这里产生**。本 SubStage 交付三件事：

1. `rules.ts`：**13** 个语义目标 × 方向 × 档位、`eq` 频段寻址（3 字段 × 2 方向 × 3 档）、7 个开关 → 具体参数增量（数值来自 `gen/rules.json`，唯一真值在设计文档 §3.4 的表格里，不许自创）；
2. `canonicalize.ts`：把增量套在当前状态上、按 `registers.ts` 夹紧量化、按 tier 分层、产出 L2；
3. `executor.mjs` + 两个 sink：把 L2 落到 dry-run / 虚拟下位机，并暴露 HTTP 给 Python 侧车。

**参数真值只用 `registers.ts`**：`toRaw`/`fromRaw`/`findRegister`/`eqBandAddr` 全部 `import`，**不许复制范围与步长**。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `src/renderer/src/device/registers.ts` | `toRaw(spec, v)`（含夹紧+量化）、`fromRaw`、`findRegister(addr)`、`eqBandAddr(band, field)`、`EQ_BAND_COUNT=7` | 
| `src/renderer/src/domain/defaults.ts` | `DEFAULT_PARAMS`（46 项工程量）、`DEFAULT_BANDS`（14 段，前 7 段是可调段） | 
| `src/renderer/src/domain/scenes.ts` | `SCENES`、`scenePatch(scene, customGains)` → `{params, gains}` | 
| `src/renderer/src/domain/quick-controls.ts` | `EQ_PRESETS`（flat/vocal/warm/bright → 7 个 gain） | 
| `tools/vdevice/sidecar.mjs` | 控制面已有 `POST /control/registers`（写**原始值**，`:792`）、`/control/reset`、`/control/stats`；**没有读寄存器的 GET** |
| `tools/vdevice/device-stack.mjs` | `ParamStack.snapshot()`（`:388`）返回 `{"0x2025": 2, …}`，可直接用作回读 |
| `tools/voice/contract/targets.ts` | 3.1 交付 | 

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/contract/rules.ts` | 规则表（设计文档 §3.4 的逐行实现） |
| `tools/voice/contract/canonicalize.ts` | `planToCommand(plan, state)` |
| `tools/voice/sinks/dry.mjs` | 内存镜像 sink |
| `tools/voice/sinks/vdevice.mjs` | 虚拟下位机 sink |
| `tools/voice/sinks/index.mjs` | `createSink({kind, url})` |
| `tools/voice/executor.mjs` | HTTP 服务 + CLI |
| `tools/vdevice/sidecar.mjs`（**追加**） | `GET /control/registers` |
| `tests/unit/voice-rules.test.ts`、`tests/unit/voice-canonicalize.test.ts` | 单测 |

---

## 4. 契约

### 4.1 `rules.ts`

```ts
import type { TuneTarget, ToggleTarget } from './targets.ts';

export type Strength = 'slight' | 'medium' | 'strong';
export type EqField = 'type' | 'freq' | 'gain' | 'q';
export type RuleAction =
  | { kind: 'param';    id: string; delta: number }
  | { kind: 'band';     band: number; field: EqField; delta: number }
  | { kind: 'paramSet'; id: string; value: number }
  | { kind: 'bandSet';  band: number; field: EqField; value: number };

export const RULES: Readonly<Record<TuneTarget, {
  more: Readonly<Record<Strength, readonly RuleAction[]>>;
  less: Readonly<Record<Strength, readonly RuleAction[]>>;
}>>;

export const TOGGLE_RULES: Readonly<Record<ToggleTarget, { on: readonly RuleAction[]; off: readonly RuleAction[] }>>;

/** 单轮上限，超出即截断（设计文档 §3.4 末段） */
export const TURN_CAPS = Object.freeze({
  eqGainDb: 6, encLevel: 3, makeUpGainDb: 6,
}) as { eqGainDb: number; encLevel: number; makeUpGainDb: number };
```

数值必须与设计文档 §3.4 的两张表**逐格一致**（例：`brightness.more.medium` = `[{kind:'band',band:7,field:'gain',delta:3},{kind:'band',band:6,field:'gain',delta:2}]`）。实现时**直接按表抄**，不要用"系数乘法"重算——表里已经是乘完的成品，重算会引入 0.1 的舍入差。

> **v2 改动**：这些数值的唯一真值在 `tools/voice/contract/kb.ts`（SubStage 3.1），由 `emit.mjs` 导出到 `tools/voice/gen/rules.json`。本 SubStage 的 `rules.ts` **只做三件事**：读 `gen/rules.json`、把 L1 的 `tune`/`eq`/`toggle` 解析成 `RuleAction[]`、交给 `canonicalize.ts` 执行。**不允许**在 `rules.ts` 里再写一份数值（否则与 kb 漂移，`emit --check` 也抓不到）。文件仍需提供 `RULES` 形状的类型声明供单测逐格比对。

**段号与频点的对应（实现时用来校验规则表是否落在合理频段）**：band1 = HPF 50 Hz（type 4）、band2 = LPF 20 kHz（type 3）、band3 = 63 Hz、band4 = 250 Hz、band5 = 1 kHz、band6 = 4 kHz、band7 = 12.5 kHz（band3–7 的默认频点见 `src/renderer/src/domain/defaults.ts` 的 `PRODUCT_BAND_FREQS`；band1/band2 是滤波器，规则表**不碰**它们的 gain）。

### 4.2 `canonicalize.ts`

```ts
export interface VoiceState {
  params: Readonly<Record<string, number>>;   // 46 项工程量（缺失项用 DEFAULT_PARAMS 兜底）
  bands: readonly number[];                   // 7 段 gain（dB）
}

export interface CanonResult {
  writes: { param: string; value: number }[];
  bandWrites: { band: number; field: EqField; value: number }[];
  scene: string | null;
  tone: string | null;
  danger: { param: string; reason: 'confirm-required' | 'excluded' }[];
  preview: string[];
  tier: 'immediate' | 'confirm' | 'excluded';   // 整轮的最高层
  say: string;                                   // 可能被规则表覆盖（静音话术）
}

export function planToCommand(plan: object, state: VoiceState, ctx: { turnId: string }): CanonResult;
```

处理顺序（**必须按序**）：

1. 校验 `plan`（同 3.3 §4.3 的 1–7 条；不合法直接抛 `Error('E_PLAN_INVALID: <原因>')`）；
2. 收集 op：`tune` → 查 `RULES[target][direction][strength]`；**`eq`** → 先用 `band` 或 `centerHz` 定位段（`centerHz` 按 `gen/rules.json` 的 `bands` 就近映射；落在 `hpf`/`lpf` 段 → 该 op 丢弃并记 `danger:{reason:'excluded'}`），再按 `EQ_DELTAS[field][direction][strength]` 取值（`freq` 是**相对百分比**，需按当前频点换算，并夹紧 20..20000 Hz）；`toggle` → `TOGGLE_RULES[target][on?'on':'off']`；`scene` → 先查 `SCENARIOS` 的映射（若 L1 给的是 `scenario`），得到 `scenePatch(SCENES.find(...), state.bands)` + 场景补丁；`tone` → `EQ_PRESETS[tone]` 写 7 段 `gain`；`set` → 单条绝对写入，**并做数字接地检查**（`plan.text` 或调用方传入的 `utterance` 里必须能找到该数值，否则丢弃并记 `danger:{reason:'ungrounded-number'}`）；`undo` → 交给 4.2；

2b. **SubStage 3.1 交付后新增的三条约定，必须实现**（否则这两类行为会静默丢失）：
   - **条件动作**：读 `gen/rules.json` 的 `conditionals`。每个条件项形如 `{target, direction, when:{id, atOrBelow}, then:[RuleAction]}`；套完主规则后，若 `state.params[when.id] <= when.atOrBelow`，把 `then` 追加进本轮的 action 列表。现有两条：①`noiseFloor.more` + `enc.Level ≤ 0` → `enc.OnOff=0`；②`gate.less` + `noisegate.threshold_db ≤ −91` → `noisegate.Enable=0`；
   - **`eq` 占位段号**：`EQ_DELTAS` 里的 action 用 `band: 0`（导出常量 `EQ_DELTA_BAND_PLACEHOLDER`）表示"用户点名的那一段"，必须在套用前替换成真实段号（`band` 或 `centerHz` 映射结果）；
   - **`rgb.Mode` 取模**：该参数的 delta 必须按 `(current + delta) mod 8` 计算（范围 0..7 循环），不是夹紧；`rgb.Mode` 之外的所有参数仍按夹紧处理；
3. 每个 action 按 §4.3 套在 `state` 上（`delta` 类用当前值 + delta；`value` 类直接用），得到**未夹紧**的目标值；
4. 逐项 `fromRaw(spec, toRaw(spec, 目标值))`（EQ 字段用 `eqBandAddr` 找 spec）；
5. 应用 `TURN_CAPS`：同一 EQ 段单轮累计 |Δ| > 6 → 截到 6（按当前值比例收缩，四舍五入到 0.1）；`enc.Level` 与 `comp.MakeUpGain` 同理；
6. 与 `state` 比较，**只保留真正变化的项**（值相同就不写，避免无意义回读）；
7. 按 tier 表（设计文档 §3.3）给每个写入定级，取最高层作为整轮 `tier`；
8. `excluded` 的写入**丢弃**并写进 `danger`；`confirm` 的写入**保留在结果里**但整轮不执行（由调用方决定）；
9. 生成 `preview`（人类可读，例：`"eq.band7.gain 0 → 3.0 dB"`）与 `say` 覆盖（若写入含 `mic.mute=1`/`mic.sigMute=1`，`say` 强制为 `"已静音，请用界面上的开关恢复"`）。

### 4.3 sink 接口

```ts
export interface Sink {
  readonly name: 'dry' | 'vdevice';
  readState(): Promise<VoiceState>;
  /** 写入；失败抛 Error，消息含 E_SINK_* 码 */
  write(cmd: { writes: CanonResult['writes']; bandWrites: CanonResult['bandWrites'] }): Promise<void>;
}
export function createSink(opts: { kind: 'dry' | 'vdevice'; url?: string }): Sink;
```

- `dry`：内存里维护 `VoiceState`，初值 = `DEFAULT_PARAMS` + `DEFAULT_BANDS.slice(0,7).map(b => b.gain)`；`--reset` 时复位。
- `vdevice`：`url` 默认 `http://127.0.0.1:8766`（`tools/vdevice/run.mjs:35` 的 `controlPort: 8766` 默认值）。`readState()` → `GET /control/registers`；`write()` → `POST /control/registers`，body 为 `{"values":{"0x205B":51}}`（**原始值**，用 `toRaw` 换算；键为 `0x` + 4 位大写十六进制）。

### 4.4 `tools/vdevice/sidecar.mjs` 的**唯一允许改动**（追加只读路由）

`ROUTES` 里 `/control/registers` 改为同时接受 GET 与 POST；GET 分支返回：

```json
{ "ok": true, "registers": { "0x2025": 2, "0x205B": 51 } }
```

数据直接来自 `paramStack.snapshot()`（不要过滤、不要改名）。**不得**改动 POST 分支、`/control/reset`、帧处理或任何既有行为。

### 4.5 `executor.mjs`

```
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
     --import ./tools/voice/register-loader.mjs tools/voice/executor.mjs \
     --sink dry|vdevice [--url http://127.0.0.1:8766] [--port 8767] [--serve] [--plan <file>]
```

| 端点 | 行为 |
|---|---|
| `GET /health` | `{"ok":true,"sink":"dry","turn":"t-0000","undoDepth":0}` |
| `GET /state` | `{"ok":true,"params":{…},"bands":[…]}` |
| `POST /plan` | 读 `VoicePlan` → `planToCommand` → 返回 `{"ok":true,"command":<L2>}`，**不写**，`command.status` 强制 `'dry-run'` |
| `POST /apply` | 读 `VoicePlan` → `planToCommand` → `tier==='immediate'` 则 `sink.write()` → 返回 `{"ok":true,"command":<L2>,"readback":<VoiceState>,"mismatch":[]}`；`tier==='confirm'` 则返回 `command.status='needs_confirm'`、`confirmToken:null`（4.2 补）、**不写** |
| `POST /undo` | 4.2 实现；本 SubStage 返回 `501` + `{"ok":false,"error":{"code":"E_NOT_IMPLEMENTED","message":"撤销由 SubStage 4.2 提供"}}` |

`turn` 编号：进程内自增，`t-0001` 起，4 位补零。

**本 SubStage 不实现**：撤销栈、confirmToken 校验、mismatch 比对、turn 日志落盘（全部在 4.2）。但 L2 的字段必须**全量存在**（`undoTurn`/`confirmToken` 给 `null`）。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| `plan` 结构非法 | `POST /plan` 返回 400 `E_PLAN_INVALID`，消息含首个违规项 |
| 全部写入落在 `excluded` | 返回 409 `E_ALL_EXCLUDED`，`command.status='rejected'` |
| sink 连不上 | 502 `E_SINK_UNAVAILABLE`，消息含 URL |
| `POST` 空 body / 非 JSON | 400 `E_PLAN_INVALID` |
| 写入值经夹紧后与目标差 > 该参数一个 `step` | 不报错，`preview` 里标 `clamped` |
| `tone='custom'` | 不写增益（自定义曲线由用户拖拽，语音不改它），`preview` 标 `no-op` |

---

## 6. 测试要求

**单元测试**（`tests/unit/voice-rules.test.ts`、`voice-canonicalize.test.ts`，vitest）：

1. **78 格全覆盖**：13 target × 3 strength × 2 direction，断言 `RULES`（来自 `gen/rules.json`）的 action 列表与设计文档 §3.4 表格逐格相等（用 `toEqual` 比对完整数组）；
1b. **EQ_DELTAS 三字段 × 3 档 × 2 方向**（18 格）逐格比对；`centerHz` 映射：250→band4、3000→band6、12500→band7；50→`unsupported`；
1c. **数字接地**：`{"kind":"set","param":"eq.band6.gain","value":3}` 配 `utterance:"第六段增益提到3dB"` → 保留；配 `utterance:"声音太闷了"` → 丢弃且 `danger` 含 `ungrounded-number`；
1d. **条件动作**：`noiseFloor.more.strong` 在 `enc.Level=3` 时 → `enc.Level` 变 0 **且** `writes` 含 `enc.OnOff=0`；`gate.less.strong` 在 `noisegate.threshold_db=-85` 时 → 阈值夹到 −91 **且** `writes` 含 `noisegate.Enable=0`（注意 `threshold_db` 的 step 为 1，−91 可达）；
1e. **rgb 取模**：`rgb.Mode=7` 收到 `rgbMode.more.slight` → 结果 0（不是 7 或 8）；`rgb.Mode=0` 收到 `rgbMode.less.slight` → 结果 7；
1f. **eq 占位段号**：`EQ_DELTAS` 里的 `band:0` 必须被替换——`{"kind":"eq","band":4,...}` 的写入落在 band4，不得出现 `eq.band0.gain`；
2. 7 个 toggle 的 on/off 各断言一次；
3. 夹紧：`brightness.more.strong` 在 `band7.gain=12`（上限）时不再增加，结果 `writes` 为空且 `preview` 含 `clamped`；
4. 量化：`eq.band6.gain` 目标 2.34 → 输出 2.3（步进 0.1）；
5. 单轮上限：连续两次 `brightness.more.strong`（第二次 state 已 +5）→ 第二次只加 1（累计 6 上限）；
6. tier：`mic.mute=1` → `tier='confirm'`，`writes` 里**不含**其它 immediate 项（原子性）；
7. excluded：`set gain.Mic=50` → `danger` 含 `{param:'gain.Mic',reason:'excluded'}`，`writes` 为空；
8. 场景：`scene='quiet'` → `writes` 含 `noisegate.threshold_db=-82`、`comp.Threshold=-18`、`bandWrites` 7 个 gain 全为 0；
9. 音色：`tone='warm'` → `bandWrites` 的 7 个 gain 等于 `EQ_PRESETS.warm`；
10. 只写变化项：state 已等于目标时不产出写入。

**启动测试**（真跑）：

```powershell
# 终端 1：虚拟下位机
.\voice.cmd python -m tools.vdevice.run   # 或 node tools/vdevice/run.mjs
# 终端 2：执行器
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tools/voice/register-loader.mjs tools/voice/executor.mjs --sink vdevice --serve
# 终端 3：打三个请求
curl.exe -s http://127.0.0.1:8767/health
curl.exe -s -X POST http://127.0.0.1:8767/plan -H "Content-Type: application/json" -d "{\"v\":1,\"status\":\"ok\",\"say\":\"亮一点\",\"confidence\":1,\"ops\":[{\"kind\":\"tune\",\"target\":\"brightness\",\"direction\":\"more\",\"strength\":\"slight\"}]}"
curl.exe -s http://127.0.0.1:8766/control/registers
```

第三条必须返回真实寄存器快照（证明 4.4 的 GET 生效）。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `/plan` 对设计文档 §3.2 的样例 1 | 返回 L2：`bandWrites` 含 `band7.gain 0→1.5`、`band6.gain 0→1` |
| 7.2 | `/apply` 同上 + `GET /control/registers` | `0x2048`(band7.gain) 由 320 变为 335（raw，`toRaw(1.5)=335`，实现时以 `toRaw` 实际输出为准并记录） |
| 7.3 | 夹紧 20 例（构造越界 plan） | 0 例越界，`preview` 里都有 `clamped` |
| 7.4 | 10 条单测 | 全绿 |
| 7.5 | `pnpm run test:device` | 仍是 20/20（证明 4.4 的追加路由没破坏虚拟下位机） |

---

## 8. 禁止事项

- 不得修改 `src/**`（`registers.ts` 只读引用）；
- 不得自创规则表数值（必须与设计文档 §3.4 逐格一致；发现表格有问题 → 停下报告，不要自行修正）；
- 不得在 `sidecar.mjs` 里改动 POST 分支或任何既有路由的行为；
- 不得让 sink 直接读写文件/注册表（dry 用内存，vdevice 用 HTTP）；
- 不得在本 SubStage 实现撤销/确认/回读比对（4.2 的职责，提前实现会导致接口冲突）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①72 格规则表单测的通过数；②`/plan`、`/apply`、`/control/registers` 三个请求的原始 JSON；③夹紧 20 例的输入/输出对照表；④`pnpm run test:device` 的 20/20 输出；⑤`sidecar.mjs` 的 diff（必须只有 GET 分支与 ROUTES 一行）；⑥与设计文档 §3.4 表格的任何不一致（应为空）；⑦未解决问题。

---

## 10. 实施回填（2026-11-24，交付后复核结论）

实测结果：**187/187 单测绿、`typecheck` 绿、`test:device` 20/20、vdevice 真桥往返成功**（`0x2048` 320 → 335 = `toRaw(1.5)`）。交给 SubAgent 的 6 条口径偏差裁决如下，**下游（4.2/4.3/5.3）以此为准**：

| # | 事项 | 裁决 |
|---|---|---|
| 1 | 单轮上限是"每轮独立"还是"跨轮累计 6 dB" | **每轮独立**（设计文档 §3.4 写的就是"单轮累计"）。跨轮不共享才对——用户连说三次"再亮一点"应该能走到 +6/+9/+12；卡在 6 dB 是 bug。本文 §6-5 那句"第二次只加 1"已作废 |
| 2 | 条件动作的判据用"当前值"还是"本轮目标值" | **本轮目标值（含夹紧后）≤ 端点**。它同时覆盖"当前值已越端点"，比字面的 `state.` 更强 |
| 3 | `danger.reason` 的取值 | 三种：`confirm-required` / `excluded` / **`ungrounded-number`**（设计文档 §3.3 已同步） |
| 4 | `CanonResult` 多出的 `undo: boolean` | **保留**（内部字段，不进 L2 契约）。`/apply` 收到 `{"kind":"undo"}` 必须回 501，不许静默零写入 |
| 5 | `vdevice.readState().params` 是 72 项、dry 只有 46 项 | **两个 sink 统一 72 项**（46 标量 + 28 个 `eq.bandN.{type,freq,gain,q}`）。**dry 的初值补齐由 SubStage 4.2 负责**（见其任务书 §4.0）。`bands`（7 段增益）保留为便捷视图，但必须与 `params` 里的 `eq.bandN.gain` 同源同值 |
| 6 | `sidecar.mjs` 多改一行方法判定（`'GET\|POST'` + `split('|').includes(...)`） | **接受**，机械必需；`POST /control/stats`、`GET /control/reset` 仍 405 已实测 |

**环境坑（后续所有 SubStage 必须遵守）**：PowerShell 5.1 会把 `-d "{\"v\":1,...}"` 里的 `\"` 吞掉，导致 `E_PLAN_INVALID`。取证与手工联调一律用 `cmd /c '<原样命令>'` 或 `curl --data-binary "@body.json"`。

留给 SubStage 4.2 的部分：撤销栈（`/undo` 与 undo op 均回 501）、`confirmToken` 签发与校验（现恒 `null`）、写入后回读比对（`mismatch` 恒 `[]`）、turn 日志、`/health` 的 `undoDepth`、设计文档 §3.7 第 3 条"连续静音保护"。

**返工记录（同日）**：dry sink 的初值已从 46 项补齐到 **72** 项（含 28 个 `eq.bandN.{type,freq,gain,q}`），`bands` 改为只由 `params` 派生（`gainsOf(params)`），单测 187 → **190**，`typecheck` 仍 0，两个 sink 的 `params` 键数实测都是 **72**。

**两条必须知道的事实（不是缺陷，验收时不要判错）**：

1. **72 而非 74**：`PARAM_IDS` = 44 可写标量 + 28 EQ。`gain.Mic` / `gain.Hp` 只读，两个 sink 都不回读它们；`canonicalize` 需要这两项的当前值时回落 `DEFAULT_PARAMS`（值恒为 100，不参与写入）。
2. **两个 sink 的 EQ 默认值不同源**：`dry` 用产品默认（`DEFAULT_BANDS`：band3 gain = −3.5 dB，频点 63/250/1k/4k/12.5k），`vdevice` 用 `tools/vdevice/device-stack.mjs` 自己的寄存器默认表（7 段 gain 的 `defaultRaw` 统一 320 = 0 dB，频点仍是 215/1000/2000/5000/10000）。两者**各自忠于自己的真值源**，属既有差异（vdevice 的默认表早于参数表 V0.3）。**4.2 的回读比对用"写后回读"，不受初始值差异影响**；SubStage 5.3 的评测同样只比写入结果，不要拿"两个 sink 初始 bands 不同"当 bug 报。要统一得改 `device-stack.mjs` 的默认表，不在本版范围。
