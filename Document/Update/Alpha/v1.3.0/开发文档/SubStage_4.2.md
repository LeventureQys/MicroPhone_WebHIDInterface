# SubStage 4.2 — 撤销、二次确认、回读校验与日志

> **所属 Stage**：Stage 4（执行层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 4.1（`executor.mjs`、`canonicalize.ts`、两个 sink、vdevice 的 GET 路由）
> **并行状态**：与 SubStage 3.3 **可并行**；SubStage 4.3、5.1 依赖本 SubStage
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §3.3（L2 字段）、§3.6（撤销模型）、§3.7（失聪保护）、§3.8（错误码）、§3.10（日志）

---

## 1. 背景与目标

4.1 会算会写，但**没有记忆**：不能撤销、不能确认、不知道写的到底中没中。本 SubStage 把"一次 turn"变成**可回滚、可确认、可复核**的事务。

三件事：
1. **撤销栈**（深度 5）：执行前记前值，`POST /undo` 原样写回；
2. **二次确认**：`confirm` 层的写入整轮不执行，签发 30 s 有效的 `confirmToken`，用户确认后带同一 token 重新提交；
3. **回读校验 + 日志**：写完立刻读回，逐项比对，不一致即回滚并报 `E_READBACK_MISMATCH`；每轮落一行 JSONL。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/executor.mjs` | 4.1 交付：`/health` `/state` `/plan` `/apply`，`/undo` 返回 501；`confirmToken` 恒 null；`mismatch` 恒空数组 |
| `tools/voice/contract/canonicalize.ts` | 4.1 交付：已算出 `tier`、`danger`、`preview` |
| `tools/voice/sinks/*` | 4.1 交付：`readState()` / `write()` |
| `tools/vdevice/sidecar.mjs` | 已含 `GET /control/registers`（4.1 追加） |
| `artifacts/voice/` | 目录可能尚不存在（本 SubStage 负责创建） |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/contract/undo.ts` | 撤销栈（深度 5） |
| `tools/voice/contract/confirm.ts` | confirmToken 签发与校验 |
| `tools/voice/contract/readback.ts` | 回读比对与容差 |
| `tools/voice/turnlog.mjs` | turn JSONL 落盘 |
| `tools/voice/executor.mjs`（修改） | 接上上面四者 |
| `tests/unit/voice-undo.test.ts`、`voice-confirm.test.ts`、`voice-readback.test.ts` | 单测 |

---

## 4. 契约

### 4.1 `undo.ts`

```ts
export interface UndoEntry {
  turn: string;
  at: number;                                  // Date.now()
  writes: { param: string; value: number }[];   // **前值**（工程量，已夹紧）
  bandWrites: { band: number; field: EqField; value: number }[]; // 前值
  scene: string | null;
  tone: string | null;
}

export class UndoStack {
  constructor(depth?: number);                 // 默认 5
  push(entry: UndoEntry): void;                // 超过 depth 丢最旧的
  pop(): UndoEntry | null;                     // 空栈返回 null
  depth(): number;
  clear(): void;
}
```

撤销执行语义：`pop()` 得到的**前值**通过同一条 sink 写回；写入后再回读比对；成功后**不再**推回栈（避免"撤销的撤销"形成环）。

### 4.2 `confirm.ts`

```ts
export interface PendingConfirm { token: string; turn: string; planDigest: string; expiresAt: number; }

export function issue(tokenSeed: string, plan: object, ttlMs?: number): PendingConfirm;  // ttl 默认 30000
export function verify(pending: PendingConfirm | null, token: string, plan: object, now?: number):
  'ok' | 'expired' | 'mismatch' | 'missing';
export function digest(plan: object): string;   // 稳定序列化后的 sha256 前 16 位十六进制
```

- `digest(plan)` 必须对键顺序不敏感（递归排序后序列化）；
- `verify` 的顺序：`missing` → `expired` → `mismatch` → `ok`；
- 一个 token 只能成功使用一次（`ok` 之后调用方必须清空 pending）。

### 4.3 `readback.ts`

```ts
export interface Mismatch { param: string; expected: number; actual: number | null; delta: number | null; }

export function compare(expected: ReadonlyArray<{param:string,value:number} | {band:number,field:EqField,value:number}>,
                       actual: VoiceState): Mismatch[];
```

容差（**必须按参数类型区分**，不要一律用 0）：

| 参数类型 | 容差 |
|---|---|
| 整数枚举（`enc.Level`、`rgb.Mode`、各类 `Enable`/`OnOff`、`mic.mute` 等） | 0（必须完全相等） |
| `eq.band*.gain`（步进 0.1 dB） | ≤ 0.1 |
| 其它带小数的工程量（阈值、时间常数、Q、频率） | ≤ 一个 `step`（由 `registers.ts` 的 `spec.step` 取） |
| `actual` 为 `null`（读不到该寄存器） | 记为 mismatch，`delta` 为 `null` |

### 4.4 `turnlog.mjs`

```js
export function appendTurn(record: object, dir = 'artifacts/voice/exec'): string;  // 返回写出的文件路径
```
- 文件名 `exec-<yyyyMMdd-HHmmss-SSS>.jsonl`，一行一个 JSON（UTF-8 无 BOM）；
- **注意分工**：本模块写的是**执行器侧**记录（`artifacts/voice/exec/`），用于本 SubStage 自查；设计文档 §3.10 规定的"每轮一行"由 SubStage 4.3 的 `pipeline.py` 写 `artifacts/voice/turn-*.jsonl`（只有它能拿到唤醒/ASR/TTS 的耗时）。两个文件不许共用命名；
- 目录不存在则递归创建；
- 字段**必须**包含设计文档 §3.10 的全部键（由调用方提供，缺键时本模块补 `null`，不抛）。

### 4.5 `POST /apply` 的完整行为（覆盖 4.1 的半成品）

```
1. 解析 plan → canonicalize（4.1）
2. tier === 'excluded' → 409 E_ALL_EXCLUDED
3. tier === 'confirm' 且未带 confirmToken
   → 签发 token，返回 {ok:true, command:{status:'needs_confirm', confirmToken, preview, danger}}
   → 不写任何参数，不入撤销栈
4. tier === 'confirm' 且带 token
   → verify：expired → 409 E_CONFIRM_EXPIRED；mismatch → 409 E_CONFIRM_EXPIRED（消息"确认的内容变了"）
5. tier === 'immediate' 或 确认通过
   → 读当前状态（sink.readState）→ **入栈前值**
   → sink.write() → sink.readState() → compare()
   → mismatch 非空：把前值写回（回滚）→ 409 E_READBACK_MISMATCH（body 含 mismatch 数组）
   → 成功：command.status='applied'、undoTurn = 入栈的 turn、写一行 turn 日志
6. POST /undo
   → 空栈：409 E_UNDO_EMPTY
   → 否则写回前值 → 回读比对 → 成功返回 {ok:true, command:{status:'applied', preview:['撤销 '+turn]}}
```

**turn 编号规则**：`/apply` 成功、`needs_confirm` 签发、`/undo` 各消耗一个自增号；日志里的 `turn` 与响应里的 `command.turn` 必须一致。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| 撤销时 sink 不可用 | 502 `E_SINK_UNAVAILABLE`，栈顶**不弹出**（保持可重试） |
| 回滚本身失败 | 500，消息含"回滚失败"，并保留栈顶 |
| 同一 token 第二次使用 | 409 `E_CONFIRM_EXPIRED` |
| token 过期 | 409 `E_CONFIRM_EXPIRED`（消息"确认超时，请再说一次"） |
| 日志写盘失败（磁盘满/权限） | 打 warn，**不影响** apply 的成功结果（日志不是业务） |
| `artifacts/voice` 不存在 | 自动创建 |
| 撤销一个 `confirm` 层写入（静音） | 允许，且 `command.say` 追加"麦克风已恢复" |

---

## 6. 测试要求

**单元测试**（vitest，用假 sink，不依赖 vdevice）：

1. `UndoStack` 深度 5：压 6 条后 `depth()==5`，`pop()` 返回第 6 条（最旧的一条被丢）；
2. 空栈 `pop()` 返回 `null`；
3. `digest`：键顺序不同的两个等价对象 → 同一 digest；
4. `verify`：missing / expired / mismatch / ok 四条路径各一例；
5. `compare`：枚举容差 0（`enc.Level` 期望 2 实际 3 → mismatch）、`band gain` 容差 0.1（2.0 vs 2.05 → 无 mismatch）、其它参数按 step；
6. `compare`：`actual` 缺项 → 记 mismatch 且 `delta===null`；
7. `/apply`（用假 sink + 真 HTTP）序列：immediate → applied → `/undo` → 回读等于前值；
8. `/apply` confirm 流：第一次 `needs_confirm` + token，第二次带 token → `applied`；token 复用 → 409；
9. 回读不一致（假 sink 写后返回被篡改的值）→ 409 `E_READBACK_MISMATCH` 且已回滚（假 sink 里值等于前值）；
10. 日志：一次 apply 后 `artifacts/voice/turn-*.jsonl` 多一行，含 §3.10 全部键。

**启动测试**（真跑，vdevice + executor）：

```powershell
# 依次：确认流 → 撤销 → 回读
curl.exe -s -X POST http://127.0.0.1:8767/apply -H "Content-Type: application/json" -d "{\"v\":1,\"status\":\"ok\",\"say\":\"静音\",\"confidence\":1,\"ops\":[{\"kind\":\"toggle\",\"target\":\"mute\",\"on\":true}]}"
curl.exe -s -X POST http://127.0.0.1:8767/apply -H "Content-Type: application/json" -d "<同上正文 + \"confirmToken\":\"<上一步的 token>\">"
curl.exe -s -X POST http://127.0.0.1:8767/undo -H "Content-Type: application/json" -d "{}"
curl.exe -s http://127.0.0.1:8766/control/registers
```

最后一步的 `0x2022`（`mic.mute`）必须回到撤销前的值。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | 立即执行类指令 20 次（vdevice） | `applied` 20/20，回读 mismatch 0 |
| 7.2 | 静音指令 | 第一次 `needs_confirm` 且寄存器**未变**；带 token 第二次才变 |
| 7.3 | 撤销 5 步往返 | 每步回读等于执行前值；第 6 步（超出栈深）返回 `E_UNDO_EMPTY` |
| 7.4 | 人为篡改 sink 回读 | 409 `E_READBACK_MISMATCH` + 已回滚 |
| 7.5 | 10 条单测 | 全绿 |
| 7.6 | `artifacts/voice/` 下的日志 | 每次成功 apply 一行，字段齐全 |

---

## 8. 禁止事项

- 不得修改 `src/**`、`sinks/*` 的既有接口、`canonicalize.ts` 的规则数值；
- 不得在撤销后再把"撤销本身"入栈；
- 不得把 token 存到进程外（重启即失效，这是刻意的）；
- 不得让日志失败影响业务结果；
- 不得修改 `tools/vdevice/**`（4.1 已经改完，本 SubStage 不需要再动）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①10 条单测输出；②确认流的两次请求与两次寄存器快照（证明第一次没写）；③撤销 5 步的逐次回读；④篡改回读的实验过程与 409 响应；⑤一条真实 turn 日志的内容；⑥与本文不一致处；⑦未解决问题。

---

## 10. 实施回填（2026-11-24，交付后复核结论）

实测：**26/26 单测、`typecheck` 绿、`test:device` 20/20、全量回归 60 文件 / 994 例绿**；真 vdevice 上确认流「第一次不写（`0x2022` 仍 0）→ 带 token 才写（0→1）→ 撤销回 0」；撤销 5 步逐次回读全部命中；篡改回读触发 `409 E_READBACK_MISMATCH` 且已回滚（`rolledBack:true`）。

| # | 偏差 | 裁决 |
|---|---|---|
| 1 | 日志文件名：本文 §6-10 说 `turn-*.jsonl`，§4.4 说执行器侧写 `exec-*.jsonl` | **以 §4.4 为准**：执行器写 `artifacts/voice/exec/exec-<ts>.jsonl`；`turn-*.jsonl` 由 SubStage 4.3 的 `pipeline.py` 写（只有它拿得到唤醒/ASR/TTS 耗时）。两个文件不许共用命名 |
| 2 | "46 标量 + 28 = 72" 的算术 | 真实派生是 **44 可写标量 + 28 EQ = 72**。以 72 为准 |
| 3 | 无 pending 记录时的 `missing` | 映射为 **409 `E_CONFIRM_EXPIRED`**（消息说明"token 不存在或已用过"），不新增错误码 |
| 4 | 只要请求带 `confirmToken` 就校验（不限于 `tier==='confirm'`） | **接受**——按字面实现时"同一 token 再用一次"不可观测（静音后重放会变 no-op），会静默接受已消费凭证 |
| 5 | `/undo` 响应多出 `readback`/`mismatch` | **接受**（附加字段，不破坏设计文档 §3.8 形状；§4.2 契约表本来就要求向 4.3/5.1 提供这两个字段） |
| 6 | `E_READBACK_MISMATCH` 的 message 用 paramId 而非寄存器地址 | **接受**（与 L2 命名一致） |
| 7 | 实现了设计文档 §3.7 第 3 条「连续静音保护」（本文正文没写） | **接受**——`mic.mute=1` 落地后闩锁，后续 turn 的 `say` 追加"（麦克风处于静音，我可能听不到你）" |
| 8 | `/apply` 收到 `{"kind":"undo"}` 回 501（消息改为"撤销请用 POST /undo"） | **接受**；`POST /undo` 是唯一撤销入口 |
| 9 | 回滚语义细化 | **接受**：写入失败→弹栈+502；回读不一致→写回前值后弹栈（不残留 no-op 快照）；回滚本身失败→500 `E_ROLLBACK_FAILED` 且**保留栈顶**；`/undo` 失败一律 `peek` 不 `pop` |
| 10 | `turn` 编号在 `/plan` 与失败路径也消耗 | **接受**（4.1 遗留行为），日志的 `turn` 与 `command.turn` 恒一致 |

**SubStage 4.3 必须知道的两条**：

1. **撤销只能走 `POST /undo`**；把 `{"kind":"undo"}` 发给 `/apply` 会拿到 501（这是刻意的，防止静默零写入）。
2. 4.3 自己写 `artifacts/voice/turn-*.jsonl`（设计文档 §3.10 的 16 键），**不要**写进 `exec/` 目录、也不要复用执行器的文件名。
