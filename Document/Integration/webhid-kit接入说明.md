# webhid-kit 接入说明

记录把 [web_hid_utils](https://github.com/LeventureQys/web_hid_utils) 作为 git submodule 引入 `MicroPhone_WebHIDInterface`，并接成「设备」页组件的过程、契约与边界。

- 接入日期：2026-10-18
- 上游锁定：`67d8680`（`feat: initial WebHID debug toolkit`，与上游 `origin/main` 同一提交）
- 实测环境：Windows / Electron 33.4.11 / Node 24.21.0 / CPython 3.12

---

## 1. 子模块

| 项 | 值 |
|---|---|
| 路径 | `third_party/web_hid_utils` |
| 远端 | `https://github.com/LeventureQys/web_hid_utils.git` |
| 记录 | `.gitmodules` + 索引里的 gitlink（commit `67d8680`） |
| 用法 | **只读引用**，本仓不改上游任何文件 |

上游仓库同时包含三样东西，本仓只用第一样：

- `packages/webhid-kit`：浏览器侧 WebHID 套件（原生 ESM，零依赖，无构建步骤）
- `packages/virtual-hid`：Python 虚拟 HID 设备 + 桥接服务（联调用）
- `packages/demo`、`docs/*`：调试控制台与协议文档

> 拉取受阻时的处理见 `AGENTS.md` 已知坑 16（本机 GitHub pack 传输会被重置，只能用本地仓库或镜像建子模块）。

---

## 2. 构建接线

上游是裸 ESM、没有 `package.json`，因此不做 workspace 链接，走别名 + 本地类型声明：

| 位置 | 内容 |
|---|---|
| `electron.vite.config.ts` | renderer `resolve.alias['@webhid-kit'] → third_party/web_hid_utils/packages/webhid-kit/src/index.js` |
| `vitest.config.ts` | 同一个别名（单测跑真实套件代码，不 mock） |
| `src/renderer/src/types/webhid-kit.d.ts` | `declare module '@webhid-kit'`：本仓用到的导出面 |
| `src/renderer/index.html` | CSP `connect-src` 放通 `ws://127.0.0.1:*` / `ws://localhost:*`（见已知坑 15） |

三者必须同步：别名改了而 `.d.ts` 没改会 `TS2307`，`.d.ts` 与上游行为不一致会由 `tests/unit/webhid-kit.test.ts` 报红。

---

## 3. 代码结构

```
src/renderer/src/
├── device/webhid/
│   ├── types.ts        WebHidKit / WebHidDeviceHandle / 会话状态类型（不 import 子模块）
│   ├── session.ts      WebHidSession：可观察的状态机，套件经构造参数注入
│   ├── kit.ts          唯一 import '@webhid-kit' 的适配层
│   └── index.ts        组件入口 createWebHidSession()
├── ui/views/device-view.ts   设备页 DOM 组件（只画状态）
└── types/webhid-kit.d.ts     上游类型声明
```

依赖方向单向：`device-view → webhid/index → session → types`，只有 `kit → @webhid-kit` 一步出仓。业务代码（`AppStore` / `Transport` / 各参数页）不感知子模块存在。

`WebHidSession` 只依赖 `WebHidKit` 接口，所以单测用 `FakeKit` + `FakeHidDevice`（`tests/unit/helpers/webhid-fakes.ts`）跑，不碰 WebSocket 与 `navigator.hid`。

---

## 4. 组件契约

### 4.1 状态

```
idle ──connect(virtual|native)──▶ connecting ──▶ ready
  ▲                                    │           │
  └────────── disconnect ◀─────────────┴──▶ error ◀─┘（失败只置 error，不抛给调用方）
```

`getState()` 返回冻结快照：`{ status, mode, bridgeUrl, error, errorCode, devices[], lastReport }`。

- 高频输入报告走独立事件 `report`（`onReport`），不进 `change`，视图按 66 ms 节流重绘。
- 失败分类 `errorCode`：`nativeUnavailable | bridge | device | noSelection | unknown`，文案键 `device.error.<code>`，原始 message 单独展示。

### 4.2 方法

| 方法 | 说明 |
|---|---|
| `connect(mode)` | `virtual`：`installVirtualHid({url})` + `getAllDevices()`；`native`：`getNativeDevices()` |
| `disconnect()` | 关掉已打开设备、`restore()` 还原 `navigator.hid`、状态回 idle |
| `refresh()` | 重新枚举当前通道（插拔后不必重连） |
| `requestNativeDevice()` | 真机通道唤起选择器；Electron 主进程当前直接取消，返回空 |
| `openDevice(id)` / `closeDevice(id)` | 开/关单台设备，挂/摘 `inputreport` 监听 |
| `setBridgeUrl(url)` | 只在下次 `connect('virtual')` 生效 |
| `dispose()` | 视图销毁时清理（连接由 `main.ts` 持有，切路由不断线） |

报告样本：`{ deviceId, reportId, hex, values, at }`；`values` 来自套件 `decode('input', id, bytes)`，字段键为 `<usagePage>:<usage>`（十进制）。

---

## 5. 联调与验收

### 5.1 起虚拟设备（后台常驻）

```powershell
$python = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$env:PYTHONPATH = 'D:\WorkShop\MicroPhone_WebHIDInterface\third_party\web_hid_utils\packages\virtual-hid'
& $python -m virtual_hid serve `
    --config 'third_party\web_hid_utils\packages\virtual-hid\profiles\dev-kit.json' --port 8765
```

四个设备：keyboard / mouse / gamepad / echo（echo 是 `output → input` 回环，用来验证双向）。

### 5.2 取真实链路证据

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\WorkShop\MicroPhone_WebHIDInterface\.userdata'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& node_modules\electron\dist\electron.exe . `
    --screenshot=artifacts\shot-device-live.png --route=device `
    --exec-file=scripts\probes\device-connect.js --no-sandbox
```

`scripts/probes/device-connect.js` 在渲染进程里点「连接」→ 打开全部设备 → 通过 `navigator.hid`（此时是套件装的替身）给 echo 发一条 `AB CD` 的 output 报告 → 读回解码结果。

实测（2026-10-18）：

```
[probe] {"rows":4,"status":"Ready","sent":"AB CD","hex":"AB CD",
         "fields":["65280:2 171","65280:3 205"]}
[screenshot] artifacts\shot-device-live.png 98734
```

即：桥接 4 台设备全部列出并打开；`output AB CD` 经 Python 侧回环成为 `input AB CD`；字段 `65280:2=171`、`65280:3=205` 解码正确。截图见 `artifacts/shot-device-live.png`。

### 5.3 自动化测试

| 用例 | 覆盖 |
|---|---|
| `tests/unit/webhid-kit.test.ts` | 别名解析到真实子模块：版本/桥协议常量、描述符解析、位布局、编解码、无 `navigator.hid` 时 `nativeAvailable()` 为 false |
| `tests/unit/webhid-session.test.ts` | 状态机全路径：连接、失败分类、枚举、开关设备、报告解码与节流、回环、幂等与清理 |
| `tests/unit/device-view.test.ts` | 设备页 DOM：空态、设备行、打开徽标、报告渲染、错误文案、`destroy()` 退订 |

```powershell
& $node $pnpm run typecheck && & $node $pnpm run test
# 实测：tsc 通过；14 个测试文件 / 104 个用例全绿
```

---

## 6. 边界与未验证项

1. **不做参数 ↔ 字节映射**：设备真实报告描述符还没拿到，`device/webhid-transport.ts` 仍是 Alpha 桩，设备页只做发现/开关/解码，不冒充能写参数。
2. **真机通道未联调**：`src/main/webhid.ts` 的 `select-hid-device` 仍按 Alpha 策略直接取消，`requestNativeDevice()` 必然拿到空数组（界面显示 `device.error.noSelection`）。本机无真机，`NativeHidHandle` 路径只有上游离线单测背书。
3. **桥接地址写死在 CSP 白名单内**：设备页允许改端口，但只能指向 `127.0.0.1` / `localhost`。
4. **`forget()` 语义**：上游只撤销本会话授权，不是操作系统级撤销。
5. **打包产物未复验**：`out/renderer` 已确认把套件打进 bundle（`webhid-bridge.v1` 字符串在产物里），但 `release/win-unpacked` 尚未重新打包验证。

---

## 7. 升级与回退

```powershell
$git = 'C:\Program Files\Git\cmd\git.exe'
& $git -C third_party/web_hid_utils fetch origin
& $git -C third_party/web_hid_utils checkout <new-commit>
& $git -C . add third_party/web_hid_utils

& $node $pnpm run typecheck   # 上游改导出 → .d.ts 先报
& $node $pnpm run test        # 上游改语义 → webhid-kit.test.ts 报
```

回退到上一个提交：`git -C third_party/web_hid_utils checkout <old>` 后重新 `git add third_party/web_hid_utils`。

上游 API 若大改（例如 `getAllDevices` 改名），只需改 `device/webhid/kit.ts` 一处；`session` / 视图 / 测试均不受影响——这是把套件隔在 `WebHidKit` 契约后面的原因。
