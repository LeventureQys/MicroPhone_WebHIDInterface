# SubStage 3.3 — LLM 意图兜底

> **所属 Stage**：Stage 3（意图层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 3.1（`schema/voice-plan.schema.json`）、SubStage 1.1（`models/llm/Qwen3-1.7B-Q4_K_M.gguf`、`models/llama/llama-server.exe`）
> **并行状态**：与 SubStage 4.1 **可并行**（文件不重叠）；SubStage 4.3、5.1 依赖本 SubStage
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §3.2（L1）、§3.8（错误码）、§2.4（硬约束）

---

## 1. 背景与目标

规则层（3.2）覆盖高频说法；覆盖不到的句子交给 1.7B。本 SubStage 交付**受约束的** LLM 调用层：结构由 JSON Schema 在解码期强制，语义由提示词引导，数值一概不产出。

**实测前提（照抄，别自己调）**：

| 项 | 实测值 |
|---|---|
| 模型 | `Qwen3-1.7B-Q4_K_M.gguf`（1.03 GB） |
| 服务 | `llama-server.exe`（`llama-b12359-bin-win-cpu-x64`），**常驻**，`-t 14`（物理核；20 线程反而慢） |
| 速度 | pp 318 tok/s、tg 43.5 tok/s |
| 思考模式 | **必须双开关关掉**：`--reasoning-budget 0` **且** `--chat-template-kwargs {"enable_thinking":false}`；只给前者实测会输出空 `actions` |
| 约束解码 | `response_format:{"type":"json_schema",…}` 实测 24/24 合法，速度 −8.3% |
| 前缀缓存 | 自动生效（`cache_n=174`）；**系统提示词必须静态**，动态内容放 user 消息 |
| 冷/热 | 冷启动单轮 4.6 s，温缓存 1.2–2.2 s → **必须预热** |

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/schema/voice-plan.schema.json` | 3.1 生成 |
| `tools/voice/models/llama/llama-server.exe` | 1.1 解包 |
| `scripts/voice.ps1` | 1.1 建的入口，`server` 子命令目前是占位（`throw`） |
| `tools/voice/` | 无 LLM 代码 |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/llm.py` | `PlanClient`：可用性检查、预热、约束解码调用、校验 |
| `tools/voice/prompts/system.zh.txt` | 静态系统提示词（含结构说明 + 词表 + few-shot） |
| `tools/voice/prompts/fewshot.zh.jsonl` | 5 条示例（`{"text":…,"plan":{…}}`） |
| `scripts/voice.ps1`（修改） | 补 `server` 子命令 |
| `tools/voice/test/test_llm.py` | 单元测试（用本地 stub 服务，不依赖真模型） |

---

## 4. 契约

### 4.1 服务启动参数（`voice server` 必须逐字照此）

```
models/llama/llama-server.exe -m models/llm/Qwen3-1.7B-Q4_K_M.gguf
  --host 127.0.0.1 --port 8768
  -t 14 -c 4096 -np 1 --jinja
  --reasoning-budget 0
  --chat-template-kwargs "{\"enable_thinking\":false}"
```

- 端口 **8768**（8765=WebHID 桥、8767=执行器）。
- `voice server` 必须：后台启动 → 轮询 `GET /health` 直到 200（最长 60 s）→ 打印 `llama-server ready`。Ctrl+C 时结束子进程。
- 若端口被占，打印中文提示并以退出码 1 结束（**不要**自动换端口，否则 `llm.py` 连不上）。

### 4.2 `llm.py`

```python
class LlmUnavailable(RuntimeError): ...

class PlanClient:
    def __init__(self, *, base_url: str = "http://127.0.0.1:8768",
                 schema_path: str = "tools/voice/schema/voice-plan.schema.json",
                 system_prompt_path: str = "tools/voice/prompts/system.zh.txt",
                 fewshot_path: str = "tools/voice/prompts/fewshot.zh.jsonl",
                 timeout_s: float = 8.0)

    def available(self) -> bool
        """GET /health，300 ms 超时；任何异常返回 False（不抛）"""

    def warmup(self) -> None
        """发一次固定内容的请求（max_tokens=8，不要 response_format），把系统提示词灌进前缀缓存；
        失败抛 LlmUnavailable"""

    def plan(self, text: str, state: dict | None = None) -> dict | None
        """返回通过本地校验的 L1 dict；服务不可达抛 LlmUnavailable；
        输出非法/被截断/枚举越界 → 返回 None（不抛）"""
```

**请求体（逐字段固定）**：

```json
{
  "model": "local",
  "messages": [
    {"role": "system", "content": "<system.zh.txt 全文 + 5 条 few-shot 展开>"},
    {"role": "user",   "content": "<当前参数快照>\\n<用户原话>"}
  ],
  "temperature": 0,
  "top_k": 1,
  "max_tokens": 96,
  "stream": false,
  "response_format": {"type": "json_schema",
                      "json_schema": {"name": "voice_plan", "strict": true, "schema": <voice-plan.schema.json>}}
}
```

- **系统提示词必须逐字节静态**（不拼时间、不拼随机数、不拼当前参数）——否则前缀缓存失效，延迟翻三倍。
- 当前参数快照只放 user 消息，格式固定为一行：

```
当前：降噪档位=1，压缩阈值=-18dB，限制器阈值=-2.0dB，噪声门阈值=-41dB，增益=[0,0,0,0,0,0,0]dB
```

（字段顺序固定；只放 `enc.Level`、`comp.Threshold`、`limit.Threshold`、`noisegate.threshold_db` 与 7 段增益这 11 个值，够模型判断"再亮一点"的相对方向。）

- `max_tokens=96`：`say` ≤ 30 字 + 1–3 个 op + JSON 骨架的实测典型用量是 50–70 token；**截断是唯一能破坏 schema 合法性的途径**（约束解码只保证未截断时合法），所以既不能太小也不能无限。

### 4.3 本地校验（`plan()` 返回前必做，任一不满足即 `None`）

1. 顶层键集合 == `{v,status,ops,say,confidence}`（`clarify` 时多一个 `question`）；
2. `v == 1`；`status ∈ {ok,clarify,unsupported}`；
3. `status=='ok'` 时 `ops` 非空、长度 ≤ 4；
4. 每个 op 的 `kind` 与 target/param/scene/tone 都在 `targets.json` 的白名单内；
5. `say` 长度 ≤ 30（超长**截断**到 30 并记 `warn`，不判非法）；
6. `confidence ∈ {0,0.25,0.5,0.75,1}`；
7. `confidence < 0.5` 且 `status=='ok'` → 上层会降级，本层原样返回。

### 4.4 `prompts/system.zh.txt` 要求

- 必须用中文**自然语言**把 L1 结构讲一遍（llama.cpp 的 JSON Schema **不会**进提示词，这是已知限制）；
- 必须列出 12 个 `tuneTarget` 与含义、7 个 `toggleTarget`、5 个场景、4 个音色；
- 必须写明三条硬规则：①**不要输出任何 dB/Hz/档位数值**（除非用户自己说了数，且此时用 `kind:'set'`）；②与麦克风调参无关的请求 → `status:'unsupported'`；③没说清 → `status:'clarify'` 且只问一次；
- 必须写明 `say` ≤ 30 字、中文、不带 emoji、不要复述用户原话；
- few-shot 用 5 条，覆盖：tune、toggle、set、scene、unsupported 各一。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| 服务没起（连接被拒） | `plan()` 抛 `LlmUnavailable`；`available()` 返回 False；`warmup()` 抛 |
| 服务响应 > 8 s | 抛 `LlmUnavailable("timeout")`（**不重试**，上层降级为只走规则层） |
| 返回内容不是 JSON | 返回 `None`，记 `warn`（含原始前 200 字符） |
| 返回 JSON 但枚举越界 | 返回 `None`，记 `warn` |
| `say` 超 30 字 | 截断并记 `warn`，仍然返回 |
| 响应 `finish_reason == "length"` | 视为截断 → 返回 `None`，记 `warn` |
| schema 文件缺失 | 构造时 `FileNotFoundError` |
| HTTP 5xx | 抛 `LlmUnavailable`，带状态码 |

---

## 6. 测试要求

**单元测试**（`python -m unittest`，用 `http.server` 起一个 **stub 服务**，不依赖真模型）：

1. `available()` 在 stub 返回 200 时为 True；服务不存在时为 False（且**不抛**）；
2. `plan()` 在 stub 返回合法 JSON 时得到 dict，且键集合校验通过；
3. stub 返回 `{"v":1,"status":"ok","ops":[],…}`（空 ops）→ `None`；
4. stub 返回枚举越界（`target:"loudnesss"`）→ `None`；
5. stub 返回 `finish_reason:"length"` → `None`；
6. `say` 40 字 → 返回且长度被截到 30；
7. 构造请求体时**系统提示词逐字节稳定**：连续两次 `plan()` 抓取请求体，`messages[0].content` 相同；
8. 当前参数快照只出现在 `messages[1]`（user），不在 system。

**启动测试**（真跑，需要 `voice server` 已起）：

```powershell
.\voice.cmd server            # 另开一个终端常驻
.\voice.cmd python tools\voice\llm.py --selftest
```
`--selftest` 必须：①`available()`；②`warmup()` 并打印耗时；③跑 10 条自由描述，打印每条 `text → plan`、`schema 合法`、耗时；④输出 p50/p95 延迟；⑤写 `artifacts/voice/selftest-33.json`。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `--selftest` 10 条 | schema 合法率 **100%**，p95 ≤ 2.5 s |
| 7.2 | 关掉 `voice server` 后 `available()` | False，无异常 |
| 7.3 | 8 条单测 | 全绿 |
| 7.4 | 连续 20 次 `plan()` | 前缀缓存生效：第 2 次起 prompt 处理 token 数明显小于首次（报告里给实际数） |
| 7.5 | 故意把 `max_tokens` 改成 8 跑一次 | 得到 `None`（截断被识别），不抛 |

---

## 8. 禁止事项

- 不得开思考模式（两个开关缺一不可）；
- 不得每轮重启 `llama-server`；
- 不得把动态内容（时间、随机数、当前参数）拼进 system 提示词；
- 不得对 `LlmUnavailable` 静默重试超过 1 次；
- 不得修改 `schema/voice-plan.schema.json`（3.1 的生成物）；
- 不得用 GPU（`-ngl` 一律不给）；
- 不得引入 `openai` / `requests` / `llama-cpp-python`（用 stdlib `urllib.request`）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①`--selftest` 原始输出与 JSON；②10 条 `text → plan` 明细；③p50/p95 延迟与首/次请求的 `tokens_predicted`/`cache_n` 对比；④8 条单测输出；⑤关服后 `available()` 的行为证据；⑥与本文不一致处（尤其 `--chat-template-kwargs` 在 PowerShell 里的转义写法）；⑦未解决问题。
