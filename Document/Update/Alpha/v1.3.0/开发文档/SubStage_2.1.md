# SubStage 2.1 — 唤醒词与聆听状态机

> **所属 Stage**：Stage 2（聆听与转写）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 1.2（`audio_io`、`vad.VadGate`）、1.1（`models/kws/*`）
> **并行状态**：与 SubStage 2.2、3.2 **可并行**（文件不重叠）；SubStage 4.3 依赖本 SubStage
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §3.1（target 词表不涉及本 Stage）、§3.10（日志字段 `wake_ms`/`audio_ms`）

---

## 1. 背景与目标

用户必须先喊「小唐小唐」，系统才开始听。本 SubStage 交付：常驻唤醒 + 应答音 + 一段可用音频。

**技术底细（已实测，照抄）**：sherpa-onnx 的 KWS 模型是**拼音（声母 + 韵母）transducer**，唤醒词是**用户自己拼的一行文本**，不是训练出来的：

```
x iǎo t áng x iǎo t áng @小唐小唐
```

实测：合成语音「小唐小唐，把声音调亮一点」**检出 1/1**；7 条无关中文语句**误唤醒 0/7**（阳性对照通过）。详见 `调研报告.md` §2.1/§2.2。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/audio_io.py`、`vad.py` | 由 SubStage 1.2 交付，本 SubStage 只调用，**不得修改**（如需扩展，在完成报告里提出） |
| `tools/voice/models/kws/` | 含 `tokens.txt` 与 `encoder/decoder/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`（由 1.1 解包拍平） |
| `tools/vdevice/` | 与本 SubStage 无关 |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/keywords/xiaotang.txt` | 唤醒词文本（UTF-8 无 BOM，一行一词） |
| `tools/voice/kws.py` | `WakeSpotter`：模型加载、`matches(frame)`、应答音生成 |
| `tools/voice/listen.py` | `listen_once()` 状态机 + `--loop` / `--wav` / `--selftest` 三个入口 |
| `tools/voice/test/test_kws.py` | 单元测试 |

---

## 4. 契约

### 4.1 `keywords/xiaotang.txt`（内容逐字节）

```
x iǎo t áng x iǎo t áng @小唐小唐
```

要求：UTF-8 **无 BOM**；每个 token 必须在 `models/kws/tokens.txt` 里存在（`t` / `áng` / `x` / `iǎo` 已核对存在；共 227 个 token）。

### 4.2 `kws.py`（API 已实测）

```python
class WakeSpotter:
    def __init__(self, model_dir: str, keywords_file: str, *,
                 num_threads: int = 2, keywords_score: float = 1.0,
                 keywords_threshold: float = 0.25, num_trailing_blanks: int = 1)
    def matches(self, frame: "np.ndarray") -> bool:
        """喂一块 16 kHz float32 音频（任意长度，内部按需切片）；命中返回 True 并自复位"""
    def reset(self) -> None
    def close(self) -> None
```

内部必须用这个构造器（**2.0.3 没有 `from_transducer()`**）：

```python
sp = sherpa_onnx.KeywordSpotter(
    tokens=f"{model_dir}/tokens.txt",
    encoder=f"{model_dir}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    decoder=f"{model_dir}/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    joiner=f"{model_dir}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    keywords_file=keywords_file, num_threads=num_threads, sample_rate=16000,
    feature_dim=80, max_active_paths=4, keywords_score=keywords_score,
    keywords_threshold=keywords_threshold, num_trailing_blanks=num_trailing_blanks,
    provider="cpu", device=0,
)
stream = sp.create_stream()
stream.accept_waveform(16000, samples)
while sp.is_ready(stream):
    sp.decode_stream(stream)
    hit = sp.get_result(stream)      # 命中时是字符串（"小唐小唐"），否则空串
    if hit:
        sp.reset_stream(stream)
        break
```

### 4.3 应答音

```python
def make_beep(freq: float = 880.0, ms: int = 120, rate: int = 16000) -> "np.ndarray"
```
返回 `float32` 正弦 + 首尾各 10 ms 线性淡入淡出（避免爆音）。**必须与采集解耦**：播放走 `sounddevice.play`（阻塞可选），且播放期间 `listen.py` 暂停喂 KWS（半双工，见设计 §3.7 第 2 条）。

### 4.4 `listen.py`

```python
def listen_once(spotter: WakeSpotter, gate: "VadGate", stream: "AudioStream", *,
                timeout_s: float = 6.0, on_event=None) -> bytes | None:
    """阻塞直到：①命中唤醒词且 VAD 判 end/overflow → 返回 16 kHz 单声道 16 bit wav 字节；
    ②timeout_s 内既没唤醒也没说话 → 返回 None。
    on_event(name: str, **fields) 用于埋点（'wake' / 'speech' / 'end' / 'overflow' / 'timeout'）。"""
```

命令行：

| 参数 | 行为 |
|---|---|
| `--loop`（默认） | 常驻：等唤醒 → 应答音 → 录到端点 → 把 wav 存 `artifacts/voice/wav/wake-<ts>.wav` 并打印 `WAV <path> <ms>` |
| `--wav <path>` | **回放模式**（自动化用）：把文件当实时输入，逐帧喂 KWS/VAD，命中则打印 `HIT <ms>` 并输出该段 wav 到 `artifacts/voice/wav/`；未命中打印 `MISS` |
| `--selftest` | 跑 §6 的门禁三项，写 `artifacts/voice/selftest-21.json` |
| `--device <子串>` | 透传给 `audio_io.open_stream` |

`--wav` 模式必须支持"命中后继续读到端点"（即等价实时回放），单条 4 s 音频全程 **≤ 1.5 s 墙钟**（可加速喂帧，不要 `sleep`）。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| 模型文件缺失 | 构造时抛 `FileNotFoundError`，消息含绝对路径 |
| 关键词文件的 token 不在 tokens.txt | 构造时抛 `ValueError`，列出缺失 token（**不要**交给 sherpa 静默忽略） |
| `--loop` 时采集中断（`AudioUnavailable`） | 打印中文原因，退出码 3；**不自动换设备** |
| 唤醒后 6 s 没人说话 | `on_event('timeout')`，回到等唤醒，**不播报**（避免空房间反复说话） |
| 应答音播放失败 | 记 warn 日志继续（音频链路还能用） |
| `--wav` 文件格式不对 | 由 `audio_io.read_wav` 抛 `ValueError`，进程退出码 2 |
| 一句话里连续喊两次唤醒词 | 只算一次；命中后立刻 `reset()` |

---

## 6. 测试要求

**单元测试**（离线，不依赖麦克风；wav 用 `audio_io.write_wav` 合成或复用 `models/kws/test_wavs/`）：

1. `keywords/xiaotang.txt` 的每个 token 都存在于 `models/kws/tokens.txt`；
2. 合成语音 wav（含"小唐小唐"）→ `WakeSpotter.matches` 返回 True；
3. `models/kws/test_wavs/3.wav`（说"文森特卡索…"）→ 返回 False（误唤醒）；
4. `make_beep()` 长度 = `ms/1000*rate`，首尾样本绝对值 < 0.02（淡入淡出生效）；
5. `listen_once` 在"唤醒 + 1.5 s 语音 + 0.8 s 静音"的回放流上返回非空 wav，时长 1.4–2.2 s；
6. `listen_once` 在"只有唤醒、无后续语音"的流上返回 `None`（走 timeout）且耗时 ≤ 6.5 s。

**启动测试**（真跑）：

```powershell
.\voice.cmd python tools\voice\listen.py --selftest
```
`--selftest` 必须做三件事并写 JSON：①合成语音命中（1/1）；②7 条无关 wav 误唤醒计数（期望 0）；③**实时**模式对着麦克风测：打印"请喊 小唐小唐"后 10 s 内统计命中次数（人工配合；无人应答也要正常超时退出，不得卡死）。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `--selftest` | 合成语音命中 1/1、无关 wav 0/7、实时模式正常超时退出 |
| 7.2 | `--wav <含唤醒词 4 s 音频>` | 打印 `HIT`，输出 wav 段落时长 1.4–2.5 s，墙钟 ≤ 1.5 s |
| 7.3 | `--wav <7 条无关 wav>` 各跑一次 | 全部 `MISS` |
| 7.4 | `--loop` 连续 10 min | 无崩溃、无内存持续增长（报告里给首尾 RSS） |
| 7.5 | 6 条单测 | 全绿 |

---

## 8. 禁止事项

- 不得修改 `audio_io.py` / `vad.py` / `src/**`；
- 不得把唤醒词写进 Python 代码（必须走 `keywords/*.txt`，产品要求可改词）；
- 不得用 `time.sleep` 模拟实时（`--wav` 模式必须尽快跑完）；
- 不得在唤醒失败时自动提高 `keywords_threshold`（阈值调整是标定工作，不是运行时兜底）；
- 不得引入 Picovoice / openWakeWord 依赖；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①6 条单测输出；②`--selftest` 的 JSON 与原始输出；③实时模式实测的命中/误唤醒计数（人工计数器，写清"喊了几次、中了几次"）；④`--wav` 模式的墙钟耗时；⑤10 min 稳定性测试的首尾 RSS；⑥与本文不一致处；⑦未解决问题。
