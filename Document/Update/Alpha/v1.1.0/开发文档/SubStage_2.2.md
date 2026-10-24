# SubStage 2.2 — 虚拟下位机（DFU 侧、故障注入、电平）

> **所属 Stage**：Stage 2（虚拟下位机）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 2.1（`device-stack.mjs`、`sidecar.mjs`、`run.mjs`、控制面 HTTP）。二进制的组帧/寄存器文件/侧车骨架必须已存在，本任务只**扩展**它们。
> **并行状态**：需等待 2.1；与 SubStage 3.x、4.1 **可并行**（文件不重叠，联调留到 5.3）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

参数侧通了以后，虚拟下位机还缺三样东西，缺一样就没法验收：

1. **DFU 侧**（R6/R7）：SigmaBus 帧解析、`DFU_CMD 0x02/0x03` 状态机、假 Flash、Gamma 解密、32 位小端字累加校验、8 KB 加密边界；以及"收到 `0x1008=1` 后从 app 模式切到 bootloader 模式、成功后切回"（R7-6）。
2. **故障注入**（R7-4，一等公民）：8 类动作，每类至少 1 个自动化用例。
3. **电平发生器**（R5/R7）：正弦/阶跃/静音三种模式驱动 `0x2057`，供 3.2 的轮询与 UI 验收。

外加一个测试夹具：**厂商格式升级包生成器**（`package.mjs`），用来造 R6-4 需要的"App 包"（`ModelCode = JYM001`、`Ver = 1.2.3`），因为出厂包里只有 `Bootld` 包。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/vdevice/device-stack.mjs` | 2.1 产出：寄存器文件 + 参数协议应答 + `hooks` 预留点（完成报告里会写清形状） |
| `tools/vdevice/sidecar.mjs` | 2.1 产出：WS 客户端 + 控制面 HTTP（`/control/stats|registers|reset|log`） |
| `tools/vdevice/run.mjs` | 2.1 产出：一条命令拉起桥 + 侧车 |
| `src/renderer/src/device/dfu/**` | 本任务**不**实现（属 4.1）；设备侧独立实现，与上位机形成对拍 |
| 出厂黄金包 | `Document/Protocol/Bootloader/Tools/Py/INNO SoftEmbe_Bootloader(PD100UGen2) MCU [内部使用].bin`（21 823 B，84 帧，`ModelCode="Bootld"`、`FwLength=20984`、`FwChecksum=0x4E0621AF`） |

DFU 协议事实（已由本轮实测复算，见问题清单 §3.3）：SigmaBus 帧 `C4 | LEN_L | LEN_H | 00 | CMD | DFU_CMD | CHIP_ID | DATA | CRC_L | CRC_H`；`LEN` 16 位小端=整帧字节数；SigmaCRC = `((~Σframe[0..n-3] & 0xFFFF) + 1) & 0xFFFF`；信息帧 90 B（载荷 81 B）、块帧 265 B（载荷 256 B）、状态帧 10 B；状态码 `0x01..0x05`；Gamma 加密只作用前 8192 B、4 字节粒度：`c = nibbleSwap(p ^ keyByte[i%4]) + 0xA3`，`keyByte = [0x63,0xBB,0x9C,0x1C]`。

---

## 3. 本 SubStage 产出文件

```
tools/vdevice/dfu-stack.mjs        新建（SigmaBus 解析 + DFU 状态机 + 假 Flash）
tools/vdevice/dfu-stack.d.mts      新建
tools/vdevice/faults.mjs           新建（故障规则匹配与动作生成）
tools/vdevice/faults.d.mts         新建
tools/vdevice/level.mjs            新建（电平发生器）
tools/vdevice/level.d.mts          新建
tools/vdevice/package.mjs          新建（厂商格式升级包生成器，测试夹具）
tools/vdevice/package.d.mts        新建
tools/vdevice/device-stack.mjs     修改（接入 dfu-stack 与 faults 的 hooks）
tools/vdevice/sidecar.mjs          修改（新增控制面：/control/faults、/control/mode、/control/level）
tests/unit/vdevice/dfu-stack.test.ts    新建
tests/unit/vdevice/faults.test.ts       新建
tests/unit/vdevice/package.test.ts      新建
```

---

## 4. 完整契约

### 4.1 `tools/vdevice/dfu-stack.mjs`

```js
export const SIGMA_START = 0xC4;
export const CMD_DFU = 0x0B;
export const CMD_ACK = 0x02;
export const DFU_CMD_STATUS = 0x01;
export const DFU_CMD_INFO = 0x02;
export const DFU_CMD_BLOCK = 0x03;
export const DFU_STATUS_INFO_ERR = 0x01;
export const DFU_STATUS_CODE_ERR = 0x02;
export const DFU_STATUS_CONTINUE = 0x03;
export const DFU_STATUS_FAIL = 0x04;
export const DFU_STATUS_SUCCESS = 0x05;
export const SIGMA_ACK_DEV_ADDR_ERR = 0x0001;
export const SIGMA_ACK_LEN_ERR = 0x0002;
export const SIGMA_ACK_CHECKSUM_ERR = 0x0003;
export const GAMMA_KEY = 0x1C9CBB63;
export const GAMMA_BYTES = 8192;
export const BLOCK_BYTES = 256;
export const APP_MAX_BYTES = 0x30000;
export const BOOT_MAX_BYTES = 0x8000;

export function sigmaCrc(bytes)                       // 16 位累加取反加一
export function buildSigmaFrame(cmd, data, addr = 0)  // → Uint8Array
export function splitReports(bytes)                   // 63 B 切包（与参数侧同实现，可复用 device-stack 的）
export function gammaDecrypt(bytes)                   // 前 8192 B、4 字节粒度
export function sum32Words(bytes)                     // 32 位小端字累加

export class DfuStack {
  /**
   * @param {object} opts
   * @param {string} [opts.modelCode]        设备自身型号码，缺省 'JYM001'
   * @param {boolean} [opts.allowBootld]     是否接受 ModelCode='Bootld'（缺省 false；自检脚本可置 true）
   * @param {() => number} [opts.now]
   * @param {object} [opts.timers]
   * @param {(reports: Uint8Array[]) => void} opts.onReplies
   */
  constructor(opts)
  /** 入站 63 B 报告（不含 report ID） */
  feed(payload)
  /** 当前 DFU 子状态：'idle'|'infoAccepted'|'done'|'failed' */
  state()
  /** 最后一次收到的 status（0..5 或 null） */
  lastStatus()
  /** 假 Flash：已写入的明文字节数 / 校验和累计值 / 块数 */
  flash()
  /** 已完成一次成功升级后为 true（侧车据此切回 app 模式） */
  completed()
  /** 强制断电：后续帧不再处理，状态停在 failed */
  powerLoss()
  reset()
}
```

设备侧行为（逐条可测）：

| # | 场景 | 行为 |
|---|---|---|
| D1 | 收到 `CMD 0x0B / DFU_CMD 0x02`（90 B） | 校验 `LEN=90`、`ADDR=0`、SigmaCRC；`ModelCode` 匹配（设备自身码 / `"000000"` / `allowBootld` 时的 `"Bootld"`）→ 记录 length/checksum、`state='infoAccepted'`、回状态帧 `0x03`；不匹配 → 回 `0x01`，`state` 保持 `idle` |
| D2 | 收到块帧（265 B / 末块更短）而 `state !== 'infoAccepted'` | 回 `0x02` |
| D3 | 块帧 `LEN = 7 + n + 2`，`n` 必须是 256 或 `FwLength` 的末块余量 | 长度不符回 `0x02` |
| D4 | 块累计 | 前 8192 B 用 `gammaDecrypt` 还原明文；累加 `sum32Words`；`DataCount += n`；回 `0x03` |
| D5 | `DataCount === FwLength` | 比对累加校验和：相等回 `0x05` 并置 `state='done'`、`completed()=true`；不等回 `0x04`、`state='failed'` |
| D6 | `DataCount > FwLength` | 回 `0x02`（不落地） |
| D7 | 重新收到信息帧 | 复位指针/计数/校验和（允许整轮重来，R6-5/R6-6 靠这条） |
| D8 | `ADDR !== 0` | 回 `C4 09 00 00 02 01 00 30 FF`（`SIGMA_ACK_DEV_ADDR_ERR`） |
| D9 | SigmaCRC 错 | 回 `C4 09 00 00 02 03 00 2E FF`（`SIGMA_ACK_CHECKSUM_ERR`），**指针不前进** |
| D10 | `LEN > 1022` 或 `< 9` | 丢弃该帧、回 `SIGMA_ACK_LEN_ERR`，清累积器 |
| D11 | 收 `CMD 0x03`（旧参数随机写）`addr==0x1008 && val==1` | 回 `C4 09 00 00 02 00 00 31 FF`，无副作用（DFU 材料 §2.1：Bootloader 里是幂等空实现） |

### 4.2 `tools/vdevice/faults.mjs`

```js
export const ACTIONS = ['drop','delay','dropAck','crcError','ackError','powerLoss','disconnect','sticky'];

/** 规则形状与设计文档 §5.14.3 一致 */
export function parseFaults(raw)     // 校验并归一；不合法抛 Error（含索引）
export class FaultTable {
  constructor(rules = [])
  /** @param {{mode:string, func?:number, dfuCmd?:number, phase?:string}} ctx  @returns {null|{action:string,ms?:number,code?:number}} */
  match(ctx)
  /** 命中后调用，推进 nth 计数；返回是否用尽（times） */
  consume(rule)
  reset()
  fired()
}
```

匹配语义：按规则数组顺序，首条 `on` 全字段匹配（缺省字段视为通配）且 `nth` 命中（未写 `nth` 匹配每次；写了则第 `nth` 次命中才触发）→ 返回该动作。`times` 缺省 1，`0` = 永久；用尽后该规则不再命中。

`crcError`/`ackError`/`sticky`/`dropAck`/`delay` 的实现方式（写在侧车）：

| action | 实现位置 |
|---|---|
| `drop` | 侧车在调用 `ParamStack.feed` / `DfuStack.feed` **之前**拦截，直接不喂 |
| `delay` | 侧车把 `feed` 延后 `ms`（走 `timers`，不阻塞事件循环） |
| `dropAck` | 先 `feed`（状态前进），再把 `onReplies` 的产物丢弃 |
| `crcError` | `feed` 后把每条回执的最后两字节改成 `(0x00, 0x00)`（保证 CRC 错且长度不变） |
| `ackError` | 参数模式：把回执替换为 `buildFrame(0x02, [hi, lo])`（参数协议错误码是 16 位大端）；DFU 模式：替换为 `buildSigmaFrame(CMD_ACK, [lo, hi])`（**SigmaBus 数据小端、2 字节**，帧长 9，如 `C4 09 00 00 02 03 00 2E FF`） |
| `powerLoss` | 调用 `DfuStack.powerLoss()` + `ParamStack.setMode('bootloader')`，之后所有入站帧不喂；直到 `/control/mode {mode:'app'}` |
| `disconnect` | 在 `ms` 时间窗内不喂任何入站帧（不改状态）；窗口结束恢复 |
| `sticky` | 把上一条回执的**尾部**（长度 `k = min(前一条长度, 63 - 本条长度)`）拼到本条回执前面，再切 63 B 包；用于验证上位机的流式拆帧 |

### 4.3 `tools/vdevice/level.mjs`

```js
export class LevelSource {
  /** @param {{pattern?:'sine'|'step'|'silence', periodMs?:number, min?:number, max?:number, value?:number}} opts */
  constructor(opts)
  /** 当前电平原始值（0..256 的整数） */
  value(now)
  set(opts)      // 控制面改模式
  snapshot()     // { pattern, periodMs, min, max, value }
}
```

- `sine`：`min + (max-min) * (1 + sin(2π·now/periodMs))/2`，四舍五入到整数并夹到 `[0,256]`；`periodMs` 缺省 2000。
- `step`：固定 `value`（缺省 128）。
- `silence`：固定 0。
- 侧车每次喂入站帧时把 `level.value(now)` 写进 `0x2057`（`ParamStack.writeRegister`），保证轮询读到的是"实时量"。

### 4.4 `tools/vdevice/package.mjs`

```js
/**
 * 把一段明文镜像打成厂商格式升级包（EnterDfu + Info + N×Block）。
 * @param {{ image: Uint8Array, modelCode: string, modelName: string, version: {x,y,z} }} opts
 * @returns {{ bytes: Uint8Array, info: {length:number, checksum:number, blocks:number} }}
 */
export function buildPackage(opts)
/** 篡改工具：把第 n 个数据字节翻转（R6-2 用） */
export function tamperByte(bytes, index)
/** 篡改 FwLength 字段（R6-3 用；会把信息帧 LEN 与 CRC 一起算对，构造"合法帧但超界"的包） */
export function overrideLength(bytes, length)
```

- 明文按 256 B 切块，末块可短；前 8192 B 走 `gammaEncrypt`（`dfu-stack.mjs` 里与 `gammaDecrypt` 成对出现）。
- `FwChecksum = sum32Words(明文)`（**对明文算**）。
- 第一帧必须是 `CMD 0x03 / addr 0x1008 / val 1` 的 `C4 0B 00 00 03 08 10 01 00 15 FF`（逐字节一致）。
- `buildPackage` 必须自检：`sigmaCrc` 全通过、`FwLength === 明文长度`、`FwLength % 4 === 0`（不足补 `0x00` 到 4 的倍数并计入长度）。

### 4.5 侧车与控制面新增

`sidecar.mjs` 新增：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/control/faults` | body `{ faults: [...] }`，整体替换规则表；回 `{ ok: true, rules: n }` |
| `POST` | `/control/mode` | body `{ mode: 'app'\|'bootloader' }`；同时清空两侧累积器；回 `{ ok: true, mode }` |
| `POST` | `/control/level` | body 同 `LevelSource` opts；回 `{ ok: true, level: {...} }` |
| `GET` | `/control/stats` | 在原字段基础上增加 `dfuStatus`、`firmwareVersion`、`blocks`、`levelRaw`、`faultsFired`、`versionSynthetic` |

模式切换逻辑（放侧车，不放 `device-stack`）：

1. `ParamStack` 回执里出现对 `0x1008=1` 的 ACK 且 `dfuRequested()` 为真 → 切 `mode='bootloader'`：`ParamStack.reset()`、`DfuStack.reset()`、此后所有入站帧只喂 `DfuStack`。
2. `DfuStack.completed()` 为真 → 把固件版本寄存器写成镜像 `Ver`（三项全 0 时写 `0.0.1` 并置 `versionSynthetic = true`），切回 `mode='app'`，`DfuStack.reset()`。
3. `powerLoss` 故障后模式固定 `bootloader`，直到 `POST /control/mode`。

---

### 4.6 与 SubStage 2.1 的接线契约（2.1 已完成，实际形状以此为准）

`device-stack.mjs` 暴露的扩展点（`.d.mts` 已声明）：

```js
new ParamStack({
  registers, info, timers, now, onReplies,
  hooks: {
    /** 每解出一帧、CRC 通过、任何状态变更前调用；把 action 置 'drop' 即该帧不产生任何回执 */
    onFrame(frame: {
      mode: 'app' | 'bootloader',
      func: number,
      data: Uint8Array,      // 已去掉 UnitID/Func/Len/CRC
      len: number,           // 整帧字节数
      at: number,            // opts.now()
      action: 'process' | 'drop',
    }): void,
    /** 在 opts.onReplies 之前调用，用于观察/改写即将发出的报告 */
    onReplies(reports: Uint8Array[]): void,
  },
})
```

插入位置（2.1 的实际代码结构）：

| 故障 | 插点 |
|---|---|
| `drop` / `delay` / `disconnect` | `sidecar.mjs` 的 `handleOutputReport`，在 `stack.feed()` **之前**；`delay` 用 `timer.setTimeout` 重新 feed（`ParamStack` 暴露 `get timers()`） |
| `crcError` / `ackError` / `sticky` | 包住侧车的 `handleReplies`（`sidecar.mjs` 的 `onReplies` 汇总处）改写/丢弃 reports；`deliver()` 已实现"每条一个 `device.setInput`、串行、失败重试 1 次" |
| `powerLoss` / 模式切换 | `ParamStack.setMode()`（切换时清累积器）；bootloader 模式 feed 直接忽略参数帧 |
| `level` | 侧车 `createStack()` 现只写常量 `LEVEL_ADDR`；改为每次 feed 前 `writeRegister(LEVEL_ADDR, levelSource.value(now))` |
| 控制面新增 | `sidecar.mjs` 的 `handleHttp` 路由表加 `/control/faults|/control/mode|/control/level`；`statsPayload()` 扩展 `dfuStatus`/`blocks`/`faultsFired`/`versionSynthetic` |

两个已实测的事实（照抄，不要再踩）：

1. `hid.outputReport` 的 `params.reportId` 是 **OUT 报告号 81（0x51）**，不是 IN 的 17；17 只用于出站 `device.setInput`。
2. 63 B 报告的尾部补位 `0x00` 必须在设备侧也当作填充丢弃（`Len === 0` 即清累积器），否则每个请求后会多回一个 ACK `0x0002`。

`/control/log` 返回**裸数组**（`[{at,dir,hex}]`，最近 200 条）；`/control/registers` 只回 `{ ok: true }`；`stats` 现有字段见 2.1 报告（`mode/framesIn/framesOut/byFunc/unknownFunc/rejectedReadOnly/rejectedRange/dfuRequested/levelRaw/firmwareVersion/modelCode/serial/lastRoundTripMs/ignoredReports/droppedReports/setInputFailures/bridgeConnected`）。

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| 故障配置非法（未知 action、`ackError` 缺 `code`） | `parseFaults` 抛 `Error`，控制面回 `400 { ok:false, error }`，保留旧规则表 |
| `ackError` 的 `code` 不在 0..5 | 同上拒绝 |
| `powerLoss` 后再收参数协议帧 | 不喂任何栈（不产生回执），统计 `framesIn` 仍 +1 |
| `disconnect` 窗口内 | 不喂栈；窗口结束后恢复正常，不回补 |
| 侧车写 `0x2057` 与 `level` 模式冲突 | `level` 为准（每次喂帧都覆盖写） |
| `package.mjs` 的明文长度不是 4 的倍数 | 右补 `0x00` 至 4 的倍数并计入 `FwLength` |
| 生成的包 `FwLength > 0x30000` | `buildPackage` 抛 `RangeError`（不允许生成超界包；超界包用 `overrideLength` 专门构造） |

---

## 6. 测试要求

`tests/unit/vdevice/dfu-stack.test.ts` 必须包含：

1. 信息帧（用 `package.mjs` 生成）→ 状态帧 `0x03`；逐字节断言 `C4 0A 00 00 0B 01 00 03 23 FF`。
2. 完整升级：82 块（256 B×81 + 末块）→ 除末块外全 `0x03`，末块 `0x05`（`C4 0A 00 00 0B 01 00 05 21 FF`）。
3. 校验和错（篡改 1 字节后再打包）→ 末块 `0x04`。
4. `ModelCode` 不匹配（设备码 `JYM001`，包 `P0JY04`）→ `0x01`，且后续块帧回 `0x02`。
5. `allowBootld: false` 时 `Bootld` 包 → `0x01`；`allowBootld: true` 时 → `0x03`。
6. 未发信息帧直接发块帧 → `0x02`。
7. 重发信息帧后指针归零，可整轮重来并成功。
8. `ADDR !== 0` → `C4 09 00 00 02 01 00 30 FF`；SigmaCRC 错 → `C4 09 00 00 02 03 00 2E FF` 且指针未前进。
9. `LEN = 2000` 的伪帧 → `SIGMA_ACK_LEN_ERR` 且累积器被清空。
10. `gammaDecrypt` / `sum32Words` 对出厂包的**前 8192 字节片段**做交叉验证：把出厂包第 1 帧后的 82 块拼成密文，`gammaDecrypt` 后首 8 字节为 `B8 41 00 20 65 42 00 00`，`sum32Words` 为 `0x4E0621AF`（用例直接从 `.bin` 读，文件缺失时 `it.skip` 并打印原因）。

`tests/unit/vdevice/faults.test.ts` 必须覆盖 8 类动作各至少一条：

1. `drop`：匹配 `{func:0x12, nth:1}` → 第一次读被丢（`match` 返回 `{action:'drop'}`）。
2. `delay`：`match` 返回 `{action:'delay', ms:200}`；同一规则 `times:1` 再匹配返回 `null`。
3. `dropAck`、`crcError`、`ackError(code:5)`、`powerLoss`、`disconnect(ms:300)`、`sticky` 各一条。
4. `parseFaults` 对未知 action、缺 `code`、`nth:0` 抛错。
5. `nth` 计数：`{nth:3, times:2}` 只在第 3、4 次命中。
6. 规则顺序：两条规则同时匹配时取第一条。

`tests/unit/vdevice/package.test.ts` 必须包含：

1. `buildPackage({ image: 1..1024, modelCode:'JYM001', version:{1,2,3} })` 的帧序列：`frames[0]` 等于 `C4 0B 00 00 03 08 10 01 00 15 FF`；`frames[1]` 长 90 且 `DFU_CMD=0x02`；其余 `DFU_CMD=0x03` 且长 265（末块除外）。
2. 全帧 SigmaCRC 通过；`FwLength === 1024`；`FwChecksum === sum32Words(image)`。
3. `tamperByte` 后 `DfuStack` 回 `0x04`。
4. `overrideLength(bytes, 0x40000)` 后，`DfuStack` 不接受（设备侧行为未定义长度上界，因此该包**只能**由上位机的 `parseImage` 拒绝；本用例只断言"生成的包 SigmaCRC 仍然全对、`FwLength` 字段被改成 0x40000"）。
5. `buildPackage` 对 `image` 长度超过 `0x30000` 抛 `RangeError`。

端到端（完成报告必须贴输出，不写成 vitest 用例）：

```powershell
$node tools/vdevice/run.mjs
curl.exe -s -X POST http://127.0.0.1:8766/control/level -H "Content-Type: application/json" -d '{"pattern":"step","value":128}'
curl.exe -s http://127.0.0.1:8766/control/stats
curl.exe -s -X POST http://127.0.0.1:8766/control/faults -H "Content-Type: application/json" -d '{"faults":[{"on":{"func":18,"nth":1},"action":"drop"}]}'
```

（真实回环到界面的验证在 SubStage 5.3 的 `selftest.mjs` 里做；本 SubStage 只需证明"侧车能按故障表改变行为"，用 `/control/stats` 的 `faultsFired` 与 `mode` 取证。）

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| E1 | 8 类故障动作各有至少 1 条自动化用例（R7-4） | `pnpm run test` 输出 |
| E2 | 设备侧完整 DFU 流程单测通过（`0x03`…`0x05`，逐字节断言状态帧） | 单测 |
| E3 | 出厂包的密文片段经 `gammaDecrypt` + `sum32Words` 得到 `0x4E0621AF` 与向量表（能与黄金样本对拍） | 单测（读真实 `.bin`） |
| E4 | `POST /control/level` 后 `GET /control/stats` 的 `levelRaw` 变化 | curl 输出 |
| E5 | `POST /control/mode {mode:'bootloader'}` 后侧车只答 SigmaBus 帧（参数帧不回执） | curl + WS 脚本输出 |
| E6 | `pnpm run typecheck` 全绿（新增 4 个 `.d.mts`） | 命令输出 |
| E7 | 子模块 `git status --porcelain third_party` 为空 | git 输出 |

---

## 8. 禁止事项

1. 不得修改 `third_party/web_hid_utils`。
2. 不得从 `tools/vdevice/**` import `src/**`（保持双向对拍）。
3. 不得让 `DfuStack` 接受未经信息帧的块（D2）；不得在 `state='failed'` 后继续写 Flash。
4. 不得用 `allowBootld: true` 作为默认值（R6-9 的边界靠它守住，默认必须 `false`）。
5. 不得在故障注入里使用同步等待；`delay`/`disconnect` 一律走 `timers`。
6. 不得把 `crcError` 实现成"截断帧"（必须保持长度不变、只改末尾两字节，否则测的是另一条路径）。
7. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. 端到端四条 curl 的输出（E4/E5）。
4. E1–E7 逐条结论与取证位置。
5. 与设计文档的偏差（无则写"无偏差"）。
6. 给 SubStage 4.2/5.3 的接线说明：如何用 `/control/faults` 复现 R6-5/R6-6/R6-7、如何用 `package.mjs` 造 R6-4 的包。
