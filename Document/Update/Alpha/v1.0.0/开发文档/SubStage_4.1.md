# SubStage 4.1 — 主进程完形、preload、截图模式与打包

- 所属 Stage：Stage 4
- 依赖前置：SubStage 1.1（骨架）、3.1–3.4（渲染端已可挂载）
- 并行状态：串行（打包依赖渲染端构建产物）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

把应用做成"双击就能跑"的桌面程序，并提供可复现的取证手段（截图模式）。交付 Windows 的 portable + nsis 两种产物；macOS/Linux 只落配置。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/main/index.ts` | 应用入口：userData 覆盖、单实例、窗口、菜单、IPC、截图模式 |
| `src/main/window.ts` | `createMainWindow()` |
| `src/main/screenshot.ts` | `captureAndExit(win, filePath)` |
| `src/main/webhid.ts` | `installWebHidHandlers(session)`（Alpha 只注册，不触发） |
| `src/preload/index.ts` | `contextBridge` 暴露 `window.micstudio` |
| `src/shared/types.ts` | `Lang`、`MicStudioApi`、IPC 通道常量 |
| `scripts/screenshot.mjs` | 批量截图脚本（6 个路由） |
| `electron-builder.yml` | 打包配置 |
| `build/README.md` | 说明图标文件应放在此目录（`icon.ico`/`icon.icns`/`icon.png`），本轮暂缺 |

## 3. 契约

### 3.1 主进程启动顺序（严格按此顺序）

```ts
// 1. userData 覆盖（必须在 whenReady 之前）
const override = process.env.MICSTUDIO_USER_DATA
  ?? (app.isPackaged ? '' : path.join(process.cwd(), '.userdata'));
if (override) app.setPath('userData', override);

// 2. 单实例锁：拿不到就退出
if (!app.requestSingleInstanceLock()) app.quit();

// 3. whenReady 后：安装 WebHID 处理器 → 创建窗口 → 注册 IPC
```

开发者态不要用 `os.tmpdir()`：本机 `%LOCALAPPDATA%\Temp` 下 Chromium 会刷一屏缓存目录权限错误。`process.cwd()` 在 dev 与 `electron.exe .` 场景即项目根。

### 3.2 窗口

```ts
export function createMainWindow(): BrowserWindow;
```

参数：`width 1280`、`height 820`、`minWidth 1100`、`minHeight 700`、`backgroundColor '#0e1118'`、`show: false`、`autoHideMenuBar: true`、`title: 'MIC STUDIO'`、`webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }`。

加载：dev（`process.env.ELECTRON_RENDERER_URL` 存在）→ `loadURL`；否则 `loadFile(path.join(__dirname, '../renderer/index.html'))`。`ready-to-show` → `show()`。

菜单：`Menu.setApplicationMenu(null)`（隐藏默认菜单，避免 Windows 上露出 Electron 菜单）。

### 3.3 截图模式

命令行参数：

- `--screenshot=<绝对文件路径>`：加载完成后等待 1500ms，`webContents.capturePage()` → `toPNG()` → 写文件，`console.log('[screenshot] ' + filePath)`，然后 `app.quit()`，退出码 0。
- `--route=<meter|input|eq|dynamics|drc|settings>`：加载完成后、截图前通过 `webContents.executeJavaScript("window.__micstudioGo && window.__micstudioGo('<route>')")` 切换模块；渲染端 `main.ts` 需暴露 `window.__micstudioGo = (r) => store.setModule(r)`（仅用于调试/取证）。
- 截图前额外等待 600ms 让 Canvas 完成一次绘制。

### 3.4 preload

```ts
const api: MicStudioApi = {
  platform: process.platform,
  appVersion: app.getVersion(),
  locale: app.getLocale(),
  requestHidDevice: () => ipcRenderer.invoke('micstudio:request-hid-device'),
};
contextBridge.exposeInMainWorld('micstudio', api);
```

主进程 `ipcMain.handle('micstudio:request-hid-device', async () => ({ ok: false, reason: 'not-implemented' }))`（Alpha 占位）。

### 3.5 WebHID 处理器

```ts
export function installWebHidHandlers(sess: Electron.Session): void;
```

内容：

```ts
sess.setPermissionCheckHandler((_wc, permission) => permission === 'hid');
sess.setDevicePermissionHandler((details) => details.deviceType === 'hid');
sess.on('select-hid-device', (event, details, callback) => {
  event.preventDefault();
  // Alpha 不自动选择设备；留空回调表示取消
  callback();
});
```

文件头注释说明：联调阶段在此处接入设备过滤与选择器。

### 3.6 `scripts/screenshot.mjs`

```js
// node scripts/screenshot.mjs
// 1) 若 out/renderer/index.html 不存在，先执行 electron-vite build
// 2) 依次对 6 个 route 启动 electron（spawn），参数：--screenshot=<abs> --route=<id> --no-sandbox
// 3) 每张截图超时 60s，失败记录到 artifacts/screenshot-failures.log 并继续下一张
// 4) 全部完成后打印汇总表：route / 文件路径 / 字节数 / 耗时
```

约束：Electron 可执行文件路径解析顺序 —— `node_modules/electron/dist/electron.exe`（Windows）或 `node_modules/electron/dist/electron`（其他）；不存在则报错退出（提示执行 `node node_modules/electron/install.js` 并设置 `ELECTRON_MIRROR`）。

环境变量：脚本内部为子进程设置 `MICSTUDIO_USER_DATA = <repo>/.userdata`（不存在则创建），`ELECTRON_RUN_AS_NODE` 必须从子进程环境中删除（否则 Electron 以 Node 模式启动并崩溃）。

### 3.7 `electron-builder.yml`

```yaml
appId: com.micstudio.app
productName: MicStudio
copyright: Copyright © 2026
directories:
  output: release
  buildResources: build
files:
  - out/**
  - package.json
asar: true
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  # icon: build/icon.ico   # 品牌图标待提供，缺失时使用 Electron 默认图标
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  shortcutName: MIC STUDIO
portable:
  artifactName: ${productName}-${version}-portable.exe
mac:
  target: [dmg]
  category: public.app-category.music
linux:
  target: [AppImage]
  category: AudioVideo
```

打包命令环境变量（必须，否则从 GitHub 拉资源超时）：

```
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

### 3.8 `package.json` 调整

- 新增 `"screenshot": "node scripts/screenshot.mjs"`。
- `"dist:win"` 保持 `"electron-vite build && electron-builder --win"`。
- `.gitignore` 追加 `artifacts/`、`release/`、`out/`、`.userdata/`。

## 4. 输入输出

- 输入：`out/renderer/index.html` 等构建产物。
- 输出：`release/MicStudio-<version>-portable.exe`、`release/MicStudio Setup <version>.exe`、`release/win-unpacked/`、`artifacts/shot-<route>.png`。

## 5. 验收标准

1. `pnpm run build` 通过。
2. `pnpm run screenshot` 产出 6 张 PNG，全部 > 20KB，控制台打印汇总表。
3. 用 `artifacts/shot-meter.png` 等图片肉眼确认：深色底、顶栏、导轨、对应页面内容可见，无白屏、无错位。
4. `pnpm run dist:win` 产出 portable 与 nsis 两个 exe；`release/win-unpacked/MicStudio.exe` 存在。
5. 启动 `release/win-unpacked/MicStudio.exe`（设置 `MICSTUDIO_USER_DATA`）能显示主窗口并保持运行 ≥10 秒，日志无 `APPCRASH`；
   启动 `release/*portable.exe` 同样通过（portable 解包启动较慢，等待上限 30 秒）。
6. 主窗口在 1280×820 下无横向滚动条；缩放窗口到 1100×700 不出现内容截断。

## 6. 禁止事项

- 不在主进程里实现 HID 字节编解码。
- 不关闭 `contextIsolation`/`sandbox`。
- 不使用远程 URL 作为窗口内容。
- 不改渲染端业务代码（发现缺口上报）。
- 不改 `Document/` 下任何文件。

## 7. 错误处理契约

- 截图失败：写 `artifacts/screenshot-failures.log`，脚本退出码 1，但已成功的图保留。
- 打包失败：先确认镜像环境变量已设置；仍失败则把完整日志写入 `artifacts/dist-failure.log` 并上报（不要反复重试超过 3 次）。
- 窗口加载失败（`did-fail-load`）：主进程记录 `[window] did-fail-load <code> <desc>`，10 秒后仍无内容则退出码 1（便于脚本判定）。

## 8. 依赖前置

需等待 SubStage 3.1–3.4 全部完成（渲染端可挂载）。本 SubStage 落盘后，4.2 负责整体集成与取证。
