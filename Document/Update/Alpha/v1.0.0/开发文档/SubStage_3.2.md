# SubStage 3.2 — 电平表与电平页

- 所属 Stage：Stage 3
- 依赖前置：SubStage 2.3（`AppStore`、`MockTransport`、`LevelFrame`）、SubStage 3.1（`card`、`segmented`、`readonlyField`、`.card`/`.pfield*` 类名）
- 并行状态：可与 3.1、3.3、3.4 并行（文件不重叠；引用 3.1 的控件契约见 §3.3）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

「显示下位机实时电平」是本产品的第一诉求。Alpha 无设备，电平由 `MockTransport` 以 50Hz 驱动。本 SubStage 交付电平绘制组件与电平页，要求：50Hz 数据进来不掉帧、峰值保持可读、数值与柱体一致。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/ui/meter.ts` | `MeterCanvas`（Canvas 2D 绘制） |
| `src/renderer/src/ui/views/meter-view.ts` | `createMeterView(store)` |

## 3. 契约

### 3.1 `MeterCanvas`

```ts
export interface MeterChannel { label: string; rms: number; peak: number }

export class MeterCanvas {
  constructor(canvas: HTMLCanvasElement, opts?: { minDb?: number; rowHeight?: number; labelWidth?: number; valueWidth?: number });
  render(channels: MeterChannel[]): void;
  destroy(): void;
}
```

默认值：`minDb = -60`、`rowHeight = 40`、`labelWidth = 88`、`valueWidth = 112`。

绘制规则（每通道一行）：

- 画布尺寸按 `clientWidth × (rowHeight * channels.length)` 计算，乘以 `devicePixelRatio` 后 `setTransform` 缩放；每帧 `render` 时若尺寸变化则重设。
- 左侧 `labelWidth` 区域：标签文本，`--text-dim` 色，13px UI 字体，垂直居中。
- 中间区域：背景轨道（`rgba(255,255,255,0.06)`，高 10px，圆角 5px）；RMS 条从 minDb 起填充到当前 RMS，颜色渐变：`<-24dB` 用 `#5d7f9c`，`-24..-12` 用 `#7fa3bd`，`-12..-3` 用 `#f0a65b`，`>-3` 用 `#f69a9a`（分段着色，不做渐变混合）。
- 峰值：在峰值位置画 2px 竖线，颜色 `#e7ebf2`，透明度 .9。
- 右侧 `valueWidth` 区域：`RMS -12.3` / `PK -8.4` 两行小字，mono 11px，`--muted` 色。
- 刻度：中间区域底部每 12 dB 一条 1px 竖线（`rgba(255,255,255,0.08)`），首尾各一条。
- 所有 dB 值 clamp 到 `[minDb, 0]`；`rms`/`peak` 为 `NaN` 时按 `minDb` 处理。
- `render` 内部不做 rAF；由调用方控制刷新节奏。`destroy()` 清空画布并置空引用。

### 3.2 电平页

```ts
export function createMeterView(store: AppStore): HTMLElement;
```

返回根节点 `.view.view--meter`，内部结构：

```html
<div class="meter-layout">
  <section class="card meter-card">
    <header class="card-head">…电平表标题 / 标尺说明…</header>
    <div class="card-body"><canvas class="meter-canvas"></canvas></div>
  </section>
  <aside class="meter-side">
    <!-- 增益卡：readonlyField(gain.Mic) + readonlyField(gain.Hp) -->
    <!-- 场景卡：segmented(silence|speech|music) -->
    <!-- 状态卡：transport 状态文本 + 已写入条数 -->
  </aside>
</div>
```

数据流：

1. 视图创建时拿到 `store`，通过 `store.transportRef`（若无此属性，则由 `createMeterView` 的第二参数注入，见下）订阅电平。
   最终签名固定为：`createMeterView(store: AppStore, transport: MockTransport): HTMLElement`。`main.ts` 与 `router` 由主 Agent 在 4.2 统一接线，视图内部只依赖这两个对象。
2. 订阅回调内保存最新帧，并用一个 `requestAnimationFrame` 节流：同一帧内多次回调只触发一次重绘。
3. 重绘时调用 `meter.render([{ label: t('meter.input'), rms: f.inputRms, peak: f.inputPeak }, { label: t('meter.output'), rms: f.outputRms, peak: f.outputPeak }])`，并把状态卡里的"已写入条数"更新为 `transport.writtenBuffer().length`。
4. 场景 `segmented` 初始值 `store.get().scene`，变更时 `store.setScene(v)`（`AppStore.setScene` 负责调 `transport.setScene`）。
5. 视图返回的根节点带 `destroy()` 方法（`(root as any).destroy = () => { cancelAnimationFrame(rafId); unsubscribeLevels(); unsubscribeStore(); }`），`router` 切换时会调用它。

峰值保持：`MockTransport` 已提供 `inputPeak/outputPeak`；本视图不做二次保持逻辑。

### 3.3 样式

在 `components.css` 中追加（不得新建 css 文件）：

```css
.meter-layout { display: grid; grid-template-columns: minmax(0,1fr) 320px; gap: 20px; }
.meter-side { display: flex; flex-direction: column; gap: 16px; }
.meter-canvas { display: block; width: 100%; height: auto; }
```

`@media (max-width: 1050px)` 下 `.meter-layout { grid-template-columns: 1fr; }`。

## 4. 输入输出

- 输入：`Transport.onLevels` 的 `LevelFrame`（50Hz）、`AppStore` 的 `scene` 与 `params`。
- 输出：像素绘制 + 三个侧卡片；无文件产物。

## 5. 验收标准

1. `pnpm run build` 通过。
2. 启动应用进入电平页：柱体随 Mock 数据持续变化（肉眼或连续两张截图对比像素差 > 0）。
3. 切换场景为「静音」：柱体落到 -72 附近并基本不动；切「音乐」：柱体持续在中高位波动。
4. 状态卡显示的写入条数在拖动任意参数后增长。
5. 控制台无 error；连续运行 30 秒 CPU 无持续飙升（观察任务管理器或 `performance.now()` 采样）。
6. 单元测试：`tests/unit/meter.test.ts` 至少覆盖 `MeterCanvas` 的 clamp 行为（`rms > 0` 时按 0 处理、`NaN` 不抛异常），使用 happy-dom 的 canvas 桩（happy-dom 提供 `getContext('2d')` 的空实现；若不可用，用最小 mock 对象注入）。

## 6. 禁止事项

- 不在视图里直接 `setInterval` 造数据（数据只能来自 `Transport`）。
- 不把 dB 数值硬编码进 DOM 文本以外的计算逻辑。
- 不改 `device/`、`domain/`、`eq/` 下的文件。
- 不改 `Document/` 下任何文件。

## 7. 错误处理契约

- `transport.onLevels` 未提供帧时不绘制（保留空轨道），不抛异常。
- Canvas 上下文获取失败（`getContext('2d')` 返回 null）时，组件降级为 DOM 文本显示数值，不抛异常。
- `createMeterView` 若传入的 `transport` 缺少 `writtenBuffer`，状态卡显示 `--`。

## 8. 依赖前置

需等待 SubStage 1.1 完成。`card`/`segmented`/`readonlyField` 由 3.1 提供（签名见 SubStage_3.1.md §3.5）；若 3.1 尚未落盘，按同一签名自行实现临时版本并在集成时替换为 import，禁止另建同名控件。
