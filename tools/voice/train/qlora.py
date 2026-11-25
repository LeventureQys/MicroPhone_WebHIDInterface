#!/usr/bin/env python
"""SubStage 5.2：Qwen3-1.7B 的 QLoRA 训练脚本。

契约来源：SubStage_5.2 §4.1（样本构造逐字固定）、§4.2（命令行 / 落盘 / 训练参数）、§5（错误码）。
只在 tools/voice/.venv-train 里跑：推理侧 tools/voice/.venv 不许出现 torch（设计文档 §2.4）。

为什么模块顶层不 import torch/transformers：单测（tools/voice/train/test_train.py）要在不碰 GPU、
不加载 3.4 GB 权重的条件下验证样本构造与配置校验，所以重依赖一律在 main() 里按需 import。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
VOICE_DIR = REPO_ROOT / "tools" / "voice"
DEFAULT_CONFIG_PATH = VOICE_DIR / "train" / "config.json"
TRAIN_VENV_DIR = VOICE_DIR / ".venv-train"

EXIT_OK = 0
EXIT_NO_TRAIN_VENV = 1
EXIT_BAD_CONFIG = 2
EXIT_BAD_DATA = 3
EXIT_NO_GPU = 6
EXIT_OOM = 7
EXIT_NAN = 8

SMOKE_STEPS = 20
EVAL_ROWS = 100
IGNORE_INDEX = -100

# 与 llama-server 的 --chat-template-kwargs {"enable_thinking":false} 对应：GGUF 内嵌模板
# 在 add_generation_prompt 时会补 '<think>\n\n</think>\n\n'，训练必须用同一份模板同一组参数，
# 否则学生模型看到的助手起始前缀与推理时不同（5.3 的 ft 档就会掉分）。
CHAT_TEMPLATE_KWARGS: dict[str, Any] = {"enable_thinking": False}

# op 字段顺序：与 prompts/system.zh.txt 里列出的 8 种形态一致（推理侧也是这个顺序）。
OP_FIELD_ORDER: dict[str, tuple[str, ...]] = {
    "tune": ("kind", "target", "direction", "strength"),
    "eq": ("kind", "band", "centerHz", "direction", "strength", "field"),
    "toggle": ("kind", "target", "on"),
    "set": ("kind", "param", "value"),
    "scene": ("kind", "scene"),
    "tone": ("kind", "tone"),
    "undo": ("kind",),
}


class ConfigError(ValueError):
    """train/config.json 不合契约（§4.1 字段固定）。"""


class NanLossError(RuntimeError):
    """训练 loss 变成 NaN/Inf：立刻停，避免白烧 GPU。"""


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


def resolve_path(value: str | Path) -> Path:
    """配置里的路径一律相对仓库根，绝对路径原样返回。"""
    path = Path(value)
    return path if path.is_absolute() else (REPO_ROOT / path)


def env_int(name: str, default: int) -> int:
    """本机显存不够时的命令行外覆盖（§5 的 OOM 退路要能一次配到 batch 1 / accum 16）。"""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"环境变量 {name}={raw!r} 不是整数") from exc


def validate_config(cfg: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if not isinstance(cfg, dict):
        return ["配置顶层不是对象"]
    for key in ("v", "base", "data", "out", "lora", "train", "quant"):
        if key not in cfg:
            problems.append(f"缺少字段 {key}")
    if problems:
        return problems
    if cfg["v"] != 1:
        problems.append(f"v 应为 1（实为 {cfg['v']!r}）")
    for key in ("base", "data", "out"):
        if not isinstance(cfg[key], str) or not cfg[key].strip():
            problems.append(f"{key} 必须是非空字符串")

    lora = cfg["lora"]
    if not isinstance(lora, dict):
        return problems + ["lora 不是对象"]
    rank = lora.get("r")
    if not isinstance(rank, int) or isinstance(rank, bool) or not (1 <= rank <= 64):
        problems.append(f"lora.r 必须是 1..64 的整数（实为 {rank!r}）")
    alpha = lora.get("alpha")
    if not isinstance(alpha, int) or isinstance(alpha, bool) or alpha <= 0:
        problems.append(f"lora.alpha 必须是正整数（实为 {alpha!r}）")
    dropout = lora.get("dropout")
    if not isinstance(dropout, (int, float)) or isinstance(dropout, bool) or not (0.0 <= float(dropout) < 1.0):
        problems.append(f"lora.dropout 必须在 [0,1)（实为 {dropout!r}）")
    modules = lora.get("target_modules")
    if not isinstance(modules, list) or not modules or not all(isinstance(m, str) and m for m in modules):
        problems.append("lora.target_modules 必须是非空字符串数组")

    train = cfg["train"]
    if not isinstance(train, dict):
        return problems + ["train 不是对象"]
    for key in ("epochs", "batchSize", "gradAccum", "lr", "maxLen", "warmupRatio", "seed"):
        if key not in train:
            problems.append(f"train 缺少字段 {key}")
    epochs = train.get("epochs")
    if not isinstance(epochs, int) or isinstance(epochs, bool) or epochs < 1:
        problems.append(f"train.epochs 必须是 ≥1 的整数（实为 {epochs!r}）")
    for key in ("batchSize", "gradAccum"):
        value = train.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            problems.append(f"train.{key} 必须是 ≥1 的整数（实为 {value!r}）")
    lr = train.get("lr")
    if not isinstance(lr, (int, float)) or isinstance(lr, bool) or not (0.0 < float(lr) <= 5e-4):
        problems.append(f"train.lr 必须在 (0,5e-4]（实为 {lr!r}）")
    max_len = train.get("maxLen")
    if not isinstance(max_len, int) or isinstance(max_len, bool) or max_len < 64:
        problems.append(f"train.maxLen 必须是 ≥64 的整数（实为 {max_len!r}）")
    warmup = train.get("warmupRatio")
    if not isinstance(warmup, (int, float)) or isinstance(warmup, bool) or not (0.0 <= float(warmup) < 1.0):
        problems.append(f"train.warmupRatio 必须在 [0,1)（实为 {warmup!r}）")
    seed = train.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool):
        problems.append(f"train.seed 必须是整数（实为 {seed!r}）")

    runtime = cfg.get("runtime")
    if runtime is not None:
        if not isinstance(runtime, dict):
            problems.append("runtime 不是对象")
        else:
            if runtime.get("dtype") not in ("bf16", "4bit", "8bit"):
                problems.append(f"runtime.dtype 只能是 bf16/4bit/8bit（实为 {runtime.get('dtype')!r}）")
            for key in ("batchSize", "gradAccum", "effectiveBatch"):
                value = runtime.get(key)
                if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                    problems.append(f"runtime.{key} 必须是 ≥1 的整数（实为 {value!r}）")
            if all(isinstance(runtime.get(key), int) for key in ("batchSize", "gradAccum", "effectiveBatch")):
                if runtime["batchSize"] * runtime["gradAccum"] != runtime["effectiveBatch"]:
                    problems.append(
                        "runtime.effectiveBatch 应等于 batchSize*gradAccum"
                        f"（{runtime['batchSize']}*{runtime['gradAccum']} != {runtime['effectiveBatch']}）"
                    )

    quant = cfg["quant"]
    if not isinstance(quant, dict):
        return problems + ["quant 不是对象"]
    if quant.get("bits") not in (4, 8):
        problems.append(f"quant.bits 只能是 4 或 8（实为 {quant.get('bits')!r}）")
    if not isinstance(quant.get("type"), str) or not quant["type"]:
        problems.append("quant.type 必须是非空字符串")
    return problems


def load_config(path: str | Path = DEFAULT_CONFIG_PATH) -> dict[str, Any]:
    resolved = resolve_path(path)
    if not resolved.is_file():
        raise ConfigError(f"找不到训练配置 {resolved}")
    try:
        cfg = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{resolved} 不是合法 JSON：{exc}") from exc
    problems = validate_config(cfg)
    if problems:
        raise ConfigError(f"{resolved} 不合契约：" + "；".join(problems))
    return cfg


# ---------------------------------------------------------------------------
# 训练环境隔离（§5：.venv-train 缺失 → 中文提示 + 退出码 1）
# ---------------------------------------------------------------------------


def check_train_venv(prefix: str | None = None) -> int:
    """当前解释器不是 .venv-train 时返回 EXIT_NO_TRAIN_VENV（并打印中文提示）。"""
    actual = Path(prefix if prefix is not None else sys.prefix).resolve()
    if actual == TRAIN_VENV_DIR.resolve():
        return EXIT_OK
    print(
        "[qlora] 训练依赖只装在 tools\\voice\\.venv-train（推理侧 .venv 不许有 torch）。\n"
        "[qlora] 先跑 .\\voice.cmd trainenv，再用 .\\tools\\voice\\.venv-train\\Scripts\\python.exe 跑本脚本。\n"
        f"[qlora] 当前解释器前缀：{actual}",
        file=sys.stderr,
    )
    return EXIT_NO_TRAIN_VENV


# ---------------------------------------------------------------------------
# 样本构造（§4.1，逐字固定）
# ---------------------------------------------------------------------------


def order_op(op: dict[str, Any]) -> dict[str, Any]:
    """按 system.zh.txt 列出的字段顺序重排一个 op；未知字段按原顺序追加，不静默丢。"""
    kind = str(op.get("kind", ""))
    order = OP_FIELD_ORDER.get(kind, ())
    ordered: dict[str, Any] = {key: op[key] for key in order if key in op}
    for key, value in op.items():
        if key not in ordered:
            ordered[key] = value
    return ordered


def compact_plan(plan: dict[str, Any]) -> str:
    """L1 → 紧凑 JSON，键顺序固定 v,status,ops,say,confidence（clarify 在 ops 后多一个 question）。"""
    status = str(plan.get("status", ""))
    out: dict[str, Any] = {"v": int(plan.get("v", 1)), "status": status}
    out["ops"] = [order_op(op) for op in (plan.get("ops") or [])]
    if status == "clarify":
        out["question"] = str(plan.get("question", ""))
    out["say"] = str(plan.get("say", ""))
    out["confidence"] = plan.get("confidence", 0)
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def snapshot_line(rng: random.Random) -> str:
    """user 消息首行。格式与推理侧 llm.py 的 snapshot_line() 逐字一致，只把 11 个值换成随机状态。

    训练语料（5.1 的 train.jsonl）只带句子与 plan，没有设备状态；推理时这里放的是真实设备快照，
    所以训练按既定口径（§4.1「训练时用 holdout/随机状态填」）用固定随机源填，避免学生模型死记一个常数。
    """
    enc = rng.choice([0, 1, 1, 2, 2, 3, 3, 4, 5])
    comp = rng.choice([-24, -22, -20, -18, -18, -16, -14, -12])
    limit = rng.choice([-6.0, -4.0, -3.0, -2.0, -2.0, -1.0, -0.5])
    gate = rng.choice([-55, -50, -47, -44, -41, -41, -38, -35])
    gains = [rng.choice([-6, -4, -3, -2, -1, 0, 0, 0, 0, 1, 2, 3, 4, 6]) for _ in range(7)]
    gain_text = ",".join(str(value) for value in gains)
    return (
        f"当前：降噪档位={enc}，"
        f"压缩阈值={comp}dB，"
        f"限制器阈值={limit:.1f}dB，"
        f"噪声门阈值={gate}dB，"
        f"增益=[{gain_text}]dB"
    )


def build_messages(row: dict[str, Any], system_text: str, state_line: str) -> list[dict[str, str]]:
    """§4.1：system = 系统提示词全文；user = 快照 + 换行 + 句子；assistant = plan 紧凑 JSON。"""
    text = str(row["text"])
    return [
        {"role": "system", "content": system_text},
        {"role": "user", "content": f"{state_line}\n{text}"},
        {"role": "assistant", "content": compact_plan(row["plan"])},
    ]


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for lineno, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            row = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{lineno} 不是合法 JSON：{exc}") from exc
        if not isinstance(row, dict) or "text" not in row or "plan" not in row:
            raise ValueError(f"{path}:{lineno} 需要 text 与 plan 两个字段")
        rows.append(row)
    return rows


def build_sample(
    row: dict[str, Any],
    system_text: str,
    state_line: str,
    *,
    encode_prompt: Any,
    encode_answer: Any,
    end_of_turn: str,
    max_len: int,
) -> dict[str, list[int]]:
    """把一行语料拼成 input_ids + labels。prompt 段标签置 -100，只有 assistant 段算 loss。

    `encode_prompt` / `encode_answer` 是「文本 → token id 列表」的可注入函数：
    真训练传 tokenizer.apply_chat_template 与 tokenizer(...)，单测传真实现以脱离 transformers。
    """
    messages = build_messages(row, system_text, state_line)
    prompt_ids = list(encode_prompt(messages))
    answer_ids = list(encode_answer(messages[2]["content"] + end_of_turn))
    if not answer_ids:
        raise ValueError(f"assistant 段没有 token：{row.get('id')!r}")
    labels = [IGNORE_INDEX] * len(prompt_ids) + answer_ids
    ids = prompt_ids + answer_ids
    if len(ids) > max_len:
        # 截断只砍 prompt 的左侧（保住 system 尾部与答句），答句本身超长直接报错。
        keep = max_len - len(answer_ids)
        if keep < 1:
            raise ValueError(f"答句比 maxLen={max_len} 还长：{row.get('id')!r}")
        ids = prompt_ids[-keep:] + answer_ids
        labels = [IGNORE_INDEX] * keep + answer_ids
    return {"input_ids": ids, "labels": labels}


def build_dataset(
    rows: list[dict[str, Any]],
    system_text: str,
    *,
    seed: int,
    encode_prompt: Any,
    encode_answer: Any,
    end_of_turn: str,
    max_len: int,
) -> tuple[list[dict[str, list[int]]], dict[str, Any]]:
    samples: list[dict[str, list[int]]] = []
    lengths: list[int] = []
    truncated = 0
    for index, row in enumerate(rows):
        # 每行一个固定随机状态：同一 seed 重跑得到同一份训练集（可复现）。
        state_line = snapshot_line(random.Random(seed * 100003 + index))
        sample = build_sample(
            row,
            system_text,
            state_line,
            encode_prompt=encode_prompt,
            encode_answer=encode_answer,
            end_of_turn=end_of_turn,
            max_len=max_len,
        )
        lengths.append(len(sample["input_ids"]))
        if len(sample["input_ids"]) >= max_len:
            truncated += 1
        samples.append(sample)
    lengths_sorted = sorted(lengths)
    stats = {
        "rows": len(samples),
        "maxLen": max_len,
        "lenMax": lengths_sorted[-1] if lengths_sorted else 0,
        "lenP50": lengths_sorted[len(lengths_sorted) // 2] if lengths_sorted else 0,
        "lenP95": lengths_sorted[min(len(lengths_sorted) - 1, int(len(lengths_sorted) * 0.95))] if lengths_sorted else 0,
        "truncated": truncated,
    }
    return samples, stats


def make_chat_encoders(tokenizer: Any) -> tuple[Any, Any, str]:
    """返回 (encode_prompt, encode_answer, end_of_turn)，把 tokenizer 细节关在数据集构造之外。"""
    end_of_turn = str(tokenizer.eos_token or "<|im_end|>")

    def encode_prompt(messages: list[dict[str, str]]) -> list[int]:
        prompt_text = tokenizer.apply_chat_template(
            messages[:2],
            tokenize=False,
            add_generation_prompt=True,
            **CHAT_TEMPLATE_KWARGS,
        )
        return tokenizer(prompt_text, add_special_tokens=False)["input_ids"]

    def encode_answer(text: str) -> list[int]:
        return tokenizer(text, add_special_tokens=False)["input_ids"]

    return encode_prompt, encode_answer, end_of_turn


# ---------------------------------------------------------------------------
# 训练
# ---------------------------------------------------------------------------


def make_collator(pad_token_id: int, counter: dict[str, int] | None = None) -> Any:
    """右填充 + labels 补 -100。counter 累计真实 token 数，用于算 tokens/s（不含 padding）。"""
    import torch

    def collate(batch: list[dict[str, list[int]]]) -> dict[str, Any]:
        width = max(len(row["input_ids"]) for row in batch)
        input_ids, labels, attention = [], [], []
        for row in batch:
            pad = width - len(row["input_ids"])
            input_ids.append(row["input_ids"] + [pad_token_id] * pad)
            labels.append(row["labels"] + [IGNORE_INDEX] * pad)
            attention.append([1] * len(row["input_ids"]) + [0] * pad)
        if counter is not None:
            counter["tokens"] += sum(sum(mask) for mask in attention)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }

    return collate


def evaluate_loss(model: Any, samples: list[dict[str, list[int]]], collator: Any, device: Any, batch_size: int = 4) -> float:
    import torch

    model.eval()
    total, tokens = 0.0, 0
    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            batch = collator(samples[start : start + batch_size])
            batch = {key: value.to(device) for key, value in batch.items()}
            out = model(**batch)
            counted = int((batch["labels"] != IGNORE_INDEX).sum().item())
            total += float(out.loss) * counted
            tokens += counted
    return total / max(1, tokens)


def build_trainer(
    cfg: dict[str, Any],
    args: argparse.Namespace,
    *,
    batch_size: int,
    grad_accum: int,
    run_steps: int | None,
    smoke: bool,
):
    """建模型 / 数据 / Trainer。返回 (trainer, eval_samples, collator, eval_collator, counter, model, guard, tokenizer)。"""
    import torch
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        Trainer,
        TrainerCallback,
        TrainingArguments,
    )
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    runtime = cfg.get("runtime") or {}
    runtime_base_dtype = str(runtime.get("dtype") or "4bit").strip().lower()
    torch.manual_seed(cfg["train"]["seed"])
    random.seed(cfg["train"]["seed"])

    base_dir = resolve_path(cfg["base"])
    if not base_dir.is_dir():
        raise ConfigError(f"找不到基座权重目录 {base_dir}（先跑 .\\voice.cmd fetch --only base-hf-shard1 ...）")
    data_path = resolve_path(cfg["data"])
    system_text = (VOICE_DIR / "prompts" / "system.zh.txt").read_text(encoding="utf-8")

    tokenizer = AutoTokenizer.from_pretrained(str(base_dir), trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    encode_prompt, encode_answer, end_of_turn = make_chat_encoders(tokenizer)
    rows = read_jsonl(data_path)
    if not rows:
        raise ValueError(f"{data_path} 一行都没有")
    samples, stats = build_dataset(
        rows,
        system_text,
        seed=cfg["train"]["seed"],
        encode_prompt=encode_prompt,
        encode_answer=encode_answer,
        end_of_turn=end_of_turn,
        max_len=cfg["train"]["maxLen"],
    )
    print(
        f"[qlora] 训练样本 {stats['rows']} 条：len max={stats['lenMax']} p50={stats['lenP50']} p95={stats['lenP95']}"
        f"（maxLen={stats['maxLen']}，被截断 {stats['truncated']} 条）"
    )

    eval_rows: list[dict[str, Any]] = []
    holdout_path = data_path.with_name("holdout.jsonl")
    if holdout_path.is_file():
        eval_rows = read_jsonl(holdout_path)[:EVAL_ROWS]
    eval_samples: list[dict[str, list[int]]] = []
    if eval_rows:
        eval_samples, eval_stats = build_dataset(
            eval_rows,
            system_text,
            seed=cfg["train"]["seed"] + 1,
            encode_prompt=encode_prompt,
            encode_answer=encode_answer,
            end_of_turn=end_of_turn,
            max_len=cfg["train"]["maxLen"],
        )
        print(f"[qlora] 评测样本 {eval_stats['rows']} 条（holdout 前 {EVAL_ROWS} 条）：len max={eval_stats['lenMax']}")

    quant_bits = int(cfg["quant"]["bits"])
    # QLORA_BASE_DTYPE 是**实测出来的退路**，不是随手加的开关（本机 4070 SUPER 12 GB + Windows）：
    #   4bit + batch1: 1151 tok/s，峰值 7.3 GB；4bit + batch2: 615 tok/s（溢出到共享显存）
    #   bf16 + batch1: 2625 tok/s，峰值 7.9 GB；bf16 + batch2: 1700 tok/s（同样溢出）
    # 4 bit 在 batch 1 反而比 bf16 慢一倍多（每层 matmul 都要反量化），显存也没省出可用空间，
    # 所以本机实际训练用 bf16（LoRA 的 r/alpha/lr/epochs/样本格式全不变，只有基座 dtype 变了）。
    base_dtype = os.environ.get("QLORA_BASE_DTYPE", runtime_base_dtype).strip().lower()
    use_4bit = base_dtype != "bf16"
    if use_4bit:
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=(quant_bits == 4),
            load_in_8bit=(quant_bits == 8),
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            str(base_dir),
            quantization_config=bnb_config,
            torch_dtype=torch.bfloat16,
            device_map={"": 0},
            trust_remote_code=False,
        )
    else:
        print("[qlora] 基座按 bf16 全精度加载（runtime.dtype 或 QLORA_BASE_DTYPE；本机 4 bit 更慢，见脚本内实测注记）")
        model = AutoModelForCausalLM.from_pretrained(
            str(base_dir),
            quantization_config=None,
            torch_dtype=torch.bfloat16,
            device_map={"": 0},
            trust_remote_code=False,
        )
    model.config.use_cache = False
    if use_4bit:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    else:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    lora_cfg = LoraConfig(
        r=int(cfg["lora"]["r"]),
        lora_alpha=int(cfg["lora"]["alpha"]),
        lora_dropout=float(cfg["lora"]["dropout"]),
        target_modules=list(cfg["lora"]["target_modules"]),
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    out_dir = resolve_path(cfg["out"])
    training_args = TrainingArguments(
        output_dir=str(out_dir),
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=grad_accum,
        learning_rate=float(cfg["train"]["lr"]),
        num_train_epochs=float(cfg["train"]["epochs"]),
        max_steps=int(run_steps) if run_steps is not None else -1,
        lr_scheduler_type="cosine",
        warmup_ratio=float(cfg["train"]["warmupRatio"]),
        bf16=True,
        fp16=False,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="paged_adamw_8bit",
        logging_strategy="steps",
        logging_steps=1 if smoke else 10,
        logging_first_step=True,
        save_strategy="no" if smoke else "steps",
        save_steps=200,
        save_total_limit=2,
        report_to=[],
        remove_unused_columns=False,
        dataloader_num_workers=0,
        disable_tqdm=True,
        seed=int(cfg["train"]["seed"]),
        data_seed=int(cfg["train"]["seed"]),
    )

    counter: dict[str, int] = {"tokens": 0}
    collator = make_collator(int(tokenizer.pad_token_id), counter)
    # 评测用不计数的一版 collator：tokens/s 只该算训练 token，别把 eval 的算进去。
    eval_collator = make_collator(int(tokenizer.pad_token_id))

    class NanGuard(TrainerCallback):
        def __init__(self) -> None:
            self.losses: list[float] = []

        def on_log(self, _args, _state, _control, logs: dict[str, Any] | None = None, **_kwargs):  # noqa: ANN001
            if not logs:
                return
            loss = logs.get("loss")
            if loss is None:
                return
            value = float(loss)
            self.losses.append(value)
            if math.isnan(value) or math.isinf(value):
                raise NanLossError(f"第 {len(self.losses)} 次记录到的 loss 是 {value}")

    guard = NanGuard()
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=samples,
        data_collator=collator,
        callbacks=[guard],
    )
    return trainer, eval_samples, collator, eval_collator, counter, model, guard, tokenizer


def train_once(
    cfg: dict[str, Any],
    args: argparse.Namespace,
    *,
    batch_size: int,
    grad_accum: int,
    run_steps: int | None,
    smoke: bool,
) -> dict[str, Any]:
    import torch

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    try:
        trainer, eval_samples, collator, eval_collator, counter, model, guard, _tokenizer = build_trainer(
            cfg,
            args,
            batch_size=batch_size,
            grad_accum=grad_accum,
            run_steps=run_steps,
            smoke=smoke,
        )
    except (torch.cuda.OutOfMemoryError, torch.OutOfMemoryError):
        torch.cuda.empty_cache()
        return {"status": "oom"}

    device = next(model.parameters()).device
    started_at = time.time()
    try:
        trainer.train(resume_from_checkpoint=bool(args.resume) or None)
    except NanLossError as exc:
        print(f"[qlora] 训练中止：{exc}", file=sys.stderr)
        print(f"[qlora] 前 {min(20, len(guard.losses))} 步 loss：{guard.losses[:20]}", file=sys.stderr)
        return {"status": "nan", "losses": guard.losses}
    except (torch.cuda.OutOfMemoryError, torch.OutOfMemoryError):
        del trainer
        torch.cuda.empty_cache()
        return {"status": "oom"}
    elapsed = time.time() - started_at

    history = list(trainer.state.log_history)
    step_losses = [float(item["loss"]) for item in history if "loss" in item]
    if any(math.isnan(value) or math.isinf(value) for value in step_losses):
        print(
            f"[qlora] loss 出现 NaN/Inf，停止。前 {min(20, len(step_losses))} 步：{step_losses[:20]}",
            file=sys.stderr,
        )
        return {"status": "nan", "losses": step_losses}

    final = next((item for item in reversed(history) if "train_loss" in item), None)
    train_loss = float(final["train_loss"]) if final else float("nan")

    eval_loss = float("nan")
    if eval_samples:
        eval_loss = evaluate_loss(model, eval_samples, eval_collator, device)

    peak_mb = torch.cuda.max_memory_allocated() / (1024**2)
    total_mb = torch.cuda.get_device_properties(0).total_memory / (1024**2)
    if peak_mb > 0.9 * total_mb:
        print(
            f"[qlora] 警告：显存峰值 {peak_mb:.0f} MiB 已超过 {total_mb:.0f} MiB 的 90%，"
            "Windows 会溢出到共享内存，tokens/s 会塌（实测溢出后掉到 1/2 以下）",
            file=sys.stderr,
        )
    tokens_per_s = counter["tokens"] / elapsed if elapsed > 0 else 0.0
    result: dict[str, Any] = {
        "status": "ok",
        "steps": int(trainer.state.global_step),
        "elapsed_s": round(elapsed, 1),
        "tokens_per_s": round(tokens_per_s, 1),
        "peak_mem_mb": round(peak_mb, 1),
        "train_loss": train_loss,
        "eval_loss": eval_loss,
        "losses": step_losses,
        "log_history": history,
        "batch_size": batch_size,
        "grad_accum": grad_accum,
    }
    if not smoke:
        out_dir = resolve_path(cfg["out"])
        out_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(str(out_dir))
        trainer.save_state()
        # 训练指标单独落一份，给 merge_and_quantize.ps1 / record_student.py / 完成报告取证用。
        (out_dir / "train_metrics.json").write_text(
            json.dumps(
                {
                    "steps": result["steps"],
                    "runSteps": run_steps,
                    "effectiveEpochs": round(
                        result["steps"] * batch_size * grad_accum / max(1, len(trainer.train_dataset)), 2
                    ),
                    "baseDtype": str((cfg.get("runtime") or {}).get("dtype") or "4bit"),
                    "effectiveBatch": batch_size * grad_accum,
                    "train_loss": train_loss,
                    "eval_loss": eval_loss,
                    "tokens_per_s": result["tokens_per_s"],
                    "peak_mem_mb": result["peak_mem_mb"],
                    "elapsed_s": result["elapsed_s"],
                    "batchSize": batch_size,
                    "gradAccum": grad_accum,
                    "maxLen": int(cfg["train"]["maxLen"]),
                    "epochs": cfg["train"]["epochs"],
                    "lr": cfg["train"]["lr"],
                    "seed": cfg["train"]["seed"],
                    "lossPoints": [[item["step"], item["loss"]] for item in history if "loss" in item and item.get("step")],
                    "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        result["out"] = str(out_dir)
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SubStage 5.2 QLoRA 训练（Qwen3-1.7B → 学生适配器）")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="训练配置（默认 tools/voice/train/config.json）")
    parser.add_argument("--smoke", action="store_true", help="只跑 20 步验证环境，不落盘适配器")
    parser.add_argument("--max-steps", type=int, default=None, help="只跑 N 步（消融用），仍按正式口径落盘")
    parser.add_argument("--resume", action="store_true", help="从 out/ 里最近的 checkpoint 续训")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    code = check_train_venv()
    if code != EXIT_OK:
        return code

    try:
        cfg = load_config(args.config)
        runtime = cfg.get("runtime") or {}
        batch_override = env_int("QLORA_BATCH_SIZE", int(runtime.get("batchSize") or cfg["train"]["batchSize"]))
        accum_override = env_int("QLORA_GRAD_ACCUM", int(runtime.get("gradAccum") or cfg["train"]["gradAccum"]))
    except ConfigError as exc:
        print(f"[qlora] {exc}", file=sys.stderr)
        return EXIT_BAD_CONFIG

    import torch  # 到这里才碰重依赖：venv 检查与配置校验必须能在没有 torch 的环境里跑

    if not torch.cuda.is_available():
        print(
            "[qlora] 本 SubStage 需要 GPU：torch.cuda.is_available() 为 False。\n"
            "[qlora] 不自动退回 CPU 训练（1 epoch 会跑 20 小时以上）。检查驱动 / CUDA 轮子后重试。",
            file=sys.stderr,
        )
        return EXIT_NO_GPU

    smoke = bool(args.smoke)
    run_steps: int | None
    if smoke:
        run_steps = SMOKE_STEPS
        if args.max_steps is not None:
            print(f"[qlora] --smoke 固定 {SMOKE_STEPS} 步，忽略 --max-steps {args.max_steps}")
    else:
        run_steps = int(args.max_steps) if args.max_steps is not None else None

    gpu = torch.cuda.get_device_name(0)
    total_mb = torch.cuda.get_device_properties(0).total_memory / (1024**2)
    print(f"[qlora] GPU {gpu}（{total_mb:.0f} MiB）torch {torch.__version__}；基座 {cfg['base']}")

    planned: list[tuple[int, int]] = [(batch_override, accum_override)]
    if (batch_override, accum_override) != (int(cfg["train"]["batchSize"]), int(cfg["train"]["gradAccum"])):
        print(
            f"[qlora] 环境变量覆盖：batchSize={batch_override} gradAccum={accum_override}"
            f"（config 是 {cfg['train']['batchSize']}/{cfg['train']['gradAccum']}，有效 batch = {batch_override * accum_override}）"
        )
    planned.append((2, 8))  # §5：OOM 时降 batch 2 / gradAccum 8，不改 lr

    for attempt, (batch_size, grad_accum) in enumerate(planned, 1):
        if smoke:
            mode = f"smoke {SMOKE_STEPS} 步"
        elif run_steps is not None:
            mode = f"max-steps {run_steps}"
        else:
            mode = f"{cfg['train']['epochs']} epoch"
        print(
            f"[qlora] 第 {attempt} 次尝试：{mode}，batchSize={batch_size} gradAccum={grad_accum}"
            f" lr={cfg['train']['lr']} maxLen={cfg['train']['maxLen']}"
        )
        result = train_once(
            cfg,
            args,
            batch_size=batch_size,
            grad_accum=grad_accum,
            run_steps=run_steps,
            smoke=smoke,
        )

        if result["status"] == "nan":
            return EXIT_NAN
        if result["status"] == "oom":
            if attempt < len(planned):
                print("[qlora] 显存不足（OOM）：降到 batchSize=2 gradAccum=8 重试一次，lr 不动", file=sys.stderr)
                continue
            print("[qlora] 降到 batchSize=2 gradAccum=8 仍 OOM，放弃（退出码 7）", file=sys.stderr)
            return EXIT_OOM

        losses = result["losses"]
        if smoke:
            first = losses[0] if losses else float("nan")
            last = losses[-1] if losses else float("nan")
            print(f"[qlora] smoke 首步 loss={first:.6f} 末步 loss={last:.6f}（共 {len(losses)} 次记录）")
        else:
            step_logs = [(int(item["step"]), item["loss"]) for item in result["log_history"] if "loss" in item and item.get("step")]
            sample_points = [item for item in step_logs if item[0] % 50 == 0]
            print(f"[qlora] 每 50 步 loss：{sample_points}")
        print(
            f"[qlora] steps={result['steps']} tokens_per_s={result['tokens_per_s']}"
            f" peak_mem_mb={result['peak_mem_mb']} elapsed_s={result['elapsed_s']}"
        )
        print(f"[qlora] train_loss={result['train_loss']:.6f} eval_loss={result['eval_loss']:.6f}")
        if result.get("out"):
            print(f"[qlora] 适配器已写入 {result['out']}")
        return EXIT_OK

    return EXIT_OOM


if __name__ == "__main__":
    sys.exit(main())
