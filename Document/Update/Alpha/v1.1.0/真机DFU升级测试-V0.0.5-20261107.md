# 真机 DFU 升级测试 — V0.0.5（2026-11-07）

> 结论：**界面固件升级功能可用，V0.0.4 → V0.0.5 升级成功**。全程走界面（选包 → 预检 → 勾选确认 → 开始升级 → 收尾），预检值与独立解析逐项一致，660/660 块写完，收尾后设备重连、版本回读 0.0.5 并通过会话的版本比对，参数通道恢复「已连接 / 已同步」。

## 1. 被测对象

| 项 | 值 |
|---|---|
| 升级包 | `Document/Protocol/dfu_M001 MCU V0.0.5_2026-11-07_Rev0.bin` |
| 包大小 / SHA256 | 174 928 B / `C6406F0C5644CD4800C6D9087518379D436DCE05C7EC4296637AB46F98163F5D` |
| 包结构 | 新 Modbus 进 DFU 帧 `00 10 00 0A 10 08 00 01 8D 09` + SigmaBus Info + 660 个块帧，帧 CRC 全通过 |
| 镜像信息（独立解析） | model `JYM001`、name `M001`、version `0.0.5`、length `168 888 B`、checksum `0xF653D0BB` |
| 设备 | M001，`USB\VID_0A67&PID_0010`，型号 `JYM001` |
| 升级前固件 | `0.0.4.0` |
| 升级后固件 | `0.0.5.0` |
| 上位机 | 当前 `out/` 构建（`electron-vite build`，v1.1.0），Electron 33.4.11 |

## 2. 取证方式

界面本身没有自动化入口，用 CDP 驱动真实渲染进程跑完整条 UI 流程（不是直接调控制器）：

```powershell
node scripts\probes\dfu-ui-v005.mjs "Document\Protocol\dfu_M001 MCU V0.0.5_2026-11-07_Rev0.bin"
```

脚本做四件事：启动 `electron . --no-sandbox --remote-debugging-port=9333` → 通过 CDP 在页面里打开设备抽屉/固件抽屉、把包塞进 `.fw-file`（`DataTransfer`）→ 轮询界面状态并在关键节点截图 → 结束后关掉应用、把 `startup.log` 与 `summary.json` 落到 `artifacts/dfu-v005/`。

设备连接走的是应用自己的后台自动连接（启动 0.1 s 发现设备、0.2 s 连上并同步），没有手动点「连接」。

## 3. 预检（界面值 vs 独立解析）

| 字段 | 界面 | 独立解析 |
|---|---|---|
| 型号 | `JYM001` | `JYM001` |
| 型号名 | `M001` | `M001` |
| 版本 | `0.0.5` | `(0, 0, 5)` |
| 长度 | `168888 B` | `168888` |
| 块数 | `660` | `660`（前 659 块 256 B + 末块 184 B） |
| 校验和 | `0xF653D0BB` | `0xF653D0BB`（解密后 32 位小端字累加） |

界面未报错，`开始升级` 在勾选确认后才可点。

## 4. 升级时间线（UI 实测）

| 相对时刻 | 界面阶段 | 进度 |
|---|---|---|
| +0.35 s | 进入升级模式 | 5%，块 1/660 |
| +2.2 s | 正在写入 | 11%，块 12/660 |
| +10.0 s | 正在写入 | 50%，块 308/660 |
| +19.4 s | 正在写入 | 95%，块 659/660 |
| +19.8 s | 等待设备重启，请勿拔线 | 95%，块 660/660（「中止升级」消失） |
| +22.3 s | **升级完成** | 100%，块 660/660，结果「设备新版本 0.0.5」 |

- 总耗时 **22.3 s**（写入段约 19.8 s，收尾重枚举 + 回读约 2.5 s），与第五轮 V0.0.4 的 654 块 / 约 21 s 同量级。
- 主进程守卫按预期开关：`dfu-active=true blocker=0`（06:51:31.6）→ `dfu-active=false blocker=none`（06:51:53.7），升级期间关窗会被拦。
- 收尾后设备回读 `0.0.5.0`，`FirmwareController.verifyVersion()` 比对通过（版本不一致会走 `verify` 失败而不是绿色结果）。

## 5. 升级后状态

| 项 | 值 |
|---|---|
| 连接 / 同步 | `已连接` / `已同步` |
| 设备摘要 | 型号 `JYM001`、名称 `M001`、固件 `0.0.5.0` |
| 参数通道统计 | `out=207 in=207 crc=0 timeout=0 retry=0 dropped=1` |
| 电平条 | 升级期间 -60（音频端点重枚举），收尾后恢复（-46.5 dB） |

## 6. 观察与建议（不阻塞本次验收）

1. **`dropped=1`**：DFU 前后各算一次通道统计，收尾后只有 1 条被丢；`crc/timeout/retry` 全 0，未影响升级。怀疑是进/出 DFU 那一刻切换会话造成的正常丢弃，若要严谨可在 `_applyEcho`/统计口径上区分"DFU 期间不计数"。
2. **完成后「开始升级」仍可点**：`phase='done'` 时主按钮仍是「开始升级」且可用（`renderControls` 的条件只看 `info != null && confirmed && !running`）。此时再点会重刷同一镜像，属于误触风险。建议 `done` 时禁用主按钮，或换成「再次升级」并把确认开关复位。
3. **DFU 诊断段没有单独取证**：设备抽屉的诊断日志卡这次只截到「输入报告」，DFU 帧日志（`onDiag`）可以通过把 `.diag-details` 展开后再截一张补齐。
4. 设备列表仍会把系统里所有 HID 设备列出来（遗留项 R2，非本次 DFU 问题）。

## 7. 证据

- `artifacts/dfu-v005/01-device-before.png`（升级前：0.0.4.0，已同步）
- `artifacts/dfu-v005/02-firmware-empty.png`（固件抽屉空态）
- `artifacts/dfu-v005/03-preflight.png`（预检摘要）
- `artifacts/dfu-v005/04-writing-early.png`、`05-writing-half.png`（写入中）
- `artifacts/dfu-v005/06-done.png`（升级完成，设备新版本 0.0.5）
- `artifacts/dfu-v005/07-device-after.png`（设备抽屉：0.0.5.0、已同步）
- `artifacts/dfu-v005/summary.json`（预检、完整时间线、前后状态）
- `artifacts/dfu-v005/startup.log`（主进程日志：自动连接、dfu-active 守卫、正常退出）
- 探针：`scripts/probes/dfu-ui-v005.mjs`
