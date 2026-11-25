"""SubStage 1.2 单元测试：`tools/voice/vad.py`。

覆盖任务书 §6 的第 3–6 条，外加模型缺失、空数组、任意块长、复位与 `flush()` 的边界用例。
"语音"波形是本文件合成的（谐波堆 + 音节包络），不依赖任何外部音频资产与麦克风。
运行：`python -m unittest discover -s tools/voice/test -p "test_vad.py"`
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.voice import audio_io as va
from tools.voice import vad as vv

MODEL_PATH = REPO_ROOT / "tools" / "voice" / "models" / "vad" / "silero_vad.onnx"
WINDOW = vv.WINDOW_SIZE


def _voiced(seconds: float, *, f0: float = 180.0, syllables: float = 4.0, seed: int = 1) -> np.ndarray:
    """合成一段 Silero 会判成语音的波形：谐波堆（声门源）+ 两个共振峰 + 音节包络。"""

    rate = vv.SAMPLE_RATE
    t = np.arange(int(round(seconds * rate))) / float(rate)
    rng = np.random.default_rng(seed)
    signal = np.zeros_like(t)
    for harmonic in range(1, 26):
        signal += (1.0 / harmonic) * np.sin(2.0 * np.pi * f0 * harmonic * t + 0.3 * harmonic)
    signal += 1.2 * np.sin(2.0 * np.pi * 720.0 * t) + 0.8 * np.sin(2.0 * np.pi * 1220.0 * t)
    envelope = 0.5 * (1.0 + np.cos(2.0 * np.pi * syllables * t)) ** 0.6
    signal = signal * envelope + 0.01 * rng.standard_normal(t.size)
    signal = signal / max(1e-9, float(np.abs(signal).max())) * 0.5
    return signal.astype(np.float32)


def _silence(seconds: float, *, level: float = 1e-4, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(int(round(seconds * vv.SAMPLE_RATE))) * level).astype(np.float32)


def _feed_all(gate: vv.VadGate, samples: np.ndarray, *, chunk: int = WINDOW) -> list[str]:
    states: list[str] = []
    for offset in range(0, samples.size, chunk):
        states.append(gate.feed(samples[offset : offset + chunk]))
    return states


class VadGateTestBase(unittest.TestCase):
    def make_gate(self, **kwargs) -> vv.VadGate:
        params = {"silence_ms": 600, "min_speech_ms": 250, "max_ms": 6000, "speech_pad_ms": 200}
        params.update(kwargs)
        return vv.VadGate(str(MODEL_PATH), **params)


class SilenceTest(VadGateTestBase):
    """§6.3：纯静音 1 s → 全程 silence，`result()` 为空。"""

    def test_pure_silence_stays_silent(self) -> None:
        gate = self.make_gate()
        states = _feed_all(gate, _silence(1.0))
        self.assertEqual(set(states), {vv.SILENCE})
        self.assertEqual(gate.result().size, 0)
        self.assertEqual(gate.flush(), vv.SILENCE)
        self.assertEqual(gate.result().size, 0)
        self.assertEqual(gate.speech_ms(), 0.0)


class SpeechThenSilenceTest(VadGateTestBase):
    """§6.4：1.5 s 语音 + 0.8 s 静音 → 先 speech 再 end，`result()` 时长 1.5–2.0 s。"""

    def test_speech_then_end(self) -> None:
        gate = self.make_gate()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "utterance.wav"
            wave_in = np.concatenate([_voiced(1.5), _silence(0.8)])
            va.write_wav(str(path), wave_in)
            samples, rate = va.read_wav(str(path))
            self.assertEqual(rate, vv.SAMPLE_RATE)
            states = _feed_all(gate, samples)
        self.assertIn(vv.SPEECH, states)
        self.assertIn(vv.END, states)
        self.assertNotIn(vv.OVERFLOW, states)
        self.assertLess(states.index(vv.SPEECH), states.index(vv.END))
        # 收尾之后剩下的静音块照 §6.6 报 silence，所以 END 不一定是最后一块
        self.assertEqual(set(states[states.index(vv.END) :]), {vv.END, vv.SILENCE})
        result = gate.result()
        self.assertEqual(result.dtype, np.float32)
        duration_s = result.size / float(vv.SAMPLE_RATE)
        self.assertGreaterEqual(duration_s, 1.5)
        self.assertLessEqual(duration_s, 2.0)
        start_ms, core_ms = gate.last_span_ms()
        self.assertGreater(core_ms, 1200.0)
        self.assertGreaterEqual(start_ms, 0.0)


class OverflowTest(VadGateTestBase):
    """§6.5：8 s 连续语音 → overflow，`result()` 时长 ≤ 6.2 s。"""

    def test_overflow_truncates_at_max(self) -> None:
        gate = self.make_gate()
        states = _feed_all(gate, _voiced(8.0))
        self.assertIn(vv.OVERFLOW, states)
        self.assertNotIn(vv.END, states[: states.index(vv.OVERFLOW) + 1])
        duration_s = gate.result().size / float(vv.SAMPLE_RATE)
        self.assertLessEqual(duration_s, 6.2 + 1e-6)
        self.assertGreater(duration_s, 5.8)
        self.assertGreater(gate.last_span_ms()[1], 5900.0)


class ResetAfterEndTest(VadGateTestBase):
    """§6.6：`end` 之后再 `feed` → 返回 silence（状态已自动复位）。"""

    def test_feed_after_end_is_silence(self) -> None:
        gate = self.make_gate()
        states = _feed_all(gate, np.concatenate([_voiced(1.5), _silence(0.8)]))
        self.assertIn(vv.END, states)
        result_before = gate.result()
        self.assertGreater(result_before.size, 0)
        after = gate.feed(_silence(0.2))
        self.assertEqual(after, vv.SILENCE)
        # 自动复位只清工作区，result() 仍能取到刚收尾那一段
        np.testing.assert_array_equal(gate.result(), result_before)
        # 复位后能正常听下一轮
        self.assertFalse(gate.in_speech())
        self.assertEqual(gate.speech_ms(), 0.0)


class EdgeCaseTest(VadGateTestBase):
    """§5 的错误与边界行为。"""

    def test_missing_model_raises_file_not_found_with_absolute_path(self) -> None:
        missing = REPO_ROOT / "tools" / "voice" / "models" / "vad" / "no-such-model.onnx"
        with self.assertRaises(FileNotFoundError) as ctx:
            vv.VadGate(str(missing))
        self.assertIn(str(missing), str(ctx.exception))
        self.assertTrue(Path(str(ctx.exception).split("：")[-1]).is_absolute())

    def test_empty_frame_keeps_state_and_advances_nothing(self) -> None:
        gate = self.make_gate()
        self.assertEqual(gate.feed(np.zeros(0, dtype=np.float32)), vv.SILENCE)
        self.assertEqual(gate.speech_ms(), 0.0)
        states = _feed_all(gate, np.concatenate([_voiced(1.5), _silence(0.8)]))
        self.assertIn(vv.END, states)

    def test_arbitrary_chunk_sizes_do_not_crash(self) -> None:
        gate = self.make_gate()
        wave_in = np.concatenate([_voiced(1.5), _silence(0.8)])
        states = _feed_all(gate, wave_in, chunk=300)
        self.assertIn(vv.END, states)
        self.assertGreater(gate.result().size, 0)

    def test_max_ms_without_speech_never_overflows(self) -> None:
        gate = self.make_gate(max_ms=1000)
        states = _feed_all(gate, _silence(8.0))
        self.assertNotIn(vv.OVERFLOW, states)
        self.assertEqual(set(states), {vv.SILENCE})
        self.assertEqual(gate.result().size, 0)

    def test_result_empty_before_any_end(self) -> None:
        gate = self.make_gate()
        self.assertEqual(gate.result().size, 0)
        _feed_all(gate, _voiced(0.5))
        self.assertEqual(gate.result().size, 0)

    def test_reset_clears_result_and_span(self) -> None:
        gate = self.make_gate(max_ms=1000)
        _feed_all(gate, _voiced(2.0))
        self.assertGreater(gate.result().size, 0)
        gate.reset()
        self.assertEqual(gate.result().size, 0)
        self.assertEqual(gate.last_span_ms(), (0.0, 0.0))
        self.assertFalse(gate.in_speech())

    def test_bad_parameters_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.make_gate(silence_ms=0)
        with self.assertRaises(ValueError):
            self.make_gate(max_ms=0)
        with self.assertRaises(ValueError):
            self.make_gate(min_speech_ms=-1)
        with self.assertRaises(ValueError):
            self.make_gate(speech_pad_ms=-1)
        with self.assertRaises(ValueError):
            self.make_gate(threshold=1.5)

    def test_defaults_match_the_task_book(self) -> None:
        gate = vv.VadGate(str(MODEL_PATH))
        self.assertEqual(gate.silence_ms, 600)
        self.assertEqual(gate.min_speech_ms, 250)
        self.assertEqual(gate.max_ms, 6000)
        self.assertEqual(gate.speech_pad_ms, 200)
        self.assertEqual(gate.threshold, 0.5)
        self.assertEqual(gate.window_size, 512)
        self.assertEqual(gate.sample_rate, 16000)
        self.assertEqual(
            (vv.SPEECH, vv.SILENCE, vv.END, vv.OVERFLOW), ("speech", "silence", "end", "overflow")
        )

    def test_flush_finalizes_a_finished_stream(self) -> None:
        gate = self.make_gate()
        # 语音后面只留 0.3 s 静音：自然 end 还没到，必须靠 flush() 收尾
        samples = np.concatenate([_voiced(1.5), _silence(0.3)])
        states = _feed_all(gate, samples)
        self.assertNotIn(vv.END, states)
        self.assertEqual(gate.flush(), vv.END)
        self.assertGreater(gate.result().size, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
