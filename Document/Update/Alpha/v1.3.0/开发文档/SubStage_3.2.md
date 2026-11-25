# SubStage 3.2 — 确定性中文解析器

> **所属 Stage**：Stage 3（意图层）
> **所属阶段**：阶段三（开发）
> **依赖前置**：SubStage 3.1（`schema/targets.json` 必须已生成）
> **并行状态**：与 SubStage 2.1 / 2.2 / 3.3 **可并行**（不依赖麦克风与模型）
> **任务书版本**：v1（2026-11-24）
> **契约来源**：设计文档 §3.2（L1 结构）、§3.1（direction 语义）、§4.2（`parser.py:parse`）

---

## 1. 背景与目标

Q6=A 定案：**规则优先，LLM 兜底**。本 SubStage 交付第一层——把高频中文说法**确定性地**变成 L1。

为什么这层必须先做：实测 1.7B 对自由描述会编出无关动作，而规则层 < 1 ms、可单测、可解释。评测（SubStage 5.1）还要靠它算"规则层命中率"。

**边界**：本层**不产出任何 dB 数值**（那是 SubStage 4.1 的规则表），只产出 `target / direction / strength`；也不做同义词纠错之外的语义推测。

---

## 2. 当前代码状态

| 位置 | 现状 |
|---|---|
| `tools/voice/schema/targets.json` | 由 3.1 生成：`tuneTargets` / `toggleTargets` / `strengths` / `directions` / `scenes` / `tones` / `paramIds` / `aliases` / `wakePrefixes` |
| `tools/voice/normalize.py` | 由 2.2 交付（数字/单位已规范化，例如 `负十八分贝` → `-18dB`） |
| `tools/voice/` | 无解析器 |

---

## 3. 本 SubStage 产出文件

| 文件 | 责任 |
|---|---|
| `tools/voice/lexicons/zh.json` | 说法表（≥ 60 条），结构化 |
| `tools/voice/parser.py` | `parse()` / `parse_control()` |
| `tools/voice/test/test_parser.py` | 单元测试 |

---

## 4. 契约

### 4.1 `lexicons/zh.json` 结构（**v2 起由 SubStage 3.1 生成，本层只读**）

> **改动说明（v2）**：v1 里这张表是手写的；v2 起它是 `emit.mjs` 的生成物，唯一真值是 `tools/voice/contract/kb.ts`。本层**不得手改** `lexicons/zh.json`——要加说法就去 3.1 的 kb 加 `aliases` 再重新 `emit`。理由是同一份说法还要喂给训练数据与评测期望，四处手写必然漂移（R-11）。
> `emit` 输出的 `lexicons/zh.json` 与你读到的这份结构完全一致，下面的示例即生成后的形态。

```json
{
  "v": 1,
  "strengthWords": {
    "slight": ["一点", "稍微", "有点儿", "略微", "小一点"],
    "strong": ["很", "特别", "非常", "太", "超"]
  },
  "entries": [
    { "pattern": "闷|浑浊|浑|糊|箱音|鼻音", "target": "muddiness", "direction": "less" },
    { "pattern": "亮|明亮|通透|清亮|发亮", "target": "brightness", "direction": "more" },
    { "pattern": "暗|发暗", "target": "brightness", "direction": "less" },
    { "pattern": "底噪|噪音|噪声|电流声|呼呼声|环境声", "target": "noiseFloor", "direction": "less" },
    { "pattern": "齿音|刺耳|太尖|si音|嘶", "target": "sibilance", "direction": "less" },
    { "pattern": "毛刺|扎耳朵|刮|发硬", "target": "harshness", "direction": "less" },
    { "pattern": "低音|低频|重低音|下潜|轰", "target": "lowEnd", "direction": "more" },
    { "pattern": "暖|温暖|厚实|圆润", "target": "warmth", "direction": "more" },
    { "pattern": "冷|薄|干瘪|单薄", "target": "warmth", "direction": "less" },
    { "pattern": "清楚|清晰|人声突出|靠前", "target": "clarity", "direction": "more" },
    { "pattern": "忽大忽小|不稳|太平", "target": "compression", "direction": "more" },
    { "pattern": "声音小|听不清|太小|响一点|大声", "target": "loudness", "direction": "more" },
    { "pattern": "气口|呼吸声|断断续续|吞字", "target": "gate", "direction": "less" },
    { "pattern": "爆音|破音|削顶|喷麦|过载", "target": "limiter", "direction": "more" }
  ],
  "switches": [
    { "pattern": "打开降噪|开降噪|启用降噪", "target": "noiseFloor", "on": true },
    { "pattern": "关掉降噪|关闭降噪|关降噪|不要降噪", "target": "noiseFloor", "on": false },
    { "pattern": "打开压缩|开压缩", "target": "compression", "on": true },
    { "pattern": "关掉压缩|关压缩", "target": "compression", "on": false },
    { "pattern": "打开防爆音|开防爆音|开限幅", "target": "limiter", "on": true },
    { "pattern": "关掉防爆音|关防爆音|关限幅", "target": "limiter", "on": false },
    { "pattern": "打开噪声门|开噪声门", "target": "gate", "on": true },
    { "pattern": "关掉噪声门|关噪声门", "target": "gate", "on": false },
    { "pattern": "打开灯效|开灯效|把灯打开", "target": "rgbMode", "on": true },
    { "pattern": "关闭灯效|关灯效|把灯关掉", "target": "rgbMode", "on": false },
    { "pattern": "静音|闭麦|关麦|别收音了", "target": "mute", "on": true },
    { "pattern": "取消静音|开麦|解除静音", "target": "mute", "on": false },
    { "pattern": "打开监听|开监听", "target": "monitor", "on": true },
    { "pattern": "关掉监听|关监听|不要监听", "target": "monitor", "on": false }
  ],
  "scenes": [
    { "pattern": "安静房间|安静模式", "scene": "quiet" },
    { "pattern": "游戏模式|打游戏", "scene": "game" },
    { "pattern": "播客模式|录播客", "scene": "podcast" },
    { "pattern": "唱歌模式|唱歌", "scene": "sing" },
    { "pattern": "自定义模式", "scene": "custom" }
  ],
  "scenarios": [
    { "pattern": "直播|带货", "scenario": "live" },
    { "pattern": "开会|会议|网课", "scenario": "meeting" },
    { "pattern": "配音|旁白|有声书", "scenario": "dub" },
    { "pattern": "asmr|轻声", "scenario": "asmr" }
  ],
  "tones": [
    { "pattern": "原声|原声模式", "tone": "flat" },
    { "pattern": "人声增强|人声模式", "tone": "vocal" },
    { "pattern": "温暖模式|温暖音色", "tone": "warm" },
    { "pattern": "明亮模式|明亮音色", "tone": "bright" },
    { "pattern": "自定义音色", "tone": "custom" }
  ],
  "explainOnly": [
    { "pattern": "回音|有回声|像在桶里|房间太空", "id": "echo" },
    { "pattern": "喷麦|p音爆|噗噗声", "id": "plosive" },
    { "pattern": "电流声|嗡嗡|50赫兹哼声", "id": "hum" },
    { "pattern": "背景音乐串|耳机漏音", "id": "bgm" }
  ],
  "undo": "撤销|撤消|回到上一步|刚才那个不要了|恢复原样",
  "confirm": "确认|确定|好|可以|行|没问题|是的|对",
  "bandParam": "第(?P<band>[1-7一二三四五六七])段(?P<field>增益|频率|q值|带宽)?",
  "hzParam": "(?P<hz>\\d+(?:\\.\\d+)?)\\s*(?:赫兹|hz|k|千赫)"
}
```

**硬要求**：`entries` + `switches` + `scenes` + `scenarios` + `tones` 合计 **≥ 52 条**；13 个维度每个方向各 ≥ 1 条；`pattern` 里除 `bandParam`/`hzParam` 外**不要**用捕获组。

**匹配顺序是硬契约（3.1 交付后回填）**：必须**按 `entries` 的数组顺序取第一个命中**，不得改成最长匹配、不得按 target 排序。原因：emit 刻意把"非主方向条目"排在前面，否则"闷一点"会被"闷"（`muddiness.less`）吞掉。3.1 交付时用穷举脚本验证过 255 条说法"首命中全部正确、explainOnly 零抢占"，改匹配策略会让这批验证作废。`explainOnly` 仍然优先于 `entries`（见 §4.2 的优先级 0）。

**歧义消解规则（必须按此优先级实现）**：
0. 命中 `explainOnly` → 直接返回 `{"v":1,"status":"unsupported","ops":[],"say":"<kb 的 explain>","confidence":1}`，**不写参数**（"有回音"不是 EQ 问题）；同句若还命中 `entries`，`explainOnly` 优先；
1. 含"模式/音色"字样 → 走 `tones`/`scenes`（例：`"温暖模式"` → tone，而不是 warmth target）；
2. 含"打开/关掉/开/关/启用/关闭"且命中 `switches` → toggle（例：`"关掉压缩"` → toggle，而不是 compression 减弱）；
3. 命中 `bandParam` 且句子里有数字（`-18`、`3`、`4.5`）→ `set` op（`eq.bandN.<field>`）；
3b. 命中 `bandParam` 但**没有**数字 → `eq` op：`{"kind":"eq","band":N,"field":"gain|q|freq","direction":…,"strength":…}`；
3c. 命中 `hzParam`（"250 赫兹""三 k""12.5 k"）→ `eq` op 用 `centerHz`，并按 `targets.json` 的 `bands` **就近映射**到 band；映射落在 `kind: 'hpf'|'lpf'` 的段上 → 返回 `unsupported`，`say` = "那是滤波器，不是均衡段"；
4. 其余命中 `entries` → tune op；
5. 一条句子里命中多个 `entries` → **每个 target 一个 op，最多 3 个**（"又闷又刺" → muddiness + sibilance）；
6. 数字接地：`set` 的 `value` 必须能在原话里找到；找不到则**不产出该 op**（这一条与 4.1 的校验重复实现是刻意的：单测两处都要过）。

### 4.2 `parser.py`

```python
class TargetsDoc:                     # 读 schema/targets.json
    tune: tuple[str, ...]; toggle: tuple[str, ...]
    strengths: tuple[str, ...]; scenes: tuple[str, ...]; tones: tuple[str, ...]
    param_ids: frozenset[str]; aliases: dict[str, tuple[str, ...]]

def load_targets(path: str = "tools/voice/schema/targets.json") -> TargetsDoc

def parse(text: str, *, targets: TargetsDoc, lexicon_path: str = "tools/voice/lexicons/zh.json") -> dict | None:
    """命中 → 返回符合设计文档 §3.2 的 L1 dict（status 恒为 'ok'，confidence 恒为 1）；
    未命中 → 返回 None（调用方转 LLM）。永不抛业务异常。"""

def parse_control(text: str, *, lexicon_path: str = "tools/voice/lexicons/zh.json") -> str | None:
    """返回 'confirm' | 'undo' | None（用于二次确认与撤销握手）"""
```

返回样例（**与设计文档 §3.2 完全一致**）：

```python
parse("声音有点闷")
# {"v":1,"status":"ok","say":"把闷的地方收一收","confidence":1,
#  "ops":[{"kind":"tune","target":"muddiness","direction":"less","strength":"slight"}]}

parse("第六段增益提到3dB")
# {"v":1,"status":"ok","say":"第六段增益设为 3dB","confidence":1,
#  "ops":[{"kind":"set","param":"eq.band6.gain","value":3}]}

parse("切换播客模式")
# {"v":1,"status":"ok","say":"切到播客","confidence":1,
#  "ops":[{"kind":"scene","scene":"podcast"}]}
```

`say` 由解析器生成（短、≤30 字、中文），不交给模型；文案模板：`tune` → `"把{中文名}{方向副词}{档位副词}"`；`set` → `"{参数中文名}设为 {value}{单位}"`。**文案里不许出现 emoji**。

**唤醒词剔除**：`parse` 开头按 `targets.wakePrefixes` 去掉句首命中的前缀（"小唐小唐，把声音调亮" → "把声音调亮"）。

---

## 5. 行为与错误处理

| 情况 | 行为 |
|---|---|
| `text` 为空/纯空白 | 返回 `None` |
| `lexicons/zh.json` 缺失或非法 | 构造时抛 `FileNotFoundError` / `ValueError`（不吞） |
| `targets.json` 里的 target 在 lexicon 中不存在 | `load_targets` 时打一条 `warn`，不抛（允许 lexicon 先于词表扩展） |
| `set` 的 band 号不在 1..7 | 丢弃该 op；若全丢则返回 `None` |
| `set` 的 param 不在 `targets.param_ids` | 丢弃该 op（同上） |
| 数值超出该参数范围 | **不在这里夹紧**（4.1 负责），原样返回 |
| 中文数字（"六"） | 本层必须支持 1–7 的中文数字映射 |

---

## 6. 测试要求

**单元测试**（`python -m unittest discover -s tools/voice/test`）：

1. lexicon 条目总数 ≥ 60；
2. 30 条中文说法表驱动：断言 `ops[0].target` 与 `direction`/`on`/`scene`/`tone` 完全符合预期（覆盖 12 个 tune target、7 个 toggle、5 个 scene、4 个 tone）；
3. 歧义消解三条："温暖模式"→tone、**不是** warmth；"关掉压缩"→toggle off、**不是** compression less；"第六段增益提到3dB"→set；
4. 多意图："又闷又刺" → 2 个 op，target 为 muddiness + sibilance；
5. 唤醒词剔除："小唐小唐，声音亮一点" 与 "声音亮一点" 结果相同；
6. 未命中："放首歌" / "今天天气怎么样" → `None`；
7. `parse_control("确认")` → `'confirm'`；`parse_control("撤销")` → `'undo'`；`parse_control("声音亮一点")` → `None`；
8. 性能：单条解析 ≤ 5 ms（1000 次循环取均值）。

**启动测试**（真跑）：

```powershell
.\voice.cmd python tools\voice\parser.py --selftest
```
打印 30 条表驱动的 PASS/FAIL 明细与命中率，写 `artifacts/voice/selftest-32.json`。

---

## 7. 可观察验收标准

| # | 步骤 | 期望 |
|---|---|---|
| 7.1 | `--selftest` | 30 条判对率 ≥ 95%（≥29/30），明细可读 |
| 7.2 | lexicon 条目数 | ≥ 60（打印实际数） |
| 7.3 | 8 条单测 | 全绿 |
| 7.4 | 与 3.1 的 `targets.json` 对照 | lexicon 里出现的每个 target 都在 `tuneTargets`/`toggleTargets` 中 |

---

## 8. 禁止事项

- 不得在本层产生任何 dB/Hz 数值（除显式 `set` 里用户自己说的数）；
- 不得读 `src/**` 或复制参数范围（本层不需要参数真值）；
- 不得修改 `targets.json`（那是 3.1 的生成物）；
- 不得调用 LLM（本层必须完全离线、确定性）；
- 不得在代码或提交信息里使用 emoji。

---

## 9. 完成报告要求

给出：①`--selftest` 的 30 条明细与命中率；②8 条单测输出；③lexicon 实际条目数与 target 覆盖矩阵（12/7/5/4 各覆盖几个）；④未命中的说法清单（供阶段五扩表）；⑤与本文不一致处；⑥未解决问题。

---

## 10. 实施回填（2026-11-24，交付后复核结论）

| # | 事项 | 定案 |
|---|---|---|
| 1 | 本文 §6 的"30 条"与它自己列的覆盖分组（13+7+5+4+3+2+2+2 = 38）算术冲突 | **主表严格 30 条**（13 tune + 7 toggle + 5 scene + 4 tone + 1 未命中）+ **补充分组 8 条**（eq 3 / 多意图 2 / explainOnly 2 / 未命中 1）；两段各自打印命中率，主表门禁仍是 ≥29/30。实测 30/30 + 8/8 |
| 2 | "词表 ≥ 60 条" | 五类的硬门槛是 **≥ 52**（实测 58）；把 `explainOnly` 计入才是 62。单测两套口径都断言 |
| 3 | 设计文档 §3.2 样例 1（`medium / confidence 0.75`）与本文 §4.2（`slight / confidence 1`）冲突 | **以本文为准**（规则层确定性，`confidence` 恒 1，"有点"归 slight）。设计文档样例已改为"规则层形态"，并注明 LLM 层可能是 medium/0.75 |
| 4 | 「又闷又刺」只命中 muddiness | 词表缺裸「刺」，已回 SubStage 3.1 增补别名后重新 emit；本层用「又闷又有齿音」「声音有点闷又有点刺耳」验证同一性质 |
| 5 | `explainOnly` 的 `say` 超过 L1 的 30 字上限 | 按本文 §4.2 优先级 0 的约定（`say` = kb 的 `explain`）**不截断**——那是给用户听的一句话，不是模型输出 |
| 6 | 「声音有点大 / 声音有点小」「麦克风关掉」未命中 | 属知识本体缺口，已回 SubStage 3.1 补别名并重新 emit；本层不得手改生成物 |

**必须保住的两条隐式契约**：①`entries` 按数组顺序取首命中（「闷一点」→ more、「有点闷」→ less）；②`explainOnly` 零抢占（「有回音，而且声音也闷」→ 只回 unsupported）。
