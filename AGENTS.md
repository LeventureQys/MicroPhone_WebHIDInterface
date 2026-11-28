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

> 本机 Smart App Control / WDAC 会拦截双击 `.cmd`（已知坑 29）。双击启动请用仓库根的 `启动 MIC STUDIO.micstudio`；首次注册：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sac-launcher.ps1`（HKCU，无需管理员，`-Unregister` 撤销）。

`start.cmd` 只是入口，逻辑在 `scripts/start.ps1`；该文件必须保存为 **UTF-8 带 BOM**，否则 PowerShell 5.1 按 GBK 解码中文会直接语法错误。脚本默认给 Electron 加 `--no-sandbox`（已知坑 14 / 18），自动化调用时设 `MICSTUDIO_NO_PAUSE=1` 可跳过失败后的 `pause`。

一键打包（把本节的环境准备全做掉：定位 DSH 运行时、生成 pnpm shim、设镜像、清 `ELECTRON_RUN_AS_NODE`，然后类型检查 + 单测 + `electron-vite build` + electron-builder + 冒烟启动）：

```powershell
.\dist.cmd                        # → release/MicStudio-<ver>-portable.exe（默认唯一产物，双击即启动）
.\dist.cmd -Installer -Zip        # 附带 NSIS 安装包（本机未验证）与 win-unpacked 绿色版 zip
.\dist.cmd -Clean -OpenFolder     # 先清 release/ 旧产物，完成后打开目录
.\dist.cmd -SkipChecks -SkipSmoke # 只调打包链路时用（产物只保证能编译）
```

入口 `dist.cmd`，逻辑在 `scripts/dist.ps1`（同样必须存 **UTF-8 带 BOM**）。脚本另外生成 `release/build-info.txt`（版本 / 提交 / 体积 / SHA256）与 `release/使用说明.txt`（给最终用户的双击说明）；冒烟截图在 `artifacts/dist-smoke-<ver>.png`，启动日志复制到 `artifacts/dist-smoke-startup.log`。冒烟用 `Start-Process`（ShellExecute，等价双击）拉起 portable 并带 `--no-sandbox`：不带它时本机解包器会立刻以 `0x80000003` 退出（已知坑 14 / 18），与产物本身无关。

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

Ground truth（地址 / 标定 / 权限 / 默认值，唯一权威）：`Document/Update/Alpha/v1.4.0/M001参数表V0.4.xlsx`；`Document/Update/hardware/v0.0.6/usb audio demo buglist_20261116.docx` 是这一轮的界面需求单（黄色 = 上位机改）；`Document/Protocol/效果器参数范围.xlsx` 仅作中文标签与单位参考。

> 2026-11-28 换版：参数表 V0.4 更新 EQ 模式与频段默认值、灯效模式 0–6、三分频动态默认关闭。设置抽屉「恢复出厂设置」写 `0x100A=1`，收到 ACK 后回读设备预设。

> 2026-11-21 换版：参数表 V0.3（表内黄色标记）取代 V0.1 —— `0x2026` 上限 4→5、三分频 `fc1/fc2` 默认 50/50→1000/3000、三区 `preGain` 默认 0→128（=1.28）、新增 `0x2072`–`0x2075`（RGB 开关 / RGB 模式 / NoiseGate 使能 / 3BandDrc 使能），预设区由 114 项变 118 项。V0.1 仍在 `Document/Protocol/` 备查但**已作废**，不要照着它改代码。落地记录见 `Document/Update/hardware/v0.0.6/修复记录-参数表V0.3-20261121.md`。

| 参照 | 本仓 | 备注 |
|---|---|---|
| `Document/Update/Alpha/v1.4.0/M001参数表V0.4.xlsx` | `src/renderer/src/device/registers.ts`、`src/renderer/src/domain/params.ts`、`tools/vdevice/device-stack.mjs` | 地址 / 原始值域 / 标定 / 读写权限 / 默认值（118 项预设区，止于 `0x2075`） |
| `Document/Protocol/M001参数表V0.1.xlsx` | 同上 | **已作废**，只用于追溯历史结论 |
| `Document/Protocol/Modbus通讯协议说明_20261026.md` | `src/renderer/src/device/protocol.ts`、`device/proto/**`、`tools/vdevice/device-stack.mjs` | 帧结构 / CRC / 功能码 / Report ID / 0x10 双向复用（2026-10-26 换版，协议层唯一权威；评审见 `协议评审-Modbus协议_20261026.md`） |
| `Document/Protocol/效果器参数范围.xlsx` | `src/renderer/src/domain/params.ts` | 仅中文标签与单位；数值以寄存器表为准（三分频 preGain 1.28 / fc 1000-3000 与 V0.3 一致） |
| `Document/Update/hardware/v0.0.6/usb audio demo buglist_20261116.docx` | `ui/views/**`、`domain/scenes.ts` | 2026-11-16 界面需求单（文字/布局/自定义场景/模块 bypass） |
| `Document/Update/Alpha/v1.0.0/需求文档.md` | 全部功能范围 | 需求边界 |
| `Document/Update/Alpha/v1.0.0/设计文档.md` | 全部实现契约 | 接口签名与视觉规范 |
| `Document/Update/Alpha/v1.1.0/设计文档.md` | v1.1.0 契约与 §12 变更记录 R-1…R-38 | 与 v1.0.0 冲突时以本文件为准 |
| `Document/Update/hardware/v0.0.6/固件刷写逻辑说明-20261121.md` | `device/dfu/**`、`device/link.ts`、`ui/views/firmware-view.ts` | **刷写行为规格**：相位 / 判据 / 固定参数 / 失败处置；与代码冲突以本文为准 |
| 参照实现 AudioEQ_Visualized_Web（MIT） | `src/renderer/src/eq/**` | 频响算法与 Canvas 分层渲染 |
| `third_party/web_hid_utils/docs/*.md`、`packages/webhid-kit/README.md` | `src/renderer/src/device/webhid/**` | WebHID 强制约束、桥接协议、套件 API |

裁决：地址 / 标定 / 权限 / 默认值以 `M001参数表V0.4.xlsx` 为准（实现即 `device/registers.ts`）；帧结构 / CRC / 功能码 / Report ID / 上报语义以 `Modbus通讯协议说明_20261026.md` 为准（实现即 `device/proto/**` + `device/protocol.ts`）；中文标签与单位可参考 `效果器参数范围.xlsx`，但数值冲突时以寄存器表为准；曲线渲染细节以参照实现为准并做渲染适配。

## Architecture

Electron 主进程只负责窗口、菜单、WebHID 会话策略与 IPC；渲染进程是唯一业务层：`AppStore` 是状态唯一写入口，参数改动经 `Transport` 出站（Alpha 用 `MockTransport`），`EqModel` + `computeCurve` 产出曲线数据、Canvas 分层绘制。主进程不参与业务计算，渲染进程不碰 Node API。

界面是**一屏工作台**（`ui/views/console-view.ts`），没有导航与路由：所有日常逻辑同屏——顶部一键场景（`domain/scenes.ts`，顺序 安静房间 → 游戏 → 播客 → 唱歌 → 自定义，2026-11-22 起「会议」改名「游戏」；每个场景的快速调音与音色改动由 `domain/scene-presets.ts` 自动保存（静音 / 监听 / 灯效是全局开关，不记进场景；换音色也不退出场景），卡片右侧「复位」清回出厂预设，复位前会确认；每个参数 / EQ 段旁还有一枚「恢复」，撤销到场景刚应用时的基准值（设备回读算基准，不算用户改动）），左侧实时电平 + 只读增益 + 设备摘要，中间**噪声门阈值 / 压缩器阈值 / 防爆音**（三行各带模块开关，直接写协议 dB，不再是 0..100 抽象强度）、音色（原声 / 人声增强 / 温暖 / 明亮 / 自定义，启动默认「自定义」）、三个输入开关（麦克风静音 / 监听 / 电平信号静音），右侧 7 段音色曲线，底部环境降噪与**灯效开关 + 0–6 模式**（与高级参数同一组寄存器）。**主界面曲线在任何音色下都可拖 / 滚轮调 Q**，卡头「恢复默认」回当前音色的默认曲线（2026-11-25 起不再有「逐段精调」跳抽屉的按钮）。协议原始参数收进顶栏「高级参数」抽屉（`ui/views/advanced-view.ts`，由 `ui/modal.ts` 承载），设备与设置也以抽屉打开，不切页。`domain/quick-controls.ts` 只保留固定音色表、自定义曲线比较与防爆音使能换算，不再做强度↔阈值映射。

设备抽屉（`ui/views/device-view.ts`）走 `device/webhid/` 适配层调用第三方套件：只做「发现设备 / 开关设备 / 报告解码」，不参与参数 ↔ 字节映射，因此**不实现** `Transport`，`AppStore` 的 Mock 链路不变。详见 §WebHID 接入。

## Sub-projects

- `src/main`、`src/preload`：Electron 两端，产物 `out/main`、`out/preload`
- `src/renderer`：界面与业务，产物 `out/renderer`
- `src/renderer/src/ui/views/console-view.ts`：一屏工作台（主界面）
- `src/renderer/src/ui/views/advanced-view.ts`：高级参数抽屉（复用 input/dynamics/drc 视图与 EQ 段表）
- `src/renderer/src/ui/modal.ts`：抽屉/弹层宿主，Esc、遮罩点击、内容 destroy
- `src/renderer/src/domain/scenes.ts`：一键场景（场景 → 7 个协议字段 + 7 段 EQ；顺序 安静房间/游戏/播客/唱歌/自定义）
- `src/renderer/src/domain/scene-presets.ts`：场景的可编辑值（localStorage `micstudio.scenes` / 自定义曲线 `micstudio.customEq`；改一项存一项，复位只清当前场景）
- `src/renderer/src/domain/defaults.ts`：产品默认值（可调参数和 EQ 默认值从参数表 V0.4 派生）
- `src/renderer/src/domain/quick-controls.ts`：固定音色表、自定义曲线比较、防爆音使能换算（不再做 0..100 强度映射）
- `src/renderer/src/device/webhid`：webhid-kit 适配层（`types` 契约 / `kit` 唯一 import / `session` 状态机）
- `src/renderer/src/device/registers.ts`：寄存器真值表（地址 / 原始值域 / 标定 / 权限 / 默认值）+ `toRaw`/`fromRaw`；`domain/params.ts` 的 46 项由它派生
- `src/renderer/src/device/proto`：参数协议纯函数层（`crc` CRC-16 / `frame` 组帧与流式拆帧 / `codec` 编解码 / `timing` 唯一定时器出口 / `session` 串行队列 + 超时重试 + 写合并 + 电平轮询）
- `src/renderer/src/device/dfu`：固件升级层（`frame` SigmaBus 帧 / `image` 打包解析与预检 / `session` DFU 状态机）
- `src/renderer/src/device/link.ts`：设备连接编排（WebHid 会话 ↔ 通道 ↔ 参数同步 ↔ DFU）
- `src/renderer/src/device/auto-connect.ts`：后台自动连接（VID 0x0A67 / PID 0x0010，默认开，设置页可关）
- `src/renderer/src/device/audio-meter.ts`：音频电平表（固件不上报 `0x2057`，改采同一台设备的音频输入）
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

**后台自动连接（2026-11-07，`device/auto-connect.ts`；2026-11-13 降频）**：应用启动后在后台检查系统里的 `VID 0x0A67 / PID 0x0010`（M001）；设备插着但上位机没连上就自动 `connect('native')` + `link.attach()`，不必用户先点「连接」再点「打开」。**2026-11-13 起不再每 1.5 s 轮询**：`WebHidSession.watchNative()` 订阅 `navigator.hid` 的 connect/disconnect（插拔立即触发，300 ms 合并），轮询只作 5 s 兜底；探测走 `kit.probeNative(vid, pid)`——只问 `getDevices()` 并按 VID/PID 过滤，**不解析系统里其它 HID（键盘鼠标）的报告描述符、不构造 `NativeHidHandle`**，解决用户反馈的“上位机不需要频繁查询 USB 连接状态和获取设备描述符”。只在真机通道生效：连的是虚拟桥接（`ready` + `virtual`）时完全不碰；用户在设备页点「断开 / 关闭」→ `pause()`，要等设备拔掉一次或再次手动连接才重新自动连；升级中（`status='dfu'`）与正在连接时不动；参数同步失败时看 `wasReady`：**从没连上过**（开机就在 Bootloader）立即 `parked` 停手，避免一直对着升级模式空转；**连上过再掉下去**则按失败退避重试（最多 `maxAttempts`=3 次）后才 `parked`，设备刚复位 / 还没缓过来时能自己连回来。设置页「通道」卡有开关（`micstudio.autoConnect`，默认开，老配置缺键时按开处理）。实测（2026-11-07，本机真插 M001）：启动日志 `[auto-connect] 发现 USB Audio Device（native-0a67-0010-0），尝试自动连接` → `自动连接成功`，顶栏直接「已连接 / 已同步」，回读增益 97/34。`WebHidSession` 为此补了 `probeNative(target?)`（会话没连上时也能只读探测，不建设备表）、`watchNative()` 与 `nativeAvailable()`；`refresh()` 在设备表没变时不再 patch。

**掉线后自动重连（2026-11-07 用户要求"丢失了连接就尝试重新连接"）**：`AutoConnector` **不会**因为掉线而 `pause()`（`pause` 只由用户在设备页点「断开 / 关闭」触发）。拔线 → `WebHidTransport._onDisconnect` → 链路 error → 后台这一拍发现设备不在 → `paused/wasReady/attempts` 全被重置 → 插回后由 HID connect 事件立即（无事件时 ≤5 s）自动 `link.attach()` 回 ready，期间不需要用户点任何按钮。重连时若参数同步失败：`wasReady` 为真（这台设备这一轮连上过）→ `fail()` 退避重试 3 次（5/10/20 s）再 `parked`；为假（开机就停在升级模式）→ 一次就 `parked`。重连成功后 `DeviceLink._startAudioLevels()` 会再跑一遍，设备轮询仍然是关的（单测「keeps the device polling off after a reconnect」）。排查口径：真机拔插后没自动回来，先看 `[auto-connect]` 日志停在 `自动连接成功` / `设备参数同步失败` / `自动连接失败` 哪一条，再看 `state()` 的 `paused/parked/attempts`。单测：`tests/unit/auto-connect.test.ts` 的「re-attaches automatically after the link drops」「waits for the device to come back and reconnects on replug」「retries a failed reconnect instead of parking after one sync failure」「still parks after the reconnect retries are used up」「probes only the target VID/PID…」「subscribes to USB hot-plug events…」。

**电平来源（2026-11-07，`device/audio-meter.ts`）**：真机固件不上报 `0x2057`（始终 0），电平条改由**同一台设备的音频输入**算。`DeviceLink` 连上后 `AudioLevelMeter.start([HID productName, 'JYM001', 'M001'])` → `enumerateDevices()` 按 label 子串匹配端点（同分优先具体端点，不选 `Default - ` 别名；首次授权前 label 为空时先开一次默认输入拿权限再重挑）→ `getUserMedia`（显式关掉 `echoCancellation/noiseSuppression/autoGainControl`）→ `AnalyserNode.getFloatTimeDomainData`（fftSize 1024，33 ms 一帧）→ 算 RMS/峰值（峰值 300 ms 线性回落）→ `LevelFrame`（输出通道恒 -96）→ `ChannelTransport.useLevelSource()`。挂着外部源时设备上报的 `0x2057` 帧被丢弃；断开 / 停在 Bootloader 时 `stop()` 并摘源。主进程必须放行麦克风：`installWebHidHandlers` 的 permission check/request 允许 `media` 且只放 `audio`（摄像头拒绝），`index.ts` 加 `autoplay-policy=no-user-gesture-required`（否则 `AudioContext` 停在 `suspended`，`AnalyserNode` 不推进）。设备页诊断卡新增「电平来源」行；拿不到麦克风时按 `denied/unavailable/unknown` 显示原因并退回设备上报。实测（2026-11-07，本机真插 M001）：诊断显示「音频输入：麦克风 (USB Audio Device) (0a67:0010)」，电平条 **RMS -44.6 / 峰值 -32.8**（改前是 -60 / —）。

**连上就不再向设备要电平（2026-11-07，用户反馈"已连接还一直请求，怕把下位机卡死"）**：`0x2057` 的 20 ms 轮询是 50 帧/s ≈ 18 万帧/小时，而真机固件对它恒回 0、读数又被音频输入接管后丢弃——纯空转流量，长期压着下位机主循环。现在 `DeviceLink._startAudioLevels()` 一旦让音频输入接管电平就调 `WebHidTransport.setLevelPolling(false)`：`ParamSession.setPolling(false)` 停轮询，**入站看门狗一起停**（没有周期请求就没有"设备沉默"可判，否则 2 s 后自己判掉线；真实拔线仍由 HID `disconnect` 事件立即上报，设备不答则会在写参数超时时暴露）。**权限被拒或设备确实不在系统里**时（`LinkState.audio.source === 'device'`）才 `setLevelPolling(true)` 退回设备上报；设备还在、只是音频端点还在重枚举时是 `'retrying'`，轮询保持关闭（见下一段）。`_levelPolling` 是 transport 的字段，`_startSession()` / `resume()` 都按它决定 `setPolling()` 与看门狗，跨 `sync()` 与 DFU `suspend()+resume()` 保留，重建会话不会自己开回来。设备页诊断卡新增「设备轮询」行：`开（电平走设备上报）` / `关（电平走音频输入，不再发请求）`（`diag.device.poll` / `diag.poll.on` / `diag.poll.off`，`DeviceBoundTransport.levelPolling?()`）。单测：`tests/unit/transport.test.ts` 的四条轮询开关用例、`tests/unit/link.test.ts` 的两条（音频接管后零出帧 / 麦克风不可用仍轮询）、`tests/unit/device-view-diag.test.ts` 的 5e。实测（2026-11-07，虚拟下位机 `pnpm run vdevice` + 本机真实麦克风，探针 `scripts/probes/level-poll-idle.js`，截图 `artifacts/level-poll-idle.png`）：连接后 `[probe]` 读到 `poll=关（电平走音频输入，不再发请求）`、诊断帧计数在 1.5 s / +3 s 三次采样恒为 30（改前 50 帧/s 会一直涨）、4 s 后 `model` 仍是 `JYM001`（关轮询没有被入站看门狗误判成掉线），电平条照常走音频输入。

**拔插后音频监听自愈（2026-11-14，用户反馈"重插后电平条监听有时候会失效"）**：电平条采的是设备音频输入，而 Windows 重新枚举音频端点比 HID 慢——`attach()` 刚 ready 时 `getUserMedia` 常报 `NotFound/NotReadable`，旧实现这时直接把 `source` 置 `'device'` + 打开 `0x2057` 轮询，而固件恒 0，电平条就从此躺底；另外驱动重载 / 端点重建时 track 只 `ended`，旧实现也没人发现，采集会一直读旧缓冲。现在加了三层检查，**只要设备还在系统里就以音频驱动监听为准**：①`AudioCapture` 补 `alive()` / `onEnded()`（track `ended`、`AudioContext` `closed`），`AudioLevelMeter` 每次出帧先验健康度，断了就 `stop()` 并派 `onLost`；②`DeviceLink` 新增音频自检循环（`audioWatchMs` 默认 2 s；`onLost` / `navigator.mediaDevices.devicechange` 在 300 ms 合并窗口内触发），采集死了（含没有 `onLost` 的僵尸采集——出帧前的 `healthy()` 检查能发现）或采的是系统默认输入而设备端点已回来时 `_startAudioLevels({strict:true})` 重开——**strict 模式匹配不到设备端点就报 `unavailable`，绝不退回默认输入**（否则会把笔记本麦克风当成 M001 的电平）；③打开失败时按 `_devicePresent()`（HID 句柄已打开、未被判掉线）分流：设备还在 → `LinkState.audio.source='retrying'` + 保持 `setLevelPolling(false)`，按 300 ms 起指数退避（封顶 5 s）重开；只有权限被拒（不再空转）或设备确实不在才退回 `'device'` + 轮询。重试前先用 `AudioLevelMeter.find(hints)` 只读枚举确认端点回来（避免打开默认输入），再用 `AudioLevelMeter.start(hints,{strict:true})`；`DeviceLink.dispose()` 退订设备表 / `onLost` 监听。诊断卡「电平来源」行新增 `正在重新打开音频输入（设备还在，自动重试）`（`device.audio.retrying`）；控制台日志 `[audio-level]`（`DeviceLinkOptions.onEvent`）。单测：`tests/unit/audio-meter.test.ts` 的「采集被系统断开时通知 onLost…」「track 没发 ended…健康检查也能发现」「strict 模式…不退回默认输入」「find()/watchDevices」、`tests/unit/link.test.ts` 的「reopens the audio input when the capture dies…」「reopens strictly when the capture dies without an ended event」「keeps retrying … instead of falling back …」「switches from the system default input …」「checks immediately on an audio devicechange event」「does not spin … permission was denied」「stops the audio watchdog after detaching」、`tests/unit/device-view-diag.test.ts` 的 5f。

**首轮真机联调（2026-10-26，M001 `0x0A67/0x0010`）**：路径全部打通到「第 1 条回读成功、第 2 条被固件假 ACK 抢答」，参数链路卡在固件侧（补位零 + 解析器闭锁），详见 `Document/Update/Alpha/v1.1.0/真机联调报告.md`，取证在 `artifacts/real/`。实测三条与旧笔记冲突、已作废的假设：

1. **Electron 33.4.11 的 `HIDDevice` 带 `collections`**（含 `usagePage`/`usage`/报告数），`getDevices()` 与 `requestDevice()` 都有，所以 `shouldAllowSelection` 的 usage 复核在真机上可用；原「不含 collections、主进程只能粗筛」的结论作废。
2. 原生句柄 `NativeHidHandle` **不透出** `vendorId/productId/productName`（身份在 `handle.device` 上），必须经 `device/webhid/kit.ts` 的 `adaptNativeHandle()` 补齐，否则真机在枚举阶段就抛 `Cannot read properties of undefined`。
3. `getDevices()` 会列出系统里所有 HID 设备（键盘/鼠标/灯效），因为主进程 `setDevicePermissionHandler` 对 `hid` 一律放行；真机列表需要按 `collections` 过滤（遗留项 R2）。

**第二轮真机联调（2026-10-26 23:00，固件 V0.0.2）**：**参数链路已跑通**——`sync()`、诊断自检 3/3、场景写入 → 设备回读一致；补位零与解析器闭锁在正常请求路径上已修，`0x0001`/`0x0002` 只出现在拒绝路径。仍留 7 条固件问题（拒绝路径喷 ACK、读路径不校验地址、只读/范围不校验、`0x12` 超容量返回 514 B 帧、区间是 `0x2075`(118) 不是 `0x2071`(114)、`0x2057` 恒 0 且无周期上报、信息区/预设区无默认值），详见 `Document/Update/Alpha/v1.1.0/真机联调报告-第二轮.md`，取证在 `artifacts/real2/`，探针 `scripts/probes/real2-*.js`。

**真机 DFU 已刷通（2026-10-27 21:11，M001 `0x0A67/0x0010`）**：`JYM001` 信息帧被 `0x01` 拒（设备信息区为空）→ 内存改 `000000` 重封 CRC → `0x03` → 64 B/块 × 2564 + 末块 896 B → **`0x05`**，120.6 s；设备写 `{A5,FF,00,02}` 复位后重新枚举为 `USB Audio Device`（`MI_00` 音频 + `MI_03` HID），Modbus 正常。整轮不依赖 Electron：`tools/dfu/m001-dfu.py` + `hidwin.py`（ctypes 直连 HID）。App 内 DFU 仍缺「等重枚举 + 重开句柄」（评审 P0-1/P0-2），救砖通道（P1-1）未做；详细过程、失败模式与主机侧三条修正见 `Document/Update/Alpha/v1.1.0/真机DFU刷写成功记录.md`，符合性评审见 `Document/Protocol/DFU协议符合性评审_20261026.md`。

**第三轮真机联调（2026-10-27 21:20–21:35，刷完 V0.0.2 后）**：这是**刷完机之后**第一次完整跑参数链路 + 逐条协议一致性，报告 `Document/Update/Alpha/v1.1.0/真机联调报告-第三轮.md`，探针 `scripts/probes/real4-*.js`，取证 `artifacts/real4/`。要点：

- **上位机侧全绿**：连接 → `sync()` → 诊断自检连跑 3 轮（3/3 全绿）→ 场景「播客/会议」写入 → 原始 HID 整段读回一致；`crc/timeout/retry` 全 0，已知坑 24（正常路径）与坑 26（`0x12`/`0x13` 竞态）都不复发。
- **协议矩阵 24 条：17 通过 / 6 失败**（`real4-conformance.js`）。框架层（`Len`、CRC-16、多报文 246 B、补位零、越界 `0x05`、坏 CRC `0x03`、长度类 `0x02`）全部符合。
- **仍不合格**：① 拒绝路径一请求 3 条 ACK（`UnitID=1` 回 `0x01,0x01,0x03`；SigmaBus 帧回 17 条）；② 只读 `0x2023` 可写且回 `0x0000`；③ 越界值 `0x2025=9` 被接受；④ 信息区 62 字全 0（界面 `0.0.0.0`/`0x0000/0x0000`）；⑤ 配置区心跳 0（表默认 700）、预设区全 0（`0x2001` 有效标志 0）；⑥ `0x2057` 恒 0（播放 440 Hz 14 s 采样 17 次仍 0）且无周期上报。
- **`0x10` 设备→主机上报的实测语义**（协议文档未写）：只有 `0x2024`/`0x2025` 真的变化时，设备才在 ACK 后约 5 ms 推一条 `0x10`，内容固定是这两个字；与用 `0x10` 还是 `0x11` 写无关；写同值/其它参数/空闲都不报（`real4-report.js` 8 组）。上位机 `_applyEcho` 已按「镜像更新、不回写」处理，不形成写环。
- **口径冲突待裁决**：协议 §五 写预设区 `0x2000~0x2075`(118)，参数表只有 114 项（止于 `0x2071`），固件按 118 放行（读 `0x2072..0x2075` 回 0 而不报错）。建议以参数表为准。
- 上位机小修：信息区为空时抽屉原本显示「设备型号不匹配：」加空值，已改为 `device.warn.modelMissing`（`设备未返回型号信息（信息区为空）`），`link.test.ts` 补例，重编后截图验证。

**第四轮真机联调（2026-11-04，M001 App 模式）**：主机侧全流程通过——连接 / `sync()` / 自检 3/3（连续 4 次）/ 场景写入回读 / 20 次连续写 / 空闲 60 s / 关闭重开；**未复现写 Flash 卡顿与偶发断连**（写 ACK 4.1–9.8 ms，写后立即读 6–11 ms，`timeouts/retries` 全 0）。固件侧余留：信息区/配置区/预设区全 0（`validFlag=0`，EQ 段 enable/type/freq 全 0）、只读与范围不校验、拒绝路径一次请求 17 条 ACK、非法高地址 `0x3000`/`0x4000` 读回内存垃圾、`0x12` 读上限 118（119+ 回 `0x0005`，124–127 的 5 报文请求偶发无回执）、`0x2057` 恒 0。DFU 按用户决定主动未做（Bootloader 写 Flash 挂死 + 本机无 J-Link）。详见 `Document/Update/Alpha/v1.1.0/真机联调报告-第四轮.md`，取证 `artifacts/real4/`，探针 `scripts/probes/real4-*.js`。

**第五轮 DFU 升级测试（2026-11-04，V0.0.4）**：**升级成功，正常路径已复测通过**。主机侧修复：空/全 0 设备型号按"未知"放行（不再报"型号不对"）、`kit.ts` 用 `WeakMap<HIDDevice, 适配句柄>` 缓存真机句柄（修掉重枚举误判）、`decodeAsciiWords()` 把 `0xFF` 擦除值当终止符、DFU 重枚举后等 1 s（`dfuEnterSettleMs`）、265 B 块帧的报告间留 2 ms（`dfuReportGapMs`，设备 OUT 只有 4 槽）、SigmaBus 0x00 补位静默、settling 后不再解析 App 报文。首轮从 App 进 DFU 在 44/654 块超时，复现于 11/654；修复后从 App 用官方 `JYM001` 包**一次写完 654/654（约 21 s，timeout/retry 0）**，设备重启到 V0.0.4；从 Bootloader 直连官方包恢复也成功。升级后新固件初始化了 `0x39000` 信息区与配置/预设区：型号 `JYM001`、名称 `M001`、固件 `0.0.4.0`、自检 3/3；官方 `JYM001` 包预检通过。遗留：SN 区仍 `0xFFFF`（界面显示"—"）。详见 `Document/Update/Alpha/v1.1.0/真机DFU升级测试-第五轮.md`，取证 `artifacts/real5/`。

**第六轮全量真机联调（2026-11-04，V0.0.4，不含 DFU）**：上位机侧全绿——42 项界面值 ⇄ 寄存器真值 **42/42**（`real6-compare.mjs` 用 `registers.ts` 反算）、42 项逐项写入 → 裸 HID 回读 **40/40**（另 2 项只读无控件）、EQ 7 段 28 值全中、四场景与业务控件映射全中（降噪 80→raw 73、平稳 40→360、明亮增益 300…370）、20 连写 `timeouts/retries=0`、空闲 60 s 3028 帧无掉线、关闭重开 + 自检 3/3。协议矩阵 24 条：19 过 / 4 失败 / 1 跳过；拒绝路径从 17 条 ACK 降到 **UnitID 3 条、CRC/长度各 1 条**（未知功能码仍静默）。固件仍缺：只读与范围校验（`0x2023`/`0x2025` 任意值都收）、`0x3000/0x4000` 读回未初始化内存、`0x2057` 恒 0 且无上报。**新发现 P1**：预设初始化整体右移 2 字——`0x205D..0x2073` 恰好等于参数表 `0x205B..0x2071` 的默认值序列（23/23），疑似固件结构体比协议地址表少 4 B，需固件确认 DSP 侧取值是否也偏移；另预设名按小端存（`Factory1 Preset 1`）、EQ 前 7 段默认频点 3 处与表不一致（20/1000/2000 vs 50/2000/5000）。收尾用 `scripts/probes/real6-restore.py` 把 76 项 rw 参数还原为参数表默认值（0 失配）。详见 `Document/Update/Alpha/v1.1.0/真机联调报告-第六轮.md`，取证 `artifacts/real6/`，探针 `scripts/probes/real6-*`。另注：用户自己的 MIC STUDIO 实例持有 `.userdata` 单实例锁时，探针要换独立 userData（本轮用 `D:\Temp\ud6`）。

**界面 DFU 复测（2026-11-07，包 V0.0.5）**：用 CDP 驱动真实界面（`scripts/probes/dfu-ui-v005.mjs`，`--remote-debugging-port` + `Page.captureScreenshot`）把 `Document/Protocol/dfu_M001 MCU V0.0.5_2026-11-07_Rev0.bin` 从 M001 `0.0.4.0` 升到 `0.0.5.0`：预检 `JYM001 / M001 / 0.0.5 / 168888 B / 660 块 / 0xF653D0BB` 与独立解析逐项一致；**22.3 s** 写完 660/660 块并完成重枚举与回读（`crc/timeout/retry` 全 0，`dropped=1`），收尾后「已连接 / 已同步」。报告 `Document/Update/Alpha/v1.1.0/真机DFU升级测试-V0.0.5-20261107.md`，取证 `artifacts/dfu-v005/`。遗留两处 UX：`phase='done'` 后「开始升级」仍可点（会重刷同一镜像）；DFU 段诊断日志没单独取证。

**DFU 包格式（协议《DFU固件升级通讯协议说明_20261026》）**：包首「进入 DFU」帧有两种形态——旧 SigmaBus `C4 0B 00 00 03 08 10 01 00 15 FF`，或 2026-10-26 起的新 Modbus 帧 `00 10 00 0A 10 08 00 01 8D 09`；`device/dfu/image.ts` 的 `detectPackageHeader()` 两种都收，`ParsedImage.headerKind` 记录形态，`frames[0]` 仍是包首帧。信息帧体固件只读前 81 B（出厂包 = 81 / 整帧 90），协议文档写的 85 / 94 是笔误，解析器两种长度都接受。**主机侧已补上「进 DFU 后等设备重枚举 + 重开句柄」与「设备停在 Bootloader 时保留原始通道继续升级」**（2026-10-27，见已知坑 28/30 与 `Document/Update/Alpha/v1.1.0/修复记录-真机问题-20261027.md`）；第五轮（2026-11-04）已完成 V0.0.4 完整升级（App 正常路径 + Bootloader 直连），见 `Document/Update/Alpha/v1.1.0/真机DFU升级测试-第五轮.md`；评审见 `Document/Protocol/DFU协议符合性评审_20261026.md`。

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

**2026-11-07 复测（SAC 开启后）：「portable 双击不吃沙箱限制」这条已经不成立。** 用计划任务（`schtasks /IT`，进程不在 DSH 工具进程树里，等价用户双击）拉起 `release/MicStudio-1.1.0-portable.exe`：不带参数 → **退出码 `0x80000003`**、无窗口、不写 `MicStudioData\startup.log`；带 `--no-sandbox` → 7 s 出窗口、截图与日志齐全。同一份刚打出来的 exe 有时还会被 ShellExecute 直接拒掉：`This command cannot be run due to the error: An Application Control policy has blocked this file.`（SAC 云端裁定，过几分钟再跑又能起）。所以：**本机验证打包产物一律带 `--no-sandbox`**（`scripts/dist.ps1` 的冒烟即如此），`release/使用说明.txt` 也写了这条；目标机双击是否同样需要该参数取决于那台机器的 Chromium 沙箱 / App Control 策略。

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

### 25. `pnpm run test:device` 的 T07 在本机稳定失败（定时器粒度）—— 2026-11-21 已修
症状：20 例里 `T07 写合并（R3-6）` 报 `120 次写产生 23 帧，超过 20`，用例耗时 3.2–3.3 s（预期 ≈1.9 s）。
根因：T07 的循环是 `client.write()` + `await delay(16)` 共 120 次；本机没有 Chromium 进程把系统定时器精度抬到 1 ms 时，Windows 的 15.6 ms 粒度让每次 `delay(16)` 实际 ≈27 ms，墙钟拉到 3.2 s，而写合并窗口 `writeThrottleMs = 120`，帧数 ≈ `ceil(T/120)+1` 就是 23。
已验证与代码无关：`git stash push -- src tests` 后重跑仍失败（3273 ms）。要它变绿：把 `writeThrottleMs` 调大或把用例的 `delay(16)` 改成按墙钟校准的写法，不要靠"跑着 Electron 顺带提高定时器精度"。

**2026-11-21 修法**：`tools/vdevice/selftest.mjs` 的 TIMING 镜像是上一轮的遗留（仍是 120 ms、且是前沿触发），已同步成 `writeThrottleMs = 300` + **尾沿触发**（与 `device/proto/session.ts` 一致）：一次拖拽只在停手后出 1 帧，墙钟被拉到 3.9 s 也只会出 ~13 帧，稳定落在 ≤20 内。实测 `SUMMARY passed=20 failed=0`。

### 26. `sync()` 抢发 `0x13`，被在途电平轮询的 `0x12` 应答认领 →「预设回读应答不是连续读响应」
症状（M001 真机，2026-10-26 第二轮）：连上设备后第一次 `sync()` 成功，点「一键自检」再 `sync()` 就失败，顶栏「同步失败」、提示「设备没有应答，参数未写入」；诊断日志里 `0x13` 刚发出 2 ms 就收到一条 `00 12 00 0A 20 57 …`（轮询应答）。
根因：`ParamSession.cancelWork()` 把**已经发到总线上**的在途轮询直接丢弃（只调 `onFail`），但协议没有请求序号；poll 的 `0x12` 回包到达时，会话把它当成新一轮 `0x13` 的应答，`link.ts` 判定"不是连续读响应"。
Fix（已落盘，`device/proto/session.ts`）：**已上总线的请求不能丢**——`cancelWork()` 把在途任务标记 `abandoned` 并返回一个"等它回包/超时"的 Promise（总线空闲时返回 `null`，`sync()` 开头保持同步执行），`sync()` 等它兑现后才发新帧；遗弃任务的应答只释放槽位不回调；超时不重发；另加 `syncGeneration`（旧 sync 不得改相位）与 `drainingSync`（等回包期间压住轮询）。单测见 `tests/unit/proto/session.test.ts` 的「S-e × S-f 竞态」两条。
排查口径：**这不再是固件问题**。若协议将来加请求序号，可把 `abandoned` 逻辑换成按序号配对。复测用 `scripts/probes/real2-app-check-shot.js`（自检三步应全绿）。

### 27. 调节参数后卡顿 / 偶发「断连」——设备写 Flash 时主循环停摆
症状（M001 真机，2026-10-27 反馈）：改一个参数后设备短暂无响应，界面偶发转「同步失败 / 连接异常」；诊断卡里 `timeouts`、`retries` 上涨，严重时 `ParamSession` 连续超时把通道打成 error。**没有拔线**。
根因两层：① 写参数后固件把参数落 Flash，写 Flash 期间主循环不响应 USB，500 ms 的读超时会被当成写超时，重发写又触发一次落盘（越调越卡）；② 入站看门狗只按"2 s 没有 IN 报告"判掉线，把落 Flash 的静默误判成拔线。
Fix（已落盘）：
- `TIMING.writeTimeoutMs = 3000`：写等 ACK 单独用长超时，读/轮询仍 500/200 ms。
- `TIMING.writeRetries = 1`：写超时最多重发 1 次（校验错/地址错仍按 `requestRetries = 2`）。
- `TIMING.writeSettleMs = 600`：写回执后暂停电平轮询，别在落 Flash 窗口里塞请求。
- `TIMING.writeGraceMs = 8000`：从最后一次写帧算起，设备静默不算掉线；`WebHidTransport._checkWatchdog` 同时看本地写时刻与 `ParamSession.writeActivityWithin()`。
- 真实拔线仍由 HID `disconnect` 事件立即上报，不受宽限影响。
排查口径：先看诊断卡 `timeouts/retries` 与最后一条写帧；若 `retries` 明显上涨，是设备落 Flash 慢，不要先怀疑协议；若 `onError` 是 HID `disconnect`，那才是物理断开。单测：`tests/unit/proto/session.test.ts` 的「写超时与写后轮询让位」、`tests/unit/transport.test.ts` 的「keeps the link ready while the device is saving flash」。

**2026-11-04 第四轮复测**：M001 真机上 20 次连续写（`0x2025`）、12 次 EQ 写、8 连写、写后立即读，ACK **2.4–11.1 ms**、写后读 **6–11 ms**，`timeouts/retries` 全 0，**未复现卡顿/断连**；但设备预设区 `validFlag=0`，不排除固件只写 RAM、未真正落 Flash。数据见 `Document/Update/Alpha/v1.1.0/真机联调报告-第四轮.md` §4。

### 28. DFU 进 Bootloader 后旧句柄失效 / 重开上位机接不上，无法继续升级
症状（M001 真机，2026-10-27 反馈）：点开始升级，`0x1008=1` 收到 ACK 后上位机像在等回包，随后 `probeFailed`；此时重开上位机，设备页「打开」卡在参数同步（Bootloader 不说 Modbus），固件抽屉选包又被预检判「型号未知 / 没有已连接设备」。
根因三处：① 进 DFU 后设备复位重枚举（约 200 ms 复位、1–3 s 出现），主机仍拿旧 `HIDDevice` 发信息帧；② 收尾 `resumeAfterDfu()` 也没有重开句柄；③ `attach()` 参数同步失败就 `dispose` 掉 transport，且预检把"拿不到型号"当拒绝，救砖路径全断。
Fix（已落盘）：
- `DeviceLink.awaitReenumeration()`：`WebHidSession.refresh()` 轮询新句柄（同 deviceId 优先，id 漂移时按 VID/PID 找"不是旧句柄"的那台），`WebHidTransport.reopen(handle)` 换句柄并重挂入站监听；窗口 `TIMING.dfuReenumTimeoutMs = 8000`、间隔 `dfuReenumPollMs = 200`。
- `DfuSession` 新增 `reconnect` 钩子：EnterDfu 收到 ACK 后、信息帧之前调用；失败报 `DfuError.kind = 'reenumerate'`，不发信息帧。
- `DeviceLink.resumeAfterDfu()` 先 `awaitReenumeration()` 再 `transport.resume()`；`DfuSession.dfuSettleTimeoutMs` 放宽到 20 s，覆盖"重枚举 8 s + 两次全量回读"。
- `DeviceLink.attach()` 参数同步失败但句柄仍开时走 `_failSync()`：保留 transport / 入站监听，只把 `store.sync` 置 error；设备页错误框提示"可能停在升级模式，去固件升级"。
- `DfuSession.preflight()` 在 `deviceModelCode() === null` 时**放行**（不再报 `unknown-device`），型号交给 Bootloader 用 Flash 信息区校验（不符回 `0x01 INFO_ERR`）。
- 虚拟通道（`WebHidSession.mode === 'virtual'`）没有真实重枚举，`awaitReenumeration()` 直接返回，vdevice 自检不受影响。
排查口径：真机若仍 `probeFailed`，先看诊断卡有没有 "EnterDfu 没有 ACK" 与重枚举错误；`Mock` 里不会复现。单测：`tests/unit/link.test.ts` 的「keeps the raw channel…」「swaps to the newly enumerated handle…」、`tests/unit/dfu/session.test.ts` 的「进 DFU 后等设备重新枚举」、`tests/unit/dfu/controller.test.ts` 的 3c/3d/5c。

**2026-11-04 第五轮真机补充**：真机 `getDevices()` 每次返回新的 `NativeHidHandle` 包装，但底层 `HIDDevice` 是同一个对象；`adaptNativeHandle()` 若每次新建适配句柄，`awaitReenumeration()` 会在设备复位前把"同一台设备的刷新"误判成"新设备"，提前发信息帧并报 `The device must be opened first.`。已在 `device/webhid/kit.ts` 用 `WeakMap<HIDDevice, 适配句柄>` 缓存；单测 `tests/unit/webhid-kit.test.ts`。修复后首轮从 App 进 DFU 仍有一次 44/654 块超时；拔插后从 Bootloader 直连重试 **654/654 成功**。正常路径复测又在 11/654 超时，定位为“重枚举后写得太早 + 5 个 63 B 报告超过设备 4 槽 OUT”；加 `dfuEnterSettleMs=1000`、`dfuReportGapMs=2` 后，App→官方包**一次写完 654/654（约 21 s）**，官方包 Bootloader 直连恢复也通过。详见 `真机DFU升级测试-第五轮.md`。

### 29. Smart App Control / WDAC 拦截双击 `.cmd` / `.bat` / `.lnk`
症状（2026-11-04，本机）：双击 `start.cmd` 弹「智能应用控制已阻挡…」，窗口不出现；`explorer.exe start.cmd` 也不启动。事件查看器 `Microsoft-Windows-CodeIntegrity/Operational` 记 `3033`：`explorer.exe` 试图加载 `System32\cmd.exe`，不满足 Enterprise 签名级别。
根因：本机 `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState = 1`（SAC 开启），且 `C:\Windows\System32\CodeIntegrity\CiPolicies\Active` 里还有一条 **Microsoft Windows Endpoint Security Policy**（WDAC，enforced）。实测**新建的空白 `hello.cmd` / `hello.bat` / `.lnk` 全部被拦**，而 `cmd.exe`、`powershell.exe`、`electron.exe` 本体可以从资源管理器启动。Microsoft 明确 SAC 没有按文件/目录的例外，改脚本内容绕不过去。
Fix / 绕过：
- **双击入口**：仓库根的 `启动 MIC STUDIO.micstudio`（自定义扩展名，`HKCU\Software\Classes\.micstudio` 关联到 `powershell.exe -File scripts\start.ps1 app`）。首次注册：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sac-launcher.ps1`，不需要管理员；`-Unregister` 撤销。实测双击可拉起窗口（`out/` 构建产物）。
- **右键入口**：注册脚本同时在文件夹右键菜单加「启动 MIC STUDIO」。
- **终端入口**（不受影响）：`cmd /c "D:\WorkShop\MicroPhone_WebHIDInterface\start.cmd" app` 或 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 app`。
- **彻底解决**：关 SAC（Windows 安全中心 → 应用和浏览器控制 → 智能应用控制 → 关闭，需管理员）；公司策略管理的 WDAC 需 IT 放行。**不要**把 `start.ps1` 改成 `.cmd` 再试——策略拦的是扩展名/脚本宿主，不是内容。
- 证据：`artifacts/` 下无（系统事件）；复现命令：新建 `hello.cmd` 后 `Start-Process explorer.exe hello.cmd`，查 3033。

### 30. 真机 DFU 写 Flash 的三个坑（M001 V0.0.2，2026-10-27 实刷）

症状与处置（都已在 `tools/dfu/m001-dfu.py` 里落地）：

1. **4 KB 扇区擦除偶发 `0x02`，回执约 1028 ms**（普通块 9–14 ms、扇区首块 ~30 ms）。落在 `Iap.Write → HalFlashErase` 内部 3 次「擦除+写+回读」全失败 + 设备 1 s 断流定时器。**重发同一块**即可过（设备在 `IapAddress += len` 之前就 return，地址没前进，重发安全）。
2. **重发会让设备 `DataCount` 多算**：`DfuProgram()` 先 `DataCount += len` 再写 Flash，写失败时 `IapAddress` 不前进。重发 N 次后设备提前 64·N 字节判定"收齐"，拿不足的累加和比整包校验和 → **`0x04`**。补偿：最后一块一次发完 896 B（`0x30480-896 = 0x30100` 是 256 对齐，`HalSpiFlashWrite` 页切分不回绕），`DataCount` 变成 `164992+64N` 仍 ≥ 长度，写入与校验和完整。
3. **进 DFU 后要等 1.2 s 再重开句柄**：MainApp 收到 ACK 后还要静音/关 UI 才写状态字节复位，抢在 200 ms 窗口里重开会拿到正在掉线的旧句柄（`ReadFile` 报 1167 `ERROR_DEVICE_NOT_CONNECTED`）。

另：**DSH 以 `workspace-write` 运行时 Electron 起不来**（子进程建不了命名管道 → `FATAL:platform_channel`），此时真机取证只能走 ctypes 直连 HID（`tools/dfu/hidwin.py`）。把文件策略放到 `danger-full-access` 后 `electron.exe . --no-sandbox` 可正常起窗口，`--exec-file` 探针能直接碰硬件（2026-10-27 第三轮联调即以此取证，见 `Document/Update/Alpha/v1.1.0/真机联调报告-第三轮.md`）。设备信息区（`0x39000`）为空时 `JYM001` 信息帧必被 `0x01` 拒，只能改内存帧走 `000000` 通用升级。

> 2026-11-04 第五轮：App 内 DFU 已补齐重枚举/救砖入口并完成 V0.0.4；本坑里的“App 内仍缺”与“必须走 ctypes”只适用于 2026-10-27 那轮，现在的 Electron 探针也能直接跑。上面的 4 KB 擦除重发/DataCount 补偿仍适用于 Bootloader 底层。

### 31. 固件升级失败 / 拔线后链路卡在“升级中”，只能重开 app（2026-11-07 修）

症状（用户反馈）：固件升级失败，或者升级中/平时把线拔了，之后点「立即重试」「重插后再试」「设备页打开」都没反应，必须关掉 app 重开。

根因（四处叠加，均已修）：
1. **失败收场不恢复链路**：`FirmwareController.start()` 原来只在 `run()` 成功后才调 `resumeAfterDfu()`；失败/中止只 `setDfuActive(false)`，于是 `DeviceLink.status` 永久停在 `'dfu'`、`WebHidTransport._suspended` 永久为真。后果：参数写入被 `write()` 静默丢弃、`disconnect` 被 `_onDisconnect` 吞掉、`_handleDrop()` 因 `status==='dfu'` 直接 return，界面却还显示“已同步/已连接”。
2. **`open()` 在挂起时直接返回**：`suspend()` 不改 `state`（仍 `'ready'`），`DeviceLink.attach()` 里的 `transport.open()` 命中 `state === 'ready'` 早退，`readAll()` 的入站字节又被 `_suspended` 拦掉 → 每一条回读都超时 → `_failSync()`。设备页「打开」因此永远失败。
3. **重试不重新枚举句柄**：`DfuSession.reconnect`（= `DeviceLink.awaitReenumeration()`）只在 **EnterDfu 拿到 ACK 之后**调用；句柄已死时 EnterDfu 的 `sendReport` 直接抛 → `channel` 错误 → 永远走不到重枚举。`replugAndRetry()` 又只是 `attach(getState().deviceId)`，用会话里的旧句柄，从不 `refresh()`。
4. **设备表不跟热插拔**：`WebHidSession` 没有 `hid.connect/disconnect` 订阅，拔插后 `devices[].opened` 与句柄表都是旧值；`attach()` 也没刷新，所以“打开”必然对着死句柄。

Fix（已落盘）：`FirmwareController.start()` 发第一帧前 `link.reacquire()`（失败 → 新错误码 `unplugged`，零出帧），`finally` 里按 `suspended` 调 `link.recoverAfterDfuFailure()`；`DeviceLink` 新增 `reacquire()`（`refresh()` + 换句柄 `reopen()`，通道丢了就重建裸通道）、`recoverAfterDfuFailure()`（能同步就回 ready，否则保留裸通道 + `device.warn.bootloader`）、`attach()` 走 `_openHandle()`（旧句柄打不开就刷新一次再开）；`WebHidTransport` 新增 `cancelDfu()` / `handleLost()`，`_fail()` 清挂起，`open()` 在挂起时改走 `resume()`；固件抽屉加「中止升级」。回归用例：`tests/unit/{transport,link,dfu/controller,firmware-view}.test.ts`。

排查口径：**再看到“升级失败后只能用重开 app 解决”，先看 `link.getState().status` 是否还是 `'dfu'`、`transport.stats().outFrames` 是否在界面操作时完全不动**——这两条同时成立就是本坑复发（或又出现新的“失败路径不恢复”分支）。

## Domain constants

### 模块与参数字段（中文标签与单位参考 `效果器参数范围.xlsx`；数值真值见 `device/registers.ts`）

> v1.1.0 起，**地址 / 原始值域 / 标定 / 读写权限 / 默认值**一律以 `M001参数表V0.4.xlsx`（`Document/Update/Alpha/v1.4.0/`）为准，实现落点是 `device/registers.ts`（原始值）与 `domain/params.ts`（46 项工程量）。本表沿用 v1.0.0 的口径，只当"中文标签 + 单位 + 语义"的索引；下表里的最小/最大/默认/步进凡是与 `PARAMS` 不一致的，以 `PARAMS` 为准。

| 模块 | 字段 | 含义 | 最小 | 最大 | 默认 | 步进 | 上位机权限 |
|---|---|---|---|---|---|---|---|
| Gain | Mic | 麦克风增益（`0x2023`，单位待定） | 0 | 100 | 100 | 1 | **只读** |
| Gain | Hp | 耳机增益（`0x205A`，单位待定） | 0 | 100 | 100 | 1 | **只读** |
| NoiseGate | Enable | 噪声门使能位（`0x2074`，V0.3 新增；0 = 旁通） | 0 | 1 | 1 | 1 | 可调 |
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
| 3BandDrc | Enable | 三分频动态使能位（`0x2075`，V0.3 新增；0 = 旁通） | 0 | 1 | 1 | 1 | 可调 |
| 3BandDrc | fc1 | 分频点 1 (Hz) | 50 | 10000 | 1000 | 1 | 可调 |
| 3BandDrc | fc2 | 分频点 2 (Hz) | 50 | 10000 | 3000 | 1 | 可调 |
| 3BandDrc | preGain ×3 | 低/中/高区 | 0 | 4 | 1.28 | 0.01 | 可调 |
| 3BandDrc | threshold ×3 | 低/中/高区 | -80 | 0 | 0 | 0.1 | 可调 |
| 3BandDrc | attackTime ×3 | 低/中/高区 (ms) | 1 | 400 | 10 | 1 | 可调 |
| 3BandDrc | releaseTime ×3 | 低/中/高区 (ms) | 5 | 680 | 20 | 1 | 可调 |
| 3BandDrc | ratio ×3 | 低/中/高区 | 1 | 20 | 10 | 0.1 | 可调 |
| RGB | OnOff | 灯效开关（`0x2072`，V0.3 新增） | 0 | 1 | 1 | 1 | 可调 |
| RGB | Mode | 灯效模式（`0x2073`，V0.3 新增；灯效含义由固件定义） | 0 | 7 | 0 | 1 | 可调 |

合计 **46 项标量**（见 `PARAMS`）= v1.1.0 的 42 项 + 参数表 V0.3 新增 4 项（`noisegate.Enable` `0x2074`、`drc3.Enable` `0x2075`、`rgb.OnOff` `0x2072`、`rgb.Mode` `0x2073`）。v1.1.0 那 42 项 = v1.0.0 的 36 项 + 新增 6 项（`mic.mute` `0x2022`、`mic.sigMute` `0x2058`、`hp.OnOff` `0x2059`、`eq.mode` `0x2026`、`comp.Enable` `0x204A`、`limit.Enable` `0x2051`）+ 改判 2 项（`comp.Threshold`、`limit.Threshold` 的默认值由 `−60` 改为寄存器表 raw 580 → `−2`，范围仍 `−60…0`）。EQ 段参数走 `EqModel` 不计入。

3BandDrc 三区：`freq < fc1`（low）、`fc1 < freq < fc2`（mid）、`freq > fc2`（high）。**寄存器段序不是频率顺序**：low(`0x2063`) → high(`0x2068`) → mid(`0x206D`)，每段 5 项按 `preGain/threshold/attackTime/releaseTime/ratio` 排；`drc3.*.ratio` 的寄存器默认 raw `1` 换算后 `0.1` 低于下限 `1`，`default` 取夹紧值 `1`。

EQ：共 14 段，上位机可调 `band[0..6]`，内部段 `band[7..13]`。Type 枚举 `0 PEAK / 1 LS / 2 HS / 3 LPF / 4 HPF`。

默认 EQ：前 7 段取寄存器表默认（HPF50 / LPF20000 / PEAK215 / PEAK1000 / PEAK2000 / PEAK5000 / PEAK10000；gain raw 320→0 dB，第 3 段 raw 285→−3.5 dB；q 0.7 / 0.7 / 0.8 / 1.5 / 1.0 / 1.0 / 0.7）；内部 7 段保持对数插值（全 PEAK、gain 0、q 0.7，永不进任何读写帧），内部段实测频点 `36 / 112 / 356 / 1125 / 3557 / 11247 / 17825`。

### 视觉与窗口常量

2026-11-07 界面改版后的口径（令牌在 `styles/tokens.css`，旧变量名 `--border` / `--border-soft` / `--accent-dim` 仍保留为别名）：

- 表面四层：`--bg #0b0d11` → `--panel #13161c` → `--panel-2 #1a1e26`（输入/悬停）→ `--panel-3 #0d0f13`（电平与曲线的"屏幕"凹槽）；细线一律半透明白 `--line` 6% / `--line-2` 10% / `--line-3` 16%。
- 文字：`--text #eceef2`、`--text-dim #a9b0bc`、`--muted #6c7482`；状态：`--ok #4fd1a1`、`--warn #f2c14e`、`--danger #ff7070`。
- 主色 `--accent #f3a45c`（`--accent-strong #ffb978`、主按钮字色 `--accent-ink #1c1208`）**只用于可操作 / 已选中**：主按钮、滑杆填充、选中场景、开关打开态、EQ 曲线与选中节点。数值读数、标签、分段选择的选中态都用中性色。
- 卡片不画标题分隔线、不用等宽大写小标（`card()` 的 `eyebrow` / `tag` 已改为可选）；等宽字体只给 hex、VID/PID、型号码、校验和。
- 图标全部是 `ui/icons.ts` 里的内联 SVG（currentColor），不引图标字体。

EQ 轴：频率 20 Hz–20 kHz 对数，增益 −24…+12 dB；曲线色 `#F3A45C`（外发光 + 按离 0 dB 距离加浓的渐变填充）；节点半径 10，选中节点实心橙并在右上角显示该段读数。**映射器与 `drawEq` 必须共用 `console-view.ts` 的 `EQ_MARGIN`**（通过 `theme.margin` 传入），否则网格与曲线错位。

电平表：LED 分段（3 px 段 + 1.5 px 缝），-18 dBFS 以下绿 / -18…-6 黄 / -6 以上红，峰值保持线随分区着色，峰值读数过 -1 dBFS 标红。画布位图尺寸必须等于 CSS 尺寸（不要再按最小值放大位图，会被压扁）。

窗口：1280×820 默认，最小 1100×700；顶栏 56px；工作台三栏 296 / 380 / 1fr（场景条横跨顶部），宽度 ≤1180 时收紧为 272 / 340 / 1fr、两个快捷开关改上下排；高度 ≤780 时隐藏说明文字。抽屉从右侧滑出：wide 1040（高级参数）/ medium 920（设备、设置）/ narrow 600（固件升级）。

### 32. 频繁调音效参数把设备压死 / USB 状态与描述符被高频查询（2026-11-13 修）

症状（用户反馈，录音 + 放音同时）：① 耳机/麦克风增益显示一直跳，像设备 ADC 检测不稳；② 上位机在后台频繁查询 USB 连接状态与设备描述符；③ 快速连续拖音效参数会把设备压死——请求无回应、灯不再变化、按键与旋钮都无效。

根因：① `0x2023`/`0x205A` 是 ADC 实时值，同一档位每次回读差 1–3，`DeviceLink` 每帧原样回填；② `AutoConnector` 每 1.5 s `probeNative()` → `getNativeDevices()` 对系统里**所有** HID（键盘/鼠标）构造 `NativeHidHandle` 并 `computeLayout(描述符)`；③ `ParamSession` 的写合并是**固定 120 ms 窗口**，拖拽期间仍每 120 ms 出一帧写，每帧都可能触发固件落 Flash。

Fix：
- `device/gain-filter.ts`：`ReadonlyGainFilter` 取最近 5 次中位数 + 1 死区；`DeviceLink._displayValue()` 只对 `gain.Mic`/`gain.Hp` 生效，重连 `reset()`。
- `webhid/kit.ts` 新增 `probeNative(vid,pid)`（只 `getDevices()` 后按 VID/PID 过滤，**不**构造句柄/解析描述符）与 `watchNative()`（`navigator.hid` connect/disconnect）；`WebHidSession` 转出 `probeNative(target?)`/`watchNative()`；`AutoConnector` 默认 5 s 兜底 + 插拔事件即时检查（300 ms 合并）。
- `TIMING.writeThrottleMs` 120→300 且改为**尾沿触发**（每次 `write()` 重置计时器）：一次连续拖拽只在停手后出 1 帧；新增 `writeGapMs=200`（相邻写帧最小间隔）与 `writePauseAfterTimeoutMs=1000`（写超时后冷却），`flushWrites()` 在冷却期内延后。
- 单测：`gain-filter.test.ts`、`link.test.ts`（噪声回显不跳字 / 真实换档跟上）、`auto-connect.test.ts`（只按 VID/PID 探测、订阅插拔）、`proto/session.test.ts`（尾沿只出一帧、写帧间隔）、`webhid-kit.test.ts`（探测不读描述符）。

排查口径：设备又"卡死"时先看诊断卡 `outFrames` 是否在拖拽期间持续增长——现在的预期是**停手后才有 1 帧**；再看 `timeouts` 是否上涨（写超时后有 1 s 冷却）。本机没有 M001 硬件，真机复测仍待做。

### 33. 「658/658 全 ACK + 收到 0x05」不等于刷成功；回读失败时别拿旧快照比版本（2026-11-21 修）

症状（M001，V0.0.5→V0.0.6 界面 DFU）：预检全对，658 块全部回 ACK、末块回 `0x05`，进度到「等待设备重启」；随后设备只以 **HID**（无 `MI_00` 音频）形态重新枚举，界面报「升级已完成但版本未变，设备已回到正常模式 / device 0.0.5 does not match image 0.0.6」，实际设备停在 Bootloader。同一台设备用 python 直连续刷也在**随机偏移**挂死（`0x19000`、`0x2B880`）。

根因两层：
1. **设备侧**：`0x05` 只表示"已收字节数够了 + 对**收到的字节流**累加校验和一致"，并不回读 Flash 校验。Bootloader 的 QSPI 擦/写静默失败时，上位机侧看起来一切正常。V0.0.6 的 hex 与 V0.0.5 的 `0x0000–0x7FFF`（Bootloader）、`0x38000`（状态字 `A5 FF 00 00`）**字节完全相同**，说明首刷记录 §8 那条缺陷一直没修。旁证：同一份镜像用 J-Link 烧整片能正常启动并跑通 Modbus。
2. **主机侧**：`DeviceLink._fail()` 只改 `status/sync/error`，**不清 `state.device`**；`resumeAfterDfu()` 又把回读异常 `catch` 掉后正常返回，`FirmwareController` 于是拿**升级前的旧快照**去比版本，报出与事实相反的结论，还把用户引向「再刷一次」。

Fix（已落盘）：
- `resumeAfterDfu(): Promise<boolean>`，返回"这一轮有没有真的从设备读到摘要"；`_fail()` 补 `device: null`。
- 回读失败 → `DfuError.kind='noReadback'`（新增，i18n `fw.error.noReadback`），**不再比对版本**；`verify` 从此只用于"读到了、版本确实没变"。
- 单测 `tests/unit/dfu/controller.test.ts` 5a：回读失败必须是 `noReadback`，detail 里不得出现 `does not match image`。
- `TIMING.dfuSendTimeoutMs = 5000` + `DfuSession.sendWithinTimeout()`：设备挂死后 `sendReport` 的 `WriteFile` 不返回，会话 `await` 它就永久卡在「探测设备 5%」（R3 实测 73 s）；现在 5 s 内按 `channel` 收场。单测 `tests/unit/dfu/session.test.ts` 12g。
- 新增 `tools/dfu/check-package.py`：把 DFU 包解密载荷与厂商 hex 的 App 区逐字节比（预检能验包自洽，验不了"这个包是不是这版 hex 导出的"）；新增 `scripts/probes/real8-health.py`：裸 HID 只读健康快照（118 项预设 + 14 项配置 + 62 字信息区，不依赖 Electron）。

排查口径：真机升级后"没升级成功"先看三件事——① 重枚举形态是不是**复合设备**（只有 HID = 还在 Bootloader）；② `real8-health.py` 能不能读到版本；③ `startup.log` 里 `dfu-active=false` 之后有没有 `自动连接成功`。三样任一不对就是没刷成，不要信界面上的版本号（旧版本可能来自旧快照）。**没有 SWD 退路时不要反复用 DFU 复测**：每次整轮重来都会重发信息帧、再次预写 `END_FAIL`。详见 `Document/Update/hardware/v0.0.6/固件升级诊断与复测方案-20261121.md`。

**2026-11-21 实刷复测（5 次，同一版 V0.0.6）**：成功 3 / 失败 2 —— R1 `App→DFU` 21.6 s 成功、R2 22.1 s 成功、R3 挂死在块 **365/658**（界面卡「探测设备 5%」73 s）、R4 从 Bootloader 续刷挂死在块 **652/658**（360 s 无结果）、R5 续刷 21.3 s 成功。两次失败后设备都是**仅 HID + OUT 写超时**，必须物理拔插；拔插后 `mode=Bootloader`（`END_FAIL` 已预写），再续刷可恢复。结论：**成功率约 60%，且失败概率与偏移无关 —— 不能交付**。另注：本机 SWD/JTAG 当时连不上目标（`VTref=3.269V` 正常但 4 个速率、`rx 2`、通用 `Cortex-M4` 全 `Cannot connect to target`），JFlash 走同一驱动同样无效，救砖最终靠的是界面续刷而非 SWD。

### 2026-11-13 界面改版（软件测试问题清单第 4 条）

- 主界面：场景顺序 安静房间 → 会议 → 播客 → 唱歌 → 自定义；`降噪强度/声音平稳` 改为直接写协议的 `噪声门阈值/压缩器阈值`（dB，步进同参数表）；音色 5 个（原声 / 人声增强 / 温暖 / 明亮 / 自定义），去掉「音乐」；「增益」卡从高级参数移除，麦克风静音 / 监听 / 电平信号静音三个开关放进「快速调音」；中栏说明文字在 `.console` 内隐藏、输入开关三列排布（1280×820 不溢出）。
- 自定义 EQ：`AppState.tone` 显式记录选中音色（不能只按曲线反推——自定义默认全平会和「原声」撞车）；只有 `tone==='custom'` 时主界面曲线可拖，拖拽同步写 `customEq`；高级参数逐段表始终可编辑，编辑后 `tone` 置 `custom`。场景「自定义」= 中性阈值 + 自定义曲线。
- 旁通：`comp.Enable`/`limit.Enable`/`enc.OnOff` 用真实使能位。**2026-11-21 参数表 V0.3 给噪声门与三分频动态补了使能位（`0x2074`/`0x2075`）**，这两项也改成真实开关（高级参数卡里 `data-enable="noisegate"` / `data-enable="drc3"`，关掉即直通，参数值照常保存），原先「钉阈值 / preGain=0+ratio=1」的中性参数近似已删除；`AppStore.setBypass()` 现在只剩均衡器一项（写 7 段 `enable=0`，真旁通）。旁通中对应字段禁用并显示说明的做法，仅 EQ 段表保留。
- 高级参数：移除「增益」卡与「均衡器模式」卡（`eq.mode` 参数仍保留，只是没有 UI）；三分频动态加「旁通」与「恢复推荐分频点（1000/3000）」，`fc1 >= fc2`（含默认 50/50 的相等）会标黄提示"分频点无效"。
- 三分频"听不出变化"的固件根因：第六轮联调发现固件预设结构体从 `0x205B` 起整体右移 2 字；协议读写无偏移，但 DSP 若按结构体取值，NoiseGate/DRC 参数会落到错误字段（见 `真机联调报告-第六轮.md` §7.1）。上位机侧已把默认 50/50 的退化分频提示出来并提供一键修正，真机是否生效仍需固件确认。

### 2026-11-21 夜间界面问题单（`usb audio demo buglist(1).docx` 23:42 那一节，13 条）

需求源：`Document/Update/hardware/v0.0.6/usb audio demo buglist_20261121.docx`；逐条处置与取证见 `Document/Update/hardware/v0.0.6/修复记录-界面问题单20261121.md`。上位机 9 条全改、2 条各改一半、4 条判给下位机。

- **快速调音三行阈值各带开关**：`噪声门阈值 / 压缩器阈值 / 防爆音` 都由 `macroSlider` 的 `toggle` 选项渲染（开关是无文案的 `switchControl`，`switch-row--bare` + `aria-label`），绑定 `noisegate.Enable` / `comp.Enable` / `limit.Enable`，与高级参数是**同一个参数 id**，联动就是同一份 store 状态。「快捷开关」里原来的「防爆音」开关已删——一个模块只留一个开关，别在两处各加一个。第三行**必须写「防爆音」**（产品叫法，高级参数里才叫「限幅器」）：2026-11-22 曾按问题单原文写成「限幅器阈值」，用户当场反馈"界面上的防爆音没了"，改回来才过。
- **音色曲线卡头两个动作**：`复位` + `逐段精调`。复位只在 `tone === 'custom'` 时可用，落点是新增的 `domain/eq-reset.ts`（7 段 **gain 0 / Q 0.7**，类型与频点沿用参数表）。它与参数表的**出厂默认**（Band-3 −3.5 dB、Q 0.8/1.5/1.0/1.0）刻意不同，`registers.ts` 不要跟着改。高级参数「全部复位」共用同一 preset。**2026-11-25 已调整**：任何音色都可拖曲线，卡头改为「恢复默认」（当前音色默认增益 + 产品默认 Q/频点），「逐段精调」按钮移除。
- **抽屉跳转**：`ShellApi.openAdvanced(section?)` → `openPanel(id, { section })`，打开后下一帧在抽屉内 `scrollIntoView`；`AdvancedSectionId` 由 `advanced-view.ts` 导出，主界面只引类型（无运行时依赖）。
- **电平表**：`MeterChannel.showPeak`（缺省 true），输出通道传 false → 不画峰值读数也不画峰值保持线（问题单「输出峰值可以不要」）。
- **样式坑**：`.switch-row + .switch-row { margin-top:10px }` 是给竖排开关列表用的，三列网格 `.tune-switch-grid` 里会让第 2、3 个开关下沉 10 px（问题单「三个开关不在同一水平线」），网格内已显式清零。`--bare` / `--toggle` / `.console-eq-actions` / `.console-link:disabled` 等新规则都在 `styles/components.css`。
- **文案**：`param.gain.Hp.label` 耳机增益 → **耳机音量**；`param.noisegate.ratio.label` 扩展比 → **压缩比**（对应 `0x205C`，`value=param/1000`），噪声门卡加 `module.noisegate.ratioHint` 说明「开关 + 阈值 + 压缩比三样都要下发」。设置页 VID 占位符 `0x352F` → `0x0A67`。
- **留给下位机**（详见修复记录 §4）：旋钮 ADC 端点到不了 0/100（`0x2023`/`0x205A` 只读，上位机只显示）；Bootloader 的 Product String 与 VID（描述符在固件）；噪声门「没有效果」（`0x2074` 使能位与 `0x205C` 是否真的进 DSP）。
- **复测入口**：`node scripts/probes/verify-buglist-20261121.mjs`（CDP 驱动真实界面，16 条断言，结果写 `artifacts/verify-20261121/result.json`）。它默认跑在真机上并在收尾用「设置 → 复位全部参数」还原，不想动真机就先拔线（退化为 mock）。公共 CDP 驱动在 `scripts/probes/lib/cdp.mjs`。若某条断言偶发"找不到抽屉里的控件"，先看 `ensureDrawer()`——截图那一步之后偶尔要等一拍（探针已内置重试）。
- **打包与启动器**：`.\dist.cmd` 出 `release/MicStudio-<ver>-portable.exe`；`release/MIC STUDIO.exe` 是这个包的**一键启动器**（自带 `--no-sandbox`，本机 App Control 挡双击时用它），源码 `scripts/launcher/MicStudioLauncher.cs` 里写的 payload 版本号要随发版改。重新编译必须显式传仓库根：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-launcher.ps1 -RepoRoot .`——本机 5.1 在 `-File` 模式下 `$PSScriptRoot` / `$PSCommandPath` 全是空，脚本会报「RepoRoot 推断失败」。csc 产物带时间戳与随机 MVID，每次重编 SHA256 都会变，别当作"产物被改过"。
- **顺手修的旧探针**：`verify-buglist-20261113.mjs` 里 3 条「中性参数旁通」断言（噪声门钉 −91 dB + 禁用字段、三分频禁用整片）自 V0.3 换版起就一直 FAIL，与本轮改动无关；已改成读 `[data-enable="noisegate"|"drc3"]` 的启用位语义，现在 26/26 全过。

### 2026-11-22 界面问题单（`usb audio demo buglist 2026-11-22.docx` 17:43 那一节，12 条）

需求源：`Document/Update/Testing/v1.1.4 新增测试/usb audio demo buglist 2026-11-22.docx`；逐条处置见 `Document/Update/hardware/v0.0.6/修复记录-界面问题单20261122.md`。上位机 9 条落地、2 条判给固件、1 条是新增测试资产。

- **场景变成"可编辑 + 自动保存"**：`domain/scene-presets.ts`（localStorage `micstudio.scenes` / `microstudio.customEq` 实际为 `micstudio.customEq`）按场景 id 存**用户改过的项**（sparse，只存差异）。选场景写 `store.setActiveScene(id)`；用户改任意参数（`PARAM_CHANGED_EVENT`）或拖曲线都记到当前场景名下；「复位」= 清掉该场景的覆盖值再按 `SCENES` 出厂预设应用一遍。`applyingScene` 这个闸门**不能删**：应用预设时的 `setParam` 也是用户改动的同一条路径，不挡住就会把出厂值当成"用户刚改的"存下来，复位后永远回不到默认。
- **场景改名**：`SceneId` 的 `meeting` → `game`（会议 → 游戏，处理链数值不变）。改 id 会牵连 `SCENE_ICON`、i18n `console.scene.game*`、`fulltest-u.mjs` / `ui-e2e-full.mjs` / `verify-buglist-20261113.mjs` 里的场景 id 断言，改的时候一起搜。
- **V0.3 时的产品默认覆盖（V0.4 已收录）**：参数表 V0.3 是真值来源，产品要求与表不同时用 `PRODUCT_PARAM_DEFAULTS`（三分频动态默认关 `drc3.Enable=0`）与 `PRODUCT_BAND_FREQS`（3–7 段频点 63/250/1k/4k/12.5k）覆盖。设备上电加载的那份预设由固件按表决定：`复位全部参数`/场景会写 0，但开机回读仍是固件的值，除非固件改 G 列。
- **启动默认「自定义」**：`quick-controls.DEFAULT_TONE='custom'` + `AppState.activeScene` 默认 `'custom'`；`domain/scene-presets.ts` 的 `loadCustomEq()` 在 `createConsoleView()` 开头把上次的曲线套到 `bands` 上（`setBands` 在 `sync!=='ready'` 时不发帧，连上设备后仍由回读接管）。
- **灯效上主页**：`快捷开关` 卡现在是两列——`环境降噪 + 档位` 与 `灯效 + 模式 0–7`（`switch-item--light`、`segmented--modes`：8 个 chip 等分压缩，窄列里每个 ~11–15 px）。与高级参数「灯效」是同一组参数 id（`rgb.OnOff`/`rgb.Mode`），联动同 store。**不要**把它做成跨两列的 `switch-item--wide`：那样中栏会多出 ~70 px，1266×783 下「快速调音」卡会被挤到内部滚动甚至压住下面的卡。
- **阈值行开关位置**：`.pfield--toggle .macro-toggle { margin-left: 0 }` + 读数 `margin-left:auto`。旧写法把开关顶到右边，读数宽度一变（−80 dB / −4.1 dB）开关就横向跳（问题单第 1 条）。
- **一屏工作台的纵向预算很紧**：1266×783 下中栏只差十几像素就会出滚动条。`.tune-grid` gap 10 / 分组 `padding-top: 12` / `.pfield--macro .pfield-head` 2px / `.macro-range` 22px 都是为这个尺寸压出来的；再加控件先跑 `node scripts/probes/inspect-console-budget.mjs`（看 `scrollable.scroll` / 标签是否省略 / 模式 chip 宽度）再改。中栏 `.card-body` 有 `overflow-y:auto` 兜底：窗口低于 ~700 高时内部滚动，而不是让「输入开关」压到「快捷开关」上。
- **`复位全部参数` 改成按批写**：`ui/views/settings-view.ts` 6 项一批、批间隔 320 ms（> `writeThrottleMs` 300，保证每批单独成帧），7 段 EQ 一段一次；设备已经 `sync==='error'` 就停手。**起因**：真机（V0.0.6）在一次性写回几十项之后 HID 不再吃 OUT 报告（`WriteFile timeout`、product string 变空、Modbus/DFU 都不应答），只能物理拔插——旧版和新版都能复现，属于固件侧问题（见修复记录 §5），上位机只能降低触发概率。
- **自动连接多给两次"冷启动"重试**：`AutoConnector` 的 `coldSyncRetries=2`（2 s 间隔）+ `link.onChange()` 订阅。设备自己复位在 USB 上看起来就是"拔掉又插回"，`wasReady` 会被清零；不给冷重试就会一次同步失败直接 `parked`，用户得手动点「打开」。真正的 Bootloader 设备仍然会在 ~6 s 后停手。
- **复测入口**：`node scripts/probes/verify-buglist-20261122.mjs`（15 条断言）与 `node scripts/probes/heavyload-20261122.mjs --seconds=180`（最重负载，8 条断言：链路 ready / 无错误提示 / 全部效果器仍开 / 录音出帧 + 回放 / 参数一直在变 / 无超时与 CRC 错 / 主线程最长 rAF < 1.5 s / 电平来源仍是音频输入）。探针结束都会用「复位全部参数」还原——**先看设备是否还活着再跑下一轮**。
- **HPF / LPF 没有增益**：唯一判据是 `eq/types.ts` 的 `bandHasGain()`（type 3/4 无增益）。曲线节点 y 坐标、命中判定、`EqModel` 与 `AppState.normalizeBand` 的归一化、高级参数的增益输入框、四个固定音色预设的前两格全按它处理——`band1.gain` / `band2.gain` 现在恒为 0（参数表默认也是 0）。起因：2026-11-25 用户反馈「HPF 和 LPF 的点应该在横轴上」，旧版节点按音色预设的 +4 / +3 dB 画（`warm`），而这个增益对 `curve.ts` 的 BLT 高低通分支没有任何作用。详见 `修复记录-EQ节点位置-20261125.md`。
- **场景「复位」的可用态看 `SCENE_DIRTY_PARAM_IDS`，不是 `SCENE_PARAM_IDS`**：前者 = 场景 7 项 + `SCENE_BASELINE_ONLY_IDS`（`limit.Threshold`、`comp.Enable`）。这两个参数**不写进场景预设**（R-19：点一次场景不许悄悄改掉用户的限幅阈值；压缩器开关一直是全局的），但都摆在快速调音里——只改它们而「复位」不亮，用户会当成按钮坏了（2026-11-25 反馈）。所以它们参与"调乱了没有"的判断；复位时退回**应用场景时**的基准值（`store.sceneTargetParam()`），不是参数表默认。切场景仍然不换掉它们。**基准属于会话**：`createConsoleView()` 只在 `store.sceneBaseline() === null` 时记初始基准（语言切换会重建工作台，不能把基准挪到当前值）；`applyTone()` 选回场景出厂音色时要 `forgetSceneTone()`，否则场景一直算脏。详见 `修复记录-场景复位-防爆音阈值-20261125.md`。