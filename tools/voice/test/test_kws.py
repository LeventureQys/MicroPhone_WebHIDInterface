"""SubStage 2.1 单元测试：唤醒词文件、`WakeSpotter`、应答音、`listen_once` 状态机。

覆盖任务书 §6 的 6 条要求（`Document/Update/Alpha/v1.3.0/开发文档/SubStage_2.1.md`）。
全部离线、不依赖麦克风、不依赖 SAPI 运行时：含唤醒词的样例是 `test/data/` 下的两个固定 wav
（`wake-sentence.wav` = 唤醒词 + 一句指令，3.9 s；`wake-only.wav` = 只有唤醒词，2.0 s；
均由 Windows SAPI `Microsoft Huihui Desktop` 合成为 16 kHz/16 bit/单声道，改唤醒词时需重新合成）。
测试代码里不出现唤醒词字面量——显示名从 `keywords/xiaotang.txt` 的 `@` 段读出来。

运行：`python -m unittest discover -s tools/voice/test -p "test_kws.py"`
"""

from __future__ import annotations

import io
import sys
import time
import unittest
import wave
from pathlib import Path

import numpy as np

VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import listen as listen_mod  # noqa: E402
from kws import (  # noqa: E402
    DEFAULT_KEYWORDS_FILE,
    DEFAULT_MODEL_DIR,
    WakeSpotter,
    load_tokens,
    make_beep,
    parse_keywords_file,
    validate_keywords,
)
from listen import listen_once  # noqa: E402

try:  # SubStage 1.2 的产物；未交付时用同目录替身
    from audio_io import read_wav
except ImportError:
    from _stub_audio import read_wav

try:
    from vad import VadGate
except ImportError:
    from _stub_audio import VadGate

TOKENS_FILE = Path(DEFAULT_MODEL_DIR) / 'tokens.txt'
TEST_WAV_DIR = Path(DEFAULT_MODEL_DIR) / 'test_wavs'
DATA_DIR = VOICE_DIR / 'test' / 'data'
SENTENCE_WAV = DATA_DIR / 'wake-sentence.wav'
WAKE_ONLY_WAV = DATA_DIR / 'wake-only.wav'
VAD_MODEL = VOICE_DIR / 'models' / 'vad' / 'silero_vad.onnx'


def _replay_stream(samples: 'np.ndarray', name: str = 'synthetic'):
    return listen_mod._FilePlaybackStream(samples, name)


def _wav_duration_ms(data: bytes) -> float:
    with wave.open(io.BytesIO(data), 'rb') as handle:
        return handle.getnframes() * 1000.0 / handle.getframerate()


class WakeSpotterTest(unittest.TestCase):
    """§6.1 / §6.2 / §6.3：关键词文件合法性、命中、误唤醒。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.spotter = WakeSpotter(str(DEFAULT_MODEL_DIR), str(DEFAULT_KEYWORDS_FILE))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.spotter.close()

    def setUp(self) -> None:
        self.spotter.reset()

    def _sentence_samples(self) -> 'np.ndarray':
        if not SENTENCE_WAV.is_file():
            self.skipTest(f'缺样例 wav：{SENTENCE_WAV}（由 SAPI 合成，见完成报告）')
        samples, rate = read_wav(str(SENTENCE_WAV))
        self.assertEqual(rate, 16000)
        return samples

    def test_01_keywords_tokens_exist_in_model(self) -> None:
        """§6.1：`keywords/xiaotang.txt` 的每个 token 都在 `models/kws/tokens.txt` 里。"""
        raw = Path(DEFAULT_KEYWORDS_FILE).read_bytes()
        self.assertFalse(raw.startswith(b'\xef\xbb\xbf'), '关键词文件必须是无 BOM 的 UTF-8')
        text = raw.decode('utf-8')  # 解不开就证明不是 UTF-8
        self.assertTrue(text.endswith('\n'), '关键词文件必须以换行结尾（一行一词）')
        lines = [line for line in text.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, '当前只登记一个唤醒词')

        entries = parse_keywords_file(str(DEFAULT_KEYWORDS_FILE))
        self.assertEqual(len(entries), 1)
        tokens = entries[0]['tokens']
        self.assertEqual(len(tokens), 8, f'唤醒词是 4 个音节共 8 个 token，实际 {tokens}')
        self.assertTrue(entries[0]['display'], '关键词行必须带 @ 显示名')
        self.assertEqual(validate_keywords(str(DEFAULT_KEYWORDS_FILE), str(TOKENS_FILE)), [])
        self.assertTrue(set(tokens) <= load_tokens(str(TOKENS_FILE)))

    def test_02_matches_synthesized_speech(self) -> None:
        """§6.2：含唤醒词的合成语音 → `matches` 返回 True。"""
        samples = self._sentence_samples()
        self.assertTrue(self.spotter.matches(samples), '含唤醒词的合成语音必须命中')
        # 命中后自复位：同一段再喂一次仍然命中（一句话里连喊两次只算一次，靠的是复位而不是屏蔽）
        self.assertTrue(self.spotter.matches(samples), '命中后必须自复位，第二次仍能检出')
        self.assertFalse(self.spotter.matches(np.zeros(0, dtype=np.float32)), '空数组不参与判定')

    def test_03_no_false_wake_on_unrelated_wav(self) -> None:
        """§6.3：`models/kws/test_wavs/3.wav`（说的是别的词）→ False。"""
        wav = TEST_WAV_DIR / '3.wav'
        self.assertTrue(wav.is_file(), f'缺测试 wav：{wav}')
        samples, rate = read_wav(str(wav))
        self.assertEqual(rate, 16000)
        self.assertFalse(self.spotter.matches(samples), '无关语句不得唤醒')


class MakeBeepTest(unittest.TestCase):
    """§6.4：应答音的长度与淡入淡出。"""

    def test_04_beep_length_and_fades(self) -> None:
        beep = make_beep()
        self.assertEqual(beep.dtype, np.float32)
        self.assertEqual(beep.ndim, 1)
        self.assertEqual(len(beep), int(120 / 1000.0 * 16000))
        self.assertLess(abs(float(beep[0])), 0.02, '首个样本必须接近 0（10 ms 淡入）')
        self.assertLess(abs(float(beep[-1])), 0.02, '末个样本必须接近 0（10 ms 淡出）')
        self.assertGreater(float(np.max(np.abs(beep))), 0.1, '应答音不能是静音')

        fade = int(10 / 1000.0 * 16000)
        self.assertLess(abs(float(beep[0])), abs(float(beep[fade])))
        self.assertLess(abs(float(beep[-1])), abs(float(beep[-fade - 1])))

        short = make_beep(freq=440.0, ms=50)
        self.assertEqual(len(short), int(50 / 1000.0 * 16000))


class ListenOnceTest(unittest.TestCase):
    """§6.5 / §6.6：唤醒 → 录到端点、唤醒后无人说话按 timeout 退出。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.spotter = WakeSpotter(str(DEFAULT_MODEL_DIR), str(DEFAULT_KEYWORDS_FILE))
        cls.gate = VadGate(str(VAD_MODEL))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.spotter.close()

    def setUp(self) -> None:
        self.spotter.reset()
        if not (WAKE_ONLY_WAV.is_file() and SENTENCE_WAV.is_file()):
            self.skipTest(f'缺样例 wav：{DATA_DIR}（由 SAPI 合成，见完成报告）')
        self.wake_samples, rate = read_wav(str(WAKE_ONLY_WAV))
        self.assertEqual(rate, 16000)
        self.full_samples, rate = read_wav(str(SENTENCE_WAV))
        self.assertEqual(rate, 16000)

    def test_05_returns_segment_after_speech(self) -> None:
        """§6.5：唤醒 + 1.5 s 语音 + 0.8 s 静音 → 返回非空 wav，时长 1.4–2.2 s。"""
        speech = self.full_samples[int(2.0 * 16000):int(3.5 * 16000)]  # 句中的 1.5 s 语音
        self.assertEqual(speech.size, int(1.5 * 16000))
        samples = np.concatenate([
            self.wake_samples,
            np.zeros(int(0.25 * 16000), dtype=np.float32),
            speech,
            np.zeros(int(0.8 * 16000), dtype=np.float32),
        ])
        events: list[dict] = []
        data = listen_once(
            self.spotter, self.gate, _replay_stream(samples),
            timeout_s=6.0, on_event=lambda name, **fields: events.append({'name': name, **fields}),
            beep=False,
        )
        names = [event['name'] for event in events]
        self.assertIn('wake', names)
        self.assertTrue({'end', 'overflow'} & set(names), f'没走到端点：{events}')
        self.assertIsNotNone(data, '录到语音必须返回 wav 字节')

        with wave.open(io.BytesIO(data), 'rb') as handle:
            self.assertEqual(handle.getframerate(), 16000)
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getsampwidth(), 2)
        duration = _wav_duration_ms(data)
        self.assertGreaterEqual(duration, 1400.0)
        self.assertLessEqual(duration, 2200.0)

    def test_06_timeout_when_nobody_speaks(self) -> None:
        """§6.6：只有唤醒、无后续语音 → None（走 timeout），耗时 ≤ 6.5 s。"""
        samples = np.concatenate([
            self.wake_samples,
            np.zeros(int(8.0 * 16000), dtype=np.float32),
        ])
        events: list[dict] = []
        started = time.perf_counter()
        data = listen_once(
            self.spotter, self.gate, _replay_stream(samples),
            timeout_s=6.0, on_event=lambda name, **fields: events.append({'name': name, **fields}),
            beep=False,
        )
        elapsed = time.perf_counter() - started
        self.assertIsNone(data)
        self.assertLessEqual(elapsed, 6.5, f'超时退出耗时过长：{elapsed:.2f}s')
        self.assertIn('wake', [event['name'] for event in events])
        timeouts = [event for event in events if event['name'] == 'timeout']
        self.assertEqual(len(timeouts), 1, f'必须记一条 timeout：{events}')
        self.assertEqual(timeouts[0].get('phase'), 'listen')


if __name__ == '__main__':
    unittest.main(verbosity=2)
