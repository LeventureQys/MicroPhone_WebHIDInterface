# SubStage 3.3 — EQ 曲线渲染与交互

- 所属 Stage：Stage 3
- 依赖前置：SubStage 2.2（`EqModel`、`computeCurve`、`FreqMapper`、`EqBand`）、SubStage 3.1（`card`、控件类名与布局）
- 并行状态：可与 3.1、3.2、3.4 并行（文件不重叠）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

EQ 曲线是本产品最核心的视觉与交互对象，审美基线取自参照项目（深色底 + 琥珀橙曲线 + 带编号的圆点节点）。要求：拖动流畅、节点可命中、曲线随参数即时重算，7 个上位机可调段全部可交互。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/eq/render.ts` | `drawEq(ctx, opts)`：网格 / 轴标签 / 曲线填充 / 曲线 / 节点 |
| `src/renderer/src/eq/interactions.ts` | `attachEqInteractions(opts)`：命中、拖拽、滚轮、键盘、双击 |
| `src/renderer/src/ui/views/eq-view.ts` | `createEqView(store)`：画布 + 工具栏 + 段列表 + 内部段折叠 |

## 3. 契约

### 3.1 渲染

```ts
export interface EqTheme {
  background: string;      // 'transparent'（卡片提供底色）
  gridColor: string;       // 'rgba(168,187,205,0.11)'
  axisColor: string;       // 'rgba(255,255,255,0.45)'
  zeroDbColor: string;     // 'rgba(255,255,255,0.28)'
  curveColor: string;      // '#F0A030'
  curveLineWidth: number;  // 2.5
  fillColor: string;       // 'rgba(240,160,48,0.15)'
  labelColor: string;      // '#8592a7'
  labelFont: string;       // '11px ui-monospace, Consolas, monospace'
  bandFill: string;        // '#171c26'
  bandStroke: string;      // 'rgba(255,255,255,0.9)'
  bandFocusFill: string;   // '#1d2430'
  bandFocusStroke: string; // '#f0a65b'
  bandRadius: number;      // 10
  margin: { top: number; right: number; bottom: number; left: number };  // {16, 20, 28, 46}
}

export function drawEq(ctx: CanvasRenderingContext2D, opts: {
  width: number;                // CSS 像素
  height: number;               // CSS 像素
  mapper: FreqMapper;
  bands: readonly EqBand[];     // 14 段，全部参与曲线
  visibleCount: number;         // 7，只画前 7 个节点
  focusedIndex: number;         // -1 表示无
  curve: readonly CurvePoint[];
  theme: EqTheme;
}): void;
```

绘制顺序与规则：

1. `clearRect` 后不填背景（卡片给底色）。
2. 网格：`FreqMapper.freqTicks` 竖线 + `FreqMapper.gainTicks(…, 6)` 横线，1px，`gridColor`。
3. 0 dB 线：`zeroDbColor`，2px。
4. 轴标签：频率刻度画在底部（`vp.y + vp.height + 8`），`< 1000` 显示 `20`、`200` 等纯数字 + `Hz`，`>= 1000` 显示 `1k`、`10k`；增益刻度画在左侧右对齐（`vp.x - 8`），显示 `-24 … 12`。字体 `theme.labelFont`，`labelColor`。
5. 曲线填充：沿曲线到 `gainToY(0)` 闭合，`fillColor`。
6. 曲线：`curveColor`，`curveLineWidth`，`lineJoin/lineCap = 'round'`。
7. 节点：仅 `index < visibleCount` 的段。圆半径 `bandRadius`，填充 `bandFill`/聚焦 `bandFocusFill`，描边 1.5px `bandStroke`/`bandFocusStroke`；圆心写段号（从 1 开始显示：`index + 1`），`11px mono`，`#e7ebf2`。
8. 所有 Y 坐标 clamp 到 `[vp.y, vp.y + vp.height]`，避免大增益时越界。

### 3.2 交互

```ts
export interface EqInteractionOptions {
  canvas: HTMLCanvasElement;
  model: EqModel;
  mapper: FreqMapper;
  onChange: () => void;         // 模型变化后的回调（视图负责重绘 + store 同步）
  hitRadius?: number;           // 默认 12
}
export function attachEqInteractions(opts: EqInteractionOptions): () => void;  // 返回 detach
```

行为：

- `pointerdown`：命中半径内最近的可见段 → `model.setFocused(index)`；未命中任意段 → `model.setFocused(-1)`。命中时 `setPointerCapture`，进入拖拽。
- `pointermove`（拖拽中，rAF 节流）：把指针坐标映射为 `freq`/`gain`；按住 `Shift` 只改频率，按住 `Alt` 只改增益，都不按则同时改。`model.setBand(index, {...})`。
- 指针离开画布但仍在拖拽 → 继续用 `pointermove`（已 capture）。
- `wheel`：指针悬停在某可见节点上时，`deltaY < 0` → Q +0.1，否则 -0.1；`preventDefault()` 阻止页面滚动；不在节点上时不拦截。
- `dblclick`：命中节点 → `model.resetBandGain(index)`。
- 键盘（`canvas.tabIndex = 0`，聚焦时）：`←/→` 频率 ×/÷ 1.02；`↑/↓` 增益 ±0.1；`Delete`/`Backspace` 复位该段。`preventDefault()` 阻止滚动。
- 每次模型变更后调用 `onChange()`。
- `detach()` 移除所有监听并释放 capture。

### 3.3 视图

```ts
export function createEqView(store: AppStore): HTMLElement;
```

结构：

```html
<div class="view view--eq">
  <div class="eq-layout">
    <section class="card eq-card">
      <header class="card-head">
        <div><p class="eyebrow">RESPONSE</p><h3 class="card-title">频率响应</h3></div>
        <div class="eq-toolbar">
          <span class="eq-badge">14 段 / 可调 7 段</span>
          <button class="btn btn--ghost" data-action="reset-all">全部归零</button>
        </div>
      </header>
      <div class="card-body"><canvas class="eq-canvas" tabindex="0"></canvas></div>
    </section>
    <aside class="eq-side">
      <section class="card"><header …>段列表</header><div class="card-body"><div class="eq-list"></div></div></section>
      <details class="card eq-internal"><summary>内部调音段 7–13</summary><div class="eq-internal-body"></div></details>
    </aside>
  </div>
</div>
```

段列表：7 行，每行 `.eq-row`（`data-band="0..6"`），列依次为段号（`1..7`）、类型下拉（`eq.type.0..4` 五项）、频率（number，step 1，范围 20–20000）、增益（number，step 0.1，范围 -32..12）、Q（number，step 0.1，范围 0.1–12）。输入走 `model.setBand`，非法输入回填旧值。聚焦行加 `is-focused`，与画布聚焦双向同步（订阅 `focus-changed`）。

内部段：只读文本列表，显示 `段 8..14 · type · freq Hz · gain dB · Q`。

工具栏：段数徽标 + 「全部归零」（遍历 0..6 调 `model.resetBandGain`）。

画布尺寸：CSS 高度 `clamp(320px, 44vh, 460px)`，宽度 100%；`resize` 时按 `ResizeObserver` 重设 canvas 像素尺寸与 `mapper.setViewport`，随后重绘。

数据流：

1. 视图创建 `EqModel`（初始 `store.get().bands`）；`model` 的变化经 `onChange` → `store.setBands(model.allBands())`。
2. 每次重绘前 `computeCurve(model.allBands(), { pointCount: 480 })`；点数随画布宽度调整：`Math.max(240, Math.round(cssWidth))`，上限 1200。
3. `store.onChange` 中若 `bands` 与本地不一致（例如「恢复默认」），用 `model` 侧回写（提供 `model.replaceAll(bands)`；若 2.2 未提供，则在视图内用 `setBand` 逐段同步）。

### 3.4 样式（追加到 `components.css`）

`.eq-layout`（grid: 1fr 320px，gap 20px）、`.eq-canvas`（block、width 100%、cursor 按 `data-cursor` 切换 `grab`/`grabbing`）、`.eq-side`（flex column gap 16px）、`.eq-list`、`.eq-row`（grid 列宽 `28px 96px 1fr 1fr 1fr`，gap 8px，垂直居中，`.is-focused` 左侧 2px 强调条 + `--panel-2` 底）、`.eq-internal summary`（cursor pointer，`--muted`）、`.eq-badge`、`.eq-toolbar`。

窄屏（≤1050px）：`.eq-layout` 单列。

## 4. 输入输出

- 输入：`EqModel` 的段数据、`AppStore` 的 `bands`/`focusedBand`。
- 输出：Canvas 像素 + 段列表 DOM；改动回写 `store.setBands`。

## 5. 验收标准

1. `pnpm run build` 通过；`pnpm run test` 不回归。
2. 进入 EQ 页：可见网格、频率/增益刻度、琥珀橙曲线、7 个编号节点（1–7）。
3. 拖动节点 3 向上 → 曲线凸起、段列表增益同步变化、`store` 中 `bands[2].gain` 变化（可用 `console.log` 或临时断言验证）。
4. 双击节点 → 该段增益归零、Q 回到 0.7。
5. 滚轮悬停节点 → Q 变化且页面不滚动。
6. 键盘 ↑↓←→ 可调聚焦段。
7. 切换语言后段列表与工具栏文案切换，曲线不变。
8. 「全部归零」后曲线拉平到 0 dB 附近（内部段本就为 0）。
9. 新增单测 `tests/unit/eq-render.test.ts`：用 mock 2D context 记录调用，断言 7 个节点各调用一次 `arc`、曲线 `stroke` 调用存在、`NaN` 坐标不进入 `lineTo`。

## 6. 禁止事项

- 不引第三方图表/拖拽库。
- 不在渲染层做参数范围校验（由 `EqModel` 负责）。
- 不画内部段（7–13）的节点。
- 不改 `eq/model.ts`、`eq/curve.ts`、`eq/mapper.ts`（发现缺陷上报主 Agent）。
- 不改 `Document/` 下任何文件。

## 7. 错误处理契约

- 画布尺寸为 0（不可见）时跳过绘制，不抛异常。
- `computeCurve` 返回空数组时只画网格与节点。
- `getContext('2d')` 失败时视图显示 `t('common.error')` 文本占位。
- 拖拽过程中 `model.setBand` 不抛异常（模型已保证）。

## 8. 依赖前置

需等待 SubStage 1.1、2.2 完成；`card` 等控件由 3.1 提供（可先按 SubStage_3.1.md §3.5 的签名写代码，集成时改为 import）。
