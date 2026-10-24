# SubStage 3.1 — 参数会话（队列 / 超时 / 重试 / 合并 / 轮询 / 诊断数据面）

> **所属 Stage**：Stage 3（参数链路）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 1.1（`device/proto/{frame,codec,timing}.ts`）、SubStage 1.2（`device/registers.ts`）。本任务会 import 这两个模块。
> **并行状态**：与 SubStage 2.x、4.1 **可并行**（文件不重叠）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

参数协议是"一问一答"的：ACK 帧不带原功能码与地址，多请求并行时无法配对（参数协议 §附A.4）。因此整条链路必须有一个**唯一在途请求槽**，并在这个约束下实现：写节流合并、超时重试、错误码映射、上电回读同步、50 Hz 电平轮询、诊断环形缓冲与统计。

本 SubStage 输出一个**不碰 WebHID / DOM** 的会话对象：出站靠注入的 `send`，入站靠 `handleBytes`，时间靠注入的 `Clock`/`Timers`/`TIMING`。这样 SubStage 3.2 只需把设备句柄接上去，单测则可用假时钟精确断言每个超时边界。

---

## 2. 当前代码状态

| 文件 | 现状 |
|---|---|
| `src/renderer/src/device/proto/session.ts` | 不存在 |
| `src/renderer/src/device/diagnostics.ts` | 不存在 |
| `src/renderer/src/device/proto/{frame,codec,timing}.ts` | SubStage 1.1 产出，可直接 import |
| `src/renderer/src/device/registers.ts` | SubStage 1.2 产出，提供 `PRESET_START` / `PRESET_COUNT` / `LEVEL_ADDR` / `DEV_INFO` / `CONFIG` / `findRegister` / `toRaw` / `fromRaw` / `decodeAsciiWords` |
| `src/renderer/src/device/transport.ts` | `LevelFrame` 无 `inputValid/outputValid`；`TransportError`/`DiagEntry`/`SessionStats` 尚未定义（本任务在 `session.ts` 里定义并导出，3.2 再从 `transport.ts` re-export） |

---

## 3. 本 SubStage 产出文件

```
src/renderer/src/device/proto/session.ts      新建（ParamSession + 类型 + levelToDb）
src/renderer/src/device/diagnostics.ts        新建（DiagnosticsHub）
tests/unit/proto/session.test.ts              新建
tests/unit/diagnostics.test.ts                新建
```

---

## 4. 完整契约

类型与签名原文见 `设计文档.md` §5.5、§5.12；下面复述**必须逐字实现**的部分，并补齐设计文档未写死的细节。

### 4.1 导出类型（`session.ts`）

```ts
export type SessionPhase = 'idle' | 'syncing' | 'ready' | 'error';

export interface TransportError {
  readonly kind: 'timeout' | 'crc' | 'readOnly' | 'range' | 'addr' | 'len' | 'disconnected';
  readonly addr?: number;
  readonly id?: string;
  readonly ack?: number;
  readonly message: string;
}

export interface DiagEntry {
  readonly at: number;
  readonly dir: 'out' | 'in';
  readonly hex: string;
  readonly summary: string;
  readonly level: 'info' | 'warn' | 'error';
}

export interface SessionStats {
  readonly outFrames: number;
  readonly inFrames: number;
  readonly crcErrors: number;
  readonly timeouts: number;
  readonly retries: number;
  readonly droppedPolls: number;
  readonly queueDepth: number;
}

export interface PresetSnapshot {
  readonly start: number;
  readonly values: Readonly<Record<number, number>>;
}

export interface DeviceSnapshot {
  readonly modelCode: string;
  readonly deviceName: string;
  readonly firmware: { readonly x: number; readonly y: number; readonly z: number; readonly build: number };
  readonly firmwareType: number;
  readonly vid: number;
  readonly pid: number;
  readonly serial: string;
  readonly comErrAck: number;
}

export interface ParamSessionOptions {
  readonly send: (reports: readonly Uint8Array[]) => void | Promise<void>;
  readonly reportIds?: ReportIds;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly timing?: Partial<typeof TIMING>;
  readonly onPhase?: (phase: SessionPhase) => void;
  readonly onEcho?: (addr: number, raw: number) => void;
  readonly onError?: (error: TransportError) => void;
  readonly onDiag?: (entry: DiagEntry) => void;
  readonly onLevel?: (sample: { readonly raw: number; readonly at: number }) => void;
  readonly onStats?: (stats: SessionStats) => void;
  readonly ringSize?: number;
}

export class ParamSession {
  constructor(options: ParamSessionOptions);
  phase(): SessionPhase;
  stats(): SessionStats;
  diagnostics(): readonly DiagEntry[];
  async sync(): Promise<{ readonly preset: PresetSnapshot; readonly device: DeviceSnapshot }>;
  write(entries: readonly WordPair[]): void;
  read(addrs: readonly number[]): Promise<RandReadReply>;
  setPolling(enabled: boolean): void;
  handleBytes(bytes: Uint8Array): void;
  dispose(): void;
}

/** raw 0..256 → dBFS（线性假设，Q4 待确认）：clamp(raw/256,0,1) * 96 - 96 */
export function levelToDb(raw: number): number;
```

### 4.2 行为契约（逐条实现，单测逐条断言）

| 编号 | 规则 |
|---|---|
| S-a | **唯一在途槽**：任何时刻最多一个未完成请求。新请求进 FIFO 队列；`stats().queueDepth` 等于队列长度（不含在途）。 |
| S-b | **写合并**：`write()` 不立刻发帧，只把 `{addr: raw}` 并入待发表（同 `addr` 后值覆盖前值），窗口 `timing.writeThrottleMs`（默认 **110 ms**，见设计 §12 R-22）到期后打包。打包时按 addr 升序分组：**同属 `[PRESET_START, PRESET_START+PRESET_COUNT-1]` 且 addr 连续（+1）的组**，长度 ≥2 用 `encodeSeqWrite`，长度 1 用 `encodeRandWrite`；非预设区（如 `0x1007`）一律单独 `encodeRandWrite`。帧按分组顺序入队。 |
| S-c | **重试**：单请求发出后 `timing.requestTimeoutMs` 未回 → `timeouts++`，重发同一帧，最多 `timing.requestRetries`（默认 2，总尝试 3 次）。收到 `ACK_CHECKSUM_ERR`/`ACK_DEV_ADDR_ERR` 也重试（同上限，`retries++`）；`ACK_READ_ONLY_ERR`/`ACK_DATA_ERR`/`ACK_LEN_ERR` **不重试**，直接完成该请求并派发 `onError`（`kind` 分别为 `'readOnly'`/`'range'`/`'len'`）。 |
| S-d | **进 error**：同一请求三次尝试都失败（超时或可重试类 ACK），`phase='error'`、清空队列与待发表、派发 `onError`（超时→`'timeout'`，ACK→对应 kind）、`onPhase('error')`。 |
| S-e | **sync()**：① 发一条 `encodeSeqRead(PRESET_START, PRESET_COUNT)`（114 个），成功后将 `values` 里 `LEVEL_ADDR` 的项**删除**（R4-8），其余逐 addr 派发 `onEcho`；② 发**一条** `encodeRandRead` 读 **46 个地址**（见下），组 `DeviceSnapshot`；③ 两步都成功后 `phase='ready'`、`onPhase('ready')`、若 `setPolling(true)` 已调用则启动轮询；④ 任一步最终失败按 S-d 进 `error` 并 reject 该 Promise（`Error` 携带 `TransportError`）。 |

`sync()` 第 ② 步的地址表（**顺序固定**，请求数据 92 B、响应 184 B）：

```
0x0000 0x0001 0x0002 0x0003 0x0004 0x0005   // modelCode(3) + deviceName(3 词 = 6 字符)
0x000B 0x000C 0x000D 0x000E                 // firmware X/Y/Z/Build
0x000F                                      // firmwareType
0x0016                                      // vid
0x0017                                      // pid
0x001E .. 0x003D                            // serial 32 词
0x1007                                      // comErrAck
```

`DeviceSnapshot` 八个字段全部由这一次应答装配（`decodeAsciiWords` 处理字符串、去尾部 `0x00`；缺项容错取 `0`/`''`）。
| S-f | **轮询**：`phase==='ready'` 且 polling 开启时，每 `timing.pollIntervalMs` 触发一次：若队列非空（有待发写或有在途请求）→ 丢本次（`droppedPolls++`）；否则发 `encodeRandRead([LEVEL_ADDR])`，`onLevel` 派发 `{ raw, at }`。轮询请求超时 `timing.pollTimeoutMs` 未回 → 丢弃该次（`droppedPolls++`）、**不重试**、不改变 `phase`。 |
| S-g | **入站**：`handleBytes` 把字节并入内部缓冲，调 `decodeStream`；`issues` 逐条计数（`crc` → `crcErrors++`，其余计入诊断 warn 条目）；`frames` 逐条处理；`rest` 留到下次。`inFrames` 按解出的帧数累加。 |
| S-h | **应答归属**：在途请求为读（`0x12`/`0x13`）时，收到的读响应帧即为应答；在途请求为写（`0x10`/`0x11`）时，收到 `0x02` 即为应答。收到与在途类型不匹配的帧 → 记一条诊断 warn（`level:'warn'`，`summary` 含 `unexpected`），丢弃该帧，不改变在途状态。 |
| S-i | **诊断**：每条出站帧一条 `DiagEntry`（`dir:'out'`），每条入站帧一条（`dir:'in'`）；`hex` 为整帧大写空格分隔；`summary` 形如 `写 0x2024 OnOff = 1` / `读 0x2000..0x2071 (114)` / `ACK 0x0003 校验错`；错误类条目 `level:'error'`。环形缓冲长度 `ringSize`（默认 500），`diagnostics()` 按时间升序返回。 |
| S-j | **error 后**：`phase==='error'` 时 `write()` 直接丢弃并**只派发一次** `onError({kind:'disconnected', message})`；`read()` 直接 reject。`sync()` 可从 `error` 重新发起（重连场景），成功后回到 `ready`。 |
| S-k | **dispose()**：清空所有定时器（节流窗口、在途超时、轮询），此后任何方法都不再派发事件、不再调用 `send`。 |
| S-l | **异常隔离**：`send` 抛错或返回 rejected Promise → 按"通道错误"处理：`phase='error'`、`onError({kind:'disconnected'})`、停轮询。不得让异常穿出到调用方。 |
| S-m | **统计**：每次统计变化后调 `onStats(stats)`（合并到一次微任务，避免每帧一次回调——用 `queueMicrotask` 或 `Promise.resolve().then` 去重）。 |

### 4.3 `transport.ts` 的 forward note（本任务不实现）

`TransportError`/`DiagEntry`/`SessionStats` 由本任务在 `session.ts` 定义；SubStage 3.2 会用 `export type { ... } from './proto/session'` 在 `transport.ts` 里 re-export，避免重复定义。

### 4.4 `device/diagnostics.ts`

```ts
export interface DiagnosticsStats extends SessionStats {}   // 直接复用
export class DiagnosticsHub extends EventTarget {
  constructor(options?: { readonly ringSize?: number });
  push(entry: DiagEntry): void;                 // 环形，超出丢最旧；派发 'entry' 事件
  entries(): readonly DiagEntry[];              // 时间升序
  update(stats: Partial<SessionStats>): void;   // 合并更新；派发 'stats' 事件
  stats(): SessionStats;
  toText(): string;                             // 见下
  clear(): void;
}
export const ENTRY_EVENT = 'entry';
export const STATS_EVENT = 'stats';
```

`toText()` 格式（逐行，供复制贴单，R8-3）：

```
# MIC STUDIO 诊断日志
设备：JYM001 MIC M001 / 固件 1.0.0.0 / VID 0x0A67 PID 0x0010 / SN VHID-MIC-M001
统计：出帧 42 / 入帧 42 / CRC 错 0 / 超时 0 / 重试 1 / 丢弃轮询 3 / 队列 0
12:00:00.123  →  00 10 00 0A 20 24 00 01 43 C0   写 0x2024 OnOff = 1
12:00:00.128  ←  00 02 00 08 00 00 F8 19   ACK 0x0000 成功
```

首两行在 `update()` 提供过 `deviceSummary` 之前显示 `设备：未连接`。为此 `update()` 的入参扩展为 `Partial<SessionStats> & { deviceSummary?: string }`（`stats()` 不返回该字段）。

---

## 5. 行为与错误处理

| 场景 | 必须的行为 |
|---|---|
| `send` 为同步函数但内部异步抛错 | 用 `try/catch` 包住调用；`Promise.resolve(send(...)).catch(...)` 同样处理 |
| `handleBytes` 收到空数组 | 什么也不做 |
| 收到 `0x02` ACK 但当前无在途请求 | 诊断 warn，丢弃 |
| 收到读响应但当前在途是写 | 诊断 warn，丢弃（S-h） |
| `sync()` 正在进行时调用 `write()` | 写进待发表，`sync` 成功后按 S-b 窗口发出（R4-2：排队而非丢弃） |
| 在 `phase==='error'` 时调用 `sync()` | 允许，视为重连；先清队列与待发表 |
| `read()` 与在途写冲突 | 排队（与普通请求同队列），完成后 resolve |
| 入站帧 CRC 错 | `crcErrors++` + 诊断 error 条目；**不重试**（重试是请求侧的事） |
| `timing` 传入部分字段 | 与 `TIMING` 合并，未传的用默认值 |

---

## 6. 测试要求

```powershell
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node $pnpm run test
& $node $pnpm run typecheck
```

`tests/unit/proto/session.test.ts` 必须用一个"假设备"辅助：记录 `send` 收到的每个 63 B 报告，可配置"收到第 N 帧后自动回什么"（用 `decodeStream` 解出请求，再用 `encodeFrame`/`buildAck` 造应答）。必须覆盖：

1. **R3-1 串行**：连续 `write()` 10 个不同地址，断言 `send` 的调用序列里任意时刻最多一个未应答请求（用"回执前调用计数"断言）。
2. **R3-2 重试**：注入 30% 丢帧（按序号丢弃在途请求的应答），断言最终全部写成功、`retries > 0`、无重复写导致的值不一致（用最终寄存器模型断言）。
3. **R3-3 只读零出帧**：这条在 3.2 校验（transport 层拦截）；本任务只断言"会话本身不知道只读"——**不写此用例**，改为在 3.2 里测。会话侧改为测：收到 `ACK_READ_ONLY_ERR` → 不重试、`onError({kind:'readOnly'})`、`phase` 保持 `ready`（R3-4 的一半）。
4. **R3-5 三次超时进 error**：假时钟推进 `requestTimeoutMs` 三次，断言 `phase==='error'`、`onPhase('error')`、`onError({kind:'timeout'})`，之后 `write()` 派发一次 `disconnected` 且不再调用 `send`。
5. **R3-6 合并生效**：假时钟下 2 秒内调用 `write()` 120 次（每次值都变），推进 2 秒，断言 `send` 被调用 ≤ 20 次；且每次的载荷解码后与最后一次值一致。
6. **S-b 合并成 `0x11`**：同一窗口写 `0x205D`、`0x205E`、`0x205F` → 一条 `func 0x11` 且 `首址=0x205D`、`数目=3`；写 `0x2024` 与 `0x2026`（不相邻）→ 两条 `0x10`。
7. **S-e 回读**：假设备回一条 114 个值的 `0x13` 响应（`0x2057` 给 200）**与一条 46 地址的 `0x12` 响应**；断言 `preset.values[0x2057]` **不存在**、`onEcho` 次数 = 113、请求数据恰好 92 B 且地址序列与 §4.2 的表逐项相等、`DeviceSnapshot` 八个字段全部正确（`modelCode='JYM001'`、`deviceName='M001'`、`firmware={1,0,0,0}`、`firmwareType=1`、`vid=2663`、`pid=16`、`serial='VHID-MIC-M001'`、`comErrAck=0`）；可另加一条"设备少回字段"的容错用例（缺失取 `0`/`''`）。
8. **R4-2 回读期间写排队**：`sync()` 未完成时 `write()` 3 次，断言 `send` 只有 `0x13`/`0x12` 两条回读帧；`sync` resolve 后推进节流窗口，断言写帧按序发出。
9. **R5-2 轮询频率**：`sync` 成功后开轮询，假时钟推进 1000 ms，断言 `encodeRandRead([LEVEL_ADDR])` 的次数在 45…55 之间。
10. **R5-2 轮询让位**：有写请求在途时推进一个轮询周期，断言没有发出轮询帧且 `droppedPolls === 1`。
11. **轮询超时不进 error**：轮询帧不回，推进 `pollTimeoutMs`，断言 `droppedPolls` 增加、`phase==='ready'`、无 `onError`。
12. **S-g/S-i**：喂一条半帧 + 一条完整帧，断言只解出一条、`diagnostics()` 有 1 条 out + 1 条 in；喂一条错 CRC 帧，断言 `crcErrors===1` 且诊断有 `level:'error'` 条目。
13. **S-k dispose**：dispose 后推进 10 秒，断言 `send` 调用数不再增加、无任何回调。
14. **S-l send 抛错**：`send` 第一次就抛 → `phase==='error'`、`onError({kind:'disconnected'})`、不抛异常。
15. **S-m 统计去重**：一次 `write` + 一次应答，断言 `onStats` 被调用次数 ≤ 3（不是每帧一次）。
16. `levelToDb`：`0→-96`、`128→-48`、`256→0`、`300→0`、`-5→-96`。

`tests/unit/diagnostics.test.ts` 必须包含：

1. 环形：`ringSize=3` 时推 5 条，`entries()` 长度为 3 且保留最后 3 条（R8-4）。
2. `toText()` 首行固定为 `# MIC STUDIO 诊断日志`；未 `update({deviceSummary})` 时第二行为 `设备：未连接`；推入一条"写 0x2024"后文本包含 `写 0x2024 OnOff = 1`（R8-3）。
3. `update()` 合并语义：先 `{outFrames:1}` 再 `{inFrames:2}`，`stats()` 两者都在。
4. `clear()` 后 `entries()` 为空、`stats()` 归零。
5. 事件：`push` 派发 `entry`、`update` 派发 `stats`。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| F1 | `pnpm run test` 全绿，会话用例 ≥ 16 条、诊断 ≥ 5 条 | 命令输出 |
| F2 | 120 次写 → 出帧 ≤ 20（R3-6） | 单测 5 |
| F3 | 三次超时进 `error` 且有明确 `onError`（R3-5） | 单测 4 |
| F4 | 回读结果里 `0x2057` 被丢弃（R4-8/R4-5） | 单测 7 |
| F5 | 轮询 50 Hz ±10% 且写优先让位、超时不进 error（R5-2） | 单测 9/10/11 |
| F6 | 诊断环形 500 条上限、`toText()` 可读（R8-3/R8-4） | 诊断用例 |
| F7 | `device/proto/session.ts` 与 `device/diagnostics.ts` 无 DOM / 定时器裸调用（只用注入的 `Timers`） | `grep -n "setTimeout\|setInterval\|document\.\|window\." src/renderer/src/device/proto/session.ts` 为空 |
| F8 | `pnpm run typecheck` 全绿 | 命令输出 |

---

## 8. 禁止事项

1. 不得在 `session.ts` 里直接调用 `setTimeout`/`setInterval`（必须经注入的 `Timers`）；不得读 `Date.now()`（必须经 `Clock`）。
2. 不得并行发送两个未完成请求（S-a 是硬约束，不允许"读可以并行"的例外）。
3. 不得让轮询进入重试路径或把 `phase` 打成 `error`（S-f）。
4. 不得在 `sync()` 里丢弃回读期间的写请求（S-e/R4-2）。
5. 不得把 `0x2057` 当成预设字段（S-e 必须删除）。
6. 不得在 `dispose()` 后仍持有定时器（内存泄漏会导致 R7-5 的 30 分钟稳定性用例失败）。
7. 不得修改 `device/proto/{frame,codec,timing}.ts`、`device/registers.ts`（属 1.1/1.2；确需变更必须在报告里提出并等待授权）。
8. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. F1–F8 逐条结论与取证位置。
4. 设计文档 §5.5 的 13 条规则（S-a…S-m）与用例的对应表。
5. 与设计文档的偏差（无则写"无偏差"）。
6. 给 SubStage 3.2 的接线说明：`send` 应该怎么包装 `device.sendReport`、`handleBytes` 应该喂什么（是否含 report ID）。
