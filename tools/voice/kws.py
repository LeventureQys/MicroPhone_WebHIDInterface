"""唤醒词检测（sherpa-onnx KWS）与应答音生成。

任务书：`Document/Update/Alpha/v1.3.0/开发文档/SubStage_2.1.md` §4.2 / §4.3。

两条硬规则（产品要求，别在这里"优化"掉）：
1. 唤醒词只存在于 `keywords/*.txt`，代码里不出现任何中文唤醒词字面量——改词是改文件。
2. `matches()` 命中即自复位，一句话里连喊两次只算一次。
"""

from __future__ import annotations

import os

import numpy as np
import sherpa_onnx

SAMPLE_RATE = 16000

_VOICE_DIR = os.path.dirname(os.path.abspath(__file__))
KEYWORDS_DIR = os.path.join(_VOICE_DIR, 'keywords')
DEFAULT_KEYWORDS_FILE = os.path.join(KEYWORDS_DIR, 'xiaotang.txt')
DEFAULT_MODEL_DIR = os.path.join(_VOICE_DIR, 'models', 'kws')

# 模型三件套的固定文件名（SubStage 1.1 拍平后的形状，见 SubStage_1.1.md §4.2）
ENCODER_FILE = 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'
DECODER_FILE = 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'
JOINER_FILE = 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'
TOKENS_FILE = 'tokens.txt'

# 一次 accept_waveform 的粒度：100 ms 与 sherpa-onnx 官方 KWS 示例一致，
# 更小只是多几次调用，更大则命中延迟变高。
CHUNK = 1600

BEEP_FREQ_HZ = 880.0
BEEP_MS = 120
BEEP_FADE_MS = 10
# 0.3 满幅：比 TTS 播报低，但离 1.0 留出余量，避免叠加其它声音时爆音。
BEEP_AMPLITUDE = 0.3


def _require_file(path: str) -> str:
    """缺文件时抛 `FileNotFoundError`，消息里必须是绝对路径（任务书 §5）。"""
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        raise FileNotFoundError(absolute)
    return absolute


def load_tokens(tokens_path: str) -> set[str]:
    """读 `tokens.txt`（每行 `token id`），返回 token 集合。"""
    absolute = _require_file(tokens_path)
    tokens: set[str] = set()
    with open(absolute, 'r', encoding='utf-8') as handle:
        for line in handle:
            parts = line.split()
            if parts:
                tokens.add(parts[0])
    return tokens


def parse_keywords_file(keywords_file: str) -> list[dict]:
    """解析 sherpa-onnx 关键词文件。

    一行的形状是 `<token> <token> ... [:<boost>] [@<显示名>]`；
    返回 `[{"tokens": [...], "display": str, "raw": str}, ...]`（空行与注释行跳过）。
    """
    absolute = _require_file(keywords_file)
    entries: list[dict] = []
    with open(absolute, 'r', encoding='utf-8') as handle:
        for line in handle:
            raw = line.rstrip('\r\n')
            if not raw.strip() or raw.lstrip().startswith('#'):
                continue
            tokens: list[str] = []
            display = ''
            for part in raw.split():
                if part.startswith('@'):
                    display = part[1:]
                    break
                if part.startswith(':'):
                    break
                tokens.append(part)
            entries.append({'tokens': tokens, 'display': display, 'raw': raw})
    return entries


def validate_keywords(keywords_file: str, tokens_path: str) -> list[str]:
    """返回关键词文件里**不在** `tokens.txt` 的 token（去重、按出现顺序）。"""
    known = load_tokens(tokens_path)
    missing: list[str] = []
    for entry in parse_keywords_file(keywords_file):
        for token in entry['tokens']:
            if token not in known and token not in missing:
                missing.append(token)
    return missing


def keywords_display_names(keywords_file: str) -> list[str]:
    """关键词的显示名（`@` 之后那一段），用来打印"请喊 xxx"，避免把唤醒词写进代码。"""
    return [entry['display'] for entry in parse_keywords_file(keywords_file) if entry['display']]


# 唤醒词的构造参数默认值。`num_threads` **必须留在 1**，不要"顺手改成 2/4"。
#
# 实测（2026-11-24，本机 i5-14600KF，3.93 s 合成语音按 64 ms 实时节奏喂，CPU 时间 / 墙钟）：
#   num_threads=1 -> 0.02 cores | num_threads=2 -> 2.42 cores | num_threads=4 -> 6.01 cores
# 原因不是"解码慢"——单线程解 3.93 s 音频只要 0.09 s CPU（约 40 倍实时），而是 sherpa-onnx
# 底下的 onnxruntime 线程池在两次 decode 之间自旋等活；线程越多，空闲时越费 CPU。
# 本助手是常驻聆听的，还要和同一台机器上的 1.7B 推理抢核，所以空转的核一个都不该给。
DEFAULT_NUM_THREADS = 1


class WakeSpotter:
    """常驻唤醒词检测器。

    sherpa-onnx 2.0.3 **没有** `KeywordSpotter.from_transducer()`（那是老教程的写法），
    只能用下面的构造器，见任务书 §4.2。
    """

    def __init__(
        self,
        model_dir: str,
        keywords_file: str,
        *,
        num_threads: int = DEFAULT_NUM_THREADS,
        keywords_score: float = 1.0,
        keywords_threshold: float = 0.25,
        num_trailing_blanks: int = 1,
    ) -> None:
        self.model_dir = os.path.abspath(model_dir)
        self.keywords_file = os.path.abspath(keywords_file)
        tokens_path = os.path.join(self.model_dir, TOKENS_FILE)
        encoder = os.path.join(self.model_dir, ENCODER_FILE)
        decoder = os.path.join(self.model_dir, DECODER_FILE)
        joiner = os.path.join(self.model_dir, JOINER_FILE)
        for path in (tokens_path, encoder, decoder, joiner):
            _require_file(path)

        missing = validate_keywords(self.keywords_file, tokens_path)
        if missing:
            raise ValueError(
                f'关键词文件的 token 不在 {tokens_path}：{", ".join(missing)}'
                f'（关键词文件 {self.keywords_file}；请改关键词文本，不要改模型）'
            )

        self.params = {
            'num_threads': num_threads,
            'keywords_score': keywords_score,
            'keywords_threshold': keywords_threshold,
            'num_trailing_blanks': num_trailing_blanks,
        }
        try:
            self._spotter = sherpa_onnx.KeywordSpotter(
                tokens=tokens_path,
                encoder=encoder,
                decoder=decoder,
                joiner=joiner,
                keywords_file=self.keywords_file,
                num_threads=num_threads,
                sample_rate=SAMPLE_RATE,
                feature_dim=80,
                max_active_paths=4,
                keywords_score=keywords_score,
                keywords_threshold=keywords_threshold,
                num_trailing_blanks=num_trailing_blanks,
                provider='cpu',
                device=0,
            )
        except Exception as exc:  # noqa: BLE001 - 统一成带路径的 RuntimeError（设计文档 §3.9）
            raise RuntimeError(f'唤醒词模型加载失败（{self.model_dir}）：{exc}') from exc
        self._stream = self._spotter.create_stream()

    def matches(self, frame: 'np.ndarray') -> bool:
        """喂一块 16 kHz float32 音频（任意长度，内部按 `CHUNK` 切片）；命中返回 True 并自复位。"""
        if self._spotter is None:
            raise RuntimeError('WakeSpotter 已 close()，不能继续喂音频')
        samples = np.ascontiguousarray(np.asarray(frame, dtype=np.float32).reshape(-1))
        if samples.size == 0:
            return False
        for start in range(0, samples.size, CHUNK):
            self._stream.accept_waveform(SAMPLE_RATE, samples[start:start + CHUNK])
            while self._spotter.is_ready(self._stream):
                self._spotter.decode_stream(self._stream)
                if self._spotter.get_result(self._stream):
                    self._spotter.reset_stream(self._stream)
                    return True
        return False

    def reset(self) -> None:
        if self._spotter is not None:
            self._spotter.reset_stream(self._stream)

    def close(self) -> None:
        self._stream = None
        self._spotter = None


def make_beep(freq: float = BEEP_FREQ_HZ, ms: int = BEEP_MS, rate: int = SAMPLE_RATE) -> 'np.ndarray':
    """应答音：`freq` Hz 正弦，`ms` 毫秒，首尾各 `BEEP_FADE_MS` 线性淡入淡出（防爆音）。"""
    total = int(round(ms / 1000.0 * rate))
    if total <= 0:
        raise ValueError(f'ms 太小，算不出样本数：ms={ms}, rate={rate}')
    timeline = np.arange(total, dtype=np.float32) / np.float32(rate)
    wave = np.sin(np.float32(2.0 * np.pi * freq) * timeline).astype(np.float32) * BEEP_AMPLITUDE

    fade = min(int(round(BEEP_FADE_MS / 1000.0 * rate)), total // 2)
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade, endpoint=False, dtype=np.float32)
        wave[:fade] *= ramp
        wave[-fade:] *= ramp[::-1]
    return np.ascontiguousarray(wave, dtype=np.float32)
