# SubStage 5.2 — 真机通道放行、IPC 与 DFU 守卫

> **所属 Stage**：Stage 5（面板 / 真机 / 工程化）
> **所属阶段**：阶段三（开发）
> **依赖前置**：无代码依赖（只碰 `src/main`、`src/preload`、`src/shared`）。**必须已读**：`设计文档.md` §5.13.5、`AGENTS.md` §WebHID 接入（含"已知边界 2"）、DFU 材料 §6 ⑭⑮。
> **并行状态**：**可并行**（与 3.x/4.x/5.1 文件不重叠；与 5.1 的唯一交集是 `shared/types.ts` 的形状，由本任务先落地）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

现在主进程的 `select-hid-device` 是"一律取消"（`src/main/webhid.ts:9`），所以真机 `requestDevice()` 永远拿到空数组，设备页显示 `device.error.noSelection`。这是 `AGENTS.md` 里记的已知边界 2。

需求 R9 要求：按描述符/VID-PID 白名单放行，白名单可配置、不硬编码 VID/PID，白名单为空时行为与现状一致。

同时本版本还要两个基础设施：

1. **DFU 守卫**：升级期间禁止睡眠、拦截退出（R6-10）。主进程侧实现，渲染进程只调一个 IPC。
2. **版本/区域信息**：`appVersion`/`locale` 现在 preload 硬编码（`1.0.0-alpha.0` / `zh-CN`），与 `package.json` 各写一份，必须收敛到 `app.getVersion()`/`app.getLocale()`。

真机不在本版本验收范围，所以本任务的可验证标准是"逻辑正确、不崩、不误弹、错误可读"（R9 原文）。

---

## 2. 当前代码状态

| 文件 | 现状 |
|---|---|
| `src/main/webhid.ts` | 20 行；`installWebHidHandlers(session)`：权限检查放通 `'hid'`、设备权限放通 `deviceType==='hid'`、`select-hid-device` → `preventDefault()` + `callback()`（取消） |
| `src/main/index.ts` | userData 覆写、startup.log、单实例锁、菜单、窗口、`--screenshot/--hold/--exec-file`、`ipcMain.handle(IPC_REQUEST_HID_DEVICE, ...)` 固定返回 `{ok:false, reason:'not-implemented'}` |
| `src/preload/index.ts` | `contextBridge.exposeInMainWorld('micstudio', { platform, appVersion:'1.0.0-alpha.0', locale:'zh-CN', requestHidDevice })` |
| `src/shared/types.ts` | `Lang`、`PlatformInfo`、`HidDeviceRequestResult`、`MicStudioApi`、`IPC_REQUEST_HID_DEVICE` |
| `package.json` | `version: '1.0.0-alpha.0'` |
| 渲染进程引用点 | 只有 `settings-view.ts:111`（取 `appVersion`/`platform`）；`requestHidDevice` 无调用点；5.1 会调 `setHidWhitelist`；4.2 会调 `setDfuActive` |

---

## 3. 本 SubStage 产出文件

```
src/shared/webhid-whitelist.ts        新建（纯函数：白名单与设备描述的匹配）
src/shared/types.ts                   修改（新增白名单/IPC/DFU 相关类型与常量）
src/main/webhid.ts                    改写（白名单放行）
src/main/index.ts                     修改（IPC handlers、DFU 守卫、版本/区域信息）
src/preload/index.ts                  修改（暴露新 API，去掉硬编码版本）
package.json                          修改（version → 1.1.0）
tests/unit/webhid-whitelist.test.ts   新建
```

---

## 4. 完整契约

### 4.1 `src/shared/types.ts`

```ts
export type Lang = 'zh' | 'en';

export interface PlatformInfo {
  readonly platform: string;
  readonly appVersion: string;      // app.getVersion()
  readonly locale: string;          // app.getLocale()
}

export interface HidDeviceRequestResult { readonly ok: boolean; readonly reason?: string }

export interface HidUsageEntry { readonly usagePage: number; readonly usage: number }
export interface HidWhitelist {
  readonly entries: readonly HidUsageEntry[];
  readonly vids: readonly number[];
  readonly pids: readonly number[];
}

/** 主进程用于匹配的设备描述（从 Electron 的 details.device 归一而来） */
export interface HidDeviceDescriptor {
  readonly vendorId: number;
  readonly productId: number;
  readonly collections: readonly { readonly usagePage: number; readonly usage: number }[];
}

export const IPC_REQUEST_HID_DEVICE = 'micstudio:request-hid-device';
export const IPC_GET_PLATFORM_INFO = 'micstudio:get-platform-info';
export const IPC_SET_HID_WHITELIST = 'micstudio:set-hid-whitelist';
export const IPC_SET_DFU_ACTIVE = 'micstudio:set-dfu-active';
export const IPC_DFU_CLOSE_BLOCKED = 'micstudio:dfu-close-blocked';

export interface MicStudioApi {
  readonly platform: string;
  readonly appVersion: string;
  readonly locale: string;
  requestHidDevice(): Promise<HidDeviceRequestResult>;
  setHidWhitelist(list: HidWhitelist): Promise<void>;
  setDfuActive(active: boolean): Promise<void>;
  /** 升级期间用户点关闭时触发；返回退订函数 */
  onDfuCloseBlocked(cb: () => void): () => void;
}
```

`declare global { interface Window { micstudio?: MicStudioApi } }` 保持不变（可选属性）。

### 4.2 `src/shared/webhid-whitelist.ts`（纯函数，可在 vitest 里直接测）

```ts
export const DEFAULT_HID_WHITELIST: HidWhitelist;   // { entries:[{usagePage:0xFF01, usage:0x01}], vids:[], pids:[] }
export function normalizeWhitelist(raw: unknown): HidWhitelist;   // 非法项丢弃；全空 → 返回空白名单（不是默认值）
export function isEmptyWhitelist(list: HidWhitelist): boolean;    // 三项都空
export function matchesWhitelist(device: HidDeviceDescriptor, list: HidWhitelist): boolean;
```

匹配语义（必须逐条实现）：

1. `isEmptyWhitelist(list) === true` → 返回 `false`（等价"全部拒绝"，保持现状，R9-2）。
2. 命中 `entries` 任一项：`device.collections` 里存在 `c.usagePage === e.usagePage && c.usage === e.usage`。
3. 命中 `vids` 任一项：`device.vendorId === vid`。
4. 命中 `pids` 任一项：`device.productId === pid`。
5. 以上任一命中 → `true`；否则 `false`。
6. **不得**按产品名/序列号匹配；**不得**硬编码 VID/PID（默认白名单里 `vids/pids` 为空）。

### 4.3 `src/main/webhid.ts`

```ts
export function installWebHidHandlers(session: Session, options?: {
  readonly getWhitelist?: () => HidWhitelist;      // 缺省 () => DEFAULT_HID_WHITELIST
}): void;
```

- 权限检查与设备权限放行保持现状（放通 `'hid'`）。
- `session.on('select-hid-device', (event, details, callback) => {...})`：
  1. `event.preventDefault()`；
  2. `const list = options?.getWhitelist?.() ?? DEFAULT_HID_WHITELIST`；
  3. 在 `details.deviceList` 里找第一个 `matchesWhitelist()` 为真的设备；
  4. 命中 → `callback(device.deviceId)`，并 `console.info('[webhid] allowed device', {vendorId, productId})`；
  5. 未命中 → `callback()`（与现状一致），并 `console.info('[webhid] selection cancelled', {whitelistEmpty})`。
- **不得**在未命中时抛错或弹窗（R9-1：虚拟通道下不触发选择器，行为不变）。
- 白名单来源是主进程内存里的一份，由 IPC `set-hid-whitelist` 更新（见 §4.4）。

### 4.4 `src/main/index.ts`

新增：

```ts
let hidWhitelist: HidWhitelist = DEFAULT_HID_WHITELIST;
let dfuActive = false;
let powerBlockerId: number | null = null;

ipcMain.handle(IPC_SET_HID_WHITELIST, (_e, raw: unknown) => {
  hidWhitelist = normalizeWhitelist(raw);
  return undefined;
});
ipcMain.handle(IPC_GET_PLATFORM_INFO, () => ({
  platform: process.platform,
  appVersion: app.getVersion(),
  locale: app.getLocale(),
}));
ipcMain.handle(IPC_REQUEST_HID_DEVICE, async () => {
  // 现状保持：由渲染进程的 navigator.hid.requestDevice() 走选择器，
  // 这里只回一个"请走 WebHID API"的结果；true 表示主进程不拦截。
  return { ok: true };
});
ipcMain.handle(IPC_SET_DFU_ACTIVE, (_e, active: unknown) => {
  dfuActive = active === true;
  if (dfuActive) {
    if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
  return undefined;
});
```

窗口守卫：

```ts
mainWindow.on('close', (event) => {
  if (!dfuActive) return;
  event.preventDefault();
  mainWindow.webContents.send(IPC_DFU_CLOSE_BLOCKED);
});
app.on('before-quit', (event) => {
  if (!dfuActive) return;
  event.preventDefault();
  mainWindow?.webContents.send(IPC_DFU_CLOSE_BLOCKED);
});
```

要求：

- `installWebHidHandlers(session, { getWhitelist: () => hidWhitelist })`（把内存白名单接进去）。
- 守卫只影响"窗口关闭/退出"，不影响 `--hold` 与 `--screenshot` 的自动化路径（`--hold` 结束时用 `app.exit(0)` 而不是 `app.quit()`，已如此）。
- 启动日志（`startup.log`）增加一行 `dfuActive=false` 与 `whitelistEntries=<n>`，便于取证。

### 4.5 `src/preload/index.ts`

```ts
const api: MicStudioApi = {
  platform: process.platform,
  appVersion: '0.0.0',       // 由 getPlatformInfo 覆盖
  locale: 'zh-CN',
  requestHidDevice: () => ipcRenderer.invoke(IPC_REQUEST_HID_DEVICE),
  setHidWhitelist: (list) => ipcRenderer.invoke(IPC_SET_HID_WHITELIST, list),
  setDfuActive: (active) => ipcRenderer.invoke(IPC_SET_DFU_ACTIVE, active),
  onDfuCloseBlocked: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC_DFU_CLOSE_BLOCKED, handler);
    return () => ipcRenderer.removeListener(IPC_DFU_CLOSE_BLOCKED, handler);
  },
};
```

版本/区域的落地方式：preload 里调 `ipcRenderer.invoke(IPC_GET_PLATFORM_INFO)` 并用 `contextBridge` 暴露一个 `ready: Promise<PlatformInfo>`，**或者**更简单——把 `appVersion` 写成同步预置值由主进程通过 `additionalArguments` 注入。

**选定方案（本任务实现这一个，不要两种都做）**：主进程创建窗口时加
`webPreferences.additionalArguments: ['--micstudio-platform-info=' + JSON.stringify(info)]`；
preload 从 `process.argv` 里解析该参数，得到 `platform/appVersion/locale` 的真实值，再暴露给渲染进程（无需 async）。
解析失败时回落到 `process.platform` / `'0.0.0'` / `'zh-CN'`，并在控制台 warn 一行。

### 4.6 `package.json`

`version` 改为 `1.1.0`（引用点为 `app.getVersion()` 与 `electron-builder` 产物名）。

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| 白名单为空（三项全空） | `matchesWhitelist` 恒 false → `callback()` 取消（R9-2，与现状一致） |
| 白名单命中 | `callback(deviceId)`（R9-3） |
| 白名单含非法项 | `normalizeWhitelist` 丢弃该项；全丢后变空白名单 |
| IPC 传非对象 | `normalizeWhitelist` 返回空白名单，不抛 |
| 虚拟通道 | 不触发 `select-hid-device`（`navigator.hid` 被 polyfill 替换），行为不变（R9-1） |
| `setDfuActive(true)` 后点关闭 | 窗口不关，渲染进程收到 `dfu-close-blocked` 事件 |
| `setDfuActive(true)` 两次 | `powerSaveBlocker` 只 start 一次（用 `powerBlockerId` 去重） |
| `setDfuActive(false)` 未 start 过 | 不抛错 |
| 升级中进程被强杀 | 无法拦截（记录在验收文档边界里） |
| preload 解析参数失败 | 回落默认值 + warn，不抛 |

---

## 6. 测试要求

`tests/unit/webhid-whitelist.test.ts` 必须包含：

1. `DEFAULT_HID_WHITELIST`：`entries` 长度 1、`{0xFF01,0x01}`、`vids/pids` 空。
2. `matchesWhitelist` 对 `{collections:[{usagePage:0xFF01, usage:1}]}` → true；`{usagePage:0xFF00, usage:1}` → false。
3. 空设备（无 collections、vid/pid 都为 0）→ false。
4. `vids:[0x352F]` + 设备 vid 0x352F → true；vid 不同 → false。
5. 空白名单（三项全空）→ 任何设备都 false（R9-2）。
6. `normalizeWhitelist({entries:[{usagePage:0xFF01,usage:1},{usagePage:-1,usage:1},null], vids:['x',123], pids:[0x1111]})` → 只保留合法项（`vids:[123]`、`pids:[4353]`）。
7. `normalizeWhitelist('nonsense')` → 空白名单，不抛。
8. `isEmptyWhitelist` 三种组合。

主进程侧无法在 vitest 里跑（Electron 环境），因此**必须**在完成报告里给出下面三条静态取证：

```powershell
# 1) webhid.ts 不再"一律取消"：必须能看到 matchesWhitelist 与 callback(device.deviceId)
Select-String -Path src/main/webhid.ts -Pattern 'matchesWhitelist|callback\('
# 2) 主进程不再硬编码版本号
Select-String -Path src/main/index.ts,src/preload/index.ts -Pattern "1\.0\.0-alpha\.0"    # 期望无匹配
# 3) DFU 守卫存在
Select-String -Path src/main/index.ts -Pattern 'IPC_SET_DFU_ACTIVE|powerSaveBlocker|IPC_DFU_CLOSE_BLOCKED'
```

并附一次 Electron 实跑日志：`startup.log` 里出现 `dfuActive=false`、`whitelistEntries=1`，且窗口正常创建（`--screenshot` 出一张图）。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| K1 | `pnpm run test`、`pnpm run typecheck` 全绿 | 命令输出 |
| K2 | 白名单空时 `matchesWhitelist` 恒 false（R9-2） | 单测 5 |
| K3 | 白名单命中时匹配返回 true（R9-3 的逻辑侧） | 单测 2 |
| K4 | `src/main/webhid.ts` 不再是"一律 callback()" | §6 的静态取证 |
| K5 | 无硬编码版本号，`package.json` 为 `1.1.0`，`startup.log` 里的 `appVersion` 为 `1.1.0` | 静态取证 + startup.log |
| K6 | 虚拟通道行为不变（设备页仍能连虚拟设备） | Electron 实跑 + 截图 |
| K7 | DFU 守卫三处代码存在且 `setDfuActive(true)` 后关闭窗口不退出 | 手工/探针取证 + 截图 |
| K8 | `git status --porcelain third_party` 为空 | git 输出 |

---

## 8. 禁止事项

1. 不得硬编码 VID/PID 作为放行条件（默认白名单只按 Usage Page/Usage）。
2. 不得在 `select-hid-device` 里同步弹自定义确认框（Electron 要求由 `requestDevice` 的用户手势驱动）。
3. 不得把白名单写进 `localStorage`（主进程读不到；持久化在渲染进程，经 IPC 下发）。
4. 不得让 DFU 守卫影响 `--screenshot`/`--hold` 自动化路径。
5. 不得同时实现"async 版"和"argv 注入版"两种平台信息通道（只做 §4.5 选定的那一种）。
6. 不得修改 `src/renderer/**`（属其它 SubStage）。
7. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. §6 的三条静态取证输出 + `startup.log` 片段 + 一张实跑截图。
4. K1–K8 逐条结论与取证位置。
5. 与设计文档的偏差（无则写"无偏差"）。
6. 明确报告"真机未验证"的边界：本任务只做到逻辑正确与不崩，不声称真机能连。
