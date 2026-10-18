# SubStage 3.4 — 参数面板四视图（输入 / 动态 / 分频 / 设置）

- 所属 Stage：Stage 3
- 依赖前置：SubStage 2.1（`PARAMS`/`paramsOf`/`findParam`/`DEFAULT_PARAMS`/`DEFAULT_BANDS`/`values`）、SubStage 2.3（`AppStore`/`t`）、SubStage 3.1（`card`/`paramSlider`/`readonlyField`/`switchControl`/`segmented`/`setSliderValue`）
- 并行状态：可与 3.1、3.2、3.3 并行（文件不重叠）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

把 36 个可绑定参数全部落成可操作控件（其中 2 个只读展示）。四个视图结构不同但交互模式一致：控件改动 → `store.setParam` → 顶栏同步状态更新；外部状态变化 → 控件回填。

## 2. 交付文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/ui/views/input-view.ts` | `createInputView(store)` |
| `src/renderer/src/ui/views/dynamics-view.ts` | `createDynamicsView(store)` |
| `src/renderer/src/ui/views/drc-view.ts` | `createDrcView(store)` |
| `src/renderer/src/ui/views/settings-view.ts` | `createSettingsView(store)` |

## 3. 通用契约（四个视图都遵守）

1. 返回根节点 `.view.view--<id>`；若内部有订阅，挂 `destroy()` 方法供 router 调用。
2. 参数控件构建：
   ```ts
   const root = paramSlider(spec, {
     value: store.get().params[spec.id],
     onInput: (v) => store.setParam(spec.id, v),
   });
   ```
3. 订阅回填：用一个 `Map<string, HTMLElement>` 记录 paramId → 控件根；`store.onChange` 时对每个条目调 `setSliderValue(root, spec, state.params[spec.id])`，只读字段直接改 `.pfield-readout strong` 的文本。
4. 文案全部走 `t()`：参数标题用 `t('param.<id>.label')`（由 3.1 的 `paramSlider` 内部取），卡片标题用 `t('module.<id>')`，卡片副标用 `t('module.<id>.desc')`。

## 4. 各视图结构

### 4.1 输入页 `input-view.ts`

```html
<div class="view view--input">
  <div class="panel-grid">
    <!-- 卡1：增益（只读） -->
    <section class="card"><header class="card-head">…module.gain…</header>
      <div class="card-body"><!-- readonlyField(gain.Mic) + readonlyField(gain.Hp) --></div>
    </section>
    <!-- 卡2：噪声门 6 个 paramSlider（顺序 noisegate.threshold_db, ratio, attack_ms, release_ms, knee_width_db, hp_freq） -->
    <!-- 卡3：ENC：switchControl(enc.OnOff) + segmented(enc.Level 0..3，标签 t('common.off') 与数字 1/2/3) -->
  </div>
</div>
```

`enc.OnOff` 存 0/1，`switchControl` 的 `checked = value === 1`，`onChange` → `store.setParam('enc.OnOff', v ? 1 : 0)`。`enc.Level` 用 `segmented`，选项 `[0,1,2,3]`，标签依次为 `t('common.off')`、`1`、`2`、`3`。

### 4.2 动态页 `dynamics-view.ts`

```html
<div class="view view--dynamics">
  <div class="panel-grid">
    <!-- 卡1 Comp：6 个 paramSlider（MakeUpGain, Threshold, Attack, Release, Rate, KneeWidth 原顺序） -->
    <!-- 卡2 Limit：3 个 paramSlider（Threshold, Attack, Release） -->
  </div>
</div>
```

### 4.3 分频页 `drc-view.ts`

```html
<div class="view view--drc">
  <div class="panel-grid">
    <!-- 卡1 分频点：paramSlider(drc3.fc1) + paramSlider(drc3.fc2) -->
    <!-- 卡2 低频区：标题 t('drc.band.low')，副标 t('drc.cond.low')（文本含 {fc1} 占位，实时填入当前 fc1 值），5 个 paramSlider -->
    <!-- 卡3 中频区：同上，cond.mid 含 {fc1} {fc2} -->
    <!-- 卡4 高频区：同上，cond.high 含 {fc2} -->
  </div>
</div>
```

区间条件文案示例（写在字典里）：中文 `freq < {fc1} Hz`、`{fc1} Hz < freq < {fc2} Hz`、`freq > {fc2} Hz`；英文对应。`fc1`/`fc2` 变化时刷新三张卡的副标文本。

一致性约束：`fc1 <= fc2`。当用户把 `fc1` 拖到大于 `fc2` 时，视图不做静默修改，只在该卡加 `.is-conflict` 类并在副标后追加提示（字典键 `drc.conflict`），数值仍按参数表范围写入。

### 4.4 设置页 `settings-view.ts`

```html
<div class="view view--settings">
  <div class="panel-grid">
    <!-- 卡1 界面：语言 segmented(zh|en) + 模拟场景 segmented(silence|speech|music) -->
    <!-- 卡2 数据：恢复默认参数按钮（btn--ghost），点击后遍历 PARAMS 调 store.setParam(spec.id, spec.default)（只读的自动被忽略），并调 store.setBands(DEFAULT_BANDS) -->
    <!-- 卡3 关于：版本（window.micstudio?.appVersion ?? '1.0.0-alpha.0'）、平台（window.micstudio?.platform ?? 'browser'）、Alpha 提示 t('settings.alphaNotice') -->
  </div>
</div>
```

恢复默认后不需要二次确认（Alpha 阶段），但按钮点击后文字临时变为 `t('common.default')` 1.5 秒。

## 5. 样式

在 `components.css` 追加：

```css
.panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; align-items: start; }
.pfield + .pfield { margin-top: 14px; }
.card-body .pfield:first-child { margin-top: 0; }
.card-head .card-desc { color: var(--muted); font-size: 11px; margin: 4px 0 0; }
.is-conflict { border-color: var(--warn); }
```

窄屏（≤680px）`.panel-grid` 单列。

## 6. 输入输出

- 输入：`AppStore` 的 `params`/`lang`/`scene`；`DEFAULT_PARAMS`/`DEFAULT_BANDS`。
- 输出：四个视图 DOM；所有改动经 `store.setParam` 进入传输层。

## 7. 验收标准

1. `pnpm run build` 通过；`pnpm run test` 不回归。
2. 输入页：Gain 两项显示为只读且值为 5 / 0；NoiseGate 6 个滑块初值分别为 -70 / 0.333 / 10 / 200 / 12 / 150；ENC 开关默认关、档位默认 1。
3. 动态页：Comp 初值 0 / -60 / 0.0005 / 0.1 / 6 / 1；Limit 初值 -60 / 0.0005 / 0.05。
4. 分频页：fc1 = 1000、fc2 = 3000；三张区卡各 5 个滑块，初值 1.28 / 0 / 10 / 20 / 10；副标随 fc1/fc2 变化更新。
5. 设置页：语言切换生效；场景切换后电平页数据变化；恢复默认后任一被改过的参数回到默认值。
6. 任意滑块拖动后，顶栏同步状态从 `已同步` 短暂变为 `同步中` 再回到 `已同步`（或显示写入计数递增）。
7. 控制台无 error。

## 8. 禁止事项

- 不在视图里硬编码 min/max/default 字面量（全部来自 `PARAMS`）。
- 不自定义新的输入控件结构（必须用 3.1 的 `paramSlider`/`segmented`/`switchControl`）。
- 不改 `domain/`、`device/`、`eq/` 下文件。
- 不改 `Document/` 下任何文件。

## 9. 错误处理契约

- `store.setParam` 对只读参数静默忽略，视图不因此报错。
- 恢复默认时若某个 id 在 `DEFAULT_PARAMS` 中缺失，跳过该 id 并 `console.warn`。
- `window.micstudio` 缺失时「关于」卡回落到默认文本。

## 10. 依赖前置

需等待 SubStage 1.1、2.1、2.3 完成。控件由 3.1 提供（签名见 SubStage_3.1.md §3.5）；未落盘前可按相同签名写本地临时实现，集成时统一替换为 import。
