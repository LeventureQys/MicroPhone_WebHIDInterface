"""SenseVoice ASR 常驻解码（Stage 2 / SubStage 2.2）。

契约来源：`Document/Update/Alpha/v1.3.0/开发文档/SubStage_2.2.md` §4.1（构造器与 API）、
§5（行为与错误处理）、§7.1（自检口径）。

三条硬约束（都由实测得出，不要"顺手优化"）：

1. 模型常驻：`AsrEngine` 构造一次，之后每次 `transcribe` 只做解码。本机 3.93 s 音频解码
   约 85 ms，而加载模型约 800 ms——每轮重载会直接吃掉延迟预算（调研报告 §2.3）。
2. wav 由标准库 `wave` + `io.BytesIO` 自解：sherpa-onnx 2.0.3 **没有** `sherpa_onnx.read_wave`
   （实测 `hasattr(sherpa_onnx, "read_wave") is False`）；也不依赖 SubStage 1.2 的 `audio_io`，
   两者并行开发，本模块必须能单独跑。
3. 非法输入要能被调用方区分：非法 wav / 非 16 kHz 一律抛 `ValueError`，**不静默返回空串**——
   否则"没声"和"格式错"在日志里长得一模一样。只有"合法但没内容"（全零、短于 100 ms）才返回 `''`。
"""

from __future__ import annotations

import argparse
import io
import json
import struct
import sys
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import sherpa_onnx

try:  # 被 `tools.voice.asr` 导入时（4.3 / 单测）
    from tools.voice.normalize import normalize
except ModuleNotFoundError:  # 直接 `python tools/voice/asr.py` 时 sys.path[0] 是 tools/voice
    from normalize import normalize

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[1]

SAMPLE_RATE = 16000
MODEL_FILE = "model.int8.onnx"
TOKENS_FILE = "tokens.txt"
DEFAULT_MODEL_DIR = _HERE / "models" / "sense-voice"
SELFTEST_ARTIFACT = _REPO_ROOT / "artifacts" / "voice" / "selftest-22.json"
DEFAULT_PROBE_WAV = _REPO_ROOT / "artifacts" / "voice" / "wav" / "xt-01.wav"

# 短于此长度直接返回空串（任务书 §5）；16 kHz 下 100 ms = 1600 采样。
MIN_SAMPLES = SAMPLE_RATE // 10

# 8 bit wav 是无符号（中点 128），16/32 bit 是有符号；除数是满量程而不是最大值。
_WIDTHS: dict[int, tuple[Any, float]] = {
    1: (np.uint8, 128.0),
    2: (np.int16, 32768.0),
    4: (np.int32, 2147483648.0),
}


def decode_wav(wav_bytes: bytes) -> np.ndarray:
    """wav 字节 -> float32 单声道波形（[-1, 1]）。

    - 不是合法 wav：`ValueError("不是有效的 wav 数据")`
    - 采样率不是 16 kHz：`ValueError`，消息里带实际采样率
    - 多声道：按帧取平均降成单声道（调用方给的是"一段音频"，不是"某个声道"）
    """
    if isinstance(wav_bytes, str):
        raise TypeError("wav_bytes 必须是 bytes，不能是 str")
    try:
        payload = bytes(wav_bytes)
    except TypeError as exc:
        raise ValueError("不是有效的 wav 数据") from exc

    try:
        with wave.open(io.BytesIO(payload), "rb") as reader:
            channels = reader.getnchannels()
            width = reader.getsampwidth()
            rate = reader.getframerate()
            frames = reader.readframes(reader.getnframes())
    except (wave.Error, EOFError, struct.error) as exc:
        raise ValueError("不是有效的 wav 数据") from exc

    if rate != SAMPLE_RATE:
        raise ValueError(f"采样率必须是 {SAMPLE_RATE} Hz，实际 {rate} Hz")
    if channels <= 0:
        raise ValueError("不是有效的 wav 数据")
    if width not in _WIDTHS:
        raise ValueError(f"不支持的采样位宽：{width * 8} bit（只接受 8/16/32 bit PCM）")

    dtype, divisor = _WIDTHS[width]
    frame_bytes = width * channels
    usable = len(frames) - (len(frames) % frame_bytes) if frame_bytes else 0
    samples = np.frombuffer(frames[:usable], dtype=dtype).astype(np.float32)
    if width == 1:
        samples = (samples - divisor) / divisor
    else:
        samples = samples / divisor
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples


class AsrEngine:
    """SenseVoice int8 常驻解码器：构造一次，多次 `transcribe`。"""

    def __init__(
        self,
        model_dir: str | Path = DEFAULT_MODEL_DIR,
        *,
        num_threads: int = 4,
        use_itn: bool = True,
        language: str = "zh",
    ) -> None:
        directory = Path(model_dir).expanduser().resolve()
        model = directory / MODEL_FILE
        tokens = directory / TOKENS_FILE
        for path in (model, tokens):
            if not path.is_file():
                # 绝对路径：日志里要能直接看出是哪个文件缺了。
                raise FileNotFoundError(f"ASR 模型文件缺失：{path}")

        self.model_dir = directory
        self.num_threads = int(num_threads)
        self.use_itn = bool(use_itn)
        self.language = str(language)
        self._recognizer: Any = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model),
            tokens=str(tokens),
            num_threads=self.num_threads,
            use_itn=self.use_itn,
            language=self.language,
            debug=False,
        )

    def transcribe(self, wav_bytes: bytes) -> str:
        """完整 wav 字节（16 kHz / 16 bit / 单声道，带 RIFF 头）-> 识别文本。"""
        recognizer = self._ensure_open()
        return self._decode(recognizer, decode_wav(wav_bytes))

    def transcribe_samples(self, samples: np.ndarray, rate: int = SAMPLE_RATE) -> str:
        """float32 波形（[-1, 1]）-> 识别文本；整数 dtype 会按满量程换算。"""
        recognizer = self._ensure_open()
        if int(rate) != SAMPLE_RATE:
            raise ValueError(f"采样率必须是 {SAMPLE_RATE} Hz，实际 {int(rate)} Hz")
        return self._decode(recognizer, _as_float32(samples))

    def close(self) -> None:
        """释放识别器；重复调用无害。"""
        self._recognizer = None

    def _ensure_open(self) -> Any:
        if self._recognizer is None:
            raise RuntimeError("AsrEngine 已关闭，请重新构造")
        return self._recognizer

    @staticmethod
    def _decode(recognizer: Any, waveform: np.ndarray) -> str:
        if waveform.size < MIN_SAMPLES or not np.any(waveform):
            return ""
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, waveform)
        recognizer.decode_stream(stream)
        return str(stream.result.text).strip()


# 设计文档 §4.2 的契约表写的是 `asr.py:transcribe(wav_bytes) -> str`，4.3 / 5.1 会
# `from tools.voice.asr import transcribe`；类方法 `AsrEngine.transcribe` 保留（4.3 的
# `ctx.asr.transcribe(audio)` 用的就是它）。两条入口共用同一个常驻识别器：
# 每轮重新构造会白付约 0.8–1.8 s 的模型加载（调研报告 §2.3）。
_DEFAULT_ENGINE: AsrEngine | None = None


def default_engine() -> AsrEngine:
    """进程内唯一的默认引擎（首次调用时加载模型，之后复用）。"""
    global _DEFAULT_ENGINE
    if _DEFAULT_ENGINE is None:
        _DEFAULT_ENGINE = AsrEngine(DEFAULT_MODEL_DIR)
    return _DEFAULT_ENGINE


def transcribe(wav_bytes: bytes) -> str:
    """模块级便捷入口：`transcribe(wav) == default_engine().transcribe(wav)`。"""
    return default_engine().transcribe(wav_bytes)


def close_default_engine() -> None:
    """释放默认引擎（下次调用 `transcribe` 会重新加载模型）；重复调用无害。"""
    global _DEFAULT_ENGINE
    if _DEFAULT_ENGINE is not None:
        _DEFAULT_ENGINE.close()
        _DEFAULT_ENGINE = None


def _as_float32(samples: Any) -> np.ndarray:
    array = np.asarray(samples)
    if array.ndim != 1:
        raise ValueError(f"samples 必须是一维（单声道），实际形状 {array.shape}")
    if array.dtype == np.uint8:
        return (array.astype(np.float32) - 128.0) / 128.0
    if array.dtype == np.int16:
        return array.astype(np.float32) / 32768.0
    if array.dtype == np.int32:
        return array.astype(np.float32) / 2147483648.0
    return array.astype(np.float32)


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _display_path(path: Path) -> str:
    """仓库内的路径写相对路径（跨机器可读），仓库外保留绝对路径。"""
    resolved = Path(path).resolve()
    try:
        return resolved.relative_to(_REPO_ROOT).as_posix()
    except ValueError:
        return str(resolved)


def _read_wav_info(path: Path) -> tuple[float, int]:
    with wave.open(str(path), "rb") as reader:
        rate = reader.getframerate()
        count = reader.getnframes()
    return (count / rate if rate else 0.0), count


def _run_selftest(args: argparse.Namespace) -> int:
    wav_paths = [Path(item) for item in (args.wav or [str(DEFAULT_PROBE_WAV)])]
    for path in wav_paths:
        if not path.is_file():
            print(f"找不到 wav 文件：{path}", file=sys.stderr)
            return 2

    expect = list(args.expect or [])
    print("ASR 自检（SenseVoice int8）")
    print(f"  模型目录     : {_display_path(Path(args.model_dir))}")
    print(f"  线程/ITN/语言: {args.num_threads} / {not args.no_itn} / {args.language}")

    started = time.perf_counter()
    try:
        engine = AsrEngine(
            args.model_dir,
            num_threads=args.num_threads,
            use_itn=not args.no_itn,
            language=args.language,
        )
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 4
    load_ms = (time.perf_counter() - started) * 1000.0
    print(f"  模型加载     : {load_ms:.1f} ms")

    repeat = max(1, int(args.repeat))
    runs: list[dict[str, Any]] = []
    for path in wav_paths:
        duration_s, sample_count = _read_wav_info(path)
        wav_bytes = path.read_bytes()
        entry: dict[str, Any] = {
            "wav": _display_path(path),
            "bytes": len(wav_bytes),
            "duration_s": round(duration_s, 3),
            "sample_count": sample_count,
        }
        try:
            timings: list[float] = []
            text = ""
            for _ in range(repeat):
                tick = time.perf_counter()
                text = engine.transcribe(wav_bytes)
                timings.append((time.perf_counter() - tick) * 1000.0)
        except ValueError as exc:
            entry["error"] = str(exc)
            entry["ok"] = False
            runs.append(entry)
            print(f"[wav] {entry['wav']}")
            print(f"  解码失败     : {exc}")
            continue

        ordered = sorted(timings)
        hits = {needle: needle in text for needle in expect}
        norm_text = normalize(text)
        entry.update(
            {
                "asr_ms": round(ordered[0], 1),
                "asr_ms_all": [round(item, 1) for item in timings],
                "asr_ms_min": round(ordered[0], 1),
                "asr_ms_median": round(ordered[len(ordered) // 2], 1),
                "text": text,
                "norm_text": norm_text,
                "expect_hits": hits,
                "ok": all(hits.values()),
            }
        )
        runs.append(entry)

        print(f"[wav] {entry['wav']}")
        print(f"  时长/采样    : {duration_s:.3f} s / {sample_count} 采样 @ 16 kHz")
        print(f"  原始文本     : {text}")
        print(f"  规范化文本   : {norm_text}")
        print(
            "  解码耗时     : "
            + " / ".join(f"{item:.1f}" for item in timings)
            + f" ms（最好 {ordered[0]:.1f} ms，中位 {ordered[len(ordered) // 2]:.1f} ms）"
        )
        if hits:
            rendered = "  ".join(f"{needle}={'命中' if found else '未命中'}" for needle, found in hits.items())
            print(f"  期望子串     : {rendered}")
    engine.close()

    ok = bool(runs) and all(item.get("ok") for item in runs)
    report = {
        "v": 1,
        "ts": _now_iso(),
        "python": sys.version.split()[0],
        "sherpa_onnx": getattr(sherpa_onnx, "__version__", "unknown"),
        "numpy": np.__version__,
        "model_dir": _display_path(Path(args.model_dir)),
        "num_threads": engine.num_threads,
        "use_itn": engine.use_itn,
        "language": engine.language,
        "model_load_ms": round(load_ms, 1),
        "repeat": repeat,
        "expect": expect,
        "runs": runs,
        "ok": ok,
    }
    artifact = Path(args.json) if args.json else SELFTEST_ARTIFACT
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"JSON: {_display_path(artifact)}")
    print(f"结论: {'通过' if ok else '未通过'}")
    return 0 if ok else 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="asr.py",
        description="SenseVoice 常驻 ASR（SubStage 2.2）；--selftest 真跑一条 wav 并写取证 JSON。",
    )
    parser.add_argument("--selftest", action="store_true", help="跑自检并写 artifacts/voice/selftest-22.json")
    parser.add_argument("--wav", action="append", metavar="PATH", help="待解码的 wav（可重复）；默认 xt-01.wav")
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR), help="sense-voice 模型目录")
    parser.add_argument("--num-threads", type=int, default=4, help="解码线程数（默认 4）")
    parser.add_argument("--no-itn", action="store_true", help="关闭逆文本正则化（默认开）")
    parser.add_argument("--language", default="zh", help="语言提示（默认 zh）")
    parser.add_argument("--repeat", type=int, default=3, help="每条 wav 重复解码次数（默认 3，用于取稳定耗时）")
    parser.add_argument("--expect", action="append", metavar="SUBSTR", help="期望出现在原始文本里的子串（可重复）")
    parser.add_argument("--json", default=None, help="取证 JSON 路径（默认 artifacts/voice/selftest-22.json）")
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            # 控制台默认代码页是 GBK，中文文本会变成乱码（调研报告 §2.3 的取证踩过）。
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.selftest:
        parser.print_help(sys.stderr)
        return 2
    return _run_selftest(args)


if __name__ == "__main__":
    raise SystemExit(main())
