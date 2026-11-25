# SubStage 4.3 — 编排与命令行入口

> **所属 Stage**：Stage 4（执行层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 2.1（`listen_once`）、2.2（`asr`/`normalize`）、3.2（`parser`）、3.3（`llm`）、4.2（`/apply` `/undo`）
> **并行状态**：**串行汇聚点**，必须等前面全部完成；SubStage 5.1 依赖本 SubStage
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §2.2（时序）、§3.7（失聪保护/半双工）、§3.10（日志字段）、§3.8（错误码）

---

## 1. 背景与目标

前面 8 个 SubStage 各自能用，但**没有人把它们串成一轮对话**。本 SubStage 交付 `pipeline.py`：一次唤醒 → 转写 → 意图 → 执行 → 播报 → 落日志，并提供三种运行模式（纯文本 / 离线 wav / 实时麦克风）供开发、评测与验收使用。

**这也是验收的主角**：验收文档里的功能项几乎全部通过本文件的输出取证。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/{audio_io,vad,asr,normalize,parser,llm,kws,listen}.py` | 1.2 / 2.1 / 2.2 / 3.2 / 3.3 交付 |
| `tools/voice/executor.mjs` | 4.2 交付，`127.0.0.1:8767`，含 `/apply` `/undo` `/state` `/health` |
| `scripts/voice.ps1` | 1.1 建，含 `fetch` / `venv` / `python` / `server` |
| `artifacts/voice/` | 4.2 已会自动创建 |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/pipeline.py` | 编排 + 三种模式 + 日志 |
| `tools/voice/tts.py` | Windows SAPI 播报（子进程，零依赖） |
| `scripts/voice.ps1`（修改） | 补 `pipeline` 子命令 |
| `tools/voice/test/test_pipeline.py` | 单元测试（假 ASR/假 executor） |

---

## 4. 契约

### 4.1 命令行

| 参数 | 说明 |
|---|---|
| `--text "<中文>"` | **纯文本模式**：跳过音频与唤醒，直接进意图→执行（评测/调试主力） |
| `--once --wav <path>` | **离线模式**：把 wav 当实时输入（2.1 的 `--wav`），走完整链路，跑一轮后退出 |
| `--loop`（默认） | **实时模式**：常驻聆听，每轮结束后继续等唤醒 |
| `--sink dry\|vdevice` | 传给 executor；默认 `dry` |
| `--executor http://127.0.0.1:8767` | 执行器地址 |
| `--llm http://127.0.0.1:8768` | llama-server 地址 |
| `--no-tts` | 只打印不播报 |
| `--no-llm` | 强制只走规则层（3.3 不可用时的降级路径，也用于对照评测） |
| `--device <子串>` | 选定输入设备 |
| `--keep-wav` | 保存本轮录音到 `artifacts/voice/wav/` |

退出码：`0` 正常 / `2` 参数或 wav 非法 / `3` 音频不可用 / `4` 模型加载失败 / `5` 执行器不可达（只在启动自检阶段）/ `6` 一次都没成功（`--once` 模式）。

### 4.2 一轮的流程（伪代码，顺序不可改）

```python
def run_turn(ctx, *, audio=None, text=None):
    t0 = time.perf_counter()
    if text is None:
        audio = ctx.listen()                       # 2.1，含唤醒 + VAD 端点（半双工：播报期间不采）
        if audio is None: return None              # 超时，不播报
        text = ctx.normalize(ctx.asr.transcribe(audio))

    control = ctx.parser.parse_control(text)       # 'confirm' | 'undo' | None
    if control == 'confirm' and ctx.pending:       # 二次确认
        plan, token = ctx.pending; ctx.pending = None
        resp = ctx.post('/apply', {**plan, 'confirmToken': token})
    elif control == 'undo':
        resp = ctx.post('/undo', {})
    else:
        plan = ctx.parser.parse(text, targets=ctx.targets)
        route = 'rule'
        if plan is None and not ctx.no_llm and ctx.llm_available:
            plan = ctx.llm.plan(text, state=ctx.executor_state()); route = 'llm'
        if plan is None:
            plan = {'v':1,'status':'unsupported','ops':[],
                    'say':'我只管调麦克风音色，比如“声音亮一点”','confidence':1}; route = 'fallback'
        resp = ctx.post('/apply', plan)
        if resp.command.status == 'needs_confirm':
            ctx.pending = (plan, resp.command.confirmToken)
    ctx.say(resp.command.say)                      # TTS（半双工：播报期间暂停采集）
    ctx.log_turn(...)                              # 见 §4.4
    return resp
```

`ctx.pending` **只保留一个**；新指令到来即丢弃旧的（避免"确认"错配到上上轮）。

### 4.3 `tts.py`

```python
class Speaker:
    def __init__(self, *, voice: str = "Microsoft Huihui Desktop", enabled: bool = True)
    def say(self, text: str) -> float:   # 返回耗时 ms；失败返回 0 并打印 warn（永不抛）
    def close(self) -> None
```

实现：`subprocess.run([...powershell -NoProfile -Command "...System.Speech..."], timeout=10, creationflags=CREATE_NO_WINDOW)`，把文本用**单引号加转义**传入（禁止字符串拼接命令注入）。文本里出现 `'` 时按 PowerShell 规则转义为 `''`。
失败（找不到 voice / 非 Windows）→ 打印 warn，**不阻塞业务**（第一轮失败后不再重试，记一个 `tts_disabled` 标记）。

### 4.4 日志（**本 SubStage 是 §3.10 的唯一写入者**）

`artifacts/voice/turn-<yyyyMMdd-HHmmss-SSS>.jsonl`，一行一个 JSON，键固定：

```json
{"turn":"t-0007","ts":"…","route":"rule|llm|fallback","text":"…","norm_text":"…",
 "plan":{…},"command":{…},"readback_ok":true,"mismatch":[],
 "audio_ms":2180,"wake_ms":120,"asr_ms":96,"llm_ms":0,"apply_ms":34,"tts_ms":180,
 "total_ms":2550,"sink":"vdevice","mem_mb":214}
```

- 音频三段（`audio_ms`/`wake_ms`）在 `--text` 模式下写 `null`；
- `turn` 取 executor 响应里的 `command.turn`（`--text` 模式下也走 `/apply`，所以一定有）；
- 任何异常都要**先记一行**（`"error":"E_…"`）再返回或退出。

### 4.5 半双工（必须实现，设计文档 §3.7 第 2 条）

播报期间：不读麦克风、不清空但**丢弃** `--loop` 模式下累积的帧；播报结束后 `kws.reset()` 再继续。`--no-tts` 时该逻辑自然失效。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| executor 未起（启动自检） | 打印"执行器没起来：<url>"，退出码 5 |
| llama-server 未起 | 打 warn，自动降级 `--no-llm`，**不退出** |
| ASR 返回空文本 | 播报"没听清，请再说一次"，不调 executor，记一行日志（`route:'empty'`） |
| `needs_confirm` | 播报 `command.say`（含"确认吗"），把 plan 与 token 存入 `ctx.pending` |
| `confirm` 但无 pending | 当作普通文本走意图层（"确认"两个字也可能出现在别的句子里） |
| `/apply` 返回 409 `E_CONFIRM_EXPIRED` | 播报"确认超时，请再说一次"，清空 pending |
| `/apply` 返回 409 `E_READBACK_MISMATCH` | 播报"写入没生效"，日志记 mismatch |
| 执行器 5xx/连接断开 | 重试 1 次（300 ms 间隔），仍失败则播报"底层没起来"并继续下一轮（`--loop` 不退出） |
| `--once` 模式失败 | 退出码 6 |
| TTS 失败 | warn + 继续 |

---

## 6. 测试要求

**单元测试**（`unittest`，用**假** `AsrEngine` / 假 `PlanClient` / `http.server` 假执行器）：

1. `--text "声音亮一点"` → 命中规则层，POST body 的 `ops[0].target=='brightness'`，日志行有 `route:'rule'`；
2. `--text "放首歌"` → `route:'fallback'`，POST body `status=='unsupported'`；
3. 假执行器返回 `needs_confirm` → `ctx.pending` 被设置，且下一句 `"确认"` 会带 token 再 POST（用假执行器断言第二次请求含 `confirmToken`）；
4. 假执行器返回 409 `E_CONFIRM_EXPIRED` → pending 被清空，`say` 含"超时"；
5. `--text "撤销"` → 打到 `/undo`，不调 parser/llm；
6. ASR 返回空串 → 不调 executor，日志 `route:'empty'`；
7. 日志行键集合 == §4.4 的 16 个键（缺一即失败）；
8. `Speaker` 在 `enabled=False` 时 `say()` 返回 0 且不 spawn 子进程。

**启动测试**（真跑，把输出贴进报告）：

```powershell
# 终端 1：虚拟下位机   终端 2：执行器   终端 3：llama-server
.\voice.cmd python tools\voice\pipeline.py --text "声音有点闷" --sink vdevice
.\voice.cmd python tools\voice\pipeline.py --once --wav artifacts\voice\wav\probe.wav --sink vdevice
.\voice.cmd python tools\voice\pipeline.py --loop --sink vdevice
```

第三条要求人工喊"小唐小唐，声音亮一点"，并记录总耗时。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `--text "声音有点闷"` | 打印一行 JSON：`route:'rule'`、`command.status:'applied'`、`bandWrites` 含 band4/band7，`total_ms` < 500（不含 ASR/唤醒） |
| 7.2 | `--once --wav <含唤醒词 4 s 音频>` | `audio_ms`/`asr_ms` 非空，`total_ms` ≤ 2500 |
| 7.3 | `--loop` 真人喊一句 | 应答音 → 播报 → 寄存器变化；日志一行齐全 |
| 7.4 | `--text "放首歌"` | `route:'fallback'`，寄存器无任何变化 |
| 7.5 | 8 条单测 | 全绿 |
| 7.6 | 关掉 llama-server 跑 7.1 | 仍成功（降级为规则层），日志 `route:'rule'`，无异常退出 |

---

## 8. 禁止事项

- 不得修改前 8 个 SubStage 的模块（只能调用；需要扩展就在完成报告里提出）；
- 不得在 `--loop` 模式下因为一次失败就退出；
- 不得把 `--text` 模式的耗时统计混进音频模式（`audio_ms` 必须为 `null`）；
- 不得用 `os.system` 拼命令播报 TTS（必须 `subprocess.run` + list 参数）；
- 不得让日志写入失败影响业务；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①8 条单测输出；②三条启动命令的完整输出与对应日志行；③`--wav` 模式的 `total_ms` 分项（唤醒/录音/ASR/意图/落地/TTS）；④降级路径（关 llama-server）的证据；⑤与本文不一致处；⑥未解决问题（尤其是 TTS 的实际耗时）。
