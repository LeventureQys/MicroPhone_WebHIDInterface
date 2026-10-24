# JAT1821 / A0 Bootloader DFU 协议解析

> 状态：源码解析稿。**依据是源码本身**，不是推测：`Document/Protocol/Bootloader/` 下 JAT1821（菁音 A0，ARMCM4_FP）Bootloader 工程 + 打包脚本 + 一个出厂升级包 `.bin`。
> 本文所有帧字节都用 `Tools/Py/Firmware_4_BootUpdater_Build.py` 生成规则重算过，并与出厂包 `INNO SoftEmbe_Bootloader(PD100UGen2) MCU [内部使用].bin` **逐字节比对一致**（见 §7 验证记录）。
>
> 适用边界：`MODEL_CODE = "P0JY04"` / `MODEL_NAME = "PD100UGen2"` / 芯片 JAT1821(A0)。如果目标产品是 RT1621，本目录的代码不适用 —— 见 §9。

---

## 0. 一句话结论

这是**自定义 HID 上的三层协议**，不是标准 USB DFU 类，WebHID 可以直接做：

```
USB HID 报告(64B)  →  SigmaBus 帧(0xC4 起始, 累加和)  →  DFU 子命令(0x02 信息 / 0x03 数据块)
```

设备侧只有**两条** DFU 命令（`0x02` 下发固件信息、`0x03` 下发数据块），**没有**擦除命令、没有能力查询、没有读回校验、没有提交命令、没有状态查询。擦除是"写之前顺手擦"的隐式行为，提交是"数据收满 + 校验和对上"的隐式行为。

所以上位机的全部工作就是：**校验镜像 → 进 DFU → 发一条信息帧 → 发 N 条数据块帧（每块等一个状态回执）→ 等设备自己重启**。

---

## 1. 传输栈

### 1.1 物理层：HID 报告

复合设备（UAC 音频 + HID），DFU 通道挂在 vendor-defined 集合上。

report descriptor 实测（`drv_uac10_lib.c`，`USB_HID_COL_USER_TRANS_EN = 1`）：

```c
0x06, 0x01, 0xFF,   // Usage Page (Vendor Defined 0xFF01)
0x09, 0x01,         // Usage (0x01)
0xA1, 0x01,         // Collection (Application)
  0xA1, 0x02,       //   Collection (Logical)
    0x85, 0x11,     //     Report ID (0x11)  IN   Count=0x3F → 63 B
    0x85, 0x51,     //     Report ID (0x51)  OUT  Count=0x3F → 63 B
```

| 项 | 值 | 说明 |
|---|---|---|
| OUT report ID | `0x51` | 主机→设备，63 字节载荷（+1 字节 report ID = 64） |
| IN report ID | `0x11` | 设备→主机，63 字节载荷 |
| VID / PID | `0x352F` / `0x0111` | 源码注释写「可以更改」，**不要硬编码**，按 report descriptor 匹配 |
| 端点 | `USB_HID_EP_NUM` 一对 IN/OUT | 不在本文关心范围 |

设备收到的每一个 `0x51` 报告，**除 report ID 外的全部字节被无脑塞进一个 4096 B 的字节流 FIFO**（`drv_uac10_hid.c:193` → `Hid.RxFiFoWrite(&pHidOutData[1], size-1)`）。
也就是说：**这是一个字节流，不是报文流**。一条 DFU 帧可以跨任意多个 HID 报告，上位机负责切分。

### 1.2 数据链路层：SigmaBus 帧

`SB_CP_START = 0xC4`（`Com.HidRx.h:28`）。接收是 6 状态状态机（`HidRxStaMac`），逐字节推进。

```
偏移  字段        长度   值 / 说明
 0    BEGIN        1     0xC4 固定
 1    LEN_L        1     整帧长度(含 CRC) 低字节
 2    LEN_H        1     整帧长度 高字节
 3    ADDR         1     必须 0x00，否则回 ACK(0x0001) 并丢弃
 4    CMD          1     0x0B=DFU，0x02=ACK，0x03/04/05/06=参数读写
 5..  DATA         LEN-7 载荷
 N-2  CRC_L        1     SigmaCRC 低字节
 N-1  CRC_H        1     SigmaCRC 高字节
```

- **`LEN` = 整帧字节数**（不是载荷长度），所以 `DATA 长度 = LEN - 7`，最小帧 `9` 字节。
- **SigmaCRC = 16 位累加取反加一**（`ComTxPacket`）：
  `crc = ((~(sum(frame[0..N-3])) & 0xFFFF) + 1) & 0xFFFF`，低字节先发。
  这是**求和校验**，不是 CRC-32，也不是 CRC-16。
- `LEN` 必须 `< 1023`（`Packet.Len < COM_CP_BUF_SIZE-1`），否则状态机**静默复位、不回错误**（`CP_ACK_LEN_ERR` 定义了但全工程从未发出）。载荷上限 1015 字节。
- CRC 校验通过后 `CMD &= 0x7F`，即 bit7 被忽略。

### 1.3 命令层

`ComFuncTable[12]`（`Com.DataProcess.c:469`）：

| CMD | 含义 | Bootloader 里是否实现 |
|---|---|---|
| `0x00`~`0x02` | 空函数 | 否（`0x02` 只用于设备→主机 ACK） |
| `0x03` | 随机写参数 | 只认 `addr == 0x1008`，回 ACK，**不做任何事** |
| `0x04` | 随机读参数 | `addr < 0x0B` 返回 `DevInfo[]`；`0x1008` 返回 `0x0001` |
| `0x05` | 连续写参数 | 只认 `0x1008 && num==1`，回 ACK |
| `0x06` | 连续读参数 | 同 `0x04` |
| `0x0B` | **DFU** | 是，见 §2 |

`0x0B` 的载荷头两字节是 `DFU_CMD` + `CHIP_ID`，`ComDfuEntry` 跳过这两个字节后分发：

| DFU_CMD | 方向 | 含义 |
|---|---|---|
| `0x01` | 设备→主机 | 状态回报。**主机不要发，发了没有回应**（switch 里没有 case） |
| `0x02` | 主机→设备 | 固件信息 |
| `0x03` | 主机→设备 | 固件数据块 |

---

## 2. DFU 帧格式（全部字节已实测）

### 2.1 进入 DFU：`CMD=0x03` 写参数 `0x1008 = 1`

不是 DFU 命令，是**参数写**。11 字节：

```
C4  0B 00  00  03  08 10  01 00  15 FF
│   │     │   │   │        │     └── SigmaCRC 0xFF15
│   │     │   │   │        └──────── value = 0x0001
│   │     │   │   └───────────────── CMD 0x03 随机写参数
│   │     │   └───────────────────── addr 0x00
│   │     └───────────────────────── LEN = 11
│   └─────────────────────────────── LEN_L
└─────────────────────────────────── 0xC4
```

设备侧行为：
- **MainApp** 收到后应写 DFU 状态字节并复位进 Bootloader —— **MainApp 源码不在本目录，无法确认**。
- **Bootloader** 收到后 `ComErrorAck(CP_ACK_NO_ERR)`，什么都不做（`Com.DataProcess.c:219`）。所以这个帧在 Bootloader 里是幂等无副作用的，回执**不能**用来判断当前处于哪个模式。

回执：`C4 09 00 00 02 00 00 31 FF`。

### 2.2 固件信息帧：`DFU_CMD=0x02`，共 90 字节

载荷 81 字节（`Cmd` 之后）：

| 偏移(载荷内) | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 6 | ModelCode | ASCII。`"000000"` = 通用（不校验）；`"Bootld"` = 刷 Bootloader |
| 6 | 64 | ModelName | ASCII，`0x00` 补齐。**Bootloader 完全不校验**（校验代码被注释掉了） |
| 70 | 3 | Ver X/Y/Z | 各 1 字节，**不校验**，不防降级 |
| 73 | 4 | FirmwareLength | uint32 LE，本次要写的总字节数 |
| 77 | 4 | FirmwareChecksum | uint32 LE，**32 位小端字累加和**（见 §4.2） |

整帧（以出厂包 `Bootld` 为例，已比对一致）：

```
C4 5A 00 00 0B 02 00
   42 6F 6F 74 6C 64                     ← "Bootld"
   30 30 30 30 30 30 00×58               ← "000000" + 58 个 0x00
   00 00 00                              ← Ver 0.0.0
   F8 51 00 00                           ← Length  = 20984
   AF 21 06 4E                           ← Checksum= 0x4E0621AF
   CRC_L CRC_H
```

设备收到后（`DfuProgramInfoCheck`）：
1. 判 ModelCode（`"000000"` / `"Bootld"` / 必须等于 `ParamTbl.DevInfo[0..2]`）；
2. 记录 Length / Checksum，`IapAddress = 0x00000000`（Bootld）或 `0x00008000`（其余）；
3. **立刻把 DFU 状态字节的 `EndFlag` 置为 `0x01` 并落盘** —— 这是「已开始升级、尚未成功」的持久标记；
4. 算进度增量，清超时；
5. 回状态帧。

失败（ModelCode 不匹配）→ 回 `0x01 INFO_ERR`，**`DfuStep` 保持 0**，后续数据块全部回 `0x02 CODE_ERR`。

### 2.3 数据块帧：`DFU_CMD=0x03`，块大小 256 → 265 字节

```
C4 09 01 00 0B 03 00 <256 字节数据> CRC_L CRC_H
   └ LEN = 0x0109 = 265
```

设备收到后（`DfuProgram`）：
1. `DfuStep == 0` → 直接回 `0x02`（必须先发信息帧）；
2. 拷进 4 KB `IapArray`；`DataCount += len`；
3. **若累计 ≤ 8 KB，对这块做 Gamma 解密**（4 字节粒度）；
4. 写 Flash（4 KB 边界处先擦扇区，写完回读比对，最多重试 3 次）；
5. `IapAddress += len`；累加 32 位字的校验和；
6. 累加进度；
7. 若 `DataCount >= FirmwareLength` → 比对校验和 → 回 `0x05` 或 `0x04`；否则回 `0x03` 并**重置 1 秒超时**。

### 2.4 设备→主机：DFU 状态帧，共 10 字节

```
C4 0A 00 00 0B 01 00 <status> CRC_L CRC_H
```

| status | 名称 | 实测字节 |
|---|---|---|
| `0x01` | INFO_ERR 固件信息错 | `C4 0A 00 00 0B 01 00 01 25 FF` |
| `0x02` | CODE_ERR 代码错 / 超时 | `C4 0A 00 00 0B 01 00 02 24 FF` |
| `0x03` | CONTINUE 继续发 | `C4 0A 00 00 0B 01 00 03 23 FF` |
| `0x04` | UPGRADE_FAIL 校验和错 | `C4 0A 00 00 0B 01 00 04 22 FF` |
| `0x05` | UPGRADE_SUCCESS 成功 | `C4 0A 00 00 0B 01 00 05 21 FF` |

### 2.5 设备→主机：SigmaBus ACK 帧，共 9 字节

主机发错帧时设备回这个，**和 DFU 状态帧是不同 CMD，必须分开处理**：

| err | 名称 | 实测字节 |
|---|---|---|
| `0x0001` | DEV_ADDR_ERR（ADDR≠0） | `C4 09 00 00 02 01 00 30 FF` |
| `0x0002` | LEN_ERR（**从不发送**） | `C4 09 00 00 02 02 00 2F FF` |
| `0x0003` | CHECKSUM_ERR（SigmaCRC 错） | `C4 09 00 00 02 03 00 2E FF` |

关键语义：**ACK 帧意味着那一帧被整帧丢弃、Flash 指针没有前进**；DFU 状态帧意味着那一块**被处理过了**。两者不能混为一谈。

### 2.6 读设备信息（可选，强烈建议前置）

读 `DevInfo[0..2]`（Model Code 的 3 个 uint16）：

```
C4 0D 00 00 04 00 00 01 00 02 00 28 FF     ← 读 addr 0x0000 / 0x0001 / 0x0002
```

回帧 `CC_PARAM_RAND_RD(0x04)`，每个地址 4 字节（地址 LE + 值 LE）：

```
C4 0D 00 00 04 | 00 00 v0 v1 | 01 00 v2 v3 | 02 00 v4 v5 | CRC_L CRC_H
                  └─ ModelCode 6 字节（小端拼）──┘
```

设备侧 `ParamTbl.Init()` 从 **`0x00039000`（`FLASH_FW_INFO_ADDR`）** 读这 6 字节 + ModelName，这块内容是 **MainApp 链接时用 `__attribute__((at(0x39000)))` 写死的**（`Fw.Info.c`）。
若该扇区是 `0xFF`（从未烧过 App / 已擦），`DevInfo` 全部清 0 —— 此时只有 `"000000"` 和 `"Bootld"` 两种镜像能通过校验。

---

## 3. 设备侧启动决策与持久状态

### 3.1 复位流程

`startup_a0.s` 的 `Reset_Handler` 先调 `BootCheck()`（在 RAM 里跑的汇编逻辑）：

```
BootCheck() 读 FLASH_DFU_SB_ADDR+1 = 0x00038001 这 1 个字节
  ├─ 0xFF (BL_JUMP_TO_APP) → 返回 0x00008000
  │     再检查 App 向量[0] (初始 MSP)：((sp & 0x1FFE0000) == 0x10000000)?
  │       ├─ 是 → SP = app.vector[0];  PC = app.vector[1];  进 MainApp
  │       └─ 否 → 回落 RUN_DFU_ROM（留在 Bootloader）
  └─ 其他                   → 返回 0，RUN_DFU_ROM（留在 Bootloader）
```

两个要点：
1. **跳转判断只看 4 字节状态区里的第 2 个字节**，不看 App 是否完整。
2. **App 的初始栈指针必须落在 `0x1000_0000` 段**（掩码 `0x1FFE0000`），否则 Bootloader 拒绝跳转、静默留在 DFU 模式。这是链接脚本约束，不是协议约束 —— 但它决定"刷完能不能启动"。

### 3.2 DFU 状态字节（`0x00038000`，4 字节）

| 偏移 | 字段 | 值 |
|---|---|---|
| +0 | Init1stFlag | `0xFF`=首次初始化魔术字，`0xA5`=已初始化 |
| +1 | BlJumpTo | `0x00`=下次进 Bootloader，`0xFF`=下次进 App |
| +2 | StartFlag | `0x01`=升级开始，`0x00`=清 |
| +3 | EndFlag | `0x02`=成功，`0x01`=失败/未完成，`0x00`=无 |

`DfuInit()`（只在真的留在 Bootloader 时执行）每次上电重算：

```
Init1stFlag == 0xFF  → 首次：置 0xA5, BlJumpTo=DFU, Start=0, End=0, 保存
否则                 → Start=0;
                       EndFlag == 0x01(FAIL) ? BlJumpTo = DFU : BlJumpTo = APP
                       保存
```

`DfuProgramInfoCheck()` 每次收到信息帧都会 `SetEndFlag(0x01)`，而 `SetEndFlag` 在 `EndFlag==FAIL` 时会顺带把 `BlJumpTo` 置成 `0x00`。

### 3.3 这套机制推导出的三条行为（对上位机极重要）

| 场景 | 设备下一个动作 |
|---|---|
| 正常开机，上次升级成功过 | 直接跳 App，**Bootloader 的 DFU 代码根本不初始化** |
| 发了信息帧之后掉了电 / 中途失败 | 状态字节是 `{A5,00,00,01}` → 每次上电都留在 DFU，**直到下一次完整成功**才回 App |
| 完整成功 | `DfuTerminate`：置 `{A5,FF,00,02}` → 延时 1 s → `NVIC_SystemReset()` → 跳 App |

**⇒ 分水岭是「信息帧」，不是「进入 DFU」。**
一旦主机发出 `DFU_CMD=0x02` 且被接受，这个设备就进入了"不刷完不罢休"的状态：它**不会**超时退出、**不会**回滚到旧固件、**没有**取消命令。想让它回到 App，唯一路径是**再完整刷一次镜像**（可以就是原来那个）。

好消息是它**不会变砖**：Bootloader 自己的代码区（`0x0`–`0x8000`）在刷 App 时不受影响，设备始终可枚举、可重刷。坏消息是"用户拔线跑路"之后设备就是一个只能进 DFU 的砖头外观。

### 3.4 内存分区

| 区域 | 地址范围 | 大小 | 说明 |
|---|---|---|---|
| Bootloader | `0x0000_0000` – `0x0000_7FFF` | 32 KB | 实占 21 KB（`Fw.BlCode.c`：`BlHexCode[21*1024]`）；代码搬 RAM 运行 |
| MainApp | `0x0000_8000` – `0x0003_7FFF` | **192 KB** | 可刷固件上限 |
| DFU 状态字节 | `0x0003_8000` | 4 B | 就在 App 区正后面 |
| 固件信息 | `0x0003_9000` | 88 B | ModelCode + ModelName，MainApp 链接期写入 |

Bootloader 的散列文件把 `Dfu.*.o / Com.*.o / Iap.o / Crc.o / Hid.o / drv_uac10*` 全塞进 `RO_CODE_RAM (0x1000_0000)`，就是为了**能一边擦自己所在的 Flash 一边继续跑**。

---

## 4. 镜像与校验

### 4.1 Gamma 加解密（前 8 KB）

`GAMMA_DECRYPT = 1`（`ProjectConfig.h`），所以**主机必须加密**，设备收到后解密。

```python
key = 0x1C9CBB63
for i in range(len//4):                 # 只处理前 min(len, 8192) 字节
    for j in range(4):
        t = data[i*4+j] ^ ((key >> (8*j)) & 0xFF)
        data[i*4+j] = (((t << 4) & 0xF0) | ((t >> 4) & 0x0F)) + 0xA3  # 低 8 位
```

- 密钥写死在两边（`Dfu.Encrypt.c:25` / Python 第 382 行）。
- **只有前 8192 字节加密**，之后是明文。
- **4 字节粒度**：长度不是 4 的倍数时，尾巴 1–3 字节不参与运算，也不会被写对。

### 4.2 "CRC-32" 其实是 32 位小端字累加

`Crc32.CalcContinue((uint32*)IapArray, len/4)` → `CRC_DATA += *(data++)`。

```python
def checksum(buf):
    s = 0
    for i in range(len(buf)//4):
        s = (s + int.from_bytes(buf[i*4:i*4+4], "little")) & 0xFFFFFFFF
    return s
```

- 名字叫 CRC32，**实现是累加和**，没有多项式、没有初值/异或。
- 作用在**解密之后**的数据上（`DfuProgram` 先解密再算校验和），所以上位机要对**明文**算校验和，再加密去发。
- 实测：把出厂包解密后按上式求和 = `0x4E0621AF` = 信息帧里填的值。✅

### 4.3 镜像处理链路（打包脚本 `Firmware_4_BootUpdater_Build.py`）

```
Keil .hex
  → ReadHexFile      按段拼接，段间空洞补 0xFF，同时累加校验和
  → DataRepair       补 0x00 到 4 字节对齐
  → GammaEncrypt     前 8 KB 加密
  → BuildBinFile     [EnterDfu(11B)][Info(90B)][Block0(265B)]…[BlockN]
```

出厂包实测：`11 + 90 + 81×265 + 257 = 21823` 字节，`FwLength = 20984`，末块 248 字节（非 256）。

---

## 5. 完整升级时序

```
主机                                                  设备
 │                                                     │
 │── ① 读 DevInfo[0..2] (CMD=0x04) ───────────────────►│  确认 ModelCode 与镜像一致
 │◄─ CC_PARAM_RAND_RD ─────────────────────────────────│
 │                                                     │
 │── ② EnterDfu: CMD=0x03 addr=0x1008 val=1 ──────────►│  MainApp 置状态字节后复位
 │◄─ ACK(0x0000) ──────────────────────────────────────│
 │         …USB 断开 / 重新枚举，等待设备回来…           │  → Bootloader
 │                                                     │
 │── ③ FW_INFO (DFU_CMD=0x02, 90B) ───────────────────►│  校验 ModelCode
 │◄─ status 0x03 CONTINUE / 0x01 INFO_ERR ─────────────│  置 EndFlag=0x01 落盘
 │                                                     │  ★ 此后不刷完不回 App
 │── ④ CODE_BLOCK#0  (256B, 265B 帧, 5 个 HID 报告) ───►│  擦 0x8000 扇区 → 写 → 回读校验
 │◄─ status 0x03 ──────────────────────────────────────│  重置 1s 超时
 │── ⑤ CODE_BLOCK#1 ──────────────────────────────────►│
 │◄─ status 0x03 ──────────────────────────────────────│
 │         … 每 16 块(4 KB) 触发一次扇区擦除，耗时明显变长 …
 │── ⑥ CODE_BLOCK#N (末块, 248B) ─────────────────────►│  DataCount >= Length
 │                                                     │  比对累加校验和
 │◄─ status 0x05 SUCCESS ──────────────────────────────│  置 ProgramCompleted
 │                                                     │  延时 1s → Terminate
 │         …约 2 s 后设备 USB 掉线…                     │  写 {A5,FF,00,02} → 复位
 │         …重新枚举…                                   │  → 跳 App
 │── ⑦ 读 DevInfo / 读一个 App 参数 ───────────────────►│  确认新固件真的跑起来了
 │◄─ 正常业务回执 ─────────────────────────────────────│
```

### 5.1 超时与看门狗（设备侧）

| 计时器 | 值 | 触发条件 | 后果 |
|---|---|---|---|
| `Dfu.Progress.DfuTimeOut` | **1000 ms** | 每个**非末块**被接受后重置；末块成功后清零 | 超时 → 主动发 `status 0x02 CODE_ERR`，并复位接收状态机 |
| `StaMac.Timeout`（`TFB_HID_RX_TO`） | 300 ms | 每收到 1 字节重置 | 帧收到一半停了 300 ms → 状态机回 BEGIN，半帧丢弃、**不报错** |

**⇒ 块与块之间不能停超过 1 秒。** 停了会收到一条**无人请求的** `0x02`，那是设备在喊"你断流了"。
**⇒ 一帧的多个 HID 报告之间不能停超过 300 ms。**

### 5.2 进度

`Dfu.Progress.Value`（0–100）**只存在于设备内存里，没有任何命令能读出来**。
上位机只能自己按"已发块数 / 总块数"算。注意 4 KB 边界上要多算一次扇区擦除时间，否则进度条会在那里"卡住"几十到上百毫秒，看起来像死了。

---

## 6. 作为上位机，你应该关注什么

按"不知道就一定出问题"的顺序排。

### P0 — 硬约束，违反必挂

**① 块大小必须同时满足三个整除关系。**
- 是 **4 的倍数** —— 否则 `GammaDecrypt` 的 `len/4` 截断、`Crc32` 的 `len/4` 也截断，尾部字节既不解密也不计校验和。
- **整除 4096** —— 否则 `IapPageWrCheck` 里 `dst % 4096 == 0` 判据失效，块跨越 4 KB 边界时扇区不擦，写完回读比对失败 → 回 `CODE_ERR`。
- **整除 8192** —— 否则 8 KB 加解密分界点落在块中间，两边对"哪部分是密文"理解不一致。

→ **就用 256**（出厂包的取值）。512 也满足。别自己发明 300 这种。

**② 校验和是"32 位小端字累加"，不是 CRC-32。**
上位机最常见的翻车点：拿 `crc32()` / `zlib.crc32()` 去算。必须按 §4.2 累加，且对**明文**算。

**③ 前 8 KB 必须 Gamma 加密，之后必须是明文。**
Bootloader 侧 `GAMMA_DECRYPT = 1`（`ProjectConfig.h`），打包脚本 `encryptType = 'Yes'` —— 两边必须一致。
加密错的表现不是报错，而是"刷成功但设备起不来"（向量表被解成垃圾 → MSP 检查不过 → 静默留在 DFU）。

**④ 帧必须自己切分到 63 字节的 HID 报告里，且尾部补 `0x00`。**
- 265 字节的块帧 = `63+63+63+63+13`，**5 个报告**。
- 一律发满 64 字节（report ID + 63 载荷），末报告补 `0x00`。解析器在 IDLE 态只认 `0xC4`，补 0 是安全的；**千万别补 `0xFF` 或 `0xC4`**（`0xC4` 会启动一个假帧）。

**⑤ 必须逐块等回执，不能流水线猛灌。**
设备侧 HID OUT 环形缓冲只有 **4 个 64 字节槽**（`USB_HID_OUT_PACKET_MAX = 4`），中断里写指针只管加、**不检查读指针**，满了就覆盖。
而一个数据块就要 **5 个报告** —— 单个块就已经超过缓冲深度。再加上 4 KB 边界那次扇区擦除会让主循环停几十毫秒，CPU 来不及排空。
→ **发完一个块（5 个报告）必须等到该块的状态回执，再发下一块。** 这是唯一能保证不丢包的方式。

**⑥ 必须持续读 IN 报告，不能只发不收。**
设备发回执用的是忙等 + 超时（`HidSendBytesCheckBusyStatus`，约 2 ms）；主机不读，回执就直接被丢掉。

### P1 — 设备不做，必须你自己做

**⑦ 固件长度上界检查（设备完全没有）。**
`DfuProgramInfoCheck` 只比对 ModelCode，`DfuProgram` 地址指针一路加，**没有任何越界判断**。
- 刷 App：`FirmwareLength ≤ 0x30000`（196 608 B）。
- 刷 Bootloader（`ModelCode = "Bootld"`，写入起点 `0x0`）：`FirmwareLength ≤ 0x8000`（32 768 B）。

超了就会把 `0x38000` 的 DFU 状态字节和 `0x39000` 的固件信息一起写掉。后果是具体的、可复现的：
- 状态字节被写成垃圾 → 下次上电 `BlJumpTo` 很可能不再是 `0xFF`，设备停不回 App；好在 `DfuInit` 会重算，通常还能自愈成 DFU 模式。
- **`0x39000` 的 ModelCode 被覆盖 → `ParamTbl.DevInfo` 变垃圾 → 之后所有正常型号的镜像都会被判 `INFO_ERR` 拒绝**，只有 `"000000"` 通用镜像还能刷。这一步必须靠 SWD 才能修好。

**这是本协议唯一的真实变砖路径**，必须在主机侧挡住。

**⑧ 镜像与设备型号匹配检查。**
先读 `DevInfo[0..2]`，和镜像里的 ModelCode 比。设备虽然也会拒（回 `INFO_ERR`），但那时已经动过 Flash 了 —— 而且如果该产品的 `0x39000` 是空的（`DevInfo` 全 0），任何正常型号的镜像都会被拒，只有 `"000000"` 能过。

**⑨ 防降级 / 版本策略。**
信息帧里的 `VerX/Y/Z` 设备**读都不读**。降级、重刷旧版、刷错产品，设备一律接受。版本表只能在主机侧维护。

**⑩ 没有签名校验 → 安全性为零。**
任何人拿到 HID 端点和这 6 字节 ModelCode 就能刷任意固件。至少：镜像来源可校验（哈希）、`.userdata` 里存一份"当前版本 bin"做回滚、生产环境限制 DFU 入口。

### P2 — 错误处理策略

**⑪ 区分"帧被丢"和"块被处理了但回执丢了"，并据此决定能不能重传。**

| 主机看到的 | 语义 | 能重传吗 |
|---|---|---|
| `C4 09 00 00 02 03 00 2E FF`（CHECKSUM_ERR） | 整帧丢弃，Flash 指针**没有前进** | **能**，重发同一块 |
| `C4 09 00 00 02 01 00 30 FF`（DEV_ADDR_ERR） | addr 不为 0，丢弃 | 能（先修 addr） |
| `status 0x03/0x05` | 已写、指针已前进 | 不能，发下一块 |
| `status 0x02` | 帧没被接受 / 1 秒断流 | **不能确定**，见下 |
| **什么都没有（超时）** | **完全无法判定** | **不要重传** |

`status 0x02` 和"静默超时"是**歧义态**：可能是帧丢了（没写），也可能是回执丢了（已写）。协议里**没有序号、没有读回、没有地址参数**，主机无法区分。

→ **策略：遇到歧义态不要猜，直接重发信息帧（`DFU_CMD=0x02`）把设备指针复位到 `0x8000`，从第 0 块整轮重来。**
重发信息帧会把 `IapAddress`、`DataCount`、`CheckSumCalc` 全部清零，是协议里唯一的"重启"原语。重来一遍只会多花时间，块边界上会重新擦扇区（`dst % 4096 == 0` 依然成立），不会写坏。别用"接着往下发"或"补发一块"。

**⑫ 约 2 秒的收尾窗口要正确处理。**
收到 `0x05` 之后设备还有 1 s 延时 + 1 s 延时才复位。这段时间：
- 不要再发任何东西（会撞上已完成的 `DfuStep = 0`，只会回 `0x02`）；
- 不要宣告成功；
- 等 HID `disconnect` 事件 → 等重新枚举 → **重新读一次设备信息确认 App 真的起来了**。
`0x05` 只代表"校验和对上了"，不代表"新固件能启动"（§3.1 的 MSP 检查可以照样把它挡回 DFU）。

**⑬ 首次进入 DFU 的失败重试要有限度。**
`EnterDfu` 的回执由"当时在跑的固件"发出，Bootloader 里是空实现。所以拿到 ACK **不能**证明进入了 DFU。判定方法：发一次信息帧，看 1 s 内有没有 `CMD=0x0B` 的状态帧回来；没有就是没进去，重试（含提示用户重插）。别无限重试同一个动作。

### P3 — 工程落地（本仓视角）

**⑭ 设备发现不要认 VID/PID，认 report descriptor。**
源码里 VID/PID 注了"可以更改"。用 WebHID 拿 `collections`，匹配 `usagePage === 0xFF01 && usage === 0x01`，再确认 `outputReports` 里有 `reportId 0x51`、`inputReports` 里有 `0x11`。

**⑮ 主进程必须放行。**
`src/main/webhid.ts` 的 `select-hid-device` 现在是直接 `callback({})` 取消（AGENTS 已知边界 2）。DFU 要走真机就必须改成按 report descriptor / VID-PID 放行，否则 `requestDevice()` 永远返回空。

**⑯ 模块划分照旧建议，但不要塞进 `Transport`。**
```
src/renderer/src/device/dfu/
├── frame.ts     SigmaBus 编解码 + SigmaCRC（纯函数，重点测）
├── image.ts     .bin 解析、长度上界、校验和、Gamma 加密（纯函数，重点测）
├── session.ts   DfuSession 状态机：preflight → enter → info → block* → settle → verify
└── index.ts
```
DFU 与参数下行（`Transport`）互不依赖；刷机状态不进 `AppStore` 的参数模型。

**⑰ 必须提供的 UI 语义**
- 分段进度（进入 / 写入 / 收尾 / 验证），写入阶段按块数推进；
- 「正在写入，不要拔线」+ `powerSaveBlocker` + 拦截 `before-quit`；
- 三个出口：重试 / 重进 DFU（重插）/ 回滚旧版本；
- **在按下"开始"之前**就把"进 DFU 之后不刷完不回 App"这条讲清楚。

**⑱ 单测杠杆**
`third_party/web_hid_utils` 的 `virtual_hid` 加一个 DFU profile（状态机 + 假 flash + 加解密 + 校验和），就能无硬件跑通全流程并注入故障：丢帧、回执丢失、1 s 断流、擦除耗时、校验和错、USB 中途掉线。§6 ⑪ 的歧义态只有靠注入测试才能验证策略正确。

**⑲ 最便宜的端到端回归**
出厂包里那个 `.bin` 是现成的黄金样本：逐字节比对 `EnterDfu + Info + 81×265 + 257`，能一次性锁死切帧、CRC、长度、块序列四个环节。本文 §7 就是这么验的。

---

## 7. 验证记录（本文结论的可复现依据）

对 `Tools/Py/INNO SoftEmbe_Bootloader(PD100UGen2) MCU [内部使用].bin`（21 823 B）逐帧解析：

| 检查项 | 结果 |
|---|---|
| 第 0 帧 = 11 B `C4 0B 00 00 03 08 10 01 00 15 FF` | ✅ 与重算一致（addr 0x1008 = 1） |
| 第 1 帧 = 90 B，`LEN=0x005A`，`CMD=0x0B`，`DFU_CMD=0x02` | ✅ ModelCode `"Bootld"`，ModelName `"000000"`+58×`00`，Ver 0.0.0 |
| `FwLength` = 20 984 | ✅ 等于后续所有块的数据总长 |
| 后续 82 帧全部 `DFU_CMD=0x03`，帧长 265（末块 257） | ✅ 81 × 256 B + 1 × 248 B = 20 984 |
| 全部 84 帧的 SigmaCRC | ✅ 全部通过 |
| `FwChecksum` = `0x4E0621AF` | ✅ 密文累加 = `0x1390B00A`（不符）；**解密后累加 = `0x4E0621AF`（符合）** |
| 解密后向量表 | `SP = 0x200041B8`，`Reset = 0x00004265` |
| 与 `Tools/Fw.BlCode.c` 前 8 字节对比 | ✅ `B8 41 00 20 65 42 00 00` 完全一致 —— 交叉证明 Gamma 解密实现正确 |

结论：§2 的帧格式、§4 的校验和与加密语义，都是从**源码推导后由出厂产物反向验证**的，不是猜的。

---

## 8. 尚未确认、需要供应商 / MainApp 侧确认的点

本目录只有 Bootloader 工程，下面几条无法从现有材料得出结论：

1. **MainApp 怎么响应 `0x1008` 写 1**。是否真的写状态字节 + 复位？还是别的方式？`UserFunction.c` 里另有一条 `address == 0x3FFF → UserEnterUpdateMode()` 的路径，但被 `#if(EFFECT_DEBUG == 1)` 关掉了（`EFFECT_DEBUG = 0`），在本工程里是死代码。
2. **进入 DFU 时 MainApp 写的是 `EndFlag = 0x01` 还是 `0x00`**。这决定"进了 DFU 但不刷"是要重插才能回去，还是永远回不去（§3.3）。
3. **Bootloader 模式的 VID/PID**。源码默认 `0x352F/0x0111` 且注明可改；如果 App 和 Bootloader 用同一套，主机就**无法靠 PID 区分模式**，只能靠"发信息帧看有没有 `0x0B` 回执"探测。
4. **真实产品的 report descriptor** 是否和这份源码一致（`USB_HID_COL_USER_TRANS_EN`、report ID `0x51/0x11`、63 字节）。
5. **App 镜像的 `ModelCode`/`ModelName`** 实际取值（本目录 Bootloader 侧是 `P0JY04` / `PD100UGen2`，App 侧 `Fw.Info.c` 的宏可见，但要与量产固件核对）。
6. **App 的初始 MSP 是否在 `0x1000_0000` 段**（§3.1 的跳转前置条件）。不满足的话每次升级"成功"但起不来。
7. **Bootloader 升级（`ModelCode = "Bootld"`）的量产策略**。源工程跑在 RAM 里所以能自擦，但写到一半掉电就只能 SWD 救 —— 出厂包名字里带 `[内部使用]` 就是这个原因，别放进消费级 UI。

---

## 9. 与 `RT1621-DFU固件升级调研.md` 的关系

那份文档是**在没有资料的情况下**写的通用骨架 + 待确认清单。现在这份 Bootloader 源码把其中大部分问题回答了，但**对象不同**：

| 那份文档的假设 | 本目录的实际情况 |
|---|---|
| 芯片 RT1621，无任何资料 | 芯片 JAT1821（菁音 A0），源码齐全 |
| DFU 通道未知，四种可能都列了 | 确定是 **vendor HID 自定义协议**（`Usage Page 0xFF01`） |
| 命令表是占位 | 确定只有 2 条命令（`0x02`/`0x03`）+ 5 个状态码 |
| 镜像格式未知 | 确定：`EnterDfu + 90 B 信息头 + 265 B/块`，前 8 KB Gamma 加密 |
| CRC 算法未知 | 确定：**不是 CRC-32，是 32 位小端字累加** |
| 需要问厂商 12 个问题 | §8 收敛到 7 条 |

如果本产品的最终硬件是 JAT1821，那份调研稿可以整体作废/归档；如果 RT1621 是另一条产品线，则两份并存，互不覆盖。**这一点需要产品侧确认，不要混用。**

---

## 10. 参考：最小上位机骨架

```ts
// ---- 常量 ----
const REPORT_OUT = 0x51, REPORT_IN = 0x11;
const CMD_DFU = 0x0B, CMD_ACK = 0x02, CMD_PARAM_RD = 0x04, CMD_PARAM_WR = 0x03;
const DFU_INFO = 0x02, DFU_BLOCK = 0x03;
const BLOCK = 256;                       // 必须: %4==0, |4096, |8192
const APP_MAX = 0x30000, BL_MAX = 0x8000; // 设备不做边界检查，主机必须做

// ---- SigmaBus 帧 ----
function pack(cmd: number, data: Uint8Array): Uint8Array {
  const f = new Uint8Array(data.length + 7);
  f[0] = 0xC4; f[1] = f.length & 0xFF; f[2] = (f.length >> 8) & 0xFF;
  f[3] = 0x00; f[4] = cmd; f.set(data, 5);
  let s = 0; for (let i = 0; i < f.length - 2; i++) s += f[i];
  const c = ((~s & 0xFFFF) + 1) & 0xFFFF;
  f[f.length - 2] = c & 0xFF; f[f.length - 1] = (c >> 8) & 0xFF;
  return f;
}

// ---- 切到 63 字节报告，始终发满 64 ----
async function send(dev: HIDDevice, frame: Uint8Array) {
  for (let off = 0; off < frame.length; off += 63) {
    const payload = new Uint8Array(63);              // 尾部补 0x00
    payload.set(frame.subarray(off, off + 63));
    await dev.sendReport(REPORT_OUT, payload);
  }
}

// ---- 32 位小端字累加（不是 CRC-32！对明文算）----
function sum32(b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i + 4 <= b.length; i += 4)
    s = (s + (b[i] | b[i+1] << 8 | b[i+2] << 16 | b[i+3] << 24)) >>> 0;
  return s >>> 0;
}

// ---- Gamma 加密：只前 8 KB，4 字节粒度，8 KB 之后保持明文 ----
function gammaEncrypt(src: Uint8Array): Uint8Array {
  const key = 0x1C9CBB63;
  const out = src.slice();                    // 整体拷贝，后面原样返回
  const n = Math.min(8192, out.length) & ~3;  // 截到 4 字节整数倍
  for (let i = 0; i < n; i++) {
    const t = (out[i] ^ ((key >>> (8 * (i & 3))) & 0xFF)) & 0xFF;
    out[i] = ((((t << 4) & 0xF0) | (t >>> 4)) + 0xA3) & 0xFF;
  }
  return out;
}

// ---- 会话状态机要点 ----
// preflight : 读 DevInfo[0..2] → 与镜像 ModelCode 比对
//             FwLength ≤ (isBootld ? BL_MAX : APP_MAX)
// enter     : pack(CMD_PARAM_WR, [0x08,0x10, 0x01,0x00]) → 等 ACK → 等重枚举
// probe     : 发 DFU_INFO，1s 内收到 CMD=0x0B 且 status∈{0x03} → 确实在 DFU
// blocks    : for i in 0..N: send block i → 等 1 个回执 → 校验 → 下一块
//             歧义态（超时 / 0x02）→ 整个循环从 probe 重来，绝不补发单块
// settle    : 收到 0x05 → 停止发送 → 等 disconnect → 等重枚举
// verify    : 重新读 DevInfo / 读一个 App 侧参数 → 确认新固件在跑
```

---

## 11. 一页速查

| 问题 | 答案 |
|---|---|
| 传输 | HID OUT `0x51` / IN `0x11`，63 B 载荷，vendor page `0xFF01` |
| 帧 | `C4 | LEN(整帧) | 00 | CMD | DATA | SigmaCRC` |
| SigmaCRC | 16 位累加取反加一 |
| DFU 命令 | 只有 `0x02` 信息帧、`0x03` 数据块 |
| 块大小 | 256（%4==0、整除 4096、整除 8192） |
| 块帧长 | 265 B = 5 个 HID 报告 |
| 流控 | **一块一个回执**，环形缓冲只有 4 个包槽 |
| 校验和 | 32 位小端字累加（≠ CRC-32），对明文 |
| 加密 | Gamma，密钥 `0x1C9CBB63`，**只前 8 KB** |
| 看门狗 | 块间 1 s；帧内 300 ms |
| 擦除 | 隐式，写前遇 4 KB 边界擦扇区 |
| 上限 | App 192 KB（`0x8000`–`0x37FFF`），Boot 32 KB |
| 分水岭 | 发信息帧后**不刷完不回 App**；恢复 = 重发信息帧整轮重来 |
| 设备护不护 | 长度不护、版本不护、签名不护、回读不护 —— 全靠主机 |
| 回执帧 | `C4 0A 00 00 0B 01 00 SS XX FF`（状态）/ `C4 09 00 00 02 EE EE XX FF`（ACK） |
