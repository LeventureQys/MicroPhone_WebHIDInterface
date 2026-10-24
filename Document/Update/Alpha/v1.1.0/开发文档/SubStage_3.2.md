# SubStage 3.2 — 通道接线与上电同步（Transport / ChannelTransport / DeviceLink / 电平与顶栏）

> **所属 Stage**：Stage 3（参数链路）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 3.1（`ParamSession`、`DiagnosticsHub` 及其类型）、SubStage 1.2（`REGISTERS`/`PARAMS`/`DEFAULT_*`）
> **并行状态**：需等待 3.1；与 SubStage 4.1/5.2 **可并行**（文件不重叠）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

3.1 交付了一个"会说话"的会话，但它离界面还差三件事：

1. **把设备句柄接上去**：`WebHidTransport` 从桩变成真实实现（R3），并把 report ID、报文切分、入站去壳接好；
2. **让 AppStore 只有一个 Transport**：`ChannelTransport` 在 Mock 与设备之间切换（问题清单 Q3：默认 Mock + 显式标记）；
3. **上电同步与电平**：连接后必须回读真实值（R4）、电平只来自轮询（R5-5 区分"不可用"与"静音"），并在顶栏/工作台把"演示数据 / 同步中 / 已连接"讲清楚。

做完之后：连上虚拟下位机 → 界面参数变成设备回读值 → 改一个旋钮 → 设备侧收到写帧 → 电平表跟着 `0x2057` 动 → 拔线（静默）后 1 秒内电平变 `—`。

---

## 2. 当前代码状态（逐条已读）

| 文件 | 现状 | 本任务怎么处理 |
|---|---|---|
| `src/renderer/src/device/transport.ts` | 28 行；`TransportState`/`LevelFrame`/`ParamWrite`/`Transport`（5 个方法） | 追加方法与 `LevelFrame` 两个可选字段；re-export 3.1 的类型 |
| `src/renderer/src/device/mock-transport.ts` | 214 行；50 Hz 合成电平；`write` 只进缓冲 | 实现新增 5 个方法，行为见 §4.2 |
| `src/renderer/src/device/webhid-transport.ts` | 40 行；全方法抛 `WEBHID_NOT_IMPLEMENTED` | **重写**为真实实现 |
| `src/renderer/src/device/webhid/types.ts` | `WebHidDeviceHandle` **没有** `sendReport`（实测 kit 的设备对象有 `sendReport(reportId, data)`） | 追加可选 `sendReport` |
| `src/renderer/src/domain/state.ts` | 148 行；`AppState` 无 `sync`；`setParam` 立即 `write`；只读静默 return | 加 `sync`、`LOCAL_ERROR_EVENT`、`applyEcho`、门控 |
| `src/renderer/src/ui/meter.ts` | `MeterChannel {label,rms,peak}`；"不可用"与"静音"外观相同 | 加 `state`，`unavailable` 画 `—` |
| `src/renderer/src/ui/views/console-view.ts` | `createConsoleView(store, transport: MockTransport, api)`；无数据时塞占位帧 `-96` | 参数类型改 `Transport`；删占位帧；加"演示数据/同步中"标记 |
| `src/renderer/src/ui/topbar.ts` | 16 个 `topbar.*` 键，5 个未被使用 | 加数据来源与同步相位胶囊 |
| `src/renderer/src/main.ts` | 硬接 `MockTransport` | 改成 `ChannelTransport` + `DeviceLink` 接线 |
| `src/renderer/src/domain/quick-controls.ts` | `limiterEnabled/limiterThreshold` 用 `Limit.Threshold` | 改用 `limit.Enable`（C-15） |
| `tests/unit/{transport,state,meter,integration,quick-controls}.test.ts` | 现有断言基于旧契约 | 同步更新；`meter.test.ts` 为新建 |

---

## 3. 本 SubStage 产出文件

```
src/renderer/src/device/transport.ts                改写（增量扩展 + re-export）
src/renderer/src/device/mock-transport.ts           修改（实现新契约）
src/renderer/src/device/webhid-transport.ts         重写
src/renderer/src/device/channel-transport.ts        新建
src/renderer/src/device/link.ts                     新建
src/renderer/src/device/webhid/types.ts             修改（sendReport）
src/renderer/src/domain/state.ts                    修改（sync / applyEcho / localError）
src/renderer/src/domain/quick-controls.ts           修改（limit.Enable）
src/renderer/src/ui/meter.ts                        修改（state）
src/renderer/src/ui/views/console-view.ts           修改（类型 + 标记 + 电平态）
src/renderer/src/ui/views/input-view.ts             修改（**必改**：`gain` 模块已从 2 项扩到 5 项，见 §4.12）
src/renderer/src/ui/topbar.ts                       修改（三态胶囊）
src/renderer/src/main.ts                            修改（接线）
src/renderer/src/i18n/zh.ts / en.ts                 追加 sync.* 与 common.unavailable 等键
tests/unit/transport.test.ts                        改写
tests/unit/channel-transport.test.ts                新建
tests/unit/link.test.ts                             新建
tests/unit/meter.test.ts                            新建
tests/unit/state.test.ts                            改写
```

---

## 4. 完整契约

### 4.1 `device/transport.ts`

```ts
export type { TransportError, DiagEntry, SessionStats, SyncPhase, DeviceSnapshot } from './proto/session';
export type TransportState = 'idle' | 'connecting' | 'ready' | 'error';
export type SyncPhase = 'idle' | 'syncing' | 'ready' | 'error';   // 注意：由 proto/session 定义后在此 re-export，不要重复声明

export interface LevelFrame {
  readonly t: number;
  readonly inputRms: number;
  readonly inputPeak: number;
  readonly outputRms: number;
  readonly outputPeak: number;
  readonly inputValid?: boolean;
  readonly outputValid?: boolean;
}

export interface ParamWrite { readonly id: string; readonly value: number }
export interface ParamReadResult {
  readonly preset: Readonly<Record<string, number>>;   // paramId → 工程量
  readonly device: DeviceSnapshot | null;
}

export interface Transport {
  readonly kind: 'mock' | 'webhid';
  state(): TransportState;
  open(): Promise<void>;
  close(): Promise<void>;
  write(updates: readonly ParamWrite[]): void;
  onLevels(cb: (frame: LevelFrame) => void): () => void;
  onStateChange(cb: (state: TransportState) => void): () => void;
  readAll(): Promise<ParamReadResult>;
  onSync(cb: (phase: SyncPhase) => void): () => void;
  onParamEcho(cb: (echo: { readonly id: string; readonly value: number }) => void): () => void;
  onError(cb: (error: TransportError) => void): () => void;
  onDiag(cb: (entry: DiagEntry) => void): () => void;
}
```

### 4.2 `MockTransport` 新增行为（保持既有 214 行逻辑不变）

| 方法 | 行为 |
|---|---|
| `readAll()` | 20 ms 后 resolve `{ preset: DEFAULT_PARAMS, device: null }`（用真实定时器即可，本类本来就用 `setInterval`） |
| `onSync` | `open()` 成功后同步派发 `'syncing'` 再派发 `'ready'`（在下一个微任务里，保证订阅者已注册）；`close()` 派发 `'idle'` |
| `onParamEcho` | `write()` 后 5 ms 派发同值回显（同一批只发一次，值取最后一个） |
| `onError` | 只维护订阅集合，永不派发 |
| `onDiag` | 每次 `write()` 派发一条 `{dir:'out', hex:'', summary:'mock 写 <id>=<value>', level:'info', at: Date.now()}`（每批一条） |
| `LevelFrame` | `inputValid/outputValid` 恒为 `true` |

### 4.3 `WebHidTransport`（重写）

```ts
export interface WebHidTransportOptions {
  readonly device: WebHidDeviceHandle;
  readonly reportIds?: ReportIds;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly timing?: Partial<typeof TIMING>;
}
export class WebHidTransport implements Transport {
  constructor(options: WebHidTransportOptions);
  readonly kind: 'webhid';
  // Transport 全量 + 下面两个
  async selfCheck(): Promise<{ ok: boolean; steps: readonly { name: string; ok: boolean; detail: string }[] }>;
  async suspend(): Promise<void>;    // 停轮询 + 清队列（DFU 前调用）
  async resume(): Promise<void>;     // 重新 sync（DFU 后调用）
}
```

接线规则：

1. `open()`：若 `device.opened === false` 先 `await device.open()`；校验 `typeof device.sendReport === 'function'`（否则 `state='error'` + `onError({kind:'device'})`）；挂 `inputreport` 监听；创建 `ParamSession`（`send` = 把每包 `device.sendReport(reportIds.out, pkg)`，串行 await；`handleBytes` 只喂 payload，不含 report ID）；`await session.sync()`；`state='ready'`。
2. `inputreport` 处理：`const detail = (event as { detail?: unknown }).detail ?? event;` 取 `reportId`/`data`；`reportId !== reportIds.in` → 丢弃；`data` 接受 `Uint8Array | DataView | ArrayBuffer | number[]`，统一转 `Uint8Array`。
3. `write()`：`findParam(id)`；未找到 → `onError({kind:'len', message:'unknown param id'})` 并丢弃；`spec.readonly` → **不发帧**，`onError({kind:'readOnly', id, addr: spec.addr})`（R2-3/R3-3）；否则 `session.write([{addr: spec.addr, raw: toRaw(spec, value)}])`。
4. `readAll()`：`await session.sync()`；把 `preset.values` 按 `findParamByAddr(addr)` 映射成 `paramId → fromRaw`（只含 42 项标量）；`device` 直接返回 `DeviceSnapshot`。
5. `onLevels`：订阅 `session.onLevel`，映射 `levelToDb`，`inputPeak` 用 300 ms 线性回落：
   `peak = max(rms, prevPeak - (elapsedMs / 300) * (prevPeak - rms))`，其中 `prevPeak` 为上一次输出值，`elapsedMs` 由 `clock.now()` 计算（首次直接 `peak = rms`）。`outputRms/outputPeak = -96`、`outputValid = false`、`inputValid = true`。
6. `close()`：`session.dispose()`、摘监听、`state='idle'`。
7. 设备 `disconnect` 事件（`addEventListener('disconnect')`，kit 会转派）：`state='error'` + `onError({kind:'disconnected'})` + `session.setPolling(false)`。
8. `selfCheck()`：`sync()` → 读 `0x2025` → 写 `0x2025 = 原值`（不改变设备状态）→ 再读比对 → 返回 3 步结果。
9. `suspend()`：`session.setPolling(false)` + 丢弃待发写 + `phase` 保持 `ready`（不 dispose，DFU 结束后还要用）。
10. **不实现**任何 `0x1004`–`0x1005` 的写路径（问题清单 Q4）。

### 4.4 `ChannelTransport`

```ts
export class ChannelTransport implements Transport {
  constructor(initial: Transport);
  use(next: Transport): void;
  active(): Transport;
  get kind(): 'mock' | 'webhid';
  // 全部 Transport 方法：转发给 active；订阅集合由本类维护，切换时不打断
}
```

实现要求：

- 内部对 active 通道**只挂一次**转发监听（levels/state/sync/echo/error/diag），切到新通道时先摘旧监听再挂新的。
- `use(next)` 后立即用 `next.state()` 与既有订阅者对齐（`state` 变化时派发一次 `onStateChange`）。
- 订阅者在 `use()` 前后不需要重新订阅（`main.ts` 只创建一次）。
- `readAll()` 直接 `await active().readAll()`。

### 4.5 `DeviceLink`

```ts
export type LinkStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'dfu';

export interface LinkState {
  readonly status: LinkStatus;
  readonly mode: WebHidMode;
  readonly deviceId: string | null;
  readonly sync: SyncPhase;
  readonly error: string | null;
  readonly errorCode: WebHidErrorCode | null;
  readonly device: DeviceSnapshot | null;
  readonly warning: string | null;
}

export interface DeviceLinkOptions {
  readonly session: WebHidSession;
  readonly channel: ChannelTransport;
  readonly mock: MockTransport;
  readonly store: AppStore;
  readonly timers?: Timers;
  readonly clock?: Clock;
  readonly createTransport?: (device: WebHidDeviceHandle) => Transport;   // 单测注入
}

export class DeviceLink extends EventTarget {
  constructor(options: DeviceLinkOptions);
  getState(): LinkState;
  onChange(cb: (state: LinkState) => void): () => void;
  async attach(deviceId: string): Promise<void>;
  async detach(): Promise<void>;
  async suspendForDfu(): Promise<void>;
  async resumeAfterDfu(): Promise<void>;
}
export const LINK_CHANGE_EVENT = 'change';
```

行为：

1. `attach(deviceId)`：`session.openDevice(deviceId)` → 取设备句柄（`session.getState().devices` 里 `id === deviceId` 对应的 handle，或经 `createTransport` 注入）→ `channel.use(webhidTransport)` → `store.setSync('syncing')` → `transport.readAll()` → `store.applyEcho` 逐项 → **EQ 7 段**经 `EQ_BAND_ADDR`：从原始 `preset` 里取每段 `type/freq/gain/q`（`enable` 只记不写）并 `store.setBands([...bands0..6, ...bands7..13])` → `store.setSync('ready')` → `status='ready'`。
2. 型号码不匹配（`device.modelCode !== 'JYM001'`）：`warning = t('device.warn.modelMismatch', { code })`，**不阻断**（R4-3）。
3. `attach` 失败（打开失败/同步失败）：`status='error'`、`error` 用 `errorKeyOf()`/文案键、`channel.use(mock)`、`store.setSync('error')`。
4. `detach()`：`channel.use(mock)`、`store.setSync('idle')`、`session.closeDevice(deviceId)`。
5. 设备断开或 transport 报 `disconnected`：`status='error'`、`channel.use(mock)`（回到演示数据并显示标记），保留文案；**不自动重连**（用户点连接）。
6. `suspendForDfu()`：`status='dfu'`、`transport.suspend()`（若为 `WebHidTransport`）。
7. `resumeAfterDfu()`：`transport.resume()` → `readAll()` → `store.applyEcho` → `status='ready'`；若 `firmware` 与升级前记录相同 → `warning = t('fw.warn.versionUnchanged')`。

### 4.6 `domain/state.ts`

```ts
export const LOCAL_ERROR_EVENT = 'local-error';       // detail: { kind: 'readOnly' | 'notSynced'; id: string }

export interface AppState {
  lang: Lang;
  params: Readonly<Record<string, number>>;
  bands: readonly EqBand[];
  transport: TransportState;
  scene: MockScene;
  sync: SyncPhase;                                     // 新增
}
```

行为：

- `sync` 初值 `'idle'`；`setSync(phase)` 有变化才派发；订阅 `transport.onSync` 自动同步（构造时挂，`dispose` 不需要——store 与 transport 同生命周期）。
- `setParam(id, value)`：
  - 未找到/只读 → 派发 `LOCAL_ERROR_EVENT`（`kind:'readOnly'`）并 return（R2-3）。
  - `this._state.sync !== 'ready' && this._transport.kind === 'webhid'` → 只更新本地值并派发 `LOCAL_ERROR_EVENT`（`kind:'notSynced'`）**不调用 write**（C4）。注意：值为 `ready` 时正常 `write`。
  - 其余同现状（量化、无变化不派发、`write`、派发 change 与 param-changed）。
- `applyEcho(id, value)`：设备回读回填，**不触发 `write`**；量化后更新本地并派发 change（不发 `PARAM_CHANGED_EVENT`，因为不是用户操作）。
- 保持既有 `setBands/setLang/setScene/onChange/subscribe` 行为不变。

### 4.7 `ui/meter.ts`

```ts
export interface MeterChannel {
  readonly label: string;
  readonly rms: number;
  readonly peak: number;
  readonly state?: 'live' | 'muted' | 'unavailable';
}
```

- `state === 'unavailable'`：该通道不画柱、读数位置画 `—`（用 `formatDb` 之外的分支）、峰值保持清零且本次不参与包络积分。
- 其它值/缺省：行为与现状完全一致（不得改变现有视觉参数）。

### 4.8 `ui/views/console-view.ts`

- `createConsoleView(store: AppStore, transport: Transport, api: ConsoleApi)`（参数类型放宽）。
- 删除"无数据时塞 `-96` 占位帧"的逻辑；未连接（`store.get().sync !== 'ready' && store.get().transport !== 'ready'`）时给两通道 `state:'unavailable'`。
- 电平卡新增 `outputValid === false` 时输出两栏显示 `—`（R5-4）。
- 参数卡右上角显示 `演示数据`（`sync.badge.demo`）或 `同步中`（`sync.badge.syncing`），`sync === 'ready'` 时不显示。
- 防爆音开关改用 `limit.Enable`：`store.setParam('limit.Enable', on ? 1 : 0)`，读取 `params['limit.Enable'] === 1`（C-15）。

### 4.9 `ui/topbar.ts`

顶栏状态胶囊两个：

1. 数据来源：`通道= mock` → `sync.source.demo`（`演示数据`）；`webhid` 且 `ready` → `sync.source.device`（`已连接`）。
2. 同步相位：`sync.phase.{idle,syncing,ready,error}`。

### 4.10 `src/main.ts` 接线

```ts
const mock = new MockTransport({ scene: 'speech', hz: 50 });
const channel = new ChannelTransport(mock);
const store = new AppStore(channel, { lang: currentLang() });
const webhid = createWebHidSession({ bridgeUrl: readBridgeUrl() });
const link = new DeviceLink({ session: webhid, channel, mock, store });
// shell 的 device 面板注入 { session: webhid, link }，settings 面板注入 { store, link }
```

`readBridgeUrl()` 读 `localStorage['micstudio.bridgeUrl']`，缺省 `ws://127.0.0.1:8765/ws`。

### 4.11 i18n 新增键（本任务只加这批）

```
sync.source.demo / sync.source.device
sync.phase.idle / sync.phase.syncing / sync.phase.ready / sync.phase.error
sync.badge.demo / sync.badge.syncing
common.unavailable
device.warn.modelMismatch（含 {code}）
device.sync.note
```

中英两份键集必须一致（`Record<DictKey, string>` 会强制）。

---

### 4.12 `ui/views/input-view.ts`（必改：`gain` 模块从 2 项扩到 5 项）

SubStage 1.2 把 `mic.mute`（`0x2022`）、`mic.sigMute`（`0x2058`）、`hp.OnOff`（`0x2059`）归入 `module: 'gain'`。当前 `input-view.ts:28-30` 对 `paramsOf('gain')` **全部**用 `readonlyField` 渲染，导致这 3 个可写项在高级参数抽屉里显示为「只读」且无法操作（1.2 的截图 `artifacts/shot-advanced.png` 可复现）。

改成按 spec 分流：

| spec 特征 | 控件 |
|---|---|
| `spec.readonly === true`（`gain.Mic`/`gain.Hp`） | `readonlyField(spec, value)` |
| 布尔开关（`min === 0 && max === 1 && step === 1`） | `switchControl({ checked, label: t('param.<id>.label'), onChange })` |
| 其它 | `createParamFields(store, [spec])` 的节点（复用既有滑块与数字输入） |

要求：

1. 卡片 `tag` 从 `'READ ONLY'` 改成 `'5 PARAMS'`（与其它卡一致），`desc` 仍用 `module.gain.desc`，并在描述里补一句"增益只读，静音/监听可调"（`module.gain.desc` 文案由本任务更新，中英都要改）。
2. `store.onChange` 订阅里同步三类控件（`createParamFields` 的 `sync`、`setSwitchChecked`、`setReadonlyValue` 若有则用）。
3. 既有 `enc` 卡的开关/档位逻辑保持不动。
4. 不允许把只读项做成可编辑（会触发 `local-error`，见 4.6）。

---

### 4.13 真机 usage 过滤接线（Electron 约束，见设计 §5.13.5 与 §12 R-9）

Electron 33 的 `HIDDevice` 不含 `collections`，主进程无法按 usage 过滤。因此 usage 过滤必须落在**渲染进程的 `requestDevice({ filters })`**：

1. `src/renderer/src/device/webhid/types.ts`：`WebHidKit.requestNativeDevice(filters?: readonly { usagePage: number; usage: number }[]): Promise<WebHidDeviceHandle[]>`（把 `requestNativeDevice()` 改成可选参数，保持既有调用不破）。
2. `src/renderer/src/device/webhid/kit.ts`：`requestNativeDevice: (filters) => requestNativeHidDevice(filters?.length ? { filters } : undefined)`（子模块 `native.js:98` 已支持 `{ filters }`）。
3. `src/renderer/src/device/webhid/session.ts`：`requestNativeDevice(filters?)` 逐层透传。
4. `src/renderer/src/device/link.ts`：`attachNative(filters?)` 或由 `main.ts` 把 `ChannelConfig.whitelist.entries` 映射成 `filters` 后调 `session.requestNativeDevice(filters)`。
5. 设备抽屉的「请求真机设备」按钮改为调用 `link` 暴露的方法（把当前 `session.requestNativeDevice()` 的直调换成带 filters 的版本）。

测试：`tests/unit/webhid-session.test.ts` 增补一条"传 filters 时 kit 收到同样的 filters"（用 `FakeKit` 记录入参）。

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| `device.sendReport` 不存在 | `open()` 失败、`state='error'`、`onError({kind:'device'})`、文案 `device.error.device` |
| 写只读参数（`gain.Mic`） | 不发帧、`onError({kind:'readOnly'})`、store 派发 `local-error`（R2-3/R3-3） |
| 同步中改参数 | 本地值更新、`notSynced` 本地错误、不发帧（C4）；回读完成后不改写用户刚改的值（**回读覆盖优先**：`applyEcho` 直接覆盖，需在报告里说明该取舍） |
| 同步失败 | `status='error'`、切回 Mock、顶栏显示 `error` 相位、错误文案来自 `errorKeyOf` |
| 设备拔线（虚拟：静默） | 请求超时 → `ParamSession` 进 error → `WebHidTransport` 派发 `disconnected` → `DeviceLink` 切 Mock 并标记；电平在 1 s 内变 `—`（R5-3） |
| 重连 | 用户再点连接 → `attach` → 全量回读（R4-4） |
| `readAll()` 返回的 `device` 为 null（Mock） | `LinkState.device = null`，设备摘要显示"—" |

---

## 6. 测试要求

`tests/unit/transport.test.ts`（改写）必须包含：

1. 既有 12 条 Mock 用例全部保留（电平频率、3 dB 差、silence 区间、write 缓冲、退订等）。
2. Mock 新契约：`onSync` 在 `open()` 后收到 `'syncing'`→`'ready'`；`onParamEcho` 在 `write()` 后 5 ms 收到同值；`readAll()` 返回 `DEFAULT_PARAMS` 且 `device === null`。
3. `WebHidTransport` 用 `tests/unit/helpers/webhid-fakes.ts` 的 `FakeHidDevice`（需扩展：加 `sendReport`，把发送的 payload 记录下来并可自动回执）：
   - `open()` 后 `state='ready'`、`onSync` 收到 `'syncing'`→`'ready'`；
   - 写 `0x2024`（`enc.OnOff`）→ FakeHidDevice 收到一条 `func 0x10`、`addr 0x2024`、`raw 1`；
   - 写 `gain.Mic`（只读）→ **零帧**发出 + `onError({kind:'readOnly'})`（R2-3/R3-3）；
   - 回读：Fake 回 114 个值的 `0x13` 与 11 地址的 `0x12` → `readAll()` 的 `preset` 含 42 项（不含 `0x2057`）、`device.modelCode === 'JYM001'`；
   - 电平：Fake 回 `0x2057 = 0/128/256` → `LevelFrame.inputRms` 分别 `-96`/`-48`/`0`，`outputValid === false`、`outputRms === -96`（R5-1/R5-4）；
   - 设备 `disconnect` → `state='error'`。

`tests/unit/channel-transport.test.ts` 必须包含：

1. 初始 Mock：`kind === 'mock'`，转发 levels/state 正常。
2. `use(fakeWebhid)` 后 `kind === 'webhid'`，旧订阅仍收到新通道事件（不重订阅），且 Mock 的新事件不再转发。
3. `readAll()` 转发到 active。
4. 切回 Mock 后 `kind === 'mock'`。

`tests/unit/link.test.ts` 必须包含（用假 `WebHidSession` + 假 `Transport` + 真 `AppStore`）：

1. `attach` 成功：`channel.kind === 'webhid'`、`store.sync === 'ready'`、`store.get().params['noisegate.threshold_db']` 等于回读值（不是默认值）。
2. 型号码不匹配：`warning` 非空且 `status === 'ready'`（R4-3）。
3. `attach` 失败：`status='error'`、`channel.kind === 'mock'`、`store.sync === 'error'`。
4. 断开：假 transport 派发 `disconnected` → `channel.kind === 'mock'`（回到演示数据）。
5. `suspendForDfu`/`resumeAfterDfu`：相位与 `readAll` 调用次数（R4-7）。
6. EQ 回填：回读里含 7 段的 type/freq/gain/q，`store.get().bands[0..6]` 与之一致，`bands[7..13]` 保持本地默认。

`tests/unit/state.test.ts`（改写）必须包含：

1. `sync` 门控：`sync !== 'ready'` 且 `transport.kind === 'webhid'` 时 `setParam` 不发 `write`、派发 `local-error`；`sync === 'ready'` 时正常发。
2. 只读参数 `setParam` → 派发 `local-error({kind:'readOnly'})`、不发 `write`（既有"静默 return"的断言要改）。
3. `applyEcho` 更新值但不调用 `write`。
4. 既有用例（无变化不派发、快照冻结、语言/场景切换）保留。

`tests/unit/meter.test.ts`（新建，happy-dom）：

1. 三个通道 `state:'live'` 时 `render` 不抛（既有行为）。
2. `state:'unavailable'` 时不抛，且内部"峰值保持"被清零（可通过连续两帧的读数间接断言，或用导出的小函数断言——若 `MeterCanvas` 不便断言，允许把 `formatDb` 与包络计算抽成导出的纯函数再断言）。
3. `formatDb`（或等价函数）对 `unavailable` 返回 `'—'`、对 `muted` 返回 `'−∞'`。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| G1 | `pnpm run test`、`pnpm run typecheck` 全绿 | 命令输出 |
| G2 | 只读参数零出帧（R2-3/R3-3） | `transport.test.ts` 用例 |
| G3 | 回读值覆盖界面（R4-1，单测层面用假设备取证） | `link.test.ts` / `transport.test.ts` |
| G4 | 电平 0/128/256 落在下/中/上三段（R5-1） + 输出两栏 `—`（R5-4） | `transport.test.ts` |
| G5 | 未连接时顶栏出现 `演示数据` 胶囊、参数卡出现标记（问题清单 Q3） | 截图 `artifacts/v1.1.0-console-demo.png` |
| G6 | 顶栏三态胶囊文案中英双语正确 | 截图 `artifacts/v1.1.0-console-en.png` |
| G7 | 虚拟设备联调：连上后参数为回读值、改旋钮设备侧收到写帧（端到端） | 见 §6 末尾的端到端步骤 |

端到端取证（必须在完成报告里贴输出与截图）：

```powershell
# 终端 1
$node tools/vdevice/run.mjs
# 终端 2（Electron 实跑，切到虚拟通道并连接）
$env:MICSTUDIO_USER_DATA = 'D:\WorkShop\MicroPhone_WebHIDInterface\.userdata'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& node_modules\electron\dist\electron.exe . --screenshot=artifacts\v1.1.0-console-demo.png --no-sandbox
# 然后用 --exec-file=scripts/probes/device-connect.js 之类的探针脚本连接设备并再截一张
```

（探针脚本可按需新增到 `scripts/probes/`，只服务于取证，不参与业务。）

---

## 8. 禁止事项

1. 不得让 `WebHidTransport` 直接持有 `ParamSession` 之外的定时器逻辑（超时/节流都在 3.1 里）。
2. 不得在 `ChannelTransport.use()` 里重建订阅者（`main.ts` 只创建一次，UI 不得感知通道切换）。
3. 不得在 `store.setParam` 里直接 `toRaw`（标定只发生在 transport 层）。
4. 不得让 `applyEcho` 触发 `transport.write`（否则形成写环）。
5. 不得把 EQ 内部 7 段写进任何帧（R2-4）。
6. 不得在未连接时把 `-96` 当成"有效静音"画满或画空（R5-5）。
7. 不得修改 `device/proto/session.ts` 与 `device/diagnostics.ts`（属 3.1；确需变更按 §9 上报）。
8. 不得引入新的运行时依赖；不得改 `package.json` 的 `dependencies`。
9. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. G1–G7 逐条结论与取证位置（含两张截图路径）。
4. 端到端输出：侧车日志（收到哪些帧）、界面截图、`/control/stats`。
5. 因契约扩展而修改的既有测试清单（文件 + 用例 + 改动理由）。
6. 与设计文档的偏差（无则写"无偏差"）。
7. 对 SubStage 4.2 的交付说明：`suspendForDfu/resumeAfterDfu` 与 `WebHidTransport.suspend/resume` 的调用顺序。
