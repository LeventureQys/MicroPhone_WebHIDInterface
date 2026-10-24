# SubStage 4.1 — DFU 帧层与镜像层

> **所属 Stage**：Stage 4（固件升级）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 1.1（`device/proto/frame.ts` 的 CRC/切包思路可参考，但 DFU 是**另一套**帧格式，不得复用 Modbus CRC）。**必须已读**：`Document/Protocol/JAT1821-Bootloader-DFU协议解析.md`（下称 **DFU 材料**）。
> **并行状态**：与 SubStage 2.x、3.x **可并行**（文件不重叠）
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

固件升级的第一半是"看懂包"：把厂商升级包（`EnterDfu + Info + N×Block` 帧序列）拆开、校验、还原明文，并在**本地离线**就挡住所有能让设备变砖的输入——设备侧没有任何长度校验，`0x39000` 的型号区被写坏就只能 SWD 救（DFU 材料 §6 ⑦）。

本 SubStage 只做纯函数：SigmaBus 帧编解码 + 镜像解析 + Gamma 加解密 + 32 位小端字累加。会话状态机在 4.2。

做完之后：给一个出厂包，能逐帧解出来并算出 `FwChecksum = 0x4E0621AF`；给一个被篡改 1 字节的包，能明确报 `checksumMismatch` 且**不发任何帧**。

---

## 2. 当前代码状态

| 文件 | 现状 |
|---|---|
| `src/renderer/src/device/dfu/` | 不存在 |
| `tests/unit/dfu/` | 不存在 |
| 出厂黄金包 | `Document/Protocol/Bootloader/Tools/Py/INNO SoftEmbe_Bootloader(PD100UGen2) MCU [内部使用].bin`（21 823 B） |

本轮已实测的事实（作为实现基准，见问题清单 §3.3）：

- 84 帧：`11 + 90 + 81×265 + 257`；全部 SigmaCRC 通过；
- `ModelCode = "Bootld"`、`ModelName = "000000"`（64 字节 ASCII，`0x00` 补齐）、`Ver = 0.0.0`、`FwLength = 20984`、`FwChecksum = 0x4E0621AF`；
- 82 个数据块（81×256 + 248），合计 20 984 B；
- Gamma 解密（前 8192 B，4 字节粒度）后首 8 字节 `B8 41 00 20 65 42 00 00`，`sum32Words(plain) = 0x4E0621AF`，`sum32Words(cipher) = 0x1390B00A`（与 DFU 材料 §7 一致，不符，证明必须对明文算）。

---

## 3. 本 SubStage 产出文件

```
src/renderer/src/device/dfu/frame.ts     新建（SigmaBus 帧编解码 + SigmaCRC + DFU 帧构造）
src/renderer/src/device/dfu/image.ts     新建（镜像解析 + Gamma + sum32 + 上界校验）
src/renderer/src/device/dfu/index.ts     新建（re-export）
tests/unit/dfu/frame.test.ts             新建
tests/unit/dfu/image.test.ts             新建
tests/unit/dfu/golden.test.ts            新建（读真实出厂包，文件缺失时 skip）
```

---

## 4. 完整契约

签名原文见 `设计文档.md` §5.9、§5.10；下面补齐设计文档未写死的实现细节。

### 4.1 `dfu/frame.ts`

常量与签名（逐字）：

```ts
export const SIGMA_START = 0xC4;
export const SIGMA_CMD_DFU = 0x0B;
export const SIGMA_CMD_ACK = 0x02;
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
export const MAX_SIGMA_FRAME = 1022;

export interface SigmaFrame {
  readonly addr: number;
  readonly cmd: number;         // 已做 cmd & 0x7F
  readonly data: Uint8Array;    // 载荷（DFU 时 data[0]=DFU_CMD、data[1]=CHIP_ID）
}
export type SigmaProblem = 'start' | 'length' | 'capacity' | 'crc' | 'addr';
export interface SigmaIssue { readonly problem: SigmaProblem; readonly offset: number; readonly detail: string }
export interface SigmaDecodeResult {
  readonly frames: readonly SigmaFrame[];
  readonly rest: Uint8Array;
  readonly issues: readonly SigmaIssue[];
}

export function sigmaCrc(bytes: Uint8Array): number;
export function encodeSigmaFrame(cmd: number, data: Uint8Array, addr?: number): Uint8Array;
export function decodeSigmaStream(buffer: Uint8Array): SigmaDecodeResult;
export function encodeDfuInfoFrame(info: DfuInfo): Uint8Array;      // 90 B
export function encodeDfuBlockFrame(data: Uint8Array): Uint8Array;   // 7 + n + 2，n ≤ 256
export function decodeDfuStatus(frame: SigmaFrame): { readonly status: number } | null;
export function decodeSigmaAck(frame: SigmaFrame): { readonly err: number } | null;
```

`decodeSigmaStream` 的重同步算法（逐条实现）：

1. 若首字节不是 `0xC4` → 记 `start` issue，丢 1 字节，重来。
2. 不足 3 字节 → `rest = buffer`。
3. `len = buf[1] | (buf[2] << 8)`（**小端**）。
4. `len < 9` 或 `len > 1022` → 记 `length`/`capacity` issue，丢 1 字节，重来。
5. `len > buf.length` → `rest = buf`。
6. `addr = buf[3]`；`addr !== 0` → 记 `addr` issue，丢弃整帧（`buf = buf.slice(len)`），重来。
7. CRC（覆盖 `buf[0..len-3]`，与 `buf[len-2] | buf[len-1] << 8` 比）不符 → 记 `crc` issue，丢 1 字节，重来。
8. 产出 `{ addr, cmd: buf[4] & 0x7F, data: buf.slice(5, len - 2) }`，`buf = buf.slice(len)`，重来。

`encodeDfuInfoFrame(info)`：`data = [DFU_CMD_INFO, 0x00, <6 字节 ModelCode ASCII>, <64 字节 ModelName ASCII 右补 0>, verX, verY, verZ, <length LE4>, <checksum LE4>]`，`data.length === 2 + 81 = 83`，整帧 90 B。`encodeSigmaFrame(SIGMA_CMD_DFU, data)`。

`encodeDfuBlockFrame(block)`：`data = [DFU_CMD_BLOCK, 0x00, ...block]`，`block.length ∈ [1,256]`，越界抛 `RangeError`。

`decodeDfuStatus(frame)`：`frame.cmd === SIGMA_CMD_DFU && frame.data[0] === DFU_CMD_STATUS && frame.data.length >= 3` → `{ status: frame.data[2] }`；否则 `null`。

`decodeSigmaAck(frame)`：`frame.cmd === SIGMA_CMD_ACK && frame.data.length >= 2` → `{ err: data[0] | (data[1] << 8) }`（**SigmaBus 数据小端**：`C4 09 00 00 02 01 00 30 FF` = `DEV_ADDR_ERR 0x0001`、`C4 09 00 00 02 03 00 2E FF` = `CHECKSUM_ERR 0x0003`）；否则 `null`。

### 4.2 `dfu/image.ts`

常量与签名（逐字）：

```ts
export interface DfuInfo {
  readonly modelCode: string;
  readonly modelName: string;
  readonly version: { readonly x: number; readonly y: number; readonly z: number };
  readonly length: number;
  readonly checksum: number;
}
export interface ParsedImage {
  readonly info: DfuInfo;
  readonly blocks: readonly Uint8Array[];
  readonly cipher: Uint8Array;
  readonly plain: Uint8Array;
  readonly frames: readonly Uint8Array[];
}
export type ImageProblem =
  | 'frame' | 'crc' | 'infoCount' | 'blockSize' | 'lengthMismatch'
  | 'checksumMismatch' | 'limitExceeded' | 'modelMissing' | 'notAligned';
export interface ImageRejection {
  readonly problem: ImageProblem;
  readonly message: string;
  readonly detail?: Readonly<Record<string, number | string>>;
}

export const GAMMA_KEY = 0x1C9CBB63;
export const GAMMA_BYTES = 8192;
export const BLOCK_BYTES = 256;
export const APP_MAX_BYTES = 0x30000;
export const BOOT_MAX_BYTES = 0x8000;
export const BOOT_MODEL_CODE = 'Bootld';

export function gammaDecrypt(bytes: Uint8Array): Uint8Array;
export function gammaEncrypt(bytes: Uint8Array): Uint8Array;
export function sum32LittleEndianWords(bytes: Uint8Array): number;
export function parseImage(bytes: Uint8Array): { readonly ok: true; readonly image: ParsedImage } | { readonly ok: false; readonly rejection: ImageRejection };
export function encodeInfoFrame(info: DfuInfo): Uint8Array;
export function encodeBlockFrame(block: Uint8Array): Uint8Array;
```

Gamma 算法（**方向不要搞反**）：

```
keyByte(i) = [0x63, 0xBB, 0x9C, 0x1C][i % 4]        // KEY = 0x1C9CBB63 的小端字节
加密：c[i] = (nibbleSwap(p[i] ^ keyByte(i)) + 0xA3) & 0xFF
解密：p[i] = nibbleSwap((c[i] - 0xA3) & 0xFF) ^ keyByte(i)
nibbleSwap(x) = ((x << 4) & 0xF0) | ((x >> 4) & 0x0F)
只处理前 min(len, 8192) 个字节，且按 4 字节粒度（n = min(len,8192) & ~3）
```

`sum32LittleEndianWords`：`s = (s + (b[i] | b[i+1]<<8 | b[i+2]<<16 | b[i+3]<<24)) >>> 0`，只在 `i + 4 <= len` 时累加（尾部不足 4 字节不参与）。

`parseImage` 的校验顺序与拒绝码（**顺序不可调换**，先粗后细）：

| 步 | 检查 | 失败码 |
|---|---|---|
| 1 | `decodeSigmaStream(bytes)` 无 issue、`rest` 为空（末帧未被截断） | `frame`（有 issue 且含 `crc` 时用 `crc`） |
| 2 | `frames[0]`：`cmd === 0x03`、`data = [0x08,0x10,0x01,0x00]`（EnterDfu 写 `0x1008=1`） | `frame` |
| 3 | **不存在**任何 `DFU_CMD=0x02` 信息帧 | `infoCount` |
| 4 | 信息帧必须恰在 `frames[1]`、`data[0] === 0x02`、`data.length === 83`（整帧 90 B） | `frame`（`detail:{index}`） |
| 5 | 其余帧：`cmd === 0x0B`、`data[0] === 0x03`、`data.length` = `2 + n`（`n ∈ [1,256]`）；且至少有一个数据块 | `frame` |
| 6 | 每个非末块 `n === 256`；全部块（含末块）`n % 4 === 0` | `blockSize` / `notAligned` |
| 7 | `info.modelCode` 为 6 个可打印 ASCII（`0x20..0x7E`） | `modelMissing` |
| 8 | `info.length <= (modelCode === BOOT_MODEL_CODE ? BOOT_MAX_BYTES : APP_MAX_BYTES)`（**上界先于长度一致性**） | `limitExceeded` |
| 9 | `info.length === Σn` | `lengthMismatch` |
| 10 | `sum32LittleEndianWords(gammaDecrypt(cipher)) === info.checksum` | `checksumMismatch` |

`message` 用简短英文技术文案（UI 负责翻译），例如 `firmware length 262144 exceeds 196608 for model JYM001`。`detail` 携带 `{ length, limit, modelCode, expected, actual }` 中可用的字段。

`parseImage` **不得抛异常**（包括 `RangeError`）：所有入参形状问题都转成 `{ ok:false }`。

### 4.3 `dfu/index.ts`

```ts
export * from './frame';
export * from './image';
```

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| 空文件 / 1 字节 | `{ ok:false, problem:'frame' }` |
| 只有 EnterDfu 帧 | `{ ok:false, problem:'infoCount' }` |
| 帧序错乱（Info 在 Block 之后） | `{ ok:false, problem:'frame' }` |
| 末块不是 4 的倍数 | `{ ok:false, problem:'notAligned' }` |
| `FwLength` 与块总长不符 | `{ ok:false, problem:'lengthMismatch', detail:{ length, actual } }` |
| `FwLength = 0x40000` 且 CRC 全对 | `{ ok:false, problem:'limitExceeded', detail:{ limit: 0x30000 } }` |
| `ModelCode = "Bootld"` 且 `FwLength > 0x8000` | `{ ok:false, problem:'limitExceeded', detail:{ limit: 0x8000 } }` |
| `ModelCode` 含不可打印字节 | `{ ok:false, problem:'modelMissing' }` |
| 篡改 1 字节（明文区的 CRC 与 FwChecksum 都不改） | 帧 CRC 先失败 → `{ ok:false, problem:'crc' }`；**若篡改后再重新计算帧 CRC（模拟"包是合法的但内容不对"）→ `checksumMismatch`** |
| `encodeDfuBlockFrame` 传 257 字节 | 抛 `RangeError` |
| `encodeSigmaFrame` 数据段超长（整帧 > 1022） | 抛 `RangeError` |

---

## 6. 测试要求

```powershell
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node $pnpm run test
& $node $pnpm run typecheck
```

`tests/unit/dfu/frame.test.ts` 必须包含：

1. `encodeSigmaFrame` 生成 EnterDfu 帧 → `C4 0B 00 00 03 08 10 01 00 15 FF`（逐字节）。
2. 状态帧：`encodeSigmaFrame(0x0B, [0x01,0x00,0x03])` → `C4 0A 00 00 0B 01 00 03 23 FF`；`0x05` → `... 21 FF`。
3. `decodeSigmaStream` 解上述三帧 → `cmd`/`data` 正确。
4. 重同步：`[0x00,0x01] + 合法帧` → 有 `start` issue 且仍解出合法帧；CRC 错 → `crc` issue；`len=8` → `length` issue；`len=1023` → `capacity` issue；`addr=1` → `addr` issue 且该帧被丢弃。
5. 一帧跨多条 63 B 切片（265 B 块帧切 5 片）→ 分 5 次喂入后解出 1 帧。
6. `decodeDfuStatus` / `decodeSigmaAck` 对非对应帧返回 `null`。
7. `encodeDfuBlockFrame(256 字节)` 长度 265；`(1 字节)` 长度 10；`(257 字节)` 抛 `RangeError`。

`tests/unit/dfu/image.test.ts` 必须包含（用一个小型合成包：明文 1024 B）：

1. 用 `gammaEncrypt` + `sum32LittleEndianWords` + `encodeInfoFrame` + `encodeDfuBlockFrame` 自造一个合法包，`parseImage` → `ok:true`、`blocks.length === 4`、`plain` 与原始明文一致。
2. 篡改 1 字节 → `crc` 失败；**重新算帧 CRC 后再篡改**（改 `FwChecksum` 之外的明文）→ `checksumMismatch`。
3. `FwLength` 改成 `0x40000`（块不变，重新算 Info 帧 CRC）→ `limitExceeded`（上界检查先于长度一致性，R6-3 的字面场景）；另加一条：`FwLength` 与块总长不一致但两者都在上界内 → `lengthMismatch`。
4. 末块长度改成非 4 倍数（重新算 CRC）→ `notAligned`。
5. 帧序错乱（把 Info 帧挪到 Block 之后，注意 Info 帧含长度/校验和，挪动后仍需 CRC 正确）→ `frame`。
6. `gammaEncrypt` / `gammaDecrypt` 互逆（1024 B 与 9000 B 各一条；9000 B 时第 8192 字节之后不变）。
7. `sum32LittleEndianWords` 对 `[01 00 00 00, 02 00 00 00]` 返回 3；对 3 字节输入返回 0。
8. 空输入 → `frame`；只有 EnterDfu → `infoCount`。

`tests/unit/dfu/golden.test.ts`（**R6-1**）必须：

1. 读 `Document/Protocol/Bootloader/Tools/Py/INNO SoftEmbe_Bootloader(PD100UGen2) MCU [内部使用].bin`（用 `fs.readFileSync` + `path.resolve(__dirname, '../../..', ...)`；vitest 环境是 happy-dom，但 Node 的 `fs` 可用——若不行则改用 `import.meta.url` 解析）。
2. 断言文件大小 21 823、SHA-256 等于首次运行算出的常量（把常量写进测试文件并在报告里贴出）。
3. `decodeSigmaStream` 无 issue、帧数 84、各帧长度序列 `[11, 90, 265×81, 257]`。
4. `parseImage` → `ok:true`；`info.modelCode === 'Bootld'`、`info.modelName === '000000'`、`info.version` 全 0、`info.length === 20984`、`info.checksum === 0x4E0621AF`、`blocks.length === 82`。
5. `gammaDecrypt(image.cipher)` 首 8 字节等于 `B8 41 00 20 65 42 00 00`；`sum32LittleEndianWords(plain) === 0x4E0621AF`。
6. **编码对拍**：对每个块 `encodeBlockFrame(block)` 与包内对应原帧**逐字节一致**；`encodeInfoFrame(info)` 与 `frames[1]` 逐字节一致（R6-1 的核心）。
7. 文件不存在时 `it.skip` 并 `console.warn` 一行原因（不得静默通过）。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| H1 | `pnpm run test`、`pnpm run typecheck` 全绿 | 命令输出 |
| H2 | 出厂包 84 帧全解、`FwChecksum 0x4E0621AF`、向量表 `200041B8/00004265`（R6-1） | `golden.test.ts` 输出 |
| H3 | 编码对拍：Info 帧与 82 个块帧逐字节等于包内原帧（R6-1） | `golden.test.ts` |
| H4 | 篡改 1 字节被拒（R6-2）、`FwLength=0x40000` 被拒（R6-3）、超 192 KB 被拒 | `image.test.ts` |
| H5 | `dfu/frame.ts`、`dfu/image.ts` 无 DOM/定时器/WebHID 引用 | grep 取证 |
| H6 | 子模块与 `Document/Protocol/**` 未被修改 | `git status --porcelain` 输出 |

---

## 8. 禁止事项

1. 不得用 `zlib.crc32`/`CRC-32` 之类的现成算法代替 `sum32LittleEndianWords`（DFU 材料 §4.2：名字叫 CRC32，实际是累加和）。
2. 不得对**密文**算校验和（必须是明文）。
3. 不得调换 `parseImage` 的校验顺序（先结构后内容，先长度后校验和）。
4. 不得把 `parseImage` 写成抛异常；不得用 `try/catch` 吞掉 CRC 失败。
5. 不得复用参数协议的 Modbus CRC（两套校验完全不同）。
6. 不得修改 `third_party/**`、`Document/Protocol/**`（含黄金包）。
7. 不得在测试里把黄金包复制到 `artifacts/` 或 `tests/` 下（只读引用 + 哈希）。
8. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. `pnpm run test`、`pnpm run typecheck` 完整输出。
3. `golden.test.ts` 的断言输出（含 SHA-256 常量、帧数、`FwChecksum`、向量表、编码对拍结果）。
4. H1–H6 逐条结论与取证位置。
5. 与设计文档的偏差（无则写"无偏差"）。
6. 给 SubStage 4.2 的说明：`parseImage` 返回的 `blocks` 是密文还是明文、发送时应传哪一个、`DfuSession` 是否应重新编码。
