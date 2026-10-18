# UI 测试报告 — Alpha v1.0.0

日期：2026-10-17
被测对象：`out/`（`electron-vite build` 产物，源码运行）与 `release/win-unpacked/MicStudio.exe`（打包产物）
测试方式：Electron `capturePage` 取真实像素 → 视觉通道逐张判读（非人工截图对比）

## 0. 视觉通道自检

| 项 | 结果 |
|---|---|
| 图像读取工具可用性 | **通过**：本次及此前共 14 张 PNG 均成功解析（1583×979 / 1358×829），可读出文字、控件状态、数值、颜色与几何关系 |
| 是否需要阻断 | **否** |

## 1. 测试矩阵

| 维度 | 取值 | 截图 |
|---|---|---|
| 页面 | meter / input / eq / dynamics / drc / settings | `artifacts/shot-*.png`（6 张，中文默认） |
| 窗口尺寸 | 1280×820（DPR 1.25 → 1583×979）、1100×700（最小尺寸 → 1358×829） | `ui3-1100-drc.png`、`ui2-1100-meter.png` |
| 参数极值 | NoiseGate 全推上限/下限（−91 / 0.999 / 500 / 5 / 6 / 200） | `ui-extremes.png` / `ui2-extremes.png` |
| EQ 极值 | 7 段全 +12 dB；7 段全 −32 dB + Q 0.1 | `ui3-eq-max.png`、`ui3-eq-min.png` |
| 语言 | 中文、英文（含最长文案：Environmental noise cancellation / Make-up gain） | `ui-en-input.png`、`ui-en-dynamics.png` |
| 状态 | 默认、EQ 编辑后、场景切换、分频点冲突、复位后 | `shot-eq-shaped.png`、`shot-meter-music.png`、`shot-drc-conflict.png`、`probe-reset.png` |
| 打包产物 | win-unpacked 下的 meter / eq | `packaged-meter.png`、`packaged-eq.png` |

取证命令（示例）：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:MICSTUDIO_USER_DATA = 'D:\Temp\ui-final-eq'
& node_modules\electron\dist\electron.exe . "--screenshot=artifacts\shot-eq.png" --route=eq --no-sandbox
```

## 2. 缺陷清单

| 编号 | 严重度 | 现象 | 根因 | 处理 |
|---|---|---|---|---|
| UI-01 | 中 | EQ 页节点 1（20 Hz）压住左侧 Y 轴刻度文字，`0` 与 `−24` 被削 | 绘图左边距 52px，节点半径 10px 与标签右对齐位置（vp.x−8）重叠 | **已修**：左边距 68px、标签右移到 vp.x−14 |
| UI-02 | 中 | 7 段全 −32 dB 时，节点圆压在底部频率刻度上（20Hz / 200Hz / 2kHz / 20kHz 被盖） | 频率标签只离绘图区 7px，小于节点半径 | **已修**：标签下移到 +22px、下边距 28→40px |
| UI-03 | 中 | 电平条在 −13 dB 档显示蓝灰色（`#7fa3bd` / `#5d7f9c`），与整体琥珀橙品牌色冲突，且较响电平反而不醒目 | 初版配色分档混入了蓝色 | **已修**：改为琥珀系四档 `#8a6a45 → #f0a65b → #f4aa5f → #f69a9a`（>−3 dB 转红） |
| UI-04 | 低 | 1100×700 下分频页「分频点」卡与「低频」卡高度差大，左侧留白明显 | `auto-fit` 两列布局 + `align-items:start` | **已修**：≤1360px 时「分频点」卡跨满一行 |
| UI-05 | 低 | 1100×700 下电平页侧栏第三张卡被视口截断（Writes 只露一半） | 卡片高度累计超过可用高度 | **已修**：`max-height:760px` 时压缩卡片内边距与侧栏间距 |
| UI-06 | 记录 | 切换语言后重启仍是上次语言（localStorage 持久化），导致连续取证时后续截图意外变成英文 | 设计如此（语言持久化），非缺陷 | **不改**；取证脚本改为每个用例使用独立 `MICSTUDIO_USER_DATA` |

修复后复测：`ui3-eq-min.png`、`ui3-eq-max.png`、`ui3-eq.png`、`ui3-1100-drc.png`、`ui2-1100-meter.png` 均确认问题消失；`vitest` 79/79 仍全绿。

## 3. 逐项判定

| 检查项 | 结论 | 依据 |
|---|---|---|
| 六页布局完整性（无溢出/重叠/截断） | 通过 | 6 张标准图 + 修复后复测 |
| 1280×820 与 1100×700 两档布局 | 通过 | 最小尺寸下无横向滚动、分频页不再留白断层（纵向滚动属内容超出，符合预期） |
| 参数极值显示（含 4 位小数 0.0005、负值 −91、三位小数 0.999） | 通过 | `ui2-extremes.png`：6 项数值完整且未被截断 |
| EQ 极端增益不越界、标签不被遮挡 | 通过（修复后） | `ui3-eq-max.png`、`ui3-eq-min.png` |
| 曲线与段列表数值一致 | 通过 | `shot-eq-shaped.png`（+4/+2.5/−6/+5/+3 与曲线形状对应） |
| 双语覆盖（导航/标题/参数/单位/徽标/提示） | 通过 | `ui-en-input.png`、`ui-en-dynamics.png` 无中文残留 |
| 只读参数视觉区分（无滑块 + Read-only 徽标） | 通过 | `shot-input.png` |
| 状态一致性（顶栏 pill / 状态卡 / 写入计数） | 通过 | `shot-meter.png`（Ready + Writes 0） |
| 冲突态提示（fc1 > fc2） | 通过 | `shot-drc-conflict.png`（描边变色 + 文案追加） |
| 配色与视觉层级（背景/卡片/强调/危险色） | 通过 | 全部截图；`--danger` 仅在 >−3 dBFS 段出现 |
| 打包产物渲染与源码一致 | 通过 | `packaged-meter.png` / `packaged-eq.png` 与源码截图体积差 < 200 B |
| 深色底文字对比度（muted 文本可读） | 通过（主观边界，见 §4） | 卡片说明文字在 1583px 下清晰 |

## 4. 未覆盖项（如实标注）

| 项 | 原因 |
|---|---|
| hover / focus / drag 中的视觉反馈 | 静态截图无法捕获指针悬停与拖拽过程；交互逻辑由 `tests/unit` 与探针 DOM 事件覆盖 |
| 动画流畅度（电平 50 Hz、曲线重绘帧率） | 无性能采集手段；`capturePage` 只证明单帧正确 |
| DPR 1.0 / 2.0 的表现 | 本机固定 DPR 1.25，仅验证该倍率 |
| 文字对比度的量化指标（WCAG） | 未做像素级对比度计算，仅目视判定 |
| 超长翻译（德/日等第三语言） | 当前只有 zh/en 两套字典 |
| 真实设备态（已连接 / 错误提示样式） | Alpha 无设备，`transport` 只会是 `ready`（mock） |

## 5. 回归

- 单测：`Test Files 11 passed (11)` / `Tests 79 passed (79)`（修复后重跑）。
- 类型检查：`tsc --noEmit` exit 0。
- 构建：`electron-vite build` exit 0，33 modules。
- 六页截图重截全部成功（42–75 KB），无白屏。

## 6. 结论

界面在两种窗口尺寸、双语、参数极值、EQ 极限曲率、冲突态下均可正确渲染；本轮发现 5 个视觉缺陷（3 中 2 低）已全部修复并复测，1 项设计行为（语言持久化）按预期保留。剩余未覆盖项集中在动态交互与多 DPR 场景，建议在真机联调阶段补 hover/拖拽截图与性能采样。
