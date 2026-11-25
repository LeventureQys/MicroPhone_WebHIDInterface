"""LLM 意图兜底（Stage 3 / SubStage 3.3）。

规则层（`parser.py`，3.2）覆盖高频说法；覆盖不到的句子交给常驻的 1.7B。
本模块只做三件事：**调用**（硬编码的请求体 + 约束解码）、**本地校验**（契约守卫）、**取证**
（`--selftest` / `--cache-probe` / `--truncate-probe` 落 `artifacts/voice/*.json`）。

设计文档 §2.4 / §3.2 与本 SubStage 任务书给出的实测前提，全部按"别自己调"处理：

- 系统提示词必须**逐字节静态**：本模块在构造时把 `prompts/system.zh.txt` 与 5 条 few-shot
  拼成一份字符串后就再也不改，请求里永远原样复用。当前参数快照只进 user 消息，
  否则 llama.cpp 的前缀缓存失效，单轮从 ~1.5 s 涨到 ~4.6 s。
- `max_tokens=96`（典型 50–70）：约束解码只保证**未截断**时合法，所以 `finish_reason=="length"`
  必须判失败（返回 None），否则会把半截 JSON 当成计划。
- 本地校验先于一切：schema 只保证语法，枚举与字段集合由 `schema/targets.json` 与
  `contract/canonicalize.ts#validatePlan` 的既有判据守（clarify 必须带 question、eq 必须带 strength）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import socket
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://127.0.0.1:8768"
DEFAULT_SCHEMA_PATH = "tools/voice/schema/voice-plan.schema.json"
DEFAULT_TARGETS_PATH = "tools/voice/schema/targets.json"
DEFAULT_SYSTEM_PROMPT_PATH = "tools/voice/prompts/system.zh.txt"
DEFAULT_FEWSHOT_PATH = "tools/voice/prompts/fewshot.zh.jsonl"
SELFTEST_ARTIFACT = "artifacts/voice/selftest-33.json"
CACHE_PROBE_ARTIFACT = "artifacts/voice/cache-probe-33.json"

CHAT_PATH = "/v1/chat/completions"
HEALTH_PATH = "/health"
HEALTH_TIMEOUT_S = 0.3
# 首轮要把 ~1.3k token 的系统提示词灌进 KV（实测 pp 318 tok/s，冷页缓存时更慢）；
# 预热不在每轮路径上，给 30 s 上限，别让"冷启动"被当成服务挂了。
WARMUP_TIMEOUT_S = 30.0
WARMUP_MAX_TOKENS = 8
WARMUP_TEXT = "把声音调亮一点"

MAX_TOKENS = 96
MAX_SAY_CHARS = 30
MAX_OPS = 4
CONFIDENCE_VALUES = (0.0, 0.25, 0.5, 0.75, 1.0)
PLAN_KEYS = ("v", "status", "ops", "say", "confidence")
PLAN_STATUSES = ("ok", "clarify", "unsupported")

# 只放这 11 个值：够模型判断"再亮一点"的相对方向，又不给它可以复述的整表。
DEFAULT_SNAPSHOT: dict[str, int | float] = {
    "enc.Level": 1,
    "comp.Threshold": -18,
    "limit.Threshold": -2.0,
    "noisegate.threshold_db": -41,
    "eq.band1.gain": 0,
    "eq.band2.gain": 0,
    "eq.band3.gain": 0,
    "eq.band4.gain": 0,
    "eq.band5.gain": 0,
    "eq.band6.gain": 0,
    "eq.band7.gain": 0,
}

# 各 op 允许出现的字段集合（等于 schema 里 additionalProperties:false 的那一份）。
OP_KEYS: dict[str, frozenset[str]] = {
    "tune": frozenset({"kind", "target", "direction", "strength"}),
    "eq": frozenset({"kind", "band", "centerHz", "direction", "strength", "field"}),
    "toggle": frozenset({"kind", "target", "on"}),
    "set": frozenset({"kind", "param", "value"}),
    "scene": frozenset({"kind", "scene"}),
    "tone": frozenset({"kind", "tone"}),
    "undo": frozenset({"kind"}),
}

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[1]


class LlmUnavailable(RuntimeError):
    """服务不可达 / 超时 / 5xx：上层降级为"只走规则层"，本层不重试。"""


# ---------------------------------------------------------------------------
# 路径解析（与 parser.py 同款：默认相对路径按模块位置解析，显式路径原样使用）
# ---------------------------------------------------------------------------


def _resolve(path: str | Path, default_literal: str, module_relative: str) -> Path:
    if str(path) == default_literal:
        candidate = _HERE / module_relative
        if candidate.exists():
            return candidate
        return Path(path)
    return Path(path)


# ---------------------------------------------------------------------------
# 白名单（schema/targets.json，3.1 生成物，只读）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Whitelist:
    tune: tuple[str, ...]
    toggle: tuple[str, ...]
    param_ids: frozenset[str]
    scenes: tuple[str, ...]
    tones: tuple[str, ...]
    directions: tuple[str, ...]
    strengths: tuple[str, ...]


def load_whitelist(path: str | Path = DEFAULT_TARGETS_PATH) -> Whitelist:
    resolved = _resolve(path, DEFAULT_TARGETS_PATH, "schema/targets.json")
    return _load_whitelist_cached(str(resolved))


@lru_cache(maxsize=4)
def _load_whitelist_cached(resolved: str) -> Whitelist:
    raw = json.loads(Path(resolved).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{resolved} 顶层必须是对象")
    for key in ("tuneTargets", "toggleTargets", "paramIds"):
        if not key in raw:
            raise ValueError(f"{resolved} 缺少字段 {key}")
    return Whitelist(
        tune=tuple(str(v) for v in raw["tuneTargets"]),
        toggle=tuple(str(v) for v in raw["toggleTargets"]),
        param_ids=frozenset(str(v) for v in raw["paramIds"]),
        scenes=tuple(str(v) for v in raw.get("scenes") or ()),
        tones=tuple(str(v) for v in raw.get("tones") or ()),
        directions=tuple(str(v) for v in raw.get("directions") or ("more", "less")),
        strengths=tuple(str(v) for v in raw.get("strengths") or ("slight", "medium", "strong")),
    )


# ---------------------------------------------------------------------------
# 当前参数快照（只进 user 消息）
# ---------------------------------------------------------------------------


def _fmt_number(value: Any) -> str:
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.1f}" if abs(value - round(value, 1)) < 1e-9 else f"{value:g}"
    return str(value)


def snapshot_line(state: dict[str, Any] | None = None) -> str:
    """`plan()` 的 user 消息首行（字段顺序固定，缺省值见 DEFAULT_SNAPSHOT）。"""

    merged: dict[str, Any] = dict(DEFAULT_SNAPSHOT)
    if state:
        merged.update({str(k): v for k, v in state.items()})
    gains = ",".join(_fmt_number(merged[f"eq.band{i}.gain"]) for i in range(1, 8))
    return (
        f"当前：降噪档位={_fmt_number(merged['enc.Level'])}，"
        f"压缩阈值={_fmt_number(merged['comp.Threshold'])}dB，"
        f"限制器阈值={_fmt_number(merged['limit.Threshold'])}dB，"
        f"噪声门阈值={_fmt_number(merged['noisegate.threshold_db'])}dB，"
        f"增益=[{gains}]dB"
    )


# ---------------------------------------------------------------------------
# 提示词装载（系统消息构造一次，之后逐字节复用）
# ---------------------------------------------------------------------------


def _load_fewshots(path: Path) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            item = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{lineno} 不是合法 JSON：{exc}") from exc
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not isinstance(
            item.get("plan"), dict
        ):
            raise ValueError(f"{path}:{lineno} 需要 {{'text': str, 'plan': object}}")
        items.append(item)
    if not items:
        raise ValueError(f"{path} 一条 few-shot 都没有")
    return items


def compose_system_message(system_text: str, fewshots: list[dict[str, Any]]) -> str:
    """系统提示词 = `system.zh.txt` 全文 + few-shot 展开。**必须纯函数**（前缀缓存）。"""

    lines = [system_text.rstrip("\n"), "", "参考示例（用户原话 → 输出 JSON）："]
    for index, item in enumerate(fewshots, 1):
        lines.append(f"示例 {index}")
        lines.append(f"用户：{item['text']}")
        lines.append("输出：" + json.dumps(item["plan"], ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 本地校验
# ---------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_confidence(value: Any) -> bool:
    return _is_number(value) and float(value) in CONFIDENCE_VALUES


def _check_op(raw: Any, index: int, whitelist: Whitelist) -> str | None:
    if not isinstance(raw, dict):
        return f"ops[{index}] 不是对象"
    kind = raw.get("kind")
    if kind not in OP_KEYS:
        return f"ops[{index}].kind 非法：{kind!r}"
    allowed = OP_KEYS[str(kind)]
    extra = sorted(set(raw) - allowed)
    if extra:
        return f"ops[{index}] 出现不该有的字段 {extra}"
    if kind == "undo":
        return None
    if kind in ("tune", "toggle"):
        if "target" not in raw:
            return f"ops[{index}] 缺少 target"
        pool = whitelist.tune if kind == "tune" else whitelist.toggle
        if raw["target"] not in pool:
            return f"ops[{index}].target 越界：{raw['target']!r}"
    if kind == "tune":
        if raw.get("direction") not in whitelist.directions:
            return f"ops[{index}].direction 非法：{raw.get('direction')!r}"
        if raw.get("strength") not in whitelist.strengths:
            return f"ops[{index}].strength 非法：{raw.get('strength')!r}"
        return None
    if kind == "eq":
        has_band = "band" in raw
        has_hz = "centerHz" in raw
        if has_band == has_hz:
            return f"ops[{index}] 必须给 band 或 centerHz 二者之一"
        if has_band:
            band = raw["band"]
            if not isinstance(band, int) or isinstance(band, bool) or not 1 <= band <= 7:
                return f"ops[{index}].band 必须是 1..7 的整数，实际 {band!r}"
        else:
            hz = raw["centerHz"]
            if not _is_number(hz) or not 20 <= float(hz) <= 20000:
                return f"ops[{index}].centerHz 必须在 20..20000 之间，实际 {hz!r}"
        if raw.get("direction") not in whitelist.directions:
            return f"ops[{index}].direction 非法：{raw.get('direction')!r}"
        # eq 的 strength 在 schema 里是可选的，但 4.1 的 validatePlan 必读它，这里先挡住。
        if raw.get("strength") not in whitelist.strengths:
            return f"ops[{index}].strength 非法：{raw.get('strength')!r}"
        if raw.get("field") not in ("gain", "q", "freq"):
            return f"ops[{index}].field 非法：{raw.get('field')!r}"
        return None
    if kind == "toggle":
        if not isinstance(raw.get("on"), bool):
            return f"ops[{index}].on 必须是布尔"
        return None
    if kind == "set":
        if "param" not in raw:
            return f"ops[{index}] 缺少 param"
        if raw["param"] not in whitelist.param_ids:
            return f"ops[{index}].param 越界：{raw['param']!r}"
        if not _is_number(raw.get("value")):
            return f"ops[{index}].value 必须是有限数"
        return None
    if kind == "scene":
        if raw.get("scene") not in whitelist.scenes:
            return f"ops[{index}].scene 非法：{raw.get('scene')!r}"
        return None
    if kind == "tone":
        if raw.get("tone") not in whitelist.tones:
            return f"ops[{index}].tone 非法：{raw.get('tone')!r}"
        return None
    return None


def validate_plan(plan: Any, *, whitelist: Whitelist) -> tuple[dict[str, Any] | None, list[str]]:
    """校验并规整 L1。返回 `(plan|None, notes)`；`None` 时 `notes` 是失败原因。

    判据见任务书 §4.3；其中两条按 `contract/canonicalize.ts#validatePlan`（4.1 已落地）
    对齐，否则下游会硬失败：`clarify` 必须带非空 `question`、`eq` 必须带 `strength`。
    另有一处**归一化**：schema 把 `question` 声明成可选属性，1.7B 会在 `ok`/`unsupported`
    的输出末尾惯性补一个 `question`（空串，或把用户原话抄进去）。`question` 在非 `clarify`
    输出里没有任何语义（4.1 的 validatePlan 也只读它来判 clarify），所以这里丢弃并记 warn，
    保证**返回对象**的键集合严格等于 §4.3 规则 1 的形状；`clarify` 缺 question 仍然判非法。
    """

    if not isinstance(plan, dict):
        return None, ["顶层不是 JSON 对象"]
    notes: list[str] = []
    status = plan.get("status")
    if "question" in plan and status != "clarify":
        notes.append("丢弃多余的 question 字段（status 不是 clarify，该字段无语义）")
        plan = {key: value for key, value in plan.items() if key != "question"}
    allowed = set(PLAN_KEYS)
    if status == "clarify":
        allowed.add("question")
    missing = [key for key in PLAN_KEYS if key not in plan]
    if missing:
        return None, [f"缺少字段 {missing}"]
    extra = sorted(set(plan) - allowed)
    if extra:
        return None, [f"出现不该有的字段 {extra}"]
    if plan["v"] != 1 or isinstance(plan["v"], bool):
        return None, [f"v 必须是 1，实际 {plan['v']!r}"]
    if status not in PLAN_STATUSES:
        return None, [f"status 非法：{status!r}"]
    if status == "clarify":
        question = plan.get("question")
        if not isinstance(question, str) or not question.strip():
            return None, ["status=clarify 必须带非空 question"]
    ops = plan["ops"]
    if not isinstance(ops, list):
        return None, ["ops 必须是数组"]
    if len(ops) > MAX_OPS:
        return None, [f"ops 最多 {MAX_OPS} 项，实际 {len(ops)}"]
    if status == "ok" and not ops:
        return None, ["status=ok 但 ops 为空"]
    say = plan.get("say")
    if not isinstance(say, str):
        return None, ["say 必须是字符串"]
    confidence = plan.get("confidence")
    if not _is_confidence(confidence):
        return None, [f"confidence 必须是 0/0.25/0.5/0.75/1 之一，实际 {confidence!r}"]

    checked: list[dict[str, Any]] = []
    for index, op in enumerate(ops):
        problem = _check_op(op, index, whitelist)
        if problem:
            return None, [problem]
        checked.append(dict(op))

    if len(say) > MAX_SAY_CHARS:
        notes.append(f"say 超长（{len(say)} 字），已截断到 {MAX_SAY_CHARS} 字")
        say = say[:MAX_SAY_CHARS]

    out: dict[str, Any] = {
        "v": 1,
        "status": status,
        "ops": checked,
        "say": say,
        "confidence": confidence,
    }
    if status == "clarify" and isinstance(plan.get("question"), str):
        out["question"] = plan["question"]
    return out, notes


# ---------------------------------------------------------------------------
# JSON Schema 子集校验（只用于 `--selftest` 的独立取证，不参与 plan() 判定）
# ---------------------------------------------------------------------------

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


def _scalar_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    return left == right


def schema_errors(value: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """`schema/*.json` 只用了 type/enum/const/oneOf/properties/required/additionalProperties/items/minimum/maximum。"""

    errors: list[str] = []
    if "const" in schema and not _scalar_equal(value, schema["const"]):
        errors.append(f"{path} 应为常量 {schema['const']!r}")
    if "enum" in schema and not any(_scalar_equal(value, item) for item in schema["enum"]):
        errors.append(f"{path} 不在枚举内：{value!r}")
    expected = schema.get("type")
    if isinstance(expected, str) and expected in _TYPE_CHECKS and not _TYPE_CHECKS[expected](value):
        errors.append(f"{path} 类型应为 {expected}")
        return errors
    if isinstance(value, dict):
        for key in schema.get("required") or ():
            if key not in value:
                errors.append(f"{path}.{key} 缺失")
        properties = schema.get("properties") or {}
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{path}.{key} 不在 properties 里")
        for key, sub in properties.items():
            if key in value:
                errors.extend(schema_errors(value[key], sub, f"{path}.{key}"))
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            errors.extend(schema_errors(item, schema["items"], f"{path}[{index}]"))
    if _is_number(value):
        if "minimum" in schema and float(value) < float(schema["minimum"]):
            errors.append(f"{path} 小于 {schema['minimum']}")
        if "maximum" in schema and float(value) > float(schema["maximum"]):
            errors.append(f"{path} 大于 {schema['maximum']}")
    branches = schema.get("oneOf")
    if isinstance(branches, list):
        matched = 0
        branch_errors: list[list[str]] = []
        for branch in branches:
            found = schema_errors(value, branch, path)
            branch_errors.append(found)
            if not found:
                matched += 1
        if matched != 1:
            errors.append(f"{path} 命中 oneOf {matched} 个分支（要求恰好 1 个）")
            if matched == 0:
                errors.extend(branch_errors[0])
    return errors


# ---------------------------------------------------------------------------
# 客户端
# ---------------------------------------------------------------------------


@dataclass
class RequestStats:
    finish_reason: str | None = None
    prompt_n: int | None = None
    predicted_n: int | None = None
    cache_n: int | None = None
    usage: dict[str, Any] | None = None
    timings: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "finishReason": self.finish_reason,
            "promptN": self.prompt_n,
            "predictedN": self.predicted_n,
            "cacheN": self.cache_n,
            "usage": self.usage,
            "timings": self.timings,
        }


class PlanClient:
    """约束解码调用 + 本地校验。见任务书 §4.2。"""

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        schema_path: str = DEFAULT_SCHEMA_PATH,
        system_prompt_path: str = DEFAULT_SYSTEM_PROMPT_PATH,
        fewshot_path: str = DEFAULT_FEWSHOT_PATH,
        timeout_s: float = 8.0,
        max_tokens: int = MAX_TOKENS,
        targets_path: str = DEFAULT_TARGETS_PATH,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = float(timeout_s)
        self.max_tokens = int(max_tokens)

        self.schema_path = _resolve(schema_path, DEFAULT_SCHEMA_PATH, "schema/voice-plan.schema.json")
        # schema 缺失要在构造时炸（任务书 §5），所以直接 read_text，不做兜底。
        self.schema: dict[str, Any] = json.loads(Path(self.schema_path).read_text(encoding="utf-8"))

        self.system_prompt_path = _resolve(
            system_prompt_path, DEFAULT_SYSTEM_PROMPT_PATH, "prompts/system.zh.txt"
        )
        system_text = Path(self.system_prompt_path).read_text(encoding="utf-8")
        self.fewshot_path = _resolve(fewshot_path, DEFAULT_FEWSHOT_PATH, "prompts/fewshot.zh.jsonl")
        self.fewshots = _load_fewshots(self.fewshot_path)
        self.system_message = compose_system_message(system_text, self.fewshots)
        self.system_sha256 = hashlib.sha256(self.system_message.encode("utf-8")).hexdigest()
        self.whitelist = load_whitelist(targets_path)
        self.last_stats = RequestStats()

    # -- 请求体 -------------------------------------------------------------

    def build_messages(self, text: str, state: dict[str, Any] | None = None) -> list[dict[str, str]]:
        return [
            {"role": "system", "content": self.system_message},
            {"role": "user", "content": f"{snapshot_line(state)}\n{text}"},
        ]

    def build_request(self, text: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "model": "local",
            "messages": self.build_messages(text, state),
            "temperature": 0,
            "top_k": 1,
            "max_tokens": self.max_tokens,
            "stream": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "voice_plan", "strict": True, "schema": self.schema},
            },
        }

    # -- HTTP ---------------------------------------------------------------

    def _post_chat(self, body: dict[str, Any], timeout_s: float) -> tuple[dict[str, Any], float]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + CHAT_PATH,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"},
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read()[:200].decode("utf-8", "replace").strip()
            except OSError:
                detail = ""
            raise LlmUnavailable(f"HTTP {exc.code}{(' ' + detail) if detail else ''}") from exc
        except (socket.timeout, TimeoutError) as exc:
            raise LlmUnavailable("timeout") from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                raise LlmUnavailable("timeout") from exc
            raise LlmUnavailable(f"unreachable: {exc.reason}") from exc
        except OSError as exc:
            raise LlmUnavailable(f"unreachable: {exc}") from exc
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LlmUnavailable(f"响应不是合法 JSON：{exc}") from exc
        if not isinstance(payload, dict):
            raise LlmUnavailable("响应顶层不是对象")
        if "error" in payload and "choices" not in payload:
            raise LlmUnavailable(f"服务返回错误：{json.dumps(payload['error'], ensure_ascii=False)[:200]}")
        return payload, elapsed_ms

    # -- 契约方法 -----------------------------------------------------------

    def available(self) -> bool:
        """GET /health，300 ms 超时；任何异常都返回 False（不抛）。"""

        request = urllib.request.Request(self.base_url + HEALTH_PATH, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=HEALTH_TIMEOUT_S) as response:
                return int(response.status) == 200
        except Exception:  # noqa: BLE001 - 契约：这里任何异常都算"不可用"
            return False

    def warmup(self) -> None:
        """把系统提示词灌进前缀缓存。不带 response_format，只要 8 个 token。

        这次调用是**唯一**的冷 prefill（系统提示词 ~3k token，实测 285 tok/s 级别 → 数秒），
        所以统计也存进 `last_stats`：`--selftest` 拿它跟后续热请求的 prompt_n 对照，
        这就是"系统提示词必须逐字节静态"的可观测证据。
        """

        body = {
            "model": "local",
            "messages": self.build_messages(WARMUP_TEXT),
            "temperature": 0,
            "top_k": 1,
            "max_tokens": WARMUP_MAX_TOKENS,
            "stream": False,
        }
        payload, elapsed_ms = self._post_chat(body, WARMUP_TIMEOUT_S)
        stats = _stats_from(payload)
        stats.timings = {**(stats.timings or {}), "wallMs": round(elapsed_ms, 1)}
        self.last_stats = stats

    def plan(self, text: str, state: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """返回通过本地校验的 L1；服务不可达抛 LlmUnavailable；非法/越界/被截断返回 None。"""

        self.last_stats = RequestStats()
        if not isinstance(text, str) or not text.strip():
            LOGGER.warning("plan() 收到空文本，返回 None")
            return None
        payload, elapsed_ms = self._post_chat(self.build_request(text, state), self.timeout_s)
        stats = _stats_from(payload)
        stats.timings = {**(stats.timings or {}), "wallMs": round(elapsed_ms, 1)}
        self.last_stats = stats

        if stats.finish_reason == "length":
            LOGGER.warning(
                "输出被截断（finish_reason=length，max_tokens=%d），判为失败", self.max_tokens
            )
            return None
        content = _content_of(payload)
        if content is None:
            LOGGER.warning("响应里没有 choices[0].message.content")
            return None
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            LOGGER.warning("输出不是合法 JSON（%s）：%s", exc, content[:200])
            return None
        plan, notes = validate_plan(parsed, whitelist=self.whitelist)
        for note in notes:
            LOGGER.warning("%s", note)
        if plan is None:
            LOGGER.warning(
                "输出未通过本地校验（%s），原始前 200 字符：%s",
                "; ".join(notes),
                content[:200],
            )
        return plan

    def chat_once(self, text: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
        """给取证用：返回 `{plan, stats}`，`LlmUnavailable` 原样抛出。"""

        plan = self.plan(text, state)
        return {"plan": plan, "stats": self.last_stats.as_dict()}


def _content_of(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if not isinstance(content, str):
        return None
    if not content.strip():
        return ""
    return content


def _stats_from(payload: dict[str, Any]) -> RequestStats:
    choices = payload.get("choices") if isinstance(payload.get("choices"), list) else []
    finish = None
    if choices and isinstance(choices[0], dict):
        finish = choices[0].get("finish_reason")
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
    timings = payload.get("timings") if isinstance(payload.get("timings"), dict) else None
    prompt_n = timings.get("prompt_n") if timings else None
    predicted_n = timings.get("predicted_n") if timings else None
    cache_n = timings.get("cache_n") if timings else None
    if cache_n is None and isinstance(prompt_n, int) and usage and isinstance(usage.get("prompt_tokens"), int):
        # 前缀缓存的复用数 = 总 prompt token - 本次真正处理的 token。
        cache_n = max(0, int(usage["prompt_tokens"]) - int(prompt_n))
    if predicted_n is None and usage and isinstance(usage.get("completion_tokens"), int):
        predicted_n = int(usage["completion_tokens"])
    return RequestStats(
        finish_reason=str(finish) if finish is not None else None,
        prompt_n=int(prompt_n) if isinstance(prompt_n, int) else None,
        predicted_n=int(predicted_n) if isinstance(predicted_n, int) else None,
        cache_n=int(cache_n) if isinstance(cache_n, int) else None,
        usage=usage,
        timings=timings,
    )


def _percentile(values: list[float], percent: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(percent / 100.0 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


# ---------------------------------------------------------------------------
# 自检（§6 / §7）
# ---------------------------------------------------------------------------

# (id, 用户原话, 说明) —— 10 条自由描述，覆盖 tune / eq / toggle / set / scene / clarify / unsupported。
SELFTEST_CASES: tuple[tuple[int, str, str], ...] = (
    (1, "我感觉人声有点闷，帮我把中间那块收一收", "tune muddiness.less"),
    (2, "声音太亮了，有点刺耳朵，把高频压一压", "tune brightness/harshness.less"),
    (3, "低音太重了，轰得我难受，收一点", "tune lowEnd.less"),
    (4, "我马上要开始直播了，帮我切到适合直播的状态", "scene podcast"),
    (5, "把第六段提升三分贝", "set eq.band6.gain=3"),
    (6, "背景的底噪有点大，降噪再强一点", "tune noiseFloor.less"),
    (7, "帮我打开噪声门", "toggle gate on"),
    (8, "把灯效换成下一个", "tune rgbMode.more"),
    (9, "今天天气怎么样", "unsupported"),
    (10, "帮我调一下", "clarify"),
)

P95_LIMIT_S = 2.5
P95_LIMIT_MS = P95_LIMIT_S * 1000.0


def _brief(plan: Any) -> str:
    return json.dumps(plan, ensure_ascii=False, separators=(",", ":")) if plan is not None else "None"


def prompt_coverage(client: PlanClient) -> dict[str, list[str]]:
    """系统提示词里是否点到了全部枚举值（§4.4 的可执行检查）。"""

    text = client.system_message
    return {
        "tune": [t for t in client.whitelist.tune if t not in text],
        "toggle": [t for t in client.whitelist.toggle if t not in text],
        "scene": [s for s in client.whitelist.scenes if s not in text],
        "tone": [t for t in client.whitelist.tones if t not in text],
    }


def _warmup_record(client: PlanClient) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        client.warmup()
    except LlmUnavailable as exc:
        return {"ok": False, "elapsedMs": round((time.perf_counter() - started) * 1000.0, 1), "error": str(exc)}
    stats = client.last_stats
    return {
        "ok": True,
        "elapsedMs": round((time.perf_counter() - started) * 1000.0, 1),
        "error": None,
        "promptN": stats.prompt_n,
        "predictedN": stats.predicted_n,
        "cacheN": stats.cache_n,
        "finishReason": stats.finish_reason,
    }


def run_cache_probe(
    client: PlanClient,
    count: int,
    *,
    text: str = "能不能把低音再收一点",
    artifact_path: str | Path | None = None,
) -> dict[str, Any]:
    """连发 count 次同一条 plan()，看第 2 次起 prompt 处理 token 数（前缀缓存证据）。"""

    rows: list[dict[str, Any]] = []
    started_all = time.perf_counter()
    for index in range(1, count + 1):
        started = time.perf_counter()
        try:
            result = client.chat_once(text)
        except LlmUnavailable as exc:
            rows.append({"n": index, "ok": False, "error": str(exc), "elapsedMs": round((time.perf_counter() - started) * 1000.0, 1)})
            break
        rows.append(
            {
                "n": index,
                "ok": result["plan"] is not None,
                "elapsedMs": round((time.perf_counter() - started) * 1000.0, 1),
                "promptN": result["stats"]["promptN"],
                "predictedN": result["stats"]["predictedN"],
                "cacheN": result["stats"]["cacheN"],
                "finishReason": result["stats"]["finishReason"],
                "plan": result["plan"],
            }
        )
    ok_rows = [row for row in rows if "promptN" in row]
    first = ok_rows[0] if ok_rows else {}
    rest = ok_rows[1:]
    summary = {
        "requests": len(rows),
        "firstPromptN": first.get("promptN"),
        "firstCacheN": first.get("cacheN"),
        "secondPromptN": rest[0].get("promptN") if rest else None,
        "secondCacheN": rest[0].get("cacheN") if rest else None,
        "restPromptNMax": max((r["promptN"] for r in rest if r.get("promptN") is not None), default=None),
        "elapsedMs": round((time.perf_counter() - started_all) * 1000.0, 1),
    }
    print(f"== 前缀缓存探针（同一句话连发 {count} 次）==")
    print(f"text: {text}")
    for row in rows:
        if "promptN" in row:
            print(
                f"[{row['n']:2d}] {'PASS' if row['ok'] else 'FAIL'} {row['elapsedMs']:8.1f} ms  "
                f"prompt_n={row['promptN']}  predicted_n={row['predictedN']}  cache_n={row['cacheN']}  "
                f"finish={row['finishReason']}"
            )
        else:
            print(f"[{row['n']:2d}] FAIL {row['elapsedMs']:8.1f} ms  {row.get('error')}")
    print(
        "CACHE first prompt_n=%s cache_n=%s -> second prompt_n=%s cache_n=%s  (rest prompt_n max=%s)"
        % (
            summary["firstPromptN"],
            summary["firstCacheN"],
            summary["secondPromptN"],
            summary["secondCacheN"],
            summary["restPromptNMax"],
        )
    )
    payload = {
        "v": 1,
        "substage": "3.3",
        "kind": "cache-probe",
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "baseUrl": client.base_url,
        "text": text,
        "count": count,
        "systemSha256": client.system_sha256,
        "summary": summary,
        "rows": rows,
    }
    if artifact_path is not None:
        _write_artifact(artifact_path, payload)
    return payload


def run_truncation_probe(
    client: PlanClient,
    *,
    text: str = "把声音调亮一点，再顺便把齿音压一压，或者切到播客场景也行",
    max_tokens: int = 8,
) -> dict[str, Any]:
    """故意用小 max_tokens 触发截断，验证 `finish_reason=="length"` → None（不抛）。"""

    probe = PlanClient(
        base_url=client.base_url,
        schema_path=str(client.schema_path),
        system_prompt_path=str(client.system_prompt_path),
        fewshot_path=str(client.fewshot_path),
        timeout_s=client.timeout_s,
        max_tokens=max_tokens,
    )
    started = time.perf_counter()
    error: str | None = None
    plan: dict[str, Any] | None = None
    try:
        plan = probe.plan(text)
    except LlmUnavailable as exc:
        error = str(exc)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 1)
    record = {
        "maxTokens": max_tokens,
        "text": text,
        "returnedNone": plan is None,
        "raised": error,
        "finishReason": probe.last_stats.finish_reason,
        "promptN": probe.last_stats.prompt_n,
        "predictedN": probe.last_stats.predicted_n,
        "elapsedMs": elapsed_ms,
        "plan": plan,
    }
    print("== 截断探针（max_tokens=%d）==" % max_tokens)
    print(f"text   : {text}")
    print(f"result : {'None' if plan is None else _brief(plan)}  finish={record['finishReason']}  raised={error}")
    print(f"elapsed: {elapsed_ms} ms")
    return record


def run_selftest(
    *,
    client: PlanClient | None = None,
    artifact_path: str | Path | None = SELFTEST_ARTIFACT,
    cache_probe: int = 0,
    truncate_probe: bool = False,
) -> dict[str, Any]:
    client = client or PlanClient()

    health_started = time.perf_counter()
    up = client.available()
    health_ms = round((time.perf_counter() - health_started) * 1000.0, 3)

    print(f"llm.py --selftest  (python {sys.version.split()[0]})")
    print(f"baseUrl : {client.base_url}")
    print(
        f"model   : local  maxTokens={client.max_tokens}  timeout={client.timeout_s}s  "
        f"schemaOk={bool(client.schema)}"
    )
    print(
        f"prompt  : {client.system_prompt_path} ({len(client.system_message)} 字符, "
        f"sha256={client.system_sha256[:16]}…)  fewshot={len(client.fewshots)}"
    )
    print(f"available: {up}  ({health_ms} ms)")

    payload: dict[str, Any] = {
        "v": 1,
        "substage": "3.3",
        "kind": "selftest",
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "python": sys.version.split()[0],
        "baseUrl": client.base_url,
        "model": "local",
        "maxTokens": client.max_tokens,
        "timeoutS": client.timeout_s,
        "schema": str(client.schema_path),
        "systemPrompt": str(client.system_prompt_path),
        "systemPromptChars": len(client.system_message),
        "systemPromptSha256": client.system_sha256,
        "fewshot": str(client.fewshot_path),
        "fewshotCount": len(client.fewshots),
        "available": up,
        "availableMs": health_ms,
        "promptTextCoverageGaps": prompt_coverage(client),
    }

    if not up:
        print("RESULT FAIL  llama-server 不可用：先跑 .\\voice.cmd server")
        payload["summary"] = {"passed": False, "reason": "unavailable"}
        if artifact_path is not None:
            _write_artifact(artifact_path, payload)
        return payload

    warmup = _warmup_record(client)
    print(
        f"warmup  : {'ok' if warmup['ok'] else 'FAIL'}  {warmup['elapsedMs']} ms  "
        f"prompt_n={warmup.get('promptN')}  predicted_n={warmup.get('predictedN')}  "
        f"cache_n={warmup.get('cacheN')}"
        + ("" if warmup["ok"] else f"  {warmup['error']}")
    )
    payload["warmup"] = warmup
    if not warmup["ok"]:
        print("RESULT FAIL  warmup 失败：服务已起但请求不通")
        payload["summary"] = {"passed": False, "reason": "warmup-failed"}
        if artifact_path is not None:
            _write_artifact(artifact_path, payload)
        return payload

    print("")
    print("== 10 条自由描述 ==")
    rows: list[dict[str, Any]] = []
    for cid, text, note in SELFTEST_CASES:
        started = time.perf_counter()
        error: str | None = None
        plan: dict[str, Any] | None = None
        try:
            plan = client.plan(text)
        except LlmUnavailable as exc:
            error = str(exc)
        elapsed_ms = round((time.perf_counter() - started) * 1000.0, 1)
        stats = client.last_stats
        errors = schema_errors(plan, client.schema) if plan is not None else ["plan 为 None"]
        rows.append(
            {
                "id": cid,
                "text": text,
                "note": note,
                "plan": plan,
                "schemaValid": plan is not None and not errors,
                "schemaErrors": errors,
                "elapsedMs": elapsed_ms,
                "error": error,
                "finishReason": stats.finish_reason,
                "promptN": stats.prompt_n,
                "predictedN": stats.predicted_n,
                "cacheN": stats.cache_n,
            }
        )
        flag = "PASS" if rows[-1]["schemaValid"] else "FAIL"
        print(
            f"[{cid:2d}] {flag} {elapsed_ms:8.1f} ms  prompt_n={stats.prompt_n}  "
            f"predicted_n={stats.predicted_n}  cache_n={stats.cache_n}  finish={stats.finish_reason}"
        )
        print(f"     说法: {text}   （意图：{note}）")
        print(f"     计划: {_brief(plan)}")
        if not rows[-1]["schemaValid"]:
            print(f"     问题: {'; '.join(errors)}  回退: {error}")

    latencies = [row["elapsedMs"] for row in rows]
    p50 = _percentile(latencies, 50)
    p95 = _percentile(latencies, 95)
    valid = sum(1 for row in rows if row["schemaValid"])
    rate = valid / len(rows) if rows else 0.0
    passed = rate >= 1.0 and p95 <= P95_LIMIT_MS
    print("")
    print(
        f"SUMMARY schema {valid}/{len(rows)} ({rate * 100:.1f}%)  "
        f"p50={p50 / 1000:.2f}s  p95={p95 / 1000:.2f}s  limit(p95<={P95_LIMIT_S:.1f}s)"
    )
    print(f"RESULT {'PASS' if passed else 'FAIL'}")
    payload["cases"] = rows
    payload["summary"] = {
        "total": len(rows),
        "schemaValid": valid,
        "schemaValidRate": round(rate, 4),
        "p50Ms": round(p50, 1),
        "p95Ms": round(p95, 1),
        "p95LimitMs": P95_LIMIT_MS,
        "passed": passed,
    }

    if cache_probe > 0:
        print("")
        payload["cacheProbe"] = run_cache_probe(client, cache_probe)
    if truncate_probe:
        print("")
        payload["truncationProbe"] = run_truncation_probe(client)

    if artifact_path is not None:
        _write_artifact(artifact_path, payload)
    return payload


def _write_artifact(path: str | Path, payload: dict[str, Any]) -> Path:
    out = Path(path)
    if not out.is_absolute():
        out = _REPO_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"artifact: {out}")
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

USAGE = (
    "用法:\n"
    "  python tools/voice/llm.py --selftest [--cache-probe N] [--truncate-probe] "
    "[--artifact <path>|--no-artifact]\n"
    "  python tools/voice/llm.py --cache-probe N [--artifact <path>|--no-artifact]\n"
    "  python tools/voice/llm.py --probe\n"
)


def _configure_stdout() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def main(argv: list[str]) -> int:
    _configure_stdout()
    logging.basicConfig(level=logging.INFO, format="[llm] %(levelname)s %(message)s")
    args = list(argv)

    artifact: str | None = SELFTEST_ARTIFACT
    artifact_explicit = False
    if "--no-artifact" in args:
        artifact = None
        args.remove("--no-artifact")
    if "--artifact" in args:
        index = args.index("--artifact")
        if index + 1 >= len(args):
            print("--artifact 需要路径")
            return 2
        artifact = args[index + 1]
        artifact_explicit = True
        del args[index : index + 2]

    cache_probe = 0
    if "--cache-probe" in args:
        index = args.index("--cache-probe")
        if index + 1 >= len(args):
            print("--cache-probe 需要次数")
            return 2
        try:
            cache_probe = int(args[index + 1])
        except ValueError:
            print("--cache-probe 需要整数")
            return 2
        del args[index : index + 2]

    truncate_probe = "--truncate-probe" in args
    if truncate_probe:
        args.remove("--truncate-probe")

    try:
        if "--probe" in args:
            client = PlanClient()
            started = time.perf_counter()
            up = client.available()
            elapsed_ms = round((time.perf_counter() - started) * 1000.0, 3)
            print(f"baseUrl  : {client.base_url}")
            print(f"available: {up}  ({elapsed_ms} ms)")
            return 0
        if "--selftest" in args:
            payload = run_selftest(
                artifact_path=artifact, cache_probe=cache_probe, truncate_probe=truncate_probe
            )
            return 0 if payload.get("summary", {}).get("passed") else 1
        if cache_probe > 0:
            client = PlanClient()
            if not client.available():
                print("RESULT FAIL  llama-server 不可用：先跑 .\\voice.cmd server")
                return 1
            payload = run_cache_probe(
                client,
                cache_probe,
                artifact_path=(
                    None if artifact is None else (artifact if artifact_explicit else CACHE_PROBE_ARTIFACT)
                ),
            )
            return 0 if all(row.get("ok") for row in payload["rows"]) else 1
    except FileNotFoundError as exc:
        print(f"缺少契约文件：{exc}")
        return 1
    except LlmUnavailable as exc:
        print(f"llama-server 不可用：{exc}")
        return 1

    print(USAGE)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
