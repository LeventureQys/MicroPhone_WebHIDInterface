# 真机 DFU 升级测试 — 第五轮（2026-11-04）

> 目标：用上位机「固件升级」把 M001 从当前 App 升到 `dfu_M001 MCU V0.0.4_2026-11-03_Rev0.bin`。
> 结果：**升级成功，正常路径已复测通过**。首轮从 App 进 DFU 在 44/654 块超时；拔插后从 Bootloader 直连完成 654/654。随后复现正常路径 11/654 超时，定位并修复两个主机侧时序问题（重枚举后未等待、5 个 63 B 报告超过设备 4 槽 OUT 缓冲），修复后 App → 官方 `JYM001` 包一次写完 654/654。
> 升级后设备信息区/配置区/预设区已由新固件初始化：型号 `JYM001`、名称 `M001`、固件 `0.0.4.0`，自检 3/3。
> 上位机修复：空型号预检、真机句柄缓存、DFU 进入后稳定等待、报告排空间隔、SigmaBus 0x00 补位静默、0xFF 擦除值解码。
> 取证：`artifacts/real5/`；探针 `scripts/probes/real5-*`。

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| “型号不对” | ✅ 已修：设备信息区为空时 `modelCode` 是空串而非 `null`，预检现按“未知型号”放行；UI 改提示“设备没有上报型号” |
| 真机句柄身份 | ✅ 已修：`getDevices()` 每次新建包装但底层 `HIDDevice` 不变，`WeakMap` 缓存后不再把“刷新”误判成“重枚举” |
| 首轮 DFU（App → DFU） | ⚠️ 历史记录：进入 Bootloader、信息帧接受、写到 44/654（≈11 KB）时块回执超时；Bootloader 随后不再响应，设备停在 Bootloader |
| 拔插后重试（Bootloader 直连） | ✅ 654/654 块全部写完，约 14.7 s；设备自动重启到 App |
| 修复后正常路径（App → 官方包 → DFU） | ✅ 654/654 块全部写完，约 21 s；无块超时、无重试，设备重启到 V0.0.4 |
| Bootloader 直连恢复（官方包） | ✅ 信息区初始化后官方 `JYM001` 包也能从 Bootloader 直连写完 654/654（约 21 s），不再需要通用包 |
| 升级后设备 | ✅ `JYM001` / `M001` / `0.0.4.0` / `VID 0x0A67` / `PID 0x0010`；自检 3/3；信息/配置/预设区已有默认值 |
| 官方 `JYM001` 包预检 | ✅ 升级后重新选官方包，型号/版本/654 块/`0xC3D9C2CC` 全部通过，不再需要通用包 |
| 遗留 | ⚠️ SN 区仍是 `0xFFFF`（新固件未写入），上位机已显示“—” |

---

## 1. 为什么上位机提示“型号不对”

设备信息区 `0x39000` 在 V0.0.2 下从未烧录：`sync()` 读 `0x0000–0x003D` 的 62 词全 0，`DeviceSnapshot.modelCode = ''`（空串，不是 `null`）。

`DfuSession.preflight()` 原来是：

```ts
if (deviceModel !== null && deviceModel !== info.modelCode) reject('mismatch');
```

空串不是 `null`，所以必然与包内 `JYM001` 不等 → 预检直接拒绝，界面显示“型号不对/型号不匹配”。

### 修复

| 文件 | 改动 |
|---|---|
| `device/dfu/session.ts` | 新增 `normalizeDeviceModelCode()`：`null` / 空串 / 全空白 / `000000` 都视为“设备未上报型号”，不参与比对；只有真实型号才判 `mismatch` |
| `device/link.ts` | 空型号/`000000` 时显示 `device.warn.modelMissing`“设备未返回型号信息（信息区为空）” |
| `i18n/{zh,en}.ts` | 新增 `device.warn.modelMissing`（与第三轮同名文案合并） |
| `tests/unit/dfu/session.test.ts` | 12b 增加 `''` / `'   '` / `'000000'` 三种“未知型号”放行断言 |
| `tests/unit/link.test.ts` | 新增空型号 → `device.warn.modelMissing` 断言 |

修复后预检实测：`JYM001 / M001 / 0.0.4 / 167376 B / 654 / 0xC3D9C2CC`，不再报“型号不对”。

---

## 2. 主机第二个修复：句柄缓存（DFU 重枚举误判）

第一次 DFU 在 `0x1008=1` ACK 后 **224 ms** 报：

```
设备通道异常，升级中止：The device must be opened first.
```

原因：`kit.ts` 的 `adaptNativeHandle()` 每次 `getNativeDevices()` 都新建适配对象；而 Chromium 对同一台物理设备返回的底层 `HIDDevice` 是**同一个对象**（探针 `real5-identity.js` 实测 `sameObject: true`）。`DeviceLink.awaitReenumeration()` 用适配对象身份判断“是否是新枚举的设备”，于是 200 ms 后的第一次 `refresh()` 就把**同一台还在 App 模式的设备**当成新设备，提前发 SigmaBus 信息帧；随后设备复位，句柄被关闭，`sendReport` 报 `The device must be opened first.`。

修复：`kit.ts` 增加 `WeakMap<HIDDevice, 适配对象>` 缓存，同一个底层 `HIDDevice` 永远返回同一个适配句柄；真正复位后 Chromium 给出新 `HIDDevice`，缓存自然产生新句柄。新增 `tests/unit/webhid-kit.test.ts` 用例断言两次 `nativeDevices()` 返回同一对象。

修复后进入 Bootloader、信息帧接受、开始写块（§4）。

---

## 3. 升级包与通用型号包

| 包 | 型号 | 版本 | 长度 | 块数 | 校验和 | SP / Reset |
|---|---|---|---|---|---|---|
| `dfu_...V0.0.4...bin` | `JYM001` | 0.0.4 | 167376 | 654 | `0xC3D9C2CC` | `0x1001E9D8` / `0x11035` |
| `dfu_...V0.0.3...bin` | `JYM001` | 0.0.3 | 167376 | 654 | `0xC3D7C2CC` | 同上 |
| `archived/dfu_...V0.0.2...bin` | `JYM001` | 0.0.2 | 164992 | 645 | `0x1F5A9770` | `0x1001E840` / `0x11035` |

升级前设备 `0x39000` 信息区为空，Bootloader 只接受 `000000` / `Bootld`。因此第一次使用了：

```
artifacts/real5/dfu_M001 MCU V0.0.4_2026-11-03_Rev0_generic.bin
```

只把信息帧里的 ModelCode 6 字节改成 `000000` 并重算该 SigmaBus 帧的 16 位 CRC；**块数据、长度、校验和与官方 V0.0.4 完全一致**。

升级成功后，新固件自己初始化了 `0x39000` 信息区；用官方 `JYM001` 包重新预检已经通过（§5.3），以后不需要通用包。

---

## 4. DFU 实测时间线

### 4.1 首轮：App → DFU（44/654 超时）

探针 `scripts/probes/real5-dfu-upgrade.js`，日志 `artifacts/real5/dfu-upgrade-2.log`：

| 时间 | 事件 |
|---|---|
| 22:26:10.975 | 勾选确认，点「开始升级」 |
| 22:26:11.283 | `进入升级模式`，5%，`0x1008=1` ACK |
| 22:26:11.x | 设备复位重枚举：序列号 `20261001`→`20251001`，音频接口消失，只剩 Bootloader HID |
| 22:26:12.184 | `正在写入`，11%，块 6/654 |
| 22:26:13.087 | 16%，块 44/654 |
| 22:26:14.634 | 块 44 回执超时 1500 ms → 主机整轮重来，重发信息帧 |
| 22:26:14.6–59.8 | phase `探测设备` 5% 停滞；Bootloader 不再回状态帧 |

首轮失败后设备停在 Bootloader，`navigator.hid.getDevices()` 一度超时；拔插 USB 后恢复枚举（序列号 `20251001`，产品名 `Maono PD100 Mic`，SigmaBus DevInfo 可读）。

### 4.2 重试：Bootloader 直连（654/654 成功）

探针 `scripts/probes/real5-dfu-retry.js`，日志 `artifacts/real5/dfu-retry.log`：

- 设备已在 Bootloader；设备页「打开」时参数同步失败，但按 2026-10-27 的 `_failSync()` 保留句柄与通道（界面提示“可能停在升级模式”）；
- 直接进「固件升级」→ 选通用包 → 勾确认 → 开始；
- **跳过 `0x1008` 进入阶段**（Bootloader 不认参数协议，没有 ACK），由信息帧探测确认；
- 信息帧 `status 0x03 CONTINUE` 后连续写块：

| 时间 | 事件 |
|---|---|
| 22:30:39.102 | 点「开始升级」 |
| 22:30:40.340 | 正在写入，11%，块 12/654 |
| 22:30:44.604 | 44%，块 262/654 |
| 22:30:48.880 | 77%，块 515/654 |
| 22:30:51.314 | 95%，块 654/654，`等待设备重启，请勿拔线` |
| 22:30:53.761 | **升级完成 100%**，“设备新版本 0.0.4” |

约 14.7 s 写完 167376 B（654 块），平均每块 ~22 ms，无重试、无超时。设备随后自动重启回 App；诊断统计 `out 43 / in 42`（只统计了收尾重连后的同步帧）。

### 4.3 复测正常路径：问题可复现（11/654 超时）

升级到 V0.0.4 后，又用**官方 `JYM001` 包**从 App 模式走了一次正常路径（探针 `real5-dfu-app-official.js`，日志 `dfu-app-official.log`）：

| 时间 | 事件 |
|---|---|
| 22:35:35.365 | 点「开始升级」，App 模式已同步 |
| 22:35:35.618 | `进入升级模式`，`0x1008=1` ACK |
| 22:35:36.138 | `正在写入`，块 5/654 |
| 22:35:36.218 | 块 11/654 发出 |
| 22:35:37.719 | 块 11 回执超时 1500 ms → 整轮重来 |
| 22:35:37.720 | 第 2 轮信息帧，之后无任何状态帧，设备再次挂死在 Bootloader |

完整诊断显示两个主机侧现象：

1. **每个状态帧前都有 53 个 `0x00` 补位**，`decodeSigmaStream` 把每个 0 都记成 `start` issue：一块 50+ 条无意义日志（500 条环形缓冲几块就刷满），既拖慢 DFU 期间的主线程，也把真正有用的帧挤掉；
2. **块 11 的 5 个 63 B 报告发出后没有任何回执**；随后信息帧又发进可能“只收到半块”的 Bootloader，设备不再响应。

结合“从拔插后已稳定数秒的 Bootloader 直连一次写完”这一事实，判断是两个主机侧时序问题叠加：

- 设备刚重枚举成 Bootloader，USB/Flash 尚未完全稳定，主机 200 ms 后就发信息帧、紧接着写块；
- 一个 265 B 块帧要拆成 **5 个 63 B 报告**，而设备 OUT 环形缓冲只有 **4 个槽**；报告背靠背发送时，第 5 个可能被丢，块回执超时；主机再把信息帧塞进“半块”状态，Bootloader 挂死。

### 4.4 修复与复测结果（正常路径通过）

| 修复 | 值 / 行为 |
|---|---|
| `TIMING.dfuEnterSettleMs` | **1000 ms**：`awaitReenumeration()` 成功后、信息帧之前等待，让 Bootloader 的 USB/Flash 初始化完成 |
| `TIMING.dfuReportGapMs` | **2 ms**：`FirmwareController` 的 DFU send 在 5 个 63 B 报告之间留排空间隔，避免 4 槽 OUT 缓冲丢第 5 包 |
| `decodeSigmaStream` | **静默跳过 `0x00` 补位**，不再为每个 0 产生 `start` issue；状态帧解析路径与日志都变干净 |
| `handleBytes` | 0x05 后（settling/verifying/done/failed）不再把 App 报文按 SigmaBus 解析，避免 0xFF 刷屏 |
| 单测 | `dfu/session` 增“重枚举后先等 1 s 再发信息帧”“settling 后不解析 App 报文”；`dfu/frame` 增“0x00 补位不报 issue”；`proto/timing` 24 字段 |

修复后拔插设备，从 Bootloader 用**官方 `JYM001` 包**直连恢复（`real5-dfu-retry-official.js`，日志 `dfu-retry-official.log`）：

| 时间 | 事件 |
|---|---|
| 22:46:27.884 | 点「开始升级」（Bootloader 直连） |
| 22:46:28.199 | `进入升级模式`，块 1/654 |
| 22:46:29.118 | 正在写入，块 7/654 |
| 22:46:45.878 | 95%，块 654/654 |
| 22:46:48.350 | **升级完成 100%**，约 20.5 s |

官方包能被 Bootloader 接受，信息区初始化后不再需要 `000000` 通用包。

随后从 App 模式走**正常路径**（`real5-dfu-app-official.js`，日志 `dfu-app-fixed.log`）：

| 时间 | 事件 |
|---|---|
| 22:47:30.326 | 点「开始升级」，App 已同步 |
| 22:47:30.591 | `进入升级模式`，`0x1008=1` |
| 22:47:32.150 | 正在写入，块 5/654（含 1 s 重枚举稳定等待） |
| 22:47:32.411–48.790 | 连续写到块 654/654，无块超时、无重试 |
| 22:47:51.390 | **升级完成 100%**，约 21 s，设备重启到 V0.0.4 |

诊断统计 `out 48 / in 48`，`timeout 0 / retry 0`。修复前同一路径在块 11/44 超时，修复后一次写完，说明两个时序修复有效。

> 结论：**上位机 DFU 功能实测通过（Bootloader 直连 + App 正常路径都通过）**。之前 44/11 块超时不是固件必然挂死，而是主机在 Bootloader 刚重枚举时写得太早、且 5 个报告背靠背发送超过设备 4 槽 OUT 缓冲；已修。

---

## 5. 升级后验证

### 5.1 设备信息区（`real4-final.js`）

设备已回到 App：MEDIA + HID MI_03，序列号 `20261001`，`0x13` 预设可读。

`0x0000–0x003D` 不再全 0：

| 地址 | 值 | 含义 |
|---|---|---|
| `0x0000–0x0002` | `0x4A59` / `0x4D30` / `0x3031` | `JYM001` |
| `0x0003–0x0004` | `0x4D30` / `0x3031` | `M001` |
| `0x000D` | 4 | 固件 Z = 4（0.0.4） |
| `0x0016` / `0x0017` | `0x0A67` / `0x0010` | VID / PID |
| `0x0018–0x001A` | 2026 / 11 / 3 | 固件日期 |
| `0x001E–0x003D` | 全 `0xFFFF` | SN 未写入（新固件遗留） |

配置区也恢复默认：`0x1000=700`（心跳）、`0x1002=1`（预设总数）、`0x1003..0x1005=1`。

预设区 `0x2001=1`（有效标志），`0x2002..0x2009` = `M001`，EQ 7 段 `enable/type/freq/gain/q`、Comp/Limit、3BandDrc 默认值均已写入。

### 5.2 上位机连接与自检

`real2-app-check-shot.js`：

```
source 已连接 / sync 已同步
自检：通过 · sync · 回读全量完成
      通过 · read · 0x2025 = 0
      通过 · writeBack · 写回原值并读回一致
设备字段：model JYM001 / name M001 / firmware 0.0.4.0 / VID PID 0x0A67/0x0010 / serial —
统计：出 494 / 入 493，CRC 0，超时 0，重试 0
```

### 5.3 官方包预检

`real5-fw-preflight.js`（官方 `JYM001` 包）：型号 `JYM001`、版本 `0.0.4`、167376 B、654 块、`0xC3D9C2CC`，无错误。说明信息区初始化后，标准包不再需要 `000000` 通用型号。

### 5.4 SN 显示修复

SN 区是 `0xFFFF`（擦除值），`decodeAsciiWords()` 原来会把它解成 64 个 `ÿ`。已改为把 `0xFF` 与 `0x00` 一样当作终止符，空 SN 现在显示“—”。新增单测。

---

## 6. 主机侧改动清单

```
src/renderer/src/device/dfu/session.ts     # 空/全 0 型号放行；重枚举后等 1 s；settling 后不解析 App 报文
src/renderer/src/device/dfu/controller.ts  # DFU 报告之间留 dfuReportGapMs 排空间隔
src/renderer/src/device/dfu/frame.ts       # decodeSigmaStream 静默跳过 0x00 补位
src/renderer/src/device/proto/timing.ts    # dfuEnterSettleMs=1000 / dfuReportGapMs=2
src/renderer/src/device/link.ts            # 空型号显示“未上报”而不是“不匹配”
src/renderer/src/device/webhid/kit.ts      # WeakMap 缓存真机适配句柄（DFU 重枚举身份）
src/renderer/src/device/registers.ts       # decodeAsciiWords 把 0xFF 当终止符
src/renderer/src/i18n/{zh,en}.ts           # device.warn.modelMissing
tests/unit/dfu/session.test.ts             # 空型号放行 + 1 s 等待 + settling 忽略 App 报文
tests/unit/dfu/frame.test.ts               # 0x00 补位不记 issue
tests/unit/proto/timing.test.ts            # 24 个时序字段
tests/unit/link.test.ts                    # 空型号 warning
tests/unit/webhid-kit.test.ts              # 同底层 HIDDevice → 同适配对象
tests/unit/registers.test.ts               # 0xFF 擦除值解码
scripts/probes/real5-fw-preflight.js       # 包内嵌官方 V0.0.4，预检取证
scripts/probes/real5-dfu-upgrade.js        # App → DFU 全流程探针（通用包）
scripts/probes/real5-dfu-app-official.js   # App → DFU 正常路径探针（官方包）
scripts/probes/real5-dfu-retry.js          # Bootloader 直连重试探针（通用包）
scripts/probes/real5-dfu-retry-official.js # Bootloader 直连恢复探针（官方包）
scripts/probes/real5-identity.js           # HID 句柄身份 / 当前模式探针
artifacts/real5/                           # 截图、日志、通用包
```

验证：`typecheck` 0 错；`vitest` **45 文件 / 638 例全过**；`build` 三端正常。

---

## 7. 结论与下一步

1. **升级成功**：设备已是 V0.0.4，信息/配置/预设区由新固件初始化，型号 `JYM001`、版本 `0.0.4.0`，自检 3/3。
2. **“型号不对”根因**是设备信息区空白 + 主机把空串当型号不符；已修。
3. **DFU 重枚举**的真机坑是适配层句柄身份；已用 `WeakMap` 修复并有单测。
4. **App→DFU 正常路径已修复并回测通过**：
   - 重枚举后立刻写块（Bootloader 未稳定）→ `dfuEnterSettleMs=1000`；
   - 265 B 块 = 5 个 63 B 报告 > 设备 4 槽 OUT 缓冲 → `dfuReportGapMs=2`；
   - 同时修掉 `decodeSigmaStream` 对 0x00 补位的日志风暴，以及 settling 后把 App 报文当 SigmaBus 解析的 0xFF 刷屏；
   - 修复后从 App 用官方 `JYM001` 包一次写完 654/654（约 21 s），无超时/重试；Bootloader 直连官方包恢复也通过。
5. 固件侧补写 SN 区（`0xFFFF` 目前显示为“—”）。
6. 不再需要 J-Link 救砖；后续如果 DFU 再失败，可用 `JYM001_Firmware_M001 MCU V0.0.4_2026-11-03_Rev0.hex` + J-Flash 兜底。
