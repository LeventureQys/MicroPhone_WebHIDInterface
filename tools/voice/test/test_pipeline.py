"""SubStage 4.3 单元测试：编排（`tools/voice/pipeline.py`）与播报（`tools/voice/tts.py`）。

任务书 §6 的 8 条按顺序对应 `PipelineContractTest` 的 8 个用例（`test_1_...` ~ `test_8_...`），
后面几个类补边界：重试、连接失败、日志写盘失败、半双工丢帧、预热与启动自检。

全部离线，不碰麦克风、不碰真执行器、不碰真 llama-server：
- 执行器用 `http.server` 起**真 HTTP** 假执行器（可编程响应队列 + 记录每一条请求）；
- ASR / LLM 用假对象（`FakeAsr` / `FakeLlm`）；
- 意图层跑**真** `parser.py`（纯函数、离线），才能证明"规则层命中"这类行为；
- 播报默认 `Speaker(enabled=False)`，要断言话术时用 `RecordingSpeaker`。

运行：`python -m unittest discover -s tools/voice/test -p "test_pipeline.py"`
"""

from __future__ import annotations

import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

VOICE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
for candidate in (VOICE_DIR, REPO_ROOT):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import pipeline as pipeline_mod  # noqa: E402
import tts as tts_mod  # noqa: E402
from tts import Speaker  # noqa: E402

DESIGN_KEYS = frozenset(  # 设计文档 §3.10 的 17 键（验收文档 F6 的"16 键齐全"取并集即可）
    {
        'turn', 'ts', 'wake_ms', 'audio_ms', 'asr_ms', 'route', 'llm_ms', 'apply_ms', 'tts_ms',
        'text', 'norm_text', 'plan', 'command', 'readback_ok', 'mismatch', 'sink', 'mem_mb',
    }
)


# ---------------------------------------------------------------------------
# 假件
# ---------------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args) -> None:  # 静音
        return

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        if not raw.strip():
            return None
        return json.loads(raw.decode('utf-8'))

    def _send(self, status: int, payload) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - http.server 的命名
        owner = self.server.owner
        owner.requests.append(('GET', self.path, None))
        if self.path == '/health':
            self._send(200, owner.health_payload)
        elif self.path == '/state':
            self._send(200, {'ok': True, 'params': owner.params, 'bands': owner.bands})
        else:
            self._send(404, {'ok': False, 'error': {'code': 'E_NOT_FOUND', 'message': '没有这个端点'}})

    def do_POST(self) -> None:  # noqa: N802
        owner = self.server.owner
        body = self._body()
        owner.requests.append(('POST', self.path, body))
        if owner.queue:
            status, payload = owner.queue.pop(0)
        else:
            status, payload = owner.default_for(self.path, body)
        self._send(status, payload)


class FakeExecutor(pipeline_mod.ExecutorClient):
    """真 HTTP 假执行器：继承真客户端，`Pipeline` 的用法与生产完全一致。"""

    def __init__(self, *, sink: str = 'dry') -> None:
        self.queue: list[tuple[int, object]] = []
        self.requests: list[tuple[str, str, object]] = []
        self.health_payload = {'ok': True, 'sink': sink, 'turn': 't-0000', 'undoDepth': 0}
        self.params = {'enc.Level': 1, 'eq.band7.gain': 0}
        self.bands = [0] * 7
        self.turn_seq = 0
        self._server = ThreadingHTTPServer(('127.0.0.1', 0), _Handler)
        self._server.daemon_threads = True
        self._server.owner = self
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        super().__init__(self.url, retry_delay_s=pipeline_mod.RETRY_DELAY_S, timeout_s=5.0)

    # -- 生命周期 -----------------------------------------------------------

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f'http://{host}:{port}'

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(2.0)

    # -- 编程 ---------------------------------------------------------------

    def push(self, status: int, payload) -> None:
        self.queue.append((status, payload))

    def posts(self, path: str = '/apply') -> list[dict]:
        return [body for method, target, body in self.requests if method == 'POST' and target == path]

    def paths(self) -> list[str]:
        return [f'{method} {target}' for method, target, _body in self.requests]

    # -- 默认响应（队列空时） ------------------------------------------------

    def _command(self, status: str, body, **extra) -> dict:
        self.turn_seq += 1
        command = {
            'v': 1,
            'turn': f't-{self.turn_seq:04d}',
            'status': status,
            'writes': [],
            'bandWrites': [],
            'scene': None,
            'tone': None,
            'say': (body or {}).get('say') or '好的',
            'undoTurn': None,
            'danger': [],
            'confirmToken': None,
            'preview': [],
        }
        command.update(extra)
        return command

    def default_for(self, path: str, body):
        if path == '/apply':
            return 200, {
                'ok': True,
                'command': self._command('applied', body, undoTurn='t-0001'),
                'readback': {'params': {}, 'bands': []},
                'mismatch': [],
            }
        if path == '/undo':
            return 200, {
                'ok': True,
                'command': self._command('applied', None, say='已撤销'),
                'readback': {'params': {}, 'bands': []},
                'mismatch': [],
            }
        return 404, {'ok': False, 'error': {'code': 'E_NOT_FOUND', 'message': '没有这个端点'}}


class FakeAsr:
    """假 ASR：返回固定文本，记录被喂了几次。"""

    def __init__(self, text: str = '') -> None:
        self.text = text
        self.calls = 0
        self.audio = []

    def transcribe(self, wav_bytes: bytes) -> str:
        self.calls += 1
        self.audio.append(wav_bytes)
        return self.text


class FakeLlm:
    def __init__(self, *, available: bool = True, warmup_error: Exception | None = None,
                 plan_result=None) -> None:
        self._available = available
        self._warmup_error = warmup_error
        self._plan_result = plan_result
        self.available_calls = 0
        self.warmup_calls = 0
        self.plan_calls: list[tuple[str, object]] = []

    def available(self) -> bool:
        self.available_calls += 1
        return self._available

    def warmup(self) -> None:
        self.warmup_calls += 1
        if self._warmup_error is not None:
            raise self._warmup_error

    def plan(self, text, state=None):
        self.plan_calls.append((text, state))
        return self._plan_result


class RecordingSpeaker:
    """记录播报内容，并假装播了 `ms` 毫秒（用来验半双工收尾）。"""

    def __init__(self, ms: float = 120.0) -> None:
        self.ms = ms
        self.said: list[str] = []
        self.enabled = True
        self.tts_disabled = False

    def say(self, text: str) -> float:
        self.said.append(text)
        return self.ms

    def close(self) -> None:
        return


class RecordingParser:
    """包一层真 parser：既能计数（证明"撤销不调意图层"），又能跑真规则。"""

    def __init__(self) -> None:
        self.parse_calls = 0
        self.control_calls = 0

    def load_targets(self):
        return pipeline_mod.parser_module.load_targets()

    def parse(self, text, **kwargs):
        self.parse_calls += 1
        return pipeline_mod.parser_module.parse(text, **kwargs)

    def parse_control(self, text, **kwargs):
        self.control_calls += 1
        return pipeline_mod.parser_module.parse_control(text, **kwargs)


class FakeStream:
    """`AudioStream` 的替身：只实现半双工收尾用到的那部分。"""

    is_replay = False
    rate = 16000

    def __init__(self, samples: int) -> None:
        self.remaining = int(samples)
        self.reads = 0

    def read(self, frames: int = 512, timeout_s=None):
        self.reads += 1
        if self.remaining <= 0:
            return np.zeros(0, dtype=np.float32)
        size = min(int(frames), self.remaining)
        self.remaining -= size
        return np.ones(size, dtype=np.float32)


class FakeSpotter:
    def __init__(self) -> None:
        self.resets = 0

    def reset(self) -> None:
        self.resets += 1


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return int(probe.getsockname()[1])


# ---------------------------------------------------------------------------
# 测试基类
# ---------------------------------------------------------------------------


class PipelineTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.executor = FakeExecutor()
        self.addCleanup(self.executor.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log_dir = os.path.join(self.tmp.name, 'logs')
        self.wav_dir = os.path.join(self.tmp.name, 'wav')

    def make_pipeline(self, *, speaker=None, asr=None, llm=None, parser_mod=None,
                      options=None, **kwargs) -> pipeline_mod.Pipeline:
        options = options or pipeline_mod.Options(no_tts=True)
        return pipeline_mod.Pipeline(
            options,
            asr=asr,
            llm=llm,
            parser_mod=parser_mod,
            speaker=speaker if speaker is not None else Speaker(enabled=False),
            executor=self.executor,
            log_dir=self.log_dir,
            wav_dir=self.wav_dir,
            mem_mb=lambda: 123,
            **kwargs,
        )

    def log_records(self) -> list[dict]:
        lines: list[dict] = []
        for path in sorted(Path(self.log_dir).glob('turn-*.jsonl')):
            for line in path.read_text(encoding='utf-8').splitlines():
                if line.strip():
                    lines.append(json.loads(line))
        return lines


# ---------------------------------------------------------------------------
# 任务书 §6 的 8 条
# ---------------------------------------------------------------------------


class PipelineContractTest(PipelineTestBase):
    # 1. --text "声音亮一点" → 规则层，ops[0].target == 'brightness'，日志 route='rule'
    def test_1_text_rule_layer_hits_brightness(self) -> None:
        parser = RecordingParser()
        pipeline = self.make_pipeline(parser_mod=parser)
        response = pipeline.run_turn(text='声音亮一点')

        self.assertIsNotNone(response)
        bodies = self.executor.posts('/apply')
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]['ops'][0]['target'], 'brightness')
        self.assertEqual(bodies[0]['ops'][0]['kind'], 'tune')
        self.assertEqual(parser.parse_calls, 1)

        record = pipeline.last_record
        self.assertEqual(record['route'], 'rule')
        self.assertEqual(record['turn'], response['command']['turn'])
        self.assertIs(record['readback_ok'], True)
        self.assertEqual(record['mismatch'], [])
        # --text 模式不许混进音频耗时（任务书 §8）
        self.assertIsNone(record['audio_ms'])
        self.assertIsNone(record['wake_ms'])
        self.assertEqual(record['sink'], 'dry')
        self.assertEqual(record['mem_mb'], 123)
        self.assertIsInstance(record['total_ms'], float)

    # 2. --text "放首歌" → 规则层不命中 → 兜底 unsupported，route='fallback'
    def test_2_text_unsupported_falls_back(self) -> None:
        pipeline = self.make_pipeline()
        pipeline.run_turn(text='放首歌')
        bodies = self.executor.posts('/apply')
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]['status'], 'unsupported')
        self.assertEqual(bodies[0]['ops'], [])
        record = pipeline.last_record
        self.assertEqual(record['route'], 'fallback')
        self.assertEqual(record['llm_ms'], 0.0)
        # LLM 没起时按设计文档 §3.9 追加一句提示
        self.assertIn('模型没起来', record['plan']['say'])

    # 3. needs_confirm → 存 pending；下一句"确认"带 token 重提交
    def test_3_needs_confirm_then_confirm_with_token(self) -> None:
        pipeline = self.make_pipeline()
        self.executor.push(200, {
            'ok': True,
            'command': {
                'v': 1, 'turn': 't-0007', 'status': 'needs_confirm', 'writes': [],
                'bandWrites': [], 'scene': None, 'tone': None,
                'say': '会把麦克风静音，确认吗', 'undoTurn': None, 'danger': [],
                'confirmToken': 'tok-abc', 'preview': ['静音'],
            },
            'readback': {'params': {}, 'bands': []},
            'mismatch': [],
        })
        pipeline.run_turn(text='静音')
        self.assertIsNotNone(pipeline.pending)
        plan, token = pipeline.pending
        self.assertEqual(token, 'tok-abc')
        self.assertEqual(pipeline.last_record['command']['status'], 'needs_confirm')
        self.assertIsNone(pipeline.last_record['readback_ok'])

        pipeline.run_turn(text='确认')
        bodies = self.executor.posts('/apply')
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[1]['confirmToken'], 'tok-abc')
        self.assertEqual(bodies[1]['ops'], bodies[0]['ops'])  # 同一份 plan 重提交
        self.assertEqual(pipeline.last_record['route'], 'control')
        self.assertIsNone(pipeline.pending)

    # 4. 409 E_CONFIRM_EXPIRED → pending 清空，话术含"超时"
    def test_4_confirm_expired_clears_pending(self) -> None:
        speaker = RecordingSpeaker()
        pipeline = self.make_pipeline(speaker=speaker)
        self.executor.push(200, {
            'ok': True,
            'command': {
                'v': 1, 'turn': 't-0008', 'status': 'needs_confirm', 'writes': [],
                'bandWrites': [], 'scene': None, 'tone': None, 'say': '确认吗',
                'undoTurn': None, 'danger': [], 'confirmToken': 'tok-x', 'preview': [],
            },
            'readback': {'params': {}, 'bands': []},
            'mismatch': [],
        })
        pipeline.run_turn(text='静音')
        self.assertIsNotNone(pipeline.pending)

        self.executor.push(409, {
            'ok': False,
            'error': {'code': 'E_CONFIRM_EXPIRED', 'message': '确认超时，请再说一次'},
        })
        pipeline.run_turn(text='确认')
        self.assertIsNone(pipeline.pending)
        self.assertEqual(pipeline.last_record['error'], 'E_CONFIRM_EXPIRED')
        self.assertEqual(speaker.said[-1], '确认超时，请再说一次')
        self.assertIn('超时', speaker.said[-1])

    # 5. --text "撤销" → 打 /undo，不调 parser/llm
    def test_5_undo_goes_to_undo_endpoint(self) -> None:
        parser = RecordingParser()
        llm = FakeLlm()
        pipeline = self.make_pipeline(parser_mod=parser, llm=llm)
        pipeline.llm_available = True
        pipeline.run_turn(text='撤销')

        self.assertIn('POST /undo', self.executor.paths())
        self.assertNotIn('POST /apply', self.executor.paths())
        self.assertEqual(self.executor.posts('/undo'), [{}])
        self.assertEqual(parser.parse_calls, 0)
        self.assertEqual(llm.plan_calls, [])
        self.assertEqual(pipeline.last_record['route'], 'control')
        self.assertIs(pipeline.last_record['readback_ok'], True)

    # 6. ASR 返回空串 → 不调执行器，日志 route='empty'
    def test_6_empty_asr_skips_executor(self) -> None:
        speaker = RecordingSpeaker()
        asr = FakeAsr('')
        pipeline = self.make_pipeline(asr=asr, speaker=speaker)
        pipeline.listen = lambda: (b'RIFF-fake-wav', {'audio_ms': 2180.0, 'wake_ms': 120.0})

        response = pipeline.run_turn()
        self.assertIsNone(response)
        self.assertEqual(asr.calls, 1)
        self.assertEqual([path for path in self.executor.paths() if 'POST' in path], [])
        record = pipeline.last_record
        self.assertEqual(record['route'], 'empty')
        self.assertEqual(record['audio_ms'], 2180.0)
        self.assertEqual(record['wake_ms'], 120.0)
        self.assertEqual(record['plan'], None)
        self.assertEqual(speaker.said, ['没听清，请再说一次'])

    # 7. 日志行键集合 == 任务书 §4.4（含设计文档 §3.10 的 17 键 + total_ms）
    def test_7_turn_log_keys_complete(self) -> None:
        pipeline = self.make_pipeline()
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            pipeline.run_turn(text='声音亮一点')
        record = pipeline.last_record

        self.assertEqual(set(record), set(pipeline_mod.TURN_LOG_KEYS))
        self.assertEqual(len(pipeline_mod.TURN_LOG_KEYS), 18)
        self.assertTrue(DESIGN_KEYS.issubset(set(record)))

        files = sorted(Path(self.log_dir).glob('turn-*.jsonl'))
        self.assertEqual(len(files), 1)
        lines = files[0].read_text(encoding='utf-8').splitlines()
        self.assertEqual(len(lines), 1)
        logged = json.loads(lines[0])
        self.assertEqual(set(logged), set(record))
        # stdout 只有一行 JSON（5.3 的 eval 逐条读它）
        printed = [line for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(printed), 1)
        self.assertEqual(json.loads(printed[0])['turn'], record['turn'])

    # 8. Speaker(enabled=False).say() 返回 0 且不起子进程
    def test_8_disabled_speaker_does_not_spawn(self) -> None:
        speaker = Speaker(enabled=False)
        calls: list[list[str]] = []

        def boom(*args, **kwargs):  # noqa: ANN002, ANN003
            calls.append(list(args))
            raise AssertionError('不应该起子进程')

        original = tts_mod.subprocess.run
        tts_mod.subprocess.run = boom
        try:
            self.assertEqual(speaker.say('把声音调亮一点'), 0.0)
        finally:
            tts_mod.subprocess.run = original
        self.assertEqual(calls, [])
        self.assertEqual(speaker.calls, 0)
        self.assertTrue(speaker.tts_disabled)


# ---------------------------------------------------------------------------
# 边界与降级
# ---------------------------------------------------------------------------


class PipelineRobustnessTest(PipelineTestBase):
    def test_5xx_retries_once_then_succeeds(self) -> None:
        pipeline = self.make_pipeline()
        self.executor.push(500, {'ok': False, 'error': {'code': 'E_INTERNAL', 'message': '炸了'}})
        pipeline.run_turn(text='声音亮一点')
        self.assertEqual(len(self.executor.posts('/apply')), 2)
        self.assertNotIn('error', pipeline.last_record)  # 重试成功后与正常一轮完全一致
        self.assertEqual(pipeline.last_record['command']['status'], 'applied')

    def test_5xx_twice_reports_executor_down_and_logs_error(self) -> None:
        speaker = RecordingSpeaker()
        pipeline = self.make_pipeline(speaker=speaker)
        for _ in range(2):
            self.executor.push(500, {'ok': False, 'error': {'code': 'E_INTERNAL', 'message': '炸了'}})
        response = pipeline.run_turn(text='声音亮一点')
        self.assertIsNone(response)
        self.assertEqual(len(self.executor.posts('/apply')), 2)  # 只重试 1 次
        self.assertEqual(pipeline.last_record['error'], 'E_INTERNAL')
        self.assertIs(pipeline.last_record['readback_ok'], False)
        self.assertEqual(speaker.said[-1], '底层没起来')

    def test_unreachable_executor_degrades_without_raising(self) -> None:
        speaker = RecordingSpeaker()
        options = pipeline_mod.Options(no_tts=True, executor=f'http://127.0.0.1:{_free_port()}')
        pipeline = pipeline_mod.Pipeline(
            options,
            speaker=speaker,
            log_dir=self.log_dir,
            wav_dir=self.wav_dir,
            mem_mb=lambda: 1,
        )
        response = pipeline.run_turn(text='声音亮一点')
        self.assertIsNone(response)
        self.assertEqual(pipeline.last_record['error'], 'E_EXECUTOR_UNREACHABLE')
        self.assertEqual(speaker.said[-1], '底层没起来')

    def test_prepare_returns_exit_5_when_executor_is_down(self) -> None:
        options = pipeline_mod.Options(no_tts=True, executor=f'http://127.0.0.1:{_free_port()}')
        pipeline = pipeline_mod.Pipeline(
            options, speaker=Speaker(enabled=False), log_dir=self.log_dir, wav_dir=self.wav_dir,
            mem_mb=lambda: 1,
        )
        stderr = io.StringIO()
        original = sys.stderr
        sys.stderr = stderr
        try:
            code = pipeline.prepare()
        finally:
            sys.stderr = original
        self.assertEqual(code, pipeline_mod.EXIT_EXECUTOR)
        self.assertIn('执行器没起来', stderr.getvalue())

    def test_prepare_warms_up_llm_before_first_turn(self) -> None:
        llm = FakeLlm()
        pipeline = self.make_pipeline(llm=llm)
        stderr = io.StringIO()
        original = sys.stderr
        sys.stderr = stderr
        try:
            code = pipeline.prepare()
        finally:
            sys.stderr = original
        self.assertIsNone(code)
        self.assertEqual(llm.available_calls, 1)
        self.assertEqual(llm.warmup_calls, 1)  # 启动必须先预热（3.3 冷启动 8.49 s）
        self.assertTrue(pipeline.llm_available)
        self.assertIn('预热完成', stderr.getvalue())

    def test_warmup_failure_degrades_instead_of_exiting(self) -> None:
        llm = FakeLlm(warmup_error=pipeline_mod.llm_module.LlmUnavailable('prefill 超时'))
        pipeline = self.make_pipeline(llm=llm)
        stderr = io.StringIO()
        original = sys.stderr
        sys.stderr = stderr
        try:
            code = pipeline.prepare()
        finally:
            sys.stderr = original
        self.assertIsNone(code)  # 不退出，降级
        self.assertFalse(pipeline.llm_available)
        self.assertIn('预热失败', stderr.getvalue())

    def test_llm_route_used_when_rule_layer_misses(self) -> None:
        llm = FakeLlm(plan_result={
            'v': 1, 'status': 'ok', 'say': '把闷的地方收一收', 'confidence': 1,
            'ops': [{'kind': 'tune', 'target': 'muddiness', 'direction': 'less',
                     'strength': 'slight'}],
        })
        pipeline = self.make_pipeline(llm=llm)
        pipeline.llm_available = True
        pipeline.run_turn(text='这句话规则层不认识')
        record = pipeline.last_record
        self.assertEqual(record['route'], 'llm')
        self.assertEqual(len(llm.plan_calls), 1)
        self.assertEqual(llm.plan_calls[0][0], '这句话规则层不认识')
        self.assertEqual(llm.plan_calls[0][1], {'enc.Level': 1, 'eq.band7.gain': 0})
        self.assertIsInstance(record['llm_ms'], float)

    def test_log_write_failure_does_not_break_business(self) -> None:
        blocked = os.path.join(self.tmp.name, 'not-a-dir')
        Path(blocked).write_text('x', encoding='utf-8')
        pipeline = self.make_pipeline()
        pipeline.log_dir = blocked
        stderr = io.StringIO()
        original = sys.stderr
        sys.stderr = stderr
        try:
            response = pipeline.run_turn(text='声音亮一点')
        finally:
            sys.stderr = original
        self.assertIsNotNone(response)
        self.assertEqual(response['command']['status'], 'applied')
        self.assertIn('日志写盘失败', stderr.getvalue())

    def test_half_duplex_discards_frames_and_resets_wake(self) -> None:
        speaker = RecordingSpeaker(ms=180.0)
        pipeline = self.make_pipeline(speaker=speaker)
        pipeline.stream = FakeStream(samples=pipeline_mod.FRAME * 3 + 100)
        pipeline.spotter = FakeSpotter()

        elapsed = pipeline.say('把声音调亮一点')
        self.assertEqual(elapsed, 180.0)
        self.assertEqual(pipeline.stream.remaining, 0)  # 播报期间累积的帧被丢掉
        self.assertEqual(pipeline.spotter.resets, 1)  # 播完复位唤醒词缓冲

    def test_half_duplex_noop_for_disabled_tts_and_replay(self) -> None:
        pipeline = self.make_pipeline(speaker=Speaker(enabled=False))
        pipeline.stream = FakeStream(samples=4096)
        pipeline.spotter = FakeSpotter()
        self.assertEqual(pipeline.say('x'), 0.0)
        self.assertEqual(pipeline.stream.remaining, 4096)  # --no-tts：半双工自然失效
        self.assertEqual(pipeline.spotter.resets, 0)

        replay_stream = FakeStream(samples=4096)
        replay_stream.is_replay = True
        pipeline.stream = replay_stream
        self.assertEqual(pipeline.discard_pending_audio(), 0)
        self.assertEqual(replay_stream.reads, 0)

    def test_conflicting_flags_exit_2(self) -> None:
        args = pipeline_mod.build_parser().parse_args(['--text', '你好', '--wav', 'x.wav'])
        options, code = pipeline_mod.options_from_args(args)
        self.assertIsNone(options)
        self.assertEqual(code, pipeline_mod.EXIT_ARGS)

        args = pipeline_mod.build_parser().parse_args(['--once'])
        options, code = pipeline_mod.options_from_args(args)
        self.assertIsNone(options)
        self.assertEqual(code, pipeline_mod.EXIT_ARGS)


class SpeakerContractTest(unittest.TestCase):
    def test_script_quotes_text_and_uses_subprocess_list(self) -> None:
        script = tts_mod.build_script("说个'引号'", 'Microsoft Huihui Desktop')
        self.assertIn("$s.Speak('说个''引号''')", script)
        self.assertIn("$s.SelectVoice('Microsoft Huihui Desktop')", script)
        self.assertIn('exit 3', script)  # Speak 失败必须给非 0 退出码

    def test_say_uses_subprocess_run_with_list_args(self) -> None:
        speaker = Speaker(voice='Microsoft Huihui Desktop')
        recorded: list[list[str]] = []

        class _Done:
            returncode = 0
            stdout = ''
            stderr = ''

        original = tts_mod.subprocess.run
        tts_mod.subprocess.run = lambda command, **kwargs: (
            recorded.append(list(command)) or _Done()
        )
        try:
            elapsed = speaker.say('你好')
        finally:
            tts_mod.subprocess.run = original
        self.assertGreaterEqual(elapsed, 0.0)
        self.assertEqual(len(recorded), 1)
        command = recorded[0]
        self.assertIsInstance(command, list)
        self.assertIn('-Command', command)
        self.assertIn("$s.Speak('你好')", command[-1])
        source = (VOICE_DIR / 'tts.py').read_text(encoding='utf-8')
        self.assertNotIn('os.system', source)
        self.assertNotIn('shell=True', source)

    def test_failure_only_warns_and_disables(self) -> None:
        speaker = Speaker()
        spawned: list[int] = []

        class _Fail:
            returncode = 3
            stdout = ''
            stderr = 'E_TTS: 系统上未安装语音'

        def fake_run(command, **kwargs):  # noqa: ANN001, ANN003
            spawned.append(1)
            return _Fail()

        original = tts_mod.subprocess.run
        tts_mod.subprocess.run = fake_run
        stderr = io.StringIO()
        original_err = sys.stderr
        sys.stderr = stderr
        try:
            self.assertEqual(speaker.say('你好'), 0.0)
            self.assertEqual(speaker.say('再来一次'), 0.0)
        finally:
            tts_mod.subprocess.run = original
            sys.stderr = original_err
        self.assertEqual(len(spawned), 1)  # 第一次失败后不再重试
        self.assertTrue(speaker.tts_disabled)
        self.assertIn('播报不可用', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
