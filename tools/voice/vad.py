"""SubStage 1.2 — Silero VAD 端点检测（`tools/voice/vad.py`）。

对外只有一层状态机 `VadGate`，四态：`speech` / `silence` / `end` / `overflow`
（契约：`Document/Update/Alpha/v1.3.0/开发文档/SubStage_1.2.md` §4.2 / §5）。上层（2.1 聆听
状态机、4.3 编排）只认这四态，不直接碰 sherpa-onnx。

实测签名（sherpa-onnx **2.0.3**，与 1.x 教程不同，别照抄网上的旧写法）：

- `sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)` —— 传 **config**，不传 model；
- `det.front` 是**属性**（写成 `det.front()` 会 TypeError），且 `empty()` 为真时取它会打印
  C++ 报错并返回空段，所以每次都要先判 `empty()`；
- `det.pop()` 是方法；`det.flush()` 收尾、`det.reset()` 复位；
- `seg.samples` / `seg.start`（`start` 是"已喂给检测器的流"里的样本偏移，单位 sample）。

自检：

    python tools/voice/vad.py --selftest --wav artifacts/voice/wav/probe.wav

`--selftest` 会①打印前 5 个输入设备（与 `audio_io.py --list` 同一份枚举）、②打印检出的
段数与每段时长、③把 `segments` / `vad_ms` 合并进 `artifacts/voice/selftest-12.json`
（`devices` / `capture` 由 `audio_io.py --selftest` 写，本模块原样保留）。
判定门槛按任务书 §7.3 针对 3.9 s 合成语音：段数 = 1、语音段长 2.9–3.2 s、VAD 耗时 < 100 ms；
换成别的 wav 时这几个 CHECK 只是参考，仍会如实打印。

两处任务书未写死的取舍：

1. `result()` 里的"前后补白"取 **原始输入**（不是检测器给的段），因为 `speech_pad_ms` 的意义
   是补回被端点判定切掉的起音/收音；检测器给的 `seg.samples` 已经被它自己裁到语音边界。
2. `overflow` 时语音核心截到 `max_ms`、**不加后置补白**（人还在说，没有"后"可补），
   否则结果会越过 `max_ms + speech_pad_ms`。`overflow` 只在"本轮已有语音"时触发
   （`max_ms` 到了但一直是静音 → 继续 `silence`），避免纯噪声把人卡在录音态。
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import sherpa_onnx

SAMPLE_RATE = 16000  # 与 audio_io.SAMPLE_RATE 同一个契约；这里单独定义是为了 vad.py 不依赖 sounddevice
WINDOW_SIZE = 512

SPEECH = "speech"
SILENCE = "silence"
END = "end"
OVERFLOW = "overflow"
STATES = (SPEECH, SILENCE, END, OVERFLOW)

SELFTEST_ARTIFACT = "artifacts/voice/selftest-12.json"
DEFAULT_SELFTEST_WAV = "artifacts/voice/wav/probe.wav"

# 任务书 §7.3 的门槛（针对 artifacts/voice/wav/probe.wav 这段 3.9 s 合成语音）
_EXPECT_SEGMENTS = 1
_EXPECT_SPEECH_MS = (2900.0, 3200.0)
_EXPECT_VAD_MS_MAX = 100.0

_REPO_ROOT = Path(__file__).resolve().parents[2]


class VadGate:
    """Silero VAD 的四态端点门。

    `feed()` 每次返回四态之一；`result()` 在收到 `end` / `overflow` 后给出本轮这一段语音
    （含 `speech_pad_ms` 补白）。收尾之后再 `feed()` 会**自动复位**（`result()` 保留到下一次
    收尾或显式 `reset()`），所以"一次唤醒只出一段音频"由本类保证，上层不用自己清状态。
    """

    def __init__(
        self,
        model_path: str,
        *,
        silence_ms: int = 600,
        min_speech_ms: int = 250,
        max_ms: int = 6000,
        speech_pad_ms: int = 200,
        threshold: float = 0.5,
    ) -> None:
        if silence_ms <= 0:
            raise ValueError(f"silence_ms 必须 > 0，实际 {silence_ms}")
        if max_ms <= 0:
            raise ValueError(f"max_ms 必须 > 0，实际 {max_ms}")
        if min_speech_ms < 0:
            raise ValueError(f"min_speech_ms 必须 >= 0，实际 {min_speech_ms}")
        if speech_pad_ms < 0:
            raise ValueError(f"speech_pad_ms 必须 >= 0，实际 {speech_pad_ms}")
        if not 0.0 < float(threshold) < 1.0:
            raise ValueError(f"threshold 必须在 (0, 1) 内，实际 {threshold}")

        path = Path(model_path).expanduser()
        absolute = path if path.is_absolute() else (Path.cwd() / path)
        absolute = absolute.resolve()
        if not absolute.is_file():
            raise FileNotFoundError(f"VAD 模型文件不存在：{absolute}")

        self.model_path = str(absolute)
        self.silence_ms = int(silence_ms)
        self.min_speech_ms = int(min_speech_ms)
        self.max_ms = int(max_ms)
        self.speech_pad_ms = int(speech_pad_ms)
        self.threshold = float(threshold)
        self.window_size = WINDOW_SIZE
        self.sample_rate = SAMPLE_RATE

        self._pad_samples = int(round(self.speech_pad_ms * SAMPLE_RATE / 1000.0))
        self._max_samples = int(round(self.max_ms * SAMPLE_RATE / 1000.0))
        # 原始音频要留够"一段话 + 两侧补白"，再给 1 s 余量吸收块边界
        self._cap_blocks = int(
            np.ceil((self._max_samples + 2 * self._pad_samples + SAMPLE_RATE) / WINDOW_SIZE)
        )

        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = self.model_path
        config.silero_vad.threshold = self.threshold
        config.silero_vad.min_silence_duration = self.silence_ms / 1000.0
        config.silero_vad.min_speech_duration = self.min_speech_ms / 1000.0
        config.silero_vad.window_size = WINDOW_SIZE
        # 让 sherpa 的强制切段永远晚于我们自己的 overflow 判定（否则段会被它先切碎）
        config.silero_vad.max_speech_duration = max(20.0, self.max_ms / 1000.0 + 1.0)
        config.sample_rate = SAMPLE_RATE
        config.num_threads = 1
        if not config.validate():
            raise RuntimeError(
                f"VAD 配置不合法：model={self.model_path} threshold={self.threshold} "
                f"silence={self.silence_ms}ms min_speech={self.min_speech_ms}ms "
                f"max={self.max_ms}ms window={WINDOW_SIZE} rate={SAMPLE_RATE}"
            )
        self.buffer_size_in_seconds = max(30.0, float(config.silero_vad.max_speech_duration) + 5.0)
        started = time.perf_counter()
        self._det = sherpa_onnx.VoiceActivityDetector(
            config, buffer_size_in_seconds=self.buffer_size_in_seconds
        )
        self.init_ms = (time.perf_counter() - started) * 1000.0

        self._pending = np.zeros(0, dtype=np.float32)
        self._blocks: list[np.ndarray] = []
        self._raw_first = 0
        self._fed_total = 0
        self._speech_samples = 0
        self._in_speech = False
        self._done = False
        self._result = np.zeros(0, dtype=np.float32)
        self._last_span = (0.0, 0.0)

    # --- 状态机 ---------------------------------------------------------------

    def feed(self, frame: Any) -> str:
        """喂任意长度的一段波形，返回 `speech` / `silence` / `end` / `overflow`。"""

        arr = np.asarray(frame, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr.reshape(-1)
        if arr.size == 0:
            # 空块不推进内部缓冲，也不触发收尾：只如实回当前状态（§5）
            return SPEECH if self._in_speech else SILENCE
        if self._done:
            # 上一次已收尾：自动复位继续听（result() 保留，便于调用方晚一步取）
            self._reset_work()
        if self._pending.size:
            arr = np.concatenate((self._pending, arr))
        # 调用方给什么长度都不许崩：内部攒够 512 的整倍数才喂检测器
        while arr.size >= WINDOW_SIZE:
            block = arr[:WINDOW_SIZE]
            arr = arr[WINDOW_SIZE:]
            self._push_block(block)
            if not self._det.empty():
                return self._finish(END)
            if self._speech_samples >= self._max_samples:
                return self._finish(OVERFLOW)
        self._pending = np.array(arr, dtype=np.float32, copy=True)
        return SPEECH if self._in_speech else SILENCE

    def flush(self) -> str:
        """送完音频后收尾（对应 sherpa 的 `det.flush()`）。

        返回 `end` 表示这里收出了一段语音；本轮没检测到语音则返回 `silence`（不产出段落）。
        不足 512 样本的残余尾巴丢掉——检测器只接受整窗。
        """

        if self._done:
            return SILENCE
        if self._speech_samples <= 0:
            self._reset_work()
            return SILENCE
        return self._finish(END)

    def result(self) -> np.ndarray:
        """本轮这一段的样本（float32，含 `speech_pad_ms` 补白）；还没收尾时返回空数组。"""

        return self._result.copy()

    def last_span_ms(self) -> tuple[float, float]:
        """上一次收尾的语音核心区间 `(起点 ms, 时长 ms)`，不含补白——自检与日志用。"""

        return self._last_span

    def reset(self) -> None:
        """彻底复位（含丢弃 `result()`），开始新一轮听。"""

        self._reset_work()
        self._result = np.zeros(0, dtype=np.float32)
        self._last_span = (0.0, 0.0)

    def in_speech(self) -> bool:
        return bool(self._in_speech)

    def speech_ms(self) -> float:
        """本轮已累计的语音时长（ms）。"""

        return self._speech_samples * 1000.0 / SAMPLE_RATE

    # --- 内部 -----------------------------------------------------------------

    def _reset_work(self) -> None:
        self._det.reset()
        self._pending = np.zeros(0, dtype=np.float32)
        self._blocks = []
        self._raw_first = 0
        self._fed_total = 0
        self._speech_samples = 0
        self._in_speech = False
        self._done = False

    def _push_block(self, block: np.ndarray) -> None:
        self._blocks.append(np.array(block, dtype=np.float32, copy=True))
        self._fed_total += block.size
        self._det.accept_waveform(block)
        self._in_speech = bool(self._det.is_speech_detected())
        if self._in_speech:
            self._speech_samples += int(block.size)
        while len(self._blocks) > self._cap_blocks:
            dropped = self._blocks.pop(0)
            self._raw_first += int(dropped.size)

    def _slice_raw(self, lo: int, hi: int) -> np.ndarray:
        lo = max(int(lo), self._raw_first)
        hi = min(int(hi), self._fed_total)
        if hi <= lo:
            return np.zeros(0, dtype=np.float32)
        pieces: list[np.ndarray] = []
        base = self._raw_first
        for block in self._blocks:
            block_end = base + block.size
            if block_end <= lo:
                base = block_end
                continue
            if base >= hi:
                break
            start = max(lo - base, 0)
            stop = min(hi - base, block.size)
            if stop > start:
                pieces.append(block[start:stop])
            base = block_end
        if not pieces:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(pieces).astype(np.float32, copy=False)

    def _drain_spans(self) -> list[tuple[int, np.ndarray]]:
        spans: list[tuple[int, np.ndarray]] = []
        while not self._det.empty():
            segment = self._det.front  # 属性，不是方法
            start = int(segment.start)
            samples = np.array(segment.samples, dtype=np.float32, copy=True).reshape(-1)
            self._det.pop()  # 方法
            if samples.size:
                spans.append((start, samples))
        return spans

    def _finish(self, kind: str) -> str:
        if kind == OVERFLOW or self._in_speech:
            # 还在说话就得让检测器把当前段吐出来（任务书 §4.2：送完音频必须 flush）
            self._det.flush()
        spans = self._drain_spans()
        if not spans:
            self._reset_work()
            return SILENCE
        truncated = kind == OVERFLOW
        pieces: list[np.ndarray] = []
        span_start_ms = 0.0
        core_ms = 0.0
        for index, (start, samples) in enumerate(spans):
            core = samples[: self._max_samples] if truncated else samples
            if index == 0:
                span_start_ms = start * 1000.0 / SAMPLE_RATE
            core_ms += core.size * 1000.0 / SAMPLE_RATE
            pieces.append(self._slice_raw(max(self._raw_first, start - self._pad_samples), start))
            pieces.append(core)
            if not truncated:
                core_end = start + core.size
                pieces.append(self._slice_raw(core_end, min(self._fed_total, core_end + self._pad_samples)))
        merged = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
        self._result = np.ascontiguousarray(merged, dtype=np.float32)
        self._last_span = (span_start_ms, core_ms)
        self._done = True
        self._pending = np.zeros(0, dtype=np.float32)
        return kind


# --- 自检 ---------------------------------------------------------------------


def _configure_stdout() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def _load_audio_io() -> Any:
    """自检才需要采集层（枚举设备、读 wav）。VAD 本身不依赖 sounddevice。"""

    if str(_REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(_REPO_ROOT))
    from tools.voice import audio_io  # noqa: PLC0415 - 延迟导入，避免 vad.py 常规使用依赖 PortAudio

    return audio_io


def _update_artifact(updates: dict, artifact_path: str | Path | None, defaults: dict | None = None) -> Path | None:
    if artifact_path is None:
        return None
    out = Path(artifact_path)
    if not out.is_absolute():
        out = _REPO_ROOT / out
    payload: dict = {}
    if out.is_file():
        try:
            loaded = json.loads(out.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                payload = loaded
        except (OSError, ValueError):
            payload = {}
    payload.setdefault("v", 1)
    payload.setdefault("substage", "1.2")
    for key, value in (defaults or {}).items():
        payload.setdefault(key, value)
    payload.update(updates)
    payload["generatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
    payload["python"] = sys.version.split()[0]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def run_selftest(
    wav_path: str,
    *,
    artifact_path: str | Path | None = SELFTEST_ARTIFACT,
    keep_wav: bool = False,
) -> int:
    """读 wav → 逐块喂 `VadGate` → 打印段数与段长 → 写自检产物。返回进程退出码。"""

    print("SELFTEST vad (SubStage 1.2)")
    try:
        audio_io = _load_audio_io()
    except Exception as exc:  # noqa: BLE001 - 缺采集层时 VAD 自检没法读 wav/枚举设备
        print(f"ENV failed: 无法导入 audio_io：{type(exc).__name__}: {exc}")
        print("RESULT BLOCKED")
        return 4

    devices: list[dict] = []
    try:
        devices = audio_io.list_devices()
    except audio_io.AudioUnavailable as exc:
        print(f"ENUM failed: AudioUnavailable(kind={exc.kind}) {exc.detail}")
    if devices:
        default = next((entry["index"] for entry in devices if entry["default"]), None)
        print(f"DEVICES inputs={len(devices)} default={default}")
        for entry in devices[:5]:
            print(
                "  [{}] {}  channels={} default={}".format(
                    entry["index"], entry["name"], entry["channels"], "True" if entry["default"] else "False"
                )
            )
    else:
        print("DEVICES inputs=0（枚举不可用，不影响下面的 wav 回放）")

    target = Path(wav_path)
    if not target.is_absolute():
        target = Path.cwd() / target
    if not target.is_file():
        print(f"WAV missing: {target}")
        print("RESULT BLOCKED")
        return 2
    try:
        samples, rate = audio_io.read_wav(str(target))
    except ValueError as exc:
        print(f"WAV invalid: {exc}")
        print("RESULT BLOCKED")
        return 2
    duration_ms = samples.size * 1000.0 / rate
    print(f"WAV {target} rate={rate} samples={samples.size} duration_ms={duration_ms:.0f}")

    gate = VadGate(
        str(_REPO_ROOT / "tools" / "voice" / "models" / "vad" / "silero_vad.onnx"),
    )
    print(
        f"MODEL {gate.model_path} threshold={gate.threshold} silence_ms={gate.silence_ms} "
        f"min_speech_ms={gate.min_speech_ms} max_ms={gate.max_ms} "
        f"speech_pad_ms={gate.speech_pad_ms} window={gate.window_size} init_ms={gate.init_ms:.1f}"
    )

    rows: list[dict] = []
    counts = {SPEECH: 0, SILENCE: 0, END: 0, OVERFLOW: 0}
    started = time.perf_counter()
    offset = 0
    while offset < samples.size:
        state = gate.feed(samples[offset : offset + WINDOW_SIZE])
        counts[state] = counts.get(state, 0) + 1
        offset += WINDOW_SIZE
        if state in (END, OVERFLOW):
            rows.append(_segment_row(len(rows) + 1, gate, state))
    tail_state = gate.flush()
    counts[tail_state] = counts.get(tail_state, 0) + 1
    if tail_state in (END, OVERFLOW):
        rows.append(_segment_row(len(rows) + 1, gate, tail_state))
    vad_ms = (time.perf_counter() - started) * 1000.0

    print(f"SEGMENTS {len(rows)}")
    for row in rows:
        print(
            "  [{}] state={} start_ms={} speech_ms={} padded_ms={}".format(
                row["index"], row["state"], row["start_ms"], row["speech_ms"], row["padded_ms"]
            )
        )
    print(f"VAD_MS {vad_ms:.1f} counts " + " ".join(f"{k}={v}" for k, v in counts.items()))

    speech_ms = sum(float(row["speech_ms"]) for row in rows)
    segments_ok = len(rows) == _EXPECT_SEGMENTS
    speech_ok = _EXPECT_SPEECH_MS[0] <= speech_ms <= _EXPECT_SPEECH_MS[1]
    vad_ok = vad_ms < _EXPECT_VAD_MS_MAX
    print(
        "CHECK segments=={} {} | speech_ms in [{}, {}] {} ({}) | vad_ms<{} {} ({:.1f})".format(
            _EXPECT_SEGMENTS,
            segments_ok,
            _EXPECT_SPEECH_MS[0],
            _EXPECT_SPEECH_MS[1],
            speech_ok,
            speech_ms,
            _EXPECT_VAD_MS_MAX,
            vad_ok,
            vad_ms,
        )
    )
    passed = bool(segments_ok and speech_ok and vad_ok)

    try:
        wav_rel = str(target.relative_to(_REPO_ROOT))
    except ValueError:
        wav_rel = str(target)
    updates = {
        "devices": len(devices),
        "wav": wav_rel,
        "model": gate.model_path,
        "vad_ms": round(vad_ms, 1),
        "segments": rows,
        "params": {
            "threshold": gate.threshold,
            "silence_ms": gate.silence_ms,
            "min_speech_ms": gate.min_speech_ms,
            "max_ms": gate.max_ms,
            "speech_pad_ms": gate.speech_pad_ms,
            "window_size": gate.window_size,
            "buffer_size_in_seconds": gate.buffer_size_in_seconds,
        },
        "wavInfo": {"rate": rate, "samples": int(samples.size), "durationMs": round(duration_ms, 1)},
        "stateCounts": counts,
        "checks": {"segments": segments_ok, "speechMs": speech_ok, "vadMs": vad_ok},
        "passed": passed,
    }
    artifact = _update_artifact(updates, artifact_path, defaults={"capture": None})
    print(f"RESULT {'PASS' if passed else 'FAIL'}")
    if artifact is not None:
        print(f"artifact: {artifact}")
    return 0 if passed else 1


def _segment_row(index: int, gate: VadGate, state: str) -> dict:
    start_ms, core_ms = gate.last_span_ms()
    padded = gate.result()
    return {
        "index": index,
        "state": state,
        "start_ms": round(start_ms, 1),
        "speech_ms": round(core_ms, 1),
        "padded_ms": round(padded.size * 1000.0 / SAMPLE_RATE, 1),
    }


def main(argv: list[str]) -> int:
    _configure_stdout()
    args = list(argv)
    artifact: str | None = SELFTEST_ARTIFACT
    wav: str = DEFAULT_SELFTEST_WAV
    if "--no-artifact" in args:
        artifact = None
        args.remove("--no-artifact")
    if "--artifact" in args:
        index = args.index("--artifact")
        if index + 1 >= len(args):
            print("--artifact 需要路径")
            return 2
        artifact = args[index + 1]
        del args[index : index + 2]
    if "--wav" in args:
        index = args.index("--wav")
        if index + 1 >= len(args):
            print("--wav 需要路径")
            return 2
        wav = args[index + 1]
        del args[index : index + 2]
    if not args or args != ["--selftest"]:
        print("用法: python tools/voice/vad.py --selftest [--wav <path>] [--artifact <path>|--no-artifact]")
        return 2
    return run_selftest(wav, artifact_path=artifact)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
