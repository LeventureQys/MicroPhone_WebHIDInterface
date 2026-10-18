# SubStage 1.1 — 工程初始化与构建链路

- 所属 Stage：Stage 1
- 依赖前置：无
- 并行状态：不可并行（Stage 1 只有这一个 SubStage，后续 Stage 全部依赖它）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

仓库当前只有 `Document/`，没有任何代码。本 SubStage 建立 Electron + electron-vite + TypeScript 的可构建骨架：三端（main / preload / renderer）能编译、能起窗口、单元测试能跑。**不实现任何业务界面**，只保证链路通。

## 2. 交付文件

在工作区根 `D:\WorkShop\MicroPhone_WebHIDInterface` 下创建：

| 文件 | 职责 |
|---|---|
| `package.json` | 依赖与脚本（内容见 §3.1） |
| `electron.vite.config.ts` | 三端构建配置（见 §3.2） |
| `tsconfig.json` + `tsconfig.node.json` | 严格模式、别名 `@shared/*`、`@renderer/*` |
| `.gitignore` | 忽略 `node_modules/`、`out/`、`release/`、`artifacts/`、`.userdata/` |
| `src/shared/types.ts` | 共享类型占位（`Lang`、`PlatformInfo`） |
| `src/main/index.ts` | 最小主进程：创建 1280×820 窗口，按 §3.3 规则决定 userData 路径，加载 renderer |
| `src/preload/index.ts` | 最小 preload：`contextBridge.exposeInMainWorld('micstudio', {...})` |
| `src/renderer/index.html` | 挂载点 `<div id="app">`，`<script type="module" src="/src/main.ts">` |
| `src/renderer/src/main.ts` | 最小引导：写入一行 `MIC STUDIO` 占位文本 + 打印 `[boot] renderer ready` |
| `src/renderer/src/styles/tokens.css` | 全部 CSS 变量（照抄设计文档 §5.11 表格，一个不差） |
| `src/renderer/src/styles/base.css` | reset、字体栈、滚动条样式、`html,body,#app { height:100% }` |
| `src/renderer/src/styles/layout.css` | `.app-shell`、`.topbar`、`.navrail`、`.content` 的最小骨架布局（尺寸照设计文档 §5.11：顶栏 64px、导轨 84px、内容 padding 24px） |
| `vitest.config.ts` | `environment: 'happy-dom'`，`include: ['tests/unit/**/*.test.ts']` |
| `tests/unit/smoke.test.ts` | 断言 1+1=2 与 happy-dom 可用（占位，后续 SubStage 会扩充测试目录） |
| `scripts/screenshot.mjs` | 占位：打印"由 SubStage 4.1 实现"，退出码 0 |

## 3. 契约

### 3.1 `package.json` 关键字段

```json
{
  "name": "micstudio",
  "version": "1.0.0-alpha.0",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "screenshot": "node scripts/screenshot.mjs",
    "dist:win": "electron-vite build && electron-builder --win"
  },
  "devDependencies": {
    "electron": "33.4.11",
    "electron-vite": "5.0.0",
    "electron-builder": "26.15.3",
    "vite": "5.4.21",
    "typescript": "5.6.3",
    "vitest": "1.6.1",
    "happy-dom": "20.14.6"
  }
}
```

**不得带 `"type": "module"`**：带上会让 preload 产物变成 `index.mjs`，而主进程按 `index.js` 引用，运行时 `Unable to load preload script`（已实测）。electron-vite 用 5.0.0——6.x 要求 vite ≥ 6，与 vite 5 组合直接构建失败（已实测）。

版本号必须**精确锁定**（不加 `^`）。安装完确认 `pnpm-lock.yaml` 生成并提交。若 `node_modules/electron/dist` 不存在（pnpm 忽略 postinstall），执行 `node node_modules/electron/install.js` 并设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

### 3.2 `electron.vite.config.ts`

```ts
import path from 'node:path';

export default defineConfig({
  main:    { build: { outDir: 'out/main',    rollupOptions: { input: 'src/main/index.ts' } } },
  preload: { build: { outDir: 'out/preload', rollupOptions: { input: 'src/preload/index.ts' } } },
  renderer:{
    root: 'src/renderer',
    build: {
      outDir: path.resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: path.resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
```

renderer 的 `outDir` **必须**是绝对路径：写成 `../../out/renderer` 会相对 `src/renderer` 解析，产物落到项目外（已实测）。

别名：`@shared` → `src/shared`，`@renderer` → `src/renderer/src`（三端都要配）。

### 3.3 主进程 userData 覆盖规则（关键，缺了本机起不来）

在 `app.whenReady()` **之前**执行：

```ts
const override = process.env.MICSTUDIO_USER_DATA
  ?? (app.isPackaged ? '' : path.join(process.cwd(), '.userdata'));
if (override) app.setPath('userData', override);
```

原因：本机沙箱环境下 Electron 用默认 `%APPDATA%` 会主进程崩溃（0xC0000005）；用 `os.tmpdir()` 虽能起窗口但 Chromium 缓存目录全部报权限拒绝。开发态落项目内 `.userdata`，打包产物由环境变量指定。

### 3.4 主进程窗口

`BrowserWindow` 参数：`width 1280`、`height 820`、`minWidth 1100`、`minHeight 700`、`backgroundColor '#0e1118'`、`show: false`、`autoHideMenuBar: true`、`webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }`。`ready-to-show` 后 `show()`。

dev 加载 `process.env.ELECTRON_RENDERER_URL`，否则 `loadFile(path.join(__dirname, '../renderer/index.html'))`。

`app.on('window-all-closed')` → 非 darwin 时 `app.quit()`。

### 3.5 preload 暴露面

```ts
contextBridge.exposeInMainWorld('micstudio', {
  platform: process.platform,
  appVersion: '1.0.0-alpha.0',
  locale: navigator.language,
});
```

本 SubStage 不实现 HID 请求（4.1 补）。

## 4. 输入输出

- 输入：本任务书 + 设计文档 §5.11 的颜色/尺寸表。
- 输出：可构建工程；`out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` 三处产物存在。

## 5. 验收标准（必须逐条自测并在完成报告贴输出）

1. `pnpm install` 完成，`node_modules/electron/dist/electron.exe` 存在（若缺失，执行 `node node_modules/electron/install.js` 并设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。
2. `pnpm run build` 退出码 0，`out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` 三个文件都存在。
3. `pnpm run typecheck` 退出码 0。
4. `pnpm run test` 退出码 0（1 个用例通过）。
5. `MICSTUDIO_USER_DATA=<临时目录> out/main` 能启动窗口：用如下命令验证
   ```powershell
   $env:MICSTUDIO_USER_DATA='D:\Temp\micstudio-userdata'
   & 'node_modules\electron\dist\electron.exe' . --no-sandbox 2>&1 | Select-Object -First 20
   ```
   期望：进程存活 ≥3 秒、无 `APPCRASH`、日志出现 renderer 的 `[boot] renderer ready`（通过主进程 `webContents.on('console-message')` 转发打印）。
6. 窗口背景为 `#0e1118`（截图或 `executeJavaScript('getComputedStyle(document.body).backgroundColor')` 输出 `rgb(14, 17, 24)`）。

## 6. 禁止事项

- 不实现业务界面、参数表、EQ、i18n（属后续 SubStage）。
- 不引入设计文档 §9 白名单外的依赖；不加 `^` 版本前缀。
- 不加 `.npmrc` 改写 registry（官方源可用）。
- 不改 `Document/` 下任何文件。

## 7. 错误处理契约

- 构建失败：先读完整报错，判断是配置（electron-vite 版本 API 差异）还是代码问题；配置问题允许调整 `electron.vite.config.ts` 结构，但三端产物路径 `out/<端>/...` 不得变。
- 若 `electron-vite@6` 与 `electron@33` 不兼容（dev 起不来且报版本相关错误）：立即停工上报主 Agent，不要在 SubStage 内自行换成两段式构建。
- 若 Electron 启动仍崩溃：确认 `MICSTUDIO_USER_DATA` 已生效（打印 `app.getPath('userData')` 验证），仍崩溃则上报。

## 8. 依赖前置

无。可立即开工。
