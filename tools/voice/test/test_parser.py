"""SubStage 3.2 单元测试：确定性中文解析器（`tools/voice/parser.py`）。

覆盖任务书 §6 的 8 组要求，另加边界与错误处置（§5）的用例。
运行：`python -m unittest discover -s tools/voice/test -p "test_parser.py"`
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.voice import parser as vp

_EMOJI_RE = re.compile("[\U0001f000-\U0001faff\u2600-\u27bf\ufe0f\u2b00-\u2bff]")
_TUNE_OP_KEYS = {"kind", "target", "direction", "strength"}


def _read_json(rel_path: str) -> dict:
    return json.loads((REPO_ROOT / rel_path).read_text(encoding="utf-8"))


class _DocMixin(unittest.TestCase):
    """词表与词表文档只读一次（`load_*` 带缓存，重复读也不慢）。"""

    targets: vp.TargetsDoc
    lexicon: vp.Lexicon

    @classmethod
    def setUpClass(cls) -> None:
        cls.targets = vp.load_targets()
        cls.lexicon = vp.load_lexicon()


class LexiconContractTest(_DocMixin):
    def test_01_lexicon_counts(self) -> None:
        """§6.1：词表条目数。

        §4.1 的硬要求是 `entries+switches+scenes+scenarios+tones >= 52`（实测 58），
        §7.2 的「≥ 60」只有在把 explainOnly 计进去时才成立（实测 62）。两份口径都断言，
        因为 `lexicons/zh.json` 是 3.1 的生成物，本层不许为凑数改它。
        """

        counts = vp._lexicon_counts(self.lexicon)
        self.assertEqual(counts["entries"], 26)
        self.assertEqual(counts["switches"], 14)
        self.assertEqual(counts["scenes"], 5)
        self.assertEqual(counts["scenarios"], 8)
        self.assertEqual(counts["tones"], 5)
        self.assertEqual(counts["explainOnly"], 4)
        self.assertGreaterEqual(counts["totalWithoutExplain"], 52)
        self.assertGreaterEqual(counts["total"], 60)

    def test_02_lexicon_targets_are_contract_targets(self) -> None:
        """§7.4：词表里出现的每个 target 都在 tuneTargets / toggleTargets 中。"""

        for rule in self.lexicon.entries:
            self.assertIn(rule.payload["target"], self.targets.tune)
        for rule in self.lexicon.switches:
            self.assertIn(rule.payload["target"], self.targets.toggle)
        for rule in self.lexicon.scenes:
            self.assertIn(rule.payload["scene"], self.targets.scenes)
        for rule in self.lexicon.tones:
            self.assertIn(rule.payload["tone"], self.targets.tones)
        for rule in self.lexicon.explain_only:
            self.assertIn(rule.payload["id"], self.targets.explain)

    def test_03_targets_doc_shape(self) -> None:
        """3.1 §10 回填：paramIds 是 72（不是 74），tones 是 5。"""

        self.assertEqual(len(self.targets.tune), 13)
        self.assertEqual(len(self.targets.toggle), 7)
        self.assertEqual(len(self.targets.param_ids), 72)
        self.assertEqual(len(self.targets.tones), 5)
        self.assertEqual(len(self.targets.bands), 7)
        self.assertEqual(len(self.targets.scenarios), 8)
        # 只断言契约要素，不锁定整份 tuple：3.1 会往词表里补同音异写的前缀（如「小糖小糖」）。
        self.assertIn("小唐小唐", self.targets.wake_prefixes)
        self.assertIn("小唐", self.targets.wake_prefixes)
        self.assertTrue(all(self.targets.wake_prefixes))

    def test_04_no_missing_lexicon_targets(self) -> None:
        """`load_targets` 只 warn 不抛：当前仓库应当是零缺失。"""

        self.assertEqual(vp.missing_lexicon_targets(self.targets, self.lexicon), ())


class SelftestTableTest(_DocMixin):
    def test_10_main_table(self) -> None:
        """§6.2：30 条表驱动，逐条判对。"""

        self.assertEqual(len(vp.SELFTEST_CASES), 30)
        failures = []
        for case in vp.SELFTEST_CASES:
            ok, actual = vp.evaluate_case(case, targets=self.targets)
            if not ok:
                failures.append((case.cid, case.text, vp._brief(actual)))
        self.assertEqual(failures, [])

    def test_11_extra_table(self) -> None:
        """补充分组 8 条：eq 3 / 多意图 2 / explainOnly 2 / 未命中 1。"""

        self.assertEqual(len(vp.SELFTEST_EXTRA), 8)
        groups = [case.group for case in vp.SELFTEST_EXTRA]
        self.assertEqual(groups.count("eq"), 3)
        self.assertEqual(groups.count("multi"), 2)
        self.assertEqual(groups.count("explainOnly"), 2)
        self.assertEqual(groups.count("miss"), 1)
        failures = []
        for case in vp.SELFTEST_EXTRA:
            ok, actual = vp.evaluate_case(case, targets=self.targets)
            if not ok:
                failures.append((case.cid, case.text, vp._brief(actual)))
        self.assertEqual(failures, [])

    def test_12_table_covers_every_dimension(self) -> None:
        """自检表不能悄悄丢覆盖：13 tune / 7 toggle / 5 scene / ≥4 tone。"""

        tune: set[str] = set()
        toggle: set[str] = set()
        scenes: set[str] = set()
        tones: set[str] = set()
        eq_count = multi_count = explain_count = miss_count = 0
        for case in vp.SELFTEST_CASES + vp.SELFTEST_EXTRA:
            _ok, actual = vp.evaluate_case(case, targets=self.targets)
            if actual is None:
                miss_count += 1
                continue
            if actual["status"] == "unsupported":
                explain_count += 1
            ops = actual.get("ops") or []
            if case.group == "eq":
                eq_count += 1
            if len(ops) > 1:
                multi_count += 1
            for op in ops:
                if op["kind"] == "tune":
                    tune.add(op["target"])
                elif op["kind"] == "toggle":
                    toggle.add(op["target"])
                elif op["kind"] == "scene":
                    scenes.add(op["scene"])
                elif op["kind"] == "tone":
                    tones.add(op["tone"])
        self.assertEqual(tune, set(self.targets.tune))
        self.assertEqual(toggle, set(self.targets.toggle))
        self.assertEqual(scenes, set(self.targets.scenes))
        self.assertGreaterEqual(len(tones), 4)
        self.assertEqual(eq_count, 3)
        self.assertEqual(multi_count, 2)
        self.assertEqual(explain_count, 2)
        self.assertEqual(miss_count, 2)


class AmbiguityTest(_DocMixin):
    def test_20_tone_beats_warmth_dimension(self) -> None:
        """§6.3：「温暖模式」→ tone，不是 warmth 维度。"""

        plan = vp.parse("温暖模式", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["status"], "ok")
        self.assertEqual(plan["ops"], [{"kind": "tone", "tone": "warm"}])
        self.assertNotEqual(plan["ops"][0]["kind"], "tune")

    def test_21_switch_beats_tune(self) -> None:
        """§6.3：「关掉压缩」→ toggle off，不是 compression 减弱。"""

        plan = vp.parse("关掉压缩", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"], [{"kind": "toggle", "target": "compression", "on": False}])

    def test_22_band_with_digits_is_set(self) -> None:
        """§6.3：显式数值 → set（数字接地，不带方向/档位）。"""

        plan = vp.parse("第六段增益提到3dB", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"], [{"kind": "set", "param": "eq.band6.gain", "value": 3}])
        self.assertEqual(plan["say"], "第六段增益设为 3dB")
        self.assertEqual(plan["confidence"], 1)

    def test_23_band_without_digits_is_eq(self) -> None:
        plan = vp.parse("第四段增益压一点", targets=self.targets)
        assert plan is not None
        self.assertEqual(
            plan["ops"],
            [{"kind": "eq", "band": 4, "field": "gain", "direction": "less", "strength": "slight"}],
        )

    def test_24_explain_only_beats_entries(self) -> None:
        """§4.1(0)：explainOnly 优先于 entries，且一条 op 都不许产出。"""

        plan = vp.parse("有回音，而且声音也闷", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["status"], "unsupported")
        self.assertEqual(plan["ops"], [])
        self.assertEqual(plan["say"], self.targets.explain["echo"])

    def test_25_cancel_mute_is_longest_match(self) -> None:
        """`取消静音` 不许被同一列表里的 `静音` 抢先判成 mute=on。"""

        plan = vp.parse("取消静音", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"], [{"kind": "toggle", "target": "mute", "on": False}])

    def test_26_scene_custom_wins_over_tone_custom(self) -> None:
        """「自定义模式」在 scenes 与 tones 里都有：先 scenes（口径写在完成报告里）。"""

        plan = vp.parse("自定义模式", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"], [{"kind": "scene", "scene": "custom"}])
        # 唯一能落到 tone.custom 的说法是带「音色」的那条，自检表只覆盖其余 4 个 tone。
        tone = vp.parse("自定义音色", targets=self.targets)
        assert tone is not None
        self.assertEqual(tone["ops"], [{"kind": "tone", "tone": "custom"}])

    def test_27_scenario_projects_to_base_scene(self) -> None:
        """L1 没有 scenario op：场景词表投影成 baseScene 的场景切换。"""

        for text, scene in (("我要直播", "podcast"), ("开会", "podcast"), ("我要录课", "quiet")):
            plan = vp.parse(text, targets=self.targets)
            assert plan is not None, text
            self.assertEqual(plan["ops"], [{"kind": "scene", "scene": scene}], text)

    def test_28_preset_guard_keeps_real_intent(self) -> None:
        """「唱歌的时候声音很闷」是调音，不是切场景。"""

        plan = vp.parse("唱歌的时候声音很闷", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"][0]["kind"], "tune")
        self.assertEqual(plan["ops"][0]["target"], "muddiness")


class MultiIntentTest(_DocMixin):
    def test_29_asr_variant_aliases_need_no_code_change(self) -> None:
        """ASR 同音异写的说法（3.1 补的「齿因」等）走词表就能命中，本层不改代码。"""

        canonical = vp.parse("齿音有点重", targets=self.targets)
        variant = vp.parse("齿因有点重", targets=self.targets)
        assert canonical is not None and variant is not None
        self.assertEqual(variant["ops"][0]["target"], "sibilance")
        self.assertEqual(variant["ops"][0]["direction"], "less")
        self.assertEqual(variant["ops"], canonical["ops"])

    def test_30_two_targets(self) -> None:
        """§6.4：一条句子两个 target → 两个 op（任务书样例「又闷又刺」）。

        该样例依赖 3.1 词表里 sibilance.less 的「有刺 / 又刺」（首次交付时没有，
        3.1 复补后到位）；「又闷又有齿音」走的是同一条多意图路径。
        """

        for text in ("又闷又刺", "又闷又有齿音"):
            plan = vp.parse(text, targets=self.targets)
            assert plan is not None, text
            self.assertEqual(len(plan["ops"]), 2, text)
            self.assertEqual(plan["ops"][0]["target"], "muddiness", text)
            self.assertEqual(plan["ops"][1]["target"], "sibilance", text)
            self.assertEqual({op["direction"] for op in plan["ops"]}, {"less"}, text)

    def test_31_cap_is_three(self) -> None:
        """§4.1(5)：每个 target 一个 op，最多 3 个。"""

        plan = vp.parse("声音又闷又有齿音又毛刺，还很暗", targets=self.targets)
        assert plan is not None
        self.assertEqual(len(plan["ops"]), 3)
        self.assertEqual(
            [op["target"] for op in plan["ops"]],
            ["brightness", "muddiness", "sibilance"],
        )

    def test_32_entries_array_order_is_the_contract(self) -> None:
        """「闷一点」必须命中排在前面的 muddiness.more，而不是「闷」→ less。"""

        more = vp.parse("声音闷一点", targets=self.targets)
        less = vp.parse("声音有点闷", targets=self.targets)
        assert more is not None and less is not None
        self.assertEqual(more["ops"][0]["direction"], "more")
        self.assertEqual(less["ops"][0]["direction"], "less")


class WakeWordAndControlTest(_DocMixin):
    def test_40_wake_prefix_is_stripped(self) -> None:
        """§6.5：带唤醒词与不带唤醒词结果相同。"""

        with_wake = vp.parse("小唐小唐，声音亮一点", targets=self.targets)
        without = vp.parse("声音亮一点", targets=self.targets)
        self.assertEqual(with_wake, without)
        self.assertIsNotNone(without)

    def test_43_variant_wake_prefix_parses_identically(self) -> None:
        """同音异写的唤醒前缀（3.1 补的「小糖小糖」）结果必须与正写一致。

        前缀走了 `targets.wakePrefixes`：词表还没收它时，它也只是一段不含任何说法的
        噪声，所以两种写法在补与未补两种状态下都应当得到同一份 plan。
        """

        canonical = vp.parse("小唐小唐，声音亮一点", targets=self.targets)
        variant = vp.parse("小糖小糖，声音亮一点", targets=self.targets)
        self.assertEqual(variant, canonical)
        self.assertIsNotNone(variant)

    def test_41_parse_control(self) -> None:
        """§6.7：确认 / 撤销 / 都不是。"""

        self.assertEqual(vp.parse_control("确认"), "confirm")
        self.assertEqual(vp.parse_control("好"), "confirm")
        self.assertEqual(vp.parse_control("撤销"), "undo")
        self.assertEqual(vp.parse_control("回到上一步"), "undo")
        self.assertIsNone(vp.parse_control("声音亮一点"))
        self.assertIsNone(vp.parse_control(""))

    def test_42_undo_wins_over_confirm(self) -> None:
        """同时出现时取安全侧：撤销不写参数。"""

        self.assertEqual(vp.parse_control("好，撤销"), "undo")


class InlinePunctuationTest(_DocMixin):
    """ASR 会在词中间插逗号（2.2 实测 `第六段，增益提高3dB`）；本层负责句中清洗。"""

    def test_44_mid_sentence_comma_keeps_band_addressing(self) -> None:
        plan = vp.parse("第六段，增益提高3dB", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"], [{"kind": "set", "param": "eq.band6.gain", "value": 3}])
        self.assertEqual(plan["say"], "第六段增益设为 3dB")

    def test_45_mid_sentence_comma_keeps_tune(self) -> None:
        plan = vp.parse("声音有点闷，化开一点", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"][0]["kind"], "tune")
        self.assertEqual(plan["ops"][0]["target"], "muddiness")
        self.assertEqual(plan["ops"][0]["direction"], "less")

    def test_46_decimal_point_is_preserved(self) -> None:
        """只删"两侧不都是数字"的点号：`3.5` 必须原样。"""

        plan = vp.parse("第4段增益提到3.5dB", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"], [{"kind": "set", "param": "eq.band4.gain", "value": 3.5}])
        self.assertEqual(vp._normalize_text("3.5"), "3.5")

    def test_47_zero_width_chars_are_dropped(self) -> None:
        plan = vp.parse("声\u200b音有\u200d点闷\ufeff", targets=self.targets)
        self.assertEqual(plan, vp.parse("声音有点闷", targets=self.targets))

    def test_48_normalize_is_idempotent(self) -> None:
        samples = (
            "第六段，增益提高3dB",
            "把250赫兹，压低一点。",
            "声音有点闷，化开一点",
            "第4段增益提到3.5dB",
            "\u200b小唐小唐，声音亮一点？",
            "，。",
            "",
        )
        for sample in samples:
            once = vp._normalize_text(sample)
            self.assertEqual(vp._normalize_text(once), once, sample)

    def test_49_hz_with_comma(self) -> None:
        plan = vp.parse("把250赫兹，压低一点", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"][0]["kind"], "eq")
        self.assertEqual(plan["ops"][0]["centerHz"], 250)
        self.assertEqual(plan["ops"][0]["direction"], "less")


class MissTest(_DocMixin):
    def test_50_unrelated_text(self) -> None:
        """§6.6：与调参无关 → None（调用方转 LLM）。"""

        for text in ("放首歌", "今天天气怎么样", "我觉得还行"):
            self.assertIsNone(vp.parse(text, targets=self.targets), text)

    def test_51_empty_and_punctuation(self) -> None:
        for text in ("", "   ", "\n\t", "，。", None):
            self.assertIsNone(vp.parse(text, targets=self.targets), repr(text))


class ErrorHandlingTest(_DocMixin):
    def test_60_missing_lexicon_raises(self) -> None:
        missing = str(REPO_ROOT / "tools" / "voice" / "lexicons" / "__nope__.json")
        with self.assertRaises(FileNotFoundError):
            vp.parse("声音亮一点", targets=self.targets, lexicon_path=missing)

    def test_61_broken_lexicon_json_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "zh.json"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ValueError):
                vp.load_lexicon(str(path))

    def test_62_lexicon_missing_key_raises(self) -> None:
        raw = _read_json(vp.DEFAULT_LEXICON_PATH)
        for broken in ({k: v for k, v in raw.items() if k != "bandParam"},
                       {**raw, "entries": [{"target": "muddiness"}]}):
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "zh.json"
                path.write_text(json.dumps(broken, ensure_ascii=False), encoding="utf-8")
                with self.assertRaises(ValueError):
                    vp.load_lexicon(str(path))

    def test_63_set_dropped_when_param_not_in_targets(self) -> None:
        """§5：param 不在 paramIds → 丢弃该 op；全丢即 None。"""

        raw = _read_json(vp.DEFAULT_TARGETS_PATH)
        raw["paramIds"] = [pid for pid in raw["paramIds"] if pid != "eq.band6.gain"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "targets.json"
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            doc = vp.load_targets(str(path))
            self.assertIsNone(vp.parse("第六段增益提到3dB", targets=doc))

    def test_64_set_dropped_when_band_out_of_range(self) -> None:
        """§5：band 号不在 1..7 → 丢弃该 op；全丢即 None。"""

        raw = _read_json(vp.DEFAULT_LEXICON_PATH)
        raw["bandParam"] = "第(?P<band>\\d+)段(?P<field>增益|频率|q值|带宽)?"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "zh.json"
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            self.assertIsNone(
                vp.parse("第9段增益3dB", targets=self.targets, lexicon_path=str(path))
            )

    def test_65_set_needs_grounded_number(self) -> None:
        """§4.1(6)：没有数字就不是 set（退回 eq），不会凭空造 value。"""

        plan = vp.parse("第六段增益提到很高", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"][0]["kind"], "eq")
        self.assertNotIn("value", plan["ops"][0])


class PayloadTest(_DocMixin):
    def test_70_tune_op_carries_no_numbers(self) -> None:
        """本层不产出 dB/Hz：tune op 的键只有 kind/target/direction/strength。"""

        plan = vp.parse("声音有点闷", targets=self.targets)
        assert plan is not None
        self.assertEqual(set(plan["ops"][0]), _TUNE_OP_KEYS)
        self.assertEqual(set(plan), {"v", "status", "say", "confidence", "ops"})
        self.assertEqual(plan["v"], 1)
        self.assertEqual(plan["confidence"], 1)

    def test_71_say_limits(self) -> None:
        """§4.2：say 短、中文、无 emoji；tune/scene/tone/toggle/set/eq 都要 ≤ 30 字。"""

        texts = [case.text for case in vp.SELFTEST_CASES + vp.SELFTEST_EXTRA]
        checked = 0
        for text in texts:
            plan = vp.parse(text, targets=self.targets)
            if plan is None or plan["status"] != "ok":
                continue
            checked += 1
            self.assertLessEqual(len(plan["say"]), 30, (text, plan["say"]))
            self.assertIsNone(_EMOJI_RE.search(plan["say"]), text)
        self.assertGreaterEqual(checked, 34)

    def test_72_explain_say_comes_from_targets(self) -> None:
        """§4.1(0)：say 用 `targets.json` 里该项的 explain。"""

        cases = {"房间里有回音": "echo", "喷麦": "plosive", "嗡嗡声": "hum", "耳机漏音": "bgm"}
        for text, identity in cases.items():
            plan = vp.parse(text, targets=self.targets)
            assert plan is not None, text
            self.assertEqual(plan["status"], "unsupported")
            self.assertEqual(plan["ops"], [])
            self.assertEqual(plan["say"], self.targets.explain[identity])

    def test_73_hpf_lpf_band_is_unsupported(self) -> None:
        """§4.1(3c)：centerHz 落在 band1/band2（HPF/LPF）→ unsupported + 固定话术。"""

        for text in ("50赫兹压一点", "20000赫兹压一点"):
            plan = vp.parse(text, targets=self.targets)
            assert plan is not None, text
            self.assertEqual(plan["status"], "unsupported")
            self.assertEqual(plan["say"], "那是滤波器，不是均衡段")

    def test_74_hz_addressing_maps_to_peak_band(self) -> None:
        plan = vp.parse("250赫兹压一点", targets=self.targets)
        assert plan is not None
        self.assertEqual(plan["ops"][0]["kind"], "eq")
        self.assertEqual(plan["ops"][0]["centerHz"], 250)
        self.assertEqual(plan["ops"][0]["field"], "gain")

    def test_75_strength_words(self) -> None:
        """档位来自词表的 strengthWords（"有点"按 slight 处理，见报告）。"""

        slight = vp.parse("声音有点闷", targets=self.targets)
        medium = vp.parse("声音闷", targets=self.targets)
        strong = vp.parse("声音非常闷", targets=self.targets)
        assert slight is not None and medium is not None and strong is not None
        self.assertEqual(slight["ops"][0]["strength"], "slight")
        self.assertEqual(medium["ops"][0]["strength"], "medium")
        self.assertEqual(strong["ops"][0]["strength"], "strong")


class PerformanceTest(_DocMixin):
    def test_80_parse_under_5ms(self) -> None:
        """§6.8：单条解析 ≤ 5 ms（1000 次取均值）。"""

        text = "声音有点闷"
        vp.parse(text, targets=self.targets)  # 预热词表缓存
        rounds = 1000
        started = time.perf_counter()
        for _ in range(rounds):
            vp.parse(text, targets=self.targets)
        average_ms = (time.perf_counter() - started) / rounds * 1000
        self.assertLess(average_ms, 5.0, f"平均 {average_ms:.3f} ms")


if __name__ == "__main__":
    unittest.main()
