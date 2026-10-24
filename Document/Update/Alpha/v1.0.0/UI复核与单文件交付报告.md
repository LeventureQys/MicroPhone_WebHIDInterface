# 界面改版与单文件交付报告 — Alpha v1.0.0

日期：2026-10-19
范围：按「一屏承载全部主要逻辑」重做信息架构 + 单 exe 交付复核
基准：`需求文档.md`、`设计文档.md`（§5.12 / §5.15 已同步）、`效果器参数范围.xlsx`

## 1. 改版原因

第一版按「专业调音台」组织：左导轨 7 个页面、36 个协议参数全部铺开。复核后确认三个问题：

1. **产品不是给工程师用的**：非专业用户不知道 NoiseGate / Attack / Ratio / Q，也不知道该先调哪个。
2. **页面切换有成本**：电平、降噪、音量、音色分散在 4 个页面，调一次声音要在页面间来回跳。
3. **上一版「简易/专业」开关是错误解法**：它把复杂度推给用户选择，而不是把逻辑收进一屏。

因此最终结构是：**一屏工作台 + 三个抽屉**。日常操作 100% 在第一屏完成；协议参数只在「高级参数」抽屉里出现。

## 2. 一屏信息架构

```text
┌ 顶栏：品牌 · 状态 pill（已就绪/演示）· 高级参数 · 设置 · 中/EN · 连接设备 ┐
├──────────────────────────────────────────────────────────────────────────┤
│ 一键场景： 会议 | 播客 | 唱歌 | 安静房间                                  │
├──────────────┬──────────────────────────────┬────────────────────────────┤
│ 实时电平      │ 快速调音                       │ 音色曲线（7 段可拖拽）       │
│ 输入/输出柱   │ 降噪强度  ──●──               │                            │
│ -60..0 dBFS  │ 声音平稳  ──●──               │  对数频率轴 20Hz–20kHz      │
│ 峰值保持      │ 音色：原声/人声/温暖/明亮/音乐  │  拖动节点调增益、滚轮调 Q    │
│ 麦克风/耳机增益│                               │                            │
│ 设备摘要      │ 快捷开关：环境降噪 + 档位       │  想更细？打开高级参数        │
│              │ 防爆音                         │                            │
└──────────────┴──────────────────────────────┴────────────────────────────┘
```

- **一键场景**（`domain/scenes.ts`）：会议 / 播客 / 唱歌 / 安静房间。一次写入 5 个协议字段 + 7 段 EQ；参数仍完整匹配时按钮高亮，用户手调任意一个控件后自动取消高亮。
- **左栏**：实时电平（双通道垂直柱、峰值保持、dBFS 刻度）、麦克风/耳机增益（只读）、数据源摘要（演示数据、模拟状态、打开设备抽屉）。
- **中栏**：两个业务旋钮（降噪强度、声音平稳）+ 音色风格 chip；快捷开关（ENC 开关与 0–3 档、防爆音开关）。
- **右栏**：音色曲线，7 个可拖拽节点，对数频率轴，鼠标滚轮调 Q；底部一行「想更细？打开高级参数」。
- **抽屉**（`ui/modal.ts`，不切页、不销毁底层）：
  - 高级参数：输入与降噪 / 动态 / 均衡（7 段表 + 内部段）/ 三分频动态；
  - 连接设备：通道、桥接、连接/断开/刷新、设备列表、报告、套件信息；
  - 设置：语言、模拟场景、复位全部参数（二次确认）、关于。

### 布局与响应式

- 1280×820（默认）：场景条 144px 高，主行 525px；三栏 300 / 410 / 1fr。
- 1100×700（最小）：场景条 116px，主行 434px；三栏 280 / 360 / 1fr；隐藏提示文字，`scrollHeight` 与内容区高度一致，**一屏不滚动**。
- 曲线在窄栏下自动隔一个刻度画一个，避免 20Hz–20kHz 标签叠字。

## 3. 业务逻辑（普通人能理解的映射）

### 一键场景

| 场景 | 降噪强度 → NoiseGate.threshold_db | 平稳度 → Comp.Threshold | 音色 → 7 段 EQ | ENC | 防爆音 |
|---|---|---|---|---|---|
| 会议 | 55 → -41 dB | 60 → -36 dB | 人声 | 开 · 档 2 | 开（-3 dBFS） |
| 播客 | 35 → -59 dB | 70 → -42 dB | 温暖 | 开 · 档 1 | 开 |
| 唱歌 | 20 → -73 dB | 35 → -21 dB | 明亮 | 关 | 开 |
| 安静房间 | 10 → -82 dB | 30 → -18 dB | 原声 | 关 | 开 |

### 业务旋钮

| 控件 | 0..100 行程 | 映射 | 说明文案 |
|---|---|---|---|
| 降噪强度 | 0 = 关闭 | `NoiseGate.threshold_db` -91..0 dB | 「调大能压掉更多底噪，但小声说话可能被一起压掉」 |
| 声音平稳 | 0 = 不压 | `Comp.Threshold` 0..-60 dB | 「调大后声音更稳，但整体会变轻；需要时到高级参数里补音量」 |
| 防爆音 | 开关 | `Limit.Threshold` 开 -3 / 关 0 dBFS | 「限制最大音量，避免突然破音」 |
| 音色 | 5 个风格 | 7 段 EQ 增益（原声/人声/温暖/明亮/音乐） | 曲线同步变化 |

所有映射只动 UI 层，协议范围 / 步进仍以 xlsx 为准；高级参数抽屉里能看到真实字段值。

## 4. 代码结构调整

| 变更 | 文件 |
|---|---|
| 新增一屏工作台 | `src/renderer/src/ui/views/console-view.ts` |
| 新增抽屉宿主 | `src/renderer/src/ui/modal.ts` |
| 新增高级参数抽屉 | `src/renderer/src/ui/views/advanced-view.ts`、`ui/views/eq-band-table.ts` |
| 新增业务映射 | `src/renderer/src/domain/scenes.ts`、`domain/quick-controls.ts` |
| 新增参数轴换算 | `src/renderer/src/domain/slider-scale.ts` |
| 重写外壳 | `src/renderer/src/app/shell.ts`（顶栏 + 工作台 + 三个抽屉） |
| 删除页面/路由 | `app/router.ts`、`ui/navrail.ts`、`ui/views/meter-view.ts`、`ui/views/eq-view.ts`、`domain/ui-mode.ts` |
| 页面改为抽屉内容 | `ui/views/input-view.ts`、`dynamics-view.ts`、`drc-view.ts`、`device-view.ts`、`settings-view.ts` |

## 5. 验证

### 交互链路（`scripts/probes/console-flow.js`，实测输出）

```json
{"sceneActive":"meeting","scenePatch":{"threshold":"-41","comp":"-36","encOn":true,"limit":"-3","gains":["-3","-2","-1","1","3","2","0"],"sections":4,"eqRows":7},"modalClosed":true,"sceneAfterTweak":null,"thresholdAfterTweak":"-36","toneActive":"warm","warmGains":["4","3","2","0","-1","-2","-3"],"encState":{"on":false,"level":"2"},"limitAfterOff":"0","settingsModal":true,"resetArmed":"再次点击确认复位","resetDone":"已复位","deviceModal":true,"sceneAfterReset":null,"toneAfterReset":"flat"}
```

覆盖：场景落参、抽屉开关与 Esc、手调后场景高亮取消、音色写入 7 段、ENC 档位、防爆音开关、设置二次确认复位、设备抽屉。

### 版式

- 1280：`scope h=683`，场景 144，主行 525，调音 381，开关 130；无溢出。
- 1100×700：`host h=599 / scrollHeight=599`，场景 116，主行 434；**一屏不滚动**。

### 截图

- `artifacts/console-zh-1280.png`
- `artifacts/console-zh-1100.png`
- `artifacts/console-en-1280.png`
- `artifacts/shot-console.png`、`shot-advanced.png`、`shot-device.png`、`shot-settings.png`
- 打包产物截图：`artifacts/portable-console.png`

### 工程

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0 |
| `vitest run` | 18 files / 126 tests 全部通过（新增 `scenes` 4 项、`quick-controls` 6 项） |
| `electron-vite build` | exit 0 |
| `pnpm run screenshot` | console / advanced / device / settings 4/4 出图 |
| `pnpm run dist:win` | exit 0 |

## 6. 单 exe

- 产物：`release/MicStudio-1.0.0-alpha.0-portable.exe`（72 526 373 B ≈ 69.2 MiB）
- SHA256：`B02DC59612E54BBD741ECD23BC3B276E4BA68CD5B0D9A90FD966E011DC159EA8`
- 数据目录：`<exe 同级>\MicStudioData`（不可写时回退 `%APPDATA%\MicStudio`）
- 实测：
  - 只复制 exe 到空目录，`--screenshot` 出图成功（`MicStudioData` 自动创建）；
  - `cmd /c start` 无参启动（与 Explorer 双击同路径）：窗口 `MIC STUDIO`、`renderer ready`、`CloseMainWindow()` 后 `window-all-closed` / `before-quit` 干净退出。
- 未签名：首次运行会弹 SmartScreen「未知发布者」，属预期。

## 7. 已知边界

| 项 | 现状 | 后续 |
|---|---|---|
| 顶栏 pill / 数据源摘要反映 Mock 传输，不是 WebHID 链路 | 数据源摘要标注「演示数据 / 模拟中」 | 真机联调时把 `WebHidSession` 状态提升到工作台 |
| 设备抽屉里的桥接地址与 `python -m virtual_hid serve` | Alpha 联调入口 | 正式版改为「本地服务未启动」引导或自动拉起 |
| 场景与业务旋钮是 UI 层组合，未与 DSP 参数整定 | 只写协议字段，不动设备算法 | 联调后按实测听感重调场景数值 |
| NSIS 安装包 | 本轮只交付单 exe | `pnpm run dist:installer` 保留 |
| 代码签名 | 无证书 | 上线前接签名，消除 SmartScreen 提示 |
