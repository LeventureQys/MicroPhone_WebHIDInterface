# SubStage 5.1 — 诊断面板、设置通道卡与文案

> **所属 Stage**：Stage 5（面板 / 真机 / 工程化）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 3.1（`DiagnosticsHub`）、3.2（`DeviceLink`/`ChannelTransport`/`LinkState`）、4.2（`firmware-view` 与 `device-view` 的按钮块）。**必须先读 4.2 的完成报告**，不要覆盖它加进 `device-view.ts` 的结构。
> **并行状态**：需等待 4.2；与 SubStage 5.2 **可并行**（5.2 只碰 `src/main`、`src/preload`、`src/shared`）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

联调时最贵的成本是"看不见发生了什么"。需求 R8 要求一个可折叠的诊断分区：帧日志（时间/方向/hex/解析字段）、统计（出/入帧、CRC 错、超时、重试、丢弃、队列深度）、设备摘要、一键自检、日志可复制。R9 要求真机白名单可配置（本任务只做 UI 与持久化，主进程放行在 5.2）。

做完之后：一次写操作能在面板里看到请求帧与 ACK 两条；注入 CRC 错能看到计数 +1 且标红；复制出来的文本能直接贴进问题单。

---

## 2. 当前代码状态

| 文件 | 现状 |
|---|---|
| `src/renderer/src/ui/views/device-view.ts` | 4 张卡（devices/reports/connection/kit）+ 4.2 加的「固件升级」按钮；`createDeviceView(session: WebHidSession)`（4.2 已扩成 `(session, options?)`） |
| `src/renderer/src/ui/views/settings-view.ts` | 3 张卡（ui/data/about）；不订阅 store；`destroy` 清两个定时器 |
| `src/renderer/src/device/diagnostics.ts` | 3.1 产出：`DiagnosticsHub`（`push/entries/update/stats/toText/clear`） |
| `src/renderer/src/device/link.ts` | 3.2 产出：`LinkState`（含 `device: DeviceSnapshot \| null`） |
| `src/renderer/src/i18n/{zh,en}.ts` | 各 221 键 + 3.2/4.2 新增的 `sync.*`/`fw.*`；**无** `diag.*`、`settings.channel.*` |
| `localStorage` 键 | 3.2 已用 `micstudio.bridgeUrl`；本任务新增 `micstudio.channel`/`micstudio.reportId.out`/`micstudio.reportId.in`/`micstudio.whitelist` |

---

## 3. 本 SubStage 产出文件

```
src/renderer/src/domain/channel-config.ts        新建（配置读写 + 默认值 + 校验）
src/renderer/src/ui/views/device-view.ts         修改（新增「诊断」卡与设备摘要）
src/renderer/src/ui/views/settings-view.ts       修改（新增「通道」卡）
src/renderer/src/i18n/zh.ts / en.ts              追加 diag.* / settings.channel.* / common.* 键
src/renderer/src/main.ts                         修改（把 hub / config 注入两个视图）
tests/unit/channel-config.test.ts                新建
tests/unit/device-view-diag.test.ts              新建
tests/unit/settings-channel.test.ts              新建
```

---

## 4. 完整契约

### 4.1 `domain/channel-config.ts`

```ts
export type ChannelKind = 'mock' | 'virtual' | 'native';

export interface ChannelConfig {
  readonly kind: ChannelKind;
  readonly bridgeUrl: string;
  readonly reportIdOut: number;
  readonly reportIdIn: number;
  readonly whitelist: { readonly usagePage: number; readonly usage: number }[];
  readonly useVidPid: boolean;
  readonly vids: readonly number[];
  readonly pids: readonly number[];
  readonly diagLimit: number;              // 100..2000，默认 500
}

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig;   // kind:'mock'、bridgeUrl:'ws://127.0.0.1:8765/ws'、0x51/0x11、whitelist:[{65281,1}]、diagLimit:500
export function loadChannelConfig(storage?: Pick<Storage,'getItem'>): ChannelConfig;   // 缺省用 localStorage
export function saveChannelConfig(config: ChannelConfig, storage?: Pick<Storage,'setItem'>): void;
export function normalizeChannelConfig(raw: unknown): ChannelConfig;   // 逐字段校验并回落默认
export function parseReportId(text: string): number | null;            // 接受 '81' / '0x51'；非法返回 null
export function formatReportId(id: number): string;                    // '0x51'
export function parseVidPidList(text: string): number[];               // '0x352F, 0x1234' → [13615, 4660]
```

`normalizeChannelConfig` 规则：`kind` 不在三个值里 → 默认；`bridgeUrl` 非 `ws://`/`wss://` 开头 → 默认；report ID 不在 `1..255` → 默认；`whitelist` 每项 `usagePage/usage` 必须是 `0..0xFFFF` 的整数，非法项丢弃（全非法则回落默认）；`diagLimit` 夹到 `100..2000`。

### 4.2 `ui/views/device-view.ts` 新增「诊断」卡

签名扩展（保持向后兼容）：

```ts
export interface DeviceViewOptions {
  readonly link?: DeviceLink;
  readonly hub?: DiagnosticsHub;
  readonly onOpenFirmware?: () => void;      // 4.2 已引入
  readonly onOpenSettings?: () => void;      // 新增
}
export function createDeviceView(session: WebHidSession, options?: DeviceViewOptions): HTMLElement;
```

「诊断」卡结构（`<details>` 默认折叠）：

| 区域 | 内容 | 键 |
|---|---|---|
| 设备摘要 | 型号 / 名称 / 固件 `X.Y.Z.Build` / VID / PID / SN / `0x1007` 最近通讯错误 | `diag.device.*` |
| 统计行 | 出帧 / 入帧 / CRC 错 / 超时 / 重试 / 丢弃轮询 / 队列 | `diag.stats.*` |
| 自检 | 按钮 → `WebHidTransport.selfCheck()` → 逐条结果列表 | `diag.selfcheck.*` |
| 日志 | 最近 **200** 条渲染（`diag.log.empty` 占位）；CRC 错条目加 `is-error` 样式 | `diag.log.title` |
| 操作 | 复制（导出全部 `diagLimit` 条）/ 清空 | `diag.copy` / `diag.clear` / `diag.copied` / `diag.copyFallback` |

要求：

- 未连设备时摘要显示 `—`，统计全 0，自检按钮 disabled。
- 订阅 `hub` 的 `entry`/`stats` 事件；`destroy()` 时退订（由 `shell` 在关闭抽屉时调用）。
- 复制走 `navigator.clipboard.writeText(hub.toText())`，`catch` 后弹出一个只读 `<textarea>` 并 `select()`（R8-3）。
- 只渲染最近 200 条的 DOM（内存与性能），复制导出全部 500（`diagLimit`）。

### 4.3 `ui/views/settings-view.ts` 新增「通道」卡

签名：`createSettingsView(store: AppStore, options?: { configStore?: ChannelConfigStore; link?: DeviceLink })`。
`ChannelConfigStore` 由 `main.ts` 创建：`{ get(): ChannelConfig; set(patch: Partial<ChannelConfig>): void; subscribe(cb): () => void }`（内部读写 `localStorage` 并派发变更）。

控件：

| 控件 | 行为 | 键 |
|---|---|---|
| 通道类型 segmented（mock/virtual/native） | 写入 `kind`；切到它时提示"下次连接生效" | `settings.channel.kind` / `settings.channel.kind.*` |
| 桥接地址 input | 失焦时校验 `ws://` 前缀，非法标红不保存 | `settings.channel.bridgeUrl` |
| report ID out/in input | 接受 `0x51`/`81`；非法不保存 | `settings.channel.reportId` |
| 白名单 textarea | 每行 `usagePage:usage`（十进制或 0x 十六进制） | `settings.channel.whitelist` |
| VID/PID 列表 + 开关 | 逗号分隔，开关打开才参与匹配 | `settings.channel.vidpid` |
| 诊断上限 number | `100..2000` | `settings.channel.diagLimit` |

保存后立即写 `localStorage`，并调用 `window.micstudio?.setHidWhitelist?.(...)`（可选链，5.2 实现）。

### 4.4 i18n 新增键（本任务）

```
diag.title / diag.subtitle / diag.device.model / diag.device.name / diag.device.firmware
diag.device.vidpid / diag.device.serial / diag.device.comErr / diag.device.none
diag.stats.out / diag.stats.in / diag.stats.crc / diag.stats.timeout / diag.stats.retry
diag.stats.dropped / diag.stats.queue
diag.selfcheck.run / diag.selfcheck.ok / diag.selfcheck.fail / diag.selfcheck.disabled
diag.log.title / diag.log.empty / diag.copy / diag.clear / diag.copied / diag.copyFallback
settings.channel.title / settings.channel.desc / settings.channel.kind / settings.channel.kind.mock
settings.channel.kind.virtual / settings.channel.kind.native / settings.channel.bridgeUrl
settings.channel.reportId / settings.channel.whitelist / settings.channel.vidpid
settings.channel.diagLimit / settings.channel.invalid / settings.channel.saved
common.none / common.copy / common.clear
```

中英键集必须一致（`Record<DictKey, string>` 会强制编译期检查）。

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| `hub` 未注入（例如单测只传 session） | 诊断卡显示 `diag.log.empty`，不抛错（向后兼容） |
| `navigator.clipboard` 不存在 | 走 `<textarea>` 回落，提示 `diag.copyFallback` |
| 白名单输入全非法 | 不保存，标红 `settings.channel.invalid`，保留旧值 |
| report ID 输入 `0` | 非法（0 是保留值），标红 |
| 诊断上限超范围 | 夹紧到边界并回写输入框 |
| `localStorage` 不可用（隐私模式） | 全部走内存默认值，不抛错（`loadChannelConfig` 内 try/catch） |
| 设置变更后 | 立即持久化；连接状态下提示"重连后生效"（不主动断开） |

---

## 6. 测试要求

`tests/unit/channel-config.test.ts` 必须包含：

1. `DEFAULT_CHANNEL_CONFIG` 各字段断言（含 `0x51`/`0x11`、白名单 `{65281,1}`）。
2. `normalizeChannelConfig` 对脏数据（`kind:'x'`、`bridgeUrl:'http://x'`、`reportIdOut:0`、`diagLimit:9999`、`whitelist:'x'`）逐项回落到默认/夹紧。
3. `loadChannelConfig` 用假 storage（`getItem` 返回 `null` → 默认；返回脏 JSON → 默认；返回合法 JSON → 解析）。
4. `saveChannelConfig` 写入的 JSON 可被 `loadChannelConfig` 读回（往返）。
5. `parseReportId('0x51')===81`、`parseReportId('81')===81`、`parseReportId('0')===null`、`parseReportId('abc')===null`、`parseReportId('256')===null`。
6. `parseVidPidList('0x352F, 4660')=== [13615, 4660]`；空串 → `[]`；非法项丢弃。

`tests/unit/device-view-diag.test.ts`（happy-dom）必须包含：

1. 未注入 `hub` 时创建不抛错，诊断卡存在且显示空态。
2. 注入 `hub` 后推 3 条日志 → DOM 里出现 3 行；推 205 条 → 只渲染 200 行（R8-4 的渲染上限）。
3. `update({crcErrors:1})` 后统计行文本含 `1`；CRC 错条目带 `is-error` 类。
4. `destroy()` 后推日志不再改 DOM。
5. 未连设备时自检按钮 disabled（用 `link` 的假实现）。

`tests/unit/settings-channel.test.ts`（happy-dom）必须包含：

1. 「通道」卡渲染 6 个控件；初始值来自 `configStore.get()`。
2. 改通道类型 → `configStore.set` 被调用且值为 `'virtual'`。
3. 输入非法 report ID → 标红且 `set` 未被调用。
4. 改诊断上限 9999 → 输入框被夹到 2000 且 `set` 被调用（`diagLimit:2000`）。
5. `window.micstudio.setHidWhitelist` 是桩时被调用（用 `vi.stubGlobal`）。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| J1 | `pnpm run test`、`pnpm run typecheck` 全绿 | 命令输出 |
| J2 | 一次写操作在日志里出现请求帧 + ACK 两条，解析字段正确（R8-1） | 截图 `artifacts/v1.1.0-diag-write.png` |
| J3 | 注入 CRC 错后统计 +1 且日志标红（R8-2） | 截图 `artifacts/v1.1.0-diag-crc.png` |
| J4 | 复制文本含地址与工程量、可直接读（R8-3） | 复制文本贴进报告 |
| J5 | 日志上限生效、内存稳定（R8-4） | 单测 2 |
| J6 | 面板默认折叠、不新增路由（R8-1/R8-4） | 截图 |
| J7 | 设置里可改四项配置并持久化，重启后仍在 | 截图 + `localStorage` dump |
| J8 | 所有新文案中英双语 | 两张截图（zh/en） |

---

## 8. 禁止事项

1. 不得新增路由/导航（只在既有抽屉里加卡）。
2. 不得覆盖 4.2 在 `device-view.ts` 里加的「固件升级」按钮与 `onOpenFirmware` 参数。
3. 不得把诊断日志落盘或上传（默认不落盘，需求 R3-7）。
4. 不得在渲染 500 条 DOM（只渲染 200 条，复制导出全量）。
5. 不得把 `localStorage` 失败当成致命错误（必须回落内存默认值）。
6. 不得在设置页直接断开/重连设备（只持久化，重连由用户操作）。
7. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. J1–J8 逐条结论与取证位置（含 4 张截图路径与一段复制出的日志文本）。
4. 新增 i18n 键的中英对照清单。
5. 与设计文档的偏差（无则写"无偏差"）。
6. 给 5.2 的交接：设置页期望的 `setHidWhitelist` 入参形状与调用时机。
