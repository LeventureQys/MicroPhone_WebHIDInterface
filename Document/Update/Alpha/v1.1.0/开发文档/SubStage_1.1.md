# SubStage 1.1 — 参数协议帧编解码

> **所属 Stage**：Stage 1（协议真值层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：无（不依赖任何其它 SubStage 的产出）
> **并行状态**：**可并行**（与 SubStage 1.2 无文件重叠；1.2 只碰 `domain/**` 与 `device/registers.ts`，本任务只碰 `device/protocol.ts`、`device/proto/**`、`tests/unit/proto/**`）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

上位机要读写设备参数，第一个断点是：`src/renderer/src/device/protocol.ts` 现在只有 3 行占位（`HID_REPORT_ID = 0`、`MAX_PAYLOAD = 64`、`HidFrame`），没有任何编解码能力。需求 R1 要求把参数协议的帧编解码做成**纯函数**（不依赖 DOM / WebHID / 定时器），并满足 R1-1…R1-5 五条验收标准。

本 SubStage 只做协议层，不碰 UI、不碰传输队列、不碰虚拟设备。做完之后，"给一段字节，拆出零到多帧；给一个功能码与数据段，拼出一帧并算对 CRC"应当随时可单测。

---

## 2. 当前代码状态

| 文件 | 现状 | 处理 |
|---|---|---|
| `src/renderer/src/device/protocol.ts` | 3 行占位常量 | 改写（保留文件名） |
| `src/renderer/src/device/proto/` | 不存在 | 新建目录与 4 个文件 |
| `tests/unit/proto/` | 不存在 | 新建目录与 3 个测试文件 |
| 其它 | 无任何代码 import 旧的 `HID_REPORT_ID` / `MAX_PAYLOAD` / `HidFrame`（已全仓 grep 确认） | 可安全删除旧导出 |

---

## 3. 本 SubStage 产出文件

```
src/renderer/src/device/protocol.ts          改写（常量与报文切分）
src/renderer/src/device/proto/crc.ts         新建
src/renderer/src/device/proto/frame.ts       新建
src/renderer/src/device/proto/codec.ts       新建
src/renderer/src/device/proto/timing.ts      新建
tests/unit/proto/crc.test.ts                 新建
tests/unit/proto/frame.test.ts               新建
tests/unit/proto/codec.test.ts               新建
tests/unit/proto/timing.test.ts              新建（TIMING 14 字段 frozen + 值与设计一致 + defaultClock 走 Date.now + defaultTimers 可定时）
```

不修改 `tests/unit/` 下任何既有文件（本任务不应破坏既有用例）。

---

## 4. 完整契约

契约原文见 `设计文档.md` §5.1、§5.4.1–§5.4.4；下面是**必须逐字实现**的部分，若与设计文档冲突以设计文档为准并立刻报告。

### 4.1 `device/protocol.ts`

```ts
export const REPORT_ID_OUT = 0x51;
export const REPORT_ID_IN = 0x11;
export const REPORT_ID_OUT_SHORT = 0x50;
export const REPORT_ID_IN_SHORT = 0x10;
export const PAYLOAD_BYTES = 63;
export const MAX_FRAME_BYTES = 512;
export const UNIT_ID = 0x00;

export interface ReportIds {
  readonly out: number;
  readonly in: number;
}
export const DEFAULT_REPORT_IDS: ReportIds;

/** 把一整帧切成若干 63B 载荷，最后一包右侧补 0x00；空输入返回空数组 */
export function splitFrame(bytes: Uint8Array, payloadBytes?: number): Uint8Array[];
```

规则：
- `splitFrame` 只补 `0x00`，**绝不补 `0xFF` 或 `0xC4`**（需求 C1：补 `0xC4` 会启动假帧）。
- `splitFrame(new Uint8Array(0))` 返回 `[]`；调用方（传输层）负责这种情况的错误文案。
- 返回值里的每个 `Uint8Array` 长度恒为 `payloadBytes`（默认 63），且是新分配、互不共享底层缓冲。

### 4.2 `device/proto/crc.ts`

```ts
export function crc16(bytes: Uint8Array): number;   // 0..0xFFFF
export function crcLo(crc: number): number;         // crc & 0xFF，先发
export function crcHi(crc: number): number;         // (crc >> 8) & 0xFF
```

算法：多项式 `0xA001`（0x8005 反射），初值 `0xFFFF`，无最终异或，逐字节 `crc ^= b` 后 8 次 `crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1`。**不得用查表法以外的近似**；必须对任意长度（含 0 与奇数长度）稳定。

### 4.3 `device/proto/frame.ts`

常量、类型、`encodeFrame` / `decodeStream` / `frameLength` 的签名与**流式拆帧 9 步算法**以 `设计文档.md` §5.4.2 为准。实现要点复述：

0. **补位零规则**：`rest` 里出现连续两个 `0x00` 时（`buf[0] === 0 && buf[1] === 0`），丢弃 1 个前导 `0x00` 且**不记 issue**，重复到不满足或缓冲不足 2 字节。依据：`UnitID=0x00` + `Func=0x00` 不可能是合法帧，且发送方每帧末尾按 63 B 补 `0x00`（需求 C1）。必须保留"单个前导 `0x00`"（可能是被报文边界切开的下一帧 UnitID）。
1. `rest` 不足 4 字节 → 全部留作 `rest`。
2. `len = (buf[2] << 8) | buf[3]`。
3. `len < 6` → issue `'length'`，丢 1 字节，重来。
4. `len > 512` → issue `'capacity'`，丢 1 字节，重来。
5. `len > buf.length` → `rest = buf`（未收全）。
6. `expectedUnitId` 给了且不等 → issue `'unit'`，丢 1 字节，重来。
7. `func` 不在 `{0x02,0x10,0x11,0x12,0x13}` → issue `'func'`，丢 1 字节，重来。
8. CRC 不符 → issue `'crc'`，丢 1 字节，重来。
9. 产出帧，`buf = buf.slice(len)`，重来。

约束：

- **任何输入都不抛异常**（R1-4）。唯一允许抛的地方是 `encodeFrame` 在 `data.length + 6 > 512` 时抛 `RangeError`。
- `issues` 里的 `offset` 是"该 issue 被判定时，相对本次输入缓冲的起偏移"（即丢字节前的位置）；同一输入可能产生多条 issue。
- 重同步策略必须是"丢 1 字节再试"（不是丢整帧），否则坏帧后面的好帧会被一起丢掉。
- `data` 必须是新切片，不共享入参缓冲。
- 不得使用 `DataView` 之外的隐式大小端转换；`Len` 一律手工移位。

### 4.4 `device/proto/codec.ts`

签名与常量见 `设计文档.md` §5.4.3。实现要点：

| 函数 | 数据段布局 | 入参约束（越界抛 `RangeError`） |
|---|---|---|
| `encodeRandWrite(pairs)` | `(AddrHi,AddrLo,ValHi,ValLo)` 重复 | `1 ≤ pairs.length ≤ 126` |
| `encodeSeqWrite(start, values)` | `首址(2B 大端) + 数目(2B 大端) + 值(2B 大端 ×N)` | `1 ≤ N ≤ 251` |
| `encodeRandRead(addrs)` | 地址序列（每个 2B 大端） | `1 ≤ N ≤ 126` |
| `encodeSeqRead(start, count)` | `首址 + 数目` | `1 ≤ count ≤ 251` |
| `encodeAck(code)` | `CP_ACK`（2B 大端） | `code ∈ {0..5}` |

`parseReply(frame)`：
- `func === 0x02`：`data.length` 必须为 2，否则抛 `Error`；返回 `{ ack }`。
- `func === 0x13`：`data.length ≥ 4` 且 `data.length === 4 + 2 * count`，否则抛 `Error`；返回 `{ start, values }`。
- `func === 0x12`：`data.length % 4 === 0` 且 `> 0`，否则抛 `Error`；返回 `{ entries }`。
- 其它 func 抛 `Error('unexpected reply func 0x..')`。
- 说明：`parseReply` 的入参来自**已通过 CRC 校验**的帧，因此这里抛错属于实现 bug，允许抛；但传输层必须 `try/catch` 并转成 `TransportError`（见 SubStage 3.1），不得让异常穿出到 UI。

`ackToErrorCode`：`0`→`null`；`1`→`'addr'`；`2`→`'len'`；`3`→`'crc'`；`4`→`'readOnly'`；`5`→`'range'`。

### 4.5 `device/proto/timing.ts`

```ts
export interface Clock { now(): number }
export interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export const TIMING: Readonly<{ /* 字段见设计文档 §5.4.4，值必须一致 */ }>;
export function defaultClock(): Clock;   // 用 Date.now
export function defaultTimers(): Timers; // 用 setTimeout / clearTimeout
```

`TIMING` 必须 `Object.freeze`，字段与数值**逐字**照 `设计文档.md` §5.4.4（`requestTimeoutMs: 500` … `dfuBlockBytes: 265`）。

---

## 5. 行为与错误处理

| 场景 | 必须的行为 |
|---|---|
| 输入含半帧（如 30 B 的 0x13 响应头 + 部分数据） | 不产生帧，`rest` 保留全部输入，`issues` 为空 |
| 帧中间插入随机垃圾字节 | 产生若干 issue（`func`/`crc`/`length` 之一），随后**仍能解出**垃圾之后的好帧 |
| 帧被截断（声明 `Len=20`，只给 18 字节） | 不产生帧，`rest` 保留，`issues` 为空 |
| CRC 错 | issue `'crc'`，不产生该帧，不抛异常 |
| `Len = 6`（空 Data） | 产出 `{ func, data: Uint8Array(0) }` 的合法帧 |
| `Len = 512`（506 B Data） | 产出合法帧 |
| `Len = 513` | issue `'capacity'`，不抛异常 |
| `unitId` 不匹配 | issue `'unit'`，不产生帧 |
| `encodeFrame` 超 512 B | 抛 `RangeError` |

---

## 6. 测试要求

执行命令（PATH 里没有 node/pnpm，用绝对路径）：

```powershell
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node $pnpm run test tests/unit/proto
& $node $pnpm run typecheck
```

`tests/unit/proto/crc.test.ts` 必须包含：

1. 需求附录 A.6 的 8 条向量逐条断言（`Uint8Array` 输入 → 期望 `number`）。至少包含 `00 02 00 08 00 05 → 0x1A38`（即 Lo `0x38`、Hi `0x1A`）。
2. `crc16(new Uint8Array(0)) === 0xFFFF`。
3. 奇数长度与偶数长度各一条自洽断言（同数据追加 0 字节改变结果）。
4. `crcLo/crcHi` 与 `crc16` 的一致性。

`tests/unit/proto/frame.test.ts` 必须包含：

1. **A.7 的 11 条业务帧逐字节一致**：用 `encodeFrame` 重新编码后与文档里给的全帧 hex 完全相同。注意：需求附录 A.7 的 11 行只含 `0x10`/`0x12`/`0x13`/`0x02` 四种功能码，**没有 `0x11`**；`0x11` 的逐字节用例改用 `Document/Protocol/Modbus通讯协议说明_20261022.md` §五 的权威示例（同时是需求附录 A.6 #5）：`00 11 00 0E 20 5B 00 02 00 01 00 02 39 42`。不要为了凑齐功能码而伪造向量。
2. **六个 `CP_ACK` 码**（`0x0000` 成功 + `0x0001`–`0x0005` 五种错误）逐字节一致：`F8 19`/`39 D9`/`79 D8`/`B8 18`/`F9 DA`/`38 1A`。
3. **R1-3**：构造一条 `0x13` 响应（首址 `0x2000`、数目 `144`、`data = 292`、整帧 298 B），用 `splitFrame` 切成 5 个 63 B 载荷，逐个喂 `decodeStream` 并拼接 `rest`，最终解出的帧与原始帧的 `func`/`data` 完全一致。
4. `Len = 6` / `Len = 512` / `Len = 513` 三条边界（`Len = 513` 用伪造头构造：`[0x00,0x13,0x02,0x01] + 任意字节`）。
5. 垃圾字节插入、截断、错 CRC、未知 func、unit 不匹配各一条，断言 `issues[0].problem` 正确且 `frames.length === 0`、不抛异常。
6. 两次 `decodeStream` 拼接等价于一次喂全（半帧 → 补齐）。
7. `frameLength` 与 `encodeFrame` 输出长度一致。

`tests/unit/proto/codec.test.ts` 必须包含：

1. 四种编码函数的返回值经 `decodeStream` 解回后结构一致（addr/values 数组逐项相等）。
2. `parseReply` 对 A.7 的 `0x12`/`0x13` 响应帧返回正确结构（`20 5B 00 00 20 5C 00 32` → 两项 `{addr, raw}`，字段名以设计文档 §5.4.3 的 `WordPair { addr, raw }` 为准；`20 00 00 02 00 00 00 01` → `start 0x2000, values [0,1]`）。
3. 越界抛 `RangeError`：`encodeRandRead` 127 个地址、`encodeSeqRead(0x2000, 252)`、`encodeRandWrite([])`、`encodeSeqWrite(0x2000, [])`。
4. `encodeAck(6 as AckCode)` 抛 `RangeError`。
5. `ackToErrorCode` 六个码全覆盖。

另外在 `tests/unit/proto/frame.test.ts` 里补一条 `splitFrame` 用例：265 B 输入 → 5 个载荷，长度全为 63，最后一包只有前 13 字节是有效数据、其余为 `0x00`。

---

## 7. 可观察验收标准

| # | 标准 | 取证方式 |
|---|---|---|
| A1 | `pnpm run test tests/unit/proto` 全绿，且新增用例数 ≥ 25 | 命令输出 |
| A2 | 需求附录 A.6 的 8 条 CRC 向量、A.7 的 11 条业务帧全部逐字节通过 | 测试名里包含向量原文 |
| A3 | `decodeStream` 对任意输入都不抛异常（含随机字节 fuzz 100 次） | 一条 100 轮 `Math.random` 生成的 fuzz 用例 |
| A4 | `pnpm run typecheck` 通过；`device/proto/{crc,frame,codec}.ts` 与 `device/protocol.ts` 里没有 `setTimeout`/`document`/`navigator`/`window` 字样；`timing.ts` 是**唯一定时器出口**（`defaultTimers()` 内的 `setTimeout`/`clearTimeout` 允许，且仅此一处） | `grep` 取证 |
| A5 | 既有测试未被破坏（`pnpm run test` 全绿） | 命令输出 |

---

## 8. 禁止事项

1. 不得修改 `third_party/web_hid_utils`。
2. 不得在 `device/proto/**` 引入 DOM、定时器、WebHID、Electron API；不得 import 任何渲染进程模块（本层必须能被 Node 直接跑）。
3. 不得为了"帧能解出来"而放宽 CRC 或 `Len` 校验；不得用 `try { } catch { }` 吞掉解析错误。
4. 不得在 `decodeStream` 里分配与输入等长的临时缓冲（性能与内存），除非是最终产出的 `data` 切片。
5. 不得硬编码 report ID（本 SubStage 只在 `protocol.ts` 定义常量，其它模块经 `ReportIds` 传入）。
6. 不得留 TODO/FIXME/emoji；注释只写"为什么"。
7. 不得改动 `tests/unit/` 下既有文件。

---

## 9. 完成报告要求

报告必须包含：

1. 产出文件清单（相对路径 + 行数）。
2. `pnpm run test tests/unit/proto` 的完整输出（用例数与通过数）。
3. `pnpm run typecheck` 输出。
4. A1–A5 五条的逐条结论与取证位置。
5. 与设计文档的任何偏差（没有则写"无偏差"）。
6. 遇到的问题与自制决策（若无写"无"）。
