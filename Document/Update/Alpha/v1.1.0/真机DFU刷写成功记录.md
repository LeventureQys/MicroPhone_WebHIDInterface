# 真机 DFU 刷写成功记录 — M001 V0.0.2（2026-10-27 21:01–21:11）

> 目的：用厂商包 `Document/Protocol/dfu_M001 MCU V0.0.2_2026-10-26_Rev0.bin` 把 2026-10-26 首刷挂死后停在 Bootloader 的 M001 刷回来。
> 结果：**刷写成功** —— 信息帧通过（`0x03`）→ 2565 个代码块全部 `0x03` → 末块 `0x05`，设备写 `{A5,FF,00,02}` 复位、跳进新 App，USB 重新枚举为复合设备（`MI_00` 音频 + `MI_03` HID），Modbus 读正常。
> 工具：`tools/dfu/m001-dfu.py`（ctypes 直连 HID，不经 Electron）+ `tools/dfu/hidwin.py`
> 取证：本机 `zzwork/dfu-20261027-210843.jsonl`（成功轮，2571 条块记录）、`dfu-20261027-210158.jsonl` / `-210325.jsonl` / `-210450.jsonl`（三轮失败）

## 1. 现场（进 DFU 之前）

设备**不在**首刷记录留下的 Bootloader 里，而是已经在跑 MainApp（说明期间被厂商工具或重新上电救过）：

| 项 | 值 |
|---|---|
| HID | VID `0x0A67` / PID `0x0010`，usagePage `0xFF01` / usage `0x01`，IN/OUT 各 64 B |
| productName | `USB Audio Device`（Bootloader 下是 `Maono PD100 Mic`，可用作模式判据） |
| Modbus 0x13 读 `0x0000..0x000E` | 回 15 个字，**全 0**（信息区/参数区空白，F8' 未修） |
| 版本串 | `0.0.0.0`（因为版本字就在空白的参数区里，读不出真实版本） |
| Bootloader DevInfo | 不应答（MainApp 不解析 SigmaBus） |

## 2. 时间线（成功轮 dfu-20261027-210843）

| 阶段 | 动作 | 结果 |
|---|---|---|
| ① 进入 DFU | `00 10 00 0A 10 08 00 01 8D 09`（Modbus 写 `0x1008=1`） | `ACK 0x0000`，约 50 ms 内回 |
| ② 复位重枚举 | 关句柄 → 等 1.2 s → 轮询重开 | 约 1.2 s 后 `productName = Maono PD100 Mic`，DevInfo 正常应答 |
| ③ 信息帧 | 厂商帧（ModelCode `JYM001`） | `status 0x01`（型号不匹配，符合预期：设备信息区为空） |
| ④ 信息帧（通配） | 内存里把 ModelCode 改 `000000` 并重封 SigmaCRC | `status 0x03`，设备置 `EndFlag=0x01`（此后刷不完不回 App） |
| ⑤ 代码块 | 64 B/块 × 2564 + 末块 896 B，逐块等回执 | 全部 `0x03`，单块 9–14 ms；4 KB 扇区首块 ~30 ms |
| ⑥ 末块 | 896 B（覆盖 `0x30100..0x30480`） | **`0x05` 升级成功**，用时 120.6 s |
| ⑦ 收尾 | 设备延时 1 s ×2 → 写 `{A5,FF,00,02}` → 复位 | 重新枚举为 `USB Audio Device`，Modbus 应答正常 |

参数：`--chunk 64 --gap-ms 3 --post-ms 6 --timeout-ms 3000 --retries 4`。

## 3. 协议对照（每一步都对上 1026 版 DFU 协议）

| 协议 | 实现/实测 |
|---|---|
| §3.1 触发帧 `00 10 00 0A 10 08 00 01 8D 09` | 与包首帧逐字节一致；MainApp 只认新 Modbus 帧 |
| §4 复位后 Bootloader 重新枚举，Report ID 仍 0x51/0x11 | 实测 productName 变化 + DevInfo 可用 |
| §5.1 SigmaBus 帧 `C4 LenL LenH Addr Cmd DFU_CMD CHIP_ID Payload CRC` | 组帧/解帧与固件 `Com.HidRx.c` 一致；`Len = Payload+9` |
| §5.2 信息帧（真机实际 81 B 体 / 90 B 帧，文档写 85/94 是笔误） | 包内即是 90 B；`DfuProgramInfoCheck()` 只读 `data[0..80]` |
| §5.2 型号校验 | 信息区空 → `JYM001` 被 `0x01` 拒；`000000` 走通用升级分支 |
| §5.3 逐块、每块等回执、块间 <1 s | 64 B/块，回执 9–14 ms，块间隔 ≈ 6 ms |
| §5.3 校验和 = 4 B 小端字累加（非 CRC32），作用在**解密后**明文 | 本地复算 `0x1F5A9770` 与包头一致；纯数据总长 164 992 B |
| §5.3 Gamma 只前 8 KB | 64 B 整除 4/4096/8192，块边界不破坏解密与累加 |
| §5.4 收到 `0x05` 后不再发帧 | 收到后只等，由设备自己写状态字并复位 |
| §7 Report ID 0x51/0x11、63 B 载荷、SigmaCRC 求和补码 | 全部按此实现 |

## 4. 前三轮为什么失败（这次定位到两个新事实）

### 4.1 4 KB 扇区擦除偶发 `0x02`（设备侧不稳定）

| 轮次 | 块大小 | 停在哪 | 现象 |
|---|---|---|---|
| 1 | 64 B | 块 641，`0x12000`（扇区首块） | 回执 1029 ms 后 `0x02` |
| 2 | 64 B | 块 577，`0x11000`（扇区首块） | 回执 1028 ms 后 `0x02` |
| 3 | 64 B | 块 2575，`0x30380` | 回执 `0x04`（校验和不符） |

- 普通块 9–14 ms、扇区首块（擦除）约 30 ms；**失败的那次约 1028 ms** ≈ 设备 `IapPageWrCheck` 内部 3 次「擦除+写+回读」全失败 + 1 s 断流定时器。
- 即故障点在 `Iap.Write → hal_flash_erase/HalFlashWrite` 的**扇区擦除**，不是主机节奏、不是丢包；与首刷记录里"挂死"是同一族问题的两种表现（这次没挂死，设备一直活着、DevInfo 一直可读）。

### 4.2 重发同一块会让设备 `DataCount` 多算（协议没有序号，也没有地址参数）

固件 `Dfu.Program.c` 的 `DfuProgram()`：

```c
LibDrvMemcpy(IapArray, data, len);
DfuCtrl.DataCount += len;          // ← 先记长度
if (!Iap.Write(...)) return CODE_ERR;   // ← 写失败：IapAddress 不前进
DfuCtrl.IapAddress += len;
```

所以「写失败 → 重发同一块」在 Flash 侧是正确的（地址没前进），但 `DataCount` 被多记了 64 B。重发 N 次后，设备会在还差 64·N 字节时就判定"收齐"，拿不足的累加和去比对整包校验和 → `0x04`（第 3 轮就是这样，N=3）。

**修正**：最后一块一次性发完剩余 896 B。`0x30480 - 896 = 0x30100` 是 256 对齐地址，`HalSpiFlashWrite()` 按页切分（256/256/256/128，全部页对齐）不会回绕，写进去的 164 992 B 与校验和都完整；而 `DataCount = 164992 + 64N` 仍 `≥` 长度，结束判定落在正确位置。成功轮 N=0，同样走这条路径（无副作用）。

## 5. 主机侧三条修正（相对 2026-10-26 首刷）

1. **进 DFU 后等 1.2 s 再重开句柄**：ACK 之后 MainApp 还要静音/关 UI 才写状态字节，抢在 200 ms 窗口里重开会拿到正在掉线的旧句柄（`ReadFile` 报 1167 `ERROR_DEVICE_NOT_CONNECTED`）。
2. **`0x02` 重发同一块（≤4 次）**：设备失败时地址不前进，重发安全；实测重发通常一次就过。
3. **末块 896 B 补偿**：吸收重发造成的 `DataCount` 多算。

另：整轮不用 Electron。本机沙箱禁止子进程建命名管道，Electron 起不来（`platform_channel` 0xFATAL），所以改成 ctypes 直连 HID（SetupAPI + `CreateFileW` + 重叠 I/O），顺带拿到精确的每块时延。

## 6. 刷完之后

| 检查 | 结果 |
|---|---|
| 设备模式 | MainApp（`productName = USB Audio Device`） |
| HID | `VID_0A67&PID_0010&MI_03`，DevInfo 不再应答（Bootloader 已退出） |
| USB 复合设备 | `MI_00` = USB Audio（`usbaudio`）+ `MI_03` = HID，两路都在 |
| Modbus 读 | `0x0000`、`0x2022`、`0x2023`、`0x2026`、`0x204A`、`0x2051`、`0x2057`、`0x2058`、`0x2059`、`0x205A` 全部正常回帧（值仍全 0，见下） |

## 7. 仍留给固件的三个问题

1. **Flash 信息区（`0x39000`）为空**：`JYM001` 包被 `0x01` 拒，只能走 `000000` 通用升级；App 起来后参数区也全 0（增益/阈值等都没默认值）。这是本次唯一必须绕过的坑，也是"版本读不出"的原因。
2. **扇区擦除不稳定**：4 KB 擦除偶发失败（3 轮里 4 次），失败时设备卡在内部重试约 1 s。建议查 `HalFlashErase/HalSpiFlashWipCheck` 在擦除期间的等待与 XIP/缓存交互。
3. **`0x2057` 仍恒 0**（第二轮 F 系列问题未变）。

## 8. 复现

```powershell
$py = 'C:\Users\66465\AppData\Local\Programs\Python\Python314\python.exe'
# 看当前模式（MainApp / Bootloader）与 DevInfo
& $py tools\dfu\m001-dfu.py state
# 已在 Bootloader 时直接刷；MainApp 时用 flash-all（先发进入帧）
& $py tools\dfu\m001-dfu.py flash-all --chunk 64 --gap-ms 3 --post-ms 6 --timeout-ms 3000 --retries 4
```

- `flash` 会先做 DevInfo 预检；不通过就停手（提示拔插），不做任何写操作。
- 信息帧被 `0x01` 拒时自动改 `000000` 重发（只改内存帧，不动厂商文件）。
- 每块都写 JSONL（`t`/`addr`/`len`/`ms`/`retries`/`reply`），失败可精确定位到块号与地址。
- 若中途出现无应答（`timeout`）而不是 `0x02`：设备可能已挂死，只能拔插上电重来（`state` 会报 Bootloader 不应答 DevInfo）。
