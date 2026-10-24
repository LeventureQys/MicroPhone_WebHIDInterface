# SubStage 5.3 — 端到端自检、覆盖率、文档同步与门禁

> **所属 Stage**：Stage 5（面板 / 真机 / 工程化）
> **所属阶段**：阶段三（开发）
> **依赖前置**：全部前序 SubStage（1.1–5.2）。本任务只做"把所有零件装起来并证明它真的能跑"，**不新增业务功能**。
> **并行状态**：最后执行，不并行
> **任务书版本**：v1（2026-10-25）

---

## 1. 背景与目标

前面 11 个 SubStage 各自都有单测，但需求 R7-3/R7-4/R10 要的是**整链路的可复现证据**：

- R7-3：R3/R4/R5/R6 的全部验收用例都能在虚拟下位机上跑通；
- R7-4：8 类故障注入各有至少 1 个自动化用例；
- R7-5：侧车 30 分钟连续运行内存不增长、无未处理异常；
- R10-1：`typecheck`/`test`/`build` 三绿；
- R10-2：协议层与镜像层覆盖率 ≥ 90%；
- R10-3：一条命令拉起虚拟下位机 + 侧车，退出清理；
- R10-4：无新增运行时依赖；
- §7.2 DoD：交付《真机到位后的 30 分钟联调清单》。

本任务交付一个可重复执行的 `selftest.mjs`、一份覆盖率门禁、一份真机清单，并把 `AGENTS.md` 的事实表更新到与代码一致。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/vdevice/{run,sidecar,device-stack,dfu-stack,faults,level,package}.mjs` | 2.x 产出，控制面 `/control/*` 可用 |
| `tools/vdevice/selftest.mjs` | 不存在 |
| `tests/unit/**` | 1.x/3.x/4.x/5.x 产出的单测 |
| `package.json` | `scripts` 无 `test:device` / `test:coverage`；`devDependencies` 无覆盖率工具 |
| `AGENTS.md` | 仍写"36 项标量""3BandDrc low→mid→high""参数范围以效果器参数范围.xlsx 为准""`device/protocol.ts` 仅占位""内部段频点 1122/3556/11220" |
| `Document/Update/Alpha/v1.1.0/` | 需求、问题清单、设计文档、开发文档；**无**真机联调清单 |

---

## 3. 本 SubStage 产出文件

```
tools/vdevice/selftest.mjs                             新建（端到端自检，输出 artifacts/vdevice/*.json）
package.json                                           修改（scripts + 覆盖率 devDependency）
vitest.config.ts                                       修改（coverage include/exclude 与 thresholds）
AGENTS.md                                              修改（事实表同步，见 §4.4）
Document/Update/Alpha/v1.1.0/真机联调清单.md            新建（DoD §7.2）
Document/Update/Alpha/v1.1.0/开发文档/SubStage_5.3.md  本文
```

---

## 4. 完整契约

### 4.1 `tools/vdevice/selftest.mjs`

```
用法：node tools/vdevice/selftest.mjs [--keep] [--port 8765] [--control-port 8766] [--timeout-ms 60000]
退出码：0 = 全部通过；1 = 有用例失败；2 = 环境不可用（Python 缺失/端口占用）
```

行为：

1. 若 `/healthz` 不通 → 用 `run.mjs` 的同样方式拉起桥 + 侧车（复用其导出函数；为此把 `run.mjs` 里的 `startBridge`/`startSidecar` 提成可 import 的函数，并在 `run.mjs` 的 `main()` 里调用）。`--keep` 时不清理，便于人工观察。
2. 逐条跑下表用例，每条前置 `POST /control/reset`，逐条记录 `{ id, name, ok, detail, durationMs }`。
3. 汇总写 `artifacts/vdevice/selftest-<timestamp>.json` 与同名 `.log`；stdout 打印一行一例的 `PASS/FAIL`；末尾打印 `SUMMARY passed=<n> failed=<m>`。
4. 任何用例抛异常都不得让进程崩掉（`try/catch` 每例）。

用例表（**编号即验收报告里的证据编号**）：

| ID | 场景 | 步骤 | 通过判据 |
|---|---|---|---|
| T01 | 设备发现（R7-1） | `GET /api/devices` | 含 `mic-m001`，input `0x11` 与 output `0x51` 的 `byteLength` 均为 63 |
| T02 | 随机读往返（R7-2） | 经 WS 让上位机侧发一条 `0x12` 读 `0x2057` | 端到端 ≤ 5 ms（用 `stats.lastRoundTripMs`） |
| T03 | 回读全量（R4-1） | `POST /control/registers` 写一组已知值 → 上位机 `readAll()` | 逐项与寄存器一致（至少 10 项断言） |
| T04 | 写参数 + 只读拦截（R3-1/R3-3） | 写 `0x2025` 与 `gain.Mic` | `0x2025` 落地；`gain.Mic` 零出帧（`stats.rejectedReadOnly` 不变、`framesIn` 不增） |
| T05 | 超范围（R3-4） | 注入 `ackError(5)` → 写 `0x2024` | 收到 `range` 错误、设备寄存器未变 |
| T06 | 三次超时进 error（R3-5） | 注入 `disconnect(ms:5000)` → 连写 | `phase==='error'`、之后无出帧 |
| T07 | 写合并（R3-6） | 2 s 内 120 次 `write()` | 设备侧 `framesIn` 增量 ≤ 20 |
| T08 | 电平三段（R5-1） | `POST /control/level` 三轮（0/128/256） | 上位机 `inputRms` 分别 ≤ −90 / ≈ −48 / ≥ −6 |
| T09 | 掉线电平失效（R5-3） | `disconnect(ms:3000)` | 1 s 内 `LevelFrame.inputValid === false` |
| T10 | 丢帧重试（R3-2） | `drop` 命中 30% 的 `0x12` | 所有写最终成功、`retries > 0` |
| T11 | DFU 成功（R6-4） | 用 `package.mjs` 造 `JYM001`/`1.2.3` 包 → 走 `DfuSession` | `phase==='done'`、`stats.firmwareVersion[1,2,3]`、设备回 app 模式 |
| T12 | 丢第 40 块（R6-5） | `dropAck` 命中 `dfuCmd:3, nth:40` | 第 2 轮成功、`round===2`、最终版本正确 |
| T13 | 丢第 40 块回执（R6-6） | `dropAck` 同上但用 `delay(ms:2000)` 制造超时 | 同上，且发送序列里无"同块连发" |
| T14 | 设备侧校验和错（R6-7） | 篡改包（重算帧 CRC） | `statusFail`、设备停 DFU 模式、可立即重试 |
| T15 | 升级中断电（R7-4 `powerLoss`） | `powerLoss` 命中第 10 块 | 之后无回执、`/control/stats` 的 `mode==='bootloader'`；`POST /control/mode {app}` 后恢复 |
| T16 | 帧粘连（R7-4 `sticky`） | `sticky` 命中 `func:0x13` | 上位机仍正确解出两帧（回读成功） |
| T17 | 预检拒绝 + 零出帧（R6-2/R6-3） | 篡改包 / `overrideLength(0x40000)` | `phase==='failed'`、`error.kind==='preflight'`、设备侧 `framesIn` 增量为 0 |
| T18 | `Bootld` 包入不可达（R6-9） | 用出厂包调 `controller.selectFile` | 返回 `internalOnly`、零出帧 |
| T19 | 诊断日志（R8-1/R8-2） | 一次写 + 注入 `crcError` | 日志含请求帧与 ACK；`crcErrors` +1 |
| T20 | 冷启动自恢复（R4-4） | 改寄存器 → 断开重连 | 界面参数等于新值 |

要求：

- 用例 11–18 需要"上位机侧的会话代码"。**允许** `selftest.mjs` 直接 import `src/renderer/src/device/**` 吗？**不允许**（渲染进程是 TS、依赖 DOM 别名、且会混淆"设备侧 vs 上位机侧"）。因此自检脚本用**最小 WS 客户端**自己实现"上位机行为"：用 `tools/vdevice/` 内已有的编码函数（`device-stack.mjs` 的 `buildFrame`）发请求、断言回执，并在报告里明确"这是协议级端到端，不是 UI 级"。UI 级取证由 Electron 截图与 `scripts/probes/` 负责（见验收文档）。
- 每条用例的断言必须落成 `detail` 里的结构化数据（供验收报告引用）。
- 不允许出现"skip 后算通过"：环境不可用直接退出码 2。

### 4.2 `package.json`

```jsonc
{
  "version": "1.1.0",
  "scripts": {
    "test:device": "node tools/vdevice/selftest.mjs",
    "test:coverage": "vitest run --coverage",
    "vdevice": "node tools/vdevice/run.mjs"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "1.6.1"
  }
}
```

- `dependencies` 字段**保持不存在**（R10-4）。
- 若 `@vitest/coverage-v8@1.6.1` 安装失败（网络/镜像），退化方案：删掉该依赖与 `test:coverage` 脚本，改为在验收报告里用"逐导出函数用例清单"证明覆盖，并在报告里写明偏差（R10-2 的强度下降必须显式声明）。

### 4.3 `vitest.config.ts`

```ts
test: {
  environment: 'happy-dom',
  include: ['tests/unit/**/*.test.ts'],
  coverage: {
    provider: 'v8',
    all: false,
    include: [
      'src/renderer/src/device/proto/**/*.ts',
      'src/renderer/src/device/dfu/**/*.ts',
      'src/renderer/src/device/registers.ts',
    ],
    exclude: ['**/*.d.ts'],
    thresholds: { lines: 90, functions: 85, branches: 80, statements: 90 },
  },
}
```

- 覆盖率只统计协议层与镜像层（R10-2 的原文），不要求 UI 层。
- `thresholds` 未达标时 `pnpm run test:coverage` 以非 0 退出。

### 4.4 `AGENTS.md` 同步清单（逐条改，不改历史文档）

| 位置 | 现在写的 | 改成 |
|---|---|---|
| §Reference truth 表 | "参数数值与范围以 `效果器参数范围.xlsx` 为准" | "地址/标定/权限/默认值以 `M001参数表V0.1.xlsx` 为准；`效果器参数范围.xlsx` 仅作中文标签与单位参考" |
| §Domain constants 表头 | "36 项标量（…）" | "42 项标量（…）"，并列出新增 6 项与改判的 2 项 |
| §Domain constants 3BandDrc 行 | "low→mid→high" | "low(`0x2063`)→high(`0x2068`)→mid(`0x206D`)" |
| §Domain constants EQ 默认 | "全 PEAK + 20/63/…/20000" | 前 7 段取寄存器表默认（HPF50/LPF20000/215/1000/2000/5000/10000）；内部 7 段保持对数插值，内部段实测频点写 `36/112/356/1125/3557/11247/17825` |
| §Sub-projects | 无 `device/proto`、`device/dfu`、`device/registers.ts`、`tools/vdevice`、`device/link.ts`、`device/channel-transport.ts` | 补齐，每个一行职责 |
| §WebHID 接入 边界 2 | "`select-hid-device` 仍是直接取消" | "改为按 `Usage Page 0xFF01 / Usage 0x01` 白名单放行（真机未验证）" |
| §Known traps | 无 | 新增 3 条：`#21 profile JSON 带 BOM 被桥拒绝`、`#22 虚拟设备无法真实重枚举（桥无注册/注销接口）`、`#23 `@vitest/coverage-v8` 必须与 vitest 同版本` |
| §Toolchain 日常命令 | 无 `vdevice`/`test:device` | 补 `pnpm run vdevice`、`pnpm run test:device`、`pnpm run test:coverage` |

### 4.5 `真机联调清单.md`（DoD §7.2）

必须包含（每条都要有"验证手段"与"判据"）：

1. 设备枚举与描述符核对（`GET /api/devices` 式的信息在真机上用 `navigator.hid` 打印 collections；判据：`usagePage 0xFF01 / usage 0x01`、input `0x11` 63B、output `0x51` 63B）。
2. report ID 核对（若真机 report ID 不是 `0x51/0x11`，改设置页两个输入框，判据：回读成功）。
3. 参数回读（判据：界面 42 项与设备实际一致；不符时贴在诊断面板复制的日志）。
4. 单参数写入（判据：设备侧旋钮/指示灯或再次回读变化）。
5. 只读参数写拦截（判据：诊断面板零出帧）。
6. 超范围写入（判据：界面提示"超范围"，设备值不变）。
7. 掉线恢复（拔线 → 插回；判据：1 s 内电平变 `—`，重连后全量回读）。
8. 心跳（`0x1000`）观察：连续 5 分钟空闲，判据：设备不主动断开；若断开，记录设备侧看门狗行为并回报固件方。
9. 电平标定：与设备自身电平指示对比，判据：给出 `raw → dBFS` 的实测对照表（至少 5 点）。
10. DFU 入口：写 `0x1008=1` 后设备是否重枚举，判据：`select-hid-device` 日志与设备列表变化。
11. DFU 全流程（用 App 包）：判据：`0x05` 收到、设备回 App、版本变为包内版本。
12. DFU 歧义态：手工在升级中拔线，判据：重插后设备停在 DFU、重试可成功。
13. 预设持久化：写参数 → 断电重启 → 回读，判据：记录"是否保留"，回报固件方（对应 Q6）。
14. 诊断面板取证：全过程导出日志一份附在问题单。

每条含：`#`、`项目`、`验证手段（含具体命令/操作）`、`判据`、`已知风险`、`对应需求编号`。

---

## 5. 行为与错误处理

| 场景 | 行为 |
|---|---|
| Python 不可用 | `selftest.mjs` 退出码 2，打印缺失的解释器路径 |
| 端口被占用 | 先 `GET /healthz`；若被**别人的**进程占用（`/api/devices` 里没有 `mic-m001`）→ 退出码 2 并说明 |
| 用例超时 | 单例 `--timeout-ms` 上限，超时记 FAIL 并继续下一例 |
| 用例中间崩溃 | 每例 `try/catch`，记 FAIL，继续 |
| 清理 | 除非 `--keep`，结束时杀侧车与桥；`--keep` 时打印 PID 便于手工清理 |
| 覆盖率未达标 | `test:coverage` 非 0 退出，报告里贴出未达标的文件与百分比 |

---

## 6. 测试要求

```powershell
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $node $pnpm run typecheck
& $node $pnpm run test
& $node $pnpm run build
& $node $pnpm run test:coverage
& $node $pnpm run test:device
```

必须全部通过；`test:device` 的 20 条用例全 PASS（允许环境原因退出码 2，但不允许"skip 算过"）。

---

## 7. 可观察验收标准

| # | 标准 | 取证 |
|---|---|---|
| L1 | `typecheck`/`test`/`build` 三绿（R10-1） | 命令输出 |
| L2 | 协议层 + 镜像层覆盖率 ≥ 90% 行（R10-2） | `test:coverage` 输出 |
| L3 | `test:device` 20 条用例全 PASS，退出码 0（R7-3/R7-4/R10-3） | `artifacts/vdevice/selftest-*.json` + stdout |
| L4 | 一条命令拉起虚拟下位机 + 侧车并清理（R10-3） | `pnpm run vdevice` 输出 + 退出后 `Get-Process` |
| L5 | `dependencies` 字段仍不存在（R10-4） | `package.json` |
| L6 | `AGENTS.md` 八处事实已同步（§4.4 表） | diff |
| L7 | `真机联调清单.md` 交付且 14 条齐备 | 文件 |
| L8 | 侧车 30 分钟稳定性（R7-5）：`--keep` 起后跑 30 分钟，每小时采样 `GET /control/stats` 与 `Get-Process` 的 `WorkingSet64` | 三份采样记录（0/15/30 分钟） | 
| L9 | `git status --porcelain third_party` 为空 | git 输出 |

L8 说明：30 分钟是真实等待，允许在后台作业里跑，同时继续其它工作；报告里写清开始/结束时间与采样值。若环境不允许，必须显式声明"未执行"，不能写"应该没问题"。

---

## 8. 禁止事项

1. 不得为了让 `selftest.mjs` 通过而修改 `tools/vdevice/{device,dfu}-stack.mjs` 的协议行为（Bug 要改在真正的出错侧并说明）。
2. 不得把 `skip` 当成 PASS；环境不可用必须退出码 2。
3. 不得在覆盖率里 `exclude` 协议层文件来"达标"。
4. 不得修改 `Document/Update/Alpha/v1.0.0/**`（历史验收物）。
5. 不得在 `AGENTS.md` 里留下与新事实矛盾的旧句子（八处必须全改）。
6. 不得新增运行时依赖（`dependencies` 必须保持不存在）。
7. 不得留 TODO/FIXME/emoji。

---

## 9. 完成报告要求

1. 产出文件清单（路径 + 行数）。
2. 五条门禁命令的完整输出。
3. `selftest` 的 20 条逐条结果（PASS/FAIL + 关键 detail）+ JSON 文件路径。
4. 覆盖率报告（协议层/镜像层各文件的行覆盖率百分比）。
5. 30 分钟稳定性采样（含开始/结束时间；未执行则写明原因）。
6. `AGENTS.md` 八处同步的 diff 摘要。
7. `真机联调清单.md` 的 14 条目录。
8. 与设计文档的偏差（无则写"无偏差"）。
