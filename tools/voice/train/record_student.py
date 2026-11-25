#!/usr/bin/env python
"""SubStage 5.2：把学生模型的文件名 / 体积 / sha256 / 超参写进 tools/voice/data/manifest.json。

用 Python 而不是 PowerShell 写回：data/manifest.json 是 5.1 的 node 工具用
`JSON.stringify(doc, null, 2)` 生成的，PowerShell 5.1 的 ConvertTo-Json 缩进规则不同，
写回去会让整份清单的 diff 变成全文件重写。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
VOICE_DIR = REPO_ROOT / "tools" / "voice"


def sha256_file(path: Path, chunk: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def rel(path: Path) -> str:
    """清单里的路径一律写仓库相对路径（Windows 用反斜杠，与 5.1 的写法一致）。"""
    try:
        return str(path.resolve().relative_to(REPO_ROOT)).replace("/", "\\")
    except ValueError:
        return str(path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="把学生模型记录写进 data/manifest.json")
    parser.add_argument("--gguf", required=True, help="量化后的学生模型")
    parser.add_argument("--manifest", default=str(VOICE_DIR / "data" / "manifest.json"))
    parser.add_argument("--config", default=str(VOICE_DIR / "train" / "config.json"))
    parser.add_argument("--metrics", default="", help="qlora.py 落的 train_metrics.json（可选）")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    gguf = Path(args.gguf)
    manifest_path = Path(args.manifest)
    config_path = Path(args.config)

    if not gguf.is_file():
        print(f"[record] 找不到学生模型 {gguf}", file=sys.stderr)
        return 1
    if not manifest_path.is_file():
        print(f"[record] 找不到 {manifest_path}", file=sys.stderr)
        return 1

    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    metrics: dict[str, object] = {}
    if args.metrics and Path(args.metrics).is_file():
        metrics = json.loads(Path(args.metrics).read_text(encoding="utf-8"))

    doc = json.loads(manifest_path.read_text(encoding="utf-8"))
    size = gguf.stat().st_size
    doc["student"] = {
        "file": gguf.name,
        "path": rel(gguf),
        "size": size,
        "sha256": sha256_file(gguf),
        "quant": cfg["quant"]["type"],
        "base": "Qwen/Qwen3-1.7B（HF bf16，models/base-hf/Qwen3-1.7B）",
        "lora": cfg["lora"],
        "train": cfg["train"],
        "metrics": {
            key: metrics.get(key)
            for key in ("steps", "train_loss", "eval_loss", "tokens_per_s", "peak_mem_mb", "elapsed_s")
            if key in metrics
        },
        # 实际跑出来的配方（config 的 train 段是契约值，这里是这一次真正生效的值）
        "run": {
            key: metrics.get(key)
            for key in (
                "runSteps",
                "effectiveEpochs",
                "baseDtype",
                "effectiveBatch",
                "batchSize",
                "gradAccum",
                "maxLen",
                "lr",
                "seed",
            )
            if key in metrics
        },
        "recordedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    manifest_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[record] 已写入 {manifest_path}：student.file={gguf.name} size={size} sha256={doc['student']['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
