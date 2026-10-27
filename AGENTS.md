# AGENTS.md — MicroPhone_WebHIDInterface

麦克风上位机（Electron + WebHID 方向）。Alpha v1.0.0 交付界面层（设备数据由 Mock 提供）；Alpha v1.1.0 接上参数协议与固件升级（虚拟下位机可跑通全流程；真机首轮联调 2026-10-26 已完成，链路卡在固件侧，见 `Document/Update/Alpha/v1.1.0/真机联调报告.md`）。

## Workspace

- 根：`D:\WorkShop\MicroPhone_WebHIDInterface`（git 仓库，remote `origin` = LeventureQys/MicroPhone_WebHIDInterface，`main` 已建初始提交并跟踪 `origin/main`）
- 版本工作目录：`Document/Update/Alpha/v1.0.0/`（界面层）与 `Document/Update/Alpha/v1.1.0/`（下位机联调与固件升级）；两处各含需求 / 问题清单 / 设计 / 开发文档 / 验收文档 / 报告
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
& $node $pnpm run test:coverage # vitest run --coverage（协议层 + 镜像层门禁，见 vitest.config.ts）
& $node $pnpm run test:device  # 虚拟下位机端到端自检 20 例 → artifacts/vdevice/selftest-*.json
& $node $pnpm run vdevice      # 一条命令起 Python 桥 + 侧车（Ctrl+C 一起收）
& $node $pnpm run dev          # 开发服务器 + Electron 窗口
& $node $pnpm run screenshot   # 四个画面各截一张 → artifacts/shot-*.png
& $node $pnpm run dist:win     # 单文件免安装包 → release/MicStudio-<ver>-portable.exe
& $node $pnpm run dist:installer  # 可选：NSIS 安装包（本机未验证）
```

一键启动（PATH 里没有 node/pnpm 也能跑；脚本自己定位 DSH 运行时、清 `ELECTRON_RUN_AS_NODE`、覆盖 userData）：

```powershell
.\start.cmd                 # 默认 dev：electron-vite dev + 热更新
.\start.cmd app             # 启动 out/ 构建产物（源码比产物新时自动重建）
.\start.cmd app -Rebuild    # 强制重建后启动
.\start.cmd -Bridge         # 额外拉起 WebHID 虚拟桥接（127.0.0.1:8765），退出时自动关闭
.\start.cmd -Sandboxed      # 不给 Electron 加 --no-sandbox（仅本机 Chromium 沙箱正常时）
```

`start.cmd` 只是入口，逻辑在 `scripts/start.ps1`；该文件必须保存为 **UTF-8 带 BOM**，否则 PowerShell 5.1 按 GBK 解码中文会直接语法错误。脚本默认给 Electron 加 `--no-sandbox`（已知坑 14 / 18），自动化调用时设 `MICSTUDIO_NO_PAUSE=1` 可跳过失败后的 `pause`。

打包与安装依赖必须先设镜像（GitHub 直连不通）：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

electron-builder 会 spawn `pnpm list` 收集依赖；PATH 里没有 pnpm 时打包直接失败（见已知坑 20）。打包命令前把 shim 放最前：

```powershell
$shim = 'D:\Temp\dsh-pnpm-shim'   # 内含 pnpm.cmd → node pnpm.mjs %*
$env:PATH = "$shim;C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
```

本机启动必须覆盖 userData（见已知坑 6）：

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\WorkShop\MicroPhone_WebHIDInterface\.userdata'
```

版本冻结（均已实测）：`electron 33.4.11`、`electron-vite 5.0.0`、`vite 5.4.21`、`vitest 1.6.1`、`happy-dom 20.14.6`、`electron-builder 26.15.3`。electron-vite 6.x 要求 vite ≥ 6，与本项目的 vite 5 组合构建失败，不要升。

## Reference truth

Ground truth（地址 / 标定 / 权限 / 默认值，唯一权威）：`Document/Protocol/M001参数表V0.1.xlsx`；`Document/Protocol/效果器参数范围.xlsx` 仅作中文标签与单位参考。

| 参照 | 本仓 | 备注 |
|---|---|---|
| `Document/Protocol/M001参数表V0.1.xlsx` | `src/renderer/src/device/registers.ts`、`src/renderer/src/domain/params.ts` | 地址 / 原始值域 / 标定 / 读写权限 / 默认值 |
| `Document/Protocol/Modbus通讯协议说明_20261026.md` | `src/renderer/src/device/protocol.ts`、`device/proto/**`、`tools/vdevice/device-stack.mjs` | 帧结构 / CRC / 功能码 / Report ID / 0x10 双向复用（2026-10-26 换版，协议层唯一权威；评审见 `协议评审-Modbus协议_20261026.md`） |
| `Document/Protocol/效果器参数范围.xlsx` | `src/renderer/src/domain/params.ts` | 仅中文标签与单位；数值以寄存器表为准 |
| `Document/Update/Alpha/v1.0.0/需求文档.md` | 全部功能范围 | 需求边界 |
| `Document/Update/Alpha/v1.0.0/设计文档.md` | 全部实现契约 | 接口签名与视觉规范 |
| `Document/Update/Alpha/v1.1.0/设计文档.md` | v1.1.0 契约与 §12 变更记录 R-1…R-23 | 与 v1.0.0 冲突时以本文件为准 |
| 参照实现 AudioEQ_Visualized_Web（MIT） | `src/renderer/src/eq/**` | 频响算法与 Canvas 分层渲染 |
| `third_party/web_hid_utils/docs/*.md`、`packages/webhid-kit/README.md` | `src/renderer/src/device/webhid/**` | WebHID 强制约束、桥接协议、套件 API |

裁决：地址 / 标定 / 权限 / 默认值以 `M001参数表V0.1.xlsx` 为准（实现即 `device/registers.ts`）；帧结构 / CRC / 功能码 / Report ID / 上报语义以 `Modbus通讯协议说明_20261026.md` 为准（实现即 `device/proto/**` + `device/protocol.ts`）；中文标签与单位可参考 `效果器参数范围.xlsx`，但数值冲突时以寄存器表为准；曲线渲染细节以参照实现为准并做渲染适配。

## Architecture

Electron 主进程只负责窗口、菜单、WebHID 会话策略与 IPC；渲染进程是唯一业务层：`AppStore` 是状态唯一写入口，参数改动经 `Transport` 出站（Alpha 用 `MockTransport`），`EqModel` + `computeCurve` 产出曲线数据、Canvas 分层绘制。主进程不参与业务计算，渲染进程不碰 Node API。

界面是**一屏工作台**（`ui/views/console-view.ts`），没有导航与路由：所有日常逻辑同屏——顶部一键场景（`domain/scenes.ts`），左侧实时电平 + 增益 + 设备摘要，中间降噪强度 / 声音平稳 / 音色风格三个业务控件，右侧可拖拽的 7 段音色曲线，底部环境降噪与防爆音开关。协议原始参数收进顶栏「高级参数」抽屉（`ui/views/advanced-view.ts`，由 `ui/modal.ts` 承载），设备与设置也以抽屉打开，不切页。业务旋钮到协议字段的换算集中在 `domain/quick-controls.ts`，不改变 xlsx 的范围与步进。

设备抽屉（`ui/views/device-view.ts`）走 `device/webhid/` 适配层调用第三方套件：只做「发现设备 / 开关设备 / 报告解码」，不参与参数 ↔ 字节映射，因此**不实现** `Transport`，`AppStore` 的 Mock 链路不变。详见 §WebHID 接入。

## Sub-projects

- `src/main`、`src/preload`：Electron 两端，产物 `out/main`、`out/preload`
- `src/renderer`：界面与业务，产物 `out/renderer`
- `src/renderer/src/ui/views/console-view.ts`：一屏工作台（主界面）
- `src/renderer/src/ui/views/advanced-view.ts`：高级参数抽屉（复用 input/dynamics/drc 视图与 EQ 段表）
- `src/renderer/src/ui/modal.ts`：抽屉/弹层宿主，Esc、遮罩点击、内容 destroy
- `src/renderer/src/domain/scenes.ts`：一键场景（场景 → 5 个协议字段 + 7 段 EQ）
- `src/renderer/src/domain/quick-controls.ts`：业务旋钮 ↔ 协议参数映射
- `src/renderer/src/device/webhid`：webhid-kit 适配层（`types` 契约 / `kit` 唯一 import / `session` 状态机）
- `src/renderer/src/device/registers.ts`：寄存器真值表（地址 / 原始值域 / 标定 / 权限 / 默认值）+ `toRaw`/`fromRaw`；`domain/params.ts` 的 42 项由它派生
- `src/renderer/src/device/proto`：参数协议纯函数层（`crc` CRC-16 / `frame` 组帧与流式拆帧 / `codec` 编解码 / `timing` 唯一定时器出口 / `session` 串行队列 + 超时重试 + 写合并 + 电平轮询）
- `src/renderer/src/device/dfu`：固件升级层（`frame` SigmaBus 帧 / `image` 打包解析与预检 / `session` DFU 状态机）
- `src/renderer/src/device/link.ts`：设备连接编排（WebHid 会话 ↔ 通道 ↔ 参数同步 ↔ DFU）
- `src/renderer/src/device/channel-transport.ts`：通道类型与 report ID 装配（mock / virtual / native）
- `tools/vdevice`：虚拟下位机（`run` 一键起停 / `sidecar` 设备侧侧车 + 控制面 / `device-stack` 参数协议栈 / `dfu-stack` DFU 栈 / `faults` 故障注入 / `level` 电平源 / `package` 升级包夹具 / `selftest` 20 例端到端自检）
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
ui/views/device-view.ts          设备抽屉（DOM 组件，只画状态）
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

1. 参数 ↔ 字节映射已由 `device/proto/**`（参数协议）与 `device/dfu/**`（SigmaBus/DFU）实现；`device/webhid-transport.ts` 是真实实现，不再是 Alpha 桩。
2. 真机通道的 `select-hid-device` 改为**按 `Usage Page 0xFF01 / Usage 0x01` 白名单放行**（`shared/webhid-whitelist.ts` 的 `shouldAllowSelection`：空白名单→拒；entries 非空→放；vids/pids 全空→放；否则按 VID/PID 复核）。usage 过滤实际发生在渲染进程 `requestDevice({ filters })`。
3. 上游 `forget()` 只撤销本会话授权，不等于操作系统级撤销。

**首轮真机联调（2026-10-26，M001 `0x0A67/0x0010`）**：路径全部打通到「第 1 条回读成功、第 2 条被固件假 ACK 抢答」，参数链路卡在固件侧（补位零 + 解析器闭锁），详见 `Document/Update/Alpha/v1.1.0/真机联调报告.md`，取证在 `artifacts/real/`。实测三条与旧笔记冲突、已作废的假设：

1. **Electron 33.4.11 的 `HIDDevice` 带 `collections`**（含 `usagePage`/`usage`/报告数），`getDevices()` 与 `requestDevice()` 都有，所以 `shouldAllowSelection` 的 usage 复核在真机上可用；原「不含 collections、主进程只能粗筛」的结论作废。
2. 原生句柄 `NativeHidHandle` **不透出** `vendorId/productId/productName`（身份在 `handle.device` 上），必须经 `device/webhid/kit.ts` 的 `adaptNativeHandle()` 补齐，否则真机在枚举阶段就抛 `Cannot read properties of undefined`。
3. `getDevices()` 会列出系统里所有 HID 设备（键盘/鼠标/灯效），因为主进程 `setDevicePermissionHandler` 对 `hid` 一律放行；真机列表需要按 `collections` 过滤（遗留项 R2）。

**第二轮真机联调（2026-10-26 23:00，固件 V0.0.2）**：**参数链路已跑通**——`sync()`、诊断自检 3/3、场景写入 → 设备回读一致；补位零与解析器闭锁在正常请求路径上已修，`0x0001`/`0x0002` 只出现在拒绝路径。仍留 7 条固件问题（拒绝路径喷 ACK、读路径不校验地址、只读/范围不校验、`0x12` 超容量返回 514 B 帧、区间是 `0x2075`(118) 不是 `0x2071`(114)、`0x2057` 恒 0 且无周期上报、信息区/预设区无默认值），详见 `Document/Update/Alpha/v1.1.0/真机联调报告-第二轮.md`，取证在 `artifacts/real2/`，探针 `scripts/probes/real2-*.js`。

**DFU 包格式（协议《DFU固件升级通讯协议说明_20261026》）**：包首「进入 DFU」帧有两种形态——旧 SigmaBus `C4 0B 00 00 03 08 10 01 00 15 FF`，或 2026-10-26 起的新 Modbus 帧 `00 10 00 0A 10 08 00 01 8D 09`；`device/dfu/image.ts` 的 `detectPackageHeader()` 两种都收，`ParsedImage.headerKind` 记录形态，`frames[0]` 仍是包首帧。信息帧体固件只读前 81 B（出厂包 = 81 / 整帧 90），协议文档写的 85 / 94 是笔误，解析器两种长度都接受。

**真机 DFU 已刷通（2026-10-27 21:11，M001 `0x0A67/0x0010`）**：`JYM001` 信息帧被 `0x01` 拒（设备信息区为空）→ 内存改 `000000` 重封 CRC → `0x03` → 64 B/块 × 2564 + 末块 896 B → **`0x05`**，120.6 s；设备写 `{A5,FF,00,02}` 复位后重新枚举为 `USB Audio Device`（`MI_00` 音频 + `MI_03` HID），Modbus 正常。整轮不依赖 Electron：`tools/dfu/m001-dfu.py` + `hidwin.py`（ctypes 直连 HID）。App 内 DFU 仍缺「等重枚举 + 重开句柄」（评审 P0-1/P0-2），救砖通道（P1-1）未做；详细过程、失败模式与主机侧三条修正见 `Document/Update/Alpha/v1.1.0/真机DFU刷写成功记录.md`，符合性评审见 `Document/Protocol/DFU协议符合性评审_20261026.md`。

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
Fix（实测有效）：指定干净的 userData 目录。本项目在 `src/main/index.ts` 顶部按此规则处理（`resolveUserDataDir()`）：`MICSTUDIO_USER_DATA` 优先；portable 包落 `<exe 同级>/MicStudioData`（`PORTABLE_EXECUTABLE_DIR`，写不进去时回退默认目录）；开发态落项目内 `.userdata`；打包产物否则用 Electron 默认目录。早期写法：
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
根因：DSH 工具进程的环境里带着 `ELECTRON_RUN_AS_NODE=1`（`[Environment]::GetEnvironmentVariable(...,'User'/'Machine')` 都是空，所以只影响本工具派生的进程，不影响 Explorer 双击），Electron 二进制按 Node 模式解析参数后退出，主进程 JS 一行都没执行。
Fix：启动 Electron 前清掉该变量：
```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```
`scripts/screenshot.mjs` 已在子进程环境里 `delete env.ELECTRON_RUN_AS_NODE`。注意：`Remove-Item Env:` 只影响当前 shell；新开的 pwsh 会话会重新继承系统值。

### 14. 沙箱里「直接拉起 Electron」需要 `--no-sandbox`，portable 双击不受影响
症状：直接由本工具 shell 拉起 `win-unpacked/MicStudio.exe`（或 `electron.exe .`）时，窗口刚建就退出：
`GPU process launch failed: error_code=18` → `FATAL:gpu_data_manager_impl_private.cc(423) GPU process isn't usable. Goodbye.`；加 `--no-sandbox` 后正常。`--disable-gpu` / `--disable-gpu-sandbox` / `in-process-gpu` 都救不回来（renderer 也起不来）。
根因：本机沙箱限制本工具直接派生的 Chromium 子进程（GPU/renderer 的 Mojo 管道与受限令牌），与打包形态无关。
Fix：
- 开发/截图取证照旧带 `--no-sandbox`（`scripts/screenshot.mjs` 已内置）。
- **单文件 portable exe 通过 ShellExecute 拉起（Explorer 双击、`cmd /c start "" <exe>`）时，应用是 NSIS 解包器的孙进程，不吃这层限制**，不带任何参数即可起窗口。2026-10-19 实测：`start` 无参启动 → 进程 `MainWindowTitle = MIC STUDIO`、`renderer ready`、`CloseMainWindow()` 后干净退出；`--screenshot` 也能出图。  
- 早期“portable 双击立即退出、%TEMP% 无解压目录”的结论作废：当时是直接用 shell `&` 拉起 portable（解包器的子进程被沙箱掐死），不是 portable 形态本身的问题。

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

**2026-10-27 补充：HTTPS 这条路已经不通，改用「临时 deploy key + SSH push」（已实测跑通）。**
实测：`github.com` 的 DNS（`20.205.243.166`）连不上；钉 `4.237.22.38` 能建 TLS 但 40 s 后 `Recv failure: Connection was reset`；`140.82.112/113/114` 全部超时；只有 `api.github.com` 稳定 200。SSH 侧 `github.com:22` 与 `ssh.github.com:443` 都通。步骤：

```powershell
# 1) 取 token（Credential Manager 里已有，GIT_TERMINAL_PROMPT=0 时静默返回 40 位 gho_ token）
$env:GIT_TERMINAL_PROMPT='0'
$token = ("protocol=https`nhost=github.com`n`n" | & $git credential fill) -match '^password=' | % { $_ -replace '^password=','' }
$env:GIT_TERMINAL_PROMPT='1'

# 2) 本地生成临时密钥（放 D:\Temp，别碰用户的 ~/.ssh）
& 'C:\Program Files\Git\usr\bin\ssh-keygen.exe' -t ed25519 -N '' -C 'dsh-upload' -f D:\Temp\dsh-git-ssh\id_ed25519

# 3) 用 token 通过 API 把它加成仓库的临时 deploy key（read_only=false）
#    POST https://api.github.com/repos/LeventureQys/MicroPhone_WebHIDInterface/keys
#    body: {"title":"dsh-upload-<date>","key":"<id_ed25519.pub 内容>","read_only":false}

# 4) SSH push（GIT_SSH_COMMAND 里的路径必须用**正斜杠**，反斜杠会被 git 的参数解析吃掉）
$env:GIT_SSH_COMMAND = '"C:/Program Files/Git/usr/bin/ssh.exe" -i D:/Temp/dsh-git-ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=D:/Temp/dsh-git-ssh/known_hosts -o BatchMode=yes'
& $git push "ssh://git@github.com/LeventureQys/MicroPhone_WebHIDInterface.git" main:main

# 5) 收尾：更新本地跟踪分支、删 deploy key、删临时密钥
& $git update-ref refs/remotes/origin/main (git rev-parse HEAD)
#    DELETE https://api.github.com/repos/LeventureQys/MicroPhone_WebHIDInterface/keys/<id>
```

坑：用 `%TEMP%` 之外的相对路径写 known_hosts 时，若 `GIT_SSH_COMMAND` 里的反斜杠被吃，会在**仓库根目录**生成一个 `D：Temp…known_hosts` 的怪文件（全角冒号），记得删。验证同上：`GET /repos/.../git/ref/heads/main` 的 sha == `git rev-parse HEAD`。

### 20. `electron-builder` 报 `No JSON content found in output`（pnpm 不在 PATH）
症状：`pnpm run dist:win` 走到 `searching for node modules pm=pnpm` 后失败：
`⨯ No JSON content found in output  failedTask=build`。
根因：electron-builder 的 pnpm 收集器直接 spawn `pnpm list --json ...`；本机 PATH 里只有 `pnpm.mjs`，没有 `pnpm` 可执行文件，子进程空输出。
Fix（实测）：在 PATH 最前面放一个 `pnpm.cmd` shim，打包命令见 §Toolchain。

### 21. 虚拟设备 profile JSON 带 BOM 被桥拒绝
症状：`python -m virtual_hid serve --config tools/vdevice/profiles/mic-m001.json` 起不来，报 `Unexpected UTF-8 BOM`（`json.decoder.JSONDecodeError`）。
根因：Python `json` 不接受 UTF-8 BOM；PowerShell 5.1 的 `Out-File`/`Set-Content -Encoding utf8` 默认写 BOM。
Fix：profile 与任何被 Python 读的 JSON 一律存**无 BOM** 的 UTF-8（`[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))`）。改完用 `Get-Content -Encoding Byte -TotalCount 3` 确认不是 `EF BB BF`。

### 22. 虚拟设备无法真实重枚举（桥没有注册/注销接口）
症状：期望"重新插拔设备"来验证掉线恢复，但 `/control/*` 与 WS 都没有 add/remove 设备或关闭设备的操作，`remove_device` 只在 Python 进程内可用、外部脚本够不到。
根因：桥启动时按 profile 一次性建好设备表，没有对外的设备生命周期接口（问题清单 §3.4）。
Fix：掉线用"不答（超时）"表达：`POST /control/faults` 注入 `{"action":"disconnect","ms":N}`，上位机侧由"请求超时 → 通道 error → 重新 attach"体现（设计 §5.14.5、§9 B2）。真重枚举只能等真机。

### 23. `@vitest/coverage-v8` 必须与 vitest 同版本
症状：装成别的版本后 `vitest run --coverage` 报 `Cannot find module '@vitest/coverage-v8'` 或覆盖率全是 0/工具内部抛错。
根因：`@vitest/coverage-v8` 与 `vitest` 是配套发布的，跨版本时 provider 与核心的 provider API 不匹配。
Fix：锁同版本安装 `& $node $pnpm add -D @vitest/coverage-v8@1.6.1`（本仓 vitest 冻结在 1.6.1）。升级 vitest 必须同时升级它。

### 24. 真机固件不丢弃 63 B 报文尾部补位 → 假 ACK 抢答 + 解析器闭锁
症状（M001 真机，2026-10-26）：`sync()` 第 1 条回读正常、第 2 条立刻 `ACK 0x0002 长度错` → 顶栏「同步失败」；诊断卡里每个请求之后都夹着 `floor(补位字节/4)` 条 `ACK 0x0002`（偶发 `0x0001`）；再往后每次请求只收到每 9–15 ms 一条的 ACK，**没有任何数据帧**，静默约 1.5 s 后自愈。
根因：固件按 `Len` 取帧后**保留**报文尾部的 `0x00` 补位并继续按 4 B 步进解析，`Len = 0` 被判成长度错；残留字节让下一次解析错位，进而闭锁。需求 C1 要求上位机每帧发满 63 B（补位不可避免），所以接收侧必须丢弃补位——虚拟下位机早已实现（`tools/vdevice/device-stack.mjs` 的 `#drain`，设计 §12 R-14、SubStage_2.1 §256）。
Fix（固件侧）：`Len === 0` → 整段丢弃；帧尾不足 4 B 且全 `0x00` → 丢弃；`Len` 非法 → 清累积器后回 `ACK_LEN_ERR`；再加 20–50 ms 帧间超时清累积器。
诊断方法：`--exec-file=scripts/probes/real-hid-raw-inbound.js`（看原始入站报文）与 `real-hid-gap.js`（量可用请求间隔）。**别把它误判成上位机 bug**：`ParamSession` 按 `S-h` 用 `0x02` 终止在途请求是协议要求，协议没有请求序号，补位产生的假 ACK 无法归因。

**2026-10-26 第二轮更新（固件 V0.0.2）**：正常请求路径已修好——补位 0–62 B 10 档全部「一请求一应答」，间隔 0 ms 可用。但**拒绝路径没修**：`UnitID = 0x01` 的一次读仍会回 18 条 ACK（4 ms 一条，`0x0001`/`0x0002` 交替），随后一条合法请求被这串 ACK 吞掉；`0x11`/`0x12` 超容量、未知功能码也会静默。所以：再看到「一次请求多条 ACK」先确认是不是拒绝路径（UnitID/长度错/CRC 错），别直接怀疑补位逻辑没改。复测用 `scripts/probes/real2-defects.js` 的 D1/D1b。

### 25. `pnpm run test:device` 的 T07 在本机稳定失败（定时器粒度）
症状：20 例里 `T07 写合并（R3-6）` 报 `120 次写产生 23 帧，超过 20`，用例耗时 3.2–3.3 s（预期 ≈1.9 s）。
根因：T07 的循环是 `client.write()` + `await delay(16)` 共 120 次；本机没有 Chromium 进程把系统定时器精度抬到 1 ms 时，Windows 的 15.6 ms 粒度让每次 `delay(16)` 实际 ≈27 ms，墙钟拉到 3.2 s，而写合并窗口 `writeThrottleMs = 120`，帧数 ≈ `ceil(T/120)+1` 就是 23。
已验证与代码无关：`git stash push -- src tests` 后重跑仍失败（3273 ms）。要它变绿：把 `writeThrottleMs` 调大或把用例的 `delay(16)` 改成按墙钟校准的写法，不要靠"跑着 Electron 顺带提高定时器精度"。

### 26. `sync()` 抢发 `0x13`，被在途电平轮询的 `0x12` 应答认领 →「预设回读应答不是连续读响应」
症状（M001 真机，2026-10-26 第二轮）：连上设备后第一次 `sync()` 成功，点「一键自检」再 `sync()` 就失败，顶栏「同步失败」、提示「设备没有应答，参数未写入」；诊断日志里 `0x13` 刚发出 2 ms 就收到一条 `00 12 00 0A 20 57 …`（轮询应答）。
根因：`ParamSession.cancelWork()` 把**已经发到总线上**的在途轮询直接丢弃（只调 `onFail`），但协议没有请求序号；poll 的 `0x12` 回包到达时，会话把它当成新一轮 `0x13` 的应答，`link.ts` 判定"不是连续读响应"。
Fix（已落盘，`device/proto/session.ts`）：**已上总线的请求不能丢**——`cancelWork()` 把在途任务标记 `abandoned` 并返回一个"等它回包/超时"的 Promise（总线空闲时返回 `null`，`sync()` 开头保持同步执行），`sync()` 等它兑现后才发新帧；遗弃任务的应答只释放槽位不回调；超时不重发；另加 `syncGeneration`（旧 sync 不得改相位）与 `drainingSync`（等回包期间压住轮询）。单测见 `tests/unit/proto/session.test.ts` 的「S-e × S-f 竞态」两条。
排查口径：**这不再是固件问题**。若协议将来加请求序号，可把 `abandoned` 逻辑换成按序号配对。复测用 `scripts/probes/real2-app-check-shot.js`（自检三步应全绿）。

### 27. 真机 DFU 写 Flash 的三个坑（M001 V0.0.2，2026-10-27 实刷）

症状与处置（都已在 `tools/dfu/m001-dfu.py` 里落地）：

1. **4 KB 扇区擦除偶发 `0x02`，回执约 1028 ms**（普通块 9–14 ms、扇区首块 ~30 ms）。落在 `Iap.Write → HalFlashErase` 内部 3 次「擦除+写+回读」全失败 + 设备 1 s 断流定时器。**重发同一块**即可过（设备在 `IapAddress += len` 之前就 return，地址没前进，重发安全）。
2. **重发会让设备 `DataCount` 多算**：`DfuProgram()` 先 `DataCount += len` 再写 Flash，写失败时 `IapAddress` 不前进。重发 N 次后设备提前 64·N 字节判定"收齐"，拿不足的累加和比整包校验和 → **`0x04`**。补偿：最后一块一次发完 896 B（`0x30480-896 = 0x30100` 是 256 对齐，`HalSpiFlashWrite` 页切分不回绕），`DataCount` 变成 `164992+64N` 仍 ≥ 长度，写入与校验和完整。
3. **进 DFU 后要等 1.2 s 再重开句柄**：MainApp 收到 ACK 后还要静音/关 UI 才写状态字节复位，抢在 200 ms 窗口里重开会拿到正在掉线的旧句柄（`ReadFile` 报 1167 `ERROR_DEVICE_NOT_CONNECTED`）。

另：**本机沙箱里 Electron 跑不起来**（子进程建不了命名管道 → `FATAL:platform_channel`），所以真机 DFU 取证走 ctypes 直连 HID（`tools/dfu/hidwin.py`）；`scripts/probes/real3-*.js` 那套 `--exec-file` 探针在本机只能用于不碰硬件的界面取证。设备信息区（`0x39000`）为空时 `JYM001` 信息帧必被 `0x01` 拒，只能改内存帧走 `000000` 通用升级。

## Domain constants

### 模块与参数字段（中文标签与单位参考 `效果器参数范围.xlsx`；数值真值见 `device/registers.ts`）

> v1.1.0 起，**地址 / 原始值域 / 标定 / 读写权限 / 默认值**一律以 `M001参数表V0.1.xlsx` 为准，实现落点是 `device/registers.ts`（原始值）与 `domain/params.ts`（42 项工程量）。本表沿用 v1.0.0 的口径，只当"中文标签 + 单位 + 语义"的索引；下表里的最小/最大/默认/步进凡是与 `PARAMS` 不一致的，以下表的注释与 `PARAMS` 为准。

| 模块 | 字段 | 含义 | 最小 | 最大 | 默认 | 步进 | 上位机权限 |
|---|---|---|---|---|---|---|---|
| Gain | Mic | 麦克风增益（`0x2023`，单位待定） | 0 | 100 | 100 | 1 | **只读** |
| Gain | Hp | 耳机增益（`0x205A`，单位待定） | 0 | 100 | 100 | 1 | **只读** |
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

合计 **42 项标量**（v1.1.0 起，见 `PARAMS`）= v1.0.0 的 36 项 + 新增 6 项（`mic.mute` `0x2022`、`mic.sigMute` `0x2058`、`hp.OnOff` `0x2059`、`eq.mode` `0x2026`、`comp.Enable` `0x204A`、`limit.Enable` `0x2051`）+ 改判 2 项（`comp.Threshold`、`limit.Threshold` 的默认值由 `−60` 改为寄存器表 raw 580 → `−2`，范围仍 `−60…0`）。EQ 段参数走 `EqModel` 不计入。

3BandDrc 三区：`freq < fc1`（low）、`fc1 < freq < fc2`（mid）、`freq > fc2`（high）。**寄存器段序不是频率顺序**：low(`0x2063`) → high(`0x2068`) → mid(`0x206D`)，每段 5 项按 `preGain/threshold/attackTime/releaseTime/ratio` 排；`drc3.*.ratio` 的寄存器默认 raw `1` 换算后 `0.1` 低于下限 `1`，`default` 取夹紧值 `1`。

EQ：共 14 段，上位机可调 `band[0..6]`，内部段 `band[7..13]`。Type 枚举 `0 PEAK / 1 LS / 2 HS / 3 LPF / 4 HPF`。

默认 EQ：前 7 段取寄存器表默认（HPF50 / LPF20000 / PEAK215 / PEAK1000 / PEAK2000 / PEAK5000 / PEAK10000；gain raw 320→0 dB，第 3 段 raw 285→−3.5 dB；q 0.7 / 0.7 / 0.8 / 1.5 / 1.0 / 1.0 / 0.7）；内部 7 段保持对数插值（全 PEAK、gain 0、q 0.7，永不进任何读写帧），内部段实测频点 `36 / 112 / 356 / 1125 / 3557 / 11247 / 17825`。

### 视觉与窗口常量

`--bg #0e1118`、`--panel #171c26`、`--panel-2 #1d2430`、`--border #323947`、`--accent #f0a65b`、`--accent-strong #f4aa5f`、`--text #e7ebf2`、`--muted #8592a7`、`--ok #86c7a5`、`--danger #f69a9a`。

EQ 轴：频率 20 Hz–20 kHz 对数，增益 −24…+12 dB；曲线色 `#F0A030`；节点半径 10。

窗口：1280×820 默认，最小 1100×700；顶栏 64px；工作台三栏 300 / 410 / 1fr（场景条横跨顶部），最小窗口下收紧为 280 / 360 / 1fr 并隐藏提示文字。
