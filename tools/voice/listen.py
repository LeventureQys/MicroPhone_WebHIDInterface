"""唤醒词 → 应答音 → 录到端点的聆听状态机（SubStage 2.1）。

任务书：`Document/Update/Alpha/v1.3.0/开发文档/SubStage_2.1.md` §4.4 / §5。
跨 SubStage 契约（设计文档 §4.2）：`listen_once(...)` 返回一段 16 kHz 单声道 16 bit 的 wav 字节，
`kws.WakeSpotter.matches(frame)` 返回是否命中唤醒词；采集与端点来自 SubStage 1.2 的
`audio_io` / `vad.VadGate`（本文件只调用，不修改）。

三个入口（`--loop` 是默认值）：
- `--loop`：常驻聆听，命中后播应答音、录到端点、把 wav 落到 `artifacts/voice/wav/`；
- `--wav <path>`：回放模式（自动化用），不 sleep、不播应答音，尽快跑完；
- `--selftest`：门禁三项（合成语音命中 / 7 条无关 wav 误唤醒 / 实时模式超时退出），
  写 `artifacts/voice/selftest-21.json`。

半双工：应答音播放期间不读麦克风、不喂 KWS（设计文档 §3.7 第 2 条），播放完立刻 `reset()` 清缓冲。
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import wave
from datetime import datetime

import numpy as np

# 既支持 `python tools/voice/listen.py`（脚本），也支持 `from tools.voice import listen`（包）。
_VOICE_DIR = os.path.dirname(os.path.abspath(__file__))
if _VOICE_DIR not in sys.path:
    sys.path.insert(0, _VOICE_DIR)

from audio_io import AudioUnavailable, open_stream, read_wav  # noqa: E402  - SubStage 1.2
from kws import (  # noqa: E402
    DEFAULT_KEYWORDS_FILE,
    DEFAULT_MODEL_DIR,
    DEFAULT_NUM_THREADS,
    SAMPLE_RATE,
    WakeSpotter,
    keywords_display_names,
    make_beep,
)
from vad import END, OVERFLOW, SPEECH, VadGate  # noqa: E402  - SubStage 1.2

DEFAULT_VAD_MODEL = os.path.join(_VOICE_DIR, 'models', 'vad', 'silero_vad.onnx')
REPO_ROOT = os.path.dirname(os.path.dirname(_VOICE_DIR))
WAV_DIR = os.path.join(REPO_ROOT, 'artifacts', 'voice', 'wav')
SELFTEST_JSON = os.path.join(REPO_ROOT, 'artifacts', 'voice', 'selftest-21.json')
TEST_WAV_DIR = os.path.join(DEFAULT_MODEL_DIR, 'test_wavs')
FIXTURE_WAV = os.path.join(_VOICE_DIR, 'test', 'data', 'wake-sentence.wav')

# 1024 = 512 的整数倍（VadGate 只吃整窗），64 ms 一帧；KWS 内部再切成 100 ms 喂模型。
FRAME = 1024
REALTIME_SECONDS = 10.0
_SAPI_VOICE = 'Microsoft Huihui Desktop'

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_WAV = 2
EXIT_AUDIO = 3
EXIT_MODEL = 4


def _now_stamp() -> str:
    return datetime.now().strftime('%Y%m%d-%H%M%S')


def _rel(path: str) -> str:
    try:
        return os.path.relpath(path, REPO_ROOT)
    except ValueError:  # 不同盘符
        return path


def _to_wav_bytes(samples: 'np.ndarray', rate: int = SAMPLE_RATE) -> bytes:
    """float32 [-1,1] → 16 bit PCM 单声道 wav 字节（`listen_once` 的返回形状）。"""
    clipped = np.clip(np.asarray(samples, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = np.round(clipped * 32767.0).astype('<i2')
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def _write_bytes(path: str, data: bytes) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, 'wb') as handle:
        handle.write(data)


def _wav_ms(data: bytes) -> float:
    with wave.open(io.BytesIO(data), 'rb') as handle:
        return round(handle.getnframes() * 1000.0 / handle.getframerate(), 1)


def play_beep(beep: 'np.ndarray | None' = None, rate: int = SAMPLE_RATE) -> bool:
    """播应答音（阻塞）。失败只记 warn，不中断链路（任务书 §5）。"""
    data = make_beep(rate=rate) if beep is None else beep
    try:
        import sounddevice as sd

        sd.play(data, rate)
        sd.wait()
        return True
    except Exception as exc:  # noqa: BLE001 - 音频链路还能用，不因为一声提示音退出
        print(f'[warn] 应答音播放失败：{exc}', file=sys.stderr)
        return False


class _FilePlaybackStream:
    """把 wav 样本当"实时输入"喂给 `listen_once`（回放模式，不 sleep、不占墙钟）。"""

    is_replay = True

    def __init__(self, samples: 'np.ndarray', name: str, rate: int = SAMPLE_RATE) -> None:
        self.rate = rate
        self.device_name = name
        self._samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        self._pos = 0

    def read(self, frames: int = FRAME) -> 'np.ndarray':
        if self._pos >= self._samples.size:
            return np.zeros(0, dtype=np.float32)
        chunk = self._samples[self._pos:self._pos + frames]
        self._pos += chunk.size
        return np.ascontiguousarray(chunk)

    def close(self) -> None:
        self._pos = self._samples.size

    def alive(self) -> bool:
        return self._pos < self._samples.size


def _stream_finished(stream) -> bool:
    """回放流读到头了才算 EOF；实时流没有 EOF（停了会抛 AudioUnavailable）。"""
    return bool(getattr(stream, 'is_replay', False)) and not stream.alive()


def _read_frame(stream, frames: int = FRAME) -> 'np.ndarray':
    """读一帧；`AudioStream.read()` 允许返回比 `frames` 短（1.2 的有界阻塞实现）。"""
    data = stream.read(frames)
    if data is None:
        return np.zeros(0, dtype=np.float32)
    return np.ascontiguousarray(np.asarray(data, dtype=np.float32).reshape(-1))


def listen_once(
    spotter: WakeSpotter,
    gate: VadGate,
    stream,
    *,
    timeout_s: float = 6.0,
    on_event=None,
    beep: bool = True,
) -> 'bytes | None':
    """阻塞直到：①命中唤醒词且 VAD 判 end/overflow → 返回 wav 字节；②`timeout_s` 内没唤醒/没说话 → None。

    `on_event(name, **fields)` 埋点：`wake` / `speech` / `end` / `overflow` / `timeout`。
    `beep=False` 供回放模式用（不占墙钟、不污染自动化环境）；实时模式必须为 True。

    计时按**音频时长**而不是墙钟：回放模式下 4 s 音频才可能远快于 4 s 墙钟。
    `timeout_s` 在两处生效：等唤醒的窗口，以及唤醒之后等第一句话的窗口（任务书 §5：
    唤醒后 6 s 没人说话 → `timeout`，回到等唤醒，不播报）。
    """
    emit = on_event or (lambda *_args, **_fields: None)
    rate = getattr(stream, 'rate', SAMPLE_RATE) or SAMPLE_RATE
    gate.reset()
    spotter.reset()

    # 相位一：等唤醒
    heard_ms = 0.0
    while True:
        started = time.perf_counter()
        frame = _read_frame(stream)
        if frame.size == 0:
            if _stream_finished(stream):
                emit('timeout', phase='wake', audio_ms=round(heard_ms, 1), reason='eof')
                return None
            # 实时流偶尔读不到整帧（有界阻塞超时返回空）：按墙钟记作"这段时间没听到"
            heard_ms += (time.perf_counter() - started) * 1000.0
        else:
            heard_ms += frame.size * 1000.0 / rate
            if spotter.matches(frame):
                break
        if heard_ms >= timeout_s * 1000.0:
            emit('timeout', phase='wake', audio_ms=round(heard_ms, 1))
            return None
    emit('wake', wake_ms=round(heard_ms, 1))
    spotter.reset()

    # 半双工：播放期间不读麦克风、不喂 KWS（设计文档 §3.7 第 2 条）
    if beep:
        play_beep()
        spotter.reset()

    # 相位二：录到端点
    listened_ms = 0.0
    spoke = False
    while True:
        started = time.perf_counter()
        frame = _read_frame(stream)
        if frame.size == 0:
            if _stream_finished(stream):
                state = gate.flush()  # 1.2 的 VadGate：残余尾巴收尾（不 flush 拿不到 END）
                if state in (END, OVERFLOW):
                    segment = gate.result()
                    data = _to_wav_bytes(segment, rate) if segment.size else None
                    start_ms, core_ms = gate.last_span_ms()
                    emit('end' if state == END else 'overflow', start_ms=round(start_ms, 1),
                         speech_ms=round(core_ms, 1), wav_ms=_wav_ms(data) if data else 0.0)
                    return data
                emit('timeout', phase='listen', audio_ms=round(listened_ms, 1), reason='eof')
                return None
            listened_ms += (time.perf_counter() - started) * 1000.0
        else:
            listened_ms += frame.size * 1000.0 / rate
            state = gate.feed(frame)
            if state == SPEECH and not spoke:
                spoke = True
                emit('speech', audio_ms=round(listened_ms, 1))
            elif state in (END, OVERFLOW):
                segment = gate.result()
                start_ms, core_ms = gate.last_span_ms()
                data = _to_wav_bytes(segment, rate) if segment.size else None
                emit('end' if state == END else 'overflow', start_ms=round(start_ms, 1),
                     speech_ms=round(core_ms, 1), wav_ms=_wav_ms(data) if data else 0.0)
                return data
        if not spoke and listened_ms >= timeout_s * 1000.0:
            emit('timeout', phase='listen', audio_ms=round(listened_ms, 1))
            return None


def replay_wav(spotter: WakeSpotter, gate: VadGate, path: str, *, beep: bool = False) -> dict:
    """回放一条 wav，返回 `{hit, hit_ms, wav_bytes, segment_ms, speech_ms, wall_ms, events, duration_ms}`。"""
    samples, rate = read_wav(path)
    if rate != SAMPLE_RATE:
        raise ValueError(f'wav 必须是 16 kHz：{path} rate={rate}')
    stream = _FilePlaybackStream(samples, os.path.basename(path), rate)
    events: list[dict] = []

    def on_event(name: str, **fields) -> None:
        events.append({'name': name, **fields})

    timeout_s = max(1.0, samples.size / rate + 0.5)
    started = time.perf_counter()
    data = listen_once(spotter, gate, stream, timeout_s=timeout_s, on_event=on_event, beep=beep)
    wall_ms = round((time.perf_counter() - started) * 1000.0, 1)
    wake = next((event for event in events if event['name'] == 'wake'), None)
    tail = next((event for event in events if event['name'] in ('end', 'overflow')), None)
    return {
        'wav': _rel(path),
        'duration_ms': round(samples.size * 1000.0 / rate, 1),
        'hit': wake is not None,
        'hit_ms': None if wake is None else wake.get('wake_ms'),
        'wav_bytes': data,
        'segment_ms': None if data is None else _wav_ms(data),
        'speech_ms': None if tail is None else tail.get('speech_ms'),
        'start_ms': None if tail is None else tail.get('start_ms'),
        'wall_ms': wall_ms,
        'events': events,
    }


def _print_events(events: list[dict]) -> None:
    for event in events:
        fields = ' '.join(f'{key}={value}' for key, value in event.items() if key != 'name')
        print(f'[{event["name"]}] {fields}'.rstrip())


def _cmd_wav(spotter: WakeSpotter, gate: VadGate, path: str) -> int:
    if not os.path.isfile(path):
        print(f'[error] 找不到 wav：{os.path.abspath(path)}', file=sys.stderr)
        return EXIT_WAV
    try:
        result = replay_wav(spotter, gate, path)
    except ValueError as exc:
        print(f'[error] wav 格式不支持：{exc}', file=sys.stderr)
        return EXIT_WAV
    _print_events(result['events'])
    if not result['hit']:
        print('MISS')
        print(f'WALL {result["wall_ms"] / 1000.0:.3f}s')
        return EXIT_OK
    print(f'HIT {result["hit_ms"]:.0f}ms')
    if result['wav_bytes'] is None:
        print('NO-SEGMENT 命中后没有录到语音（未到端点）')
    else:
        out_path = os.path.join(WAV_DIR, f'wav-{_now_stamp()}.wav')
        _write_bytes(out_path, result['wav_bytes'])
        print(f'WAV {_rel(out_path)} {result["segment_ms"]:.0f}ms')
    print(f'WALL {result["wall_ms"] / 1000.0:.3f}s')
    return EXIT_OK


def _cmd_loop(spotter: WakeSpotter, gate: VadGate, device: 'str | None', timeout_s: float) -> int:
    try:
        stream = open_stream(device)
    except AudioUnavailable as exc:
        print(f'[error] 打不开音频输入：{exc.kind} {exc.detail}', file=sys.stderr)
        return EXIT_AUDIO
    print(f'LISTEN device={stream.device_name} keywords={_rel(spotter.keywords_file)} timeout={timeout_s:.1f}s')
    print('就绪：先喊一次唤醒词，听到应答音后说指令。Ctrl+C 退出。')
    try:
        while True:
            events: list[dict] = []
            try:
                data = listen_once(
                    spotter, gate, stream, timeout_s=timeout_s,
                    on_event=lambda name, **fields: events.append({'name': name, **fields}),
                )
            except AudioUnavailable as exc:
                print(f'[error] 采集中断：{exc.kind} {exc.detail}', file=sys.stderr)
                return EXIT_AUDIO
            _print_events(events)
            if data is None:
                if not stream.alive():
                    print('[error] 采集流已停止', file=sys.stderr)
                    return EXIT_AUDIO
                continue
            out_path = os.path.join(WAV_DIR, f'wake-{_now_stamp()}.wav')
            _write_bytes(out_path, data)
            print(f'WAV {_rel(out_path)} {_wav_ms(data):.0f}ms')
    except KeyboardInterrupt:
        print('[stop] 收到 Ctrl+C，退出')
        return EXIT_OK
    finally:
        stream.close()


_SAPI_SCRIPT = r'''
param([string]$Path, [string]$Text, [string]$Voice)
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoice($Voice) } catch { [Console]::Error.WriteLine("voice unavailable: $Voice"); exit 4 }
$synth.SetOutputToWaveFile($Path, $fmt)
$synth.Speak($Text)
$synth.Dispose()
'''


def synthesize_wav(text: str, out_path: str, voice: str = _SAPI_VOICE) -> tuple[bool, str]:
    """用 Windows SAPI 合成 16 kHz / 16 bit / 单声道 wav。返回 (是否成功, 说明)。"""
    script_path = os.path.join(tempfile.gettempdir(), 'voice-sapi-synth.ps1')
    with open(script_path, 'w', encoding='utf-8') as handle:
        handle.write(_SAPI_SCRIPT)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    command = [
        'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script_path, '-Path', out_path, '-Text', text, '-Voice', voice,
    ]
    try:
        proc = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace')
    except OSError as exc:
        return False, f'SAPI 启动失败：{exc}'
    detail = (proc.stdout or '') + (proc.stderr or '')
    if proc.returncode != 0 or not os.path.isfile(out_path):
        return False, f'退出码 {proc.returncode}：{detail.strip()}'
    return True, 'ok'


def _ensure_wake_audio(display: str) -> tuple['str | None', str, str]:
    """准备一条"含唤醒词"的合成语音：先现场 SAPI 合成，不行就退回仓库内固定样例。

    返回 `(wav 路径, 来源, 说明)`；来源为 `sapi` / `fixture` / `blocked`。
    为什么要 fixture 兜底：SAPI 的语音是"按进程安全设置"枚举的，低完整性级别进程（例如被开发
    沙箱降权的 Python 子进程）里 `SelectVoice` 会报 "none available with the current security
    setting"，与代码无关。
    """
    out_path = os.path.join(WAV_DIR, 'selftest-wake.wav')
    ok, detail = synthesize_wav(f'{display}，把声音调亮一点', out_path)
    if ok:
        return out_path, 'sapi', 'ok'
    if os.path.isfile(FIXTURE_WAV):
        return FIXTURE_WAV, 'fixture', detail
    return None, 'blocked', detail


def _count_wakes_realtime(spotter: WakeSpotter, device: 'str | None', seconds: float) -> dict:
    """实时模式数命中：统计 `seconds` 秒内的唤醒次数，并记下麦克风峰值电平。"""
    try:
        stream = open_stream(device)
    except AudioUnavailable as exc:
        return {'status': 'blocked', 'kind': exc.kind, 'detail': exc.detail, 'hits': 0, 'seconds': seconds}
    consumed = 0.0
    hits = 0
    peak = 0.0
    # 兜底：采集层一直返回空块（有界阻塞超时）时不能让计数永远不退出
    deadline = time.monotonic() + seconds + 5.0
    try:
        while consumed < seconds and time.monotonic() < deadline:
            frame = _read_frame(stream)
            if frame.size == 0:
                continue
            consumed += frame.size / SAMPLE_RATE
            peak = max(peak, float(np.max(np.abs(frame))))
            if spotter.matches(frame):
                hits += 1
                spotter.reset()
                print(f'WAKE {hits} at {consumed:.1f}s')
    except AudioUnavailable as exc:
        return {'status': 'blocked', 'kind': exc.kind, 'detail': exc.detail, 'hits': hits,
                'seconds': round(consumed, 2), 'peak_dbfs': round(_dbfs(peak), 1)}
    finally:
        stream.close()
    return {
        'status': 'ok',
        'device': stream.device_name,
        'hits': hits,
        'seconds': round(consumed, 2),
        'peak_dbfs': round(_dbfs(peak), 1),
        'timeout_exit': True,
    }


def _dbfs(peak: float) -> float:
    return 20.0 * math.log10(max(float(peak), 1e-9))


def _cmd_selftest(spotter: WakeSpotter, gate: VadGate, device: 'str | None') -> int:
    display = (keywords_display_names(spotter.keywords_file) or ['(未命名)'])[0]
    os.makedirs(WAV_DIR, exist_ok=True)
    report: dict = {
        'stage': '2.1',
        'ts': datetime.now().astimezone().isoformat(timespec='seconds'),
        'keywords_file': _rel(spotter.keywords_file),
        'keywords_display': display,
        'model_dir': _rel(spotter.model_dir),
    }
    started = time.perf_counter()

    # ① 合成语音命中
    synthetic_wav, synthetic_source, synthetic_detail = _ensure_wake_audio(display)
    synthetic: dict = {'source': synthetic_source, 'status': 'blocked'}
    if synthetic_wav is None:
        synthetic['detail'] = synthetic_detail
        print(f'[1/3] 合成语音：阻塞（SAPI 与仓库样例都不可用：{synthetic_detail}）', file=sys.stderr)
    else:
        synthetic['wav'] = _rel(synthetic_wav)
        if synthetic_source == 'fixture':
            synthetic['detail'] = f'SAPI 不可用，退回固定样例：{synthetic_detail}'
            print(f'[1/3] SAPI 不可用（{synthetic_detail}），改用样例 {_rel(synthetic_wav)}')
        replayed = replay_wav(spotter, gate, synthetic_wav)
        synthetic.update({
            'status': 'ok',
            'duration_ms': replayed['duration_ms'],
            'hits': 1 if replayed['hit'] else 0,
            'attempts': 1,
            'hit_ms': replayed['hit_ms'],
            'start_ms': replayed['start_ms'],
            'speech_ms': replayed['speech_ms'],
            'segment_ms': replayed['segment_ms'],
            'wall_ms': replayed['wall_ms'],
        })
        print(f'[1/3] 合成语音 {os.path.basename(synthetic_wav)}：'
              f'{"HIT" if replayed["hit"] else "MISS"} hit_ms={replayed["hit_ms"]} '
              f'speech_ms={replayed["speech_ms"]} segment_ms={replayed["segment_ms"]} '
              f'wall={replayed["wall_ms"]:.0f}ms')
    report['synthetic'] = synthetic

    # ② 7 条无关 wav 的误唤醒计数
    negatives: dict = {'count': 0, 'false_wakes': 0, 'files': [], 'status': 'ok'}
    wav_files = sorted(
        os.path.join(TEST_WAV_DIR, name)
        for name in os.listdir(TEST_WAV_DIR)
        if name.lower().endswith('.wav')
    ) if os.path.isdir(TEST_WAV_DIR) else []
    for path in wav_files:
        replayed = replay_wav(spotter, gate, path)
        negatives['count'] += 1
        if replayed['hit']:
            negatives['false_wakes'] += 1
        negatives['files'].append({
            'wav': _rel(path),
            'verdict': 'HIT' if replayed['hit'] else 'MISS',
            'hit_ms': replayed['hit_ms'],
            'wall_ms': replayed['wall_ms'],
        })
        print(f'[2/3] 负样本 {os.path.basename(path)}：{"HIT" if replayed["hit"] else "MISS"} '
              f'wall={replayed["wall_ms"]:.0f}ms')
    if not wav_files:
        negatives['status'] = 'blocked'
        negatives['detail'] = f'{_rel(TEST_WAV_DIR)} 下没有 wav'
        print('[2/3] 负样本：阻塞（test_wavs 目录为空）', file=sys.stderr)
    report['negatives'] = negatives

    # ③ 实时模式：喊唤醒词统计命中，无人应答按 10 s 自然超时
    print(f'[3/3] 实时模式：请喊 {display}（{REALTIME_SECONDS:.0f} 秒内逐次统计命中）')
    realtime = _count_wakes_realtime(spotter, device, REALTIME_SECONDS)
    report['realtime'] = realtime
    print(f'[3/3] 实时模式：status={realtime["status"]} hits={realtime["hits"]} '
          f'seconds={realtime["seconds"]} peak_dbfs={realtime.get("peak_dbfs")}')

    report['wall_ms'] = round((time.perf_counter() - started) * 1000.0, 1)
    # 注意用 >=7 而不是 ==7：模型包以后多带几条 test_wavs 时不该把门禁判成失败。
    report['ok'] = (
        synthetic['status'] == 'ok'
        and synthetic['hits'] == synthetic['attempts'] == 1
        and negatives['status'] == 'ok'
        and negatives['false_wakes'] == 0
        and negatives['count'] >= 7
    )
    _write_bytes(SELFTEST_JSON, json.dumps(report, ensure_ascii=False, indent=2).encode('utf-8'))
    print(f'SELFTEST {"PASS" if report["ok"] else "FAIL"} json={_rel(SELFTEST_JSON)} '
          f'wall={report["wall_ms"]:.0f}ms')
    return EXIT_OK if report['ok'] else EXIT_FAIL


def _configure_stdout() -> None:
    """stdout 被管道/Tee 接走时是块缓冲：长跑日志会看不见，也会把中文按控制台代码页丢掉。

    `--loop` 是常驻进程（还要连续跑 10 min 取证），所以这里统一改成行缓冲 + UTF-8。
    """
    for handle in (sys.stdout, sys.stderr):
        if hasattr(handle, 'reconfigure'):
            try:
                handle.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
            except (ValueError, OSError):
                pass


def main(argv: 'list[str] | None' = None) -> int:
    _configure_stdout()
    parser = argparse.ArgumentParser(description='唤醒词聆听入口（SubStage 2.1）')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--loop', action='store_true', help='常驻聆听（默认）')
    group.add_argument('--wav', metavar='PATH', help='回放模式：把 wav 当实时输入，尽快跑完')
    group.add_argument('--selftest', action='store_true', help='门禁三项并写 artifacts/voice/selftest-21.json')
    parser.add_argument('--device', metavar='SUBSTR', help='透传给 audio_io.open_stream 的设备名子串')
    parser.add_argument('--timeout', type=float, default=6.0, help='等唤醒/等开口的音频秒数（默认 6.0）')
    args = parser.parse_args(argv)

    try:
        # 显式传 1：这个进程是常驻聆听的，空转的核要留给同机的 LLM 推理（实测见 kws.py 顶部注释）。
        spotter = WakeSpotter(DEFAULT_MODEL_DIR, DEFAULT_KEYWORDS_FILE, num_threads=DEFAULT_NUM_THREADS)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f'[error] 唤醒词模型不可用：{exc}', file=sys.stderr)
        return EXIT_MODEL
    try:
        gate = VadGate(DEFAULT_VAD_MODEL)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f'[error] VAD 模型不可用：{exc}', file=sys.stderr)
        return EXIT_MODEL

    try:
        if args.selftest:
            return _cmd_selftest(spotter, gate, args.device)
        if args.wav:
            return _cmd_wav(spotter, gate, args.wav)
        return _cmd_loop(spotter, gate, args.device, args.timeout)
    finally:
        spotter.close()


if __name__ == '__main__':
    sys.exit(main())
