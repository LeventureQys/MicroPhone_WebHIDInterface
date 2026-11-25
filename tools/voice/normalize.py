"""文本规范化：把 ASR 原文统一成意图层可以直接消费的写法。

契约来源：`Document/Update/Alpha/v1.3.0/开发文档/SubStage_2.2.md` §4.2（8 步，**顺序敏感**）。

本模块是纯函数、无全局状态、幂等；**不做**同义词替换 / 去语气词 / 断句 / 纠错——
这些属于 SubStage 3.2 的别名表，两处都改会让行为不可预测（任务书 §4.3、§8）。
"""

from __future__ import annotations

import re

__all__ = ["normalize"]

# --------------------------------------------------------------------------- 规则 1
# 句末标点：全角句号、全角点、半角点、全角感叹/问号、半角感叹/问号。
_TRAILING_PUNCT = frozenset("。．.！!？?")

# 引号：ASCII 单双引号、中文弯引号、直角引号。句中与句末都会出现，一次性全去。
_QUOTES_RE = re.compile("[\"'“”‘’「」『』]")

# --------------------------------------------------------------------------- 规则 2
_CN_DIGITS = {
    "零": 0,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_CN_NUM_CHARS = "".join(_CN_DIGITS) + "十百千"
_CN_RUN_RE = re.compile("[" + _CN_NUM_CHARS + "]+")

# 位权字符。解析规则：位权必须严格递减（"十千" 不成立），整段以十开头的（"十八"）允许，
# 以百/千开头的（"百二十"、"千"）不算数——中文口语里那种说法都会带前导数字（一百二十），
# 而"两"不在契约数字表里，"两百"必须原样留着，不能被吃成"两100"。
_CN_UNIT_VALUES = {"十": 10, "百": 100, "千": 1000}

# 规则 2 里要先藏起来的单位别名：「千赫/千赫兹」的「千」是单位的一部分（"五千赫" = 5 kHz），
# 不藏起来会被当数字吃掉，变成 "5000赫"。
_NUMERAL_UNIT_SAFE_RE = re.compile(r"千\s*赫\s*兹?")

# "一点" 是量词（"小一点"/"亮一点"），不是 1.0。判断方式是看「点」后面是否紧跟数字或「半」。
_AFTER_DIAN_DIGITS = frozenset("0123456789半") | frozenset(_CN_NUM_CHARS)

# "一下/一样/一起/一定/一般/一共/一直/一些/一会儿" 里的 "一" 也不是数量：
# 转成 "1下" 既不自然，又会让设计文档 R-14 的「数字接地」凭空多出一个用户没说过的 1
# （"帮我调一下低频到3dB" 变成 "…1下…"，`set value=1` 就会被误判成"用户说过"）。
# 「点」不在这里：它由上面的 一点/一点五 分支单独判断。
_YI_IDIOM_TAILS = frozenset("下样起定般共直些会儿")

# --------------------------------------------------------------------------- 规则 3
_POINT_HALF_RE = re.compile(r"(\d+)\s*点\s*半")
_POINT_DECIMAL_RE = re.compile(r"(\d+)\s*点\s*(\d+)")
_POINT_BARE_RE = re.compile(r"(\d+)\s*点(?![\d半])")

# --------------------------------------------------------------------------- 规则 4
_NEGATIVE_RE = re.compile(r"负\s*(\d+(?:\.\d+)?)")

# --------------------------------------------------------------------------- 规则 5
# 单位别名 -> 契约字面值。顺序即优先级：长别名（千赫/khz）必须先于短别名（赫兹/hz），
# 否则 "千赫兹" 会被 "赫兹 -> Hz" 吃掉前半截，留下 "千Hz"。
# ASCII 别名大小写不敏感，因为契约把 "dB"/"kHz" 写成混合大小写：
# 若只匹配小写，规整后的 "kHz" 会在规则 6 被降成 "khz"，再跑一遍又被抬回 "kHz"，幂等性直接崩。
_UNIT_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"千\s*赫\s*兹?"), "kHz"),
    (re.compile(r"(?<![A-Za-z])k\s*hz(?![A-Za-z])", re.IGNORECASE), "kHz"),
    (re.compile(r"赫\s*兹"), "Hz"),
    (re.compile(r"(?<![A-Za-z])hz(?![A-Za-z])", re.IGNORECASE), "Hz"),
    (re.compile(r"分\s*贝"), "dB"),
    (re.compile(r"(?<![A-Za-z])d\s*b(?![A-Za-z])", re.IGNORECASE), "dB"),
    (re.compile(r"毫\s*秒"), "ms"),
    (re.compile(r"(?<![A-Za-z])ms(?![A-Za-z])", re.IGNORECASE), "ms"),
)

# 规则 5 的产物（dB/Hz/kHz/ms 带大小写）必须原样活到输出，所以先用私用区哨兵占位，
# 让规则 6 的 ASCII 小写化碰不到它们，最后再还原。
_SENTINEL_OPEN = "\ue000"
_SENTINEL_CLOSE = "\ue001"
_SENTINEL_RE = re.compile(_SENTINEL_OPEN + r"(\d+)" + _SENTINEL_CLOSE)

# --------------------------------------------------------------------------- 规则 6
_ASCII_UPPER_RE = re.compile(r"[A-Z]+")

# --------------------------------------------------------------------------- 规则 7
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_edges(text: str) -> str:
    """规则 1：去引号、去首尾空白、去句末标点（连写的 "。！" 也剥干净）。"""
    stripped = _QUOTES_RE.sub("", text).strip()
    while stripped and stripped[-1] in _TRAILING_PUNCT:
        stripped = stripped[:-1].rstrip()
    return stripped


def _cn_run_to_arabic(run: str) -> str | None:
    """把一段中文数字（0–9999）转成阿拉伯数字串；无法解释时返回 None（原样保留）。

    支持 `十八` / `二十` / `二十三` / `二百五十` / `一千零二十四` / `九千九百九十九`；
    `两` 不在契约数字表里（`两百` 原样留着），`万` 及更大单位不解释。
    """
    if not any(ch in _CN_UNIT_VALUES for ch in run):
        # 没有 十/百/千 的连写（"一二"）：按位拼接，保留前导零。
        return "".join(str(_CN_DIGITS[ch]) for ch in run)

    if run[0] in _CN_UNIT_VALUES and run[0] != "十":
        # "百二十"/"千" 这类缺前导数字的写法不解释：口语里会写成 "一百二十"，
        # 而"两百"的"两"不在数字表里，放开这条会把 "两百" 吃成 "两100"。
        return None

    total = 0
    section = 0
    last_unit = 0
    for ch in run:
        if ch in _CN_DIGITS:
            section = _CN_DIGITS[ch]
            continue
        unit = _CN_UNIT_VALUES[ch]
        if last_unit and unit >= last_unit:
            return None  # 位权必须严格递减（"十千" 不成立）
        if section == 0:
            section = 1  # "十八"/"一千"：位权前没写数字就是 1
        total += section * unit
        section = 0
        last_unit = unit
    total += section
    if total > 9999:
        return None
    return str(total)


def _protect(text: str, pattern: re.Pattern[str]) -> tuple[str, list[str]]:
    """把匹配到的片段换成哨兵占位，返回（占位后的文本, 按序对应的原文片段）。"""
    literals: list[str] = []

    def replace(match: re.Match[str]) -> str:
        literals.append(match.group(0))
        return _SENTINEL_OPEN + str(len(literals) - 1) + _SENTINEL_CLOSE

    return pattern.sub(replace, text), literals


def _to_arabic(text: str) -> str:
    """规则 2：中文数字 0–9999 -> 阿拉伯数字（"十八" -> "18"、"第三段" -> "第3段"）。"""

    def replace(match: re.Match[str]) -> str:
        run = match.group(0)
        # "一点"/"小一点" 是量词：转成 "1点" 会被规则 3 变成 "1.0"，
        # 既打掉 3.2 词表里的 strengthWords（lexicons/zh.json 收了 "一点"、"小一点"），
        # 又会给设计文档 R-14 的「数字接地」提供一个用户没说过的数字。
        if run == "一":
            tail = text[match.end() : match.end() + 1]
            if tail == "点":
                if text[match.end() + 1 : match.end() + 2] not in _AFTER_DIAN_DIGITS:
                    return run
            elif tail in _YI_IDIOM_TAILS:
                return run
        # "十分刺耳"/"十分钟" 的 "十" 是程度/时间副词，不是数字；
        # 但 "十分贝" 必须照常转成 10dB（后面跟的是单位）。
        if run == "十" and text[match.end() : match.end() + 1] == "分":
            if text[match.end() + 1 : match.end() + 2] != "贝":
                return run
        converted = _cn_run_to_arabic(run)
        return run if converted is None else converted

    # "五千赫" 的「千」属于规则 5 的单位别名，先藏起来（否则会变成 "5000赫"）。
    text, protected = _protect(text, _NUMERAL_UNIT_SAFE_RE)
    text = _CN_RUN_RE.sub(replace, text)
    return _restore(text, protected)


def _to_decimal(text: str) -> str:
    """规则 3：小数（"四点五" -> "4.5"、"四点半" -> "4.5"、"四点" -> "4.0"）。"""
    text = _POINT_HALF_RE.sub(lambda m: m.group(1) + ".5", text)
    text = _POINT_DECIMAL_RE.sub(lambda m: m.group(1) + "." + m.group(2), text)
    return _POINT_BARE_RE.sub(lambda m: m.group(1) + ".0", text)


def _to_negative(text: str) -> str:
    """规则 4：负号（"负十八" -> "-18"）。"""
    return _NEGATIVE_RE.sub(lambda m: "-" + m.group(1), text)


def _apply_units(text: str) -> tuple[str, list[str]]:
    """规则 5：单位统一，返回（带占位符的文本, 占位符按序对应的契约字面值）。"""
    literals: list[str] = []

    for pattern, literal in _UNIT_RULES:
        def replace(_match: re.Match[str], _literal: str = literal) -> str:
            literals.append(_literal)
            return _SENTINEL_OPEN + str(len(literals) - 1) + _SENTINEL_CLOSE

        text = pattern.sub(replace, text)
    return text, literals


def _lower_ascii(text: str) -> str:
    """规则 6：只把 ASCII 大写字母降成小写（不碰全角字母，也不碰规则 5 的字面值）。"""
    return _ASCII_UPPER_RE.sub(lambda m: m.group(0).lower(), text)


def _restore(text: str, literals: list[str]) -> str:
    """把哨兵占位换回原文片段（规则 2 的单位别名、规则 5 的契约字面值共用）。"""
    return _SENTINEL_RE.sub(lambda m: literals[int(m.group(1))], text)


def _squeeze_spaces(text: str) -> str:
    """规则 7：多余空白合并成一个空格，并去掉首尾空白。"""
    return _WHITESPACE_RE.sub(" ", text).strip()


def normalize(text: str) -> str:
    """把 ASR 原文规范化成意图层的输入写法（幂等、纯函数）。

    规则 8（明确不做）：同义词替换、去语气词、断句、纠错。
    """
    if not isinstance(text, str):
        raise TypeError(f"normalize 只接受 str，收到 {type(text).__name__}")
    if not text:
        return ""

    result = _strip_edges(text)  # 1
    if not result:
        return ""
    result = _to_arabic(result)  # 2
    result = _to_decimal(result)  # 3
    result = _to_negative(result)  # 4
    result, literals = _apply_units(result)  # 5
    result = _lower_ascii(result)  # 6
    result = _restore(result, literals)  # 6 收尾：还原被保护的契约字面值
    return _squeeze_spaces(result)  # 7
