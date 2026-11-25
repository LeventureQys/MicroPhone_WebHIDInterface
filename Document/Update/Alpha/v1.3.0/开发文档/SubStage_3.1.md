# SubStage 3.1 — 知识本体与契约（TS）

> **所属 Stage**：Stage 3（意图层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：无（不需要模型、不音频）
> **并行状态**：与 SubStage 1.1 / 1.2 **可并行**；SubStage 3.2、3.3、4.1、5.1、5.3 依赖本 SubStage
> **任务书版本**：v2（2026-11-24，替换 v1）
> **实现复核（2026-11-24，开发后回填）**：本任务书已按 SubAgent 的实测结果更正三处口径，见文末 §10「实施回填」。
> **契约来源**：设计文档 §2.1（文件布局）、§3.1（维度与频段寻址）、§3.2（L1）、§3.4（**全部数值**）、§4.2

---

## 1. 背景与目标

本 SubStage 交付**一份知识本体**：把"用户会怎么描述声音 → 该动哪些参数、动多少"写成一个可执行、可测试、可派生的 TS 模块。

**为什么它是本体而不是文档**：同一份知识要被**四个消费面**用到，手写四份必然漂移——

| 消费面 | 消费者 | 产物 |
|---|---|---|
| 运行时映射（语义动作 → 参数写入） | 执行器（Node） | `gen/rules.json` |
| 规则解析词表（中文说法 → 语义动作） | `parser.py` | `lexicons/zh.json` |
| 训练标签（微调数据） | SubStage 5.1 | `data/*.jsonl` 的 `plan` 字段 |
| 评测期望 | SubStage 5.3 | 评测用例的 `expect` |

所以：**`kb.ts` 是唯一真值，四份产物由它生成**（R-11）。任何"直接在 lexicons 里加一条说法"的行为都是漂移。

**第二个目标**：覆盖用户点破的短板——小模型没有 EQ/场景先验。因此本体除了 13 个语义维度，还必须有**频段寻址**（"250 赫兹压一点"）与**场景映射**（"我要直播"）。

---

## 2. 当前代码状态

| 位置 | 现状 | 关系 |
|---|---|---|
| `src/renderer/src/device/registers.ts` | 自包含无 import；`toRaw`/`fromRaw`/`findRegister`/`eqBandAddr`/`EQ_BAND_COUNT` | 只读引用 |
| `src/renderer/src/domain/params.ts` | `PARAMS`（46 项，含 `readonly`） | 只读引用（派生 ParamId） |
| `src/renderer/src/domain/defaults.ts` | `PRODUCT_BAND_FREQS = [50, 20000, 63, 250, 1000, 4000, 12500]` | 只读引用（频段寻址的锚点） |
| `src/renderer/src/domain/scenes.ts` | `SCENES`（5）、`scenePatch()` | 只读引用（场景映射的基底） |
| `src/renderer/src/domain/quick-controls.ts` | `EQ_PRESETS`（flat/vocal/warm/bright） | 只读引用 |
| `tools/voice/` | 只有 1.1/1.2 的产物 | 本 SubStage 新建 `contract/`、`schema/`、`gen/`、`lexicons/` |

**Node 侧跑 TS 的既定办法**（已实测）：`tools/voice/tsloader.mjs` + `register-loader.mjs`（30 行 ESM 解析钩子），运行时加

```
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
     --import ./tools/voice/register-loader.mjs <script>
```

**不要**给根 `package.json` 加 `"type": "module"`（会破坏 preload，AGENTS.md 已知坑 11）。

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/tsloader.mjs`、`register-loader.mjs` | ESM 解析钩子（跨 SubStage 资产，4.1/5.1 也要用） |
| `tools/voice/contract/kb.ts` | **知识本体**（详见 §4） |
| `tools/voice/contract/targets.ts` | 从 kb 再导出 `TUNE_TARGETS`/`TOGGLE_TARGETS`/`PARAM_IDS`/`TARGET_WRITABLE` |
| `tools/voice/contract/schemas.ts` | L1 / L2 的 JSON Schema 构造器 |
| `tools/voice/emit.mjs` | 生成 `schema/*.json`、`gen/rules.json`、`lexicons/zh.json`；`--check`、`--audit` |
| `tools/voice/schema/voice-plan.schema.json`、`schema/targets.json`、`gen/rules.json`、`lexicons/zh.json` | 生成物（提交进仓库） |
| `tests/unit/voice-kb.test.ts`、`voice-targets.test.ts` | 防漂移单测 |

---

## 4. 契约

### 4.1 `kb.ts` 的结构（字段名固定）

```ts
export interface KbDimension {
  id: TuneTarget;                        // 13 项之一
  nameZh: string;                        // "浑浊" 等，用于 preview 与 say 模板
  aliases: string[];                     // ≥ 6 条中文说法（进 lexicons）
  directionWord: { more: string[]; less: string[] };  // "亮一点"/"压下去" 这类方向词
  writable: string[];                    // 允许改写的 paramId（与 targets.TARGET_WRITABLE 一致）
  rules: { more: RulesByStrength; less: RulesByStrength };
  explain?: string;                      // 命中但不可执行时的解释（explainOnly 用）
}

export interface KbScenario {            // 8 种
  id: 'live'|'meeting'|'sing'|'game'|'podcast'|'record'|'dub'|'asmr';
  nameZh: string; aliases: string[];
  baseScene: 'quiet'|'game'|'podcast'|'sing'|'custom';   // 映射到内置场景
  patch: RuleAction[];                                    // 额外补丁（可为空）
}

export interface KbBand { band: 1|2|3|4|5|6|7; centerHz: number; kind: 'hpf'|'lpf'|'peak'; }
```

`kb.ts` 必须导出：

```ts
export const DIMENSIONS: readonly KbDimension[];      // 13
export const EXPLAIN_ONLY: readonly { id: string; nameZh: string; aliases: string[]; explain: string }[]; // ≥ 4
export const SCENARIOS: readonly KbScenario[];        // 8
export const BANDS: readonly KbBand[];                // 7（用 PRODUCT_BAND_FREQS 派生）
export const EQ_DELTAS: { gain: RulesByStrength; q: RulesByStrength; freqPct: RulesByStrength };  // 设计文档 §3.4 的 EQ_DELTAS
export const TURN_CAPS: { eqGainDb: number; encLevel: number; makeUpGainDb: number };             // 6 / 3 / 6
export const STRENGTH_WORDS: { slight: string[]; strong: string[] };
export const WAKE_PREFIXES: readonly string[];        // ['小唐小唐','小唐']
```

**数值必须逐格等于设计文档 §3.4 的两张表与 `EQ_DELTAS` 表**。实现时**照抄**，不要用"系数乘法"重算（表里已是乘完的成品，重算会引入 0.1 的舍入差）。

`RulesByStrength`（按 `slight/medium/strong` 给出三组）与 `RuleAction` 形状沿用设计文档 §3.4：

```ts
type RuleAction =
  | { kind:'param'; id:string; delta:number }
  | { kind:'band'; band:number; field:'type'|'freq'|'gain'|'q'; delta:number }
  | { kind:'paramSet'; id:string; value:number }
  | { kind:'bandSet'; band:number; field:…; value:number };
```

### 4.2 `EXPLAIN_ONLY` 最少 4 条

| id | 说法示例 | 解释（回给用户的话术） |
|---|---|---|
| `echo` | 回音、有回声、像在桶里、房间太空 | 这是房间声学问题，调 EQ 只会更糟：建议加吸音或靠近麦说话 |
| `plosive` | 喷麦、p 音爆、噗噗声 | 这是离麦太近与气流：建议加防喷罩或偏 30 度说话 |
| `hum` | 电流声、嗡嗡、50 Hz 哼声 | 这是接地/电源干扰：先换 USB 口或加地环路隔离 |
| `bgm` | 背景音乐串进来、耳机漏音 | 这是串音：建议戴封闭式耳机并把音量降下来 |

### 4.3 `emit.mjs`

```
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
     --import ./tools/voice/register-loader.mjs tools/voice/emit.mjs [--check|--audit]
```

| 模式 | 行为 | 退出码 |
|---|---|---|
| 默认 | 写 4 个文件：`schema/voice-plan.schema.json`、`schema/targets.json`、`gen/rules.json`、`lexicons/zh.json`（UTF-8 无 BOM、2 空格缩进、键顺序稳定） | 0 |
| `--check` | 只比较不写；有差异打印前 20 行 diff | 0 / 2 |
| `--audit` | 抽样 100 条自动生成的"说法 → 期望 plan"，打印未命中的条目（给 3.2/5.1 用） | 0 |

成功后打印一行：`emitted 4 files (dims=13, explain=4, scenarios=8, aliases=N, paramIds=74)`。

`schema/targets.json` 结构（Python 只读这个 + `lexicons/zh.json`）：

```json
{"v":1,"tuneTargets":[…13…],"toggleTargets":[…7…],"strengths":["slight","medium","strong"],
 "directions":["more","less"],"scenes":[…5…],"tones":[…4…],"paramIds":[…74…],
 "aliases":{"brightness":["亮","明亮","…"]},"wakePrefixes":["小唐小唐"],
 "bands":[{"band":1,"centerHz":50,"kind":"hpf"},…],
 "explainOnly":[{"id":"echo","nameZh":"回音","aliases":["回音","有回声"],"explain":"…"}],
 "scenarios":[{"id":"live","nameZh":"直播","aliases":["直播","带货"],"baseScene":"podcast"}]}
```

### 4.4 `lexicons/zh.json`（由 kb 生成，**不手写**）

```json
{"v":1,"entries":[{"pattern":"闷|浑浊|浑|糊","target":"muddiness","direction":"less"}],
 "switches":[…],"scenes":[…],"tones":[…],"explainOnly":[{…}],
 "bandParam":"第(?P<band>[1-7一二三四五六七])段(?P<field>增益|频率|q值|带宽)?",
 "hzParam":"(?P<hz>\\d+(?:\\.\\d+)?)\\s*(?:赫兹|hz|k|千赫)"}
```

- `pattern` 由 kb 的 `aliases` 合并（`'|'.join`），不得手写新正则；
- `entries` 条目数 = 13 个维度 × 两个方向（`more`/`less`）各 ≥ 1 条，合计 ≥ 26；加上 switches ≥ 14、scenes 8、tones 4，**总数 ≥ 52**；`aliases` 数组总计 ≥ 100 条说法。

### 4.5 `targets.ts`

从 kb 再导出（**不重复定义数值**）：

```ts
export const TUNE_TARGETS: readonly TuneTarget[];      // 13，顺序即 kb 顺序
export const TOGGLE_TARGETS: readonly ToggleTarget[];  // 7
export const PARAM_IDS: readonly string[];             // 74，派生规则见下
export const TARGET_WRITABLE: Readonly<Record<TuneTarget|ToggleTarget, readonly string[]>>;
```

`PARAM_IDS` 派生（**不许手抄**）：

```ts
import { PARAMS } from '../../../src/renderer/src/domain/params.ts';
const scalars = PARAMS.filter((p) => !p.readonly).map((p) => p.id);
const bands = [];
for (let b = 1; b <= 7; b += 1) for (const f of ['type','freq','gain','q'] as const) bands.push(`eq.band${b}.${f}`);
```

### 4.6 `schemas.ts`

`voicePlanSchema()` / `voiceCommandSchema()` 只允许用 `type / properties / required / additionalProperties / items / enum / const / oneOf / maximum / minimum`；**禁用** `$ref`（嵌套失效）、`pattern`（除 `^…$`）、`format`、`allOf`；每个 object 都要 `additionalProperties:false`；`confidence` 用 `enum:[0,0.25,0.5,0.75,1]`；`ops` 的 8 种 `kind` 用**扁平 `oneOf`**（`tune` / `eq`(band) / `eq`(centerHz) / `toggle` / `set` / `scene` / `tone` / `undo`）。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| `DIMENSIONS` 数量 ≠ 13 | 抛错 `new Error('DIMENSIONS 应为 13，实际 N')`，退出码 1 |
| 某维度 `aliases` < 6 或为空 | 抛错，列出该维度 |
| 某维度的 `writable` 里出现不在 `PARAM_IDS` 的 id | 抛错，列出该 id |
| `rules` 的三档里出现空数组 | 抛错（每档都必须有动作） |
| `EXPLAIN_ONLY` < 4 | 抛错 |
| `--check` 有差异 | 退出码 2 + diff |
| 导入 `params.ts` 失败 | 打印原始错误 + 提示检查 loader 与 `--experimental-strip-types`，退出码 1 |

---

## 6. 测试要求

**单元测试**（`tests/unit/voice-kb.test.ts`、`voice-targets.test.ts`，vitest）：

1. `DIMENSIONS.length === 13`，id 唯一，顺序与设计文档 §3.1 一致；
2. **逐格比对**：13 维度 × 2 方向 × 3 档的 `rules` 与设计文档 §3.4 表格完全相等（用 `toEqual`）；
3. `EQ_DELTAS.gain/q/freqPct` 三档逐格等于 §3.4 的表；
4. 每维度 `aliases.length ≥ 6`，全库别名去重后 ≥ 100；
5. `PARAM_IDS.length === 72`（**44 可写标量 + 28 EQ**，只读的 `gain.Mic`/`gain.Hp` 不在其中），与 `PARAMS.filter(p=>!p.readonly)` 顺序一致；
6. `TARGET_WRITABLE` 的每个 id ⊆ `PARAM_IDS`；且每个维度的 `writable` 与其 `rules` 实际用到的 id **一致**（多写或少写都算错）；
7. 场景：8 个，`baseScene` ∈ 5 个内置场景；
8. `BANDS` 的 `centerHz` 等于 `PRODUCT_BAND_FREQS`；`kind` 为 `hpf/lpf/peak/peak/peak/peak/peak`；
9. schema 递归扫描：不含 `$ref`/`pattern`/`allOf`；两次构造 `JSON.stringify` 完全一致；
10. `emit --check` 在当前仓库退出码 0。

**启动测试**（真跑）：

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tools/voice/register-loader.mjs tools/voice/emit.mjs
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tools/voice/register-loader.mjs tools/voice/emit.mjs --check
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tools/voice/register-loader.mjs tools/voice/emit.mjs --audit
npx vitest run tests/unit/voice-kb.test.ts tests/unit/voice-targets.test.ts
```

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `emit` | `emitted 4 files (dims=13, explain=4, scenarios=8, aliases≥100, paramIds=72)` |
| 7.2 | `emit --check`（未改代码） | 退出码 0 |
| 7.3 | 手工把 `muddiness.rules.less.medium` 的 band 从 4 改成 5，重跑 `--check` | 退出码 2 |
| 7.4 | 手工从 `lexicons/zh.json` 删一条后重跑 `--check` | 退出码 2（证明它是生成物） |
| 7.5 | 10 条单测 | 全绿 |
| 7.6 | `git status` | `src/**` 未修改 |

---

## 8. 禁止事项

- 不得修改 `src/**`、根 `package.json`、`tsconfig.json`、`vitest.config.ts`；
- 不得手抄 74 个 paramId、46 项参数范围或 13×6 的规则数值（前者派生、后者照抄设计文档表格）；
- 不得在 `lexicons/zh.json` 里手写内容（它是生成物，手改会被 `--check` 打回）；
- 不得在 schema 里用 `$ref`/`pattern`/`allOf`（llama.cpp 会静默降级）；
- 不得新增 npm 依赖（`emit.mjs` 只用 `node:fs`/`node:path`）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①`emit` 三种模式的原始输出；②10 条单测输出；③13 维度的别名计数与总数；④`gen/rules.json` 与设计文档 §3.4 逐格比对的结论（应为"完全一致"）；⑤`--audit` 的前 20 条未命中；⑥与本文不一致处；⑦未解决问题。

---

## 10. 实施回填（2026-11-24，交付后复核结论）

SubAgent 完成本 SubStage 后提出 5 个待裁决点，全部按下表定案，**后续 SubStage 以此为准**：

| # | 事项 | 定案 | 影响谁 |
|---|---|---|---|
| 1 | `PARAM_IDS` 是 **72** 不是 74 | **以 72 为准**（44 可写标量 + 28 EQ；`gain.Mic`/`gain.Hp` 只读，属 §3.3 的 `excluded`）。设计文档 §3.2/§3.5 与验收 D1 已同步更正 | 3.2 / 4.1 / 5.1 / 验收 |
| 2 | `EQ_DELTAS` 的类型 | 实际为 `EqDeltaTable = { gain\|q\|freqPct: { more, less } }`（`RulesByStrength` 装不下"方向"维，原声明不成立）。`freqPct` 的 delta 是**百分比**（+10 = +10%），写入时映射到 `field:'freq'` | 4.1 |
| 3 | `eq` 增量格的段号 | 用占位符 `band: 0`（导出常量 `EQ_DELTA_BAND_PLACEHOLDER`），由 4.1 替换成用户点名的那一段 | 4.1 |
| 4 | §3.4 的两条条件行为 + rgb 取模 | kb 另导出 `CONDITIONAL_ACTIONS` 并写进 `gen/rules.json.conditionals`：①`noiseFloor.more` 且 `enc.Level` 已 ≤0 → 追加 `enc.OnOff=0`；②`gate.less` 且 `noisegate.threshold_db` 已 ≤−91 → 追加 `noisegate.Enable=0`。`rgb.Mode` 的 0..7 取模由 4.1 的 canonicalize 处理 | 4.1 |
| 5 | `explainOnly` 的 id | 用任务书/词表口径 `echo / plosive / hum / bgm`（设计文档 §3.1 的 `plosive-pops / background-music` 作废） | 3.2 / 设计文档 |

另外三条**隐式契约**，下游必须遵守：

- **词表条目顺序**：`lexicons/zh.json` 的 `entries` 由 emit 按"非主方向条目在前"生成（例："闷一点" → `muddiness.more`，不会被"闷"→`muddiness.less` 吞掉）。**3.2 必须"按条目顺序取第一个命中"**，改成最长匹配或按 target 排序会破坏 255/255 的穷举干净度。
- **词表是生成物**：`lexicons/zh.json`、`gen/rules.json`、`schema/*.json` 一律不得手改（`emit --check` 会打回，已实测退出码 2）。
- **`targets.json.tones` 是 5 个**（`flat/vocal/warm/bright/custom`），不是 4 个——`custom` 是 L1 的合法枚举值。

额外导出（任务书写"必须导出"不含"只许导出"）：`ALIAS_SIDE`、`SWITCH_WORDS`/`SCENE_WORDS`/`TONE_WORDS`、`UNDO_WORDS`/`CONFIRM_WORDS`、`BAND_PARAM_PATTERN`/`HZ_PATTERN`、`SCENE_IDS`/`TONE_IDS`、`PARAM`/`paramIdOfAction`、`KbError`、`EqDeltaTable`。
