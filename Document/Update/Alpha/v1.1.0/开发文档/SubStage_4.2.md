# SubStage 4.2 — DFU 会话、升级界面与虚拟设备联调

> **所属 Stage**：Stage 4（固件升级）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 4.1（`dfu/frame.ts`、`dfu/image.ts`）、SubStage 2.2（虚拟下位机 DFU 侧与故障注入）、SubStage 3.2（`DeviceLink`、`WebHidTransport`、`ChannelTransport`）
> **并行状态**：需等待 4.1/2.2/3.2；SubStage 5.2 **可并行**（只碰 `src/main`、`src/preload`、`src/shared`）；SubStage 5.1 **必须在本任务之后**（共享 `ui/views/device-view.ts`）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

镜像能看懂之后，剩下的是"把它安全地送进设备"：进 DFU（写 `0x1008=1`）、探测、逐块写入、歧义态整轮重来、收尾等重枚举、回读版本确认。这条链路的每一条岔路都必须有明确的、可测的行为——因为**设备在发出信息帧之后就不回 App 了**（DFU 材料 §3.3），上位机是唯一的护栏。

本 SubStage 交付：

1. `DfuSession` 状态机（含歧义态整轮重来、超时、上限）；
2. `FirmwareController` 把会话接到 `DeviceLink` 与文件输入；
3. 固件升级抽屉（文件 → 预检 → 不可取消确认 → 进度 → 结果/出口）；
4. DFU 期间的主进程守卫接线（禁用睡眠 + 拦截退出，IPC 由 5.2 提供）；
5. 与虚拟下位机的全流程联调取证（成功 / 丢块 / 丢回执 / 校验和错 / 断电）。

---

## 2. 当前代码状态

| 文件 | 现状 |
|---|---|
| `src/renderer/src/device/dfu/{frame,image,index}.ts` | 4.1 产出 |
| `src/renderer/src/device/link.ts` | 3.2 产出：`attach/detach/suspendForDfu/resumeAfterDfu`；**没有**暴露内部 transport |
| `src/renderer/src/device/webhid-transport.ts` | 3.2 产出：`suspend()/resume()/selfCheck()` |
| `src/renderer/src/app/shell.ts` | `PanelId = 'advanced' \| 'device' \| 'settings'`；`openPanel/closePanel` |
| `src/renderer/src/ui/views/device-view.ts` | 4 张卡（devices/reports/connection/kit） |
| `tools/vdevice/**` | 2.x 产出：控制面 `/control/{stats,faults,mode,level,registers,reset,log}` |
| `window.micstudio` | `src/preload/index.ts` 现只暴露 `platform/appVersion/locale/requestHidDevice`；本任务只**调用** `setDfuActive?.(true/false)`（5.2 实现），调用处必须用可选链 |

---

## 3. 本 SubStage 产出文件

```
src/renderer/src/device/dfu/session.ts            新建（DfuSession + 类型）
src/renderer/src/device/dfu/controller.ts         新建（FirmwareController）
src/renderer/src/device/link.ts                   修改（增补 transport() 访问器，见 §4.2）
src/renderer/src/ui/views/firmware-view.ts        新建
src/renderer/src/app/shell.ts                     修改（PanelId 增 'firmware'）
src/renderer/src/ui/views/device-view.ts          修改（只加"固件升级"按钮与回调，不动 4 张卡结构）
src/renderer/src/i18n/zh.ts / en.ts               追加 fw.* 键
scripts/probes/firmware-flow.js                   新建（Electron 取证探针，可选）
tests/unit/dfu/session.test.ts                    新建
tests/unit/dfu/controller.test.ts                 新建
tests/unit/firmware-view.test.ts                  新建
```

---

## 4. 完整契约

### 4.1 `dfu/session.ts`

类型与签名原文见 `设计文档.md` §5.11；下面补齐实现细节。

```ts
export type DfuPhase =
  | 'idle' | 'preflight' | 'ready' | 'entering' | 'probing'
  | 'writing' | 'settling' | 'verifying' | 'done' | 'failed' | 'aborted';

export interface DfuProgress {
  readonly phase: DfuPhase;
  readonly blockIndex: number;
  readonly blockTotal: number;
  readonly percent: number;
  readonly round: number;
  readonly message: string;        // i18n key
}

export interface DfuError {
  readonly kind: 'preflight' | 'enterTimeout' | 'probeFailed' | 'statusCode'
    | 'statusInfo' | 'statusFail' | 'timeout' | 'restartExhausted' | 'settle' | 'verify' | 'channel';
  readonly status?: number;
  readonly round?: number;
  readonly blockIndex?: number;
  readonly detail?: string;
}

export interface DfuSessionOptions {
  readonly send: (reports: readonly Uint8Array[]) => void | Promise<void>;
  readonly timers?: Timers;
  readonly clock?: Clock;
  readonly timing?: Partial<typeof TIMING>;
  readonly deviceModelCode: () => string | null;
  readonly allowBootld?: boolean;         // 缺省 false（R6-9）
  readonly onProgress?: (progress: DfuProgress) => void;
  readonly onError?: (error: DfuError) => void;
  readonly onDiag?: (entry: DiagEntry) => void;
}

export class DfuSession {
  constructor(options: DfuSessionOptions);
  phase(): DfuPhase;
  preflight(bytes: Uint8Array):
    | { readonly ok: true; readonly info: DfuInfo; readonly blocks: number; readonly encrypted: boolean }
    | { readonly ok: false; readonly rejection: ImageRejection };
  async run(bytes: Uint8Array): Promise<void>;   // 失败时 reject(Error)，同时已派发 onError
  abort(): void;
  handleBytes(bytes: Uint8Array): void;
  dispose(): void;
}
```

流程与超时（`timing` 覆盖默认值）：

| 阶段 | 发出的帧 | 等待 | 成功条件 | 失败处理 |
|---|---|---|---|---|
| `preflight` | 无（**一帧都不发**） | — | `parseImage` + 型号匹配 + 非 `Bootld` | `onError({kind:'preflight'})`，`phase='failed'` |
| `entering` | 参数协议 `write 0x1008=1`（`00 10 00 0A 10 08 00 01 8D 09` 切包） | `0x02 ACK 0x0000`，超时 `requestTimeoutMs` | 收到 ACK（**不证明已进 DFU**） | 重发 1 次（共 2 次）后 `enterTimeout` |
| `probing` | `encodeDfuInfoFrame(info)` | `0x0B` 状态帧，超时 `dfuProbeTimeoutMs` | `0x03` → 进 `writing`；`0x01` → `statusInfo` 立即失败（不重试） | 超时重试（信息帧可重发，设备侧幂等）最多 `dfuProbeAttempts` 次；用尽 → `probeFailed` |
| `writing` | 逐块 `encodeDfuBlockFrame(block)`（用 `image.blocks`，**密文原样**） | 每块一个状态帧，超时 `dfuBlockTimeoutMs` | `0x03` → 下一块；`0x05` → `settling` | `0x04` → `statusFail`；`0x02` / 超时 / SigmaBus ACK 校验错 → **整轮重来**（见下） |
| 整轮重来 | 清空回包缓冲，`round++`，回到 `probing`（重发信息帧复位设备指针） | — | 新一轮成功 | `round > dfuRoundRestarts` → `restartExhausted` |
| `settling` | **不发送任何帧** | `dfuSettleTimeoutMs` 内等调用方触发（`FirmwareController` 调 `link.resumeAfterDfu()`） | 调用方 `complete()` | `settle` 超时 → `settle` 失败 |
| `verifying` | 由 `FirmwareController` 用参数协议回读 `0x000B`–`0x000D` | `requestTimeoutMs` | 与 `info.version` 相等（`000000` 通配镜像跳过比对） | `verify` 失败（但保留"设备已回 App"的说明） |

补充约束：

- `run()` 在非 `preflight`/`ready` 状态下调用 → 直接 reject（`Error('dfu already running')`）。
- `abort()` 只在 `entering`/`probing`/`writing` 有效；`settling` 之后无效（返回 false）。`abort()` 后 `phase='aborted'`，不再发帧、清定时器。
- `handleBytes`：用 `decodeSigmaStream` 解帧；`decodeDfuStatus` 优先，其次 `decodeSigmaAck`；未匹配的帧记诊断 warn 并丢弃。
- 进度：`percent` 按 `设计文档.md` §6.7 的权重公式；`blockIndex` 从 0 起，`blockTotal = image.blocks.length`。
- 诊断：每条出站/入站帧一条 `DiagEntry`（`summary` 形如 `DFU info len=20984 csum=0x4E0621AF`、`DFU block 12/82`、`DFU status 0x03 CONTINUE`）。
- `dispose()`：清所有定时器。

### 4.2 `device/link.ts` 增补

```ts
/** 返回当前活动的设备通道（webhid 时返回 WebHidTransport，mock 时返回 null） */
transport(): Transport | null;
```

只加访问器，不改既有行为。`FirmwareController` 用它拿设备句柄。

### 4.3 `dfu/controller.ts`

```ts
export interface FirmwareState {
  readonly phase: DfuPhase;
  readonly progress: DfuProgress | null;
  readonly error: DfuError | null;
  readonly info: DfuInfo | null;
  readonly confirmed: boolean;          // 用户是否已确认"不可取消"
  readonly fileName: string | null;
}

export interface FirmwareControllerOptions {
  readonly link: DeviceLink;
  readonly readFile?: (file: File) => Promise<Uint8Array>;   // 单测注入
  readonly timers?: Timers;
  readonly clock?: Clock;
  readonly timing?: Partial<typeof TIMING>;
}

export class FirmwareController extends EventTarget {
  constructor(options: FirmwareControllerOptions);
  state(): FirmwareState;
  onChange(cb: (state: FirmwareState) => void): () => void;
  /** 读文件 + 预检（不发帧）；失败返回错误文案键 */
  async selectFile(file: File): Promise<{ ok: true; info: DfuInfo; blocks: number } | { ok: false; message: string }>;
  /** 用户勾选"我已知悉升级中断的后果" */
  setConfirmed(confirmed: boolean): void;
  /** 开始升级；未确认 → 抛 Error('confirmation required')，不发任何帧 */
  async start(): Promise<void>;
  abort(): void;
}
export const FIRMWARE_CHANGE_EVENT = 'change';
```

行为：

1. `selectFile`：`readFile` → 建 `DfuSession`（`send` = 切 63 B 报文后调 `transport sendReport`，见下）→ `preflight` → 成功则 `phase='ready'` 并保存 `bytes`。
2. `start`：`state.confirmed === true` 才允许；调用 `link.suspendForDfu()` → `window.micstudio?.setDfuActive?.(true)` → `session.run(bytes)` → 成功进入 `settling` 后：`link.resumeAfterDfu()` → 回读版本 → `session.complete()`（4.1 未提供 `complete()`，本任务在 `session.ts` 里加 `complete(): void`，见 §4.5）→ `phase='done'` → `setDfuActive(false)`。
3. 失败：`setDfuActive(false)`、`phase='failed'`、保留 `error`；**不回滚设备**（设备已在 DFU），UI 提供"立即重试"（再 `start()`）与"重插后再试"（`link.attach` 后 `start()`）。
4. `send` 的实现：`const reports = splitFrame(frame); for (const r of reports) await device.sendReport(reportIds.out, r)`。`device`/`reportIds` 从 `link.transport()` 取：为此 `WebHidTransport` 增加 `readonly device: WebHidDeviceHandle` 与 `readonly reportIds: ReportIds` 两个只读字段（3.2 的类已存在，本任务可加字段，不得改其行为）。
5. DFU 期间若收到 `window.micstudio` 的 `micstudio:dfu-close-blocked` 事件（5.2 提供）：`phase` 不变，派发 `onError({kind:'channel', detail:'close-blocked'})` 由 UI 提示"升级中不能关闭"。

### 4.4 `ui/views/firmware-view.ts`

```ts
export interface FirmwareViewDeps {
  readonly controller: FirmwareController;
}
export function createFirmwareView(deps: FirmwareViewDeps): HTMLElement;
```

结构与文案（键前缀 `fw.*`）：

| 区块 | 内容 | 键 |
|---|---|---|
| 说明 | 顶部固定提示"升级中断后设备将停留在升级模式，需重新升级才能恢复" | `fw.warn.stuck` |
| 文件 | `<input type="file" accept=".bin">` + 文件名 + 大小 | `fw.file.pick` / `fw.file.none` / `fw.file.size` |
| 预检 | 型号 / 型号名 / 版本 / 长度 / 块数 / 校验和（hex） | `fw.info.model` / `fw.info.version` / `fw.info.length` / `fw.info.blocks` / `fw.info.checksum` |
| 确认 | 复选框 + 开始按钮（未勾选时 disabled） | `fw.confirm.check` / `fw.start` |
| 进度 | 阶段名 + `块 i/N` + 百分比 + 进度条 | `fw.phase.*` / `fw.block` |
| 出口 | 重试 / 重插后再试 / 关闭 | `fw.retry` / `fw.replug` / `fw.close` |
| 错误 | 错误标题 + 详情 | `fw.error.<kind>` |

要求：

- 所有文案经 `t()`，中英双语。
- `phase==='settling'` 时显示"正在等待设备重启，请勿拔线"（`fw.phase.settling`），并且"关闭"按钮 disabled。
- `phase==='done'` 显示新版本号（`fw.done.version`）。
- 视图必须能 `destroy()`（清订阅）。

### 4.5 `dfu/session.ts` 增补 `complete()`

```ts
/** 由调用方在 settle 完成、版本回读结束后调用，把 phase 从 'verifying' 推到 'done' */
complete(): void;
```

### 4.6 `app/shell.ts` 与 `device-view.ts`

- `PanelId` 增加 `'firmware'`；`ShellOptions` 增加 `firmware: () => HTMLElement`；尺寸 `'wide'`；标题键 `fw.title` / `fw.subtitle`。
- `createDeviceView(session, options?: { link?: DeviceLink; onOpenFirmware?: () => void })`：在 connection 卡下方加一个按钮 `fw.open`（`onClick = onOpenFirmware`）；**不得**改动既有 4 张卡的结构与键（5.1 会加诊断卡）。
- `main.ts` 增加：`const firmware = new FirmwareController({ link });`，shell 注入 `firmware: () => createFirmwareView({ controller: firmware })`。

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| `Bootld` 包（R6-9） | `selectFile` 返回 `{ ok:false, message:'fw.error.internalOnly' }`；**不发任何帧**；`start()` 不可用 |
| 未勾选确认就点开始 | 按钮 disabled；`controller.start()` 直接抛 `Error('confirmation required')` 且零出帧 |
| 预检失败（篡改/超界/型号不匹配） | `phase='failed'`、`error.kind='preflight'`、零出帧（R6-2/R6-3） |
| `EnterDfu` 无 ACK | 重发 1 次后 `enterTimeout`；UI 提示"请重插设备后再试" |
| 探测 3 次无状态帧 | `probeFailed`；UI 提供"重插后再试" |
| 块超时 / 收到 `0x02` | 整轮重来（R6-5/R6-6），`round++`，诊断里注明原因（`timeout` 或 `status 0x02`） |
| 第 3 轮仍失败 | `restartExhausted`，UI 提示"设备仍在升级模式，请勿断电，重试或联系支持" |
| 设备回 `0x01` | `statusInfo` 失败，立即停止（不重来） |
| 设备回 `0x04` | `statusFail`，UI 允许"立即重试"（设备停在 DFU，可立即重来） |
| 收 `0x05` 后超时没等到重连 | `settle` 失败；UI 提示"设备可能已重启，请点重连确认版本" |
| 回读版本与镜像不一致 | `verify` 失败，但 `phase='failed'` 里带"设备已回 App"说明 |
| 升级中关闭窗口 | `setDfuActive(true)` 生效后主进程拦截（5.2），渲染进程收到 `dfu-close-blocked` 并提示（R6-8） |
| `transport()` 返回 null（没连设备） | `selectFile` 直接失败 `fw.error.noDevice`，零出帧 |

---

## 6. 测试要求

`tests/unit/dfu/session.test.ts`（假时钟 + 假 `send`，用 `4.1` 的编码函数造回执）必须包含：

1. 快乐路径：信息帧 → `0x03`；82 块（用 1024 B 明文造 4 块即可）逐个 `0x03`；末块 `0x05`；`phase` 依次 `entering → probing → writing → settling`；`percent` 单调不减且末值 95（settling 前）。
2. `preflight` 零出帧：`session.run(坏包)` → `send` 调用 0 次、`onError({kind:'preflight'})`（R6-2/R6-3）。
3. 探测超时：信息帧不回 → 重发 **3 次信息帧**（`dfuProbeAttempts`）→ `probeFailed`；**总 `send` 次数 = 4**（1 次 EnterDfu + 3 次信息帧）。验收时按"信息帧 3 次"写脚本，不要按总次数 3。
4. 块超时整轮重来（**R6-6**）：第 2 块不回（假时钟推进 `dfuBlockTimeoutMs`）→ 断言重发信息帧、第 2 轮从第 0 块开始、最终成功、`round === 2`；并断言**没有**补发单个块（发送序列里不出现"同块连发两次"）。
5. 回执丢失（**R6-5**）：第 2 块收到了、但不回状态帧 → 与 4 相同（整轮重来）。
6. `0x02` 歧义态：某块回 `0x02` → 整轮重来。
7. 三轮都失败 → `restartExhausted`。
8. `0x01` → `statusInfo` 且 `send` 到此为止（不再发块）。
9. `0x04` → `statusFail`，不发后续块。
10. `settling` 期间零出帧：进入 settling 后推进 `dfuSettleTimeoutMs`，`send` 不再被调用；`complete()` 后 `phase==='done'`。
11. `abort()`：在 `writing` 中调用 → `phase='aborted'`、后续无出帧；`settling` 后调用返回 `false`。
12. `Bootld` 包 + `allowBootld:false` → `preflight` 失败；`allowBootld:true` → 成功进入 `probing`。

`tests/unit/dfu/controller.test.ts` 必须包含：

1. `selectFile` 对 `Bootld` 包返回 `fw.error.internalOnly`（R6-9），且 `start()` 不可用。
2. 未确认时 `start()` 抛错且 `send` 零次。
3. 确认后 `start()` 依次调用 `link.suspendForDfu()`、`setDfuActive(true)`、会话 `run`、`link.resumeAfterDfu()`、`setDfuActive(false)`（用假的 link 与 `window.micstudio` 桩）。
4. 失败路径 `setDfuActive(false)` 一定被调用（`try/finally`）。
5. 版本不一致 → `onError({kind:'verify'})`。

`tests/unit/firmware-view.test.ts`（happy-dom）必须包含：

1. 未选文件时开始按钮 disabled。
2. 选文件后预检摘要渲染（型号/长度/块数）。
3. 未勾选确认时开始按钮 disabled；勾选后 enabled。
4. `phase='writing'` 时进度文本含 `块 3/4`（或等价 key 渲染结果）。
5. `phase='done'` 时显示新版本，关闭按钮可用。
6. `destroy()` 后不再响应 controller 事件。

端到端联调（完成报告必须贴输出，不写成 vitest 用例）：

```powershell
# 1) 起虚拟下位机
$node tools/vdevice/run.mjs
# 2) 造一个 App 包（ModelCode=JYM001, Ver 1.2.3）
& $node -e "import('./tools/vdevice/package.mjs').then(async m=>{const fs=await import('node:fs');const img=Buffer.alloc(4096,0x5A);const r=m.buildPackage({image:new Uint8Array(img),modelCode:'JYM001',modelName:'M001',version:{x:1,y:2,z:3}});fs.writeFileSync('artifacts/vdevice/app-1.2.3.bin',Buffer.from(r.bytes));console.log(r.info)})"
# 3) Electron 实跑，走升级流程（探针脚本或手工），截图 + 侧车 stats
curl.exe -s http://127.0.0.1:8766/control/stats
# 4) 故障场景：丢第 40 块 → 应整轮重来并成功
curl.exe -s -X POST http://127.0.0.1:8766/control/faults -H "Content-Type: application/json" -d '{"faults":[{"on":{"dfuCmd":3,"nth":40},"action":"drop"}]}'
curl.exe -s -X POST http://127.0.0.1:8766/control/reset
```

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| I1 | `pnpm run test`、`pnpm run typecheck` 全绿 | 命令输出 |
| I2 | 预检失败零出帧（R6-2/R6-3）、`Bootld` 不可达（R6-9） | 单测 |
| I3 | 虚拟设备全流程成功且版本变化（R6-4） | 端到端 + 截图 + `stats.firmwareVersion` |
| I4 | 丢第 40 块 → 整轮重来成功（R6-5/R6-6） | 端到端 + `stats`（`round 2`） |
| I5 | 设备侧校验和错 → 界面报"固件校验失败"、设备停 DFU、可重试（R6-7） | 端到端 + 截图 |
| I6 | 升级中关闭窗口被拦截并提示（R6-8） | 端到端（`SetDfuActive` 生效后点关闭）+ 截图 |
| I7 | 升级中断电（`powerLoss`）后设备停在 DFU，重连后 UI 提示"仍在升级模式"（R7-4 的 `powerLoss`） | 端到端 + 截图 |
| I8 | 所有新增文案中英双语、经 `t()` | 两张截图（zh/en） |

---

## 8. 禁止事项

1. 不得在 `preflight` 阶段发出任何帧（包括 EnterDfu）；R6-2/R6-3 的"拒绝且不发帧"全靠这一条。
2. 不得补发单个块（C7）；歧义态只能整轮重来。
3. 不得在 `settling` 期间发送任何帧（会被设备当成新状态，回 `0x02`）。
4. 不得把 `FwLength`/`FwChecksum` 的校验下移到设备侧（设备侧不做，必须主机侧挡）。
5. 不得在 `Bootld` 包上提供任何 `allowBootld` 的 UI 开关（只允许测试代码传 `true`）。
6. 不得在升级失败时自动重连并重试（必须用户点）；不得在升级期间允许参数写（由 `link.suspendForDfu()` 保证）。
7. 不得改 `dfu/{frame,image}.ts` 的校验语义（属 4.1）。
8. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. 端到端五组取证输出与截图（成功 / 丢块重来 / 校验和错 / 关闭被拦 / 断电）。
4. I1–I8 逐条结论与取证位置。
5. 新增的 `fw.*` i18n 键清单（zh/en 对照）。
6. 与设计文档的偏差（无则写"无偏差"）。
7. 给 5.1 的交接：`device-view.ts` 里已加/未加的结构，避免 5.1 覆盖。
