# SubStage 3.1 — 应用外壳、路由与控件库

- 所属 Stage：Stage 3
- 依赖前置：SubStage 2.1（`ParamSpec`/`findParam`/`formatValue`/`parseInput`）、SubStage 2.3（`t`/`AppStore`）
- 并行状态：可与 3.2、3.3、3.4 并行；但 **3.2/3.3/3.4 都以本 SubStage 的 DOM 结构与控件库为准**，本 SubStage 的类名与函数签名一旦落盘不得再改
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

搭出应用骨架：顶栏、左侧导轨、路由容器，以及四个通用控件。之后所有视图都只用这层提供的结构与类名，不各自造轮子。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/app/shell.ts` | `createShell()`：装配顶栏 + 导轨 + 内容区 |
| `src/renderer/src/app/router.ts` | `createRouter()` |
| `src/renderer/src/ui/topbar.ts` | `createTopbar()` |
| `src/renderer/src/ui/navrail.ts` | `createNavRail()` |
| `src/renderer/src/ui/controls.ts` | `paramSlider` / `readonlyField` / `switchControl` / `segmented` / `setSliderValue` / `card` |
| `src/renderer/src/styles/components.css` | 上述结构的全部样式 |
| `src/renderer/src/main.ts` | 改为：装载样式 → 构建 store/transport → createShell → 默认进 `meter` |

## 3. 契约

### 3.1 外壳 DOM

```html
<div class="app-shell">
  <header class="topbar" id="topbar"></header>
  <div class="app-body">
    <nav class="navrail" id="navrail"></nav>
    <main class="content" id="view-root"></main>
  </div>
</div>
```

```ts
export interface ShellOptions {
  store: AppStore;
  router: Router;
}
export function createShell(opts: ShellOptions): HTMLElement;
```

要求：`#topbar` 与 `#navrail` 由 `createTopbar`/`createNavRail` 填充；`#view-root` 交给 router 挂载。`createShell` 内部订阅 `store.onChange`，在 `module` 变化时调用 `router.go(module)`，在 `lang` 变化时重建顶栏与导轨（`innerHTML = ''` 后重新生成）并 `router.go(router.current())` 重刷当前视图。

### 3.2 路由

```ts
export type RouteId = 'meter' | 'input' | 'eq' | 'dynamics' | 'drc' | 'settings';
export interface Router {
  go(id: RouteId): void;
  current(): RouteId;
}
export function createRouter(opts: {
  mount: HTMLElement;
  store: AppStore;
  views: Record<RouteId, () => HTMLElement>;
}): Router;
```

- 首次 `go` 时才构建视图并缓存；再次 `go` 到同一 RouteId 时销毁旧节点后重新构建（因为语言切换需要重建文案）。
- 构建前若有上一视图且其元素带 `destroy` 方法，先调用。
- 切换时给 `mount` 下新节点加类 `view view--<id>`。

### 3.3 顶栏

```ts
export function createTopbar(opts: { store: AppStore }): HTMLElement;
```

DOM：

```html
<div class="brand">
  <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
  <div class="brand-text">
    <strong>MIC <span class="brand-accent">STUDIO</span></strong>
    <small>麦克风控制台 / Mic Console</small>
  </div>
</div>
<div class="topbar-right">
  <span class="state-pill state-pill--ready|--mock|--idle|--error"><i class="dot"></i><span class="state-text">模拟中</span></span>
  <div class="segmented segmented--lang">
    <button class="seg-btn is-active" data-lang="zh">中</button>
    <button class="seg-btn" data-lang="en">EN</button>
  </div>
  <button class="btn btn--primary" id="connect-btn">连接设备</button>
</div>
```

行为：语言按钮点击 → `store.setLang(lang)`；`连接设备` 点击 → `window.micstudio.requestHidDevice()`，返回 `{ ok: false }` 时把按钮文字临时改为 `Alpha 阶段未开放` 2 秒后还原（文案键 `topbar.connect`，临时文案直接内联字符串，两种语言各一份）。状态 pill 文案键 `topbar.state.<transport state>`，类名 `.state-pill--<state>`。

### 3.4 导轨

```ts
export function createNavRail(opts: { store: AppStore }): HTMLElement;
```

6 个按钮，`data-route="meter|input|eq|dynamics|drc|settings"`，每个含 `<span class="nav-icon">`（内联 SVG，24×24，`stroke="currentColor"`、`fill="none"`、`stroke-width="1.5"`）与 `<span class="nav-label">`（`t('nav.<id>')`）。点击 → `store.setModule(route)`。当前项加 `is-active`。

图标用极简几何图形即可（电平：三根竖条；输入：麦克风轮廓；EQ：折线；动态：上下箭头对；分频：三条横线；设置：齿轮/滑杆）。SVG 内联在 TS 字符串里，不引外部资源。

### 3.5 控件库（DOM 结构固定，样式在 components.css）

所有控件根节点带 `data-param="<paramId>"`（若与参数相关），文案一律来自 `t()`。

**参数滑块**

```html
<div class="pfield" data-param="noisegate.threshold_db">
  <div class="pfield-head">
    <span class="pfield-label">阈值</span>
    <span class="pfield-unit">dB</span>
  </div>
  <div class="pfield-body">
    <input class="pfield-range" type="range" min="-91" max="0" step="1" value="-70" />
    <input class="pfield-number" type="number" min="-91" max="0" step="1" value="-70" />
  </div>
</div>
```

```ts
export function paramSlider(spec: ParamSpec, opts: { value: number; onInput: (v: number) => void }): HTMLElement;
```

- `range` 的 `input` 事件 → `quantize(spec, Number(range.value))` → 同步 number 输入显示 → `onInput(v)`。
- `number` 的 `change` 与 `keydown Enter` 事件 → `parseInput`；非 null 则 `onInput`，null 则回填当前值。
- `dblclick` → 复位 `spec.default` 并 `onInput`。
- `number` 的显示文本用 `formatValue`。

**只读字段**

```html
<div class="pfield pfield--readonly" data-param="gain.Mic">
  <div class="pfield-head">
    <span class="pfield-label">麦克风增益</span>
    <span class="pfield-badge">只读</span>
  </div>
  <div class="pfield-readout"><strong>5</strong><span class="pfield-unit">dB</span></div>
</div>
```

```ts
export function readonlyField(spec: ParamSpec, value: number): HTMLElement;
```

**开关**

```html
<label class="switch-row"><span class="switch-label">环境降噪</span><span class="switch"><input type="checkbox" /><span class="switch-track"></span></span></label>
```

```ts
export function switchControl(opts: { checked: boolean; label: string; onChange: (v: boolean) => void }): HTMLElement;
```

**分段选择**

```html
<div class="segmented" role="group">
  <button class="seg-btn is-active" data-value="0">关</button>
  <button class="seg-btn" data-value="1">1</button>
</div>
```

```ts
export function segmented<T extends string | number>(opts: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}): HTMLElement;
```

点击后切换 `is-active` 并回调（仅当值变化）。`data-value` 用 `String(value)`，回调时按 `options` 里原始类型取值（字符串型选项直接传字符串，数字型选项 `Number()`）。

**卡片**

```html
<section class="card">
  <header class="card-head">
    <div><p class="eyebrow">NOISE GATE</p><h3 class="card-title">噪声门</h3></div>
    <span class="card-tag">6 PARAMS</span>
  </header>
  <div class="card-body"></div>
</section>
```

```ts
export function card(opts: { eyebrow: string; title: string; tag?: string }): { root: HTMLElement; body: HTMLElement };
```

**回填**

```ts
export function setSliderValue(root: HTMLElement, spec: ParamSpec, value: number): void;
```

仅更新 `range.value`、`number.value` 与显示文本，不触发 `onInput`。

### 3.6 样式要求（components.css）

必须实现并覆盖：`.app-shell`（flex column，100vh）、`.topbar`（64px，border-bottom `--border-soft`）、`.app-body`（flex，min-height 0）、`.navrail`（84px，右侧 1px 分隔线，纵向 flex，gap 6px）、`.nav-item`（84×64，居中列，`color: --muted`，hover 提亮，`is-active` 用 `--accent` + 左侧 2px 强调条）、`.content`（flex 1，overflow auto，padding 24px）、`.brand*`、`.state-pill`（胶囊，四种状态色：idle `--muted`、mock `--warn`、ready `--ok`、error `--danger`）、`.segmented`/`.seg-btn`（描边分段，`is-active` 用 `--accent-dim` 底 + `--accent` 字）、`.btn`/`.btn--primary`、`.card`/`.card-head`/`.card-title`/`.card-tag`/`.card-body`、`.eyebrow`（11px mono 大写、`--accent` 色、letter-spacing .08em）、`.pfield*`、`.switch*`、`.pfield--readonly`。

滑块样式：`input[type=range]` 全宽、高 18px、`accent-color: var(--accent)`；`input[type=number]` 宽 88px、底 `--panel-3`、边框 `--border`、右对齐、mono 字体。

禁止使用 CSS 框架或 `@import` 外部字体。

## 4. 输入输出

- 输入：设计文档 §5.11 视觉规范、§5.13 控件契约、§5.15 路由契约；本任务书 §3 的 DOM。
- 输出：`shell.ts`/`router.ts`/`topbar.ts`/`navrail.ts`/`controls.ts` + `components.css`；被 3.2/3.3/3.4 引用。

## 5. 验收标准

1. `pnpm run build` 通过；`pnpm run test` 既有测试不回归。
2. 用 `MICSTUDIO_USER_DATA=<tmp>` 启动（`pnpm run dev` 或打包前 `electron.exe .`），窗口出现：顶栏有品牌与三个右侧控件，左导轨 6 项，内容区为空态文本 `请选择模块`（临时，3.x 视图接入后移除）。
3. 点击导轨任一项不报错（视图尚未实现时显示占位文本即可）。
4. 语言切换点击后，导轨与顶栏文案在中文/英文间切换。
5. 控制台无 error。

## 6. 禁止事项

- 不在本 SubStage 实现电平表、EQ 画布、参数面板内容（属 3.2/3.3/3.4）。
- 不硬编码中文文案（除 §3.3 的临时提示）。
- 不改 `domain/`、`device/`、`eq/` 下文件。
- 不改 `Document/` 下任何文件。

## 7. 错误处理契约

- 视图工厂抛异常时，router 捕获并挂载一个 `.view-error` 节点显示错误文本（`t('common.error')` 若有，否则原始 message），同时 `console.error`，不使整个应用白屏。
- `window.micstudio` 不存在（浏览器调试环境）时，`连接设备` 按钮禁用并在 title 提示，不抛异常。

## 8. 依赖前置

需等待 SubStage 1.1、2.1、2.3 完成。开工时可与本 Stage 其他 SubStage 并行，但 3.2/3.3/3.4 会 import 本 SubStage 的 `controls.ts` 与类名，落盘后请立即通知主 Agent。
