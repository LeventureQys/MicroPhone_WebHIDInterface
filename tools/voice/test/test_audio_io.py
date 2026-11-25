"""SubStage 1.2 单元测试：`tools/voice/audio_io.py`。

覆盖任务书 §6 的第 1、2 条，外加错误分级（§5）与采集流行为（§7.2 / §7.5）的离线用例。
全部用例不依赖真实麦克风：设备相关分支用假 PortAudio 流或纯函数注入。
运行：`python -m unittest discover -s tools/voice/test -p "test_audio_io.py"`
"""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.voice import audio_io as va


def _sine(seconds: float, freq: float = 440.0, amplitude: float = 0.5, rate: int = va.SAMPLE_RATE) -> np.ndarray:
    t = np.arange(int(round(seconds * rate))) / float(rate)
    return (amplitude * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


class _TmpDirMixin:
    def setUp(self) -> None:  # noqa: D401 - unittest 钩子
        self._tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def wav_path(self, name: str = "case.wav") -> Path:
        return self.tmpdir / name


class WavReadTest(_TmpDirMixin, unittest.TestCase):
    """§6.1：`read_wav` 的格式门禁。"""

    def test_reads_16k_mono_and_keeps_float_range(self) -> None:
        path = self.wav_path()
        va.write_wav(str(path), _sine(0.5))
        samples, rate = va.read_wav(str(path))
        self.assertEqual(rate, va.SAMPLE_RATE)
        self.assertEqual(samples.ndim, 1)
        self.assertEqual(samples.dtype, np.float32)
        self.assertEqual(samples.shape, (8000,))
        self.assertGreaterEqual(float(samples.min()), -1.0)
        self.assertLessEqual(float(samples.max()), 1.0)
        self.assertAlmostEqual(float(np.abs(samples).max()), 0.5, places=2)

    def test_rejects_44k_with_actual_triple(self) -> None:
        path = self.wav_path("44k.wav")
        va.write_wav(str(path), _sine(0.2, rate=44100), rate=44100)
        with self.assertRaises(ValueError) as ctx:
            va.read_wav(str(path))
        message = str(ctx.exception)
        self.assertIn("rate=44100", message)
        self.assertIn("width=2", message)
        self.assertIn("channels=1", message)

    def test_rejects_stereo_with_actual_triple(self) -> None:
        path = self.wav_path("stereo.wav")
        interleaved = np.repeat(_sine(0.1), 2)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(va.SAMPLE_RATE)
            handle.writeframes(np.rint(interleaved * 32767.0).astype("<i2").tobytes())
        with self.assertRaises(ValueError) as ctx:
            va.read_wav(str(path))
        self.assertIn("channels=2", str(ctx.exception))

    def test_missing_file_raises_file_not_found(self) -> None:
        with self.assertRaises(FileNotFoundError):
            va.read_wav(str(self.tmpdir / "nope.wav"))


class WavRoundTripTest(_TmpDirMixin, unittest.TestCase):
    """§6.2：`write_wav` → `read_wav` 往返误差 ≤ 1/32768。"""

    def test_round_trip_error_within_quantization(self) -> None:
        original = _sine(0.25, freq=1000.0, amplitude=0.9)
        path = self.wav_path()
        va.write_wav(str(path), original)
        restored, rate = va.read_wav(str(path))
        self.assertEqual(rate, va.SAMPLE_RATE)
        self.assertEqual(restored.shape, original.shape)
        self.assertLessEqual(float(np.max(np.abs(restored - original))), 1.0 / 32768.0)

    def test_write_clips_out_of_range(self) -> None:
        path = self.wav_path("clip.wav")
        va.write_wav(str(path), np.array([-3.0, -1.0, 0.0, 1.0, 3.0], dtype=np.float32))
        samples, _ = va.read_wav(str(path))
        self.assertEqual(samples.shape, (5,))
        self.assertTrue(np.all(samples >= -1.0))
        self.assertTrue(np.all(samples <= 1.0))
        self.assertAlmostEqual(float(samples[0]), -1.0, places=6)
        self.assertAlmostEqual(float(samples[1]), -1.0, places=6)
        self.assertAlmostEqual(float(samples[3]), 32767.0 / 32768.0, places=6)
        self.assertAlmostEqual(float(samples[4]), 32767.0 / 32768.0, places=6)

    def test_write_creates_missing_directory(self) -> None:
        path = self.tmpdir / "nested" / "deep" / "out.wav"
        va.write_wav(str(path), _sine(0.05))
        self.assertTrue(path.is_file())


class ErrorClassificationTest(unittest.TestCase):
    """§5：`AudioUnavailable.kind` 的分级（权限 → 错误码 → 占用 → 不存在）。"""

    def test_invalid_sample_rate_code_is_unavailable(self) -> None:
        kind, detail = va._classify_portaudio_error(
            RuntimeError("Invalid sample rate [PaErrorCode -9997]"), context="打开输入设备"
        )
        self.assertEqual(kind, va.TARGET_KIND_UNAVAILABLE)
        self.assertIn("Invalid sample rate", detail)
        self.assertIn("打开输入设备", detail)

    def test_device_unavailable_code_is_busy(self) -> None:
        kind, _ = va._classify_portaudio_error(RuntimeError("Device unavailable [PaErrorCode -9985]"))
        self.assertEqual(kind, va.TARGET_KIND_BUSY)

    def test_permission_text_wins_over_code(self) -> None:
        kind, detail = va._classify_portaudio_error(
            RuntimeError("Unanticipated host error [PaErrorCode -9999]: Access is denied")
        )
        self.assertEqual(kind, va.TARGET_KIND_DENIED)
        self.assertIn("Access is denied", detail)

    def test_unmatched_error_defaults_to_unavailable(self) -> None:
        kind, _ = va._classify_portaudio_error(RuntimeError("something odd happened"))
        self.assertEqual(kind, va.TARGET_KIND_UNAVAILABLE)

    def test_audio_unavailable_rejects_unknown_kind(self) -> None:
        with self.assertRaises(ValueError):
            va.AudioUnavailable("nope", "detail")
        error = va.AudioUnavailable(va.TARGET_KIND_BUSY, "占用中")
        self.assertEqual(error.kind, va.TARGET_KIND_BUSY)
        self.assertTrue(str(error).startswith("busy"))


class DeviceResolveTest(unittest.TestCase):
    """§4.1：`open_stream` 的 device 参数解析（纯函数，不需要设备）。"""

    DEVICES = [
        {"index": 0, "name": "Microsoft Sound Mapper - Input", "channels": 2, "default": False},
        {"index": 1, "name": "麦克风 (USB Audio Device)", "channels": 1, "default": True},
        {"index": 9, "name": "麦克风 (USB Audio Device)", "channels": 1, "default": False},
    ]

    def test_none_picks_default(self) -> None:
        self.assertEqual(va._resolve_device(None, self.DEVICES), (1, "麦克风 (USB Audio Device)"))

    def test_none_without_default_raises_unavailable(self) -> None:
        without = [{**entry, "default": False} for entry in self.DEVICES]
        with self.assertRaises(va.AudioUnavailable) as ctx:
            va._resolve_device(None, without)
        self.assertEqual(ctx.exception.kind, va.TARGET_KIND_UNAVAILABLE)

    def test_int_index_round_trip(self) -> None:
        self.assertEqual(va._resolve_device(9, self.DEVICES)[0], 9)

    def test_unknown_index_raises_unavailable(self) -> None:
        with self.assertRaises(va.AudioUnavailable) as ctx:
            va._resolve_device(77, self.DEVICES)
        self.assertEqual(ctx.exception.kind, va.TARGET_KIND_UNAVAILABLE)

    def test_name_substring_is_case_insensitive_and_takes_first(self) -> None:
        self.assertEqual(va._resolve_device("usb audio device", self.DEVICES)[0], 1)
        self.assertEqual(va._resolve_device("USB AUDIO", self.DEVICES)[0], 1)
        self.assertEqual(va._resolve_device("麦克风", self.DEVICES)[0], 1)

    def test_unknown_name_raises_unavailable(self) -> None:
        with self.assertRaises(va.AudioUnavailable) as ctx:
            va._resolve_device("No Such Microphone", self.DEVICES)
        self.assertEqual(ctx.exception.kind, va.TARGET_KIND_UNAVAILABLE)

    def test_empty_name_and_bad_type(self) -> None:
        with self.assertRaises(ValueError):
            va._resolve_device("   ", self.DEVICES)
        with self.assertRaises(TypeError):
            va._resolve_device(1.5, self.DEVICES)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            va._resolve_device(True, self.DEVICES)  # type: ignore[arg-type]


class DeviceEnumerationTest(unittest.TestCase):
    """§7.1 / §4.1：枚举是只读的，没有麦克风也必须能跑。"""

    def test_list_devices_shape(self) -> None:
        devices = va.list_devices()
        self.assertIsInstance(devices, list)
        for entry in devices:
            self.assertEqual(set(entry), {"index", "name", "channels", "default"})
            self.assertIsInstance(entry["index"], int)
            self.assertIsInstance(entry["name"], str)
            self.assertGreaterEqual(entry["channels"], 1)
            self.assertIsInstance(entry["default"], bool)
        indexes = [entry["index"] for entry in devices]
        self.assertEqual(indexes, sorted(indexes))
        self.assertEqual(len(indexes), len(set(indexes)))

    def test_open_stream_with_unknown_name_raises_audio_unavailable(self) -> None:
        with self.assertRaises(va.AudioUnavailable) as ctx:
            va.open_stream("绝对不存在的麦克风名称-XYZ")
        self.assertEqual(ctx.exception.kind, va.TARGET_KIND_UNAVAILABLE)

    def test_open_stream_with_unknown_index_raises_audio_unavailable(self) -> None:
        with self.assertRaises(va.AudioUnavailable) as ctx:
            va.open_stream(987654)
        self.assertEqual(ctx.exception.kind, va.TARGET_KIND_UNAVAILABLE)


class FrameRingTest(unittest.TestCase):
    """`read()` 的底层缓冲：定长、丢最旧、绝不补零。"""

    def test_push_take_keeps_order(self) -> None:
        ring = va._FrameRing(8)
        ring.push(np.arange(4, dtype=np.float32))
        self.assertEqual(ring.available(), 4)
        np.testing.assert_array_equal(ring.take(4), np.arange(4, dtype=np.float32))
        self.assertEqual(ring.available(), 0)
        self.assertEqual(ring.take(4).size, 0)

    def test_wraparound(self) -> None:
        ring = va._FrameRing(5)
        ring.push(np.array([0, 1, 2, 3], dtype=np.float32))
        ring.take(3)
        ring.push(np.array([4, 5, 6], dtype=np.float32))
        np.testing.assert_array_equal(ring.take(4), np.array([3, 4, 5, 6], dtype=np.float32))

    def test_drops_oldest_when_full(self) -> None:
        ring = va._FrameRing(4)
        ring.push(np.array([0, 1, 2, 3, 4, 5], dtype=np.float32))
        self.assertEqual(ring.dropped, 2)
        np.testing.assert_array_equal(ring.take(4), np.array([2, 3, 4, 5], dtype=np.float32))

    def test_oversized_push_keeps_tail(self) -> None:
        ring = va._FrameRing(3)
        ring.push(np.arange(10, dtype=np.float32))
        np.testing.assert_array_equal(ring.take(9), np.array([7, 8, 9], dtype=np.float32))
        self.assertEqual(ring.total, 10)


class _FakePortAudioStream:
    """最小 PortAudio 流替身：只提供 AudioStream 用到的 active / stop / close。"""

    def __init__(self) -> None:
        self.active = True
        self.stop_calls = 0
        self.close_calls = 0

    def stop(self) -> None:
        self.stop_calls += 1
        self.active = False

    def close(self) -> None:
        self.close_calls += 1
        self.active = False


def _tone(seconds: float, rate: int, freq: float = 440.0, amplitude: float = 0.5) -> np.ndarray:
    t = np.arange(int(round(seconds * rate))) / float(rate)
    return (amplitude * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


def _peak_freq(samples: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(samples.size)))
    freqs = np.fft.rfftfreq(samples.size, 1.0 / float(rate))
    return float(freqs[int(np.argmax(spectrum))])


def _rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(samples.astype(np.float64)))))


class SampleRateFallbackTest(unittest.TestCase):
    """§3.9.1：端点拒绝 16 kHz 时按原生采样率采集 + 内部线性插值重采样。

    验收口径（设计文档 §3.9.1 第 6 条）：合成 440 Hz 正弦走这条路 → 峰值频率偏差 ≤ 5%、
    RMS 偏差 ≤ 1 dB；对上层仍是 16000 Hz。
    """

    def make(self, source_rate: int = va.SAMPLE_RATE) -> tuple[va.AudioStream, _FakePortAudioStream]:
        audio = va.AudioStream(device_index=0, device_name="fake", source_rate=source_rate)
        fake = _FakePortAudioStream()
        audio._attach(fake)
        return audio, fake

    def feed(self, audio: va.AudioStream, samples: np.ndarray, block: int = 1024) -> None:
        for offset in range(0, samples.size, block):
            audio._ingest(samples[offset : offset + block])

    def assert_tone_ok(self, out: np.ndarray, *, freq: float = 440.0, amplitude: float = 0.5) -> None:
        self.assertEqual(out.shape, (va.SAMPLE_RATE,))
        segment = out[2000:14000]
        peak = _peak_freq(segment, va.SAMPLE_RATE)
        self.assertLessEqual(abs(peak - freq) / freq, 0.05, f"峰值频率 {peak} Hz 偏离 {freq} Hz 超过 5%")
        expected = amplitude / float(np.sqrt(2.0))
        delta_db = 20.0 * float(np.log10(_rms(segment) / expected))
        self.assertLessEqual(abs(delta_db), 1.0, f"RMS 偏差 {delta_db:.3f} dB 超过 1 dB")

    def test_native_16k_has_no_resampler(self) -> None:
        audio, _ = self.make(va.SAMPLE_RATE)
        self.assertEqual(audio.rate, va.SAMPLE_RATE)
        self.assertEqual(audio.source_rate, va.SAMPLE_RATE)
        self.assertFalse(audio.resampled)
        self.assertIsNone(audio.fallback_note)

    def test_48k_fallback_keeps_440hz_and_rms(self) -> None:
        audio, _ = self.make(48000)
        self.assertEqual(audio.rate, va.SAMPLE_RATE)
        self.assertEqual(audio.source_rate, 48000)
        self.assertTrue(audio.resampled)
        self.feed(audio, _tone(1.0, 48000))
        self.assert_tone_ok(audio.read(va.SAMPLE_RATE, timeout_s=1.0))

    def test_44100_fallback_keeps_440hz_and_length(self) -> None:
        audio, _ = self.make(44100)
        self.assertTrue(audio.resampled)
        self.feed(audio, _tone(1.0, 44100))
        self.assert_tone_ok(audio.read(va.SAMPLE_RATE, timeout_s=1.0))

    def test_resampler_is_block_size_invariant(self) -> None:
        source = _tone(0.5, 48000)
        small = va._LinearResampler(48000)
        large = va._LinearResampler(48000)
        small_out = np.concatenate(
            [small.push(source[i : i + 333]) for i in range(0, source.size, 333)]
        )
        large_out = np.concatenate(
            [large.push(source[i : i + 4096]) for i in range(0, source.size, 4096)]
        )
        self.assertEqual(small_out.size, large_out.size)
        np.testing.assert_allclose(small_out, large_out, rtol=0.0, atol=1e-6)

    def test_resampler_produced_frames_matches_ratio(self) -> None:
        resampler = va._LinearResampler(48000)
        out = resampler.push(_tone(1.0, 48000))
        self.assertEqual(out.size, va.SAMPLE_RATE)
        self.assertEqual(resampler.fed_frames, 48000)
        self.assertEqual(resampler.produced_frames, va.SAMPLE_RATE)
        self.assertEqual(resampler.step, 3.0)

    def test_resampler_handles_tiny_blocks_without_phase_reset(self) -> None:
        # 回归：早期实现只保留"pos 之前一个样本"，每次 push 1 个样本时相位会被重置，
        # 输出条数会按 1/step 比例缩水。这里锁住"分块不影响相位"。
        source = _tone(0.1, 48000)
        tiny = va._LinearResampler(48000)
        tiny_out = np.concatenate([tiny.push(source[i : i + 1]) for i in range(source.size)])
        whole = va._LinearResampler(48000)
        whole_out = whole.push(source)
        self.assertLessEqual(abs(tiny_out.size - whole_out.size), 1)
        shorter = min(tiny_out.size, whole_out.size)
        np.testing.assert_allclose(tiny_out[:shorter], whole_out[:shorter], rtol=0.0, atol=1e-6)

    def test_fallback_decision_only_on_sample_rate_error(self) -> None:
        rate_error = va.AudioUnavailable(
            va.TARGET_KIND_UNAVAILABLE,
            "Error opening InputStream: Invalid sample rate [PaErrorCode -9997]（打开输入设备）",
        )
        self.assertTrue(va._is_sample_rate_fallback(rate_error))
        self.assertTrue(
            va._is_sample_rate_fallback(
                va.AudioUnavailable(va.TARGET_KIND_UNAVAILABLE, "boom [PaErrorCode -9997]")
            )
        )
        # 不是 unavailable（被占用/权限拒绝）一律不兜底
        self.assertFalse(
            va._is_sample_rate_fallback(va.AudioUnavailable(va.TARGET_KIND_BUSY, "Invalid sample rate"))
        )
        self.assertFalse(
            va._is_sample_rate_fallback(va.AudioUnavailable(va.TARGET_KIND_DENIED, "Invalid sample rate"))
        )
        # unavailable 但不是采样率问题（设备真不存在）：兜底没意义
        self.assertFalse(
            va._is_sample_rate_fallback(
                va.AudioUnavailable(va.TARGET_KIND_UNAVAILABLE, "Invalid device [PaErrorCode -9996]")
            )
        )
        self.assertFalse(va._is_sample_rate_fallback(None))

    def test_fallback_note_matches_design_wording(self) -> None:
        error = va.AudioUnavailable(
            va.TARGET_KIND_UNAVAILABLE,
            "Error opening InputStream: Invalid sample rate [PaErrorCode -9997]"
            "（打开输入设备 '麦克风' (index 21, 16000 Hz)）",
        )
        self.assertEqual(
            va._fallback_note(error, 48000),
            "[audio] 16 kHz 被拒（-9997），改用 48 kHz 采集 + 重采样",
        )
        self.assertEqual(
            va._fallback_note(error, 44100),
            "[audio] 16 kHz 被拒（-9997），改用 44.1 kHz 采集 + 重采样",
        )


class AudioStreamBehaviourTest(unittest.TestCase):
    """§5 / §7.2：采集流的读取、存活判定与失败形态（用假流，不需要麦克风）。"""

    def make(self, *, stall_s: float = 5.0) -> tuple[va.AudioStream, _FakePortAudioStream]:
        audio = va.AudioStream(device_index=0, device_name="fake", stall_s=stall_s)
        fake = _FakePortAudioStream()
        audio._attach(fake)
        return audio, fake

    def test_read_returns_exact_frames(self) -> None:
        audio, _ = self.make()
        ramp = np.arange(600, dtype=np.float32) / 1000.0
        audio._ingest(ramp)
        block = audio.read(512)
        self.assertEqual(block.shape, (512,))
        self.assertEqual(block.dtype, np.float32)
        np.testing.assert_allclose(block, ramp[:512])
        self.assertEqual(audio.rate, va.SAMPLE_RATE)

    def test_read_returns_short_tail_instead_of_padding(self) -> None:
        audio, _ = self.make()
        audio._ingest(np.ones(70, dtype=np.float32))
        block = audio.read(512, timeout_s=0.05)
        self.assertEqual(block.shape, (70,))
        np.testing.assert_allclose(block, np.ones(70, dtype=np.float32))

    def test_read_rejects_non_positive_frames(self) -> None:
        audio, _ = self.make()
        with self.assertRaises(ValueError):
            audio.read(0)

    def test_read_after_close_raises_busy(self) -> None:
        audio, fake = self.make()
        audio.close()
        self.assertEqual(fake.close_calls, 1)
        self.assertFalse(audio.alive())
        with self.assertRaises(va.AudioUnavailable) as ctx:
            audio.read(512, timeout_s=0.05)
        self.assertEqual(ctx.exception.kind, va.TARGET_KIND_BUSY)

    def test_close_is_idempotent(self) -> None:
        audio, fake = self.make()
        audio.close()
        audio.close()
        self.assertEqual(fake.stop_calls, 1)
        self.assertEqual(fake.close_calls, 1)

    def test_context_manager_closes(self) -> None:
        audio, fake = self.make()
        with audio as entered:
            self.assertIs(entered, audio)
        self.assertEqual(fake.close_calls, 1)
        self.assertFalse(audio.alive())

    def test_stream_stopped_externally_is_not_alive_and_read_raises(self) -> None:
        audio, fake = self.make()
        audio._ingest(np.zeros(64, dtype=np.float32))
        self.assertTrue(audio.alive())
        fake.active = False  # 外力把流停了（摘麦 / 驱动重载）
        self.assertFalse(audio.alive())
        # 已缓冲的样本先交出去，交完之后必须报 busy，不许返回全零数组
        np.testing.assert_allclose(audio.read(32), np.zeros(32, dtype=np.float32))
        tail = audio.read(64, timeout_s=0.05)
        self.assertEqual(tail.size, 32)
        with self.assertRaises(va.AudioUnavailable) as ctx:
            audio.read(64, timeout_s=0.05)
        self.assertEqual(ctx.exception.kind, va.TARGET_KIND_BUSY)

    def test_callback_stall_marks_dead(self) -> None:
        audio, _ = self.make(stall_s=0.05)
        self.assertTrue(audio.alive())
        time.sleep(0.1)
        self.assertFalse(audio.alive())
        with self.assertRaises(va.AudioUnavailable):
            audio.read(16, timeout_s=0.05)

    def test_ingest_records_overflow_flag(self) -> None:
        class _Status:
            input_overflow = True

        audio, _ = self.make()
        audio._ingest(np.zeros(8, dtype=np.float32), _Status())
        self.assertEqual(audio.overflow_count, 1)

    def test_read_blocks_until_data_arrives(self) -> None:
        audio, _ = self.make()
        started = time.perf_counter()
        audio._ingest(np.zeros(256, dtype=np.float32))
        block = audio.read(256, timeout_s=1.0)
        self.assertEqual(block.shape, (256,))
        self.assertLess(time.perf_counter() - started, 0.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
