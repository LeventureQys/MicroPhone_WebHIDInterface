# SubStage 5.1 — 蒸馏数据构建

> **所属 Stage**：Stage 5（蒸馏与评测）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 3.1（`kb.ts` 与四份生成物）、3.2（`parser.py`，用作语义一致性回测）、1.1（教师模型 `models/teacher/Qwen3-8B-Q4_K_M.gguf`）
> **并行状态**：与 SubStage 4.2 **可并行**；SubStage 5.2 依赖本 SubStage
> **任务书版本**：v2（2026-11-24）
> **契约来源**：设计文档 §1.2（做 4）、§3.2（L1）、§4.2、R-12（标签来自 kb、表述由教师改写）、§6 风险（数据泄漏/教师引入错误）

---

## 1. 背景与目标

小模型没有"闷 = 削 250 Hz"这类先验（实测 1.7B 对自由描述会编出无关动作）。补的办法不是手写更多词表，而是**用知识本体当教师、用大模型把表述讲得更像人话**，造出几千条"用户会怎么说 → 该做什么"的语料，再微调学生模型。

**核心纪律（写死，违反即返工）**：
1. **标签只来自 `kb.ts`**。教师模型**只改 `text`，永不产出 `plan`**；
2. 改写句必须能被 `parser.py` 命中**同一条 kb 条目**（语义一致性回测），否则丢弃——这条把"教师把闷改写成明亮"挡在数据门外；
3. 训练集与留出集**按 kb 条目 id + 模板 id 分组切分**，不按行随机切（否则改写句跨集会泄漏）。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/contract/kb.ts` + `gen/rules.json` + `lexicons/zh.json` | 3.1 交付（本 SubStage 只读） |
| `tools/voice/parser.py` | 3.2 交付（本 SubStage 用于回测） |
| `tools/voice/models/teacher/Qwen3-8B-Q4_K_M.gguf` | 1.1 下载（约 5.0 GB） |
| `tools/voice/data/` | 不存在，本 SubStage 新建（**入库**） |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/datagen/templates.mjs` | 核心句模板（按 kb 条目 × 档位 × 场景组合） |
| `tools/voice/datagen/rewrite.mjs` | 调教师模型改写（可断点续跑） |
| `tools/voice/datagen/verify.mjs` | 语义一致性回测 + 去重 + 分集 |
| `tools/voice/datagen/build.mjs` | 总入口：模板 → 改写 → 校验 → 分集 → manifest |
| `tools/voice/data/train.jsonl`、`data/holdout.jsonl`、`data/manifest.json` | 数据集（入库） |
| `tools/voice/test/test_datagen.mjs` | 单元测试 |

---

## 4. 契约

### 4.1 数据行格式（逐字段固定）

```json
{"id":"t000123","text":"声音有点闷，帮我弄通一点","src":"teacher",
 "kb":"muddiness:less:medium","plan":{"v":1,"status":"ok","say":"把闷的地方收一收","confidence":1,
 "ops":[{"kind":"tune","target":"muddiness","direction":"less","strength":"medium"}]},
 "split":"train","scene":null}
```

- `src` ∈ `template | teacher | hand`；
- `kb` = `<target|eq|switch|scene|set|outofscope>:<direction|band|on|param>:<strength|null>`，用于分组切分与统计；
- `split` ∈ `train | holdout`；
- `plan` 必须能被 `voice-plan.schema.json` 校验通过（`build.mjs` 用 `ajv` 之外的**手写校验**即可，避免新增依赖：按 3.3 §4.3 的 1–7 条自检）。

### 4.2 数量与构成（硬指标）

| 类别 | 条数 | 说明 |
|---|---|---|
| tune（13 维度 × 2 方向 × 3 档） | 78 × 5 种说法 ≈ **390 核心句 → 改写后 ≥ 2 600** | 每格至少 3 条不同表述 |
| eq 频段寻址（7 段 × 2 方向 × 2 档 + `centerHz` 变体） | ≈ **56 核心句 → ≥ 400** | 含"250 赫兹""三 k""12.5 k"三类说法 |
| toggle（7 × 2） | 14 → **≥ 140** | 含"别收我气口""把降噪关掉" |
| scene + scenario（8 场景 + 5 内置） | 13 → **≥ 130** | 含"我要直播""换成唱歌模式" |
| set（显式数值，数字接地） | 20 → **≥ 200** | 含中文数字、小数、负值、段号 |
| unsupported（范围外） | 30 → **≥ 300** | 音乐/天气/闲聊/别的硬件 |
| explainOnly（回音/喷麦/电流声/背景音乐） | 4 → **≥ 160** | 期望 `status:'unsupported'` + 解释类 |
| clarify（模糊） | 10 → **≥ 100** | "调一下""不太对" |
| **对抗样本**（多意图、否定、"别…了"、超长句、中英混） | — | **占总量 10%** |

**总计 5 000 条**（4 500 train / 500 holdout）。

### 4.3 `rewrite.mjs`

```powershell
node tools/voice/datagen/rewrite.mjs --in artifacts/voice/datagen/cores.jsonl --out artifacts/voice/datagen/raw.jsonl --per-core 8 [--resume]
```

- 教师服务地址默认 **`http://127.0.0.1:8769`**（**不是 8768**：8768 归推理侧 base/student，见设计文档 §3.8 的端口分配表；教师是长跑进程，与 3.3/5.3 抢同一端口会让请求被投递到错误的模型）。
  启动命令（必须带两个关思考开关，否则 `content` 为空、只有 `reasoning_content`，改写会拿到空串）：
  ```
  tools\voice\models\llama\llama-server.exe -m models\teacher\Qwen3-8B-Q4_K_M.gguf \
    --host 127.0.0.1 --port 8769 -t 14 -c 4096 -np 1 --jinja -ngl 0 \
    --reasoning-budget 0 --chat-template-kwargs "{\"enable_thinking\":false}"
  ```
- 采样参数：`temperature 0.9`、`top_p 0.95`、`max_tokens 40`、`n` 由 `--per-core` 控制（逐条请求，不用 `n` 参数以免 llama.cpp 版本差异）；
- 提示词要求：**只输出改写后的中文句子，不解释、不加引号、不出现数字**（出现数字直接丢弃，防止教师往数据里塞 dB）；
- **断点续跑**：已完成的核心句 id 记在 `artifacts/voice/datagen/done.txt`，`--resume` 跳过；
- 预估：600 核心句 × 8 次 ≈ 4 800 次请求 × ~30 token。教师 8B Q4 在**本机 CPU** 约 8–12 tok/s → **3–6 小时**（可后台跑）。若改 GPU 版 `llama-server`（CUDA 构建）可降到 ~40 分钟，属可选项。

### 4.4 `verify.mjs` 的三道关

1. **语义一致性**：`parser.parse(text)` 必须返回与核心句**同一个** `kb` 键（target + direction + strength 完全一致）。不一致 → 丢弃并计入 `rejected`；
2. **去重**：`normalize(text)` 后取 sha1，重复即丢；
3. **分集**：按 `kb` 分组（同 `kb` 键的样本整体进同一 split），保证 train/holdout 的 `kb` 键**交集为空**；再按 9:1 比例分配，`--seed 20261124` 固定。

### 4.5 `data/manifest.json`

```json
{"v":1,"createdAt":"…","seed":20261124,
 "kbSha256":"…","teacher":"Qwen3-8B-Q4_K_M.gguf@<sha256前16>",
 "counts":{"train":4500,"holdout":500,"rejected":123,"deduped":45},
 "byClass":{"tune":2600,"eq":400,"toggle":140,"scene":130,"set":200,"unsupported":300,"explain":160,"clarify":100,"adversarial":500},
 "splitKeys":{"train":["brightness:more:medium",…],"holdout":[…]}}
```

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| 教师服务连不上 | 退出码 5，提示先 `voice server --model teacher` |
| 改写结果含阿拉伯数字 | 丢弃（记为 `rejected`，原因 `has-digit`） |
| 改写结果长度 < 3 或 > 30 字 | 丢弃 |
| 改写结果为空/纯标点 | 丢弃 |
| 某核心句 8 次改写全被丢弃 | 记 `warn`，在报告里列出（不改模板，先看比例） |
| 留出集某 `kb` 键样本 < 3 条 | 该键重分到 train，并在报告里说明（避免 holdout 过小不稳定） |
| 中断后重跑 | `--resume` 从断点继续，最终产物与一次跑完**逐字节一致**（同一 seed） |

---

## 6. 测试要求

**单元测试**（`node --test tools/voice/test/test_datagen.mjs`，用假教师，不联网）：

1. 模板生成：13×2×3 = 78 个 tune 核心句全覆盖，每个至少 1 条；
2. 改写结果含数字 → 被丢弃；
3. 语义不一致（假教师把"闷"改写成"亮"）→ 被丢弃并计入 `rejected`；
4. 去重：同一句重复 3 次只留 1 条；
5. 分集：`train` 与 `holdout` 的 `kb` 键交集为空；
6. `--resume`：跑一半中断再续跑，产物哈希与一次跑完相同；
7. 每行 `plan` 通过 §4.1 的结构自检（8 种 kind 各造一条合法样本 + 3 条非法样本应被拒）；
8. 对抗样本占比在 8%–12% 之间。

**启动测试**（真跑）：

```powershell
.\voice.cmd python -m tools.voice.datagen --cores    # 或 node tools/voice/datagen/build.mjs --cores-only
node tools/voice/datagen/build.mjs --cores-only --out artifacts/voice/datagen/cores.jsonl
node tools/voice/datagen/rewrite.mjs --per-core 8 --resume      # 长跑，可后台
node tools/voice/datagen/verify.mjs
```

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `counts` | `train=4500`、`holdout=500`（±2%） |
| 7.2 | `byClass` | 8 类全部非空，且 unsupported ≥ 300、adversarial 8%–12% |
| 7.3 | 分集检查 | `train`/`holdout` 的 `kb` 键交集为空（单测 + 报告） |
| 7.4 | 语义一致率 | `rejected / (accepted + rejected)` ≤ 40%（高于 40% 说明模板或提示词要改） |
| 7.5 | 复现性 | 同一 seed 两次跑，`manifest.json` 的 `counts` 与文件 sha256 一致 |
| 7.6 | 8 条单测 | 全绿 |

---

## 8. 禁止事项

- 不得让教师模型产出 `plan`（标签只能来自 kb）；
- 不得手写 `lexicons/zh.json` 或 `gen/rules.json`（3.1 的生成物）；
- 不得按行随机切分（必须按 kb 键分组）；
- 不得在数据里保留含阿拉伯数字的改写句（防止把 dB 塞给学生）；
- 不得修改 `kb.ts`（发现维度不够 → 停下报告，由 3.1 扩展后再跑）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①`manifest.json` 全文；②8 类条数与对抗样本占比；③`rejected` 的 Top 10 原因与样例；④语义一致率；⑤两次跑的哈希一致性证据；⑥教师长跑的实际耗时（每千次请求）；⑦8 条单测输出；⑧与本文不一致处；⑨未解决问题。
