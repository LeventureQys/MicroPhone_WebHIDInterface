#!/usr/bin/env python
"""SubStage 5.2 §6 的训练侧小单测（不碰 GPU、不加载权重、不 import torch）。

跑法（用 .venv-train 的 python，跑完不留缓存）：
  tools\\voice\\.venv-train\\Scripts\\python.exe -m unittest discover -s tools\\voice\\train -p "test_*.py" -v

测的是"闸门"而不是"训练能不能收敛"：样本构造逐字合规、label 掩码正确、配置校验与退出码符合 §4.1/§5。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

TRAIN_DIR = Path(__file__).resolve().parent
if str(TRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(TRAIN_DIR))

import qlora  # noqa: E402  （路径先插好再导入）


class SampleConstructionTest(unittest.TestCase):
    """§4.1：三段 messages 与只对 assistant 段算 loss。"""

    def setUp(self) -> None:
        self.system_text = qlora.VOICE_DIR.joinpath("prompts", "system.zh.txt").read_text(encoding="utf-8")
        self.row = {
            "id": "unit-1",
            "text": "有点闷",
            "plan": {
                "v": 1,
                "status": "ok",
                "say": "把闷的地方收一收",
                "confidence": 1,
                "ops": [{"kind": "tune", "target": "muddiness", "direction": "less", "strength": "slight"}],
            },
        }

    def test_messages_are_exactly_three_segments(self) -> None:
        state_line = "当前：降噪档位=2，压缩阈值=-18dB，限制器阈值=-2.0dB，噪声门阈值=-41dB，增益=[0,0,0,0,0,0,0]dB"
        messages = qlora.build_messages(self.row, self.system_text, state_line)

        self.assertEqual([item["role"] for item in messages], ["system", "user", "assistant"])
        # system 必须与 prompts/system.zh.txt 逐字节相同（推理侧用的就是这一份）
        self.assertEqual(messages[0]["content"], self.system_text)
        # user = 快照行 + 换行 + 句子
        self.assertEqual(messages[1]["content"], f"{state_line}\n有点闷")
        # assistant = 紧凑 JSON，键顺序固定 v,status,ops,say,confidence
        self.assertEqual(
            messages[2]["content"],
            '{"v":1,"status":"ok","ops":[{"kind":"tune","target":"muddiness","direction":"less","strength":"slight"}],"say":"把闷的地方收一收","confidence":1}',
        )
        self.assertNotIn(" ", messages[2]["content"].replace("把闷的地方收一收", ""))

    def test_clarify_keeps_question_between_ops_and_say(self) -> None:
        plan = {"v": 1, "status": "clarify", "ops": [], "question": "想调哪里？", "say": "", "confidence": 0.5}
        text = qlora.compact_plan(plan)
        self.assertEqual(text, '{"v":1,"status":"clarify","ops":[],"question":"想调哪里？","say":"","confidence":0.5}')

    def test_eq_op_field_order_matches_system_prompt(self) -> None:
        op = {"field": "gain", "strength": "medium", "direction": "less", "band": 4, "kind": "eq"}
        self.assertEqual(list(qlora.order_op(op).keys()), ["kind", "band", "direction", "strength", "field"])

    def test_labels_mask_the_prompt_segment(self) -> None:
        prompt_ids = [11, 12, 13, 14, 15]
        answer_ids = [91, 92, 93]
        sample = qlora.build_sample(
            self.row,
            self.system_text,
            "当前：降噪档位=1，压缩阈值=-18dB，限制器阈值=-2.0dB，噪声门阈值=-41dB，增益=[0,0,0,0,0,0,0]dB",
            encode_prompt=lambda _messages: list(prompt_ids),
            encode_answer=lambda _text: list(answer_ids),
            end_of_turn="<|im_end|>",
            max_len=64,
        )
        self.assertEqual(sample["input_ids"], prompt_ids + answer_ids)
        self.assertEqual(sample["labels"][: len(prompt_ids)], [qlora.IGNORE_INDEX] * len(prompt_ids))
        self.assertEqual(sample["labels"][len(prompt_ids) :], answer_ids)

    def test_truncation_keeps_the_whole_answer(self) -> None:
        prompt_ids = [1, 2, 3, 4, 5]
        answer_ids = [8, 9, 10]
        sample = qlora.build_sample(
            self.row,
            self.system_text,
            "当前：降噪档位=1，压缩阈值=-18dB，限制器阈值=-2.0dB，噪声门阈值=-41dB，增益=[0,0,0,0,0,0,0]dB",
            encode_prompt=lambda _messages: list(prompt_ids),
            encode_answer=lambda _text: list(answer_ids),
            end_of_turn="<|im_end|>",
            max_len=6,
        )
        self.assertEqual(len(sample["input_ids"]), 6)
        self.assertEqual(sample["input_ids"], [3, 4, 5] + answer_ids)
        self.assertEqual(sample["labels"], [qlora.IGNORE_INDEX, qlora.IGNORE_INDEX, qlora.IGNORE_INDEX] + answer_ids)

    def test_answer_longer_than_max_len_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            qlora.build_sample(
                self.row,
                self.system_text,
                "当前：x",
                encode_prompt=lambda _messages: [1],
                encode_answer=lambda _text: [7, 8, 9],
                end_of_turn="<|im_end|>",
                max_len=3,
            )

    def test_snapshot_line_matches_inference_format(self) -> None:
        import random

        line = qlora.snapshot_line(random.Random(1))
        self.assertTrue(line.startswith("当前：降噪档位="))
        self.assertIn("，压缩阈值=", line)
        self.assertIn("dB，限制器阈值=", line)
        self.assertIn("dB，噪声门阈值=", line)
        self.assertIn("dB，增益=[", line)
        self.assertRegex(line, r"增益=\[(-?\d+,){6}-?\d+\]dB$")
        # 同一 seed 必须得到同一行（训练可复现）
        self.assertEqual(line, qlora.snapshot_line(random.Random(1)))


class ConfigTest(unittest.TestCase):
    """§4.1：字段固定；§6 单测 2：r ≤ 64、lr ≤ 5e-4。"""

    def setUp(self) -> None:
        self.cfg = qlora.load_config(qlora.DEFAULT_CONFIG_PATH)

    def test_shipped_config_is_valid(self) -> None:
        self.assertEqual(qlora.validate_config(self.cfg), [])
        self.assertEqual(self.cfg["v"], 1)
        self.assertLessEqual(self.cfg["lora"]["r"], 64)
        self.assertLessEqual(self.cfg["train"]["lr"], 5e-4)

    def test_rank_above_64_is_rejected(self) -> None:
        self.cfg["lora"]["r"] = 128
        problems = qlora.validate_config(self.cfg)
        self.assertTrue(any("lora.r" in item for item in problems), problems)

    def test_lr_above_5e_4_is_rejected(self) -> None:
        self.cfg["train"]["lr"] = 1e-3
        problems = qlora.validate_config(self.cfg)
        self.assertTrue(any("train.lr" in item for item in problems), problems)

    def test_missing_field_is_rejected(self) -> None:
        del self.cfg["quant"]
        problems = qlora.validate_config(self.cfg)
        self.assertTrue(any("quant" in item for item in problems), problems)

    def test_max_len_fits_the_real_system_prompt(self) -> None:
        """maxLen 必须容得下 system.zh.txt + 答句（否则训练样本会被截掉大半个系统提示词）。

        实测（Qwen3 tokenizer，2026-11-24，见 artifacts/voice/substage-5.2/measure-tokens.log）：
        system.zh.txt = 3570 字 = 1807 token；4549 条样本全长 max 1989 / p99 1978 / p50 1932。
        任务书 §4.1 给的 512 连系统提示词的三分之一都放不下，这里用实测值兜住。
        """
        measured_sample_max_tokens = 1989
        self.assertGreaterEqual(
            self.cfg["train"]["maxLen"],
            measured_sample_max_tokens,
            f"maxLen={self.cfg['train']['maxLen']} 容不下实测最长样本 {measured_sample_max_tokens} token",
        )


    def test_runtime_block_documents_the_real_run(self) -> None:
        """runtime 记录本机实测结论（4bit 更慢 → bf16），有效 batch 必须还是 16。"""
        runtime = self.cfg.get("runtime") or {}
        self.assertEqual(runtime.get("dtype"), "bf16")
        self.assertEqual(runtime["effectiveBatch"], runtime["batchSize"] * runtime["gradAccum"])
        self.assertEqual(runtime["effectiveBatch"], 16)

    def test_inconsistent_runtime_is_rejected(self) -> None:
        self.cfg["runtime"]["effectiveBatch"] = 8
        problems = qlora.validate_config(self.cfg)
        self.assertTrue(any("runtime.effectiveBatch" in item for item in problems), problems)

    def test_bad_runtime_dtype_is_rejected(self) -> None:
        self.cfg["runtime"]["dtype"] = "fp8"
        problems = qlora.validate_config(self.cfg)
        self.assertTrue(any("runtime.dtype" in item for item in problems), problems)


class VenvCheckTest(unittest.TestCase):
    """§5：不是 .venv-train 的解释器 → 中文提示 + 退出码 1。"""

    def test_foreign_prefix_returns_exit_code_1(self) -> None:
        self.assertEqual(qlora.check_train_venv(prefix=str(Path(sys.base_prefix))), qlora.EXIT_NO_TRAIN_VENV)
        self.assertEqual(qlora.EXIT_NO_TRAIN_VENV, 1)

    def test_train_venv_prefix_passes(self) -> None:
        self.assertEqual(qlora.check_train_venv(prefix=str(qlora.TRAIN_VENV_DIR)), qlora.EXIT_OK)


class DataTest(unittest.TestCase):
    """§4.1 的语料本体：一行一个对象，text 与 plan 必填。"""

    def test_first_train_row_has_text_and_plan(self) -> None:
        rows = qlora.read_jsonl(qlora.VOICE_DIR / "data" / "train.jsonl")
        self.assertGreater(len(rows), 4000)
        self.assertIn("text", rows[0])
        self.assertIn("plan", rows[0])
        self.assertEqual(json.loads(json.dumps(rows[0]["plan"]))["v"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
