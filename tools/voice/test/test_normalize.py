"""SubStage 2.2 单元测试：文本规范化（`tools/voice/normalize.py`）。

覆盖任务书 §6 的 5（表驱动 ≥20 条，逐条覆盖 §4.2 的规则 1–7）、6（幂等）与 §5 的边界。
运行：`python -m unittest discover -s tools/voice/test -p "test_normalize.py"`
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.voice.normalize import normalize

# (规则, 输入, 期望输出, 说明)。规则列同时用于"每条规则都被覆盖"的自检。
TABLE: tuple[tuple[int, str, str, str], ...] = (
    (1, "声音亮一点。", "声音亮一点", "句末句号"),
    (1, "声音亮一点！！", "声音亮一点", "连写句末标点一起剥"),
    (1, "“声音亮一点”", "声音亮一点", "中文引号"),
    (1, '"声音亮一点"', "声音亮一点", "ASCII 引号"),
    (1, "  声音亮一点  ", "声音亮一点", "首尾空白"),
    (2, "十八分贝", "18dB", "十位+个位"),
    (2, "第三段", "第3段", "第三段口径"),
    (2, "第六段增益3dB", "第6段增益3dB", "位次 + 已带数字的混合句"),
    (2, "二十三", "23", "二十几"),
    (2, "二十", "20", "整十"),
    (2, "十", "10", "单独的十"),
    (2, "九十九", "99", "两位数上限"),
    (2, "零", "0", "零"),
    (2, "一百零五", "105", "百位 + 零"),
    (2, "二百五十", "250", "百位 + 十位"),
    (2, "一百一十", "110", "百位 + 十位（末位不省略）"),
    (2, "一千", "1000", "整千"),
    (2, "一千零二十四", "1024", "千位 + 零 + 十位"),
    (2, "九千九百九十九", "9999", "四位上限"),
    (2, "两百", "两百", "「两」不在契约数字表里，不能被吃成 两100"),
    (2, "十千", "十千", "位权必须递减，非法写法原样保留"),
    (2, "千", "千", "缺前导数字的位权不解释（让 千赫 保持完整）"),
    (2, "一万赫兹", "1万Hz", "万及更大单位不解释（超出 0–9999）"),
    (3, "四点五", "4.5", "X点Y"),
    (3, "四点半", "4.5", "X点半"),
    (3, "四点", "4.0", "X点单独出现"),
    (3, "一点五", "1.5", "1.5 不被量词守卫吃掉"),
    (4, "负十八", "-18", "负号"),
    (4, "负十八分贝", "-18dB", "负号 + 单位（SubStage_3.2 §2 的示例）"),
    (4, "负四点五", "-4.5", "负小数"),
    (4, "负零点五", "-0.5", "负零点五"),
    (5, "千赫", "kHz", "千赫"),
    (5, "khz", "kHz", "khz 小写"),
    (5, "kHz", "kHz", "已是规范写法（幂等前提）"),
    (5, "赫兹", "Hz", "赫兹"),
    (5, "千赫兹", "kHz", "长别名优先，不吃成 千Hz"),
    (5, "毫秒", "ms", "毫秒"),
    (5, "十毫秒", "10ms", "数字 + 毫秒"),
    (5, "秒", "秒", "秒 保留"),
    (5, "分 贝", "dB", "含空格变体"),
    (5, "dB", "dB", "dB 原样"),
    (5, "DB", "dB", "全大写 DB"),
    (5, "3 kHz", "3 kHz", "空格变体不粘连"),
    (5, "提起 250 赫兹", "提起 250 Hz", "中文句里的赫兹"),
    (6, "EQ", "eq", "英文小写化"),
    (6, "把EQ调亮", "把eq调亮", "句中英文"),
    (6, "Q值", "q值", "单字母"),
    (7, "  把   声音   调亮  ", "把 声音 调亮", "空白合并"),
    (7, "声音\t亮\n一点", "声音 亮 一点", "制表符与换行"),
    (8, "嗯那个", "嗯那个", "不做语气词删除"),
    (8, "声音有点闷，帮我把低音收一点", "声音有点闷，帮我把低音收一点", "不做同义替换/纠错，句中逗号保留"),
    (8, "小唐小唐把声音调亮一点。", "小唐小唐把声音调亮一点", "不删唤醒词"),
    (8, "一点", "一点", "量词「一点」不变成 1.0"),
    (8, "声音小一点点", "声音小一点点", "「一点点」不受数字规则影响"),
    (8, "帮我调一下音色", "帮我调一下音色", "「一下」里的 一 不转成假数字（R-14 数字接地）"),
    (8, "一起调一下", "一起调一下", "「一起」同理"),
    (2, "一共三段", "一共3段", "别的位次数字照常转换"),
    (2, "一次调到三点五", "1次调到3.5", "真数量照常转换（不被惯用法守卫吃掉）"),
    (8, "十分刺耳", "十分刺耳", "「十分」是程度副词，不转数字"),
    (5, "十分贝", "10dB", "「十分贝」是真数量，照常转"),
    (5, "把二百五十赫兹压低一点", "把250Hz压低一点", ">99 中文数字 + 单位（F2 收口）"),
    (5, "一千零二十四赫兹", "1024Hz", "千位 + 单位"),
    (5, "五千赫", "5kHz", "千赫 的单位字不能被数字规则吃掉"),
    (5, "三点五毫秒", "3.5ms", "小数 + 毫秒"),
)


class NormalizeTableTest(unittest.TestCase):
    """§6.5 + §6.6：表驱动逐条断言，并对每条输入断言幂等。"""

    def test_01_table_size(self) -> None:
        self.assertGreaterEqual(len(TABLE), 20, "任务书 §6.5 要求 ≥20 条")
        self.assertEqual(len({row[1] for row in TABLE}), len(TABLE), "表里有重复输入")

    def test_02_rules_covered(self) -> None:
        """§4.2 的规则 1–7 每条至少有一条用例（规则 8 是"不做"，也要求有反例）。"""
        covered = {row[0] for row in TABLE}
        for rule in range(1, 9):
            self.assertIn(rule, covered, f"规则 {rule} 没有用例")

    def test_03_table(self) -> None:
        for rule, source, expected, note in TABLE:
            with self.subTest(rule=rule, source=source, note=note):
                self.assertEqual(normalize(source), expected, f"规则 {rule}：{note}")

    def test_04_idempotent_on_table(self) -> None:
        """§6.6：normalize(normalize(x)) == normalize(x)，逐条。"""
        for rule, source, _expected, note in TABLE:
            with self.subTest(rule=rule, source=source, note=note):
                once = normalize(source)
                self.assertEqual(normalize(once), once, f"规则 {rule} 不幂等：{note}")

    def test_05_pure(self) -> None:
        """纯函数：同样输入多次调用结果一致，且不修改入参。"""
        source = "十八分贝。"
        self.assertEqual(normalize(source), normalize(source))
        self.assertEqual(source, "十八分贝。")


class NormalizeEdgeTest(unittest.TestCase):
    """§5 的边界与错误处置。"""

    def test_11_empty_string(self) -> None:
        self.assertEqual(normalize(""), "")

    def test_12_only_punctuation(self) -> None:
        for text in ("。", "。。！", "？!", "  ...  ", "“”"):
            with self.subTest(text=text):
                self.assertEqual(normalize(text), "")

    def test_13_only_whitespace(self) -> None:
        self.assertEqual(normalize("   \t\n "), "")

    def test_14_non_string_rejected(self) -> None:
        for value in (None, 1, b"abc"):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    normalize(value)  # type: ignore[arg-type]

    def test_15_asr_output_sample(self) -> None:
        """SAPI + SenseVoice 的实测原文（调研报告 §2.3）可以直接被规范化。"""
        self.assertEqual(
            normalize("小唐小唐把声音调亮一点。"), "小唐小唐把声音调亮一点"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
