# SubStage 2.2 — ASR 与文本规范化

> **所属 Stage**：Stage 2（聆听与转写）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 1.1（`models/sense-voice/*`、venv）
> **并行状态**：与 SubStage 2.1、3.2 **可并行**（只吃 wav，不需要麦克风，也不需要唤醒词）
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §4.2（`asr.py:transcribe`、`normalize.py:normalize`）、§3.10（日志 `asr_ms`）

---

## 1. 背景与目标

把一段 1–6 s 的中文音频变成**规范化的文本**，供意图层直接消费。两件事分开做：ASR 负责"听清"，规范化负责"统一写法"（数字、单位、英文大小写），**不做同义词替换**（那是 SubStage 3.2 的职责，避免两处都改语义）。

实测基线：SenseVoice int8，3.93 s 音频 → **93 ms**，输出「小唐小唐把声音调亮一点。」（含句号）。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/models/sense-voice/` | `model.int8.onnx`（228.2 MB）+ `tokens.txt`（由 1.1 下载） |
| `tools/voice/audio_io.py` | `read_wav` / `write_wav` 可用（1.2） |
| `tools/voice/` | 无任何 ASR 代码 |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/asr.py` | SenseVoice 常驻解码 |
| `tools/voice/normalize.py` | 文本规范化（纯函数） |
| `tools/voice/test/test_asr.py`、`test_normalize.py` | 单元测试 |

---

## 4. 契约

### 4.1 `asr.py`（API 已实测）

```python
class AsrEngine:
    def __init__(self, model_dir: str, *, num_threads: int = 4,
                 use_itn: bool = True, language: str = "zh")
    def transcribe(self, wav_bytes: bytes) -> str:
        """wav_bytes = 16 kHz / 16 bit / 单声道 的完整 wav 文件字节（带 RIFF 头）。
        返回识别文本（可能带句末标点；空音频返回 ''）。永不抛业务异常。"""
    def transcribe_samples(self, samples: "np.ndarray", rate: int = 16000) -> str
    def close(self) -> None
```

内部构造（**2.0.3 实测可用**）：

```python
self._rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=f"{model_dir}/model.int8.onnx", tokens=f"{model_dir}/tokens.txt",
    num_threads=num_threads, use_itn=use_itn, language=language, debug=False)
```

`wav_bytes` 用标准库 `wave` + `io.BytesIO` 解，**不要**依赖 `sherpa_onnx.read_wave`（2.0.3 实测没有这个函数）。

### 4.2 `normalize.py`

```python
def normalize(text: str) -> str: ...
```

规则（**顺序敏感，按此顺序实现**）：

| # | 规则 | 输入 → 输出 |
|---|---|---|
| 1 | 去首尾空白、去掉句末 `。．.！!？?` 与引号 | `"声音亮一点。"` → `声音亮一点` |
| 2 | 中文数字转阿拉伯（0–99：`零一二三四五六七八九十`，支持 `十`/`十八`/`二十`/`二十三`） | `"十八分贝"` → `18分贝`、`"第三段"` → `第3段` |
| 3 | 小数：`X点Y` → `X.Y`；`X点半` → `X.5`；`X点` 单独出现 → `X.0` | `"四点五"` → `4.5`、`"四点半"` → `4.5` |
| 4 | 负数：`负X` → `-X` | `"负十八"` → `-18` |
| 5 | 单位统一（含空格变体） | `分贝`/`db`/`dB` → `dB`；`赫兹` → `Hz`；`千赫`/`khz` → `kHz`；`毫秒` → `ms`；`秒` 保留 |
| 6 | 英文小写化（仅 ASCII 字母） | `EQ` → `eq`、`DB` → `db`（已被 #5 吃掉则不变） |
| 7 | 合并多余空白为单个空格 |  |
| 8 | **不做**：同义词替换、去语气词、断句、纠错 | `"嗯那个"` 原样保留 |

要求：纯函数、无全局状态、幂等（`normalize(normalize(x)) == normalize(x)`，测试要覆盖）。

### 4.3 故意不做的两件事（写进契约，避免被"顺手优化"）

1. **不删唤醒词**：`"小唐小唐把声音调亮"` 里的唤醒词保留。是否剔出由 SubStage 3.2 决定（它知道哪些前缀算唤醒词）。
2. **不纠错**：ASR 把"齿音"听成"齿因"时，规范化不改；纠错放 3.2 的别名表。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| `wav_bytes` 不是合法 wav | 抛 `ValueError("不是有效的 wav 数据")`，**不返回空串**（静默吞会让"没声"和"格式错"混为一谈） |
| 采样率不是 16 kHz | 抛 `ValueError`，消息含实际值 |
| 音频全零 / 极短（< 100 ms） | 返回 `''`，不抛 |
| 模型文件缺失 | 构造时 `FileNotFoundError`（绝对路径） |
| `normalize("")` | 返回 `''` |
| 文本里只有标点 | 返回 `''` |

---

## 6. 测试要求

**单元测试**（离线；wav 用 `audio_io.write_wav` 合成或复用 `models/kws/test_wavs/`）：

1. `transcribe` 一条合成语音 wav → 返回非空、且 `normalize(text)` 含 `小唐小唐`；
2. `transcribe(b'not a wav')` → 抛 `ValueError`；
3. 44.1 kHz wav → 抛 `ValueError`；
4. 全零 0.5 s wav → 返回 `''`；
5. `normalize` 表驱动 **≥20 条**（覆盖 §4.2 的 1–7 每条规则，含 `"四点半"`、`"负十八分贝"`、`"第三段"`、`"EQ"`、`"千赫"`）；
6. 幂等性：对 5 里的每条输入断言 `normalize(normalize(x)) == normalize(x)`；
7. 性能：`transcribe` 一条 3.9 s 音频 ≤ 400 ms（本机实测 93 ms，留 4 倍余量）。

**启动测试**（真跑）：

```powershell
.\voice.cmd python tools\voice\asr.py --selftest --wav artifacts\voice\wav\probe.wav
```
`--selftest` 打印：模型加载耗时、解码耗时、原始文本、规范化文本，并写 `artifacts/voice/selftest-22.json`。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `--selftest` 一条合成语音 | 原始文本含「小唐小唐」「亮」，耗时 ≤ 400 ms |
| 7.2 | 30 条合成语料批量转写（脚本自造，用 SAPI 合成正文后跑） | 与原文一致率 ≥ 95%（报告里给逐条对照表） |
| 7.3 | `normalize` 20 条表驱动 | 全绿且幂等 |
| 7.4 | 7 条单测 | 全绿 |

---

## 8. 禁止事项

- 不得修改 `audio_io.py` / `vad.py` / `src/**`；
- 不得在 `normalize` 里做同义词替换或纠错（与 3.2 重复会导致行为不可预测）；
- 不得引入 `funasr` / `faster-whisper` / `torch`；
- 不得调用 `sherpa_onnx.read_wave`（2.0.3 不存在）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①7 条单测输出；②`--selftest` 输出与 JSON；③30 条语料的一致率对照表（原文 / 转写 / 是否一致）；④实测耗时与原「93 ms」的差异；⑤与本文不一致处；⑥未解决问题。
