# SubStage 1.2 — 音频 I/O 与 VAD

> **所属 Stage**：Stage 1（基础设施）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 1.1（`tools/voice/models/vad/silero_vad.onnx` 必须已就位）
> **并行状态**：与 SubStage 3.1 / 3.2 **可并行**；SubStage 2.1、4.3、5.1 依赖本 SubStage
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §4.2（跨 SubStage 契约）、§3.9（失败行为）

---

## 1. 背景与目标

把"麦克风里的声音"变成"一段规整的 16 kHz 单声道 float32 数组"，并回答一个问题：**用户说完了没有**。这两件事是后续唤醒、ASR、评测的全部输入。

本 SubStage 交付两个纯 Python 模块与一个自检入口，**不含任何关键词/模型推理逻辑**（那是 Stage 2）。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/` | 只有 SubStage 1.1 的 `fetch-models.mjs` / `manifest.json` / `requirements.txt` |
| `tools/voice/.venv` | 已含 `sherpa-onnx==2.0.3`、`numpy`、`sounddevice==0.5.6` |
| `src/renderer/src/device/audio-meter.ts` | 渲染进程里已有 `getUserMedia` + `AnalyserNode` 的采集实现，**本 SubStage 不复用也不得修改**（Q1=A：不改 `src/**`）；可读它理解"端点重枚举/掉线"的坑 |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/audio_io.py` | 设备枚举、流式采集、wav 读、wav 写 |
| `tools/voice/vad.py` | Silero VAD 端点封装 |
| `tools/voice/test/test_audio_io.py`、`test_vad.py` | 单元测试（`unittest`，不引入 pytest） |
| `artifacts/voice/selftest-12.json` | 自检结果（`--selftest` 生成） |

---

## 4. 契约

### 4.1 `audio_io.py`

```python
SAMPLE_RATE = 16000          # 全局固定；不接受其它采样率
TARGET_KIND_DENIED = 'denied'          # 系统/权限拒绝
TARGET_KIND_UNAVAILABLE = 'unavailable' # 设备不存在
TARGET_KIND_BUSY = 'busy'               # 被独占或打开失败

class AudioUnavailable(RuntimeError):
    kind: str   # 上三者之一
    detail: str

def list_devices() -> list[dict]:
    """[{"index": int, "name": str, "channels": int, "default": bool}, ...]"""

def open_stream(device: str | int | None = None) -> "AudioStream":
    """device=None 用系统默认输入；str 时按名称子串匹配（大小写不敏感，首个命中）。
    打不开时抛 AudioUnavailable。不许静默改用别的设备。"""

class AudioStream:            # 上下文管理器
    rate: int                 # 恒 16000
    device_name: str
    def read(self, frames: int = 512) -> "np.ndarray"   # float32, shape (frames,), 值域 [-1, 1]
    def close(self) -> None                            # 幂等
    def alive(self) -> bool                            # 底层流未停止且未报错
    # __enter__ / __exit__ 必须实现

def read_wav(path: str) -> tuple["np.ndarray", int]:
    """读 16 kHz / 16 bit / 单声道 wav。其它格式抛 ValueError，消息含实际 (rate, width, channels)。"""

def write_wav(path: str, samples: "np.ndarray", rate: int = SAMPLE_RATE) -> None:
    """写 16 bit PCM 单声道；samples 为 float32 [-1,1]，内部 clip 后取整。"""
```

### 4.2 `vad.py`（**API 已实测，照抄，别信网上老教程**）

sherpa-onnx 2.0.3 的构造方式与 1.x 教程不同，实测结论：

```python
import sherpa_onnx

cfg = sherpa_onnx.VadModelConfig()
cfg.silero_vad.model = "tools/voice/models/vad/silero_vad.onnx"   # 必须绝对路径或 cwd 相对且存在
cfg.silero_vad.threshold = 0.5
cfg.silero_vad.min_silence_duration = 0.6     # 秒
cfg.silero_vad.min_speech_duration = 0.25
cfg.silero_vad.window_size = 512              # 每次 accept_waveform 的样本数必须是它的整数倍
cfg.sample_rate = 16000
cfg.num_threads = 1
assert cfg.validate()

det = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)   # 传 config，不传 model
det.accept_waveform(samples_f32)     # 长度 = 512 的整数倍
det.empty()                          # bool
seg = det.front                      # 是 property，不是方法（写成 det.front() 会 TypeError）
det.pop()                            # 是方法
det.flush()                          # 送完音频后必须调用
det.is_speech_detected()             # bool
det.reset()
```

> 已在 3.93 s 的合成语音上实测：`segments = [3.01 s]`，VAD 总耗时 15 ms。**`VadModel.create()` 与本 SubStage 无关**，不要用。

本 SubStage 对外只暴露一层状态机：

```python
SPEECH = 'speech'; SILENCE = 'silence'; END = 'end'; OVERFLOW = 'overflow'

class VadGate:
    def __init__(self, model_path: str, *, silence_ms: int = 600,
                 min_speech_ms: int = 250, max_ms: int = 6000,
                 speech_pad_ms: int = 200, threshold: float = 0.5)
    def feed(self, frame: "np.ndarray") -> str:
        """frame 长度必须是 512 的整数倍；返回四态之一。
        - speech：正在说话
        - silence：还没开口（本轮还没检测到语音）
        - end：说完（静音 ≥ silence_ms 且之前有 ≥ min_speech_ms 的语音）
        - overflow：累计语音已 ≥ max_ms（强制收尾）
        """
    def result(self) -> "np.ndarray":
        """累计的语音样本（float32），含 speech_pad_ms 的前后补白；未调用前返回空数组"""
    def reset(self) -> None
```

**实现要点**：
- `feed()` 内部自己转 `512` 的整倍数切片（调用方给任何长度都不许崩）；
- `end` 之后继续 `feed()` 必须返回 `silence` 并自动 `reset()`（一次唤醒只出一段音频）；
- `overflow` 只在"已有语音"时触发，避免纯噪声把人卡在录音态。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| `open_stream` 打不开 | 抛 `AudioUnavailable`，`kind` 按 `sounddevice.PortAudioError` 的文本分类（含 `Unanticipated host error`/`Invalid device` → `unavailable`；`Device unavailable`/`busy` → `busy`；权限类 → `denied`）；**不许 try/except 后返回 None** |
| `read()` 长度不足 | 返回 `(n,)` 的真实长度，**不补齐**（调用方自己缓冲） |
| 采集流被外力停止 | `alive()` 返回 False；`read()` 抛 `AudioUnavailable('busy')`，不许返回全零数组 |
| wav 不是 16 kHz 单声道 16 bit | `read_wav` 抛 `ValueError`，消息含 `rate=…, width=…, channels=…` |
| VAD 模型文件缺失 | 构造时抛 `FileNotFoundError`，消息为绝对路径 |
| `feed()` 传入空数组 | 返回当前状态，不推进内部缓冲 |
| `max_ms` 到了但从未检测到语音 | 不触发 `overflow`，继续 `silence` |

---

## 6. 测试要求

**单元测试**（`python -m unittest discover -s tools/voice/test`，全部离线，不得依赖真实麦克风）：

1. `read_wav` 读 16 kHz 单声道 → shape 正确、值域在 [-1,1]；读 44.1 kHz 文件抛 `ValueError`；
2. `write_wav` → `read_wav` 往返：同一段正弦波最大误差 ≤ 1/32768；
3. `VadGate.feed` 喂**纯静音** 1 s → 全程 `silence`，`result()` 为空；
4. 喂"1.5 s 语音 + 0.8 s 静音"的合成波形（用 `write_wav` 生成）→ 依次出现 `speech` 与 `end`，`result()` 时长在 1.5–2.0 s；
5. 喂"8 s 连续语音"→ 出现 `overflow`，`result()` 时长 ≤ 6.2 s；
6. `end` 之后再 `feed` → 返回 `silence`（状态已复位）。

**启动测试**（真跑，把输出贴进报告）：

```powershell
.\voice.cmd python tools\voice\audio_io.py --list
.\voice.cmd python tools\voice\vad.py --selftest --wav artifacts\voice\wav\probe.wav
```

`--selftest` 要：①打印枚举到的前 5 个输入设备；②用 `--wav` 指定的文件跑 VAD，打印检出的段落数与各段时长；③写 `artifacts/voice/selftest-12.json`（含 `{"devices": n, "segments": [...], "vad_ms": n}`）。
若本机没有麦克风，`--list` 必须仍然成功（枚举是只读的）并在 `--selftest` 里报告 `AudioUnavailable(kind)` 后以退出码 3 结束——这属于**阻塞**，要写进完成报告。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `audio_io.py --list` | 打印 ≥1 个输入设备，含 `default=True` 的一项 |
| 7.2 | 用默认设备 `open_stream()` 采 1 s | 返回 16000 个 float32 样本，无异常 |
| 7.3 | `vad.py --selftest --wav <3.9 s 合成语音>` | 段数 = 1，段长 2.9–3.2 s，`vad_ms` < 100 |
| 7.4 | 6 条单元测试 | 全绿 |
| 7.5 | 拔掉/禁用麦克风后 `open_stream()` | 抛 `AudioUnavailable`，`kind` ∈ {unavailable, busy, denied}，**不是** None 或全零流 |

---

## 8. 禁止事项

- 不得修改 `src/**`；不得 import 渲染进程的任何模块；
- 不得引入 `pyaudio`、`silero-vad`（pip 包会拖 torch）、`webrtcvad`；
- 不得做重采样（统一要求 16 kHz 输入文件；换采样率的责任在调用方）；
- 不得在采集失败时静默 fallback 到默认设备（这会让"用户对着错误麦克风说话"永远查不出来）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①6 条单测的原始输出；②`--list` 与 `--selftest` 的原始输出；③`selftest-12.json` 内容；④实测的 VAD 段数与段长（与 §4.2 里 3.01 s 的参考值对比）；⑤任何 API 与本文不一致之处（尤其 sherpa-onnx 2.0.3 的 VAD 构造）；⑥未解决问题。
