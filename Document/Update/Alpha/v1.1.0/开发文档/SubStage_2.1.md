# SubStage 2.1 — 虚拟下位机（参数侧）

> **所属 Stage**：Stage 2（虚拟下位机）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 1.1（帧格式与常量）、SubStage 1.2（寄存器表与标定）。两者已完成才可开工；若未完成，按本文件"§4 契约"里的字面值先实现，**不得**从 `src/**` 反向 import 渲染进程代码（见 §8）。
> **并行状态**：需等待 1.1/1.2；与 SubStage 3.1、4.1 **可并行**（无文件重叠）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

没有真机，就没有办法验收参数读写。需求 R7 要求自研一套虚拟下位机：与真机描述符逐字节一致的虚拟 HID 设备 + 跑在独立进程里的设备侧协议栈，用桥接（`third_party/web_hid_utils` 的 `virtual_hid`）把两者连起来。

本 SubStage 交付**参数侧**的可运行最小闭环：

1. `virtual_hid serve` 能照本仓 profile 起一台 `mic-m001`，report `0x11`/`0x51` 各 63 B（R7-1）；
2. 侧车订阅桥接的 `hid.outputReport`，按参数协议组帧，并用 `device.setInput` 注入回执（R7-2：一次 `0x12` 读端到端 5 ms 内响应）；
3. 寄存器文件覆盖预设区 114 项 + 设备信息区 + 设备配置区，支持 `0x10/0x11/0x12/0x13`，只读写回 `0x0004`、越界写回 `0x0005`；
4. 一条命令拉起桥 + 侧车（R10-3 的前半），退出时清理子进程；
5. 控制面 HTTP 让测试与人工都能改寄存器、读统计（R7-5/R7-4 的地基）。

DFU 侧、故障注入、电平发生器在 SubStage 2.2。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/` | 不存在（仓库根既无 `tools/` 也无 `vdevice/`） |
| `third_party/web_hid_utils/packages/virtual-hid` | 子模块，**只读**；`python -m virtual_hid serve --config <json> --port 8765` |
| 桥接事实（已实测，见设计文档 §5.14 与问题清单 §3.4） | `hid.outputReport` **无条件广播**（与 `loopback` 无关）；`hid.inputReport` 只推给已 `hid.open` 的会话；`device.setInput` 不要求 open；HTTP `/api/devices` 只支持 GET |
| profile 已验证 | 本任务书 §4.1 给出的 profile 已被 `python -m virtual_hid list` 正确解析为 input `0x10`(15B)/`0x11`(63B)、output `0x50`(15B)/`0x51`(63B) |

Python 与 node 的绝对路径（PATH 里都没有）：

```
PY   = C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
NODE = C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
```

---

## 3. 本 SubStage 产出文件

```
tools/vdevice/profiles/mic-m001.json     新建（无 BOM 的 UTF-8）
tools/vdevice/device-stack.mjs           新建（寄存器文件 + 参数协议应答，纯逻辑）
tools/vdevice/device-stack.d.mts         新建（TS 类型声明，供 vitest 用例 import 时通过 typecheck）
tools/vdevice/sidecar.mjs                新建（WS 客户端 + 控制面 HTTP + 接线）
tools/vdevice/sidecar.d.mts              新建
tools/vdevice/run.mjs                    新建（唯一入口：起桥 + 起侧车 + 清理）
tools/vdevice/README.md                  仅当确有操作步骤需要写时创建（≤ 40 行，只写命令与端口）
tests/unit/vdevice/device-stack.test.ts  新建
```

不创建 `tools/vdevice/faults.mjs`、`level.mjs`、`dfu-stack.mjs`、`package.mjs`（留给 2.2；本 SubStage 只留接线点与常量 0 电平）。

---

## 4. 完整契约

### 4.1 `tools/vdevice/profiles/mic-m001.json`（内容逐字节照抄）

```json
{
  "server": { "host": "127.0.0.1", "port": 8765 },
  "devices": [
    {
      "id": "mic-m001",
      "description": "MIC M001 vendor HID channel (Usage Page 0xFF01 / Usage 0x01).",
      "vendorId": 2663,
      "productId": 16,
      "productName": "Virtual MIC M001",
      "serialNumber": "VHID-MIC-M001",
      "reportDescriptor": "06 01 FF 09 01 A1 01 A1 02 15 80 25 7F 75 08 85 10 95 0F 09 44 81 22 85 11 95 3F 09 45 81 22 85 50 95 0F 09 54 91 22 85 51 95 3F 09 55 91 22 C0 C0",
      "loopback": "none",
      "initInput": [{ "reportId": 17, "data": "00" }, { "reportId": 16, "data": "00" }]
    }
  ]
}
```

硬约束：

- **文件必须无 BOM**（实测带 BOM 会被桥报 `Unexpected UTF-8 BOM`）。PowerShell 里写文件用 `[System.IO.File]::WriteAllText(path, text, (New-Object System.Text.UTF8Encoding($false)))`。
- `loopback` 必须是 `"none"`（需求 D.1：开着会让主机自己的帧回到自己接收路径，制造"设备已回答"的假象）。
- 描述符是 49 字节，与 `Document/Protocol/Bootloader/source/driver/usb/uac10/drv_uac10_lib.c` 的 `USB_HID_COL_USER_TRANS_EN` 段**逐字节一致**（已核对，见设计文档 §5.14.1）。

### 4.2 `tools/vdevice/device-stack.mjs`

纯逻辑设备侧协议栈（不碰 WS/HTTP/文件系统），**独立实现**参数协议解码（与 `src/renderer/src/device/proto/**` 互为对拍，不允许 import 渲染进程代码）。

```js
export const MODE_APP = 'app';
export const MODE_BOOTLOADER = 'bootloader';
export const REPORT_ID_IN = 0x11;      // 63 B
export const PAYLOAD_BYTES = 63;
export const MAX_FRAME_BYTES = 512;

export function crc16(bytes)                       // Modbus CRC-16，与上位机同算法
export function buildFrame(func, data)             // → Uint8Array（含 UnitID/Len/CRC）
export function splitReports(bytes)                // → Uint8Array[]（每包 63 B，右侧补 0x00）

/** 预设区默认寄存器（114 项）+ 设备信息 + 设备配置的默认原始值 */
export function defaultRegisters()                 // → Map<number, number>

export class ParamStack {
  /**
   * @param {object} opts
   * @param {Map<number, number>} [opts.registers]   缺省用 defaultRegisters()
   * @param {{modelCode?: string, deviceName?: string, firmware?: {x:number,y:number,z:number,build:number,
   *          type:number}, vid?: number, pid?: number, serial?: string}} [opts.info]
   * @param {object} [opts.timers]                   { setTimeout, clearTimeout }，注入以便单测
   * @param {() => number} [opts.now]                毫秒时钟，缺省 Date.now
   * @param {(reports: Uint8Array[]) => void} opts.onReplies   出站回调（可能被延迟调用）
   * @param {object} [opts.hooks]                    预留：2.2 的 faults/level 通过它接入
   */
  constructor(opts)

  /** 入站一条 63 B 报告（不含 report ID）；可能同步或异步产生出站报告 */
  feed(payload)
  /** 当前模式 */
  get mode()
  /** 强制切模式（控制面用；切换时清空累积器） */
  setMode(mode)
  /** 读/写寄存器原始值（控制面用，绕过只读/范围校验） */
  readRegister(addr)
  writeRegister(addr, raw)
  /** 寄存器快照（`{ "0x2024": 1, ... }`） */
  snapshot()
  /** 设备信息快照 */
  info()
  /** 统计：{ framesIn, framesOut, byFunc: { "16": n, ... }, unknownFunc, rejectedReadOnly, rejectedRange } */
  stats()
  /** 设备收到过一次"写 0x1008=1" 后置真（2.2 的模式切换用） */
  dfuRequested()
  /** 清空累积器与半帧状态 */
  reset()
}
```

行为契约（逐条可测）：

| # | 场景 | 必须的行为 |
|---|---|---|
| P1 | 入站报告累积不足一帧 | 不出任何回执；半帧保留到下次 |
| P2 | 一帧跨多条报告 | 收齐后一次性应答 |
| P3 | 一条报告里含两帧（帧粘连） | 两条回执分别发出，顺序与入站一致 |
| P4 | `0x12` 随机读 | 每条地址 `(Addr,Val)` 4 B 大端，func 回 `0x12`；地址不存在 → 回 `0x02` ACK `0x0001`（地址错） |
| P5 | `0x13` 连续读 | `首址 + 数目 + 数据（2B×N 大端）`，func 回 `0x13`；越界（`首址+N > 0x2071` 且不在设备信息/配置区）→ ACK `0x0001` |
| P6 | `0x10` 随机写 / `0x11` 连续写 | 逐项校验：只读 → 回 `0x02` ACK `0x0004`（**整帧不落地**）；超范围 → ACK `0x0005`（整帧不落地）；地址不存在 → ACK `0x0001`；全部合法 → 落地并回 ACK `0x0000` |
| P7 | `len % 4 != 0`（`0x10`）/ `N*2+4 != len`（`0x11`）/ 未知 func | 回 ACK `0x0002`（长度错） |
| P8 | UnitID ≠ `0x00` | 回 ACK `0x0001` |
| P9 | CRC 错 | 不回任何回执（真实设备回 `0x0003`，但为避免把"错帧"当成有效触发，这里也回 `0x02 ACK 0x0003`；**实现时回 ACK 0x0003**，与协议一致） |
| P10 | 写入 `0x1008 = 1` | 先回 ACK `0x0000`，再置 `dfuRequested=true`（模式切换留给 2.2 的 hooks） |
| P11 | 写 `0x2057`（电平） | 忽略写入但回 ACK `0x0000`（`kind:'live'` 寄存器） |
| P12 | 写保留项 `0x2052`/`0x2056` | 回 ACK `0x0004`（视为只读） |

### 4.3 `tools/vdevice/sidecar.mjs`

```
用法：node tools/vdevice/sidecar.mjs --bridge ws://127.0.0.1:8765/ws --device mic-m001 --control-port 8766 [--level 0]
环境变量：MICSTUDIO_VDEVICE_LOG=1 时把每条入站/出站帧打到 stdout
```

职责：

1. 用 Node 内建 `WebSocket`（Node 24 自带，零依赖）连 `--bridge`；
2. 收 `hid.outputReport` 且 `params.deviceId === --device` → base64 解码 → 交给 `ParamStack.feed()`；
3. `onReplies(reports)` → 每条用一个 `device.setInput` 请求发出（`{ deviceId, reportId: 17, data: base64 }`），串行、失败重试 1 次；连接断开时打印一行并把退出码置 1；
4. 控制面 HTTP 服务（`--control-port`，仅 `127.0.0.1`）：
   - `GET /control/stats` → `{ mode, framesIn, framesOut, byFunc, unknownFunc, rejectedReadOnly, rejectedRange, dfuRequested, levelRaw, firmwareVersion }`
   - `POST /control/registers` body `{ values: { "0x2024": 1 } }` → 写入并回 `{ ok: true }`
   - `POST /control/reset` → 重建默认寄存器、清累积器、回 `{ ok: true }`
   - `GET /control/log` → 最近 200 条 `{ at, dir, hex }`
   - 其它路径 `404`，方法不符 `405`；
5. 收到 `SIGINT`/`SIGTERM` 时：关 HTTP、关 WS、`process.exit(0)`。**不得**留下未清理的定时器（R7-5）。

侧车启动后必须打印一行就绪标志（供 `run.mjs` 等待）：`[vdevice] sidecar ready device=mic-m001 bridge=ws://127.0.0.1:8765/ws control=http://127.0.0.1:8766`。

### 4.4 `tools/vdevice/run.mjs`

```
用法：node tools/vdevice/run.mjs [--port 8765] [--control-port 8766] [--bridge-url <ws-url>]
```

职责：

1. 解析参数；`PYTHONPATH` 置为 `<repo>/third_party/web_hid_utils/packages/virtual-hid`（用 `path.resolve` 拼绝对路径，不依赖 cwd）；
2. `spawn` Python 桥：`<PY> -m virtual_hid serve --config tools/vdevice/profiles/mic-m001.json --port <port>`，`stdio: 'inherit'`；
3. 轮询 `GET http://127.0.0.1:<port>/healthz` 直到 200（超时 10 s，500 ms 间隔），失败则杀子进程并 `exit(1)`；
4. `spawn` 侧车（同一 NODE 二进制），`stdio: 'inherit'`；
5. 收到 `SIGINT`/`SIGTERM`/`exit`：先杀侧车再杀桥（`taskkill /pid <pid> /T /F` 在 Windows 上更稳，实现时可先用 `child.kill()`，失败再 `taskkill`），最后 `process.exit(0)`；
6. 打印三行：`[vdevice] bridge  http://127.0.0.1:8765`、`[vdevice] ws      ws://127.0.0.1:8765/ws`、`[vdevice] control http://127.0.0.1:8766`。

### 4.5 类型声明（`*.d.mts`）

每个 `.mjs` 旁边必须有一个同名 `.d.mts`，导出与实现一致的签名（供 `tests/unit/**` 从 `.ts` 里 `import` 时通过 `tsc --noEmit`）。声明里不要写 `any`（除了 `timers` 这类确实结构化的对象），不要 `export =`。

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| 桥没起就启动侧车 | 侧车重连：500 ms 间隔，最多 20 次；仍失败则打印 `[vdevice] bridge unreachable` 并 `exit(1)` |
| 侧车收到的报告 `reportId !== 81`（`hid.outputReport` 携带的是 **OUT 报告号 0x51 = 81**，不是 IN 的 17） | 忽略并计数（`stats().ignoredReports`） |
| 收到的 `data` 长度 ≠ 63 | 右侧补 `0x00` 到 63（与桥接"短包容忍"一致），补不出则丢弃并计数 |
| 回执发送失败（WS 错误） | 重试 1 次；再失败打印错误并按 1 s 后重连处理 |
| 控制面端口被占用 | 打印明确错误（含端口号）并 `exit(1)`；**不得**静默忽略 |
| 收到未知 func | 回 ACK `0x0002`（P7） |
| 单帧超过 512 B | 丢弃该帧前半并回 ACK `0x0002`，随后清空累积器 |

---

## 6. 测试要求

```powershell
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node $pnpm run test
& $node $pnpm run typecheck
```

`tests/unit/vdevice/device-stack.test.ts`（vitest，happy-dom 环境不影响纯逻辑）必须包含：

1. **黄金回执**（用需求附录 A.7 的请求帧，逐字节断言设备侧回执）：
   - 写 `0x2024=1` → `00 02 00 08 00 00 F8 19`
   - 读 `0x205B`/`0x205C`（`00 12 00 0A 20 5B 20 5C 89 E1`）→ `00 12 00 0E 20 5B 00 00 20 5C 00 32 D5 C0`（默认寄存器 `0x205B=0`、`0x205C=50`）
   - 连续读 `0x2000` 起 2 个 → `00 13 00 0E 20 00 00 02 00 00 00 01 C9 FE`
   - 读电平 `0x2057`（`00 12 00 08 20 57 61 E4`）→ func `0x12`、值 `0`
2. 写只读 `0x2023=1` → ACK `0x0004`（`00 02 00 08 00 04 F9 DA`），且寄存器未被改动。
3. 写超范围 `0x2024=2` → ACK `0x0005`，且寄存器未被改动。
4. 只读/超范围同批写入时**整帧不落地**：`0x10` 写 `[{0x2024,1},{0x2023,1}]` → ACK `0x0004` 且 `0x2024` 仍为 0。
5. 长度错：`0x10` 的 data 长度 3 → ACK `0x0002`；`0x11` 的 `N*2+4 ≠ len` → ACK `0x0002`。
6. 未知 func（如 `0x7E`）→ ACK `0x0002`。
7. CRC 错（把帧末字节翻转）→ ACK `0x0003`。
8. UnitID 非 0 → ACK `0x0001`。
9. 一帧拆成 2 条 63 B 报告喂入（用 `splitReports` 切）→ 与一次喂入产生相同回执。
10. 一条报告含两帧 → 两条回执，顺序一致。
11. `0x1008=1` → ACK `0x0000` 且 `dfuRequested() === true`。
12. `defaultRegisters()` 长度 190、`0x2024=0`、`0x2025=0`、`0x205B=0`、`0x205C=50`、`0x2001=1`、`0x2023=100`、`0x205A=100`。
13. `buildFrame`/`crc16` 与需求附录 A.6 的 8 条向量一致（设备侧独立实现也必须对）。

**端到端冒烟（必须在完成报告里贴输出，不写成 vitest 用例）**：

```powershell
# 终端 1（或后台作业）
$env:PYTHONPATH='D:\WorkShop\MicroPhone_WebHIDInterface\third_party\web_hid_utils\packages\virtual-hid'
& $node tools/vdevice/run.mjs

# 终端 2
curl.exe -s http://127.0.0.1:8765/api/devices        # 必须看到 mic-m001，layout 里 input 17/output 81 的 byteLength 均为 63
curl.exe -s http://127.0.0.1:8766/control/stats      # 必须返回 mode=app
```

再用 `python -m virtual_hid send`（或 `curl POST /api/devices/mic-m001/input` 的逆操作不可用，改用 WS 客户端脚本）验证"回环无害"：**不做回环测试**，只验证"侧车收到 output 事件后注入 input 报告"需要界面侧配合（留给 SubStage 3.2/5.3 的端到端）。本 SubStage 的端到端证据用一条 `tools/vdevice/` 下临时脚本（不入库）或 `curl` + WS 调试脚本完成，输出贴进报告。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| C1 | `node tools/vdevice/run.mjs` 一条命令拉起桥 + 侧车，Ctrl+C 后两进程都不残留 | 命令输出 + `Get-Process python,node` |
| C2 | `GET /api/devices` 返回 `mic-m001`，input `0x11` 与 output `0x51` 的 `byteLength` 都是 63（R7-1） | curl 输出 |
| C3 | 一次 `0x12` 读的端到端往返 < 5 ms（R7-2） | 侧车 `GET /control/stats` 里的 `lastRoundTripMs`（**本任务书新增要求**：侧车在 `stats()` 里记录最近一次"入站帧到回执发出"的毫秒数） |
| C4 | 12 条设备侧单测全绿，黄金回执逐字节一致 | `pnpm run test` 输出 |
| C5 | `pnpm run typecheck` 全绿（含 `.d.mts` 被正确解析） | 命令输出 |
| C6 | profile 无 BOM、`loopback: "none"`、描述符 49 字节 | 十六进制取证（`Format-Hex` 前 3 字节） |
| C7 | 子模块未改动（`git status --porcelain third_party` 为空） | git 输出 |

---

## 8. 禁止事项

1. **不得修改 `third_party/web_hid_utils` 任何文件**，包括 profile 与测试。
2. 不得从 `tools/vdevice/**` import `src/**`（渲染进程 TS）；设备侧必须独立实现协议，形成双向对拍。
3. 不得引入任何第三方依赖（Node 只用内建 `http`/`fs`/`path`/`worker` 以外的 `WebSocket` 全局对象）。
4. 不得用 `loopback: "output-to-input"`；不得让侧车依赖回环。
5. 不得用同步 `sleep`/忙等等待；所有延迟走 `timers`。
6. 不得把控制面绑到 `0.0.0.0`（只允许 `127.0.0.1`）。
7. 不得在 `.mjs` 里写 TypeScript 语法；不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. 端到端冒烟：`run.mjs` 启动日志、`/api/devices` 输出、`/control/stats` 输出（含 `lastRoundTripMs`）。
4. C1–C7 逐条结论与取证位置。
5. 与设计文档的偏差（无则写"无偏差"）。
6. 留给 SubStage 2.2 的接线点清单（`hooks` 字段实际形状、侧车在何处插 faults/level/dfu）。
