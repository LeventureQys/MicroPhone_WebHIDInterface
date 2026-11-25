# SubStage 1.1 — 模型与运行环境

> **所属 Stage**：Stage 1（基础设施）
> **所属阶段**：阶段三（开发）
> **依赖前置**：无
> **并行状态**：与 SubStage 3.1 **可并行**（文件不重叠）；与 1.2 之外的 SubStage 无冲突
> **任务书版本**：v2（2026-11-24）
> **契约来源**：设计文档 §2.1（文件布局）、§2.4（硬约束）、§4.2（跨 SubStage 契约）

---

## 1. 背景与目标

语音链路要跑起来需要 7 个离线资产（合计约 7.5 GB）与两个隔离的 Python 环境。本 SubStage 交付**可重建**的资产准备层：一条命令下载 + 校验，一条命令建 venv 装依赖。

**为什么必须"可重建"**：`调研报告.md` §2.6 已实测本机网络——`huggingface.co` 与 `github.com` 的 HTML 均不可达，但 **GitHub release 资产直连可下**（206/200）、`hf-mirror.com` 可用、PyPI 直连**慢到卡死**（sherpa-onnx 装了 15 分钟没完）。所以下载路径与镜像必须写死在清单里，不能让下一个人自己试。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/` | **不存在**，本 SubStage 新建 |
| `package.json` | 只有 electron/vite/vitest 依赖；**本 SubStage 不得修改**（D17：不引入运行时依赖） |
| `.gitignore` | 需追加忽略规则（见 §3） |
| 根 `scripts/` | 有 `start.ps1`、`dist.ps1`、`screenshot.mjs` 等；`start.ps1`/`dist.ps1` 存为 UTF-8 带 BOM（PowerShell 5.1 按 GBK 解中文会语法错误） |
| Python | 本机 `C:\Users\a5935\AppData\Local\Programs\Python\Python312\python.exe`（3.12.10），`python` 已在 PATH |

---

## 3. 本 SubStage 产出文件

| 文件 | 作用 |
|---|---|
| `tools/voice/manifest.json` | 资产清单：url / 镜像 / 目标路径 / 期望 SHA256 / 字节数 / 解压方式 |
| `tools/voice/fetch-models.mjs` | 下载 + 校验 + 解压；`--check` 只校验；`--record` 写入实测哈希 |
| `tools/voice/requirements.txt` | 推理侧 Python 依赖固定版本 |
| `voice.cmd` + `scripts/voice.ps1` | 根入口（**UTF-8 带 BOM**）：`fetch` / `venv` / `python` / `trainenv`（占位）/ `server`（占位） |
| `.gitignore` | 追加 `tools/voice/models/`、`tools/voice/.venv/`、`tools/voice/.venv-train/`、`tools/voice/train/out/`、`artifacts/voice/` |

---

## 4. 契约

### 4.1 `manifest.json` 结构（字段名固定）

```json
{
  "v": 1,
  "python": "3.12",
  "pipIndex": "https://pypi.tuna.tsinghua.edu.cn/simple",
  "assets": [
    {
      "id": "llama-cpp",
      "url": "https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cpu-x64.zip",
      "mirror": "https://ghproxy.net/https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-cpu-x64.zip",
      "dest": "models/llama",
      "extract": "zip",
      "size": 25097509,
      "sha256": "<--record 写入>"
    },
    {
      "id": "kws-zh",
      "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2",
      "mirror": "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2",
      "dest": "models/kws",
      "extract": "tar.bz2",
      "size": 32654866,
      "sha256": "<--record 写入>"
    },
    {
      "id": "sense-voice",
      "url": "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx",
      "mirror": null,
      "dest": "models/sense-voice/model.int8.onnx",
      "extract": "none",
      "size": 239233841,
      "sha256": "<--record 写入>"
    },
    {
      "id": "sense-voice-tokens",
      "url": "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt",
      "mirror": null,
      "dest": "models/sense-voice/tokens.txt",
      "extract": "none",
      "size": null,
      "sha256": "<--record 写入>"
    },
    {
      "id": "silero-vad",
      "url": "https://hf-mirror.com/csukuangfj/vad/resolve/main/silero_vad.onnx",
      "mirror": "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
      "dest": "models/vad/silero_vad.onnx",
      "extract": "none",
      "size": 1807522,
      "sha256": "<--record 写入>"
    },
    {
      "id": "qwen3-1.7b",
      "url": "https://hf-mirror.com/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
      "mirror": null,
      "dest": "models/llm/Qwen3-1.7B-Q4_K_M.gguf",
      "extract": "none",
      "size": 1107409472,
      "sha256": "<--record 写入>"
    },
    {
      "id": "qwen3-8b-teacher",
      "url": "https://hf-mirror.com/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
      "mirror": null,
      "dest": "models/teacher/Qwen3-8B-Q4_K_M.gguf",
      "extract": "none",
      "size": null,
      "sha256": "<--record 写入>"
    }
  ]
}
```

`size` 允许 `null`（未知时省略校验）；`sha256` 必须由 `--record` 实测后写回文件（**不许手填**）。

`qwen3-8b-teacher` 只用于 SubStage 5.1 的数据生成（改写表述），**不进推理链路**。SubStage 5.2 另需 HF 格式的 `base-hf/Qwen3-1.7B/`（safetensors ≈ 3.4 GB），由 5.2 自己追加条目，本 SubStage 不下载。

### 4.2 `fetch-models.mjs` 子命令

| 命令 | 行为 | 退出码 |
|---|---|---|
| `node tools/voice/fetch-models.mjs` | 缺什么下什么（先 `url`，失败再 `mirror`；`mirror===null` 时不重试），下完解压，最后逐项 `--check` | 0 全好 / 2 有缺 |
| `--check` | 只校验：文件存在、字节数匹配、SHA256 匹配；打印一行一项：`ok  llama-cpp  25.1 MB  sha256 匹配` | 0 / 2 |
| `--record` | 下载后把实测 `size`/`sha256` 写回 `manifest.json`（保持字段顺序、2 空格缩进、UTF-8 无 BOM） | 0 |
| `--only <id>` | 只处理一个资产 | 同上 |

解压后的**期望目录形状**（后续 SubStage 依赖这些路径，必须逐字一致）：

```
tools/voice/models/
  llama/llama-server.exe
  llama/llama-cli.exe
  llama/llama-quantize.exe
  llama/llama.dll
  llama/llama-common.dll
  llama/ggml.dll
  llama/ggml-cpu-alderlake.dll      （其他 ggml-cpu-*.dll 保留）
  kws/tokens.txt
  kws/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx
  kws/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx
  kws/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx
  sense-voice/model.int8.onnx
  sense-voice/tokens.txt
  vad/silero_vad.onnx
  llm/Qwen3-1.7B-Q4_K_M.gguf
  teacher/Qwen3-8B-Q4_K_M.gguf
```

（`tar.bz2` 解包会多一层目录，必须在 `fetch-models.mjs` 里拍平到 `models/kws/`。）

### 4.3 `requirements.txt`（逐行固定）

```
sherpa-onnx==2.0.3
numpy>=1.26,<3
sounddevice==0.5.6
```

**不要**加 `llama-cpp-python`（PyPI 上 cp312 win 只有 sdist，需要 MSVC 编译；本设计用官方预编译 `llama-server.exe`）、不要加 `requests`（用 stdlib `urllib.request`）、不要加 torch（训练依赖归 `.venv-train`）。

### 4.4 `scripts/voice.ps1` 子命令

| 命令 | 行为 |
|---|---|
| `voice fetch [--check\|--record]` | 调 `node tools/voice/fetch-models.mjs`（参数透传） |
| `voice venv` | 若无 `tools/voice/.venv` 则 `python -m venv`，然后 `pip install -r requirements.txt -i <pipIndex>` |
| `voice python <args...>` | 用 `.venv\Scripts\python.exe` 跑参数 |
| `voice trainenv` | 建 `tools/voice/.venv-train` 并装 `train/requirements-train.txt`；**与 `.venv` 完全隔离**；本 SubStage 只留占位（`throw "SubStage 5.2 落地"`） |
| `voice server [--model base\|teacher\|student]` | 启动 `llama-server.exe`（参数见 SubStage 3.3 §4.1；`--model` 决定 `-m` 指向哪个 GGUF，默认 `base`）；本 SubStage 先留占位 |

脚本要求：自己定位仓库根（`$PSScriptRoot` 上两级）；找不到 `python` 时报中文错误并退出码 1；**不设置**任何全局环境变量；文件必须是 **UTF-8 带 BOM**。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| `url` 与 `mirror` 都失败 | 打印 `下载失败：<id> <url>`，继续下一个，最后退出码 2（不做无限重试） |
| SHA256 不匹配 | 删除该文件并报 `校验失败：<id>（期望 …，实际 …）`，退出码 2 |
| 磁盘空间不足（< 9 GB） | 开跑前检查并提示，退出码 2 |
| `--record` 时文件缺失 | 先下载再记录 |
| `manifest.json` 非法 JSON | 直接抛出（不做兜底） |
| PowerShell 脚本非 UTF-8 BOM | `voice venv` 会先自检文件头 `EF BB BF`，缺失则以中文提示退出码 1 |

---

## 6. 测试要求

**单元测试**（`tools/voice/test/fetch-models.test.mjs`，用 `node --test`）：

1. `--check` 对**缺失文件**返回 2 且输出含 `missing`；
2. `--check` 对**篡改过 1 字节**的临时文件返回 2 且输出含 `sha256`；
3. `--record` 写回后 `manifest.json` 仍可被 `JSON.parse`，且字段顺序与缩进不变（比对字符串）；
4. 解包拍平逻辑：给定 tmp 目录伪造 `xxx/tokens.txt`，断言结果落在 `models/kws/tokens.txt`；
5. 7 个资产的 `id` 唯一、`dest` 不重复。

**启动测试**（必须真跑，把输出粘进完成报告）：

```powershell
.\voice.cmd fetch --check
.\voice.cmd venv
.\voice.cmd python -c "import sherpa_onnx, numpy, sounddevice; print('imports ok', sherpa_onnx.__version__)"
& .\tools\voice\models\llama\llama-server.exe --version
```

第 4 条必须打印出版本串（实测应为 `1.0.0-dev (build 12359 …)` 一类），否则视为启动失败。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `voice fetch --check` | **7 项**全部 `ok`，退出码 0 |
| 7.2 | 删 `models/kws` 后重跑 `voice fetch` | 自动补回并再次 `--check` 通过 |
| 7.3 | `voice venv` 在**新克隆**的干净目录 | 成功建 venv 并装 3 个依赖 |
| 7.4 | `llama-server.exe --version` | 有版本串，退出码 0 |
| 7.5 | 教师模型 | `models/teacher/Qwen3-8B-Q4_K_M.gguf` 存在且 `--check` 通过（约 5 GB） |
| 7.6 | `git status --porcelain` | `models/`、`.venv/`、`.venv-train/` **不出现**（被 ignore） |

---

## 8. 禁止事项

- 不得修改 `src/**`、根 `package.json`、`pnpm-lock.yaml`；
- 不得把模型或二进制提交进 git；
- 不得用 `npm i`/`pnpm add` 装任何 Node 依赖（`fetch-models.mjs` 只用 Node 内置模块 `node:fs`/`node:crypto`/`node:https`/`node:child_process`）；
- 不得把 torch/transformers 装进 `tools/voice/.venv`（训练依赖归 `.venv-train`）；
- 不得在代码或提交信息里使用 emoji；
- 不得生成 README（用法写在本任务书与设计文档里）。

---

## 9. 完成报告要求

必须给出：①7 个资产的实测 `size`/`sha256`（与 manifest 一致）；②`--check` 与 `--version` 的原始输出；③venv 里 `pip list`（只有三行核心依赖）；④教师模型的体积与下载耗时；⑤任何与本文不一致的实现（含原因）；⑥未解决问题（没有就写"无"）。

---

## 10. 实施回填（2026-11-24，交付后复核结论）

实测：7 个资产全量下载约 **3.5 分钟**（hf-mirror 70–80 MB/s；GitHub release 那 25 MB 反而只有 0.23 MB/s），教师 5.03 GB 用 66 s；venv 从零重建 17 s；`node --test` 5/5；`fetch --check` 7/7；`llama-server --version` exit 0。

| # | 偏差 | 裁决 |
|---|---|---|
| 1 | **本文写的 `sense-voice` size 是错的**（239,295,148 → 实测 **239,233,841**，差 −61,307 B） | **以实测为准**，本文 §4.1 的 manifest 已更正。三方旁证：本次下载 / 源站 HEAD `Content-Length` / `D:\Temp` 旧副本完全一致 |
| 2 | `--record` 模式跳过 size/sha 校验门（否则清单写错时会陷入"下载→判不符→重下"死循环） | **接受**；`--check` 仍是严格门禁 |
| 3 | 解包类资产在 `models/.cache/<id>.zip|.tar.bz2` 留归档（多占 58 MB） | **接受**。理由：解包目录没有单一哈希可算，`--check` 的"7 项全 ok"需要归档的哈希；顺带让"删 `models/kws` 后重跑 fetch"变成 1.4 s 本地解压而非重下 32 MB |
| 4 | `voice venv` 的 pip 命令加 `--disable-pip-version-check --no-input` | **接受，且后续所有 SubStage 必须照抄**。不加时 pip 装完会去 `pypi.org` 查新版，本机直连不通，进程卡在退出前（实测两次分别 >600 s / 608 s 才被杀，加上后 1 s 返回） |
| 5 | BOM 自检对所有子命令生效（本文只要求 `voice venv`） | **接受**——一处检查比逐命令检查更难漏 |
| 6 | `voice.cmd` 失败不 `pause`（与 `start.cmd` 不同） | **接受**——自动化调用不能被阻塞 |
| 7 | `artifacts/voice/` 规则冗余（`artifacts/` 已覆盖） | **接受**，按 §3 字面保留 |

**下游必须知道的两条事实**：

1. **`llama-server.exe` 只有 9,728 B**（b12359 是"薄 exe + `llama-server-impl.dll`"结构），`--version` 正常。**SubStage 3.3 / 5.2 不要拿 exe 体积当失败判据**。
2. 资产体积合计约 **6.3 GB**（含教师 4.68 GB）＋ `.cache` 58 MB；`.gitignore` 已覆盖 `models/`、`.venv/`、`.venv-train/`、`train/out/`，`git status` 里不出现。
