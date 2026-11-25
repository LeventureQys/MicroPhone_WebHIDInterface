"""SubStage 3.3 单元测试：LLM 意图兜底层（`tools/voice/llm.py`）。

全部离线：用 `http.server` 起一个 **stub llama-server**（可编程返回体、记录请求体），
不依赖真模型、不占 8768。任务书 §6 的 8 条在类 `PlanClientContractTest` 里逐条对应，
后面几个类是边界与错误处置（§5）。

运行：`python -m unittest discover -s tools/voice/test -p "test_llm.py"`
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.voice import llm as vl

_TUNE_PLAN = {
    "v": 1,
    "status": "ok",
    "say": "把闷的地方收一收",
    "confidence": 1,
    "ops": [{"kind": "tune", "target": "muddiness", "direction": "less", "strength": "slight"}],
}


def _openai_response(content: str, *, finish_reason: str = "stop", prompt_n: int = 4, predicted_n: int = 21):
    return {
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish_reason}
        ],
        "usage": {"prompt_tokens": 1000, "completion_tokens": predicted_n, "total_tokens": 1000 + predicted_n},
        "timings": {"prompt_n": prompt_n, "predicted_n": predicted_n},
    }


class StubServer:
    """可编程的 llama-server 替身。

    `queue` 里每一项是 `(status, content, kwargs)`：`content` 是 dict 时按 JSON 序列化，
    是 str 时原样塞进 `choices[0].message.content`；队列空了就用默认的合法计划。
    """

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict | None]] = []
        self.queue: list[tuple[int, object, dict]] = []
        self.health_status = 200
        self.default_plan: dict = _TUNE_PLAN
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args) -> None:  # 静音
                return

            def _send(self, status: int, payload: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:  # noqa: N802 - http.server 约定
                stub.requests.append(("GET", self.path, None))
                if self.path != vl.HEALTH_PATH:
                    self._send(404, b'{"error":"not found"}')
                    return
                if stub.health_status == 200:
                    self._send(200, b'{"status":"ok"}')
                else:
                    self._send(stub.health_status, b'{"error":"loading model"}')

            def do_POST(self) -> None:  # noqa: N802 - http.server 约定
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode("utf-8")) if raw else None
                except json.JSONDecodeError:
                    body = None
                stub.requests.append(("POST", self.path, body))
                if self.path != vl.CHAT_PATH:
                    self._send(404, b'{"error":"not found"}')
                    return
                if stub.queue:
                    status, content, kwargs = stub.queue.pop(0)
                else:
                    status, content, kwargs = 200, stub.default_plan, {}
                if status != 200:
                    self._send(status, b'{"error":"stub failure"}')
                    return
                text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                self._send(200, json.dumps(_openai_response(text, **kwargs), ensure_ascii=False).encode("utf-8"))

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> "StubServer":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def chat_requests(self) -> list[dict]:
        return [body for method, path, body in self.requests if method == "POST" and path == vl.CHAT_PATH]


def _client(stub: StubServer | None = None, **kwargs) -> vl.PlanClient:
    base_url = stub.base_url if stub is not None else "http://127.0.0.1:9"
    return vl.PlanClient(base_url=base_url, **kwargs)


class PlanClientContractTest(unittest.TestCase):
    """任务书 §6 的 8 条。"""

    def setUp(self) -> None:
        self.stub = StubServer().start()
        self.addCleanup(self.stub.stop)

    # 1
    def test_available_true_with_stub_and_false_without_service(self) -> None:
        self.assertTrue(_client(self.stub).available())
        dead = _client()  # 127.0.0.1:9 没有监听
        self.assertFalse(dead.available())  # 契约：不抛

    # 2
    def test_plan_returns_validated_dict(self) -> None:
        client = _client(self.stub)
        plan = client.plan("声音有点闷")
        self.assertIsInstance(plan, dict)
        self.assertEqual(set(plan), {"v", "status", "ops", "say", "confidence"})
        self.assertEqual(plan["ops"], _TUNE_PLAN["ops"])
        self.assertEqual(plan["say"], _TUNE_PLAN["say"])

    # 3
    def test_plan_rejects_empty_ops_when_status_ok(self) -> None:
        self.stub.queue.append((200, {"v": 1, "status": "ok", "ops": [], "say": "好的", "confidence": 1}, {}))
        self.assertIsNone(_client(self.stub).plan("随便说点什么"))

    # 4
    def test_plan_rejects_out_of_whitelist_target(self) -> None:
        bad = dict(_TUNE_PLAN)
        bad["ops"] = [{"kind": "tune", "target": "loudnesss", "direction": "more", "strength": "medium"}]
        self.stub.queue.append((200, bad, {}))
        self.assertIsNone(_client(self.stub).plan("声音大一点"))

    # 5
    def test_plan_rejects_truncated_output(self) -> None:
        self.stub.queue.append((200, _TUNE_PLAN, {"finish_reason": "length"}))
        self.assertIsNone(_client(self.stub).plan("声音有点闷"))

    # 6
    def test_plan_truncates_long_say_to_30_chars(self) -> None:
        long_say = "这是一句故意写得很长很长的播报话术用来验证截断行为到底是否真的生效一共四十个字整"
        self.assertEqual(len(long_say), 40)
        self.stub.queue.append((200, {**_TUNE_PLAN, "say": long_say}, {}))
        plan = _client(self.stub).plan("声音有点闷")
        self.assertIsNotNone(plan)
        self.assertEqual(len(plan["say"]), vl.MAX_SAY_CHARS)
        self.assertEqual(plan["say"], long_say[: vl.MAX_SAY_CHARS])

    # 7
    def test_system_message_is_byte_stable_across_calls(self) -> None:
        client = _client(self.stub)
        client.plan("第一句")
        client.plan("第二句")
        bodies = self.stub.chat_requests()
        self.assertEqual(len(bodies), 2)
        first = bodies[0]["messages"][0]["content"]
        second = bodies[1]["messages"][0]["content"]
        self.assertEqual(first, second)
        self.assertEqual(first, client.system_message)
        # 另起一个客户端重建系统消息，逐字节相同（没有时间戳/随机数/参数快照混进来）
        rebuilt = _client(self.stub).system_message
        self.assertEqual(first, rebuilt)
        self.assertEqual(len(client.fewshots), 5)
        self.assertIn("参考示例", first)
        self.assertTrue(first.startswith(Path(client.system_prompt_path).read_text(encoding="utf-8").rstrip("\n")))

    # 8
    def test_state_snapshot_only_in_user_message(self) -> None:
        client = _client(self.stub)
        client.plan("声音亮一点", {"enc.Level": 3, "eq.band6.gain": 4.5})
        body = self.stub.chat_requests()[0]
        system_text = body["messages"][0]["content"]
        user_text = body["messages"][1]["content"]
        self.assertNotIn("当前：", system_text)
        self.assertNotIn("降噪档位=3", system_text)
        self.assertTrue(user_text.startswith("当前：降噪档位=3"))
        self.assertIn("增益=[0,0,0,0,0,4.5,0]dB", user_text)
        self.assertTrue(user_text.endswith("\n声音亮一点"))


class RequestBodyTest(unittest.TestCase):
    """请求体逐字段固定（任务书 §4.2）。"""

    def setUp(self) -> None:
        self.stub = StubServer().start()
        self.addCleanup(self.stub.stop)

    def test_request_body_matches_contract(self) -> None:
        client = _client(self.stub)
        client.plan("声音有点闷")
        body = self.stub.chat_requests()[0]
        self.assertEqual(body["model"], "local")
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["top_k"], 1)
        self.assertEqual(body["max_tokens"], 96)
        self.assertFalse(body["stream"])
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        fmt = body["response_format"]
        self.assertEqual(fmt["type"], "json_schema")
        self.assertEqual(fmt["json_schema"]["name"], "voice_plan")
        self.assertTrue(fmt["json_schema"]["strict"])
        self.assertEqual(fmt["json_schema"]["schema"], client.schema)

    def test_default_snapshot_line_matches_contract(self) -> None:
        expected = (
            "当前：降噪档位=1，压缩阈值=-18dB，限制器阈值=-2.0dB，噪声门阈值=-41dB，"
            "增益=[0,0,0,0,0,0,0]dB"
        )
        self.assertEqual(vl.snapshot_line(), expected)

    def test_warmup_uses_small_budget_and_no_response_format(self) -> None:
        _client(self.stub).warmup()
        body = self.stub.chat_requests()[0]
        self.assertNotIn("response_format", body)
        self.assertEqual(body["max_tokens"], 8)


class FailureHandlingTest(unittest.TestCase):
    """任务书 §5 的错误处置。"""

    def setUp(self) -> None:
        self.stub = StubServer().start()
        self.addCleanup(self.stub.stop)

    def test_missing_schema_raises_file_not_found(self) -> None:
        with self.assertRaises(FileNotFoundError):
            _client(self.stub, schema_path="tools/voice/schema/does-not-exist.json")

    def test_unreachable_service_raises_llm_unavailable(self) -> None:
        dead = _client()
        with self.assertRaises(vl.LlmUnavailable):
            dead.plan("声音有点闷")
        with self.assertRaises(vl.LlmUnavailable):
            dead.warmup()

    def test_http_5xx_raises_with_status_code(self) -> None:
        self.stub.queue.append((500, "", {}))
        with self.assertRaises(vl.LlmUnavailable) as ctx:
            _client(self.stub, max_tokens=96).plan("声音有点闷")
        self.assertIn("500", str(ctx.exception))

    def test_non_json_content_returns_none(self) -> None:
        self.stub.queue.append((200, "抱歉，我不太明白", {}))
        self.assertIsNone(_client(self.stub).plan("声音有点闷"))

    def test_clarify_without_question_is_rejected(self) -> None:
        self.stub.queue.append((200, {"v": 1, "status": "clarify", "ops": [], "say": "", "confidence": 0.25}, {}))
        self.assertIsNone(_client(self.stub).plan("帮我调一下"))

    def test_extra_field_is_rejected(self) -> None:
        self.stub.queue.append((200, {**_TUNE_PLAN, "text": "声音有点闷"}, {}))
        self.assertIsNone(_client(self.stub).plan("声音有点闷"))

    def test_empty_question_on_ok_is_normalized_away(self) -> None:
        # 1.7B 会在末尾惯性补一个 "question":""；空串无语义，丢弃后键集合仍严格等于五键。
        self.stub.queue.append((200, {**_TUNE_PLAN, "question": ""}, {}))
        plan = _client(self.stub).plan("声音有点闷")
        self.assertIsNotNone(plan)
        self.assertEqual(set(plan), {"v", "status", "ops", "say", "confidence"})

    def test_question_outside_clarify_is_normalized_away(self) -> None:
        # 模型也会把用户原话抄进 question；status 才是权威，多余字段丢弃并记 warn。
        self.stub.queue.append(
            (
                200,
                {
                    "v": 1,
                    "status": "unsupported",
                    "ops": [],
                    "say": "我只管调麦克风音色",
                    "confidence": 1,
                    "question": "今天天气怎么样",
                },
                {},
            )
        )
        plan = _client(self.stub).plan("今天天气怎么样")
        self.assertIsNotNone(plan)
        self.assertEqual(set(plan), {"v", "status", "ops", "say", "confidence"})
        self.assertEqual(plan["status"], "unsupported")

    def test_low_confidence_ok_is_returned_untouched(self) -> None:
        self.stub.queue.append((200, {**_TUNE_PLAN, "confidence": 0.25}, {}))
        plan = _client(self.stub).plan("声音有点闷")
        self.assertIsNotNone(plan)
        self.assertEqual(plan["confidence"], 0.25)

    def test_truncation_probe_reports_none(self) -> None:
        self.stub.queue.append((200, _TUNE_PLAN, {"finish_reason": "length"}))
        record = vl.run_truncation_probe(_client(self.stub))
        self.assertTrue(record["returnedNone"])
        self.assertIsNone(record["raised"])
        self.assertEqual(record["finishReason"], "length")


class ContractAssetTest(unittest.TestCase):
    """提示词与 schema 的静态判据。"""

    def setUp(self) -> None:
        self.client = vl.PlanClient()

    def test_prompt_names_every_enum_value(self) -> None:
        self.assertEqual(
            vl.prompt_coverage(self.client),
            {"tune": [], "toggle": [], "scene": [], "tone": []},
        )

    def test_prompt_has_three_hard_rules_and_say_limit(self) -> None:
        text = self.client.system_message
        self.assertIn("三条硬规则", text)
        self.assertIn("30 个字", text)
        self.assertIn("unsupported", text)
        self.assertIn("clarify", text)

    def test_schema_has_no_dynamic_keywords(self) -> None:
        raw = json.dumps(self.client.schema, ensure_ascii=False)
        for token in ('"$ref"', '"pattern"', '"allOf"', '"format"'):
            self.assertNotIn(token, raw)

    def test_schema_validator_flags_broken_plan(self) -> None:
        self.assertEqual(vl.schema_errors(_TUNE_PLAN, self.client.schema), [])
        broken = {**_TUNE_PLAN, "ops": [{"kind": "tune", "target": "nope", "direction": "less", "strength": "slight"}]}
        self.assertTrue(vl.schema_errors(broken, self.client.schema))

    def test_validate_plan_requires_strength_for_eq(self) -> None:
        plan = {
            "v": 1,
            "status": "ok",
            "say": "第四段压一点",
            "confidence": 1,
            "ops": [{"kind": "eq", "band": 4, "direction": "less", "field": "gain"}],
        }
        checked, notes = vl.validate_plan(plan, whitelist=self.client.whitelist)
        self.assertIsNone(checked)
        self.assertTrue(notes)


if __name__ == "__main__":
    unittest.main()
