"""SubStage 2.2 单元测试：ASR 解码（`tools/voice/asr.py`）。

覆盖任务书 §6 的 1/2/3/4/7 条，另加 §5 的边界（短音频、多声道、引擎生命周期、模型缺失）。
运行：`python -m unittest discover -s tools/voice/test -p "test_asr.py"`

合成语音 wav 由 Windows SAPI 生成（调研报告 §2.5 的办法），不依赖 SubStage 1.2 的 `audio_io`：
1.2 与本 SubStage 并行开发，测试里自带一个 10 行的最小 wav 写入器。
"""

from __future__ import annotations

import shutil
import struct
import subprocess
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

from tools.voice import asr as va

WAV_DIR = REPO_ROOT / "artifacts" / "voice" / "wav"
SPEECH_WAV = WAV_DIR / "xt-01.wav"
SPEECH_TEXT = "小唐小唐，把声音调亮一点"
PERF_LIMIT_MS = 400.0  # 任务书 §6.7；设计文档 §4.3 写 300 ms，本 SubStage 取任务书的 400 ms


def write_wav(path: Path, samples: np.ndarray, rate: int = 16000, channels: int = 1) -> Path:
    """最小 wav writer（内联，不依赖 audio_io）。samples 为 int16 的展平数据。"""
    data = np.asarray(samples, dtype=np.int16).tobytes()
    block_align = 2 * channels
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, 1, channels, rate, rate * block_align, block_align, 16
    )
    header += b"data" + struct.pack("<I", len(data))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + data)
    return path


def _synthesize_speech(target: Path) -> bool:
    """用 SAPI 合成一句中文（16 kHz / 16 bit / 单声道）。失败返回 False，由调用方 skip。"""
    powershell = shutil.which("powershell")
    if not powershell or not sys.platform.startswith("win"):
        return False
    script = "\n".join(
        [
            "Add-Type -AssemblyName System.Speech",
            "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo("
            "16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, "
            "[System.Speech.AudioFormat.AudioChannel]::Mono)",
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
            "$s.SelectVoice('Microsoft Huihui Desktop')",
            f"$s.SetOutputToWaveFile('{target}', $fmt)",
            f"$s.Speak('{SPEECH_TEXT}')",
            "$s.SetOutputToNull()",  # .NET Framework 下不调这句，wav 会停在 0 字节
            "$s.Dispose()",
        ]
    )
    with tempfile.TemporaryDirectory() as tmp:
        # PowerShell 5.1 按 GBK 读无 BOM 的 UTF-8 会解坏中文，必须存成 utf-8-sig（AGENTS.md 已知坑）。
        script_path = Path(tmp) / "sapi.ps1"
        script_path.write_text(script, encoding="utf-8-sig")
        try:
            completed = subprocess.run(
                [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                 "-File", str(script_path)],
                capture_output=True,
                timeout=120,
            )
        except (OSError, subprocess.SubprocessError):
            return False
    return completed.returncode == 0 and target.is_file() and target.stat().st_size > 1024


class _SpeechFixtureMixin(unittest.TestCase):
    """复用 `artifacts/voice/wav/xt-01.wav`；缺了就现场合成，合不出来才 skip。"""

    @classmethod
    def speech_wav(cls) -> bytes:
        if not SPEECH_WAV.is_file() and not _synthesize_speech(SPEECH_WAV):
            raise unittest.SkipTest(
                f"缺少合成语音 wav（{SPEECH_WAV}），且本机 SAPI 合成失败。"
                "注意：本机沙箱下由 Python 派生的 PowerShell 写 wav 会落成 0 字节，"
                "需先在 shell 里手动跑 SAPI 脚本（见 SubStage_2.2_完成报告.md §7 F6），"
                "或放任意 16 kHz / 16 bit / 单声道 wav 到该路径"
            )
        return SPEECH_WAV.read_bytes()


class AsrTranscribeTest(_SpeechFixtureMixin):
    """任务书 §6 的 1/2/3/4/7 条：`transcribe(wav_bytes)` 的对外行为。"""

    @classmethod
    def setUpClass(cls) -> None:
        if not (va.DEFAULT_MODEL_DIR / va.MODEL_FILE).is_file():
            raise unittest.SkipTest(f"ASR 模型缺失：{va.DEFAULT_MODEL_DIR}（先跑 `voice.cmd fetch`）")
        cls.tmpdir = tempfile.TemporaryDirectory()
        cls.engine = va.AsrEngine(va.DEFAULT_MODEL_DIR)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.engine.close()
        cls.tmpdir.cleanup()

    def tmp_path(self, name: str) -> Path:
        return Path(self.tmpdir.name) / name

    def test_01_speech_wav_returns_text_with_wake_word(self) -> None:
        """§6.1：一条合成语音 -> 非空文本，且规范化后含「小唐小唐」。"""
        text = self.engine.transcribe(self.speech_wav())
        self.assertTrue(text, "合成语音解码出空串")
        normalized = va.normalize(text)
        self.assertIn("小唐小唐", normalized)
        self.assertIn("亮", normalized)

    def test_02_non_wav_bytes_raise_value_error(self) -> None:
        """§6.2：非 wav 字节 -> ValueError，且消息是契约字面值（不许静默返回空串）。"""
        with self.assertRaises(ValueError) as ctx:
            self.engine.transcribe(b"not a wav")
        self.assertEqual(str(ctx.exception), "不是有效的 wav 数据")
        with self.assertRaises(ValueError):
            self.engine.transcribe(b"")

    def test_03_44k1_wav_raise_value_error_with_actual_rate(self) -> None:
        """§6.3：44.1 kHz -> ValueError，消息里带实际采样率。"""
        path = write_wav(self.tmp_path("tone-44k1.wav"), np.zeros(44100 // 2, dtype=np.int16), rate=44100)
        with self.assertRaises(ValueError) as ctx:
            self.engine.transcribe(path.read_bytes())
        message = str(ctx.exception)
        self.assertIn("44100", message)
        self.assertIn("16000", message)

    def test_04_silent_wav_returns_empty(self) -> None:
        """§6.4：全零 0.5 s -> 返回 ''，不抛。"""
        path = write_wav(self.tmp_path("silence.wav"), np.zeros(8000, dtype=np.int16))
        self.assertEqual(self.engine.transcribe(path.read_bytes()), "")

    def test_05_short_wav_returns_empty(self) -> None:
        """§5 边界：短于 100 ms 的合法 wav -> 返回 ''。"""
        path = write_wav(self.tmp_path("short.wav"), np.zeros(799, dtype=np.int16))
        self.assertEqual(self.engine.transcribe(path.read_bytes()), "")

    def test_06_wav_header_only_returns_empty(self) -> None:
        """§5 边界：只有 RIFF 头、0 采样 -> 返回 ''（不是"非法 wav"）。"""
        path = write_wav(self.tmp_path("empty.wav"), np.zeros(0, dtype=np.int16))
        self.assertEqual(self.engine.transcribe(path.read_bytes()), "")

    def test_07_perf_3_9s_within_limit(self) -> None:
        """§6.7：3.93 s 音频解码 ≤ 400 ms（本机实测 87 ms，基线 93 ms）。"""
        wav_bytes = self.speech_wav()
        with wave.open(str(SPEECH_WAV), "rb") as reader:
            duration_s = reader.getnframes() / reader.getframerate()
        self.assertGreater(duration_s, 3.5, "基线 wav 不是 3.9 s 左右，性能断言失去意义")
        timings = []
        for _ in range(3):
            tick = time.perf_counter()
            self.engine.transcribe(wav_bytes)
            timings.append((time.perf_counter() - tick) * 1000.0)
        self.assertLessEqual(
            max(timings), PERF_LIMIT_MS, f"解码 {timings} ms 超过 {PERF_LIMIT_MS} ms 上限"
        )


class AsrSamplesTest(_SpeechFixtureMixin):
    """`transcribe_samples` 的 dtype / 采样率 / 形状契约。"""

    @classmethod
    def setUpClass(cls) -> None:
        if not (va.DEFAULT_MODEL_DIR / va.MODEL_FILE).is_file():
            raise unittest.SkipTest(f"ASR 模型缺失：{va.DEFAULT_MODEL_DIR}")
        cls.engine = va.AsrEngine(va.DEFAULT_MODEL_DIR)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.engine.close()

    def test_11_int16_and_float32_agree(self) -> None:
        """int16 与 float32 两种 dtype 解出同一句话。"""
        samples = va.decode_wav(self.speech_wav())
        as_float = self.engine.transcribe_samples(samples)
        as_int16 = self.engine.transcribe_samples((samples * 32768.0).astype(np.int16))
        self.assertEqual(as_float, as_int16)
        self.assertIn("小唐小唐", as_float)

    def test_12_wrong_rate_raise_value_error(self) -> None:
        samples = va.decode_wav(self.speech_wav())
        with self.assertRaises(ValueError) as ctx:
            self.engine.transcribe_samples(samples, rate=8000)
        self.assertIn("8000", str(ctx.exception))

    def test_13_two_dimensional_samples_raise(self) -> None:
        with self.assertRaises(ValueError):
            self.engine.transcribe_samples(np.zeros((100, 2), dtype=np.float32))

    def test_14_silent_samples_return_empty(self) -> None:
        self.assertEqual(self.engine.transcribe_samples(np.zeros(16000, dtype=np.float32)), "")


class ModuleEntryTest(_SpeechFixtureMixin):
    """设计文档 §4.2 的模块级入口 `asr.py:transcribe(wav_bytes)`（与类方法并存）。"""

    def test_31_module_transcribe_reuses_default_engine(self) -> None:
        if not (va.DEFAULT_MODEL_DIR / va.MODEL_FILE).is_file():
            self.skipTest("ASR 模型缺失")
        wav_bytes = self.speech_wav()
        try:
            first = va.transcribe(wav_bytes)
            engine = va.default_engine()
            self.assertIs(va.default_engine(), engine, "默认引擎必须是同一个实例（不重复加载模型）")
            self.assertEqual(va.transcribe(wav_bytes), first)
            self.assertEqual(engine.transcribe(wav_bytes), first, "模块级与类方法的结果必须一致")
            self.assertIn("小唐小唐", va.normalize(first))

            va.close_default_engine()
            va.close_default_engine()  # 重复关闭无害
            self.assertIsNone(va._DEFAULT_ENGINE)
            self.assertEqual(va.transcribe(wav_bytes), first, "关闭后应能惰性重开")
        finally:
            va.close_default_engine()


class AsrEngineLifecycleTest(unittest.TestCase):
    """构造/关闭/能力探测：这些都不依赖模型里跑一次解码。"""

    def test_21_missing_model_raises_file_not_found_with_absolute_path(self) -> None:
        """§5：模型文件缺失 -> 构造时 FileNotFoundError（绝对路径）。"""
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError) as ctx:
                va.AsrEngine(tmp)
            message = str(ctx.exception)
            self.assertIn("model.int8.onnx", message)
            self.assertIn(str(Path(tmp).resolve()), message)

    def test_22_close_is_idempotent_and_blocks_transcribe(self) -> None:
        if not (va.DEFAULT_MODEL_DIR / va.MODEL_FILE).is_file():
            self.skipTest("ASR 模型缺失")
        engine = va.AsrEngine(va.DEFAULT_MODEL_DIR)
        engine.close()
        engine.close()
        with self.assertRaises(RuntimeError):
            engine.transcribe(b"anything")

    def test_23_stdlib_decoder_replaces_missing_read_wave(self) -> None:
        """任务书 §4.1 的"不许用 sherpa_onnx.read_wave"：2.0.3 里它确实不存在。

        这条断言是为了在升级 sherpa-onnx 时立刻暴露"我们为什么自己解 wav"的前提。
        """
        import sherpa_onnx

        self.assertFalse(hasattr(sherpa_onnx, "read_wave"))
        self.assertTrue(callable(va.decode_wav))

    def test_24_multichannel_wav_is_downmixed(self) -> None:
        """多声道按帧取平均：左声道 0、右声道满幅 -> 均值落在中间。"""
        left = np.zeros(1600, dtype=np.int16)
        right = np.full(1600, 16384, dtype=np.int16)
        interleaved = np.column_stack([left, right]).reshape(-1)
        with tempfile.TemporaryDirectory() as tmp:
            path = write_wav(Path(tmp) / "stereo.wav", interleaved, channels=2)
            samples = va.decode_wav(path.read_bytes())
        self.assertEqual(samples.shape, (1600,))
        self.assertAlmostEqual(float(samples.mean()), 0.25, places=4)

    def test_25_non_bytes_wav_rejected(self) -> None:
        with self.assertRaises(TypeError):
            va.decode_wav("not bytes")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main(verbosity=2)
