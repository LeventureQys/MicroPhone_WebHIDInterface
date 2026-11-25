# SubStage 5.3 — 三档评测与回归

> **所属 Stage**：Stage 5（蒸馏与评测）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 4.3（`pipeline.py`）、5.1（`data/holdout.jsonl`）、5.2（学生模型）
> **并行状态**：串行（验收前最后一步）
> **任务书版本**：v2（2026-11-24）
> **契约来源**：设计文档 §1.4（成功判据）、§3.10（日志）、§4.2、R-16（三档取优）、`问题清单.md` D11

---

## 1. 背景与目标

三档模型跑同一套评测集，**取优者为默认推理档**（R-16）。三档是：

| 档 | 配置 |
|---|---|
| `base` | Qwen3-1.7B Q4_K_M（原始权重），`--no-llm` **不用**：要让它参与自由描述 |
| `fewshot` | 同一个 base，但系统提示词里带 5 条 few-shot（3.3 的默认形态） |
| `ft` | 5.2 的学生模型 `Qwen3-1.7B-ft-Q4_K_M.gguf` |

**门禁线**（验收会逐条对）：
- 文本级：动作集 F1 ≥ 0.85、拒绝准确率 ≥ 0.95、过度拒绝率 ≤ 0.05；
- 择优判据：`ft` 的 F1 ≥ `fewshot` 的 F1，且拒绝/过度拒绝不退化，且 P95 延迟回退 ≤ 10%；
- 音频级：端到端成功率 ≥ 0.70。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/data/holdout.jsonl` | 5.1 交付（500 条，与 train 的 kb 键不相交） |
| `tools/voice/models/student/Qwen3-1.7B-ft-Q4_K_M.gguf` | 5.2 交付 |
| `tools/voice/pipeline.py` | 4.3 交付（`--text` / `--once --wav`，`--no-tts`） |
| `tools/voice/prompts/fewshot.zh.jsonl` | 3.3 交付（5 条） |
| `tools/voice/eval/` | 不存在，本 SubStage 新建 |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/eval/metrics.mjs` | 指标算法（F1 / 拒绝 / 过度拒绝 / 容差匹配） |
| `tools/voice/eval/run.mjs` | 跑一档：起 `llama-server` → 逐条 `pipeline.py --text` → 汇总 |
| `tools/voice/eval/compare.mjs` | 三档对照 + 择优 + 门禁判定 |
| `tools/voice/eval/audio.mjs` | 音频级（30 条 SAPI 合成 wav → `--once --wav`） |
| `tools/voice/eval/make-audio.mjs` | 用 SAPI 合成评测 wav（16 kHz 单声道，前置唤醒词） |
| `tools/voice/eval/report.mjs` | 写 `artifacts/voice/eval-<ts>.json` 与终端摘要 |
| `tools/voice/config.json` | **择优结果**（`"tier": "ft" \| "fewshot" \| "base"`），`pipeline.py` 启动时读 |
| `tools/voice/test/test_eval.mjs` | 指标算法单测 |

---

## 4. 契约

### 4.1 指标定义（与 5.1 v1 的旧定义相比有两处收紧）

| 指标 | 定义 |
|---|---|
| `validRate` | 输出为合法 L1 的比例 |
| `actionSetF1` | 按 op 的 `(target \| param \| band, direction \| on \| value)` 做集合匹配，宏平均后取 F1 |
| `refusalRecall` | 范围外（含 `explainOnly`）语料中 `status=='unsupported'` 的比例 |
| `overRefusal` | 支持类语料里被判 unsupported 的比例 |
| `strengthAcc` | **新增**：`tune`/`eq` 的 `strength` 与期望一致的比例（仅统计命中 target 的样本）——用于判断微调是否真的学到了"一点/很"的差别 |
| `groundingAcc` | **新增**：`set` 类语料里，通过数字接地校验的比例（应恒为 1.0；<1 说明对齐规则过松） |
| `p50/p95Ms` | 单条墙钟（进程内，不含进程启动） |
| `e2eSuccess` | 音频级：`status=='applied'` 且动作集与期望一致的比例 |

**宽容规则**：`tune`/`eq` 只比 `target`+`direction`+`strength`，**不比具体 dB**（数值由 kb 决定，属实现细节）；`set` 比 `param` 与 `value`（`eq.band*.gain` 容差 ±0.6）。

### 4.2 `eval/run.mjs`

```powershell
node tools/voice/eval/run.mjs --tier base|fewshot|ft [--limit N] [--out artifacts/voice]
```

必须：①按档位起对应的 `llama-server`（学生模型换 `-m` 路径；`fewshot` 档用带 few-shot 的 system 提示词）；②**复用同一个 executor 进程**（`--sink dry`），避免每条的启动开销污染 P95；③逐条 `pipeline.py --text <text> --sink dry --no-tts`，读它打印的 JSON；④`--limit` 时用固定前 N 条（**不得随机**，否则三档不可比）；⑤输出单档报告 `artifacts/voice/eval-<tier>-<ts>.json`。

### 4.3 `eval/compare.mjs`

读三档报告 → 输出：

```json
{"chosen":"ft","reason":"F1 0.91 > fewshot 0.87；refusal/overRefusal 不退化；P95 +6%",
 "gate":{"actionSetF1":true,"refusalRecall":true,"overRefusal":true,"e2e":false},
 "table":[{"tier":"base","f1":0.72},{"tier":"fewshot","f1":0.87},{"tier":"ft","f1":0.91}]}
```

规则（严格按序）：
1. 任一档不满足门禁的基本项（`refusalRecall ≥ 0.95`、`overRefusal ≤ 0.05`）→ 该档标记不合格；
2. 在合格档里取 `actionSetF1` 最高者；
3. 若最高者 P95 比 `fewshot` 高 > 10% → 降级选 `fewshot`；
4. 结果写 `tools/voice/config.json` 的 `tier` 字段。

### 4.4 音频级（`eval/audio.mjs` + `make-audio.mjs`）

- 30 条用例：从 holdout 里挑覆盖 8 个类别的样本，`make-audio.mjs` 在文本前补 `小唐小唐，`，用 SAPI（`Microsoft Huihui Desktop`，16 kHz / 16 bit / 单声道）合成到 `artifacts/voice/wav/eval/`；
- 逐条 `pipeline.py --once --wav <wav> --sink dry --no-tts`；
- 统计 `e2eSuccess` 与分段耗时（唤醒/录音/ASR/意图/落地）。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| 学生模型缺失 | `--tier ft` 直接退出码 9，提示先跑 5.2 |
| executor 未起 | 退出码 5 |
| 单条 pipeline 崩溃 | 记 `pass:false, error:'E_CRASH'`，继续（不中断整批） |
| 合成 wav 缺失 | 自动合成；失败该条记 `error:'E_TTS'` 并继续 |
| 三档用了不同的 `--limit` | 立即报错（不可比） |
| 报告文件已存在 | 新时间戳另写，不覆盖 |
| holdout 条数 < 100 | 退出码 2（数据不对） |

---

## 6. 测试要求

**单元测试**（`node --test tools/voice/test/test_eval.mjs`）：

1. `actionSetF1`：完全匹配 = 1；多一个 op → P 下降；少一个 op → R 下降；空期望 vs 空输出 = 1；
2. `refusalRecall` / `overRefusal` 各一例；分母为 0 时返回 0（不是 NaN）；
3. `value` 容差：`eq.band6.gain` 期望 3、实际 3.5 → 通过；期望 3、实际 4 → 不通过；
4. `strengthAcc`：期望 medium、实际 slight → 不计入分子；期望 medium、实际 medium → 计入；
5. `compare.mjs` 择优：构造三档假报告，验证 4 条规则各触发一次（含"P95 高 12% 时降级"）；
6. `config.json` 写入：`tier` 只能是三个值之一。

**启动测试**（真跑，全部三档）：

```powershell
node tools/voice/eval/run.mjs --tier base  --sink dry
node tools/voice/eval/run.mjs --tier fewshot --sink dry
node tools/voice/eval/run.mjs --tier ft    --sink dry
node tools/voice/eval/compare.mjs
node tools/voice/eval/audio.mjs --tier ft
```

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | 三档各跑 500 条 | 三份报告齐全，`validRate` 均 = 1.0 |
| 7.2 | `compare.mjs` | 输出择优结果并写入 `config.json`；`table` 里三档 F1 可横向比较 |
| 7.3 | 门禁 | 选中档 `actionSetF1 ≥ 0.85`、`refusalRecall ≥ 0.95`、`overRefusal ≤ 0.05` |
| 7.4 | 微调是否有效 | `ft` 的 F1 ≥ `fewshot` 的 F1（否则按 R-16 选 fewshot，并在报告里写明"微调未带来增益及原因"） |
| 7.5 | 音频级 | `e2eSuccess ≥ 0.70`，H 段耗时 P95 ≤ 3.5 s |
| 7.6 | 复现性 | 同一 commit 连跑两次，指标差 ≤ 1 个百分点 |
| 7.7 | 6 条单测 | 全绿 |

---

## 8. 禁止事项

- 不得用 `train.jsonl` 评测（只能用 holdout）；
- 不得为了达标改 kb 数值或评测期望（发现期望错 → 写进报告，由 3.1 修完重跑）；
- 不得用不同 `--limit` 比较三档；
- 不得让评测器依赖网络；
- 不得修改 `pipeline.py` / `parser.py` / `llm.py` / `executor.mjs` / `data/*.jsonl`；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①三档的完整指标表（含 `strengthAcc`/`groundingAcc`）；②`compare.mjs` 的择优结论与理由；③`config.json` 内容；④音频级 30 条的逐条结果与分段耗时；⑤两次跑的复现性证据；⑥未达门禁项的原因分析与建议（扩 kb / 改提示词 / 加训练轮次）；⑦6 条单测输出；⑧与本文不一致处；⑨未解决问题。
