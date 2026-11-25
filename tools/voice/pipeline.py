"""一轮对话的编排入口：唤醒 → 转写 → 意图 → 执行 → 播报 → 落日志（SubStage 4.3）。

任务书：`Document/Update/Alpha/v1.3.0/开发文档/SubStage_4.3.md`
契约来源：设计文档 §2.2（时序，顺序不可改）、§3.7（半双工/失聪保护）、§3.8（端口与错误码）、
§3.10（日志 16 键）。

三种模式（任务书 §4.1）：

| 模式 | 干什么 |
|---|---|
| `--text "<中文>"` | 跳过音频与唤醒，直接 文本 → 意图 → 执行。评测主力；`eval/run.mjs`（5.3）读它打印的 JSON |
| `--once --wav <path>` | 把 wav 当实时输入（2.1 的 `--wav` 回放路径），走完整链路，跑一轮后退出 |
| `--loop`（默认） | 常驻聆听，每轮结束继续等唤醒；一次失败不退出 |

三条不能省的实现约束：

1. **启动先 `llm.warmup()`**：3.3 实测冷启动 8.49 s（KV 空时 prefill 2170 token），不预热第一轮
   必顶 `plan()` 的 8 s 超时。`PlanClient.warmup()` 自带 30 s 上限。
2. **半双工**（设计文档 §3.7 第 2 条）：播报期间不读麦克风；播完把这段时间累积的帧**丢弃**，
   再 `WakeSpotter.reset()`，否则"自己念的话"会被当成下一轮指令。
3. **日志分工**（4.2 §10）：`artifacts/voice/turn-<ts>.jsonl` 由**本文件**写（只有这里拿得到唤醒 /
   ASR / TTS 耗时）；执行器自己写 `artifacts/voice/exec/exec-<ts>.jsonl`，两处不许共用文件名。

标准输出只放**一行 JSON**（本轮 turn 记录），人类可读的进度/告警一律走 stderr——5.3 的评测脚本
逐条解析 stdout，混进进度行会让它把日志当成结果。

退出码（任务书 §4.1）：`0` 正常 / `2` 参数或 wav 非法 / `3` 音频不可用 / `4` 模型加载失败 /
`5` 执行器不可达（只在启动自检阶段）/ `6` 一次都没成功（`--once` 模式）/
`1` `--text` 模式的这一轮执行失败（执行器 5xx 重试后仍失败或连接断开；任务书 §4.1 未定义此码，
    此处按"单轮失败"取 1，理由见完成报告 §9⑤）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO

# 既支持 `python tools/voice/pipeline.py`（脚本），也支持测试里 `import pipeline`（包内模块）。
_VOICE_DIR = os.path.dirname(os.path.abspath(__file__))
if _VOICE_DIR not in sys.path:
    sys.path.insert(0, _VOICE_DIR)

from audio_io import AudioUnavailable, open_stream  # noqa: E402  - SubStage 1.2
import llm as llm_module  # noqa: E402  - SubStage 3.3
from kws import DEFAULT_KEYWORDS_FILE, DEFAULT_MODEL_DIR, WakeSpotter  # noqa: E402  - SubStage 2.1
from listen import FRAME, listen_once, replay_wav  # noqa: E402  - SubStage 2.1
from normalize import normalize  # noqa: E402  - SubStage 2.2
import parser as parser_module  # noqa: E402  - SubStage 3.2
from tts import Speaker  # noqa: E402  - 本 SubStage
from vad import VadGate  # noqa: E402  - SubStage 1.2

REPO_ROOT = os.path.dirname(os.path.dirname(_VOICE_DIR))
DEFAULT_VAD_MODEL = os.path.join(_VOICE_DIR, 'models', 'vad', 'silero_vad.onnx')
LOG_DIR = os.path.join(REPO_ROOT, 'artifacts', 'voice')
WAV_DIR = os.path.join(LOG_DIR, 'wav')

DEFAULT_EXECUTOR_URL = 'http://127.0.0.1:8767'
DEFAULT_LLM_URL = 'http://127.0.0.1:8768'

#: 等唤醒 / 唤醒后等开口的音频秒数（2.1 的默认值，任务书没给新值就不动）
LISTEN_TIMEOUT_S = 6.0
HTTP_TIMEOUT_S = 10.0
#: §5：5xx / 连接断开重试 1 次，间隔 300 ms
RETRY_DELAY_S = 0.3

EXIT_OK = 0
EXIT_TURN_FAILED = 1
EXIT_ARGS = 2
EXIT_AUDIO = 3
EXIT_MODEL = 4
EXIT_EXECUTOR = 5
EXIT_NO_TURN = 6

#: 设计文档 §3.10 的 17 键（与 4.2 的 `turnlog.mjs` 同集合）+ 任务书 §4.4 的 `total_ms` = 18。
#: 任务书 §4.4 的样例把这 18 个键全列了；验收文档 F6 只要求"不缺键"，所以这里取并集。
TURN_LOG_KEYS = (
    'turn', 'ts', 'route', 'text', 'norm_text', 'plan', 'command', 'readback_ok', 'mismatch',
    'audio_ms', 'wake_ms', 'asr_ms', 'llm_ms', 'apply_ms', 'tts_ms', 'total_ms', 'sink', 'mem_mb',
)

#: 任务书 §4.2：规则层与 LLM 都没命中时的兜底 L1
FALLBACK_PLAN = {
    'v': 1,
    'status': 'unsupported',
    'ops': [],
    'say': '我只管调麦克风音色，比如“声音亮一点”',
    'confidence': 1,
}
#: 设计文档 §3.9：LLM 不可达时的降级话术
LLM_DOWN_NOTE = '（模型没起来）'
EMPTY_SAY = '没听清，请再说一次'
CONFIRM_TIMEOUT_SAY = '确认超时，请再说一次'
READBACK_FAIL_SAY = '写入没生效'
EXECUTOR_DOWN_SAY = '底层没起来'


# ---------------------------------------------------------------------------
# 进程内小工具
# ---------------------------------------------------------------------------


def _ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000.0, 1)


def _local_iso_now() -> str:
    """`2026-11-24T10:31:02.117+08:00`（与设计文档 §3.10 的样例同形）"""
    return datetime.now().astimezone().isoformat(timespec='milliseconds')


def _stamp() -> str:
    """`yyyyMMdd-HHmmss-SSS`（文件名用本地时间，取证时与人工观察一致）"""
    now = datetime.now()
    return f'{now.strftime("%Y%m%d-%H%M%S")}-{int(now.microsecond / 1000):03d}'


def _wav_duration_ms(data: bytes) -> float | None:
    try:
        with wave.open(BytesIO(data), 'rb') as handle:
            rate = handle.getframerate() or 16000
            return round(handle.getnframes() * 1000.0 / rate, 1)
    except (wave.Error, EOFError, OSError):
        return None


def _process_mem_mb() -> int | None:
    """本进程工作集 MB（对应 Node 侧的 `process.memoryUsage().rss`）；取不到就 `null`。"""
    try:
        import ctypes
        from ctypes import wintypes

        class _Counters(ctypes.Structure):
            _fields_ = [
                ('cb', wintypes.DWORD),
                ('PageFaultCount', wintypes.DWORD),
                ('PeakWorkingSetSize', ctypes.c_size_t),
                ('WorkingSetSize', ctypes.c_size_t),
                ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                ('PagefileUsage', ctypes.c_size_t),
                ('PeakPagefileUsage', ctypes.c_size_t),
            ]

        counters = _Counters()
        counters.cb = ctypes.sizeof(counters)
        kernel32 = ctypes.WinDLL('kernel32')
        # **必须**声明返回类型：默认 c_int 会把 64 位句柄截断，GetProcessMemoryInfo 直接失败
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        handle = kernel32.GetCurrentProcess()
        psapi = ctypes.WinDLL('psapi.dll')  # type: ignore[attr-defined]
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(_Counters), wintypes.DWORD
        ]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
        if not ok:
            return None
        return int(round(counters.WorkingSetSize / (1024 * 1024)))
    except Exception:  # noqa: BLE001 - 内存数只是取证字段，取不到不许影响链路
        return None


def _configure_stdout() -> None:
    """stdout 被管道接走时是块缓冲：一行 JSON 要及时刷出去，中文也不能按控制台代码页丢。"""
    for handle in (sys.stdout, sys.stderr):
        if hasattr(handle, 'reconfigure'):
            try:
                handle.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
            except (ValueError, OSError):
                pass


def _warn(message: str) -> None:
    print(f'[warn] {message}', file=sys.stderr)


def _info(message: str) -> None:
    print(f'[pipeline] {message}', file=sys.stderr)


# ---------------------------------------------------------------------------
# 执行器 HTTP 客户端（设计文档 §3.8）
# ---------------------------------------------------------------------------


class ExecutorError(RuntimeError):
    """执行器返回非 2xx，或根本连不上。

    `status` 为 `None` 表示连接层失败（没拿到 HTTP 状态码）；其余按执行器的
    `{"ok":false,"error":{"code","message","detail"}}` 填充。
    """

    def __init__(self, status: int | None, code: str, message: str, detail=None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status >= 500


class ExecutorClient:
    """`/health` `/state` `/apply` `/undo` 的最小客户端（stdlib `urllib`，零依赖）。"""

    def __init__(
        self,
        base_url: str = DEFAULT_EXECUTOR_URL,
        *,
        timeout_s: float = HTTP_TIMEOUT_S,
        retry_delay_s: float = RETRY_DELAY_S,
        attempts: int = 2,
    ) -> None:
        self.base_url = base_url.rstrip('/')
        self.timeout_s = float(timeout_s)
        self.retry_delay_s = float(retry_delay_s)
        self.attempts = max(1, int(attempts))

    # -- 底层 ---------------------------------------------------------------

    def _once(self, method: str, path: str, payload=None) -> dict:
        data = None
        headers = {'Accept': 'application/json'}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json; charset=utf-8'
        request = urllib.request.Request(
            self.base_url + path, data=data, method=method, headers=headers
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            body = b''
            try:
                body = exc.read()
            except OSError:
                pass
            raise self._failure(exc.code, body) from exc
        except urllib.error.URLError as exc:
            raise ExecutorError(None, 'E_EXECUTOR_UNREACHABLE', f'连不上执行器：{exc.reason}') from exc
        except OSError as exc:
            raise ExecutorError(None, 'E_EXECUTOR_UNREACHABLE', f'连不上执行器：{exc}') from exc
        try:
            parsed = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ExecutorError(None, 'E_EXECUTOR_BAD_JSON', f'执行器返回的不是 JSON：{exc}') from exc
        if not isinstance(parsed, dict):
            raise ExecutorError(None, 'E_EXECUTOR_BAD_JSON', '执行器返回的顶层不是对象')
        if parsed.get('ok') is False:
            error = parsed.get('error') if isinstance(parsed.get('error'), dict) else {}
            raise ExecutorError(
                200,
                str(error.get('code') or 'E_EXECUTOR'),
                str(error.get('message') or '执行器返回 ok=false'),
                error.get('detail'),
            )
        return parsed

    @staticmethod
    def _failure(status: int, body: bytes) -> ExecutorError:
        code = f'E_HTTP_{status}'
        message = f'执行器返回 HTTP {status}'
        detail = None
        try:
            parsed = json.loads(body.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get('error'), dict):
            error = parsed['error']
            code = str(error.get('code') or code)
            message = str(error.get('message') or message)
            detail = error.get('detail')
        return ExecutorError(status, code, message, detail)

    # -- 对外 ---------------------------------------------------------------

    def request(self, method: str, path: str, payload=None) -> dict:
        """5xx / 连接失败重试 1 次（§5）；4xx 不重试（重试也不会变）。"""
        last: ExecutorError | None = None
        for attempt in range(self.attempts):
            try:
                return self._once(method, path, payload)
            except ExecutorError as exc:
                last = exc
                if not exc.retryable or attempt == self.attempts - 1:
                    raise
                time.sleep(self.retry_delay_s)
        assert last is not None  # 理论上到不了；留个明确出口
        raise last

    def get(self, path: str) -> dict:
        return self.request('GET', path)

    def post(self, path: str, payload: dict) -> dict:
        return self.request('POST', path, payload)

    def health(self) -> dict | None:
        """启动自检：连不上返回 None（不抛），由调用方决定退出码 5。"""
        try:
            return self.get('/health')
        except ExecutorError:
            return None

    def state(self) -> dict:
        return self.get('/state')


# ---------------------------------------------------------------------------
# 命令行选项
# ---------------------------------------------------------------------------


@dataclass
class Options:
    text: str | None = None
    once: bool = False
    wav: str | None = None
    loop: bool = False
    sink: str = 'dry'
    executor: str = DEFAULT_EXECUTOR_URL
    llm: str = DEFAULT_LLM_URL
    no_tts: bool = False
    no_llm: bool = False
    device: str | None = None
    keep_wav: bool = False


# ---------------------------------------------------------------------------
# 编排
# ---------------------------------------------------------------------------


class Pipeline:
    """一次进程内的编排器：持有各层句柄、待确认槽位与日志出口。

    依赖全部可从构造函数注入（单测用假 ASR / 假 `PlanClient` / 真 HTTP 假执行器），
    默认值才去碰真模型与真服务。
    """

    def __init__(
        self,
        options: Options | None = None,
        *,
        asr=None,
        parser_mod=None,
        llm=None,
        speaker=None,
        executor=None,
        spotter=None,
        gate=None,
        stream=None,
        targets=None,
        log_dir: str | None = None,
        wav_dir: str | None = None,
        mem_mb=None,
    ) -> None:
        self.options = options or Options()
        self.no_llm = bool(self.options.no_llm)
        self.keep_wav = bool(self.options.keep_wav)

        self.parser = parser_mod or parser_module
        self.asr = asr
        self.llm = llm
        self.llm_available = False
        self.speaker = speaker if speaker is not None else Speaker(enabled=not self.options.no_tts)
        self.executor = executor if executor is not None else ExecutorClient(self.options.executor)
        self.spotter = spotter
        self.gate = gate
        self.stream = stream

        self.log_dir = log_dir or LOG_DIR
        self.wav_dir = wav_dir or WAV_DIR
        self._mem_mb = mem_mb or _process_mem_mb
        if targets is not None:
            self.targets = targets
        else:
            loader = getattr(self.parser, 'load_targets', None)
            self.targets = loader() if callable(loader) else None

        #: 只保留一个待确认（任务书 §4.2）：`(plan, confirmToken)`
        self.pending: tuple[dict, str] | None = None
        #: 落地靶名称以执行器 `/health` 为准（`--sink` 只是期望值）
        self.sink = self.options.sink
        self.listen_timeout = LISTEN_TIMEOUT_S
        self.listen = self.listen_unavailable
        self.last_record: dict | None = None

    # -- 启动自检 -----------------------------------------------------------

    def prepare(self) -> int | None:
        """执行器可达性 + LLM 预热。返回 `None` 表示可以开门，否则返回退出码。"""
        health = self.executor.health()
        if health is None:
            print(f'执行器没起来：{self.options.executor}', file=sys.stderr)
            return EXIT_EXECUTOR
        self.sink = str(health.get('sink') or self.options.sink)
        if self.sink != self.options.sink:
            _warn(
                f'执行器当前 sink={self.sink}，与 --sink {self.options.sink} 不一致'
                '（sink 由执行器自己的启动参数决定，这里只记执行器报告的那个）'
            )
        _info(f'执行器 {self.options.executor} sink={self.sink} turn={health.get("turn")} '
              f'undoDepth={health.get("undoDepth")}')
        self.prepare_llm()
        return None

    def prepare_llm(self) -> None:
        """`available()` → `warmup()`；失败一律降级为只走规则层，**不退出**（§5）。"""
        if self.no_llm:
            _info('--no-llm：只走规则层')
            return
        if self.llm is None:
            try:
                self.llm = llm_module.PlanClient(base_url=self.options.llm)
            except (OSError, ValueError) as exc:
                _warn(f'LLM 客户端构造失败（{exc}），降级为只走规则层')
                return
        if not self.llm.available():
            _warn(f'llama-server 没起来（{self.options.llm}），本进程降级为只走规则层')
            return
        started = time.perf_counter()
        try:
            self.llm.warmup()
        except llm_module.LlmUnavailable as exc:
            _warn(f'LLM 预热失败（{exc}），降级为只走规则层')
            return
        except Exception as exc:  # noqa: BLE001 - 预热失败不是致命错误
            _warn(f'LLM 预热异常（{exc}），降级为只走规则层')
            return
        self.llm_available = True
        _info(f'LLM 预热完成 {_ms(started):.0f}ms（冷启动 prefill，不预热第一轮必顶超时）')

    # -- 一轮 ---------------------------------------------------------------

    def run_turn(self, *, audio: bytes | None = None, text: str | None = None) -> dict | None:
        """跑完一轮，返回执行器响应（没有唤醒/没听清时返回 `None`）。

        顺序固定（任务书 §4.2）：听 → 转写 → 规范化 → 控制词 → 意图 → 执行 → 播报 → 落日志。
        """
        started = time.perf_counter()
        record = self._blank_record()
        say_text: str | None = None
        response: dict | None = None
        try:
            if text is None:
                audio, span = self.listen()
                if audio is None:
                    # §4.2：音频超时不算一轮，不播报、不落日志
                    self.last_record = None
                    return None
                record['audio_ms'] = span.get('audio_ms')
                record['wake_ms'] = span.get('wake_ms')
                if audio and self.keep_wav:
                    self.save_wav(audio)
                asr_started = time.perf_counter()
                raw_text = self.asr.transcribe(audio) if self.asr is not None else ''
                record['asr_ms'] = _ms(asr_started)
            else:
                raw_text = text
            record['text'] = raw_text
            norm = normalize(raw_text or '')
            record['norm_text'] = norm

            if not norm.strip():
                # §5：空文本不调执行器，播报"没听清"，日志 route='empty'
                record['route'] = 'empty'
                say_text = EMPTY_SAY
            else:
                response, say_text = self._dispatch(record, norm)
        except ExecutorError as exc:
            say_text = self._note_failure(exc, record)
        except AudioUnavailable:
            raise
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001 - 单轮失败不许把常驻进程带走
            record['error'] = 'E_PIPELINE'
            _warn(f'本轮异常：{exc}')
            say_text = EXECUTOR_DOWN_SAY

        record['tts_ms'] = self.say(say_text) if say_text else 0.0
        record['total_ms'] = _ms(started)
        self.last_record = record
        self.log_turn(record)
        self._print_record(record)
        return response

    def _dispatch(self, record: dict, norm: str) -> tuple[dict | None, str | None]:
        """控制词 / 规则层 / LLM / 兜底 → 一次执行器调用。抛出 `ExecutorError` 由上层处置。"""
        control = self.parser.parse_control(norm)

        if control == 'confirm' and self.pending is not None:
            plan, token = self.pending
            self.pending = None
            record['route'] = 'control'
            record['plan'] = plan
            return self._post_and_record('/apply', {**plan, 'confirmToken': token}, record)

        if control == 'undo':
            # 撤销只能走 POST /undo（4.2 §10 第 1 条：发给 /apply 会拿到 501）
            record['route'] = 'control'
            return self._post_and_record('/undo', {}, record)

        # 普通指令：新指令到来即丢弃旧的待确认（§4.2，"确认"不许错配到上上轮）
        self.pending = None

        plan = self.parser.parse(norm, targets=self.targets)
        route = 'rule'
        llm_ms = 0.0
        if plan is None and not self.no_llm and self.llm_available and self.llm is not None:
            llm_started = time.perf_counter()
            try:
                plan = self.llm.plan(norm, state=self.executor_state())
            except llm_module.LlmUnavailable as exc:
                _warn(f'LLM 调用失败（{exc}），本进程降级为只走规则层')
                self.llm_available = False
                plan = None
            llm_ms = _ms(llm_started)
            route = 'llm'
        record['llm_ms'] = llm_ms if route == 'llm' else 0.0

        if plan is None:
            plan = dict(FALLBACK_PLAN)
            # 规则层没命中、而 LLM 这条路根本不可用（启动就没起来，或刚抛了 LlmUnavailable）
            # → 按设计文档 §3.9 在话术尾巴上说明原因；模型起来了但输出不可用则不加。
            if not self.no_llm and not self.llm_available:
                plan['say'] = plan['say'] + LLM_DOWN_NOTE
            route = 'fallback'
        record['route'] = route

        # 把规范化后的原话一并交过去：执行器用它做"数字接地"与 exec 日志（L1 允许附加顶层键）
        payload = {**plan, 'text': norm}
        record['plan'] = payload
        response, say_text = self._post_and_record('/apply', payload, record)
        if response is not None:
            command = response.get('command') or {}
            if command.get('status') == 'needs_confirm':
                self.pending = (payload, str(command.get('confirmToken') or ''))
        return response, say_text

    def _post_and_record(
        self, path: str, payload: dict, record: dict
    ) -> tuple[dict, str | None]:
        started = time.perf_counter()
        try:
            response = self.post(path, payload)
        finally:
            record['apply_ms'] = _ms(started)
        command = response.get('command') if isinstance(response.get('command'), dict) else {}
        record['command'] = command
        record['turn'] = command.get('turn')
        record['mismatch'] = response.get('mismatch') or []
        status = command.get('status')
        if status == 'applied':
            record['readback_ok'] = not record['mismatch']
        elif status == 'needs_confirm':
            # 这一轮刻意没写设备（等用户确认），谈不上回读成功或失败
            record['readback_ok'] = None
        else:
            record['readback_ok'] = False
        return response, (command.get('say') or None)

    def _note_failure(self, exc: ExecutorError, record: dict) -> str:
        """把执行器失败映射成播报话术，并把错误码/回读差异记进日志（§5）。"""
        code = exc.code or 'E_EXECUTOR'
        record['error'] = code
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        command = detail.get('command')
        if isinstance(command, dict):
            record['command'] = command
            record['turn'] = command.get('turn')
        mismatch = detail.get('mismatch')
        if isinstance(mismatch, list):
            record['mismatch'] = mismatch
        record['readback_ok'] = False

        if code == 'E_CONFIRM_EXPIRED':
            self.pending = None
            return CONFIRM_TIMEOUT_SAY
        if code == 'E_READBACK_MISMATCH':
            return READBACK_FAIL_SAY
        if exc.retryable or code in ('E_SINK_UNAVAILABLE', 'E_EXECUTOR_UNREACHABLE'):
            _warn(f'执行器不可用（{code}）：{exc.message}')
            return EXECUTOR_DOWN_SAY
        return exc.message or '这次没成功'

    # -- 各层句柄 -----------------------------------------------------------

    def post(self, path: str, payload: dict) -> dict:
        return self.executor.post(path, payload)

    def executor_state(self) -> dict:
        """给 LLM 的当前参数快照（11 个值）；取不到就空快照，不让执行器抖动毁掉意图层。"""
        try:
            state = self.executor.state()
        except ExecutorError as exc:
            _warn(f'读当前状态失败（{exc.code}），LLM 用默认快照')
            return {}
        params = state.get('params') if isinstance(state, dict) else None
        return params if isinstance(params, dict) else {}

    def say(self, text: str | None) -> float:
        """播报并做半双工收尾：播完丢掉播放期间累积的帧，再复位唤醒词缓冲。"""
        if not text or self.speaker is None:
            return 0.0
        elapsed = self.speaker.say(text)
        if elapsed > 0:
            self.discard_pending_audio()
            self.reset_wake()
        return elapsed

    def discard_pending_audio(self, *, budget_s: float = 1.0, max_frames: int = 320) -> int:
        """非阻塞地把采集流里已经排队的帧读空并丢弃，返回丢掉的样本数。

        `AudioStream.read(frames, timeout_s=0)` 是"有多少拿多少"：播报期间没人读，
        PortAudio 的环形缓冲会积一段自己的回声，不丢就会把 TTS 念的话当下一轮指令。
        """
        stream = self.stream
        if stream is None or getattr(stream, 'is_replay', False):
            return 0
        dropped = 0
        deadline = time.monotonic() + max(0.0, budget_s)
        while dropped < max_frames * FRAME and time.monotonic() < deadline:
            try:
                chunk = stream.read(FRAME, timeout_s=0.0)
            except TypeError:  # 不是 1.2 的 AudioStream（例如测试替身）
                break
            except AudioUnavailable:
                break
            size = 0 if chunk is None else len(chunk)
            if size == 0:
                break
            dropped += size
        if dropped:
            _info(f'半双工：丢弃播报期间累积的 {dropped} 个样本')
        return dropped

    def reset_wake(self) -> None:
        if self.spotter is not None:
            try:
                self.spotter.reset()
            except Exception as exc:  # noqa: BLE001 - 复位失败不该毁掉这一轮
                _warn(f'唤醒词缓冲复位失败：{exc}')

    def listen_unavailable(self) -> tuple[None, dict]:
        raise RuntimeError('当前模式没有音频源（--text 不该调用 listen）')

    def listen_live(self) -> tuple[bytes | None, dict]:
        """实时模式的一轮聆听：等唤醒 + 录到端点（2.1 的 `listen_once`）。"""
        events: list[dict] = []

        def on_event(name: str, **fields) -> None:
            events.append({'name': name, **fields})

        data = listen_once(
            self.spotter, self.gate, self.stream, timeout_s=self.listen_timeout, on_event=on_event
        )
        for event in events:
            fields = ' '.join(f'{key}={value}' for key, value in event.items() if key != 'name')
            _info(f'[{event["name"]}] {fields}'.rstrip())
        if data is None:
            return None, {}
        wake = next((item for item in events if item['name'] == 'wake'), {})
        tail = next(
            (item for item in events if item['name'] in ('end', 'overflow')), {}
        )
        audio_ms = tail.get('wav_ms') or _wav_duration_ms(data)
        return data, {'audio_ms': audio_ms, 'wake_ms': wake.get('wake_ms')}

    def save_wav(self, data: bytes) -> str | None:
        """`--keep-wav`：本轮录音落到 `artifacts/voice/wav/turn-<stamp>.wav`（失败只 warn）。

        文件名用 `_stamp()`（`yyyyMMdd-HHmmss-SSS`）：`ts` 里的冒号在 Windows 上是非法字符。
        """
        try:
            os.makedirs(self.wav_dir, exist_ok=True)
            path = os.path.join(self.wav_dir, f'turn-{_stamp()}.wav')
            with open(path, 'wb') as handle:
                handle.write(data)
            _info(f'本轮录音：{os.path.relpath(path, REPO_ROOT)}')
            return path
        except OSError as exc:
            _warn(f'录音写盘失败（不影响业务）：{exc}')
            return None

    # -- 日志 ---------------------------------------------------------------

    def _blank_record(self) -> dict:
        record = {key: None for key in TURN_LOG_KEYS}
        record['ts'] = _local_iso_now()
        record['route'] = 'rule'
        record['mismatch'] = []
        record['sink'] = self.sink
        record['mem_mb'] = self._mem_mb()
        return record

    def log_turn(self, record: dict) -> str | None:
        """`artifacts/voice/turn-<yyyyMMdd-HHmmss-SSS>.jsonl` 追加一行；失败只 warn（§5）。"""
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            path = os.path.join(self.log_dir, f'turn-{_stamp()}.jsonl')
            line = json.dumps(record, ensure_ascii=False) + '\n'
            with open(path, 'a', encoding='utf-8', newline='\n') as handle:
                handle.write(line)
            return path
        except Exception as exc:  # noqa: BLE001 - 日志不是业务，磁盘满也不许影响结果
            _warn(f'turn 日志写盘失败（不影响业务）：{exc}')
            return None

    @staticmethod
    def _print_record(record: dict) -> None:
        sys.stdout.write(json.dumps(record, ensure_ascii=False) + '\n')
        sys.stdout.flush()

    # -- 收尾 ---------------------------------------------------------------

    def close(self) -> None:
        if self.speaker is not None:
            try:
                self.speaker.close()
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------
# 三种模式
# ---------------------------------------------------------------------------


def _build_wake_stack() -> tuple[WakeSpotter | None, VadGate | None, str | None]:
    """唤醒词 + VAD。返回 `(spotter, gate, 错误说明)`。"""
    try:
        spotter = WakeSpotter(DEFAULT_MODEL_DIR, DEFAULT_KEYWORDS_FILE)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        return None, None, f'唤醒词模型不可用：{exc}'
    try:
        gate = VadGate(DEFAULT_VAD_MODEL)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        spotter.close()
        return None, None, f'VAD 模型不可用：{exc}'
    return spotter, gate, None


def _build_asr() -> tuple[object | None, str | None]:
    try:
        import asr as asr_module  # 只为 `--text` 模式省掉 1 s 的模型加载
    except Exception as exc:  # noqa: BLE001
        return None, f'ASR 模块不可用：{exc}'
    try:
        return asr_module.AsrEngine(), None
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        return None, f'ASR 模型不可用：{exc}'


def run_text_mode(pipeline: Pipeline, options: Options) -> int:
    """`--text`：不起模型、不开麦克风，只跑一轮意图 → 执行。"""
    response = pipeline.run_turn(text=options.text)
    record = pipeline.last_record or {}
    if response is None:
        print('这一轮没有结果（文本为空？）', file=sys.stderr)
        return EXIT_TURN_FAILED
    if record.get('error'):
        _warn(f'这一轮失败：{record["error"]}')
        return EXIT_TURN_FAILED
    return EXIT_OK


def run_once_wav_mode(pipeline: Pipeline, options: Options) -> int:
    """`--once --wav`：把 wav 当实时输入走完整链路（2.1 的回放路径），跑一轮后退出。"""
    path = options.wav or ''
    if not path or not os.path.isfile(path):
        print(f'[error] 找不到 wav：{os.path.abspath(path) if path else "(未给 --wav)"}',
              file=sys.stderr)
        return EXIT_ARGS

    spotter, gate, error = _build_wake_stack()
    if spotter is None:
        print(f'[error] {error}', file=sys.stderr)
        return EXIT_MODEL
    try:
        try:
            replay = replay_wav(spotter, gate, path)
        except ValueError as exc:
            print(f'[error] wav 格式不支持：{exc}', file=sys.stderr)
            return EXIT_ARGS
        for event in replay.get('events') or []:
            fields = ' '.join(f'{key}={value}' for key, value in event.items() if key != 'name')
            _info(f'[{event["name"]}] {fields}'.rstrip())
        if not replay['hit']:
            print(f'[once] MISS 没有命中唤醒词（{path}）', file=sys.stderr)
            return EXIT_NO_TURN
        segment = replay['wav_bytes']
        if segment is None:
            print('[once] NO-SEGMENT 命中了唤醒词但没录到语音', file=sys.stderr)
            return EXIT_NO_TURN

        asr, error = _build_asr()
        if asr is None:
            print(f'[error] {error}', file=sys.stderr)
            return EXIT_MODEL
        span = {'audio_ms': replay['segment_ms'], 'wake_ms': replay['hit_ms']}
        pipeline.spotter = spotter
        pipeline.gate = gate
        pipeline.asr = asr
        pipeline.listen = lambda: (segment, span)  # 回放已经在上面跑完了
        response = pipeline.run_turn()
        record = pipeline.last_record or {}
        if response is None or record.get('error'):
            _warn('这一轮没有成功写入')
            return EXIT_NO_TURN
        return EXIT_OK
    finally:
        spotter.close()


def run_loop_mode(pipeline: Pipeline, options: Options) -> int:
    """`--loop`（默认）：常驻聆听。单轮失败只 warn，不退出（§8）。"""
    spotter, gate, error = _build_wake_stack()
    if spotter is None:
        print(f'[error] {error}', file=sys.stderr)
        return EXIT_MODEL
    asr, asr_error = _build_asr()
    if asr is None:
        spotter.close()
        print(f'[error] {asr_error}', file=sys.stderr)
        return EXIT_MODEL
    try:
        stream = open_stream(options.device)
    except AudioUnavailable as exc:
        spotter.close()
        print(f'[error] 打不开音频输入：{exc.kind} {exc.detail}', file=sys.stderr)
        return EXIT_AUDIO

    pipeline.spotter = spotter
    pipeline.gate = gate
    pipeline.asr = asr
    pipeline.stream = stream
    pipeline.listen = pipeline.listen_live
    _info(f'LISTEN device={stream.device_name} timeout={pipeline.listen_timeout:.1f}s '
          f'llm={"on" if pipeline.llm_available else "off"} tts={"off" if options.no_tts else "on"}')
    print('就绪：先喊一次唤醒词，听到应答音后说指令。Ctrl+C 退出。', file=sys.stderr)
    try:
        while True:
            try:
                pipeline.run_turn()
            except AudioUnavailable as exc:
                print(f'[error] 采集中断：{exc.kind} {exc.detail}', file=sys.stderr)
                return EXIT_AUDIO
            except KeyboardInterrupt:
                raise
            except Exception as exc:  # noqa: BLE001 - 一轮失败不许终止常驻进程
                _warn(f'这一轮失败，继续聆听：{exc}')
    except KeyboardInterrupt:
        print('[stop] 收到 Ctrl+C，退出', file=sys.stderr)
        return EXIT_OK
    finally:
        try:
            stream.close()
        finally:
            spotter.close()
            try:
                asr.close()
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='语音链路编排入口（SubStage 4.3）：--text / --once --wav / --loop',
        add_help=True,
    )
    parser.add_argument('--text', metavar='文本', default=None,
                        help='纯文本模式：跳过音频与唤醒，直接进意图→执行')
    parser.add_argument('--once', action='store_true', help='离线模式：配 --wav 跑一轮后退出')
    parser.add_argument('--wav', metavar='PATH', default=None, help='把 wav 当实时输入（回放）')
    parser.add_argument('--loop', action='store_true', help='实时模式（默认）：常驻聆听')
    parser.add_argument('--sink', default='dry', choices=('dry', 'vdevice'),
                        help='期望执行器用的落地靶（默认 dry）')
    parser.add_argument('--executor', metavar='URL', default=DEFAULT_EXECUTOR_URL,
                        help=f'执行器地址（默认 {DEFAULT_EXECUTOR_URL}）')
    parser.add_argument('--llm', metavar='URL', default=DEFAULT_LLM_URL,
                        help=f'llama-server 地址（默认 {DEFAULT_LLM_URL}）')
    parser.add_argument('--no-tts', action='store_true', help='只打印不播报')
    parser.add_argument('--no-llm', action='store_true', help='强制只走规则层')
    parser.add_argument('--device', metavar='SUBSTR', default=None, help='输入设备名子串')
    parser.add_argument('--keep-wav', action='store_true', help='保存本轮录音到 artifacts/voice/wav/')
    return parser


def options_from_args(args: argparse.Namespace) -> tuple[Options | None, int | None]:
    """把命令行折成 `Options`，并做互斥/取值校验（非法时返回退出码 2）。"""
    if args.text is not None and args.wav:
        print('--text 与 --wav 互斥', file=sys.stderr)
        return None, EXIT_ARGS
    if args.loop and (args.text is not None or args.wav):
        print('--loop 与 --text / --wav 互斥', file=sys.stderr)
        return None, EXIT_ARGS
    if args.once and not args.wav:
        print('--once 需要 --wav <path>', file=sys.stderr)
        return None, EXIT_ARGS
    for name in ('executor', 'llm'):
        value = getattr(args, name)
        if not str(value).startswith(('http://', 'https://')):
            print(f'--{name} 必须是 http(s) URL：{value}', file=sys.stderr)
            return None, EXIT_ARGS
    return Options(
        text=args.text,
        once=bool(args.once),
        wav=args.wav,
        loop=bool(args.loop),
        sink=args.sink,
        executor=args.executor,
        llm=args.llm,
        no_tts=bool(args.no_tts),
        no_llm=bool(args.no_llm),
        device=args.device,
        keep_wav=bool(args.keep_wav),
    ), None


def main(argv: list[str] | None = None) -> int:
    _configure_stdout()
    args = build_parser().parse_args(argv)
    options, code = options_from_args(args)
    if options is None:
        return EXIT_ARGS

    pipeline = Pipeline(options)
    try:
        startup = pipeline.prepare()
        if startup is not None:
            return startup
        if options.text is not None:
            return run_text_mode(pipeline, options)
        if options.wav:
            return run_once_wav_mode(pipeline, options)
        return run_loop_mode(pipeline, options)
    finally:
        pipeline.close()


if __name__ == '__main__':
    sys.exit(main())
