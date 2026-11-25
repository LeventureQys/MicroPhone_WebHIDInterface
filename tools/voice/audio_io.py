"""SubStage 1.2 — 16 kHz 单声道采集与 wav I/O（`tools/voice/audio_io.py`）。

契约（`Document/Update/Alpha/v1.3.0/开发文档/SubStage_1.2.md` §4.1 / §5，设计文档 §3.9 / §3.9.1）：

- `SAMPLE_RATE` 恒 16000：**wav 文件不做重采样**（不是 16 kHz 就报错，换采样率是调用方的责任）；
  采集流只在端点拒绝 16 kHz 时按设计文档 §3.9.1 降级到**原生采样率 + 内部重采样**，
  对上层仍然是"永远 16 kHz"（`AudioStream.rate` 恒 16000，另报 `source_rate` / `resampled`）；
- `open_stream()` 打不开时抛 `AudioUnavailable(kind)`：不返回 None、不静默换**设备**
  （静默换设备会让"用户对着错误的麦克风说话"永远查不出来）；§3.9.1 只允许换**采样率**；
- `read()` 只返回真实拿到的样本数，不补零——补零会让 VAD 把静音误判成语音；
- 采集流被外力停掉（驱动重载、拔麦）时 `alive()` 转 False、`read()` 抛
  `AudioUnavailable('busy')`，绝不返回全零数组。

自检（真跑需要麦克风；枚举是只读的，没麦克风也能跑）：

    python tools/voice/audio_io.py --list
    python tools/voice/audio_io.py --selftest

`--selftest` 采 1 s 默认输入并写 `artifacts/voice/selftest-12.json`。该文件由本模块与
`vad.py --selftest` 共同维护：各自只覆盖自己负责的键（本模块：`devices` / `deviceList` /
`capture`；`vad.py`：`segments` / `vad_ms` / `wav` / `checks`），后跑的不会抹掉先跑的。

三个实现取舍（任务书未写死，按最小惊讶原则定）：

1. `read()` 是**有界阻塞**：等到 `frames` 个样本、或流死掉、或超时（默认 3 倍标称时长 + 0.5 s），
   超时就把已缓冲的样本原样交出去（可能短于 `frames`）。这样调用方 write→read 循环不会挂死，
   也不会收到补零的假数据。
2. `alive()` 除了看 `active` 标志，还看最后一次回调距今是否超过 `stall_s`（默认 2 s）——
   Windows 上设备被外力摘掉时 PortAudio 不一定立刻把 `active` 改成 False，只有回调停了才是
   可观测的事实（渲染进程的 `audio-meter.ts` 踩过同一类坑）。
3. 重采样只做**线性插值**且只在回调线程里做：§3.9.1 明确 KWS/ASR 不需要高保真，加抗混叠
   低通会引入额外延迟与依赖。代价是原生采样率高于 32 kHz 时 8 kHz 以上的成分会折叠回来
   （48k→16k 不做低通），对唤醒/转写够用，对评测用的"听感"不够——评测走 wav，不走这里。
"""

from __future__ import annotations

import json
import re
import sys
import threading
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 16000

TARGET_KIND_DENIED = "denied"
TARGET_KIND_UNAVAILABLE = "unavailable"
TARGET_KIND_BUSY = "busy"
TARGET_KINDS = (TARGET_KIND_DENIED, TARGET_KIND_UNAVAILABLE, TARGET_KIND_BUSY)

SELFTEST_ARTIFACT = "artifacts/voice/selftest-12.json"

_REPO_ROOT = Path(__file__).resolve().parents[2]
_RING_SECONDS = 5.0
_STALL_S = 2.0
_PA_CODE_RE = re.compile(r"\[PaErrorCode\s+(-?\d+)\]")

# 分类顺序 = 权限 → PortAudio 错误码 → 占用 → 设备不可用 → 兜底 unavailable。
# 权限关键字必须排最前：Windows WASAPI 把"没有麦克风权限"也报成
# `Unanticipated host error`（-9999），光看错误码会错判成"设备不存在"。
_DENIED_HINTS = (
    "permission",
    "denied",
    "not permitted",
    "not allowed",
    "access is denied",
    "0x80070005",
    "拒绝访问",
    "无权限",
)
_BUSY_HINTS = (
    "device unavailable",
    "device is unavailable",
    "devices unavailable",
    "busy",
    "in use",
    "exclusively",
    "占用",
    "正在使用",
)
_UNAVAILABLE_HINTS = (
    "invalid device",
    "invalid number of channels",
    "invalid sample rate",
    "unanticipated host error",
    "no default input",
    "no devices",
    "error querying device",
    "device not found",
    "host api not found",
    "insufficient memory",
    "internal error",
)
_PA_CODE_KINDS = {
    -9999: TARGET_KIND_UNAVAILABLE,  # paUnanticipatedHostError
    -9998: TARGET_KIND_UNAVAILABLE,  # paInvalidChannelCount
    -9997: TARGET_KIND_UNAVAILABLE,  # paInvalidSampleRate
    -9996: TARGET_KIND_UNAVAILABLE,  # paInvalidDevice
    -9994: TARGET_KIND_UNAVAILABLE,  # paSampleFormatNotSupported
    -9993: TARGET_KIND_UNAVAILABLE,  # paBadIODeviceCombination
    -9992: TARGET_KIND_UNAVAILABLE,  # paInsufficientMemory
    -9986: TARGET_KIND_UNAVAILABLE,  # paInternalError
    -9985: TARGET_KIND_BUSY,  # paDeviceUnavailable
    -9983: TARGET_KIND_BUSY,  # paStreamIsStopped
    -9982: TARGET_KIND_BUSY,  # paStreamIsNotStopped
    -9979: TARGET_KIND_UNAVAILABLE,  # paHostApiNotFound
    -9978: TARGET_KIND_UNAVAILABLE,  # paInvalidHostApi
}


class AudioUnavailable(RuntimeError):
    """打不开或读不到音频设备。`kind` ∈ {denied, unavailable, busy}。"""

    def __init__(self, kind: str, detail: str) -> None:
        if kind not in TARGET_KINDS:
            raise ValueError(f"kind 必须是 {TARGET_KINDS} 之一，实际 {kind!r}")
        super().__init__(f"{kind}: {detail}")
        self.kind = kind
        self.detail = detail

    def __str__(self) -> str:
        return f"{self.kind}: {self.detail}"


def _classify_portaudio_error(exc: BaseException, *, context: str = "") -> tuple[str, str]:
    """把 `sounddevice.PortAudioError` 归类成 `AudioUnavailable(kind, detail)` 的两个入参。"""

    text = str(exc).strip() or exc.__class__.__name__
    detail = f"{text}（{context}）" if context else text
    low = text.lower()
    for hint in _DENIED_HINTS:
        if hint in low:
            return TARGET_KIND_DENIED, detail
    match = _PA_CODE_RE.search(text)
    if match is not None:
        kind = _PA_CODE_KINDS.get(int(match.group(1)))
        if kind is not None:
            return kind, detail
    for hint in _BUSY_HINTS:
        if hint in low:
            return TARGET_KIND_BUSY, detail
    for hint in _UNAVAILABLE_HINTS:
        if hint in low:
            return TARGET_KIND_UNAVAILABLE, detail
    return TARGET_KIND_UNAVAILABLE, detail


def list_devices() -> list[dict]:
    """列出全部输入设备：`[{"index", "name", "channels", "default"}]`，按 PortAudio 索引升序。"""

    try:
        devices = sd.query_devices()
        default_device = sd.default.device
        default_index = int(default_device[0])
    except sd.PortAudioError as exc:
        raise AudioUnavailable(*_classify_portaudio_error(exc, context="枚举输入设备")) from exc
    out: list[dict] = []
    for index, info in enumerate(devices):
        channels = int(info.get("max_input_channels", 0))
        if channels <= 0:
            continue
        out.append(
            {
                "index": index,
                "name": str(info.get("name", "")),
                "channels": channels,
                "default": index == default_index,
            }
        )
    return out


def _resolve_device(device: str | int | None, devices: list[dict]) -> tuple[int, str]:
    """把 `open_stream()` 的 device 参数解析成 (索引, 名称)。纯函数，便于单测。"""

    if device is None:
        for entry in devices:
            if entry["default"]:
                return int(entry["index"]), str(entry["name"])
        raise AudioUnavailable(
            TARGET_KIND_UNAVAILABLE,
            f"系统没有默认输入设备（枚举到 {len(devices)} 个输入设备）",
        )
    if isinstance(device, bool):
        raise TypeError(f"device 只接受 None / int / str，实际 {type(device).__name__}")
    if isinstance(device, int):
        for entry in devices:
            if int(entry["index"]) == device:
                return int(entry["index"]), str(entry["name"])
        raise AudioUnavailable(
            TARGET_KIND_UNAVAILABLE,
            f"没有索引为 {device} 的输入设备（枚举到 {len(devices)} 个，索引见 --list）",
        )
    if isinstance(device, str):
        needle = device.strip().lower()
        if not needle:
            raise ValueError("device 名称不能是空字符串（要默认设备就传 None）")
        # 同一支麦在不同 host API 下会重复出现（MME / DirectSound / WASAPI / WDM-KS），
        # 按索引升序取首个命中：这与 `--list` 的顺序一致，调用方能自己挑索引。
        for entry in devices:
            if needle in str(entry["name"]).lower():
                return int(entry["index"]), str(entry["name"])
        raise AudioUnavailable(
            TARGET_KIND_UNAVAILABLE,
            f"没有名称包含 {device!r} 的输入设备（枚举到 {len(devices)} 个）",
        )
    raise TypeError(f"device 只接受 None / int / str，实际 {type(device).__name__}")


class _LinearResampler:
    """线性插值重采样，只用在原生采样率兜底上（设计文档 §3.9.1）。

    跨块保持插值相位：内部只留"下一个输出样本位置之前的那一个输入样本"，因此分块喂和
    一次喂完的输出逐样本一致（没有块边界毛刺）。线性插值对 48k→16k 恰好落在整数步长上
    （纯抽取），对 44.1k 是可接受的近似；不做抗混叠低通是 §3.9.1 的明确取舍。
    """

    def __init__(self, source_rate: int, target_rate: int = SAMPLE_RATE) -> None:
        if source_rate <= 0 or target_rate <= 0:
            raise ValueError(f"采样率必须为正，实际 source={source_rate} target={target_rate}")
        self.source_rate = int(source_rate)
        self.target_rate = int(target_rate)
        self.step = self.source_rate / float(self.target_rate)
        self._buf = np.zeros(0, dtype=np.float32)
        self._pos = 0.0
        self._fed = 0
        self._out = 0

    @property
    def fed_frames(self) -> int:
        return self._fed

    @property
    def produced_frames(self) -> int:
        return self._out

    def push(self, block: Any) -> np.ndarray:
        arr = np.asarray(block, dtype=np.float32).reshape(-1)
        if arr.size:
            self._buf = arr if self._buf.size == 0 else np.concatenate((self._buf, arr))
            self._fed += int(arr.size)
        # 插值要用 buf[lo] 与 buf[lo+1]，故最后一个输出位置必须 ≤ size-2
        room = self._buf.size - 2 - self._pos
        if room < 0.0:
            return np.zeros(0, dtype=np.float32)
        count = int(np.floor(room / self.step)) + 1
        if count <= 0:
            return np.zeros(0, dtype=np.float32)
        positions = self._pos + self.step * np.arange(count, dtype=np.float64)
        low = positions.astype(np.int64)
        frac = (positions - low).astype(np.float32)
        out = self._buf[low] * (1.0 - frac) + self._buf[low + 1] * frac
        self._pos = float(positions[-1] + self.step)
        # 只能丢掉"已经确定不再需要"的样本：next 位置可能落在缓冲之外（还没采到），
        # 这时一个样本都不能丢，否则相位会被悄悄重置（分块大小不同就会得出不同结果）。
        keep = min(int(np.floor(self._pos)), self._buf.size)
        if keep > 0:
            self._buf = self._buf[keep:]
            self._pos -= keep
        self._out += count
        return out.astype(np.float32, copy=False)


class _FrameRing:
    """定长环形缓冲（单写多读，读写都在 `AudioStream` 的 Condition 里加锁）。"""

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError(f"capacity 必须是正整数，实际 {capacity}")
        self._buf = np.zeros(int(capacity), dtype=np.float32)
        self._start = 0
        self._len = 0
        self._total = 0
        self._dropped = 0

    @property
    def capacity(self) -> int:
        return int(self._buf.size)

    def available(self) -> int:
        return self._len

    @property
    def total(self) -> int:
        """累计写入的样本数（含已被丢弃的）。"""

        return self._total

    @property
    def dropped(self) -> int:
        """因缓冲满而丢弃的最旧样本数。"""

        return self._dropped

    def push(self, block: Any) -> None:
        arr = np.asarray(block, dtype=np.float32).reshape(-1)
        size = int(arr.size)
        if size == 0:
            return
        self._total += size
        capacity = self.capacity
        if size >= capacity:
            self._dropped += self._len + size - capacity
            self._buf[:] = arr[size - capacity :]
            self._start = 0
            self._len = capacity
            return
        end = (self._start + self._len) % capacity
        overflow = max(0, self._len + size - capacity)
        if overflow:
            self._start = (self._start + overflow) % capacity
            self._len -= overflow
            self._dropped += overflow
        first = min(size, capacity - end)
        self._buf[end : end + first] = arr[:first]
        if first < size:
            self._buf[: size - first] = arr[first:]
        self._len += size

    def take(self, frames: int) -> np.ndarray:
        wanted = min(int(frames), self._len)
        if wanted <= 0:
            return np.zeros(0, dtype=np.float32)
        capacity = self.capacity
        end = self._start + wanted
        if end <= capacity:
            out = self._buf[self._start : end].copy()
        else:
            out = np.concatenate((self._buf[self._start :], self._buf[: end - capacity]))
        self._start = end % capacity
        self._len -= wanted
        return np.ascontiguousarray(out, dtype=np.float32)


class AudioStream:
    """16 kHz 单声道 float32 采集流（上下文管理器）。

    `open_stream()` 才会连上真设备；本类可以被单测直接构造（`stream` 由 `_attach()` 注入），
    因此 read/alive/close 的行为不依赖麦克风。
    """

    def __init__(
        self,
        *,
        device_index: int = -1,
        device_name: str = "",
        blocksize: int = 0,
        ring_seconds: float = _RING_SECONDS,
        stall_s: float = _STALL_S,
        source_rate: int = SAMPLE_RATE,
        fallback_note: str | None = None,
    ) -> None:
        self._source_rate = int(source_rate)
        if self._source_rate <= 0:
            raise ValueError(f"source_rate 必须为正，实际 {source_rate}")
        # 只有"端点拒绝 16 kHz"这条路才会带重采样器进来（设计文档 §3.9.1）
        self._resampler = (
            None if self._source_rate == SAMPLE_RATE else _LinearResampler(self._source_rate)
        )
        self._fallback_note = fallback_note
        self.device_index = int(device_index)
        self.device_name = str(device_name)
        self.blocksize = int(blocksize)
        self._ring = _FrameRing(int(SAMPLE_RATE * float(ring_seconds)))
        self._cond = threading.Condition()
        self._stream: Any | None = None
        self._closed = False
        self._fatal: str | None = None
        self._opened_at = time.monotonic()
        self._last_rx = self._opened_at
        self._stall_s = float(stall_s)
        self._overflow = 0

    # --- 生命周期 -----------------------------------------------------------

    @property
    def rate(self) -> int:
        """对上层承诺的采样率，恒 16000（重采样在内部完成）。"""

        return SAMPLE_RATE

    @property
    def source_rate(self) -> int:
        """实际从设备采到的采样率；等于 16000 表示没有重采样。"""

        return self._source_rate

    @property
    def resampled(self) -> bool:
        """是否走了 §3.9.1 的原生采样率兜底（内部重采样到 16 kHz）。"""

        return self._resampler is not None

    @property
    def fallback_note(self) -> str | None:
        """走了兜底时的日志行原文，供自检与侧车日志复用。"""

        return self._fallback_note

    def _attach(self, stream: Any) -> None:
        """接上底层 PortAudio 流（测试里用假对象）。"""

        self._stream = stream
        self._opened_at = time.monotonic()
        self._last_rx = self._opened_at

    def _ingest(self, block: Any, status: Any = None) -> None:
        """PortAudio 回调线程调用：把一块样本塞进环形缓冲。这里绝不允许抛回 PortAudio。"""

        try:
            if status is not None and getattr(status, "input_overflow", False):
                self._overflow += 1
            arr = np.asarray(block, dtype=np.float32)
            if arr.ndim > 1:
                arr = arr[:, 0]
            if self._resampler is not None:
                arr = self._resampler.push(arr)
            now = time.monotonic()
            with self._cond:
                if self._closed:
                    return
                self._last_rx = now
                if arr.size:
                    self._ring.push(arr)
                    self._cond.notify_all()
        except Exception as exc:  # noqa: BLE001 - 回调线程里抛异常会被 PortAudio 吞掉并中断流
            with self._cond:
                self._fatal = f"{type(exc).__name__}: {exc}"

    def _active(self) -> bool:
        stream = self._stream
        if stream is None:
            return False
        try:
            return bool(getattr(stream, "active", True))
        except Exception:  # noqa: BLE001 - 底层对象被外力拆掉时属性访问也可能抛
            return False

    def _stalled(self) -> bool:
        return (time.monotonic() - self._last_rx) > self._stall_s

    def _dead(self) -> bool:
        return self._closed or self._fatal is not None or not self._active() or self._stalled()

    def alive(self) -> bool:
        """底层流未停止、未报错、且回调还在推进。"""

        return not self._dead()

    def close(self) -> None:
        """停止并关闭底层流；幂等。"""

        with self._cond:
            if self._closed:
                return
            self._closed = True
            self._cond.notify_all()
        stream = self._stream
        if stream is None:
            return
        try:
            stream.stop()
        except Exception:  # noqa: BLE001 - 关闭路径不容许抛，设备可能已经没了
            pass
        try:
            stream.close()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self) -> "AudioStream":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    # --- 数据 -----------------------------------------------------------------

    @property
    def overflow_count(self) -> int:
        """PortAudio 报的输入溢出次数（数据仍连续可用，只是中间少了些帧）。"""

        return self._overflow

    @property
    def dropped_frames(self) -> int:
        """因调用方读得太慢而丢掉的最旧样本数。"""

        return self._ring.dropped

    def _dead_detail(self) -> str:
        who = f"device={self.device_name!r} index={self.device_index}"
        if self._closed:
            return f"采集流已关闭（{who}）"
        if self._fatal is not None:
            return f"采集回调异常：{self._fatal}（{who}）"
        if not self._active():
            return f"采集流已被外力停止（{who}）"
        return f"采集回调 {self._stall_s:.1f} s 没有新数据（{who}）"

    def read(self, frames: int = 512, timeout_s: float | None = None) -> np.ndarray:
        """读最多 `frames` 个样本，返回真实长度（可能更短，绝不补零）。"""

        frames = int(frames)
        if frames <= 0:
            raise ValueError(f"frames 必须是正整数，实际 {frames}")
        if timeout_s is None:
            timeout_s = frames / float(self.rate) * 3.0 + 0.5
        deadline = time.monotonic() + max(0.0, float(timeout_s))
        with self._cond:
            while True:
                if self._ring.available() >= frames:
                    return self._ring.take(frames)
                if self._dead():
                    pending = self._ring.take(frames)
                    if pending.size:
                        return pending
                    raise AudioUnavailable(TARGET_KIND_BUSY, self._dead_detail())
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self._ring.take(frames)
                self._cond.wait(min(remaining, 0.05))


def _is_sample_rate_fallback(error: "AudioUnavailable | None") -> bool:
    """这次打开失败该不该走 §3.9.1 的原生采样率兜底。

    条件严格照设计文档：`kind == 'unavailable'` **且** 错误里确实是采样率被拒
    （PortAudio `-9997` / `Invalid sample rate`）。设备不存在、被占用、权限被拒都不兜底。
    """

    if error is None or error.kind != TARGET_KIND_UNAVAILABLE:
        return False
    low = error.detail.lower()
    return ("invalid sample rate" in low) or ("-9997" in low)


def _native_sample_rate(index: int) -> int:
    """设备声明的原生采样率（`default_samplerate`），取不到时返回 0。"""

    try:
        info = sd.query_devices(index)
        rate = float(info.get("default_samplerate", 0) or 0)
    except Exception:  # noqa: BLE001 - 设备刚好消失时不要在这里炸
        return 0
    return int(round(rate)) if rate > 0 else 0


def _khz_label(rate: int) -> str:
    text = f"{float(rate) / 1000.0:.1f}".rstrip("0").rstrip(".")
    return f"{text} kHz"


def _fallback_note(error: "AudioUnavailable", native_rate: int) -> str:
    """设计文档 §3.9.1 第 4 条要求的那行日志。"""

    match = _PA_CODE_RE.search(error.detail)
    reason = match.group(1) if match is not None else error.detail
    return f"[audio] 16 kHz 被拒（{reason}），改用 {_khz_label(native_rate)} 采集 + 重采样"


def _try_open(
    index: int, name: str, rate: int, callback: Any
) -> tuple[Any | None, "AudioUnavailable | None"]:
    """按指定采样率打开并启动输入流。失败只回传 `AudioUnavailable`，不抛。"""

    stream: Any | None = None
    try:
        stream = sd.InputStream(
            device=index,
            samplerate=int(rate),
            channels=1,
            dtype="float32",
            blocksize=0,
            callback=callback,
        )
        stream.start()
        return stream, None
    except sd.PortAudioError as exc:
        if stream is not None:
            try:
                stream.close()
            except Exception:  # noqa: BLE001 - 半开的流可能连 close 都抛
                pass
        kind, detail = _classify_portaudio_error(
            exc, context=f"打开输入设备 {name!r} (index {index}, {rate} Hz)"
        )
        return None, AudioUnavailable(kind, detail)


def open_stream(device: str | int | None = None) -> AudioStream:
    """打开 16 kHz 单声道输入流。

    `device=None` 用系统默认输入；`int` 是 `--list` 里的索引；`str` 按名称子串匹配
    （大小写不敏感，取索引最小的首个命中）。打不开时抛 `AudioUnavailable`——
    不返回 None，也不静默换设备。

    端点拒绝 16 kHz 时按设计文档 §3.9.1 降级：**同一台设备**改用它的 `default_samplerate`
    打开，内部线性插值重采样到 16 kHz（`AudioStream.resampled` 为 True）。
    """

    devices = list_devices()
    index, name = _resolve_device(device, devices)
    # 回调可能比 AudioStream 更早存在，用持有者中转（建流前就可能有回调）
    holder: dict[str, AudioStream] = {}

    def _callback(indata: Any, frames: int, time_info: Any, status: Any) -> None:
        audio = holder.get("audio")
        if audio is not None:
            audio._ingest(indata, status)

    source_rate = SAMPLE_RATE
    note: str | None = None
    stream, error = _try_open(index, name, SAMPLE_RATE, _callback)
    if stream is None:
        if _is_sample_rate_fallback(error):
            native = _native_sample_rate(index)
            if native and native != SAMPLE_RATE:
                stream, retry_error = _try_open(index, name, native, _callback)
                if stream is not None:
                    source_rate = native
                    note = _fallback_note(error, native)
                else:
                    raise AudioUnavailable(
                        retry_error.kind,
                        f"{retry_error.detail}；原生采样率 {native} Hz 也打不开，"
                        f"该端点不可用（16 kHz 时：{error.detail}）",
                    ) from None
        if stream is None:
            raise error
    audio = AudioStream(
        device_index=index,
        device_name=name,
        source_rate=source_rate,
        fallback_note=note,
    )
    holder["audio"] = audio
    audio._attach(stream)
    if note is not None:
        print(note)
    return audio


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """读 16 kHz / 16 bit / 单声道 wav，返回 (float32 波形, 采样率)。

    其它格式抛 `ValueError`，消息里带实际的 `rate=…, width=…, channels=…`。
    """

    target = Path(path)
    with wave.open(str(target), "rb") as handle:
        rate = int(handle.getframerate())
        width = int(handle.getsampwidth())
        channels = int(handle.getnchannels())
        frames = int(handle.getnframes())
        raw = handle.readframes(frames)
    if (rate, width, channels) != (SAMPLE_RATE, 2, 1):
        raise ValueError(
            f"wav 必须是 {SAMPLE_RATE} Hz / 16 bit / 单声道，"
            f"实际 rate={rate}, width={width}, channels={channels}"
            f"（{rate} Hz / {width * 8} bit / {channels} 声道，{target}）；"
            "换采样率的责任在调用方，本层不做重采样"
        )
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return np.ascontiguousarray(samples, dtype=np.float32), rate


def write_wav(path: str, samples: Any, rate: int = SAMPLE_RATE) -> None:
    """写 16 bit PCM 单声道 wav；`samples` 是 [-1, 1] 的浮点波形，内部 clip 后取整。

    量化尺度用 **32768**（读侧除以 32768），正满幅被夹到 32767：这样往返误差恒 ≤ 1/32768，
    换成 32767 时误差会到 x/32768 + 半个 LSB，任务书 §6.2 的门禁就过不去。
    """

    data = np.asarray(samples, dtype=np.float64).reshape(-1)
    pcm = np.clip(np.rint(np.clip(data, -1.0, 1.0) * 32768.0), -32768.0, 32767.0).astype("<i2")
    target = Path(path)
    if target.parent != Path("") and not target.parent.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(pcm.tobytes())


# --- 自检 ---------------------------------------------------------------------


def _configure_stdout() -> None:
    # 自检输出含中文，Windows 控制台默认按本地代码页解码，统一成 UTF-8 便于取证。
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def _update_artifact(
    updates: dict,
    artifact_path: str | Path | None = SELFTEST_ARTIFACT,
    defaults: dict | None = None,
    append: dict | None = None,
) -> Path | None:
    """把本模块负责的键合并进 `selftest-12.json`（另一个模块负责的键原样保留）。

    `append` 用于保留历史（`captures`）：默认设备与 §3.9.1 兜底两条路径各跑一次，
    产物里能同时看到"这次走的哪条路"和"两条路都真跑过"。
    """

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
    for key, value in (append or {}).items():
        history = payload.get(key)
        if not isinstance(history, list):
            history = []
        payload[key] = (history + [value])[-10:]
    payload["generatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
    payload["python"] = sys.version.split()[0]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def _print_devices(devices: list[dict], limit: int | None = None) -> None:
    default = next((entry["index"] for entry in devices if entry["default"]), None)
    print(f"DEVICES inputs={len(devices)} default={default}")
    rows = devices if limit is None else devices[:limit]
    for entry in rows:
        print(
            "  [{}] {}  channels={} default={}".format(
                entry["index"],
                entry["name"],
                entry["channels"],
                "True" if entry["default"] else "False",
            )
        )
    if limit is not None and len(devices) > limit:
        print(f"  … 另有 {len(devices) - limit} 个输入设备（--list 看全量）")


def _dbfs(value: float) -> float:
    if value <= 0.0:
        return float("-inf")
    return 20.0 * float(np.log10(value))


def run_selftest(
    artifact_path: str | Path | None = SELFTEST_ARTIFACT,
    *,
    capture_s: float = 1.0,
    device: str | int | None = None,
) -> int:
    """枚举 + 用默认输入（或 `device` 指定的输入）采 `capture_s` 秒 + 写自检产物。返回退出码。

    `device` 用来验证设计文档 §3.9.1 的兜底：`--device 21` 这类拒绝 16 kHz 的端点在产物里
    会写 `"resampled": true` 与 `"source_rate": 48000`。
    """

    print("SELFTEST audio_io (SubStage 1.2)")
    try:
        devices = list_devices()
    except AudioUnavailable as exc:
        print(f"ENUM failed: AudioUnavailable(kind={exc.kind}) {exc.detail}")
        artifact = _update_artifact(
            {"devices": 0, "deviceList": [], "capture": {"ok": False, "kind": exc.kind, "detail": exc.detail}},
            artifact_path,
            defaults={"segments": [], "vad_ms": 0},
        )
        print(f"RESULT BLOCKED artifact: {artifact}" if artifact else "RESULT BLOCKED")
        return 3

    _print_devices(devices, limit=5)
    if device is not None:
        print(f"TARGET device={device!r}（自检指定，非系统默认）")
    target_frames = int(round(capture_s * SAMPLE_RATE))
    updates: dict = {
        "devices": len(devices),
        "deviceList": devices,
        "sampleRate": SAMPLE_RATE,
        "captureSeconds": capture_s,
    }
    try:
        started = time.perf_counter()
        with open_stream(device) as audio:
            opened_ms = (time.perf_counter() - started) * 1000.0
            print(
                f"STREAM device={audio.device_index} {audio.device_name!r} "
                f"rate={audio.rate} source_rate={audio.source_rate} "
                f"resampled={audio.resampled} channels=1 opened_ms={opened_ms:.1f}"
            )
            blocks: list[np.ndarray] = []
            got = 0
            deadline = started + max(1.0, capture_s) * 5.0
            while got < target_frames:
                block = audio.read(min(512, target_frames - got))
                if block.size == 0:
                    raise AudioUnavailable(
                        TARGET_KIND_BUSY,
                        f"采 {capture_s:g} s 期间没有收到任何样本（device={audio.device_name!r}）",
                    )
                blocks.append(block)
                got += int(block.size)
                if time.perf_counter() > deadline:
                    raise AudioUnavailable(
                        TARGET_KIND_BUSY,
                        f"采 {capture_s:g} s 超时：只收到 {got} 个样本（device={audio.device_name!r}）",
                    )
            took_ms = (time.perf_counter() - started) * 1000.0
            samples = np.concatenate(blocks)[:target_frames]
            overflow = audio.overflow_count
            dropped = audio.dropped_frames
            alive_after = audio.alive()
    except AudioUnavailable as exc:
        print(f"CAPTURE failed: AudioUnavailable(kind={exc.kind}) {exc.detail}")
        updates["capture"] = {"ok": False, "kind": exc.kind, "detail": exc.detail}
        artifact = _update_artifact(updates, artifact_path, defaults={"segments": [], "vad_ms": 0})
        print(f"RESULT BLOCKED artifact: {artifact}" if artifact else "RESULT BLOCKED")
        return 3

    shape_ok = samples.shape == (target_frames,)
    dtype_ok = samples.dtype == np.float32
    finite_ok = bool(np.all(np.isfinite(samples)))
    path = "resampled" if audio.resampled else "native-16k"
    print(
        f"CAPTURE path={path} source_rate={audio.source_rate} resampled={audio.resampled} "
        f"frames={samples.size} shape={samples.shape} dtype={samples.dtype} "
        f"took_ms={took_ms:.1f} peak_dbfs={_dbfs(float(np.abs(samples).max())):.1f} "
        f"rms_dbfs={_dbfs(float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))):.1f} "
        f"overflow={overflow} dropped={dropped} alive={alive_after}"
    )
    if audio.fallback_note is not None:
        print(f"NOTE {audio.fallback_note}")
    print(f"CHECK frames=={target_frames} {shape_ok} | dtype==float32 {dtype_ok} | finite {finite_ok}")
    updates["capture"] = {
        "ok": bool(shape_ok and dtype_ok and finite_ok),
        "device": {"index": audio.device_index, "name": audio.device_name},
        "rate": audio.rate,
        "source_rate": int(audio.source_rate),
        "resampled": bool(audio.resampled),
        "path": path,
        "fallback_note": audio.fallback_note,
        "frames": int(samples.size),
        "tookMs": round(took_ms, 1),
        "peakDbfs": round(_dbfs(float(np.abs(samples).max())), 1),
        "rmsDbfs": round(_dbfs(float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))), 1),
        "overflow": int(overflow),
        "dropped": int(dropped),
        "alive": bool(alive_after),
    }
    artifact = _update_artifact(
        updates,
        artifact_path,
        defaults={"segments": [], "vad_ms": 0},
        append={"captures": updates["capture"]},
    )
    passed = bool(shape_ok and dtype_ok and finite_ok and alive_after)
    print(f"RESULT {'PASS' if passed else 'FAIL'}")
    if artifact is not None:
        print(f"artifact: {artifact}")
    return 0 if passed else 1


def main(argv: list[str]) -> int:
    _configure_stdout()
    args = list(argv)
    artifact: str | None = SELFTEST_ARTIFACT
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
        # 只有 vad.py 需要 --wav；这里显式拒掉，避免"以为换了个文件"却静默忽略
        print("audio_io 不认识 --wav（那是 vad.py --selftest 的参数）")
        return 2
    target: str | int | None = None
    if "--device" in args:
        index = args.index("--device")
        if index + 1 >= len(args):
            print("--device 需要索引或名称")
            return 2
        raw = args[index + 1]
        target = int(raw) if raw.lstrip("-").isdigit() else raw
        del args[index : index + 2]
    if not args:
        print(
            "用法: python tools/voice/audio_io.py --list | "
            "--selftest [--device <索引|名称>] [--artifact <path>|--no-artifact]"
        )
        return 2
    if args == ["--list"]:
        try:
            devices = list_devices()
        except AudioUnavailable as exc:
            print(f"ERROR AudioUnavailable(kind={exc.kind}) {exc.detail}")
            return 3
        _print_devices(devices)
        return 0
    if args == ["--selftest"]:
        return run_selftest(artifact, device=target)
    print(f"未知参数：{' '.join(args)}")
    print(
        "用法: python tools/voice/audio_io.py --list | "
        "--selftest [--device <索引|名称>] [--artifact <path>|--no-artifact]"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
