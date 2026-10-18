# RT1621 DFU 固件升级调研

> 状态：调研稿（2026-10-18）。**结论定性**：公开渠道查不到 RT1621 这颗芯片的任何 DFU / 数据手册资料，所以本文交付的是「怎么确认它走哪种 DFU」+「通用实现骨架」+「在本工程怎么落地」。第 3、4 节的报文表是占位，拿到原厂文档或抓包结果后填。

---

## 0. 一句话结论

DFU（Device Firmware Upgrade）无论哪颗芯片，骨架都是六步：

**进 bootloader → 查能力 → 擦除 → 分块写入 → 整片校验 → 切换启动并复位**

芯片之间的差异只集中在两处：

1. **传输载体**：标准 USB DFU 类（class `0xFE`）？自定义 HID 报告？还是私有驱动？
2. **镜像格式**：裸 `.bin`，还是带 magic / 版本 / 长度 / CRC / 硬件 ID 的包头格式？

这两点决定实现方式，**不能靠猜**。猜错的代价是把设备刷成砖。

---

## 1. 前提：先确认 RT1621 到底走哪种 DFU

### 1.1 检索结论

| 检索范围 | 结果 |
|---|---|
| `RT1621` / `RT 1621` / `RTL1621` + datasheet / DFU / 固件 / 升级工具 | 0 条芯片相关结果（命中的是同型号螺丝刀、刹车盘、EuroVoc 术语表等无关内容） |
| 本机所有工程全文检索 `rt1621`（含本仓、`AudioProcesser`、`third_party/web_hid_utils`） | 0 命中 |
| 本仓 `Document/` | 只有 `效果器参数范围.xlsx`，无固件升级相关文档 |

说明这颗芯片不在公开资料覆盖范围内（大概率是小批量国产 USB Audio SoC，或方案商改过丝印/型号）。**因此不要按「标准 USB DFU」直接开工。**

### 1.2 识别步骤（半天到一天能做完）

1. **应用态描述符**：先把设备插上，看 VID/PID 与接口分布。
   - 本工程设备页已能列出 `vendorId / productId / productName`（`navigator.hid.getDevices()`）；
   - 想看完整 descriptor（interface class / subclass / protocol / 端点），用 UsbTreeView（Windows 免装）或 `pnputil /enum-devices /class HIDClass /connected`。
2. **进 bootloader 后再看一次**：VID/PID 是否变化（常见 app `0x1234:0x0001` → boot `0x1234:0x0002`），是否新出现一个 HID 接口（usagePage 通常 ≥ `0xFF00`，即 vendor-defined）。
3. **抓一次原厂升级工具的包**：USBPcap + Wireshark，过滤 `usb.idVendor == 0x???? && usb.idProduct == 0x????`。
   - 走 EP0 的 class 请求（`0x21`/`0xA1` + bRequest 0..6）→ 标准 DFU 类；
   - 看到 `SET_REPORT` / `GET_REPORT` 成对出现、每帧 64 字节 → HID 自定义 DFU。
4. **反查工具本体**：`strings`（找命令码、`CRC32`、`.bin`/`.fw` 字样）、dnSpy（.NET 工具）、IDA（native 工具）。这条路常常比找原厂要文档更快，能直接读出命令表、CRC 算法与镜像头结构。

### 1.3 判定表

| 抓到的现象 | 判定 | 上位机可用通道 |
|---|---|---|
| interface class `0xFE` + subclass `0x01` + protocol `0x02` | 标准 USB DFU 1.1 | **WebHID 做不到**（要 class 控制传输）→ WebUSB 或内置 `dfu-util` |
| vendor HID 接口 + `SET_REPORT`/`GET_REPORT` | HID 自定义 DFU | **WebHID 直接可用**，本工程最省事 |
| 必须装厂商 `.sys` / 私有驱动 | 私有协议 | GUI 只能调厂商 CLI/工具，或主进程自带 Node USB 栈 |
| 只有 UAC 音频接口，无独立 vendor 接口 | 走 UAC 扩展单元或根本没有 DFU 通道 | 只能依赖厂商工具 |

---

## 2. 通用骨架：六个阶段与失败后果

| 阶段 | 主机做什么 | 设备做什么 | 这一步失败的后果 |
|---|---|---|---|
| 1 进入 | 发 magic/命令，或按键/重插让设备重新枚举 | 关音频流、跳 bootloader、换 PID | 无（可无限重试） |
| 2 查能力 | 读 boot 版本、芯片 ID、flash 容量、单包上限 | 返回能力集 | 无 |
| 3 擦除 | `erase(sector range)` | 擦 flash | **擦完断电 = 变砖窗口打开** |
| 4 写入 | 分块下发，逐块等 ACK | 写 flash，回执 | 可重传，但已擦区域无旧固件 |
| 5 校验 | 读回设备侧 CRC，与主机侧比对 | 计算整片 CRC/SHA | **禁止跳过**：不比对就等于没写成功 |
| 6 激活 | `commit` / 切 slot，然后复位 | 置启动标志、重启进新固件 | 有 A/B 时旧固件仍在；无 A/B 则同样危险 |

三条硬规则：

1. **顺序必须是「擦 → 写 → 校验 → 最后 commit」**。有 A/B 或 golden image 的芯片，把切换放到最后一步，能把变砖窗口压到最小。
2. **擦除动辄几百 ms 到数秒**，必须按设备返回的 busy 位/轮询值等待，不能写死固定延时。
3. **每条命令都要有超时 + 重试 + 幂等**。USB 掉包、HID 报告被丢弃都会发生（Windows 的 HID 栈没有重传保证）。

---

## 3. 情况 A：HID 自定义 DFU（本工程默认假设）

这是 USB Audio 类设备最常见的做法（XMOS 的 AN02019 就是专门讲「USB Audio 里怎么用 HID 做 DFU」，原因正是音频设备不便另装 WinUSB 驱动）。优点是 Windows 自带 HID 驱动，浏览器/Electron 用 WebHID 就能直接发报告。

### 3.1 需要摸清的帧布局

典型形态（占位，等原厂文档替换）：

```
feature report，长度 = 报告描述符声明值（多数实现是 64 字节）
byte 0        命令码
byte 1        序号 seq（可选，用于丢帧检测/重传）
byte 2..3     载荷长度（小端）
byte 4..N     载荷
末尾          可选 CRC16 / 命令参数
```

命令集通常只需 6~8 条，可按此模板对接：

| 命令 | 方向 | 载荷 | 设备回执 | 常见超时 |
|---|---|---|---|---|
| ENTER_BOOT | 写 | magic（4 或 8 字节） | ACK | 500 ms |
| GET_INFO | 写+读 | 无 | 版本 / flash 大小 / 单包上限 | 500 ms |
| ERASE | 写 | 起始地址 + 长度 | ACK + 状态 | **1~5 s** |
| WRITE_BLOCK | 写 | 地址 + 数据 | ACK（含 seq 回显） | 500 ms |
| READ_BLOCK | 写+读 | 地址 + 长度 | 数据（用于回读校验） | 500 ms |
| GET_CRC | 写+读 | 地址 + 长度 | CRC32 | 1~3 s |
| COMMIT | 写 | 无 | ACK | 500 ms |
| REBOOT | 写 | 无 | **无回执**（设备直接复位） | 不等待 |

### 3.2 时序与吞吐

- 单包 64 字节、1 MB 镜像 → 16384 次 `SET_REPORT`。Windows 上每次约 1~3 ms，**总耗时 20~50 s**；若厂商支持走中断 OUT 端点做数据通道（output report），可降到几秒。
- 写完最后一个块后**不能立刻 REBOOT**：必须等 `GET_CRC` 比对一致再 commit。
- 进度条要分三段（擦除 / 写入 / 校验），别只给一个百分比——擦除阶段长时间 0% 会被当成卡死。

### 3.3 本工程要注意的两个坑

1. **报告长度必须与描述符一致**。Chrome/Electron 的 `sendFeatureReport(reportId, data)` 会校验长度，短了直接抛错；不足要补 `0x00` 或 `0xFF`。
2. **设备重新枚举后旧句柄失效**。进入 bootloader 后 `HIDDevice` 对象会 disconnected，必须重新 `requestDevice` / 走授权回调，否则后面的写入全部报 `InvalidStateError`。

---

## 4. 情况 B：标准 USB DFU 类

### 4.1 协议要点（DFU 1.1）

- class code `0xFE`，subclass `0x01`，protocol `0x01`=runtime / `0x02`=DFU mode。
- 请求：`DFU_DETACH(0)`、`DFU_DNLOAD(1)`、`DFU_UPLOAD(2)`、`DFU_GETSTATUS(3)`、`DFU_CLRSTATUS(4)`、`DFU_GETSTATE(5)`、`DFU_ABORT(6)`，`bmRequestType` 为 `0x21`（out）/`0xA1`（in），recipient = interface。
- `DFU_GETSTATUS` 返回 6 字节：`bStatus(1) + bwPollTimeout(3) + bState(1) + iString(1)`。
- 状态机：`appIDLE(0) → appDETACH(1) → dfuIDLE(2) → dfuDNLOAD-SYNC(3) → dfuDNBUSY(4) → dfuDNLOAD-IDLE(5) → dfuMANIFEST-SYNC(6) → dfuMANIFEST(7) → dfuMANIFEST-WAIT-RESET(8)`，出错进 `dfuERROR(10)`，`UPLOAD-IDLE` 为 9。
- `wTransferSize`（功能描述符）决定**单次 DNLOAD 的最大长度**，不是 64 字节；`bwPollTimeout` 是主机必须等待的毫秒数。
- 下载结束的标志是**发一次 0 长度 DNLOAD**，然后进 MANIFEST。

### 4.2 WebHID 为什么不行，替代路径是什么

WebHID 只能发 HID 输入/输出/feature 报告，**无法发任意 class 控制传输**，所以 DFU 类设备它碰不到。两条替代：

| 方案 | 可行性 | 代价 |
|---|---|---|
| WebUSB（`navigator.usb`） | Windows 下要求设备绑 WinUSB；Chrome 可借 MS OS 描述符自动装驱动，但接口被 `usbaudio.sys` 占用时打不开 | 需在 Electron 补 `select-usb-device` 与 permission handler；固件必须支持 WCID |
| 主进程内置 `dfu-util` | 最稳，与固件实现解耦 | 多一个二进制；进度只能解析 stderr；沙箱下注意 stdio（本机坑：pipe 会被拒） |

---

## 5. 镜像与校验

- **格式**：裸 `.bin` 最省事；带头的 `.fw` 一般含 `magic + version + length + CRC + hardware id`。**必须核对 hardware id**，否则可能把 1621 的固件刷进别的型号。
- **校验分层**：单块 ACK → 整片 CRC32 →（可选）SHA-256 → 版本号防降级。
- **保留旧固件**：主机侧把「当前在跑的版本」的 bin 存进 `.userdata/firmware/`，出问题至少能回刷。
- **版本策略**：默认拒绝降级，开发模式才允许；否则老化测试会刷回旧版本还查不出原因。

---

## 6. 在本工程怎么落地

### 6.1 模块划分（不动现有参数链路）

```
src/renderer/src/device/dfu/
├── types.ts        镜像描述、进度、错误码
├── image.ts        .bin/.fw 解析 + 完整性校验（纯函数，好测）
├── protocol.ts     帧编解码（命令表、seq、CRC）
├── session.ts      DfuSession 状态机：idle → erase → write → verify → commit → done
└── index.ts        对外入口
```

DFU 与 `Transport` **互不依赖**：`Transport` 走参数下行（36 项标量 + EQ），DFU 只在设备页/设置页出现，避免把刷机状态塞进 `AppStore` 的参数模型。

### 6.2 复用与改动点

| 位置 | 要做的事 |
|---|---|
| `device/webhid/session.ts` | 复用它的设备发现与句柄管理；DFU 需要一个「按 VID/PID 重连」的能力 |
| `src/main/webhid.ts` | 现在 `select-hid-device` 是直接 `callback({})` 取消，**真机通道本来就打不通**（AGENTS 已知边界 2）。做 DFU 必须先放行 bootloader 设备的 VID/PID |
| 主进程 | 刷机期间 `powerSaveBlocker.start('prevent-display-sleep')`，并拦截 `before-quit` 提示「正在写入固件」 |
| UI | 分段进度 + 「不要拔线」+ 失败后「重试 / 重新进 bootloader / 回刷旧版本」三个出口 |
| 文件选择 | 渲染进程拖拽（File API，无需 Node）或主进程 `dialog.showOpenDialog` + 读文件 |

### 6.3 最大的测试杠杆：虚拟设备

`third_party/web_hid_utils` 已有 Python `virtual_hid` + WebSocket 桥接。给它加一个 DFU profile（状态机 + 假 flash + CRC 计算），就能在**没有硬件**的情况下把主机侧全流程跑通，并注入故障：

- 某帧不 ACK / 延迟 2 s → 验证超时重传；
- 返回错误 CRC → 验证校验失败分支；
- 写入中途断开连接 → 验证恢复流程与「不 commit」的约束。

这比等硬件到位再联调快一个数量级，也是把「变砖风险」提前暴露出来的唯一办法。

### 6.4 单测

纯函数优先：镜像解析（截断/CRC 错/硬件 ID 不匹配）、帧编解码（长度边界、seq 回绕）、状态机（非法跳转必须抛错）。

---

## 7. 变砖边界（先跟硬件确认，再写代码）

1. 有没有 **ROM boot / 强制进 bootloader** 的引脚或按键组合？
2. flash 是**内置还是外挂 SPI**？外挂的话，写到一半断电基本等于拆机烧录。
3. 有没有 **A/B 双区或 golden image**？
4. 有没有写保护 / 加密位？量产是否锁死 debug 口？
5. 升级过程中音频功能是否消失、是否会影响正在录音的会话？

---

## 8. 向原厂索取的资料清单（可直接转发）

1. RT1621 datasheet 中 **Firmware Update / Bootloader / DFU** 章节。
2. 官方升级工具（含版本号）与其命令行参数（能否被 GUI 调用）。
3. **镜像格式规范**：包头字段、magic、版本、长度、CRC 算法与多项式、硬件 ID 位置。
4. **传输协议**：接口类型（HID / DFU 类 / 私有）、报告描述符、命令码表、回执格式、超时约定。
5. **单次擦除/写入的最大长度**与对齐要求（sector 边界）。
6. 进入 bootloader 的方式，以及 boot 模式下的 **VID/PID**。
7. flash 分区表：bootloader / app / 参数区 / golden image 地址与大小。
8. 掉电保护策略（A/B？校验失败自动回滚？）。
9. 擦除与写入的典型耗时（做进度条与超时阈值用）。
10. 是否支持读回（verify by readback）与整片 CRC 命令。
11. 量产/研发固件是否加密签名，主机侧是否要做签名校验。
12. 已知的升级失败恢复手段（最短路径，不用拆机的那种）。

---

## 9. 参考

- USB Device Firmware Upgrade (DFU) 1.1 规范：<https://www.usb.org/sites/default/files/DFU_1.1.pdf>
- XMOS AN02019《Using Device Firmware Upgrade (DFU) in USB Audio》——USB Audio 设备用 HID 做 DFU 的参考实现：<https://www.xmos.com/file/an02019-using-device-firmware-upgrade-dfu-in-usb-audio/>
- WebHID 规范（`sendReport` / `sendFeatureReport` / `receiveFeatureReport` 的能力边界）：<https://wicg.github.io/webhid/>
- `dfu-util` 手册（标准 DFU 类设备的命令行参考）：<https://dfu-util.sourceforge.net/dfu-util.1.html>
