"""确定性中文解析器（Stage 3 / SubStage 3.2）。

把高频中文说法确定性映射成设计文档 §3.2 的 L1 dict：规则层不产出任何 dB/Hz 数值
（除用户在 `set` 里自己说的数）、不调用 LLM、只用标准库（re + json）。

匹配顺序是硬契约（SubStage_3.1 §10「实施回填」，有约束力）：

- `explainOnly` 优先于一切（"有回音"不是 EQ 问题，命中即 unsupported，不写参数）；
- `entries` 必须**按数组顺序取第一个命中**，不得改成最长匹配、不得按 target 排序：
  emit 刻意把"非主方向条目"排在前面，否则"闷一点"会被"闷"（muddiness.less）吞掉；
- `switches` / `scenes` / `tones` / `scenarios` 没有顺序约束，因此按"最长说法优先"
  取命中（否则 `取消静音` 会被同一列表里的 `静音` 抢先判成 mute=on）。
"""

from __future__ import annotations

import json
import logging
import math
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

LOGGER = logging.getLogger(__name__)

DEFAULT_TARGETS_PATH = "tools/voice/schema/targets.json"
DEFAULT_LEXICON_PATH = "tools/voice/lexicons/zh.json"
SELFTEST_ARTIFACT = "artifacts/voice/selftest-32.json"

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[1]

# 中文数字 1..7：本层必须支持"第六段"这种说法（设计文档 §3.1.1 的频段寻址）。
_CN_DIGITS = {
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
}
_CN_BAND_TEXT = ("一", "二", "三", "四", "五", "六", "七")

# 词表里 field 分组的原始说法 -> L1 的 EqField
_FIELD_TOKENS = {
    "增益": "gain",
    "频率": "freq",
    "频点": "freq",
    "q值": "q",
    "带宽": "q",
    "宽度": "q",
}
_FIELD_SAY = {"gain": "增益", "freq": "频率", "q": "Q值"}
_FIELD_UNIT = {"gain": "dB", "freq": "Hz", "q": ""}

# say 模板里用的口语名：13 维度取自 kb.ts 的 nameZh，唯 muddiness 用口语名「闷」，
# 以匹配任务书 §4.2 的样例 say（"把闷的地方收一收"）。
_TUNE_SAY_NAME = {
    "brightness": "明亮",
    "warmth": "温暖",
    "lowEnd": "低音",
    "muddiness": "闷",
    "clarity": "清晰",
    "sibilance": "齿音",
    "harshness": "毛刺",
    "noiseFloor": "底噪",
    "compression": "压缩",
    "loudness": "音量",
    "gate": "噪声门",
    "limiter": "防爆音",
    "rgbMode": "灯效",
}
_TOGGLE_SAY = {
    "noiseFloor": ("打开降噪", "关掉降噪"),
    "gate": ("打开噪声门", "关掉噪声门"),
    "limiter": ("打开防爆音", "关掉防爆音"),
    "compression": ("打开压缩", "关掉压缩"),
    "rgbMode": ("打开灯效", "关掉灯效"),
    "mute": ("麦克风静音", "取消麦克风静音"),
    "monitor": ("打开监听", "关掉监听"),
}
_SCENE_SAY = {
    "quiet": "安静房间",
    "game": "游戏",
    "podcast": "播客",
    "sing": "唱歌",
    "custom": "自定义",
}
_TONE_SAY = {
    "flat": "原声",
    "vocal": "人声增强",
    "warm": "温暖",
    "bright": "明亮",
    "custom": "自定义",
}

# preset（scene/tone/scenario）识别护栏：命中片段里有这些标记才算"在切预设"，
# 否则要求整句就是那条说法——避免"唱歌的时候声音很闷"被当成场景切换。
_PRESET_MARKERS = ("模式", "音色", "房间", "场景")
_LEAD_FILLERS = (
    "麻烦你",
    "麻烦",
    "帮我",
    "请",
    "我想要",
    "我要",
    "我想",
    "给我",
    "现在",
    "切换到",
    "切换成",
    "切到",
    "换到",
    "换成",
    "调到",
    "调成",
    "设置成",
    "把",
    "来",
    "用",
    "想",
)
_TAIL_NOISE = ("一点", "一些", "一下", "点儿", "点", "吧", "呢", "啊", "呀", "嘛", "哦", "的")
_LEAD_PUNCT = "，,。.、；;：:！!？?“”\"'「」『』（）()【】…—-~· \t\r\n"

# eq 动作的方向判定词：用户不会说 more/less，只给"压一点/提一点"这种动词。
# "宽/窄"按设计文档 §3.1.1 的口径（"这一段的 Q 太窄" -> direction more）。
_LESS_MARKERS = (
    "压",
    "削",
    "减",
    "降",
    "收",
    "砍",
    "沉",
    "低",
    "小",
    "少",
    "弱",
    "闷",
    "糊",
    "暗",
    "刺",
    "尖",
    "硬",
    "冷",
    "薄",
    "干",
    "紧",
    "宽",
)
_MORE_MARKERS = (
    "提",
    "抬",
    "加",
    "增",
    "高",
    "大",
    "多",
    "强",
    "亮",
    "暖",
    "厚",
    "清楚",
    "清晰",
    "通透",
    "响",
    "窄",
)

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_WHITESPACE_RE = re.compile(r"\s+")
_ZERO_WIDTH_RE = re.compile("[\u200b-\u200f\u2060\ufeff]")
# ASR 会插的句中标点；点号单独处理（数字里的小数点要留），见 _strip_inline_punct。
_INLINE_PUNCT = "，,、；;：:！!？?。."
_HZ_FILTER_SAY = "那是滤波器，不是均衡段"


# ---------------------------------------------------------------------------
# 路径解析
# ---------------------------------------------------------------------------


def _resolve(path: str | Path, default_literal: str, module_relative: str) -> Path:
    """默认相对路径按模块位置解析，显式传入的路径原样使用。

    这样 `--selftest` 在任何工作目录下都能跑，而单测传一个不存在的路径时仍然
    拿到 `FileNotFoundError`（不会被默默替换成仓库里那份真词表）。
    """

    if str(path) == default_literal:
        candidate = _HERE / module_relative
        if candidate.exists():
            return candidate
        return Path(path)
    return Path(path)


# ---------------------------------------------------------------------------
# 词表（lexicons/zh.json，3.1 生成物，只读）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Rule:
    """一条说法：原始 pattern + 整串正则 + 逐别名正则 + 载荷。"""

    pattern: str
    regex: re.Pattern[str]
    aliases: tuple[re.Pattern[str], ...]
    payload: dict[str, Any]


@dataclass(frozen=True)
class Lexicon:
    path: str
    raw: dict[str, Any]
    slight_words: tuple[str, ...]
    strong_words: tuple[str, ...]
    entries: tuple[_Rule, ...]
    switches: tuple[_Rule, ...]
    scenes: tuple[_Rule, ...]
    scenarios: tuple[_Rule, ...]
    tones: tuple[_Rule, ...]
    explain_only: tuple[_Rule, ...]
    undo: re.Pattern[str]
    confirm: re.Pattern[str]
    band_param: re.Pattern[str]
    hz_param: re.Pattern[str]


@dataclass(frozen=True)
class BandSpec:
    band: int
    center_hz: float
    kind: str


@dataclass(frozen=True)
class ScenarioSpec:
    id: str
    name_zh: str
    aliases: tuple[str, ...]
    base_scene: str


@dataclass(frozen=True)
class TargetsDoc:
    """`schema/targets.json` 的只读视图（3.1 生成物）。"""

    tune: tuple[str, ...]
    toggle: tuple[str, ...]
    strengths: tuple[str, ...]
    directions: tuple[str, ...]
    scenes: tuple[str, ...]
    tones: tuple[str, ...]
    param_ids: frozenset[str]
    aliases: dict[str, tuple[str, ...]]
    wake_prefixes: tuple[str, ...]
    bands: tuple[BandSpec, ...]
    explain: dict[str, str]
    scenarios: tuple[ScenarioSpec, ...]


_LEXICON_GROUPS = (
    ("entries", ("target", "direction")),
    ("switches", ("target", "on")),
    ("scenes", ("scene",)),
    ("scenarios", ("scenario",)),
    ("tones", ("tone",)),
    ("explainOnly", ("id",)),
)


def _split_alternation(pattern: str) -> tuple[str, ...]:
    # 词表里的 pattern 是 kb 的别名用 '|' 拼成的纯 alternation；逐别名编译是因为
    # 整串正则按"左优先"匹配，会把 "原声模式" 截成 "原声"，丢掉了 preset 判定要用的标记。
    return tuple(part for part in pattern.split("|") if part)


def _compile_rule(pattern: Any, payload: dict[str, Any], where: str) -> _Rule:
    if not isinstance(pattern, str) or not pattern:
        raise ValueError(f"{where} 缺少 pattern 或不是字符串：{pattern!r}")
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        raise ValueError(f"{where} 的正则不合法：{pattern!r}（{exc}）") from exc
    aliases: list[re.Pattern[str]] = []
    for part in _split_alternation(pattern):
        try:
            aliases.append(re.compile(part, re.IGNORECASE))
        except re.error:
            continue
    if not aliases:
        aliases.append(regex)
    return _Rule(pattern=pattern, regex=regex, aliases=tuple(aliases), payload=payload)


def _as_rules(raw: dict[str, Any], key: str, required: Iterable[str]) -> tuple[_Rule, ...]:
    items = raw.get(key)
    if not isinstance(items, list):
        raise ValueError(f"词表字段 {key} 必须是数组")
    rules: list[_Rule] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"词表 {key}[{index}] 必须是对象")
        for field in required:
            if field not in item:
                raise ValueError(f"词表 {key}[{index}] 缺少字段 {field}")
        payload = {k: v for k, v in item.items() if k != "pattern"}
        if key == "entries" and payload.get("direction") not in ("more", "less"):
            raise ValueError(f"词表 entries[{index}].direction 非法：{payload.get('direction')!r}")
        if key == "switches" and not isinstance(payload.get("on"), bool):
            raise ValueError(f"词表 switches[{index}].on 非法：{payload.get('on')!r}")
        rules.append(_compile_rule(item.get("pattern"), payload, f"{key}[{index}]"))
    return tuple(rules)


def load_lexicon(path: str = DEFAULT_LEXICON_PATH) -> Lexicon:
    """读 `lexicons/zh.json`。

    缺失 → `FileNotFoundError`；JSON 非法或结构不合契约 → `ValueError`（不吞，见任务书 §5）。
    """

    resolved = _resolve(path, DEFAULT_LEXICON_PATH, "lexicons/zh.json")
    return _load_lexicon_cached(str(resolved))


@lru_cache(maxsize=8)
def _load_lexicon_cached(resolved: str) -> Lexicon:
    raw = json.loads(Path(resolved).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"词表 {resolved} 顶层必须是对象")
    for key in (
        "strengthWords",
        "entries",
        "switches",
        "scenes",
        "scenarios",
        "tones",
        "explainOnly",
        "undo",
        "confirm",
        "bandParam",
        "hzParam",
    ):
        if key not in raw:
            raise ValueError(f"词表 {resolved} 缺少字段 {key}")
    words = raw["strengthWords"]
    if not isinstance(words, dict):
        raise ValueError("词表 strengthWords 必须是对象")
    slight = tuple(str(w) for w in words.get("slight") or ())
    strong = tuple(str(w) for w in words.get("strong") or ())
    groups = {key: _as_rules(raw, key, required) for key, required in _LEXICON_GROUPS}
    try:
        undo = re.compile(str(raw["undo"]))
        confirm = re.compile(str(raw["confirm"]))
        band_param = re.compile(str(raw["bandParam"]))
        hz_param = re.compile(str(raw["hzParam"]), re.IGNORECASE)
    except re.error as exc:
        raise ValueError(f"词表 {resolved} 的控制/寻址正则不合法：{exc}") from exc
    return Lexicon(
        path=resolved,
        raw=raw,
        slight_words=slight,
        strong_words=strong,
        entries=groups["entries"],
        switches=groups["switches"],
        scenes=groups["scenes"],
        scenarios=groups["scenarios"],
        tones=groups["tones"],
        explain_only=groups["explainOnly"],
        undo=undo,
        confirm=confirm,
        band_param=band_param,
        hz_param=hz_param,
    )


# ---------------------------------------------------------------------------
# targets.json（3.1 生成物，只读）
# ---------------------------------------------------------------------------


def load_targets(path: str = DEFAULT_TARGETS_PATH) -> TargetsDoc:
    resolved = _resolve(path, DEFAULT_TARGETS_PATH, "schema/targets.json")
    return _load_targets_cached(str(resolved))


@lru_cache(maxsize=8)
def _load_targets_cached(resolved: str) -> TargetsDoc:
    raw = json.loads(Path(resolved).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{resolved} 顶层必须是对象")
    for key in ("tuneTargets", "toggleTargets", "strengths", "directions", "paramIds", "bands"):
        if key not in raw:
            raise ValueError(f"{resolved} 缺少字段 {key}")
    doc = TargetsDoc(
        tune=tuple(str(v) for v in raw["tuneTargets"]),
        toggle=tuple(str(v) for v in raw["toggleTargets"]),
        strengths=tuple(str(v) for v in raw.get("strengths") or ("slight", "medium", "strong")),
        directions=tuple(str(v) for v in raw.get("directions") or ("more", "less")),
        scenes=tuple(str(v) for v in raw.get("scenes") or ()),
        tones=tuple(str(v) for v in raw.get("tones") or ()),
        param_ids=frozenset(str(v) for v in raw["paramIds"]),
        aliases={str(k): tuple(str(v) for v in vals) for k, vals in (raw.get("aliases") or {}).items()},
        wake_prefixes=tuple(str(v) for v in raw.get("wakePrefixes") or ()),
        bands=tuple(
            BandSpec(int(b["band"]), float(b["centerHz"]), str(b["kind"]))
            for b in raw["bands"]
            if isinstance(b, dict) and "band" in b
        ),
        explain={
            str(e["id"]): str(e.get("explain", ""))
            for e in (raw.get("explainOnly") or [])
            if isinstance(e, dict) and "id" in e
        },
        scenarios=tuple(
            ScenarioSpec(
                id=str(s.get("id")),
                name_zh=str(s.get("nameZh", s.get("id"))),
                aliases=tuple(str(v) for v in (s.get("aliases") or ())),
                base_scene=str(s.get("baseScene", "")),
            )
            for s in (raw.get("scenarios") or [])
            if isinstance(s, dict) and s.get("id")
        ),
    )
    _warn_lexicon_gaps(doc)
    return doc


def missing_lexicon_targets(doc: TargetsDoc, lexicon: Lexicon) -> tuple[str, ...]:
    """哪些 target 在词表里一条说法都没有（允许词表滞后，只 warn 不抛）。"""

    covered = {rule.payload.get("target") for rule in lexicon.entries}
    covered |= {rule.payload.get("target") for rule in lexicon.switches}
    wanted = list(doc.tune) + [t for t in doc.toggle if t not in doc.tune]
    return tuple(target for target in wanted if target not in covered)


def _warn_lexicon_gaps(doc: TargetsDoc) -> None:
    try:
        lexicon = load_lexicon()
    except (OSError, ValueError) as exc:
        LOGGER.warning("词表不可用，跳过 target 覆盖检查：%s", exc)
        return
    for target in missing_lexicon_targets(doc, lexicon):
        LOGGER.warning("targets.json 的 target %r 在词表里没有说法（允许词表滞后）", target)


# ---------------------------------------------------------------------------
# 文本与匹配工具
# ---------------------------------------------------------------------------


def _strip_inline_punct(text: str) -> str:
    """删句中标点，只保留数字里的小数点。

    ASR 会在词中间插逗号：`第六段增益提高三分贝` 出来是 `第六段，增益提高3dB`，而
    `bandParam` 的 `第X段(增益|频率|q值|带宽)?` 里没有标点的位置，不清掉整句就会失配、
    掉到 LLM 兜底，把一个完全标准的显式数值指令丢掉。`normalize.py` 按契约只去句末标点，
    所以句中清洗由这一层收口。只删"两侧不都是数字"的点号，`3.5` 的小数点必须保住。
    """

    if not any(ch in _INLINE_PUNCT for ch in text):
        return text
    out: list[str] = []
    last = len(text) - 1
    for index, ch in enumerate(text):
        if ch not in _INLINE_PUNCT:
            out.append(ch)
            continue
        if ch == ".":
            before = text[index - 1] if index > 0 else ""
            after = text[index + 1] if index < last else ""
            if before.isdigit() and after.isdigit():
                out.append(ch)
    return "".join(out)


def _normalize_text(text: Any) -> str:
    """NFKC -> 去零宽 -> 去空白 -> 去句中标点 -> 去首尾标点。幂等。"""

    if not isinstance(text, str):
        return ""
    normalized = unicodedata.normalize("NFKC", text)
    normalized = _ZERO_WIDTH_RE.sub("", normalized)
    normalized = _WHITESPACE_RE.sub("", normalized)
    normalized = _strip_inline_punct(normalized)
    return normalized.strip(_LEAD_PUNCT)


def _strip_wake(text: str, prefixes: Iterable[str]) -> str:
    stripped = text.lstrip(_LEAD_PUNCT)
    for prefix in sorted((p for p in prefixes if p), key=len, reverse=True):
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix) :].lstrip(_LEAD_PUNCT)
            break
    return stripped


def _first_match(core: str, rules: Iterable[_Rule]) -> _Rule | None:
    """按数组顺序取第一个命中（entries 的硬契约）。"""

    for rule in rules:
        if rule.regex.search(core):
            return rule
    return None


def _best_alias(core: str, rules: Iterable[_Rule]) -> tuple[_Rule, str] | None:
    """最长说法优先，长度相同取数组靠前的（switches/scenes/tones/scenarios 用）。"""

    best: tuple[int, int, _Rule, str] | None = None
    for index, rule in enumerate(rules):
        for alias in rule.aliases:
            match = alias.search(core)
            if not match:
                continue
            text = match.group(0)
            candidate = (len(text), -index, rule, text)
            if best is None or (candidate[0], candidate[1]) > (best[0], best[1]):
                best = candidate
    if best is None:
        return None
    return best[2], best[3]


def _skeleton(core: str) -> str:
    text = core
    changed = True
    while changed:
        changed = False
        for filler in _LEAD_FILLERS:
            if text.startswith(filler) and len(text) > len(filler):
                text = text[len(filler) :]
                changed = True
                break
    for particle in _TAIL_NOISE:
        if text.endswith(particle) and len(text) > len(particle):
            text = text[: -len(particle)]
            break
    return text


def _leftover_is_noise(core: str, alias: str) -> bool:
    index = core.find(alias)
    if index < 0:
        return False
    rest = core[:index] + core[index + len(alias) :]
    while rest:
        for noise in _TAIL_NOISE:
            if rest.startswith(noise):
                rest = rest[len(noise) :]
                break
        else:
            return False
    return True


def _preset_allowed(core: str, alias: str, skeleton: str) -> bool:
    if any(marker in alias for marker in _PRESET_MARKERS):
        return True
    if skeleton == alias:
        return True
    return _leftover_is_noise(core, alias)


def _strength(core: str, lexicon: Lexicon) -> str:
    if any(word and word in core for word in lexicon.strong_words):
        return "strong"
    # "有点儿" 与 "有点" 是同一档口语；词表只收了前者，样例 "声音有点闷" 要求 slight。
    if any(word and word in core for word in lexicon.slight_words) or "有点" in core:
        return "slight"
    return "medium"


def _direction(core: str) -> str:
    probe = core.replace("带宽", "")
    if any(word in probe for word in _LESS_MARKERS):
        return "less"
    if any(word in probe for word in _MORE_MARKERS):
        return "more"
    # 用户点名频段通常是想压掉某个问题，没给动词时按 less 处理（口径写在报告里）。
    return "less"


def _numbers(text: str) -> list[tuple[int, int, float]]:
    out: list[tuple[int, int, float]] = []
    for match in _NUM_RE.finditer(text):
        try:
            out.append((match.start(), match.end(), float(match.group(0))))
        except ValueError:  # 理论上不会发生，防御性收口
            continue
    return out


def _grounded(text: str, value: float) -> bool:
    return any(abs(candidate - value) < 1e-9 for _, _, candidate in _numbers(text))


def _fmt_number(value: float) -> int | float:
    if float(value).is_integer():
        return int(value)
    return round(value, 3)


def _band_number(token: str | None) -> int | None:
    if not token:
        return None
    token = token.strip().lower()
    return _CN_DIGITS.get(token)


def _field_of(token: str | None) -> str | None:
    if not token:
        return None
    return _FIELD_TOKENS.get(token.strip().lower())


def _field_in_window(core: str, start: int, width: int = 10) -> str | None:
    window = core[start : start + width].lower()
    for token, field in _FIELD_TOKENS.items():
        if token in window:
            return field
    # "第4段Q太窄"：Q 单独出现时也是一段字段名（词表的 field 分组只收了 "q值"）。
    if "q" in window:
        return "q"
    return None


def _field_in_text(core: str) -> str:
    lowered = core.lower()
    if "q值" in lowered or "带宽" in lowered or "宽度" in lowered or "q" in lowered:
        return "q"
    if "频率" in core or "频点" in core:
        return "freq"
    return "gain"


def _nearest_band(hz: float, bands: tuple[BandSpec, ...]) -> BandSpec | None:
    if hz <= 0 or not bands:
        return None
    target = math.log(hz)
    return min(bands, key=lambda band: abs(math.log(band.center_hz) - target))


def _ok(ops: list[dict[str, Any]], say: str) -> dict[str, Any]:
    return {"v": 1, "status": "ok", "say": say, "confidence": 1, "ops": ops}


def _unsupported(say: str) -> dict[str, Any]:
    return {"v": 1, "status": "unsupported", "ops": [], "say": say, "confidence": 1}


# ---------------------------------------------------------------------------
# 解析主体
# ---------------------------------------------------------------------------


def parse(
    text: str,
    *,
    targets: TargetsDoc,
    lexicon_path: str = DEFAULT_LEXICON_PATH,
) -> dict[str, Any] | None:
    """命中 → L1 dict（`status` 恒为 'ok' 或 'unsupported'，`confidence` 恒为 1）；未命中 → None。

    词表/词表路径错误会抛（配置问题）；任何"句子看不懂"的情形都只返回 None。
    """

    lexicon = load_lexicon(lexicon_path)
    core = _strip_wake(_normalize_text(text), targets.wake_prefixes)
    if not core:
        return None

    # 优先级 0：explainOnly —— "有回音"不是 EQ 问题，命中就不许写参数。
    explain_hit = _first_match(core, lexicon.explain_only)
    if explain_hit is not None:
        identity = str(explain_hit.payload.get("id", ""))
        return _unsupported(targets.explain.get(identity, "这个问题不适合用调音解决"))

    # 优先级 1：含"模式/音色"或整句就是说法 → scene / tone / scenario。
    preset = _parse_preset(core, lexicon, targets)
    if preset is not None:
        return preset

    # 优先级 2：命中 switches → toggle（先于 entries，否则"关掉压缩"会被判成 compression 减弱）。
    switch = _parse_switch(core, lexicon)
    if switch is not None:
        return switch

    # 优先级 3 / 3b / 3c：频段寻址（band 或 centerHz）。
    addressed = _parse_addressed(core, lexicon, targets)
    if addressed is not None:
        return addressed

    # 优先级 4 / 5：entries，数组顺序取第一个命中，每个 target 一个 op，最多 3 个。
    return _parse_tune(core, lexicon)


def _parse_preset(core: str, lexicon: Lexicon, targets: TargetsDoc) -> dict[str, Any] | None:
    skeleton = _skeleton(core)
    tone_first = "音色" in core
    groups: list[tuple[tuple[_Rule, ...], str]] = (
        [(lexicon.tones, "tone"), (lexicon.scenes, "scene")]
        if tone_first
        else [(lexicon.scenes, "scene"), (lexicon.tones, "tone")]
    )
    for rules, kind in groups:
        for rule in rules:
            best = _best_alias(core, (rule,))
            if best is None:
                continue
            alias = best[1]
            if not _preset_allowed(core, alias, skeleton):
                continue
            if kind == "scene":
                scene = str(rule.payload.get("scene"))
                return _ok([{"kind": "scene", "scene": scene}], f"切到{_SCENE_SAY.get(scene, scene)}")
            tone = str(rule.payload.get("tone"))
            return _ok([{"kind": "tone", "tone": tone}], f"切到{_TONE_SAY.get(tone, tone)}音色")

    # 场景词表（8 种）在 L1 里没有独立的 op 类型：投影成它的 baseScene 场景切换，
    # 额外补丁（如直播的 enc.Level+1）属于 L2，由 4.1 的 rules.json 负责。
    for rule in lexicon.scenarios:
        best = _best_alias(core, (rule,))
        if best is None:
            continue
        if not _preset_allowed(core, best[1], skeleton):
            continue
        scenario_id = str(rule.payload.get("scenario"))
        base_scene = next(
            (spec.base_scene for spec in targets.scenarios if spec.id == scenario_id), ""
        )
        if base_scene not in (targets.scenes or (base_scene,)):
            base_scene = ""
        if not base_scene:
            return None
        return _ok(
            [{"kind": "scene", "scene": base_scene}],
            f"切到{_SCENE_SAY.get(base_scene, base_scene)}",
        )
    return None


def _parse_switch(core: str, lexicon: Lexicon) -> dict[str, Any] | None:
    best = _best_alias(core, lexicon.switches)
    if best is None:
        return None
    rule, _alias = best
    target = str(rule.payload.get("target"))
    on = bool(rule.payload.get("on"))
    phrases = _TOGGLE_SAY.get(target, (f"打开{target}", f"关掉{target}"))
    return _ok([{"kind": "toggle", "target": target, "on": on}], phrases[0] if on else phrases[1])


def _parse_addressed(core: str, lexicon: Lexicon, targets: TargetsDoc) -> dict[str, Any] | None:
    band_match = lexicon.band_param.search(core)
    if band_match is not None:
        groups = band_match.groupdict()
        band = _band_number(groups.get("band"))
        if band is None or not 1 <= band <= 7:
            return None
        field = _field_of(groups.get("field")) or _field_in_window(core, band_match.end()) or "gain"
        after = [item for item in _numbers(core) if item[0] >= band_match.end()]
        before = [item for item in _numbers(core) if item[1] <= band_match.start()]
        picked = after or before
        if picked:
            value = picked[0][2]
            param = f"eq.band{band}.{field}"
            # 任务书 §5：band 越界 / param 不在 72 项内 / 数字不接地 → 丢弃该 op（全丢即 None）。
            if not math.isfinite(value):
                return None
            if param not in targets.param_ids:
                return None
            if not _grounded(core, value):
                return None
            say = f"第{_CN_BAND_TEXT[band - 1]}段{_FIELD_SAY[field]}设为 {_fmt_number(value)}{_FIELD_UNIT[field]}"
            return _ok([{"kind": "set", "param": param, "value": _fmt_number(value)}], say)
        direction = _direction(core)
        strength = _strength(core, lexicon)
        say = f"把第{_CN_BAND_TEXT[band - 1]}段{_FIELD_SAY[field]}{'压一压' if direction == 'less' else '提一提'}"
        return _ok(
            [{"kind": "eq", "band": band, "field": field, "direction": direction, "strength": strength}],
            say,
        )

    hz_match = lexicon.hz_param.search(core)
    if hz_match is None:
        return None
    try:
        hz = float(hz_match.group("hz"))
    except (TypeError, ValueError):
        return None
    unit = re.sub(r"[\d.\s]+", "", hz_match.group(0)).lower()
    if unit in ("k", "khz", "千赫", "k赫兹"):
        hz *= 1000.0
    if hz <= 0 or not math.isfinite(hz):
        return None
    band_spec = _nearest_band(hz, targets.bands)
    if band_spec is None:
        return None
    if band_spec.kind in ("hpf", "lpf"):
        # 任务书 §4.1(3c)：落在 HPF/LPF 段上不产出 eq op，而是解释一句。
        return _unsupported(_HZ_FILTER_SAY)
    field = _field_in_text(core)
    direction = _direction(core)
    strength = _strength(core, lexicon)
    say = f"把{_fmt_number(hz)}Hz 附近{_FIELD_SAY[field]}{'压一压' if direction == 'less' else '提一提'}"
    return _ok(
        [
            {
                "kind": "eq",
                "centerHz": _fmt_number(hz),
                "field": field,
                "direction": direction,
                "strength": strength,
            }
        ],
        say,
    )


def _parse_tune(core: str, lexicon: Lexicon) -> dict[str, Any] | None:
    strength = _strength(core, lexicon)
    ops: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rule in lexicon.entries:  # 数组顺序即契约，不许按 target 排序
        target = str(rule.payload.get("target"))
        if target in seen:
            continue
        if not rule.regex.search(core):
            continue
        seen.add(target)
        direction = str(rule.payload.get("direction"))
        ops.append({"kind": "tune", "target": target, "direction": direction, "strength": strength})
        if len(ops) >= 3:
            break
    if not ops:
        return None
    names = [_TUNE_SAY_NAME.get(op["target"], op["target"]) for op in ops]
    directions = {op["direction"] for op in ops}
    if len(directions) == 1:
        verb = "收一收" if ops[0]["direction"] == "less" else "提一提"
    else:
        verb = "调一调"
    if len(ops) == 1:
        say = f"把{names[0]}的地方{verb}"
    else:
        say = f"把{'、'.join(names)}的地方一起{verb}"
    return _ok(ops, say)


def parse_control(
    text: str,
    *,
    lexicon_path: str = DEFAULT_LEXICON_PATH,
) -> str | None:
    """返回 'confirm' | 'undo' | None（二次确认与撤销握手用）。

    撤销优先于确认：一句话里同时出现两者时，撤销是安全侧（不写参数）。
    """

    lexicon = load_lexicon(lexicon_path)
    core = _normalize_text(text)
    if not core:
        return None
    if lexicon.undo.search(core):
        return "undo"
    if lexicon.confirm.search(core):
        return "confirm"
    return None


# ---------------------------------------------------------------------------
# 自检表（30 条主表 + 8 条补充分组）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SelftestCase:
    cid: int
    group: str
    text: str
    # None = 期望未命中；否则是 L1 的部分断言（status / ops 逐项子集 / say）
    expect: dict[str, Any] | None
    note: str = ""


# 主表 30 条：13 个 tune target、7 个 toggle、5 个 scene、4 个 tone、1 条未命中。
SELFTEST_CASES: tuple[SelftestCase, ...] = (
    SelftestCase(1, "tune", "把声音调亮一点", {"ops": [{"kind": "tune", "target": "brightness", "direction": "more", "strength": "slight"}]}, "brightness.more"),
    SelftestCase(2, "tune", "再暖一点", {"ops": [{"kind": "tune", "target": "warmth", "direction": "more"}]}, "warmth.more"),
    SelftestCase(3, "tune", "低音再多一点", {"ops": [{"kind": "tune", "target": "lowEnd", "direction": "more"}]}, "lowEnd.more"),
    SelftestCase(4, "tune", "声音有点闷", {"ops": [{"kind": "tune", "target": "muddiness", "direction": "less", "strength": "slight"}], "say": "把闷的地方收一收"}, "任务书 §4.2 样例"),
    SelftestCase(5, "tune", "人声再清楚一点", {"ops": [{"kind": "tune", "target": "clarity", "direction": "more"}]}, "clarity.more"),
    SelftestCase(6, "tune", "齿音有点重", {"ops": [{"kind": "tune", "target": "sibilance", "direction": "less"}]}, "sibilance.less"),
    SelftestCase(7, "tune", "有点刺耳", {"ops": [{"kind": "tune", "target": "harshness", "direction": "less"}]}, "harshness.less"),
    SelftestCase(8, "tune", "底噪有点大", {"ops": [{"kind": "tune", "target": "noiseFloor", "direction": "less"}]}, "noiseFloor.less"),
    SelftestCase(9, "tune", "声音忽大忽小", {"ops": [{"kind": "tune", "target": "compression", "direction": "more"}]}, "compression.more"),
    SelftestCase(10, "tune", "声音太小了", {"ops": [{"kind": "tune", "target": "loudness", "direction": "more"}]}, "loudness.more"),
    SelftestCase(11, "tune", "气口太明显", {"ops": [{"kind": "tune", "target": "gate", "direction": "less"}]}, "gate.less"),
    SelftestCase(12, "tune", "一喊就破音", {"ops": [{"kind": "tune", "target": "limiter", "direction": "more"}]}, "limiter.more"),
    SelftestCase(13, "tune", "换个灯效", {"ops": [{"kind": "tune", "target": "rgbMode", "direction": "more"}]}, "rgbMode.more"),
    SelftestCase(14, "toggle", "打开降噪", {"ops": [{"kind": "toggle", "target": "noiseFloor", "on": True}]}, "noiseFloor on"),
    SelftestCase(15, "toggle", "关掉压缩", {"ops": [{"kind": "toggle", "target": "compression", "on": False}]}, "§6.3 歧义：不是 compression less"),
    SelftestCase(16, "toggle", "开防爆音", {"ops": [{"kind": "toggle", "target": "limiter", "on": True}]}, "limiter on"),
    SelftestCase(17, "toggle", "关掉噪声门", {"ops": [{"kind": "toggle", "target": "gate", "on": False}]}, "gate off"),
    SelftestCase(18, "toggle", "把灯打开", {"ops": [{"kind": "toggle", "target": "rgbMode", "on": True}]}, "rgbMode on"),
    SelftestCase(19, "toggle", "静音", {"ops": [{"kind": "toggle", "target": "mute", "on": True}]}, "mute on"),
    SelftestCase(20, "toggle", "打开监听", {"ops": [{"kind": "toggle", "target": "monitor", "on": True}]}, "monitor on"),
    SelftestCase(21, "scene", "切换安静房间", {"ops": [{"kind": "scene", "scene": "quiet"}]}, "quiet"),
    SelftestCase(22, "scene", "切换到游戏模式", {"ops": [{"kind": "scene", "scene": "game"}]}, "game"),
    SelftestCase(23, "scene", "打开播客模式", {"ops": [{"kind": "scene", "scene": "podcast"}]}, "podcast"),
    SelftestCase(24, "scene", "唱歌模式", {"ops": [{"kind": "scene", "scene": "sing"}]}, "sing"),
    SelftestCase(25, "scene", "自定义模式", {"ops": [{"kind": "scene", "scene": "custom"}]}, "scene 先于 tone（同一说法两边都有）"),
    SelftestCase(26, "tone", "温暖模式", {"ops": [{"kind": "tone", "tone": "warm"}]}, "§6.3 歧义：不是 warmth 维度"),
    SelftestCase(27, "tone", "明亮音色", {"ops": [{"kind": "tone", "tone": "bright"}]}, "bright"),
    SelftestCase(28, "tone", "人声增强", {"ops": [{"kind": "tone", "tone": "vocal"}]}, "vocal"),
    SelftestCase(29, "tone", "原声模式", {"ops": [{"kind": "tone", "tone": "flat"}]}, "flat"),
    SelftestCase(30, "miss", "放首歌", None, "与调参无关"),
)

# 补充分组 8 条：eq 频段寻址 3 条、多意图 2 条、explainOnly 2 条、未命中 1 条。
SELFTEST_EXTRA: tuple[SelftestCase, ...] = (
    SelftestCase(31, "eq", "第四段增益压一点", {"ops": [{"kind": "eq", "band": 4, "field": "gain", "direction": "less", "strength": "slight"}]}, "band 寻址（任务书 3b）"),
    SelftestCase(32, "eq", "第六段增益提到3dB", {"ops": [{"kind": "set", "param": "eq.band6.gain", "value": 3}], "say": "第六段增益设为 3dB"}, "任务书 §4.2 样例（数字接地）"),
    SelftestCase(33, "eq", "250赫兹压一点", {"ops": [{"kind": "eq", "centerHz": 250, "field": "gain", "direction": "less", "strength": "slight"}]}, "centerHz 寻址（任务书 3c）"),
    SelftestCase(34, "multi", "又闷又刺", {"ops": [{"kind": "tune", "target": "muddiness", "direction": "less"}, {"kind": "tune", "target": "sibilance", "direction": "less"}]}, "任务书 §6.4 样例：2 个 op"),
    SelftestCase(35, "multi", "声音有点闷又有点刺耳", {"ops": [{"kind": "tune", "target": "muddiness", "direction": "less"}, {"kind": "tune", "target": "harshness", "direction": "less"}]}, "多意图：2 个 op"),
    SelftestCase(36, "explainOnly", "房间里有回音", {"status": "unsupported", "ops": [], "say": "@explain:echo"}, "识别但不写参数"),
    SelftestCase(37, "explainOnly", "一直有电流声", {"status": "unsupported", "ops": [], "say": "@explain:hum"}, "识别但不写参数"),
    SelftestCase(38, "miss", "今天天气怎么样", None, "与调参无关"),
)


def _resolve_expected_say(expect: dict[str, Any], targets: TargetsDoc) -> dict[str, Any]:
    resolved = dict(expect)
    say = resolved.get("say")
    if isinstance(say, str) and say.startswith("@explain:"):
        resolved["say"] = targets.explain.get(say.split(":", 1)[1], "")
    return resolved


def evaluate_case(case: SelftestCase, *, targets: TargetsDoc) -> tuple[bool, Any]:
    """跑一条自检：返回 (是否判对, 实际结果)。"""

    actual = parse(case.text, targets=targets)
    if case.expect is None:
        return actual is None, actual
    if actual is None:
        return False, actual
    expected = _resolve_expected_say(case.expect, targets)
    if actual.get("status") != expected.get("status", "ok"):
        return False, actual
    want_ops = expected.get("ops")
    if want_ops is not None:
        got_ops = actual.get("ops") or []
        if len(got_ops) != len(want_ops):
            return False, actual
        for got, want in zip(got_ops, want_ops):
            for key, value in want.items():
                if got.get(key) != value:
                    return False, actual
    if "say" in expected and actual.get("say") != expected["say"]:
        return False, actual
    return True, actual


def _brief(actual: Any) -> str:
    if actual is None:
        return "None"
    status = actual.get("status")
    parts: list[str] = []
    for op in actual.get("ops") or []:
        kind = op.get("kind")
        if kind == "tune":
            parts.append(f"tune {op.get('target')}.{op.get('direction')}.{op.get('strength')}")
        elif kind == "eq":
            where = f"band{op.get('band')}" if "band" in op else f"{op.get('centerHz')}Hz"
            parts.append(f"eq {where}.{op.get('field')}.{op.get('direction')}.{op.get('strength')}")
        elif kind == "toggle":
            parts.append(f"toggle {op.get('target')}={'on' if op.get('on') else 'off'}")
        elif kind == "set":
            parts.append(f"set {op.get('param')}={op.get('value')}")
        elif kind == "scene":
            parts.append(f"scene {op.get('scene')}")
        elif kind == "tone":
            parts.append(f"tone {op.get('tone')}")
        else:
            parts.append(str(kind))
    if status != "ok":
        parts.append(f"[{status}]")
    parts.append(f"say={actual.get('say')!r}")
    return " | ".join(parts)


def _brief_expected(case: SelftestCase, targets: TargetsDoc) -> str:
    if case.expect is None:
        return "None（未命中）"
    expected = _resolve_expected_say(case.expect, targets)
    return _brief({"status": expected.get("status", "ok"), "ops": expected.get("ops") or [], "say": expected.get("say")})


def _coverage(rows: list[dict[str, Any]], targets: TargetsDoc) -> dict[str, Any]:
    tune = {target: 0 for target in targets.tune}
    toggle = {target: 0 for target in targets.toggle}
    scenes = {scene: 0 for scene in targets.scenes}
    tones = {tone: 0 for tone in targets.tones}
    eq_rows = multi_rows = explain_rows = miss_rows = 0
    for row in rows:
        ops = (row.get("actual") or {}).get("ops") or []
        status = (row.get("actual") or {}).get("status")
        if row["group"] == "eq":
            eq_rows += 1
        if row["group"] == "multi":
            multi_rows += 1
        if status == "unsupported":
            explain_rows += 1
        if row.get("actual") is None:
            miss_rows += 1
        for op in ops:
            kind = op.get("kind")
            if kind == "tune" and op.get("target") in tune:
                tune[op["target"]] += 1
            elif kind == "toggle" and op.get("target") in toggle:
                toggle[op["target"]] += 1
            elif kind == "scene" and op.get("scene") in scenes:
                scenes[op["scene"]] += 1
            elif kind == "tone" and op.get("tone") in tones:
                tones[op["tone"]] += 1
    return {
        "tuneTargets": {"covered": sum(1 for v in tune.values() if v), "total": len(tune), "hits": tune},
        "toggleTargets": {"covered": sum(1 for v in toggle.values() if v), "total": len(toggle), "hits": toggle},
        "scenes": {"covered": sum(1 for v in scenes.values() if v), "total": len(scenes), "hits": scenes},
        "tones": {"covered": sum(1 for v in tones.values() if v), "total": len(tones), "hits": tones},
        "groups": {"eq": eq_rows, "multi": multi_rows, "explainOnly": explain_rows, "miss": miss_rows},
    }


def _lexicon_counts(lexicon: Lexicon) -> dict[str, int]:
    counts = {
        "entries": len(lexicon.entries),
        "switches": len(lexicon.switches),
        "scenes": len(lexicon.scenes),
        "scenarios": len(lexicon.scenarios),
        "tones": len(lexicon.tones),
        "explainOnly": len(lexicon.explain_only),
    }
    counts["total"] = sum(counts.values())
    counts["totalWithoutExplain"] = counts["total"] - counts["explainOnly"]
    return counts


def run_selftest(*, artifact_path: str | Path | None = SELFTEST_ARTIFACT) -> dict[str, Any]:
    """跑 30 条主表 + 8 条补充分组，打印明细并落 artifacts JSON。"""

    targets = load_targets()
    lexicon = load_lexicon()
    rows: list[dict[str, Any]] = []
    for case in SELFTEST_CASES + SELFTEST_EXTRA:
        ok, actual = evaluate_case(case, targets=targets)
        rows.append(
            {
                "id": case.cid,
                "group": case.group,
                "text": case.text,
                "note": case.note,
                "ok": ok,
                "expect": _brief_expected(case, targets),
                "actual": actual,
            }
        )

    main_rows = rows[: len(SELFTEST_CASES)]
    extra_rows = rows[len(SELFTEST_CASES) :]
    main_pass = sum(1 for row in main_rows if row["ok"])
    extra_pass = sum(1 for row in extra_rows if row["ok"])
    total_pass = main_pass + extra_pass
    main_rate = main_pass / len(main_rows) if main_rows else 0.0
    extra_rate = extra_pass / len(extra_rows) if extra_rows else 0.0
    total_rate = total_pass / len(rows) if rows else 0.0
    threshold = 0.95
    passed = main_rate >= threshold and extra_rate >= threshold

    counts = _lexicon_counts(lexicon)
    coverage = _coverage(rows, targets)

    print(f"parser.py --selftest  (python {sys.version.split()[0]})")
    print(f"targets : {DEFAULT_TARGETS_PATH}")
    print(f"lexicon : {lexicon.path}")
    print(
        "counts  : "
        f"entries={counts['entries']} switches={counts['switches']} scenes={counts['scenes']} "
        f"scenarios={counts['scenarios']} tones={counts['tones']} explainOnly={counts['explainOnly']} "
        f"total={counts['total']} (五类合计 {counts['totalWithoutExplain']})"
    )
    print("")
    label = "主表（30 条）"
    print(f"== {label} ==")
    for row in main_rows:
        flag = "PASS" if row["ok"] else "FAIL"
        print(f"[{row['id']:2d}] {flag} {row['group']:<11} {row['text']}")
        print(f"         actual   : {_brief(row['actual'])}")
        if not row["ok"]:
            print(f"         expected : {row['expect']}")
    print("")
    print("== 补充分组（8 条：eq 3 / 多意图 2 / explainOnly 2 / 未命中 1）==")
    for row in extra_rows:
        flag = "PASS" if row["ok"] else "FAIL"
        print(f"[{row['id']:2d}] {flag} {row['group']:<11} {row['text']}")
        print(f"         actual   : {_brief(row['actual'])}")
        if not row["ok"]:
            print(f"         expected : {row['expect']}")
    print("")
    print(
        f"SUMMARY main {main_pass}/{len(main_rows)} ({main_rate * 100:.1f}%)  "
        f"extra {extra_pass}/{len(extra_rows)} ({extra_rate * 100:.1f}%)  "
        f"total {total_pass}/{len(rows)} ({total_rate * 100:.1f}%)  threshold>={threshold * 100:.0f}%"
    )
    print(
        "COVERAGE tune "
        f"{coverage['tuneTargets']['covered']}/{coverage['tuneTargets']['total']}  toggle "
        f"{coverage['toggleTargets']['covered']}/{coverage['toggleTargets']['total']}  scene "
        f"{coverage['scenes']['covered']}/{coverage['scenes']['total']}  tone "
        f"{coverage['tones']['covered']}/{coverage['tones']['total']}  "
        f"eq={coverage['groups']['eq']} multi={coverage['groups']['multi']} "
        f"explainOnly={coverage['groups']['explainOnly']} miss={coverage['groups']['miss']}"
    )
    print(f"RESULT {'PASS' if passed else 'FAIL'}")

    payload = {
        "v": 1,
        "substage": "3.2",
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "python": sys.version.split()[0],
        "targets": DEFAULT_TARGETS_PATH,
        "lexicon": lexicon.path,
        "lexiconCounts": counts,
        "summary": {
            "main": {"total": len(main_rows), "passed": main_pass, "hitRate": round(main_rate, 4)},
            "extra": {"total": len(extra_rows), "passed": extra_pass, "hitRate": round(extra_rate, 4)},
            "total": {"total": len(rows), "passed": total_pass, "hitRate": round(total_rate, 4)},
            "threshold": threshold,
            "passed": passed,
        },
        "coverage": coverage,
        "rows": rows,
    }
    if artifact_path is not None:
        out = Path(artifact_path)
        if not out.is_absolute():
            # 取证文件固定落在仓库根下，从任何工作目录跑 --selftest 都写到同一处。
            out = _REPO_ROOT / out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"artifact: {out}")
    return payload


def _configure_stdout() -> None:
    # 自检输出含中文，Windows 控制台默认按本地代码页解码，这里统一成 UTF-8 便于取证。
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


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
    if not args or "--selftest" not in args:
        print("用法: python tools/voice/parser.py --selftest [--artifact <path>|--no-artifact]")
        return 2
    payload = run_selftest(artifact_path=artifact)
    return 0 if payload["summary"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
