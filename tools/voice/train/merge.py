#!/usr/bin/env python
"""SubStage 5.2：把 LoRA 适配器合并回 f16 的 HF 权重（merge_and_quantize.ps1 的第 1 步）。

契约：SubStage_5.2 §4.3「合并 LoRA 到 f16 HF 权重」。产出目录可以被
train/vendor/convert_hf_to_gguf.py 直接吃（config.json + *.safetensors + tokenizer 旁挂文件）。

先写 <out>.partial，全部成功后才改名成 <out>：中途失败不留半成品目录。
"""

from __future__ import annotations

import argparse
import shutil
import sys
import traceback
from pathlib import Path

# 与 tokenizer / 生成配置相关的旁挂文件：逐字节从基座复制，保证 GGUF 内嵌的聊天模板
# 与训练时用的那份完全一致（训练/推理同分布）。
SIDECAR_NAMES = {
    "vocab.json",
    "merges.txt",
    "added_tokens.json",
    "special_tokens_map.json",
    "generation_config.json",
    "chat_template.jinja",
    "preprocessor_config.json",
    "LICENSE",
    "README.md",
}
SIDECAR_PREFIXES = ("tokenizer",)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="把 LoRA 合并进 f16 HF 权重")
    parser.add_argument("--base", required=True, help="基座 HF 权重目录")
    parser.add_argument("--lora", required=True, help="qlora.py 落盘的适配器目录")
    parser.add_argument("--out", required=True, help="合并结果目录（f16 HF）")
    return parser.parse_args(argv)


def is_sidecar(name: str) -> bool:
    return name in SIDECAR_NAMES or name.startswith(SIDECAR_PREFIXES)


def copy_sidecars(base_dir: Path, out_dir: Path) -> int:
    copied = 0
    for item in sorted(base_dir.iterdir()):
        if not item.is_file() or not is_sidecar(item.name):
            continue
        shutil.copy2(item, out_dir / item.name)
        copied += 1
    return copied


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    base = Path(args.base)
    lora = Path(args.lora)
    out = Path(args.out)

    if not base.is_dir():
        print(f"[merge] 找不到基座权重目录 {base}（先跑 .\\voice.cmd fetch 拉 base-hf）", file=sys.stderr)
        return 1
    if not lora.is_dir():
        print(f"[merge] 找不到适配器目录 {lora}（先跑正式训练 qlora.py）", file=sys.stderr)
        return 1
    if not (lora / "adapter_config.json").is_file():
        print(f"[merge] {lora} 里没有 adapter_config.json，不是 PEFT 适配器目录", file=sys.stderr)
        return 1

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM

    partial = out.with_name(out.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir(parents=True)

    # 合并本身不需要 4 bit：显存够就在 GPU 上合（快一个数量级），OOM 再退 CPU。
    def load(device: str):
        model = AutoModelForCausalLM.from_pretrained(
            str(base),
            torch_dtype=torch.bfloat16,
            device_map={"": device},
            trust_remote_code=False,
        )
        model = PeftModel.from_pretrained(model, str(lora))
        return model

    try:
        try:
            model = load("cuda")
        except (torch.cuda.OutOfMemoryError, torch.OutOfMemoryError, RuntimeError):
            torch.cuda.empty_cache()
            print("[merge] GPU 合并不可用，退回 CPU 合并", file=sys.stderr)
            model = load("cpu")
        merged = model.merge_and_unload()
        merged = merged.to(torch.float16)
        merged.save_pretrained(str(partial), safe_serialization=True, max_shard_size="4GB")
        copied = copy_sidecars(base, partial)

        if out.exists():
            shutil.rmtree(out)
        partial.rename(out)
        total = sum(item.stat().st_size for item in out.iterdir() if item.is_file())
        weights = sorted(item.name for item in out.iterdir() if item.suffix == ".safetensors")
        print(f"[merge] 合并完成 {out}")
        print(f"[merge] 权重 {weights} 体积 {total / 1024**3:.2f} GB，复制旁挂文件 {copied} 个")
        return 0
    except Exception:  # noqa: BLE001 - 任何失败都要清掉 .partial 再报错
        traceback.print_exc()
        shutil.rmtree(partial, ignore_errors=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
