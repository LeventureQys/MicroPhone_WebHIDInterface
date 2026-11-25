# SubStage 5.2 — QLoRA 微调与量化

> **所属 Stage**：Stage 5（蒸馏与评测）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 5.1（`data/train.jsonl` / `holdout.jsonl`）、1.1（资产清单与下载脚本）、4.3（`pipeline.py --no-llm` 用作快速回归）
> **并行状态**：串行（吃 GPU，且要等数据）；SubStage 5.3 依赖本 SubStage
> **任务书版本**：v2（2026-11-24）
> **契约来源**：设计文档 §2.4（训练环境隔离）、§4.2、R-13（微调进主线）、R-16（三档取优）、§6 风险（过拟合/超预算/合并失败）

---

## 1. 背景与目标

用 5 000 条由知识本体标注的语料，对 Qwen3-1.7B 做 **QLoRA** 微调，合并成 f16 后重新量化为 Q4_K_M，产出**学生模型 GGUF**，供推理侧（严格 CPU）使用。

**不在本 SubStage 决定"是否用它"**——三档对比在 5.3（R-16）。本 SubStage 的成败只看：能不能训出来、合得上、加载得了、指标不崩。

**硬件与预算**：RTX 4070 SUPER 12 GB。1.7B 的 QLoRA 显存约 4–6 GB，余量充足。单 epoch（4 500 条、max_len 512）预估 **15–40 分钟**；先跑 1 epoch 看曲线，再决定是否加到 3 epoch。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/data/train.jsonl`、`holdout.jsonl`、`manifest.json` | 5.1 交付（入库） |
| `tools/voice/.venv` | 推理侧 venv（`sherpa-onnx`/`numpy`/`sounddevice`），**不得装入训练依赖** |
| `tools/voice/models/base-hf/` | **不存在**。QLoRA 需要 HF 格式权重（safetensors），GGUF 不能直接训 |
| `tools/voice/models/llama/llama-quantize.exe` | 1.1 解包自带（同 zip 内） |

**新增资产（本 SubStage 负责下载，仍走 `fetch-models.mjs` 的清单）**：
- `models/base-hf/Qwen3-1.7B/`（`config.json` / `tokenizer*` / `*.safetensors`，约 **3.4 GB**，来源 `hf-mirror.com/Qwen/Qwen3-1.7B`）；
- 训练依赖装进 **`tools/voice/.venv-train`**（独立 venv）。

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/manifest.json`（追加） | 新增 `base-hf`（HF 权重）与 `llama-quantize` 条目 |
| `tools/voice/train/requirements-train.txt` | `torch`（cu121 或 cu124）、`transformers`、`peft`、`trl`、`datasets`、`accelerate`、`bitsandbytes` |
| `tools/voice/train/qlora.py` | 训练脚本（可 `--smoke` 只跑 20 步） |
| `tools/voice/train/merge_and_quantize.ps1` | 合并 + 转 GGUF + 量化三步（UTF-8 带 BOM） |
| `tools/voice/train/config.json` | LoRA 超参（r/alpha/lr/epochs/max_len） |
| `tools/voice/models/student/Qwen3-1.7B-ft-Q4_K_M.gguf` | 产物（**不入库**） |
| `tools/voice/data/manifest.json`（追加） | 学生模型文件名 + sha256 + 超参 |
| `tools/voice/test/test_student.mjs` | 加载与冒烟测试 |

---

## 4. 契约

### 4.1 训练配置（`train/config.json`，字段固定）

```json
{
  "v": 1,
  "base": "tools/voice/models/base-hf/Qwen3-1.7B",
  "data": "tools/voice/data/train.jsonl",
  "out": "tools/voice/train/out/qwen3-1.7b-lora",
  "lora": { "r": 16, "alpha": 32, "dropout": 0.05, "target_modules": ["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"] },
  "train": { "epochs": 3, "batchSize": 4, "gradAccum": 4, "lr": 0.0002, "maxLen": 512, "warmupRatio": 0.03, "seed": 20261124 },
  "quant": { "bits": 4, "type": "Q4_K_M" }
}
```

**对话格式（训练样本的构造，逐字固定）**：

- `messages[0]` = system：与推理侧 **完全同一份** `prompts/system.zh.txt`（保证训练与推理同分布）；
- `messages[1]` = user：`当前：…`（当前参数快照，训练时用 `holdout`/随机状态填）+ 换行 + 句子 `text`；
- `messages[2]` = assistant：`plan` 的**紧凑 JSON**（与推理侧输出格式一致，字段顺序固定为 `v,status,ops,say,confidence`）；
- **只对 assistant 段算 loss**（`labels` 里 prompt 段置 −100）。

### 4.2 `qlora.py` 命令行

```
python tools/voice/train/qlora.py [--config train/config.json] [--smoke] [--max-steps N] [--resume]
```

- `--smoke`：只跑 20 步，打印首个与末个 loss，用于验证环境（不落盘适配器）；
- 正式跑：落盘 `out/qwen3-1.7b-lora/`（`adapter_model.safetensors` + `adapter_config.json`）+ `trainer_state.json`（loss 曲线）；
- 必须 `gradient_checkpointing=True`、`bf16=True`（Ada 支持 bf16）、`optim="paged_adamw_8bit"`；
- 结束时打印：`train_loss=<x> eval_loss=<y>`（在 `holdout` 的前 100 条上算 eval）；
- 显存不足时**降 batchSize 到 2、gradAccum 到 8**（写在报告里，不要改 lr）。

### 4.3 `merge_and_quantize.ps1` 三步

```powershell
# 1) 合并 LoRA 到 f16 HF 权重
python tools/voice/train/merge.py --base models/base-hf/Qwen3-1.7B --lora train/out/qwen3-1.7b-lora --out train/out/merged
# 2) 转 GGUF（用 llama.cpp 官方 convert 脚本，需 Python + torch，装 .venv-train）
python <llama.cpp>/convert_hf_to_gguf.py train/out/merged --outfile train/out/merged-f16.gguf --outtype f16
# 3) 量化
models/llama/llama-quantize.exe train/out/merged-f16.gguf models/student/Qwen3-1.7B-ft-Q4_K_M.gguf Q4_K_M
```

- `convert_hf_to_gguf.py` 从 llama.cpp 仓库取（**只取这一个脚本**，放 `tools/voice/train/vendor/`，不改内容，附 commit 号）；
- 三步任一失败 → 脚本 `exit 1`，**不产出半成品**（先写临时文件再原子改名）；
- 完成后把 `sha256` 与文件名写进 `data/manifest.json` 的 `student` 字段。

### 4.4 `test_student.mjs`

```
node tools/voice/test/test_student.mjs [--gguf models/student/Qwen3-1.7B-ft-Q4_K_M.gguf]
```

必须做四件事：①起一次 `llama-server` 加载学生模型（独立端口 8769，避免与教师/基线争用）；②发 10 条 `holdout` 的 `text`，断言 **10/10 schema 合法**；③打印每条耗时；④关闭服务并释放端口。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| `.venv-train` 缺失 | `qlora.py` 打中文提示"先跑 `voice trainenv`"并退出码 1 |
| 无 GPU / CUDA 不可用 | 退出码 6，提示"本 SubStage 需要 GPU"；**不**自动退回 CPU 训练（会跑 20+ 小时） |
| 显存 OOM | 打提示并自动重试一次（batch 2 / accum 8）；再失败退出码 7 |
| 训练 loss 为 NaN | 立即停止，退出码 8，打印前 20 步 loss（多半 lr 太大或数据里有空样本） |
| 合并后 GGUF 超过 4.5 GB | `warn`（说明量化失败或用了 f16 直接交付） |
| 学生模型加载失败 | `test_student.mjs` 退出码 9，打印 llama-server 的 stderr 前 30 行 |
| 学生模型 10 条里 < 10 条合法 | 退出码 10（视为 5.2 未完成，先查训练格式再重训） |

---

## 6. 测试要求

**单元测试**（`node --test tools/voice/test/test_student.mjs` 的离线部分 + `python -m unittest` 训练侧的小单测）：

1. 数据格式转换：给定一行 `train.jsonl`，构造出的 `messages` 三段内容与 §4.1 逐字一致；`labels` 的 prompt 段全为 −100；
2. `config.json` 校验：字段齐全、`r/alpha/lr/epochs` 在合理区间（r ≤ 64、lr ≤ 5e-4）；
3. `.venv-train` 存在性检查给出正确退出码；
4. `merge_and_quantize.ps1` 在缺少适配器目录时退出码 1 且不留半成品文件；
5. `test_student.mjs` 在 GGUF 路径不存在时退出码 9。

**启动测试**（真跑，必须留证据）：

```powershell
.\voice.cmd trainenv                                  # 建 .venv-train 并装依赖
python tools\voice\train\qlora.py --smoke             # 20 步，看 loss 下降
python tools\voice\train\qlora.py --max-steps 200     # 200 步消融，记录 tokens/s
python tools\voice\train\qlora.py                     # 正式 3 epoch（可后台）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\voice\train\merge_and_quantize.ps1
node tools\voice\test\test_student.mjs
```

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `--smoke` | 末步 loss < 首步 loss；无 NaN |
| 7.2 | 正式训练 | 完成 3 epoch 不 OOM；`trainer_state.json` 有完整 loss 曲线 |
| 7.3 | 合并 + 量化 | 产出 `Qwen3-1.7B-ft-Q4_K_M.gguf`，体积在 1.0–1.4 GB |
| 7.4 | `test_student.mjs` | 10/10 schema 合法；单条 P50 延迟 ≤ 2.5 s |
| 7.5 | `manifest.json` | 有 `student` 字段（文件名 + sha256 + 超参） |
| 7.6 | 隔离性 | `tools/voice/.venv` 里 `pip list` **不含** torch/transformers（训练依赖只在 `.venv-train`） |

---

## 8. 禁止事项

- 不得把训练依赖装进 `tools/voice/.venv`；
- 不得修改 `prompts/system.zh.txt`（训练与推理必须同一份；要改就回 3.3 改完重跑本 SubStage）；
- 不得修改 `data/*.jsonl`（5.1 的产物）；
- 不得在推理侧使用 GPU（`test_student.mjs` 的 `llama-server` 不传 `-ngl`）；
- 不得跳过 `--smoke` 直接长跑；
- 不得提交 `.venv-train`、`train/out/`、`models/**` 到 git；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①`--smoke` 的首末 loss；②200 步消融的 tokens/s 与显存占用峰值；③正式训练的 epoch/loss 曲线数据（每 50 步一点）；④量化前后文件体积与 sha256；⑤`test_student.mjs` 的 10 条结果与延迟；⑥训练总耗时；⑦`pip list` 隔离性证据；⑧与本文不一致处（尤其 bitsandbytes 在 Windows 的版本敏感性）；⑨未解决问题。
