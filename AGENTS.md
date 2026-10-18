# AGENTS.md — MicroPhone_WebHIDInterface

麦克风上位机（Electron + WebHID 方向）。Alpha v1.0.0 只交付界面层：设备数据由 Mock 提供，HID 只定接口不实现编解码。

## Workspace

- 根：`D:\WorkShop\MicroPhone_WebHIDInterface`（git 仓库，remote `origin` = LeventureQys/MicroPhone_WebHIDInterface，`main` 已建初始提交并跟踪 `origin/main`）
- 版本工作目录：`Document/Update/Alpha/v1.0.0/`（需求 / 问题清单 / 设计 / 开发文档 / 验收文档 / 报告）
- 代码目录：`src/`（main / preload / renderer / shared）、`tests/unit/`、`scripts/`
- 产物目录：`out/`（构建）、`release/`（打包）、`artifacts/`（截图与日志）、`.userdata/`（运行数据）
- 第三方子模块：`third_party/web_hid_utils`（git submodule，上游 LeventureQys/web_hid_utils，锁定 `67d8680`；**只读引用，不改上游代码**）

## Toolchain

PATH 里没有 node/pnpm，必须用绝对路径：

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node -v          # v24.21.0
& $node $pnpm -v    # 11.7.0
```

用户名与上例不一致时，用 `load_workspace_dependencies` 给出的实际路径（本机为 `C:\Users\a5935\.dsh\...`）。`pnpm run *` 会自己调 `node`，跑脚本前先把 node 目录加进 PATH：

```powershell
$env:PATH = "C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
```

日常命令：

```powershell
& $node $pnpm install
& $node $pnpm run build        # electron-vite build → out/{main,preload,renderer}
& $node $pnpm run typecheck    # tsc --noEmit
& $node $pnpm run test         # vitest run
& $node $pnpm run dev          # 开发服务器 + Electron 窗口
& $node $pnpm run screenshot   # 七个路由各截一张 → artifacts/shot-*.png
& $node $pnpm run dist:win     # electron-builder → release/
```

打包与安装依赖必须先设镜像（GitHub 直连不通）：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

本机启动必须覆盖 userData（见已知坑 6）：

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\WorkShop\MicroPhone_WebHIDInterface\.userdata'
```

版本冻结（均已实测）：`electron 33.4.11`、`electron-vite 5.0.0`、`vite 5.4.21`、`vitest 1.6.1`、`happy-dom 20.14.6`、`electron-builder 26.15.3`。electron-vite 6.x 要求 vite ≥ 6，与本项目的 vite 5 组合构建失败，不要升。

## Reference truth

Ground truth（参数范围与设备语义，唯一权威）：`Document/Protocol/效果器参数范围.xlsx`

| 参照 | 本仓 | 备注 |
|---|---|---|
| `Document/Protocol/效果器参数范围.xlsx` | `src/renderer/src/domain/params.ts` | 范围 / 默认 / 步进 / 读写权限 |
| `Document/Update/Alpha/v1.0.0/需求文档.md` | 全部功能范围 | 需求边界 |
| `Document/Update/Alpha/v1.0.0/设计文档.md` | 全部实现契约 | 接口签名与视觉规范 |
| 参照实现 AudioEQ_Visualized_Web（MIT） | `src/renderer/src/eq/**` | 频响算法与 Canvas 分层渲染 |
| `third_party/web_hid_utils/docs/*.md`、`packages/webhid-kit/README.md` | `src/renderer/src/device/webhid/**` | WebHID 强制约束、桥接协议、套件 API |

裁决：参数数值与范围以 xlsx 为准；曲线渲染细节以参照实现为准；两者冲突时以 xlsx 为准并做渲染适配。

## Architecture

Electron 主进程只负责窗口、菜单、WebHID 会话策略与 IPC；渲染进程是唯一业务层：`AppStore` 是状态唯一写入口，参数改动经 `Transport` 出站（Alpha 用 `MockTransport`），`EqModel` + `computeCurve` 产出曲线数据、Canvas 分层绘制。主进程不参与业务计算，渲染进程不碰 Node API。

设备页（`ui/views/device-view.ts`）走 `device/webhid/` 适配层调用第三方套件：只做「发现设备 / 开关设备 / 报告解码」，不参与参数 ↔ 字节映射，因此**不实现** `Transport`，`AppStore` 的 Mock 链路不变。详见 §WebHID 接入。

## Sub-projects

- `src/main`、`src/preload`：Electron 两端，产物 `out/main`、`out/preload`
- `src/renderer`：界面与业务，产物 `out/renderer`
- `src/renderer/src/device/webhid`：webhid-kit 适配层（`types` 契约 / `kit` 唯一 import / `session` 状态机）
- `src/shared`：跨进程类型
- `tests/unit`：vitest（happy-dom 环境）
- `third_party/web_hid_utils`：git submodule（webhid-kit 浏览器套件 + `virtual_hid` Python 虚拟设备 + 桥接协议文档）

## Code style

- 界面文案中文/英文双语，一律经 `t()`；代码标识符英文。
- 参数范围、默认值、枚举只在 `domain/params.ts` 定义一次。
- 不引用网络字体与 CDN 资源（离线必须可用）。
- 不引入 UI 框架、状态库、i18n 库、图表库、DSP 库。
- 注释只解释"为什么"，不复述"是什么"。
- 只有 `device/webhid/kit.ts` 可以直接 `import '@webhid-kit'`；其余代码经 `device/webhid` 入口，别把子模块路径散落到业务里。

## WebHID 接入（third_party/web_hid_utils）

上游 `LeventureQys/web_hid_utils` 提供一套与 W3C 同构的 `navigator.hid`：Python 进程里跑虚拟设备，浏览器侧套件用 WebSocket 桥接，业务代码在真机与虚拟设备之间切换只差一个 `installVirtualHid()`。本仓把**整个仓库**作为 submodule 引入，只用其中的 `packages/webhid-kit`。

```
ui/views/device-view.ts           设备页（DOM 组件，只画状态）
        ↓
device/webhid/index.ts            组件入口：createWebHidSession()
        ↓
device/webhid/session.ts          WebHidSession 状态机（idle→connecting→ready/error）
        ↓                         ↑ 注入 WebHidKit 契约，单测传假实现
device/webhid/kit.ts              唯一 import '@webhid-kit' 的适配层
        ↓
third_party/web_hid_utils/packages/webhid-kit/src/index.js   （原生 ESM，只读）
```

接线点（改这三处即可复现）：

| 位置 | 作用 |
|---|---|
| `electron.vite.config.ts` renderer `resolve.alias['@webhid-kit']` | 构建期解析到子模块 `src/index.js` |
| `vitest.config.ts` 同款别名 | 单测跑真实套件代码（`tests/unit/webhid-kit.test.ts`） |
| `src/renderer/src/types/webhid-kit.d.ts` | 上游无 `.d.ts`，本仓声明用到的表面；偏差由测试兜底 |

`WebHidSession` 的两条通道：

- `virtual`：`installVirtualHid({url})` 装上 `navigator.hid` 替身，用套件的调试扩展 `getAllDevices()` 列出桥上全部设备（不走授权流程）；`disconnect()` 时 `restore()` 还原原生对象。
- `native`：`getNativeDevices()` / `requestNativeHidDevice()`，设备侧位布局由套件用 `computeLayout()` 本地算，`decode('input', id, bytes)` 直接出字段值。

联调命令（先起桥接，再取证）：

```powershell
$env:PYTHONPATH = 'D:\WorkShop\MicroPhone_WebHIDInterface\third_party\web_hid_utils\packages\virtual-hid'
& $python -m virtual_hid serve --config third_party\web_hid_utils\packages\virtual-hid\profiles\dev-kit.json --port 8765   # 后台常驻

$env:MICSTUDIO_USER_DATA = 'D:\WorkShop\MicroPhone_WebHIDInterface\.userdata'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& node_modules\electron\dist\electron.exe . --screenshot=artifacts\shot-device-live.png --route=device --exec-file=scripts\probes\device-connect.js --no-sandbox
```

实测输出（2026-10-18，Electron 33.4.11）：`{"rows":4,"status":"Ready","sent":"AB CD","hex":"AB CD","fields":["65280:2→171","65280:3→205"]}`——桥接 4 台设备全部列出并打开，echo 设备 `output→input` 回环，字段解码正确。

**边界（本次不做，别当成 bug）**：

1. 参数 ↔ 字节映射仍缺设备报告描述符，`device/webhid-transport.ts` 保持 Alpha 桩；设备页不冒充能写参数。
2. 真机通道在 Electron 里受主进程策略限制：`src/main/webhid.ts` 的 `select-hid-device` 仍是「直接取消」，所以 `requestNativeDevice()` 会拿到空数组并显示 `device.error.noSelection`。接选择器是下一步。
3. 上游 `forget()` 只撤销本会话授权，不等于操作系统级撤销。

升级子模块：

```powershell
$git = 'C:\Program Files\Git\cmd\git.exe'
& $git -C third_party/web_hid_utils fetch origin     # 直连不通时挂镜像，见已知坑 16
& $git -C third_party/web_hid_utils checkout <commit>
& $git -C . add third_party/web_hid_utils            # 记录新 gitlink
```

## Known traps

### 1. `github.com` 直连超时
症状：`git clone https://github.com/...` 报 `Failed to connect to github.com port 443 after ~21s`。
根因：本机出网策略只放通部分域名。
Fix：走镜像前缀（实测可用）：
```powershell
curl.exe -sSL -o D:\Temp\ref.zip "https://ghproxy.net/https://github.com/<owner>/<repo>/archive/refs/heads/main.zip"
```
Alternative：`gitee.com`、`registry.npmmirror.com`、`registry.npmjs.org` 均可达。

### 2. pnpm 11 的 build 脚本与 `pnpm run` 连锁失败
症状：`ERR_PNPM_IGNORED_BUILDS Ignored build scripts: electron@..., esbuild@...`，紧接着连 `pnpm run build` / `pnpm run test` 也失败（`runDepsStatusCheck` 会自动重跑 install 并继承该退出码）。
根因：pnpm 11 默认禁止第三方 postinstall，且 `pnpm run` 前会校验依赖状态。
Fix（本仓已落盘）：`pnpm-workspace.yaml` 写
```yaml
allowBuilds:
  electron: true
  electron-winstaller: true
  esbuild: true
```
再 `pnpm install`。此后 `pnpm run *` 正常。
Alternative：`pnpm approve-builds` 交互式放行；或 `pnpm config set verify-deps-before-run false`（不推荐，掩盖问题）。

### 3. PowerShell 里 `Invoke-WebRequest` 报 "处于非交互模式"
症状：`Invoke-WebRequest -Method Head` 直接报错。
Fix：联网探测统一用 `curl.exe -sS -o NUL -w "%{http_code}"`。

### 4. 读取 xlsx 出现乱码
症状：openpyxl 打印中文表头成 `��Сֵ`。
Fix：`$env:PYTHONIOENCODING='utf-8'` 后再跑，脚本存 UTF-8。

### 5. 需求文档与流程模板的版本目录名不一致
症状：模板要求 `Document/Update/vX.Y.Z - <名称>/`，本仓是 `Document/Update/Alpha/v1.0.0/`。
Fix：以现有目录为准，不搬家。

### 6. Electron 主进程崩溃 0xC0000005（默认 userData）
症状：`electron.exe` 启动即 `APPCRASH`，异常码 `0xc0000005`，WER 报告故障模块就是 `electron.exe` 自身；`--version`（`ELECTRON_RUN_AS_NODE=1` 模式）却正常。
根因：本机沙箱环境下 Chromium 初始化默认 userData（`%APPDATA%\electron`）时崩；与环境变量 `ELECTRON_RUN_AS_NODE=1` 共存无关。
Fix（实测有效）：指定干净的 userData 目录。本项目在 `src/main/index.ts` 顶部按此规则处理：
```ts
const override = process.env.MICSTUDIO_USER_DATA
  ?? (app.isPackaged ? '' : path.join(process.cwd(), '.userdata'));
if (override) app.setPath('userData', override);
```
注意：开发态不要用 `os.tmpdir()`——本机 `%LOCALAPPDATA%\Temp` 下 Chromium 会刷一屏 `Failed to create directory ... Code Cache` / `Network: 拒绝访问 (0x5)`（能起窗口，但缓存全废）。用手工验证：`electron.exe . --user-data-dir=D:\Temp\ud`。
Alternative：命令行直接传 `--user-data-dir=<dir>`。

### 7. Electron 二进制缺失（`node_modules/electron/dist` 不存在）
症状：安装后 `dist`、`path.txt` 都没有，`electron --version` 报找不到模块。
根因：pnpm 忽略 electron 的 postinstall（见坑 2）。
Fix：
```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
& $node node_modules/electron/install.js
```
验证：`node_modules/electron/path.txt` 内容为 `electron.exe`。

### 8. 后台作业与 workdir 不存在
症状：`Error: spawn C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe ENOENT`，但该文件确实存在。
根因：`workdir` 指向不存在的目录时，工具层报的错伪装成 powershell 缺失；另外本机 shell 是 Windows PowerShell 5.1，后台作业模式不稳定。
Fix：确保 `workdir` 目录已存在；长命令直接用前台 `timeoutMs` 拉长，或 `Start-Process`/`cmd /c` 自行控制。

### 9. 桌面截图 `CopyFromScreen` 卡死
症状：PowerShell 里 `Graphics.CopyFromScreen` 长时间不返回，命令挂住。
根因：非交互会话下屏幕捕获不可靠。
Fix：用 Electron 自带能力取证：`webContents.capturePage()` → `toPNG()` → 写文件（实测稳定，含 DPR 缩放后的真实像素）。

### 10. `electron-builder` 偶发超时
症状：`⨯ Timeout awaiting 'request' for 600000ms`。
根因：打包过程要拉 nsis / winCodeSign / electron zip，镜像未设时回到 GitHub。
Fix：设 §Toolchain 的两个镜像变量后重跑。已缓存的资源在 `%LOCALAPPDATA%\electron\Cache` 与 `%LOCALAPPDATA%\electron-builder\Cache`，命中时几十秒完成。

### 11. 加了 `"type": "module"` 后 preload 加载失败
症状：渲染进程控制台报 `Unable to load preload script: .../out/preload/index.js` + `ENOENT`，而磁盘上只有 `index.mjs`。
根因：`type: module` 让 electron-vite 把 preload 输出成 `.mjs`，主进程仍按 `.js` 引用。
Fix：`package.json` 不要写 `"type": "module"`。main/preload 输出 CJS，preload 在 `sandbox: true` 下正常加载（实测 `window.micstudio` 可用）。renderer 端仍是 ESM，由 vite 打包，不受影响。

### 12. electron-vite 配置里的 `build.outDir` 与 `rollupOptions` 类型报错
症状：`tsc --noEmit` 报 `'outDir'/'rollupOptions' does not exist in type 'MainBuildOptions'`；若改用相对路径写 `outDir`，renderer 产物还会跑到项目外（相对 `src/renderer` 解析）。
根因：electron-vite 5 的配置类型基于 vite 6+ 的 Environment API，与项目锁定的 vite 5 类型不匹配。
Fix（本仓已落盘）：**三端都不写 `outDir`**，electron-vite 固定输出 `out/main`、`out/preload`、`out/renderer`；`electron.vite.config.ts` **不纳入** `tsconfig.json` 的 `include`（配置正确性由 `pnpm run build` 保证）。

### 13. `ELECTRON_RUN_AS_NODE=1` 让打包 exe 静默退场
症状：`release/win-unpacked/MicStudio.exe` 双击无窗口、无日志、进程立刻消失；前台运行报 `MicStudio.exe: bad option: --no-sandbox`；`userData` 目录根本不创建。
根因：本机系统环境变量里存在 `ELECTRON_RUN_AS_NODE=1`，Electron 二进制按 Node 模式解析参数后退出，主进程 JS 一行都没执行。
Fix：启动 Electron 前清掉该变量：
```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```
`scripts/screenshot.mjs` 已在子进程环境里 `delete env.ELECTRON_RUN_AS_NODE`。注意：`Remove-Item Env:` 只影响当前 shell；新开的 pwsh 会话会重新继承系统值。

### 14. NSIS 目标（安装包 / portable）在本机沙箱不可用
症状一：`electron-builder --win nsis` 报 `⨯ ...MicStudio Setup <ver>.exe process failed 2`。
症状二：`MicStudio-<ver>-portable.exe` 生成成功（69MB），但双击后立即退出、`%TEMP%` 下不留解压目录。
根因：NSIS 安装/自解压在 `%TEMP%` 下展开并执行子进程，本机沙箱对 TEMP 下的目录创建与可执行文件拉起有额外限制（同源现象：Chromium 在 TEMP 下报 `Code Cache ... 拒绝访问 (0x5)`）。
Fix：本机验收一律用 `release/win-unpacked/MicStudio.exe`（免解压直接运行，已验证可起窗口并 `capturePage` 截图）。portable 与 nsis 产物属于**未验证**，只能在真机确认。

### 15. CSP 把桥接 WebSocket 拦掉
症状：设备页点「连接」后状态停在 Error，渲染进程控制台报
`Refused to connect to 'ws://127.0.0.1:8765/ws' because it violates the following Content Security Policy directive: "default-src 'self'"`。
根因：`src/renderer/index.html` 的 CSP 没声明 `connect-src`，回退到 `default-src 'self'`；`'self'` 只含页面自身的源（`file:` 或 dev server），不含回环 WebSocket。
Fix（已落盘）：补 `connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:*`。只放回环，不要写 `ws://*`——设备页允许改端口，但不应允许连公网。

### 16. `git submodule add` 在 GitHub 拉取时卡死
症状：`Cloning into 'third_party/web_hid_utils'...` 长时间不动，最后
`error: RPC failed; curl 56 Recv failure: Connection was reset` / `fatal: early EOF` / `fatal: fetch-pack: invalid index-pack output`；`.git/modules/third_party/web_hid_utils/objects/pack/tmp_pack_*` 始终 0 字节。
根因：`git ls-remote` 这类小请求能过，但 pack 传输被掐断（同坑 1）。所以「`ls-remote` 成功」不代表能 clone。
Fix（已实测）：本机已有完整上游仓库时，用本地路径建子模块，再把 `.gitmodules` 的 url 改回上游：
```powershell
$git = 'C:\Program Files\Git\cmd\git.exe'
& $git -c protocol.file.allow=always submodule add D:/WorkShop/web_hid_utils third_party/web_hid_utils
# 手改 .gitmodules 的 url = https://github.com/LeventureQys/web_hid_utils.git，再：
& $git submodule sync --recursive
```
新机器上没有本地副本时，给 GitHub 地址临时挂镜像：
`& $git -c url."https://ghproxy.net/https://github.com/".insteadOf="https://github.com/" submodule update --init`
验证：`git submodule status` 的 commit 与上游 HEAD 一致（当前 `67d8680`）。

### 17. PATH 里没有 git
症状：`git : 无法将"git"项识别为 cmdlet、函数、脚本文件或可运行程序的名称`。
Fix：用绝对路径 `C:\Program Files\Git\cmd\git.exe`；需要 `git` 在 PATH 的命令（npm prepare / husky 之类）本仓没有。

### 18. `pnpm run dev` 启动即崩（GPU 进程）
症状：`electron-vite dev` 打完 main/preload、起好 `http://localhost:5173/`，Electron 窗口刚创建就退出：
`gpu_process_host.cc(976) GPU process launch failed: error_code=18` → `FATAL:gpu_data_manager_impl_private.cc(423) GPU process isn't usable. Goodbye.`（退出码 `2147483651`）。
根因：本机沙箱下 Electron 子进程拉起受限，与 `--no-sandbox` 同源（截图脚本一直带该参数所以没暴露）。
Fix：把参数透传给 Electron：`& $node $pnpm run dev -- --no-sandbox`（实测渲染进程正常启动 `[vite] connected` / `[boot] renderer ready`）。仅本机开发需要，代码里不要写死。

### 19. `git push` 连不上 `github.com:443`
症状：`fatal: unable to access 'https://github.com/...': Failed to connect to github.com:443 after 21104 ms`；但 `curl https://api.github.com/...` 正常，`git ls-remote` 时好时坏。
根因：本机 DNS 解析出的 github.com 边缘 IP（如 `20.205.243.166`）不通；同名其他边缘 IP 可用（实测 `140.82.112.3` 稳定，`140.82.113/114/200/4.237.*` 能连通但慢）。
Fix（已实测）：把域名钉到可用边缘 IP 再推，HTTP/1.1 更稳：
```powershell
& $git -c http.curloptResolve=github.com:443:140.82.112.3 -c http.version=HTTP/1.1 push -u origin main
```
凭据：本机 Windows 凭据管理器里有 target `GitHub - https://api.github.com/LeventureQys`（OAuth token，可访问 api.github.com），GCM 默认不匹配这个 target 会一直要交互。临时注入即可，**不要**把 token 写进 remote URL 或 `.git/config`：
```powershell
& $git -c credential.helper= -c credential.helper='!f() { echo username=<user>; echo password=$TOKEN_ENV; }; f' push ...
```
验证：`git ls-remote origin refs/heads/main` 的 sha 与 `git rev-parse HEAD` 一致。

## Domain constants

### 模块与参数字段（来源：`效果器参数范围.xlsx` / Sheet1）

| 模块 | 字段 | 含义 | 最小 | 最大 | 默认 | 步进 | 上位机权限 |
|---|---|---|---|---|---|---|---|
| Gain | Mic | 麦克风增益 (dB) | -27 | 36 | 5 | 1 | **只读** |
| Gain | Hp | 耳机增益 (dB) | -40 | 0 | 0 | 1 | **只读** |
| NoiseGate | threshold_db | 阈值 (dB) | -91 | 0 | -70 | 1 | 可调 |
| NoiseGate | ratio | 扩展比（2.0 表示 2:1） | 0.05 | 0.999 | 0.333 | 0.001 | 可调 |
| NoiseGate | attack_ms | 启动时间 (ms) | 5 | 500 | 10 | 1 | 可调 |
| NoiseGate | release_ms | 释放时间 (ms) | 5 | 500 | 200 | 1 | 可调 |
| NoiseGate | knee_width_db | 膝宽 (dB) | 6 | 12 | 12 | 1 | 可调 |
| NoiseGate | hp_freq | 侧链高通截止频率 (Hz) | 60 | 200 | 150 | 1 | 可调 |
| Comp | MakeUpGain | dB | 0 | 60 | 0 | 0.1 | 可调 |
| Comp | Threshold | dB | -60 | 0 | -60 | 0.1 | 可调 |
| Comp | Attack | s | 0.0001 | 0.2 | 0.0005 | 0.0001 | 可调 |
| Comp | Release | s | 0.005 | 2 | 0.1 | 0.0001 | 可调 |
| Comp | Rate | 语义未明，按协议原名展示 | 1 | 100 | 6 | 0.1 | 可调 |
| Comp | KneeWidth | dB | 0 | 60 | 1 | 0.1 | 可调 |
| Limit | Threshold | dB | -60 | 0 | -60 | 0.1 | 可调 |
| Limit | Attack | s | 0.0001 | 0.2 | 0.0005 | 0.0001 | 可调 |
| Limit | Release | s | 0.005 | 2 | 0.05 | 0.0001 | 可调 |
| EQ（14 段） | Type | 枚举，见下 | 0 | 4 | 0 | 1 | 可调 |
| EQ（14 段） | Freq | Hz | 20 | 20000 | 1000 | 1 | 可调 |
| EQ（14 段） | Gain | dB | -32 | 12 | 0 | 0.1 | 可调 |
| EQ（14 段） | Q | 无量纲 | 0.1 | 12 | 0.7 | 0.1 | 可调 |
| ENC | OnOff | 环境降噪开关 | 0 | 1 | 0 | 1 | 可调 |
| ENC | Level | 档位 | 0 | 3 | 1 | 1 | 可调 |
| 3BandDrc | fc1 | 分频点 1 (Hz) | 50 | 10000 | 1000 | 1 | 可调 |
| 3BandDrc | fc2 | 分频点 2 (Hz) | 50 | 10000 | 3000 | 1 | 可调 |
| 3BandDrc | preGain ×3 | 低/中/高区 | 0 | 4 | 1.28 | 0.01 | 可调 |
| 3BandDrc | threshold ×3 | 低/中/高区 | -80 | 0 | 0 | 0.1 | 可调 |
| 3BandDrc | attackTime ×3 | 低/中/高区 (ms) | 1 | 400 | 10 | 1 | 可调 |
| 3BandDrc | releaseTime ×3 | 低/中/高区 (ms) | 5 | 680 | 20 | 1 | 可调 |
| 3BandDrc | ratio ×3 | 低/中/高区 | 1 | 20 | 10 | 0.1 | 可调 |

合计 36 项标量（Gain 2 + NoiseGate 6 + Comp 6 + Limit 3 + ENC 2 + 3BandDrc 17），EQ 段参数走 `EqModel` 不计入。

3BandDrc 三区：`freq < fc1`（low）、`fc1 < freq < fc2`（mid）、`freq > fc2`（high）。

EQ：共 14 段，上位机可调 `band[0..6]`，内部段 `band[7..13]`。Type 枚举 `0 PEAK / 1 LS / 2 HS / 3 LPF / 4 HPF`。

默认 EQ 频点：可调段 `freq[k] = round(20 × 10^(0.5k))` → 20 / 63 / 200 / 632 / 2000 / 6325 / 20000；内部段 36 / 112 / 356 / 1122 / 3556 / 11220 / 17825。

### 视觉与窗口常量

`--bg #0e1118`、`--panel #171c26`、`--panel-2 #1d2430`、`--border #323947`、`--accent #f0a65b`、`--accent-strong #f4aa5f`、`--text #e7ebf2`、`--muted #8592a7`、`--ok #86c7a5`、`--danger #f69a9a`。

EQ 轴：频率 20 Hz–20 kHz 对数，增益 −24…+12 dB；曲线色 `#F0A030`；节点半径 10。

窗口：1280×820 默认，最小 1100×700；顶栏 64px；左导轨 84px。
