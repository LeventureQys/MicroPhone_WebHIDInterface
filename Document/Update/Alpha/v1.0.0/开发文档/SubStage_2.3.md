# SubStage 2.3 — i18n、应用状态与传输层

- 所属 Stage：Stage 2
- 依赖前置：SubStage 1.1；`ParamSpec` 类型与 `findParam()` 由 SubStage 2.1 提供（签名已在 §3.3 写死，若 2.1 尚未落盘，先按签名编码并在 2.1 完成后联调）
- 并行状态：可与 SubStage 2.1、2.2 并行（文件不重叠）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

三件事：中英双语字典、应用状态容器（唯一可写入口）、传输层（接口 + Mock 实现 + WebHID 骨架）。Alpha 阶段没有真实设备，但参数改动必须走真实的写入路径，保证后续联调只换实现。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/i18n/zh.ts` | 中文字典（扁平键值） |
| `src/renderer/src/i18n/en.ts` | 英文字典（键集合与 zh 完全一致） |
| `src/renderer/src/i18n/index.ts` | `t` / `currentLang` / `setLang` / `onLangChange` / `detectLang` |
| `src/renderer/src/device/transport.ts` | `Transport`、`LevelFrame`、`ParamWrite`、`TransportState` |
| `src/renderer/src/device/mock-transport.ts` | `MockTransport`（50Hz 电平 + 写入缓冲） |
| `src/renderer/src/device/webhid-transport.ts` | `WebHidTransport` 骨架（不实现） |
| `src/renderer/src/device/protocol.ts` | `HID_REPORT_ID`、`MAX_PAYLOAD`、`HidFrame` 占位 |
| `src/renderer/src/domain/state.ts` | `AppStore`（EventTarget） |
| `tests/unit/i18n.test.ts` | 字典一致性与回退 |
| `tests/unit/transport.test.ts` | Mock 电平与写入 |
| `tests/unit/state.test.ts` | 状态变更、只读拦截、写入联动 |

## 3. 契约

### 3.1 i18n

```ts
export type Lang = 'zh' | 'en';
export function t(key: string, vars?: Record<string, string | number>): string;
export function currentLang(): Lang;
export function setLang(lang: Lang): void;
export function onLangChange(cb: (lang: Lang) => void): () => void;
export function detectLang(nav: { language: string }): Lang;
```

- `t()` 支持 `{name}` 占位替换；缺失 key 返回 key 本身，且同一 key 只 `console.warn` 一次。
- `setLang` 写 `localStorage['micstudio.lang']`（happy-dom 提供 localStorage），并通知订阅者。
- `detectLang`：`language` 以 `zh` 开头 → `'zh'`，否则 `'en'`。
- 初次加载：`localStorage['micstudio.lang']` 存在且合法则用之，否则 `detectLang(navigator)`。

**字典键集合（两份必须完全一致，键名逐字使用）**

导航与模块：`nav.meter` `nav.input` `nav.eq` `nav.dynamics` `nav.drc` `nav.settings`
`module.gain` `module.noisegate` `module.comp` `module.limit` `module.eq` `module.enc` `module.drc3`
`module.gain.desc` `module.noisegate.desc` `module.comp.desc` `module.limit.desc` `module.eq.desc` `module.enc.desc` `module.drc3.desc`

顶栏：`topbar.connect` `topbar.lang` `topbar.state.idle` `topbar.state.connecting` `topbar.state.ready` `topbar.state.error` `topbar.state.mock` `topbar.synced` `topbar.syncing`

通用：`common.reset` `common.default` `common.on` `common.off` `common.readonly` `common.unit.dB` `common.unit.Hz` `common.unit.ms` `common.unit.s` `common.scene` `common.writes`

参数标签（36 条，键为 `param.<id>.label`），逐项列出：

```
param.gain.Mic.label            麦克风增益 / Mic gain
param.gain.Hp.label             耳机增益 / Headphone gain
param.noisegate.threshold_db.label   阈值 / Threshold
param.noisegate.ratio.label     扩展比 / Ratio
param.noisegate.attack_ms.label 启动时间 / Attack
param.noisegate.release_ms.label 释放时间 / Release
param.noisegate.knee_width_db.label 膝宽 / Knee
param.noisegate.hp_freq.label   侧链高通 / Sidechain HPF
param.comp.MakeUpGain.label     补偿增益 / Make-up gain
param.comp.Threshold.label      阈值 / Threshold
param.comp.Attack.label         启动时间 / Attack
param.comp.Release.label        释放时间 / Release
param.comp.Rate.label           Rate / Rate
param.comp.KneeWidth.label      膝宽 / Knee width
param.limit.Threshold.label     阈值 / Threshold
param.limit.Attack.label        启动时间 / Attack
param.limit.Release.label       释放时间 / Release
param.enc.OnOff.label           环境降噪 / Noise cancellation
param.enc.Level.label           降噪档位 / Level
param.drc3.fc1.label            分频点 1 / Crossover 1
param.drc3.fc2.label            分频点 2 / Crossover 2
param.drc3.low.preGain.label    低频补偿 / Low pre-gain
param.drc3.low.threshold.label  低频阈值 / Low threshold
param.drc3.low.attackTime.label 低频启动 / Low attack
param.drc3.low.releaseTime.label 低频释放 / Low release
param.drc3.low.ratio.label      低频比率 / Low ratio
param.drc3.mid.preGain.label    中频补偿 / Mid pre-gain
param.drc3.mid.threshold.label  中频阈值 / Mid threshold
param.drc3.mid.attackTime.label 中频启动 / Mid attack
param.drc3.mid.releaseTime.label 中频释放 / Mid release
param.drc3.mid.ratio.label      中频比率 / Mid ratio
param.drc3.high.preGain.label   高频补偿 / High pre-gain
param.drc3.high.threshold.label 高频阈值 / High threshold
param.drc3.high.attackTime.label 高频启动 / High attack
param.drc3.high.releaseTime.label 高频释放 / High release
param.drc3.high.ratio.label     高频比率 / High ratio
```

EQ 与视图：`eq.title` `eq.subtitle` `eq.type.0` `eq.type.1` `eq.type.2` `eq.type.3` `eq.type.4`（PEAK / LS / HS / LPF / HPF）、`eq.column.index` `eq.column.type` `eq.column.freq` `eq.column.gain` `eq.column.q`、`eq.internal.title` `eq.internal.desc` `eq.resetAll` `eq.hint`

电平页：`meter.input` `meter.output` `meter.rms` `meter.peak` `meter.scene.silence` `meter.scene.speech` `meter.scene.music` `meter.card.gain` `meter.card.scene` `meter.card.status` `meter.status.transport` `meter.status.writes`

设置页：`settings.title` `settings.language` `settings.scene` `settings.resetAll` `settings.about` `settings.version` `settings.platform` `settings.alphaNotice`

分频页：`drc.band.low` `drc.band.mid` `drc.band.high` `drc.cond.low` `drc.cond.mid` `drc.cond.high`

中文文案按上表；英文为等效英文（例如 `common.readonly` = `Read-only` / `只读`）。`param.comp.Rate.label` 两侧都为 `Rate`（不臆造语义）。

### 3.2 传输层

```ts
export type TransportState = 'idle' | 'connecting' | 'ready' | 'error';
export interface LevelFrame { t: number; inputRms: number; inputPeak: number; outputRms: number; outputPeak: number }
export interface ParamWrite { id: string; value: number }

export interface Transport {
  readonly kind: 'mock' | 'webhid';
  state(): TransportState;
  open(): Promise<void>;
  close(): Promise<void>;
  write(updates: readonly ParamWrite[]): void;
  onLevels(cb: (frame: LevelFrame) => void): () => void;
  onStateChange(cb: (state: TransportState) => void): () => void;
}
```

`MockTransport`：

```ts
export type MockScene = 'silence' | 'speech' | 'music';
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  constructor(options?: { hz?: number; scene?: MockScene });   // 默认 50Hz、'speech'
  setScene(scene: MockScene): void;
  writtenBuffer(): readonly ParamWrite[];
  lastFrame(): LevelFrame | null;
  // 其余方法按 Transport 实现
}
```

行为：`open()` 置 `connecting` → 立即 `ready` 并启动定时器（`setInterval`，间隔 `1000/hz`）；`close()` 清定时器并置 `idle`；`write()` 追加到内部缓冲并触发一次 `topbar.syncing` 语义所需的事件（本层只需缓冲）。

电平模型：

- `silence`：`inputRms = -72 + jitter(±1)`；`inputPeak = inputRms + 3`。
- `speech`：以 1 秒为粒度在「激活 / 静默」间切换，激活时长 0.6–3s、幅度 -14..-3 dBFS，静默段 -68 dBFS；帧间用一阶平滑（`next = prev * 0.7 + target * 0.3`）避免跳变。
- `music`：在 -22..-6 dBFS 间以正弦 + 抖动持续波动。
- 输出：`outputRms = inputRms - 3`，`outputPeak = inputPeak - 3`。
- 所有值 clamp 到 `[-96, 0]`。

`WebHidTransport`：`class WebHidTransport implements Transport`，`kind = 'webhid'`；所有方法体为 `throw new Error('webhid transport not implemented in alpha')`，文件头 `TODO(联调): 用 navigator.hid 实现 open/write，帧编码见 protocol.ts`。

`protocol.ts`：

```ts
export const HID_REPORT_ID = 0;
export const MAX_PAYLOAD = 64;
export interface HidFrame { reportId: number; payload: Uint8Array }
```

仅常量与类型，不写编码函数。

### 3.3 应用状态

```ts
export interface AppState {
  lang: 'zh' | 'en';
  module: 'meter' | 'input' | 'eq' | 'dynamics' | 'drc' | 'settings';
  params: Readonly<Record<string, number>>;
  bands: readonly EqBand[];        // 14 段，index 升序
  focusedBand: number;             // -1..6（可见段范围）
  transport: TransportState;
  scene: 'silence' | 'speech' | 'music';
}

export class AppStore extends EventTarget {
  constructor(transport: Transport, initial?: Partial<AppState>);
  get(): AppState;
  setParam(id: string, value: number): void;
  setBands(bands: readonly EqBand[]): void;
  setFocus(index: number): void;
  setModule(m: AppState['module']): void;
  setLang(lang: 'zh' | 'en'): void;
  setScene(scene: AppState['scene']): void;
  onChange(cb: (s: AppState) => void): () => void;
}
```

规则：

1. 构造时 `params` 取自 `DEFAULT_PARAMS`（36 项），`bands` 取 `DEFAULT_BANDS`，`lang` 取 i18n 当前语言，`module` 默认 `'meter'`，`focusedBand = -1`，`transport` 取 `transport.state()`，`scene` 默认 `'speech'`。
2. `setParam(id, value)`：`findParam` 找不到 → 忽略；`spec.readonly` → 忽略；`quantize` 后与当前值相同 → 忽略；否则更新并 `transport.write([{ id, value }])`，再派发一次 `new CustomEvent('change', { detail: this.get() })`。
3. `setLang` 同时调用 i18n 的 `setLang`。
4. 任何 setter 若无变化都不派发事件。
5. `get()` 返回浅拷贝对象（`params` 与 `bands` 冻结或复制，调用方不得就地改）。
6. 订阅：`onChange(cb)` 内部 `addEventListener('change', ...)`，返回取消函数，回调参数为 `this.get()`。
7. 构造时挂 `transport.onStateChange(s => { this._state.transport = s; 派发 change })`。

## 4. 单元测试

`i18n.test.ts`：

1. `Object.keys(zh).sort()` 与 `Object.keys(en).sort()` 完全相等（长度与逐项比对）。
2. 每个 `param.<id>.label` 在 `PARAMS`（36 项）里都能找到对应键（遍历 `PARAMS` 断言 key 存在）。
3. `t('not.exist.key')` 返回 `'not.exist.key'`，且只 warn 一次（连续调用两次只记录一条）。
4. `detectLang({ language: 'zh-CN' })` → `'zh'`；`'en-US'` → `'en'`；`'ja-JP'` → `'en'`。
5. `setLang('en')` 后 `t('nav.eq')` 变化，且 `localStorage['micstudio.lang'] === 'en'`。

`transport.test.ts`（用 `vi.useFakeTimers()`）：

1. `open()` 后 `state() === 'ready'`。
2. 推进 100ms，`onLevels` 回调被调用 ≥3 次，且 `lastFrame()` 的四个 dB 值都在 `[-96, 0]`。
3. `setScene('silence')` 后推进 200ms，`inputRms` 在 `[-75, -69]`。
4. `write([{id:'comp.Rate', value:6}])` 后 `writtenBuffer().length === 1`。
5. `close()` 后 `state() === 'idle'`，推进 200ms 不再有新帧。
6. `WebHidTransport.open()` 抛出 `Error`（用 `expect(...).rejects.toThrow()`）。

`state.test.ts`：

1. 初始 `params` 有 36 个键，`bands.length === 14`。
2. `setParam('gain.Mic', 99)` 被忽略（只读，值仍是 5）。
3. `setParam('noisegate.threshold_db', -70.4)` → 值变为 `-70`（step 1 量化）。
4. 有效 `setParam` 会调用 `transport.write`（用 spy 断言调用一次，参数含 `{ id, value }`）。
5. 同值重复 `setParam` 不派发 `change`、不调用 `write`。
6. `setModule('eq')` 派发一次 `change`；同值再设不派发。
7. `setFocus(3)` 后 `focusedBand === 3`。

## 5. 输入输出

- 输入：本任务书 §3 的接口与键表、设计文档 §5.6/§5.7/§5.8。
- 输出：i18n 模块、device 模块、`domain/state.ts`；被 SubStage 3.x 全部引用。

## 6. 验收标准

1. `pnpm run test` 中 `i18n.test.ts`、`transport.test.ts`、`state.test.ts` 全绿，贴真实输出。
2. `pnpm run typecheck` 通过。
3. 中英字典键数一致（测试已断言），且 `param.comp.Rate.label` 在两份字典中都不是中文语义标签。

## 7. 禁止事项

- 不引入 i18n 库、状态库、EventEmitter 库。
- 不在 `state.ts` 里做 DOM 操作。
- 不在 `mock-transport.ts` 里读真实设备。
- 不改 `params.ts` / `values.ts` / `eq/` 下文件。
- 不改 `Document/` 下任何文件。

## 8. 错误处理契约

- `Transport.open()` 失败：捕获内部异常，置 `error` 状态并 `console.warn`，**不 rethrow**（调用方不写 try/catch）。
- `WebHidTransport` 的方法体允许 throw（Alpha 占位），但其契约声明为"调用方负责捕获"。
- `write()` 永不抛异常。
- 测试失败必须修到通过。

## 9. 依赖前置

需等待 SubStage 1.1 完成。`ParamSpec`/`findParam`、`DEFAULT_PARAMS`、`DEFAULT_BANDS`、`EqBand` 由 2.1/2.2 提供；签名在 §3.3 与设计文档 §5.1/§5.3 已写死，可在 2.1/2.2 落盘前先按契约编码，集成时以实际落盘签名为准（不一致则上报主 Agent，不自行改契约）。
